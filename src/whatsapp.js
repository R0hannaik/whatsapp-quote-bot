// WhatsApp connection (Baileys, multi-device "Linked devices"), group sync, auto-reply, rotating join links.
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, normalizeMessageContent, S_WHATSAPP_NET,
  jidNormalizedUser, isJidGroup, areJidsSameUser,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR, getGroup, listGroups, upsertLiveGroup, markGroupsLeft, patchGroup, incrementQuotes,
  createInquiry, getSettings, addCustomGroup, setCurrentAccount, getTemplates,
} from './db.js';
import { planReplies } from './bot.js';
import { normalize, hasPhrase } from './parser.js';
import { findRecentInquiry, flagInquiry } from './db.js';

const AUTH_DIR = path.join(DATA_DIR, 'wa-auth');
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'warn' });

export const wa = {
  status: 'disconnected',   // disconnected | connecting | qr | open | logged_out | disabled
  qr: null,                 // data URL of the "link device" QR
  me: null,
  lastError: null,
  lastSync: null,
  sock: null,
};

const groupMeta = new Map();          // jid -> metadata (for sending)
const sentIds = new Set();            // ids of messages the bot sent (never answer these)
const sentTexts = [];                 // recent reply texts (second guard against reply loops)

/** Rolling log of the last messages the bot saw and what it decided — shown on the dashboard. */
export const activity = [];
function logActivity(e) {
  const entry = { at: new Date().toISOString(), ...e };
  activity.unshift(entry);
  if (activity.length > 150) activity.length = 150;
  const who = e.sender ? ` ${e.sender}` : '';
  if (!process.env.QB_QUIET) console.log(`[bot] ${e.result.toUpperCase()} · ${e.chatName || e.chat || ''}${who} · "${(e.text || '').slice(0, 60)}"${e.detail ? ' → ' + e.detail : ''}`);
}
const cooldown = new Map();           // `${group}|${sender}|${chem}` -> ts
const groupBurst = new Map();         // group -> [ts]
let reconnectTimer = null;
let retries = 0;
let unlinking = false;   // set while we unlink on purpose, so the close handler doesn't also restart
let sendChain = Promise.resolve();
let lastSendError = '';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

/* ------------------------------------------------------------------ connection */
export async function startWhatsApp() {
  if (process.env.WA_DISABLED === '1') { wa.status = 'disabled'; return; }
  clearTimeout(reconnectTimer);
  wa.status = 'connecting';
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use bundled default */ }

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    // Name shown on the phone under Settings → Linked devices (applies to new links).
    browser: [(process.env.WA_DEVICE_NAME || 'Quote Bot').slice(0, 30), 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    cachedGroupMetadata: async jid => groupMeta.get(jid),
  });
  wa.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async u => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      wa.status = 'qr';
      wa.qr = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
    }
    if (connection === 'open') {
      retries = 0;
      wa.status = 'open';
      wa.qr = null;
      wa.lastError = null;
      wa.me = { id: jidNormalizedUser(sock.user?.id), lid: sock.user?.lid, name: sock.user?.name || sock.user?.verifiedName || '' };
      setCurrentAccount(wa.me.id);   // show this number's groups (a different number won't see the old ones)
      setTimeout(() => runPaymentReminders().catch(e => console.warn('[pay] reminder run failed:', e.message)), 30000).unref?.();
      console.log('[wa] connected as', wa.me.id);
      syncGroups().catch(e => console.warn('[wa] group sync failed:', e.message));
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      wa.lastError = lastDisconnect?.error?.message || String(code || 'closed');
      if (wa.sock !== sock || unlinking) return; // superseded by a newer socket, or logoutWhatsApp() is handling it
      const next = closeAction({ code, message: wa.lastError, linked: !!state.creds?.me });
      if (next === 'qr_expired') {
        // Nobody scanned the QR. Stop here instead of making new QR codes forever; the dashboard asks for a new one.
        wa.status = 'qr_expired'; wa.qr = null; retries = 0;
        console.log('[wa] QR code expired without being scanned. Open the dashboard and click "Link WhatsApp" to get a new one.');
        return;
      }
      if (next === 'logged_out') {
        console.log('[wa] logged out — clearing session, a new QR will appear');
        wa.status = 'logged_out';
        wa.me = null;
        setCurrentAccount('');           // unlinked from the phone: hide this number's groups
        groupMeta.clear();
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        reconnectTimer = setTimeout(startWhatsApp, 1500);
      } else {
        wa.status = 'connecting';
        const delay = Math.min(30000, 2000 * 2 ** retries++);
        console.log(`[wa] connection closed (${wa.lastError}); reconnecting in ${delay / 1000}s`);
        reconnectTimer = setTimeout(startWhatsApp, delay);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    // 'notify' = new live messages (incl. ones typed on the linked phone). 'append' = history / our own sends.
    if (type !== 'notify') return;
    for (const m of messages) handleMessage(m).catch(e => {
      console.warn('[wa] handler error:', e);
      logActivity({ chat: m.key?.remoteJid, result: 'error', detail: e.message });
    });
  });

  sock.ev.on('groups.upsert', metas => metas.forEach(saveMeta));
  sock.ev.on('groups.update', async updates => {
    for (const u of updates) {
      try { saveMeta(await sock.groupMetadata(u.id)); } catch { /* ignore */ }
    }
  });
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      const meId = wa.me?.id;
      const removedMe = action === 'remove' && participants.some(p => areJidsSameUser(typeof p === 'string' ? p : p.id, meId) || areJidsSameUser(typeof p === 'string' ? p : p.id, wa.me?.lid));
      if (removedMe) { markGroupsLeft([id]); groupMeta.delete(id); return; }
      saveMeta(await sock.groupMetadata(id));
    } catch { /* ignore */ }
  });
}

function amIAdmin(meta) {
  const ids = [wa.me?.id, wa.me?.lid].filter(Boolean);
  return (meta.participants || []).some(p => p.admin && ids.some(me =>
    areJidsSameUser(p.id, me) || areJidsSameUser(p.phoneNumber, me) || areJidsSameUser(p.lid, me)));
}

function saveMeta(meta) {
  if (!meta?.id) return;
  groupMeta.set(meta.id, meta);
  if (!wa.me) return;                       // not linked (yet) — nothing to save groups under
  upsertLiveGroup({ jid: meta.id, name: meta.subject, members: meta.size || meta.participants?.length || 0, is_admin: amIAdmin(meta) });
}

export async function syncGroups() {
  if (wa.status !== 'open') throw new Error('WhatsApp is not connected');
  const all = await wa.sock.groupFetchAllParticipating();
  const live = Object.values(all);
  for (const meta of live) saveMeta(meta);
  const liveIds = new Set(live.map(m => m.id));
  markGroupsLeft(listGroups().filter(g => g.type === 'live' && !liveIds.has(g.jid)).map(g => g.jid));
  wa.lastSync = new Date().toISOString();
  return live.length;
}

/**
 * Unlink this number: ask WhatsApp to remove the linked device and WAIT for it to confirm
 * (the library's own logout() closes the connection without waiting, so the request can be lost
 * and the phone keeps showing the device). Returns { confirmed, reason }.
 */
export async function logoutWhatsApp() {
  unlinking = true;
  clearTimeout(reconnectTimer);
  let confirmed = false, reason = '';
  try {
    // If we're mid-reconnect, give the connection a few seconds to come back so the request can be sent.
    for (let i = 0; i < 30 && wa.sock && wa.status === 'connecting'; i++) await sleep(500);
    const sock = wa.sock;
    const me = sock?.authState?.creds?.me?.id;
    if (!sock || wa.status !== 'open' || !me) {
      reason = 'WhatsApp was not connected, so the phone could not be told';
    } else {
      // WhatsApp usually answers by closing the connection with "logged out" — that counts as confirmed too.
      const closedAsLoggedOut = new Promise(resolve => {
        sock.ev.on('connection.update', u => {
          if (u.connection === 'close' && u.lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) resolve(true);
        });
      });
      const ack = sock.query({
        tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'md' },
        content: [{ tag: 'remove-companion-device', attrs: { jid: me, reason: 'user_initiated' } }],
      }, 15000).then(() => true);
      try {
        confirmed = await Promise.race([ack, closedAsLoggedOut, sleep(16000).then(() => { throw new Error('no answer from WhatsApp'); })]);
      } catch (e) {
        confirmed = await Promise.race([closedAsLoggedOut, sleep(1500).then(() => false)]);
        if (!confirmed) reason = e.message || 'WhatsApp did not confirm';
      }
    }
  } finally {
    const old = wa.sock;
    wa.sock = null;
    try { old?.end(new Error('unlinked')); } catch { /* already closed */ }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    wa.status = 'logged_out'; wa.me = null; wa.qr = null;
    setCurrentAccount('');
    groupMeta.clear();
    unlinking = false;
    if (!process.env.QB_QUIET) console.log(confirmed ? '[wa] unlinked — WhatsApp confirmed the device was removed' : `[wa] unlinked locally, but ${reason}. Remove it on the phone: Settings → Linked devices.`);
    reconnectTimer = setTimeout(startWhatsApp, 1500);   // show a fresh QR
  }
  return { confirmed, reason };
}

/** What to do when the connection closes: 'logged_out' | 'qr_expired' | 'reconnect'. */
export function closeAction({ code, message = '', linked }) {
  if (code === DisconnectReason.loggedOut) return 'logged_out';
  if (!linked && (/QR refs attempts ended/i.test(message) || code === DisconnectReason.timedOut)) return 'qr_expired';
  return 'reconnect';
}

export async function restartWhatsApp() {
  try { wa.sock?.end(new Error('restart requested')); } catch { /* ignore */ }
  wa.sock = null;
  await startWhatsApp();
}

/** Join a group from an invite link/code and return its jid. */
export async function joinByInvite(link) {
  if (wa.status !== 'open') throw new Error('WhatsApp is not connected');
  const code = String(link).trim().split('/').pop().split('?')[0];
  const jid = await wa.sock.groupAcceptInvite(code);
  if (!jid) throw new Error('Could not join with that invite');
  try { saveMeta(await wa.sock.groupMetadata(jid)); } catch { addCustomGroup({ jid, name: jid }); }
  return jid;
}

/* ------------------------------------------------------------------ messages */
/** Is this message a reply (swipe-reply) to something the bot sent? */
function isReplyToBot(msg) {
  const c = normalizeMessageContent(msg.message);
  const ctx = c?.extendedTextMessage?.contextInfo || c?.imageMessage?.contextInfo || c?.documentMessage?.contextInfo;
  if (!ctx?.stanzaId) return false;
  if (sentIds.has(ctx.stanzaId)) return true;
  const me = [wa.me?.id, wa.me?.lid].filter(Boolean);
  return !!ctx.participant && me.some(j => areJidsSameUser(ctx.participant, j));
}

function textOf(msg) {
  const c = normalizeMessageContent(msg.message);
  if (!c) return '';
  return c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || c.documentMessage?.caption || '';
}

function senderInfo(msg) {
  const k = msg.key;
  const candidates = [k.participant, k.participantAlt, k.remoteJid, k.remoteJidAlt].filter(Boolean);
  const pn = candidates.find(j => j.endsWith('@s.whatsapp.net'));
  const jid = isJidGroup(k.remoteJid) ? (k.participant || k.participantAlt) : k.remoteJid;
  return { jid, phone: pn ? '+' + pn.split('@')[0].split(':')[0] : '', name: cleanName(msg.pushName) };
}

/** WhatsApp display names are chosen by the sender — strip formatting, links and length before we ever echo one. */
function cleanName(n) {
  return String(n || '')
    .replace(/https?:\/\/\S+|www\.\S+|\S+\.(com|in|net|org|xyz|link|ly|me)\b\S*/gi, '')
    .replace(/[*_~`<>{}\[\]\\]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** keys = chemical ids in the reply. Blocked only if EVERY product was already quoted to this person recently. */
function allowedByRateLimit(group, sender, keys, s) {
  const now = Date.now();
  const cd = (Number(s.cooldown_minutes) || 0) * 60000;
  const ks = (Array.isArray(keys) ? keys : [keys]).map(k => `${group}|${sender}|${k}`);
  if (ks.every(k => now - (cooldown.get(k) || 0) < cd)) return false;
  const burst = (groupBurst.get(group) || []).filter(t => now - t < 10 * 60000);
  if (burst.length >= (Number(s.group_max_replies_per_10min) || 15)) return false;
  ks.forEach(k => cooldown.set(k, now));
  burst.push(now); groupBurst.set(group, burst);
  return true;
}

function findChat(msg) {
  const k = msg.key;
  for (const j of [k.remoteJid, k.remoteJidAlt].filter(Boolean)) {
    const g = getGroup(j) || getGroup(jidNormalizedUser(j));
    if (g) return { jid: j, group: g };
  }
  return { jid: k.remoteJid, group: null };
}

export async function handleMessage(msg) {
  const k = msg.key || {};
  const rawJid = k.remoteJid;
  if (!rawJid || rawJid === 'status@broadcast' || rawJid.endsWith('@newsletter') || rawJid.endsWith('@broadcast')) return;
  if (sentIds.has(k.id)) return;                                   // our own reply echoing back
  const { jid, group } = findChat(msg);
  const chatName = group?.name || groupMeta.get(rawJid)?.subject || rawJid;
  const text = textOf(msg).trim().slice(0, 4000);
  const sender = senderInfo(msg);
  const log = (result, detail) => logActivity({ chat: jid, chatName, sender: k.fromMe ? 'You (linked number)' : (sender.name || sender.phone), text, result, detail });

  if (msg.messageStubType && !text) return;                        // joins, leaves, name changes…
  if (!msg.message) return log('skipped', 'could not decrypt yet — WhatsApp is still setting up keys for this chat, send the message again in a minute');
  if (!text) return;                                               // sticker / image without caption etc.

  const s = getSettings();
  if (k.fromMe) {
    if (!s.reply_to_own_messages) return log('skipped', 'sent from the bot\'s own number — turn on "Test mode" in Settings to test from this phone');
    if (sentTexts.includes(text)) return;                          // never answer our own quote
  }
  if (!group) return log('skipped', isJidGroup(rawJid) ? 'group not in the dashboard yet — press Sync Live Groups' : 'direct chat not added — add the number via "+ Add Custom Group"');
  if (!group.auto_reply) return log('skipped', 'auto-reply is OFF for this group');

  const ts = Number(msg.messageTimestamp?.toNumber ? msg.messageTimestamp.toNumber() : msg.messageTimestamp || 0) * 1000;
  if (ts && Date.now() - ts > (Number(s.ignore_older_than_sec) || 120) * 1000) return log('skipped', 'old message (arrived after a reconnect)');

  // ---- Steps 3–4: the buyer answers a quote (order / question) → hand over to the owner, don't auto-quote ----
  const msgKey = { id: k.id, remoteJid: rawJid, participant: k.participant, fromMe: !!k.fromMe };
  const repliedToBot = isReplyToBot(msg);
  const recent = findRecentInquiry(jid, sender.jid);
  const norm = normalize(text);
  const orderWords = String(s.order_keywords || '').split(',').map(w => w.trim()).filter(Boolean).some(w => hasPhrase(norm, w));
  if (orderWords && (repliedToBot || recent)) {
    const target = recent || createInquiry({ group_jid: jid, group_name: group.name, sender_jid: sender.jid, sender_name: sender.name,
      sender_phone: sender.phone, message: text, msg_key: msgKey, intent: 'order', status: 'Awaiting Owner', history_text: 'Order message (reply to an earlier quote)' });
    flagInquiry(typeof target === 'object' ? target.id : target, { text, kind: 'order', msg_key: msgKey });
    return log('flagged', `order request — waiting for you in Orders & Decisions (record the order there to start payment tracking)`);
  }

  const plan = await planReplies(text, { senderName: sender.name });
  const a = plan.analysis;
  const followUpWords = /\?|\b(kab|when|delivery|deliver|payment|terms|credit|advance|transport|freight|gst|bill|invoice|sample|coa|msds|tds|grade|purity|available|stock)\b/i;
  if (recent && (!a.isRequest || !a.items.length) && (repliedToBot || (followUpWords.test(text) && Date.now() - Date.parse(recent.created_at.replace(' ', 'T') + 'Z') < 6 * 3600e3))) {
    flagInquiry(recent.id, { text, kind: 'followup', msg_key: msgKey });
    return log('flagged', `follow-up question on ${recent.chemical_name || 'an earlier quote'} — waiting for you in Orders & Decisions`);
  }
  if (!a.isRequest) return log('skipped', a.skipReason === 'no request words found' && a.items.length
    ? `found ${a.items.map(i => i.chem.name).join(', ')} but no request words — add "rate", "need", "chahiye", a "?" or a quantity`
    : `not an enquiry (${a.skipReason})`);

  const base = {
    group_jid: jid, group_name: group.name, sender_jid: sender.jid, sender_name: sender.name, sender_phone: sender.phone,
    message: text, msg_key: { id: k.id, remoteJid: rawJid, participant: k.participant, fromMe: !!k.fromMe },
    quantity: a.quantity?.text || null, location: a.location, origin: a.origins.join(', ') || null,
  };

  const batchKey = k.id || `${jid}-${Date.now()}`;
  const batchSize = a.items.length + plan.unavailable.length;
  const batch = batchSize > 1 ? { batch_key: batchKey, batch_size: batchSize } : {};
  // Items we can't quote (not in the matrix / out of stock) still go to Orders so the owner can follow up.
  const logUnavailable = () => plan.unavailable.forEach(u => createInquiry({
    ...base, ...batch, quantity: u.quantity?.text || null, requested_text: u.name, intent: 'unmatched', status: 'Unmatched',
    history_text: u.reason === 'out of stock' ? `Asked for ${u.name} — out of stock, not quoted` : `Asked for "${u.name}" — not in the rates matrix`,
  }));

  if (!plan.replies.length) {
    if (plan.unavailable.length) logUnavailable();
    else if (a.items.length === 0 && a.unmatchedWorthy) createInquiry({ ...base, intent: 'unmatched', status: 'Unmatched' });
    if ((plan.unavailable.length || a.unmatchedWorthy) && plan.unmatchedReply && allowedByRateLimit(jid, sender.jid, 'unmatched', s)) await queueSend(jid, plan.unmatchedReply, msg, s);
    return log('unmatched', plan.unavailable.length ? `not in your matrix: ${plan.unavailable.map(u => u.name).join(', ')} — listed in Orders → Unmatched`
      : a.items.length ? 'chemical is out of stock / paused' : 'no chemical from your matrix found — add it or its alias, and it is listed in Orders → Unmatched');
  }

  let anySent = false;
  for (const r of plan.replies) {
    const names = r.items.map(i => i.chem.name).join(', ');
    if (!allowedByRateLimit(jid, sender.jid, r.items.map(i => i.chem.id), s)) { log('skipped', `${names}: cooldown — same person asked within ${s.cooldown_minutes} min (or group limit reached)`); continue; }
    const sent = await queueSend(jid, r.text, msg, s);
    if (!sent) { log('error', `${names}: sending failed — ${lastSendError}`); continue; }
    anySent = true;
    const how = r.kind === 'multi' ? `Multi-Product, ${r.items.length} products` : r.intent === 'deal' ? 'Deal template' : 'Price Quotation';
    log('replied', r.kind === 'multi' ? `${r.items.length} products in one message (${names})${plan.unavailable.length ? ` + ${plan.unavailable.length} to check` : ''}` : `${names} (${how})`);
    incrementQuotes(jid);
    for (const it of r.items) createInquiry({
      ...base, ...batch, quantity: it.quantity?.text || null, chemical_id: it.chem.id, chemical_name: it.chem.name, intent: r.intent,
      quote_text: r.text, quoted_rate: it.quotedRate, status: r.intent === 'deal' ? 'Negotiating' : 'Quoted',
      history_text: `Auto-quote sent (${how})`,
    });
  }
  if (anySent) logUnavailable();
}

/** Sends are serialised with a human-like delay and "typing…" indicator to keep the number safe. */
function queueSend(jid, text, quotedMsg, s = getSettings(), extra = {}) {
  const job = sendChain.then(async () => {
    if (wa.status !== 'open') return false;
    try {
      const min = Number(s.reply_delay_min_sec) || 0, max = Math.max(min, Number(s.reply_delay_max_sec) || 0);
      await wa.sock.sendPresenceUpdate('composing', jid).catch(() => {});
      await sleep(rand(min, max) * 1000);
      rememberSent(null, text);
      const out = await wa.sock.sendMessage(jid, { text, ...extra }, quotedMsg ? { quoted: quotedMsg } : {});
      rememberSent(out?.key?.id);
      await wa.sock.sendPresenceUpdate('paused', jid).catch(() => {});
      return true;
    } catch (e) {
      lastSendError = e.message;
      if (!process.env.QB_QUIET) console.warn('[wa] send failed:', e);
      return false;
    }
  });
  sendChain = job.catch(() => false);
  return job;
}

function rememberSent(id, text) {
  if (id) { sentIds.add(id); if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value); }
  if (text) { sentTexts.push(text.trim()); if (sentTexts.length > 50) sentTexts.shift(); }
}

/** Owner follow-up from the Orders screen, quoting the original enquiry when we have it. */
export async function sendOwnerMessage(inquiry, text) {
  if (wa.status !== 'open') throw new Error('WhatsApp is not connected');
  const k = inquiry.msg_key;
  const quoted = k ? { key: k, message: { conversation: inquiry.message || '' } } : undefined;
  rememberSent(null, text);
  const out = await wa.sock.sendMessage(inquiry.group_jid, { text }, quoted ? { quoted } : {});
  rememberSent(out?.key?.id);
}

/* ------------------------------------------------------------------ rotating join links */
const qrCache = new Map();
export async function qrFor(code) {
  if (!code) return null;
  if (!qrCache.has(code)) {
    if (qrCache.size > 200) qrCache.clear();
    qrCache.set(code, await QRCode.toDataURL(`https://chat.whatsapp.com/${code}`, { margin: 1, width: 360 }));
  }
  return qrCache.get(code);
}

/** Revoke the old invite link and issue a new one (bot must be a group admin). */
export async function rotateInvite(jid) {
  if (wa.status !== 'open') throw new Error('WhatsApp is not connected');
  try {
    const code = await wa.sock.groupRevokeInvite(jid);
    if (!code) throw new Error('No invite code returned');
    return patchGroup(jid, { invite_code: code, invite_rotated_at: new Date().toISOString(), invite_error: null, is_admin: true });
  } catch (e) {
    const msg = /not-authorized|forbidden|401|403/i.test(e.message) ? 'Bot number must be an admin of this group to create invite links' : e.message;
    return patchGroup(jid, { invite_error: msg, invite_rotated_at: new Date().toISOString() });
  }
}

export function startInviteRotation() {
  setInterval(async () => {
    if (wa.status !== 'open') return;
    const minutes = Number(getSettings().invite_rotate_minutes) || 10;
    for (const g of listGroups().filter(g => g.join_qr && !g.left_group)) {
      const age = g.invite_rotated_at ? Date.now() - Date.parse(g.invite_rotated_at) : Infinity;
      if (age >= minutes * 60000) {
        await rotateInvite(g.jid).catch(e => console.warn('[wa] rotate failed', g.jid, e.message));
        await sleep(1500);
      }
    }
  }, 20000);
}

/* ------------------------------------------------------------------ payment reminders */
import { remindersDue, markReminderSent, markReminderFailed, reminderVars, hourIST, getOrder } from './orders.js';
import { render } from './quote.js';

/** The reminder text for an order (also used by the dashboard preview). */
export function reminderText(order, template = getTemplates().reminder) {
  return render(template, reminderVars(order));
}

/** Send one order's reminder in its chat: as a reply to the buyer's order message, tagging them in groups. */
export async function sendPaymentReminder(orderOrId, { manual = false } = {}) {
  const o = typeof orderOrId === 'object' ? orderOrId : getOrder(orderOrId);
  if (!o) throw new Error('Order not found');
  if (wa.status !== 'open') throw new Error('WhatsApp is not connected');
  const text = reminderText(o);
  const quoted = o.msg_key && o.msg_key.remoteJid === o.chat_jid
    ? { key: o.msg_key, message: { conversation: o.order_message || '' } } : null;
  const extra = o.chat_type === 'group' && o.customer_jid && text.includes('@') ? { mentions: [o.customer_jid] } : {};
  const s = getSettings();
  const sent = await queueSend(o.chat_jid, text, quoted, s, extra);
  const chatName = o.chat_name || o.chat_jid;
  if (!sent) {
    markReminderFailed(o.id, lastSendError || 'send failed');
    logActivity({ chat: o.chat_jid, chatName, sender: o.customer_name, text: `Payment reminder · order #${o.id}`, result: 'error', detail: lastSendError || 'send failed' });
    if (manual) throw new Error(`Could not send: ${lastSendError || 'send failed'}`);
    return null;
  }
  logActivity({ chat: o.chat_jid, chatName, sender: o.customer_name, text: `Payment reminder · order #${o.id}`, result: 'replied', detail: `payment reminder #${(o.reminders_sent || 0) + 1} sent` });
  return markReminderSent(o.id, { manual });
}

let reminderRunning = false;
/** Send all reminders that are due today (from the configured hour). Safe to call often. */
export async function runPaymentReminders({ now = Date.now() } = {}) {
  const s = getSettings();
  if (!s.payment_reminders_enabled || wa.status !== 'open' || reminderRunning) return { sent: 0 };
  if (hourIST(now) < (Number(s.reminder_hour_ist) || 0)) return { sent: 0 };
  reminderRunning = true;
  let sent = 0;
  try {
    for (const o of remindersDue()) {
      if (wa.status !== 'open') break;
      if (await sendPaymentReminder(o)) sent++;
      await sleep(rand(3, 8) * 1000 * (process.env.QB_FAST ? 0 : 1));   // space them out
    }
  } finally { reminderRunning = false; }
  return { sent };
}

export function startPaymentReminders() {
  setInterval(() => runPaymentReminders().catch(e => console.warn('[pay] reminder run failed:', e.message)), 10 * 60000).unref();
}
