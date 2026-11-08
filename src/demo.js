// Demo mode (DEMO_MODE=1): for showing the product to clients.
// - Separate data, realistic sample content, its own password.
// - No real WhatsApp: a simulated connection runs the REAL bot logic, and the "Demo Chat" screen lets you type as a
//   buyer in a group and watch the bot reply, hand orders to the owner, send payment reminders, etc.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { db, getSetting, setSetting, upsertLiveGroup, patchGroup, setCurrentAccount, createInquiry, updateInquiry } from './db.js';
import * as ord from './orders.js';
import { wa, handleMessage, activity } from './whatsapp.js';
import { planReplies } from './bot.js';

export const isDemo = () => process.env.DEMO_MODE === '1';
export const BOT_JID = '919000000000@s.whatsapp.net';

export const DEMO_GROUPS = [
  { jid: '120363401111111111@g.us', name: 'Mumbai Chemical Traders', members: 248, auto: true, admin: true },
  { jid: '120363402222222222@g.us', name: 'Bhiwandi Solvent Brokers', members: 87, auto: true, admin: false },
  { jid: '120363403333333333@g.us', name: 'Vapi – Ankleshwar Buyers', members: 163, auto: true, admin: true },
  { jid: '120363404444444444@g.us', name: 'Gujarat Petrochem Network', members: 512, auto: false, admin: false },
  { jid: '120363405555555555@g.us', name: 'Family Group', members: 12, auto: false, admin: false },
];
const BUYERS = [
  { name: 'Rakesh Shah', phone: '919820011001' }, { name: 'Amit Traders', phone: '919820011002' }, { name: 'Neha Chem', phone: '919820011003' },
  { name: 'Suresh Polymers', phone: '919820011004' }, { name: 'Vikas Industries', phone: '919820011005' }, { name: 'Kiran Dyes', phone: '919820011006' },
];

/* ---------------- simulated WhatsApp ---------------- */
export const chat = [];   // { id, jid, from: 'buyer'|'bot', name, text, at, quotedId }
let seq = 0;
const trim = () => { if (chat.length > 500) chat.splice(0, chat.length - 500); };

export function attachDemoSocket() {
  const meta = g => ({ id: g.jid, subject: g.name, size: g.members,
    participants: [{ id: BOT_JID, admin: g.admin ? 'admin' : null }, ...BUYERS.map(b => ({ id: `${b.phone}@s.whatsapp.net`, admin: null }))] });
  wa.sock = {
    ev: new EventEmitter(),
    authState: { creds: { me: { id: BOT_JID } } },
    sendPresenceUpdate: async () => {},
    sendMessage: async (jid, content, opts = {}) => {
      const id = `DEMOBOT${++seq}`;
      chat.push({ id, jid, from: 'bot', name: 'Quote Bot', text: content.text, at: new Date().toISOString(), quotedId: opts.quoted?.key?.id || null });
      trim();
      return { key: { id, remoteJid: jid, fromMe: true } };
    },
    groupFetchAllParticipating: async () => Object.fromEntries(DEMO_GROUPS.map(g => [g.jid, meta(g)])),
    groupMetadata: async jid => meta(DEMO_GROUPS.find(g => g.jid === jid) || DEMO_GROUPS[0]),
    groupRevokeInvite: async () => crypto.randomBytes(11).toString('base64url'),
    groupAcceptInvite: async () => { throw new Error('Joining groups by invite is turned off in the demo'); },
    query: async () => ({}),
    end() {}, logout: async () => {},
  };
  wa.status = 'open';
  wa.me = { id: BOT_JID, name: 'Quote Bot (demo)' };
  wa.qr = null; wa.lastError = null; wa.lastSync = new Date().toISOString();
  setCurrentAccount(BOT_JID);
}

/** A buyer "sends" a message in a demo chat; the real bot handles it. Returns what was added to the chat. */
export async function demoMessage({ jid, name, phone, text, replyToId }) {
  const group = DEMO_GROUPS.find(g => g.jid === jid);
  if (!group) throw new Error('Pick one of the demo groups');
  text = String(text || '').trim().slice(0, 2000);
  if (!text) throw new Error('Type a message');
  const digits = String(phone || '').replace(/\D/g, '').slice(-12) || '919820011099';
  const before = chat.length;
  const actBefore = activity[0];
  const id = `DEMOIN${++seq}`;
  chat.push({ id, jid, from: 'buyer', name: String(name || 'Buyer').slice(0, 40), text, at: new Date().toISOString(), quotedId: replyToId || null });
  const msg = {
    key: { remoteJid: jid, id, participant: `${digits}@s.whatsapp.net`, fromMe: false },
    pushName: String(name || 'Buyer').slice(0, 40),
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: replyToId
      ? { extendedTextMessage: { text, contextInfo: { stanzaId: replyToId, participant: BOT_JID } } }
      : { conversation: text },
  };
  await handleMessage(msg);
  const happened = [];
  for (const a of activity) { if (a === actBefore) break; happened.push(a); if (happened.length >= 5) break; }
  return { added: chat.slice(before), activity: happened };
}

/* ---------------- sample data ---------------- */
const daysAgo = (n, h = 11) => { const d = new Date(Date.now() - n * 86400000); d.setUTCHours(h - 5, 30, 0, 0); return d.toISOString().replace('T', ' ').slice(0, 19); };

export async function seedDemo({ force = false } = {}) {
  if (getSetting('demo_seeded') && !force) return false;
  db.exec('DELETE FROM inquiries; DELETE FROM orders; DELETE FROM groups;');
  chat.length = 0; activity.length = 0;
  setCurrentAccount(BOT_JID);

  // settings that make the demo feel snappy
  for (const [k, v] of Object.entries({ reply_delay_min_sec: 1, reply_delay_max_sec: 2, cooldown_minutes: 0, group_max_replies_per_10min: 100 })) setSetting(k, v);
  if (!process.env.CONTACT_PHONE && !getSetting('contact_phone')) setSetting('contact_phone', process.env.DEMO_CONTACT_PHONE || '+91 90000 00000');

  for (const g of DEMO_GROUPS) {
    upsertLiveGroup({ jid: g.jid, name: g.name, members: g.members, is_admin: g.admin });
    patchGroup(g.jid, { auto_reply: g.auto });
  }
  const setQuotes = (jid, n) => db.prepare('UPDATE groups SET quotes_sent = ? WHERE jid = ?').run(n, jid);
  setQuotes(DEMO_GROUPS[0].jid, 46); setQuotes(DEMO_GROUPS[1].jid, 19); setQuotes(DEMO_GROUPS[2].jid, 27);
  patchGroup(DEMO_GROUPS[0].jid, { join_qr: true, invite_code: crypto.randomBytes(11).toString('base64url'), invite_rotated_at: new Date().toISOString() });

  const [G1, G2, G3] = DEMO_GROUPS;
  const B = BUYERS;
  async function enquiry({ g, b, text, status, ago, extra = {}, history }) {
    const plan = await planReplies(text, { senderName: b.name, useAi: false });
    const r = plan.replies[0];
    const item = r?.items[0];
    const id = createInquiry({
      group_jid: g.jid, group_name: g.name, sender_jid: `${b.phone}@s.whatsapp.net`, sender_name: b.name, sender_phone: `+${b.phone}`, message: text,
      msg_key: { id: `SEED${++seq}`, remoteJid: g.jid, participant: `${b.phone}@s.whatsapp.net`, fromMe: false },
      chemical_id: item?.chem.id ?? null, chemical_name: item?.chem.name ?? extra.chemical_name ?? null, quantity: item?.quantity?.text ?? null,
      location: plan.analysis.location, origin: plan.analysis.origins.join(', ') || null, intent: r?.intent || 'unmatched',
      quote_text: r?.text || null, quoted_rate: item?.quotedRate || null, status: r ? 'Quoted' : 'Unmatched', ...extra,
    });
    if (status && status !== 'Quoted') updateInquiry(id, { status, ...(history ? { log: history } : {}) });
    db.prepare('UPDATE inquiries SET created_at = ?, updated_at = ? WHERE id = ?').run(daysAgo(ago), daysAgo(ago), id);
    return id;
  }

  await enquiry({ g: G1, b: B[0], text: 'PA 2 ton Bhiwandi rate urgent chahiye', ago: 0 });
  await enquiry({ g: G2, b: B[1], text: 'MA china last rate kya hai? 10 MT Vapi', status: 'Negotiating', ago: 0 });
  const awaiting = await enquiry({ g: G1, b: B[3], text: 'PA Korea 3 MT rate?', ago: 1 });
  db.prepare("UPDATE inquiries SET status = 'Awaiting Owner', intent = 'order', message = ?, history = json_insert(history, '$[#]', json(?)) WHERE id = ?")
    .run('ok confirm karo, dispatch kal', JSON.stringify({ at: new Date().toISOString(), by: 'buyer', text: '🛒 Wants to place an order: "ok confirm karo, dispatch kal"' }), awaiting);
  await enquiry({ g: G3, b: B[2], text: 'Need DOP 5 drums rate pls', ago: 1 });
  // a multi-product enquiry
  const plan = await planReplies('Need rates:\n1. PA 2 MT\n2. IPA 20 drums\n3. MSG 1 ton', { senderName: B[5].name });
  for (const it of plan.replies[0]?.items || []) {
    const id = createInquiry({ group_jid: G1.jid, group_name: G1.name, sender_jid: `${B[5].phone}@s.whatsapp.net`, sender_name: B[5].name, sender_phone: `+${B[5].phone}`,
      message: 'Need rates:\n1. PA 2 MT\n2. IPA 20 drums\n3. MSG 1 ton', chemical_id: it.chem.id, chemical_name: it.chem.name, quantity: it.quantity?.text, intent: 'quote',
      quote_text: plan.replies[0].text, quoted_rate: it.quotedRate, status: 'Quoted', batch_key: 'DEMO-MULTI-1', batch_size: 3 });
    db.prepare('UPDATE inquiries SET created_at = ? WHERE id = ?').run(daysAgo(2), id);
  }
  await enquiry({ g: G2, b: B[4], text: 'IPA 40 drums rate', status: 'Rejected', ago: 4, history: 'Buyer wanted ₹92 — below cost' });

  // placed orders & payments
  const order = async (b, g, ask, confirm, amount, ago, extra = {}) => {
    const id = await enquiry({ g, b, text: ask, ago, status: 'Confirmed' });
    const inq = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(id);
    return ord.createOrder({ inquiry_id: id, chat_jid: g.jid, chat_name: g.name, chat_type: 'group', customer_name: b.name, customer_phone: `+${b.phone}`,
      customer_jid: `${b.phone}@s.whatsapp.net`, product: inq.chemical_name, quantity: inq.quantity, amount, order_date: ord.addDays(ord.todayIST(), -ago),
      msg_key: JSON.parse(inq.msg_key), order_message: confirm, ...extra });
  };
  const overdue = await order(B[0], G1, 'PA 2 MT rate?', 'ok PA 2 MT confirm', 256000, 36, { invoice_no: 'PC/2026/1170' });
  db.prepare('UPDATE orders SET reminders_sent = 4, last_reminder_date = ?, next_reminder_date = ? WHERE id = ?')
    .run(ord.addDays(ord.todayIST(), -2), ord.todayIST(), overdue.id);
  await order(B[1], G2, 'MA China 5 MT rate pls', 'MA 5 MT final, book karo', 990000, 28, { invoice_no: 'PC/2026/1182' });   // reminder due today (day 28)
  await order(B[2], G3, 'IPA 20 drums rate', 'IPA 20 drums book karo', 389000, 12, { chat_type: 'private', chat_jid: `${B[2].phone}@s.whatsapp.net`, chat_name: `Private chat · +${B[2].phone}` });
  const paid = await order(B[4], G2, 'Acrylic acid 10 MT rate?', 'AA 10 MT ok confirm', 1620000, 20, { invoice_no: 'PC/2026/1190' });
  ord.setPaymentStatus(paid.id, 'Paid');

  // a little history in the activity log
  const now = Date.now();
  activity.push(
    { at: new Date(now - 60e3).toISOString(), chat: G1.jid, chatName: G1.name, sender: B[0].name, text: 'PA 2 ton Bhiwandi rate urgent chahiye', result: 'replied', detail: 'Phthalic Anhydride (Price Quotation)' },
    { at: new Date(now - 180e3).toISOString(), chat: G2.jid, chatName: G2.name, sender: 'Mahesh', text: 'Good morning all 🙏', result: 'skipped', detail: 'not an enquiry (no request words found)' },
    { at: new Date(now - 300e3).toISOString(), chat: G1.jid, chatName: G1.name, sender: 'Deepak', text: 'PA Korea available with us @ 104/kg', result: 'skipped', detail: 'not an enquiry (seller post ("available with us"))' },
  );
  setSetting('demo_seeded', true);
  return true;
}

/** Password for the demo (or trial): the env var if set, else one generated once and kept in the data folder. */
export function demoPassword(dataDir, fs, path, { env = 'DEMO_PASSWORD', prefix = 'demo' } = {}) {
  if (process.env[env]) return { password: process.env[env], generated: false };
  const file = path.join(dataDir, `${prefix}-password.txt`);
  if (fs.existsSync(file)) return { password: fs.readFileSync(file, 'utf8').trim(), generated: true };
  const pw = `${prefix}-${crypto.randomBytes(6).toString('base64url')}`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, pw, { mode: 0o600 });
  return { password: pw, generated: true };
}
