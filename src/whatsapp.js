// WhatsApp connection (Baileys, multi-device "Linked devices"), group sync, auto-reply, rotating join links.
import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, normalizeMessageContent,
  jidNormalizedUser, isJidGroup, areJidsSameUser,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR, getGroup, listGroups, upsertLiveGroup, markGroupsLeft, patchGroup, incrementQuotes,
  createInquiry, getSettings, addCustomGroup, setCurrentAccount,
} from './db.js';
import { planReplies } from './bot.js';

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
  console.log(`[bot] ${e.result.toUpperCase()} · ${e.chatName || e.chat || ''}${who} · "${(e.text || '').slice(0, 60)}"${e.detail ? ' → ' + e.detail : ''}`);
}
const cooldown = new Map();           // `${group}|${sender}|${chem}` -> ts
const groupBurst = new Map();         // group -> [ts]
let reconnectTimer = null;
let retries = 0;
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
    browser: Browsers.ubuntu('Chrome'),
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
      console.log('[wa] connected as', wa.me.id);
      syncGroups().catch(e => console.warn('[wa] group sync failed:', e.message));
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      wa.lastError = lastDisconnect?.error?.message || String(code || 'closed');
      if (wa.sock !== sock) return; // superseded by a newer socket
      if (code === DisconnectReason.loggedOut) {
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

export async function logoutWhatsApp() {
  try { await wa.sock?.logout(); } catch { /* ignore */ }
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  wa.status = 'logged_out'; wa.me = null;
  setCurrentAccount('');
  groupMeta.clear();
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(startWhatsApp, 1500);
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

function allowedByRateLimit(group, sender, chemId, s) {
  const now = Date.now();
  const key = `${group}|${sender}|${chemId}`;
  if (now - (cooldown.get(key) || 0) < (Number(s.cooldown_minutes) || 0) * 60000) return false;
  const burst = (groupBurst.get(group) || []).filter(t => now - t < 10 * 60000);
  if (burst.length >= (Number(s.group_max_replies_per_10min) || 15)) return false;
  cooldown.set(key, now);
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

  const plan = await planReplies(text, { senderName: sender.name });
  const a = plan.analysis;
  if (!a.isRequest) return log('skipped', a.skipReason === 'no request words found' && a.items.length
    ? `found ${a.items.map(i => i.chem.name).join(', ')} but no request words — add "rate", "need", "chahiye", a "?" or a quantity`
    : `not an enquiry (${a.skipReason})`);

  const base = {
    group_jid: jid, group_name: group.name, sender_jid: sender.jid, sender_name: sender.name, sender_phone: sender.phone,
    message: text, msg_key: { id: k.id, remoteJid: rawJid, participant: k.participant, fromMe: !!k.fromMe },
    quantity: a.quantity?.text || null, location: a.location, origin: a.origins.join(', ') || null,
  };

  if (!plan.replies.length) {
    if (a.items.length === 0 && a.unmatchedWorthy) {
      createInquiry({ ...base, intent: 'unmatched', status: 'Unmatched' });
      if (plan.unmatchedReply && allowedByRateLimit(jid, sender.jid, 'unmatched', s)) await queueSend(jid, plan.unmatchedReply, msg, s);
    }
    return log('unmatched', a.items.length ? 'chemical is out of stock / paused' : 'no chemical from your matrix found — add it or its alias, and it is listed in Orders → Unmatched');
  }

  for (const r of plan.replies) {
    if (!allowedByRateLimit(jid, sender.jid, r.chem.id, s)) { log('skipped', `${r.chem.name}: cooldown — same person asked within ${s.cooldown_minutes} min (or group limit reached)`); continue; }
    const sent = await queueSend(jid, r.text, msg, s);
    if (!sent) { log('error', `${r.chem.name}: sending failed — ${lastSendError}`); continue; }
    log('replied', `${r.chem.name} (${r.intent === 'deal' ? 'Deal template' : 'Price Quotation'})`);
    incrementQuotes(jid);
    createInquiry({
      ...base, quantity: r.quantity?.text || base.quantity, chemical_id: r.chem.id, chemical_name: r.chem.name, intent: r.intent, quote_text: r.text,
      quoted_rate: r.quotedRate, status: r.intent === 'deal' ? 'Negotiating' : 'Quoted',
    });
  }
}

/** Sends are serialised with a human-like delay and "typing…" indicator to keep the number safe. */
function queueSend(jid, text, quotedMsg, s = getSettings()) {
  const job = sendChain.then(async () => {
    if (wa.status !== 'open') return false;
    try {
      const min = Number(s.reply_delay_min_sec) || 0, max = Math.max(min, Number(s.reply_delay_max_sec) || 0);
      await wa.sock.sendPresenceUpdate('composing', jid).catch(() => {});
      await sleep(rand(min, max) * 1000);
      rememberSent(null, text);
      const out = await wa.sock.sendMessage(jid, { text }, quotedMsg ? { quoted: quotedMsg } : {});
      rememberSent(out?.key?.id);
      await wa.sock.sendPresenceUpdate('paused', jid).catch(() => {});
      return true;
    } catch (e) {
      lastSendError = e.message;
      console.warn('[wa] send failed:', e);
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
