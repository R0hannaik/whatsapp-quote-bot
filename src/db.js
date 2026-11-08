// SQLite storage: settings, chemicals, groups, templates, inquiries (orders).
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TEMPLATES } from './presets.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
// The data folder holds the WhatsApp session keys and the password hash — keep it private to this user.
try { fs.chmodSync(DATA_DIR, 0o700); } catch { /* not supported on this filesystem */ }

export const db = new Database(path.join(DATA_DIR, 'quotebot.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS chemicals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  aliases      TEXT NOT NULL DEFAULT '',
  price        REAL,
  unit         TEXT NOT NULL DEFAULT 'kg',
  gst          REAL NOT NULL DEFAULT 18,
  manufacturer TEXT DEFAULT '',
  packaging    TEXT DEFAULT '',
  location     TEXT DEFAULT '',
  stock_note   TEXT DEFAULT 'Ready Stock',
  status       TEXT NOT NULL DEFAULT 'In Stock',
  origin_rates TEXT NOT NULL DEFAULT '[]',
  active       INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS groups (
  jid               TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL DEFAULT 'live',   -- live | custom
  members           INTEGER NOT NULL DEFAULT 0,
  quotes_sent       INTEGER NOT NULL DEFAULT 0,
  auto_reply        INTEGER NOT NULL DEFAULT 0,
  is_admin          INTEGER NOT NULL DEFAULT 0,
  join_qr           INTEGER NOT NULL DEFAULT 0,
  invite_code       TEXT,
  invite_rotated_at TEXT,
  invite_error      TEXT,
  left_group        INTEGER NOT NULL DEFAULT 0,
  last_synced       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS templates (
  mode       TEXT PRIMARY KEY,                       -- quote | deal
  body       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS inquiries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  group_jid     TEXT,
  group_name    TEXT,
  sender_jid    TEXT,
  sender_name   TEXT,
  sender_phone  TEXT,
  message       TEXT,
  msg_key       TEXT,
  chemical_id   INTEGER,
  chemical_name TEXT,
  quantity      TEXT,
  location      TEXT,
  origin        TEXT,
  intent        TEXT,             -- quote | deal | unmatched
  quote_text    TEXT,
  quoted_rate   TEXT,
  status        TEXT NOT NULL DEFAULT 'New',
  final_rate    TEXT,
  final_qty     TEXT,
  owner_notes   TEXT,
  history       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_inq_status ON inquiries(status);
CREATE INDEX IF NOT EXISTS idx_inq_created ON inquiries(created_at);
`);

// Columns added later (kept compatible with older databases)
{
  const have = new Set(db.prepare('PRAGMA table_info(inquiries)').all().map(c => c.name));
  if (!have.has('batch_key')) db.exec('ALTER TABLE inquiries ADD COLUMN batch_key TEXT');            // same message → same key
  if (!have.has('batch_size')) db.exec('ALTER TABLE inquiries ADD COLUMN batch_size INTEGER');       // products asked in that message
  if (!have.has('requested_text')) db.exec('ALTER TABLE inquiries ADD COLUMN requested_text TEXT');  // e.g. "DOP" when not in the matrix
}

/* ---------------- settings ---------------- */
export const SETTING_DEFAULTS = {
  business_name: 'Pawan Chemicals',
  contact_phone: '',               // set CONTACT_PHONE in .env
  default_location: 'Bhiwandi / Mumbai Ex-Godown',
  default_gst: 18,
  cooldown_minutes: 3,           // same sender + same chemical in same group
  group_max_replies_per_10min: 15,
  reply_delay_min_sec: 2,
  reply_delay_max_sec: 6,
  max_products_per_message: 10,   // products quoted from one message
  multi_reply_style: 'combined',  // combined = one message for all products · separate = one message per product
  max_message_length: 450,       // longer messages are usually price lists / broadcasts
  ignore_older_than_sec: 120,    // don't answer backlog after reconnect
  quote_out_of_stock: true,
  reply_unmatched: false,
  unmatched_reply: 'Thanks! We\'ll check availability and get back to you shortly. 📞 {contact_phone}',
  deal_keywords: 'last, final, lowest, negotiable, nego, discount, kam, kum, reduce, target, counter, workable, best price, best rate, bulk rate',
  ignore_keywords: 'selling, for sale, we offer, offering, disposal, avl with us, available with us',
  invite_rotate_minutes: 10,
  join_page_token: '',
  reply_to_own_messages: false, // test mode: also answer messages typed on the bot's own phone
  ai_enabled: false,
  ai_model: 'claude-haiku-5-5',
  // payment reminders for placed orders
  payment_reminders_enabled: true,
  default_credit_days: 30,
  reminder_days_before_due: 2,    // first reminder on day 28 of 30
  reminder_repeat_days: 2,        // then every other day until Paid
  reminder_hour_ist: 11,          // send reminders from 11 AM India time
  order_keywords: 'confirm, confirmed, book, booking, book karo, po, purchase order, place order, order confirm, order karo, lock, lock karo, dispatch, dispatch karo, deal done, done deal, proceed, go ahead, final kar do, pakka',
  backup_hour_ist: 3,             // daily database backup time (India time, 0–23)
  backup_keep_days: 14,           // how many daily backups to keep
};

/** Settings that come from .env when present (kept out of the code and the database). */
export const ENV_SETTINGS = { contact_phone: 'CONTACT_PHONE' };
const fromEnv = key => {
  const v = ENV_SETTINGS[key] && process.env[ENV_SETTINGS[key]];
  return v && v.trim() ? v.trim() : undefined;
};
export const envLockedSettings = () => Object.keys(ENV_SETTINGS).filter(k => fromEnv(k) !== undefined);

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

export function getSetting(key) {
  const env = fromEnv(key);
  if (env !== undefined) return env;
  const row = getStmt.get(key);
  if (!row) return SETTING_DEFAULTS[key];
  try { return JSON.parse(row.value); } catch { return row.value; }
}
export function setSetting(key, value) { setStmt.run(key, JSON.stringify(value)); }
export function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    if (key in SETTING_DEFAULTS) { try { out[key] = JSON.parse(value); } catch { out[key] = value; } }
  }
  for (const k of envLockedSettings()) out[k] = fromEnv(k);
  return out;
}

/* ---------------- chemicals ---------------- */
function hydrateChemical(r) {
  if (!r) return r;
  let origin = [];
  try { origin = JSON.parse(r.origin_rates || '[]'); } catch {}
  return { ...r, active: !!r.active, origin_rates: origin, alias_list: splitAliases(r.aliases) };
}
export function splitAliases(s) {
  return String(s || '').split(',').map(a => a.trim()).filter(Boolean);
}
export const listChemicals = () => db.prepare('SELECT * FROM chemicals ORDER BY name COLLATE NOCASE').all().map(hydrateChemical);
export const getChemical = id => hydrateChemical(db.prepare('SELECT * FROM chemicals WHERE id = ?').get(id));

function cleanChemical(c) {
  const num = v => (v === '' || v === null || v === undefined || isNaN(Number(v))) ? null : Number(v);
  const origin = Array.isArray(c.origin_rates) ? c.origin_rates
    .map(o => ({ country: String(o.country || '').trim(), brand: String(o.brand || '').trim(), rate: num(o.rate) }))
    .filter(o => o.country && o.rate !== null) : [];
  return {
    name: String(c.name || '').trim(),
    aliases: splitAliases(c.aliases).join(', '),
    price: num(c.price),
    unit: String(c.unit || 'kg').trim() || 'kg',
    gst: num(c.gst) ?? getSetting('default_gst'),
    manufacturer: String(c.manufacturer || '').trim(),
    packaging: String(c.packaging || '').trim(),
    location: String(c.location || '').trim(),
    stock_note: String(c.stock_note || '').trim(),
    status: String(c.status || 'In Stock').trim(),
    origin_rates: JSON.stringify(origin),
    active: c.active === false || c.active === 0 ? 0 : 1,
  };
}
export function createChemical(c) {
  const v = cleanChemical(c);
  const info = db.prepare(`INSERT INTO chemicals(name, aliases, price, unit, gst, manufacturer, packaging, location, stock_note, status, origin_rates, active)
    VALUES(@name, @aliases, @price, @unit, @gst, @manufacturer, @packaging, @location, @stock_note, @status, @origin_rates, @active)`).run(v);
  return getChemical(info.lastInsertRowid);
}
export function updateChemical(id, c) {
  const v = { ...cleanChemical(c), id };
  db.prepare(`UPDATE chemicals SET name=@name, aliases=@aliases, price=@price, unit=@unit, gst=@gst, manufacturer=@manufacturer,
    packaging=@packaging, location=@location, stock_note=@stock_note, status=@status, origin_rates=@origin_rates, active=@active,
    updated_at=datetime('now') WHERE id=@id`).run(v);
  return getChemical(id);
}
export const deleteChemical = id => db.prepare('DELETE FROM chemicals WHERE id = ?').run(id);

/* ---------------- groups ----------------
 * Groups belong to the WhatsApp number that was linked when they were synced (column `account`).
 * Only the currently linked number's groups are visible; unlinking hides them, relinking the same number
 * brings them back with their toggles. */
(function migrateGroups() {
  const cols = db.prepare("PRAGMA table_info(groups)").all().map(c => c.name);
  if (cols.includes('account')) return;
  db.transaction(() => {
    db.exec(`ALTER TABLE groups RENAME TO groups_old;
      CREATE TABLE groups (
        account           TEXT NOT NULL,
        jid               TEXT NOT NULL,
        name              TEXT NOT NULL,
        type              TEXT NOT NULL DEFAULT 'live',
        members           INTEGER NOT NULL DEFAULT 0,
        quotes_sent       INTEGER NOT NULL DEFAULT 0,
        auto_reply        INTEGER NOT NULL DEFAULT 0,
        is_admin          INTEGER NOT NULL DEFAULT 0,
        join_qr           INTEGER NOT NULL DEFAULT 0,
        invite_code       TEXT,
        invite_rotated_at TEXT,
        invite_error      TEXT,
        left_group        INTEGER NOT NULL DEFAULT 0,
        last_synced       TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (account, jid)
      );
      INSERT INTO groups(account, jid, name, type, members, quotes_sent, auto_reply, is_admin, join_qr, invite_code,
        invite_rotated_at, invite_error, left_group, last_synced, created_at)
      SELECT '__legacy__', jid, name, type, members, quotes_sent, auto_reply, is_admin, join_qr, invite_code,
        invite_rotated_at, invite_error, left_group, last_synced, created_at FROM groups_old;
      DROP TABLE groups_old;`);
  })();
})();

/** The WhatsApp number currently linked (e.g. 9198…@s.whatsapp.net), or '' when none. */
export const currentAccount = () => getSetting('wa_account') || '';
export function setCurrentAccount(account) {
  setSetting('wa_account', account || '');
  if (account) {   // groups saved before this update belong to the first number that links
    db.prepare("UPDATE OR IGNORE groups SET account = ? WHERE account = '__legacy__'").run(account);
    db.prepare("DELETE FROM groups WHERE account = '__legacy__'").run();
  }
}

const hydrateGroup = g => g && ({ ...g, auto_reply: !!g.auto_reply, is_admin: !!g.is_admin, join_qr: !!g.join_qr, left_group: !!g.left_group });
export const listGroups = () => db.prepare('SELECT * FROM groups WHERE account = ? ORDER BY left_group, auto_reply DESC, name COLLATE NOCASE')
  .all(currentAccount()).map(hydrateGroup);
export const getGroup = jid => hydrateGroup(db.prepare('SELECT * FROM groups WHERE account = ? AND jid = ?').get(currentAccount(), jid));

function requireAccount() {
  const a = currentAccount();
  if (!a) throw new Error('Link a WhatsApp number first');
  return a;
}
export function upsertLiveGroup({ jid, name, members, is_admin }) {
  db.prepare(`INSERT INTO groups(account, jid, name, type, members, is_admin, left_group, last_synced)
      VALUES(@account, @jid, @name, 'live', @members, @is_admin, 0, datetime('now'))
    ON CONFLICT(account, jid) DO UPDATE SET name=excluded.name, members=excluded.members, is_admin=excluded.is_admin,
      type=CASE WHEN groups.type='custom' THEN 'live' ELSE groups.type END,
      left_group=0, last_synced=datetime('now')`).run({ account: requireAccount(), jid, name: name || jid, members: members || 0, is_admin: is_admin ? 1 : 0 });
}
export function addCustomGroup({ jid, name }) {
  db.prepare(`INSERT INTO groups(account, jid, name, type) VALUES(?, ?, ?, 'custom')
    ON CONFLICT(account, jid) DO UPDATE SET name=excluded.name`).run(requireAccount(), jid, name || jid);
  return getGroup(jid);
}
export function patchGroup(jid, patch) {
  const allowed = ['name', 'auto_reply', 'join_qr', 'members', 'is_admin', 'invite_code', 'invite_rotated_at', 'invite_error', 'left_group'];
  const sets = []; const vals = {};
  for (const k of allowed) if (k in patch) {
    sets.push(`${k} = @${k}`);
    vals[k] = typeof patch[k] === 'boolean' ? (patch[k] ? 1 : 0) : patch[k];
  }
  if (sets.length) db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE account = @account AND jid = @jid`).run({ ...vals, jid, account: currentAccount() });
  return getGroup(jid);
}
export const markGroupsLeft = jids => {
  const st = db.prepare("UPDATE groups SET left_group = 1, auto_reply = 0 WHERE account = ? AND jid = ? AND type = 'live'");
  const a = currentAccount();
  db.transaction(list => list.forEach(j => st.run(a, j)))(jids);
};
export const incrementQuotes = jid => db.prepare('UPDATE groups SET quotes_sent = quotes_sent + 1 WHERE account = ? AND jid = ?').run(currentAccount(), jid);
export const allAutoReplyOff = () => db.prepare('UPDATE groups SET auto_reply = 0').run();   // every number, to be safe
export const deleteGroup = jid => db.prepare('DELETE FROM groups WHERE account = ? AND jid = ?').run(currentAccount(), jid);

/* ---------------- templates ---------------- */
export const TEMPLATE_MODES = ['quote', 'deal', 'multi', 'multi_item', 'reminder'];
export function getTemplates() {
  const rows = Object.fromEntries(db.prepare('SELECT mode, body FROM templates').all().map(r => [r.mode, r.body]));
  return Object.fromEntries(TEMPLATE_MODES.map(m => [m, rows[m] ?? DEFAULT_TEMPLATES[m]]));
}
export function saveTemplate(mode, body) {
  db.prepare(`INSERT INTO templates(mode, body) VALUES(?, ?) ON CONFLICT(mode) DO UPDATE SET body=excluded.body, updated_at=datetime('now')`).run(mode, body);
}
export const resetTemplate = mode => db.prepare('DELETE FROM templates WHERE mode = ?').run(mode);

/* ---------------- inquiries / orders ---------------- */
export const INQUIRY_STATUSES = ['New', 'Quoted', 'Negotiating', 'Awaiting Owner', 'Confirmed', 'On Hold', 'Rejected', 'Dispatched', 'Unmatched'];

const hydrateInquiry = r => r && ({ ...r, history: JSON.parse(r.history || '[]'), msg_key: r.msg_key ? JSON.parse(r.msg_key) : null });

export function createInquiry(i) {
  const { history_text, ...row } = i;
  i = row;
  const history = [{ at: new Date().toISOString(), by: 'bot', text: history_text || (i.status === 'Unmatched' ? 'Request received, no chemical matched' : `Auto-quote sent (${i.intent === 'deal' ? 'Deal & Negotiation' : 'Price Quotation'})`) }];
  const info = db.prepare(`INSERT INTO inquiries(group_jid, group_name, sender_jid, sender_name, sender_phone, message, msg_key, chemical_id,
      chemical_name, quantity, location, origin, intent, quote_text, quoted_rate, status, history, batch_key, batch_size, requested_text)
    VALUES(@group_jid, @group_name, @sender_jid, @sender_name, @sender_phone, @message, @msg_key, @chemical_id, @chemical_name,
      @quantity, @location, @origin, @intent, @quote_text, @quoted_rate, @status, @history, @batch_key, @batch_size, @requested_text)`).run({
    group_jid: null, group_name: null, sender_jid: null, sender_name: null, sender_phone: null, message: null, chemical_id: null,
    chemical_name: null, quantity: null, location: null, origin: null, intent: null, quote_text: null, quoted_rate: null,
    batch_key: null, batch_size: null, requested_text: null,
    ...i, msg_key: i.msg_key ? JSON.stringify(i.msg_key) : null, history: JSON.stringify(history),
  });
  return info.lastInsertRowid;
}
export const getInquiry = id => hydrateInquiry(db.prepare('SELECT * FROM inquiries WHERE id = ?').get(id));

export function listInquiries({ status, q, from, to, batch, ids, limit = 500 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 50000);
  q = q ? String(q).slice(0, 100) : '';
  const where = []; const p = {};
  if (Array.isArray(ids)) { where.push(`id IN (${ids.map(Number).filter(Number.isInteger).join(',') || 'NULL'})`); }
  if (status && status !== 'all' && status !== 'payment_pending') {
    if (status === 'open') where.push("status IN ('New','Quoted','Negotiating','Awaiting Owner','On Hold')");
    else { where.push('status = @status'); p.status = status; }
  }
  if (q) { where.push('(message LIKE @q OR chemical_name LIKE @q OR requested_text LIKE @q OR group_name LIKE @q OR sender_name LIKE @q OR sender_phone LIKE @q OR owner_notes LIKE @q)'); p.q = `%${q}%`; }
  if (batch) { where.push('batch_key = @batch'); p.batch = String(batch).slice(0, 100); }
  if (from) { where.push("date(created_at, '+330 minutes') >= @from"); p.from = from; }
  if (to) { where.push("date(created_at, '+330 minutes') <= @to"); p.to = to; }
  const sql = `SELECT * FROM inquiries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`;
  return db.prepare(sql).all(p).map(hydrateInquiry);
}

export function updateInquiry(id, patch, by = 'owner') {
  const cur = getInquiry(id);
  if (!cur) return null;
  const fields = ['status', 'final_rate', 'final_qty', 'owner_notes'];
  const next = { ...cur };
  const changes = [];
  for (const f of fields) if (f in patch && patch[f] !== cur[f]) {
    next[f] = patch[f];
    if (f === 'status') changes.push(`Status → ${patch[f]}`);
    if (f === 'final_rate') changes.push(`Final rate: ${patch[f] || '—'}`);
    if (f === 'final_qty') changes.push(`Final qty: ${patch[f] || '—'}`);
    if (f === 'owner_notes') changes.push('Notes updated');
  }
  if (patch.log) changes.push(patch.log);
  if (!changes.length) return cur;
  const history = [...cur.history, { at: new Date().toISOString(), by, text: changes.join(' · ') }];
  db.prepare(`UPDATE inquiries SET status=@status, final_rate=@final_rate, final_qty=@final_qty, owner_notes=@owner_notes,
      history=@history, updated_at=datetime('now') WHERE id=@id`).run({
    id, status: next.status, final_rate: next.final_rate ?? null, final_qty: next.final_qty ?? null,
    owner_notes: next.owner_notes ?? null, history: JSON.stringify(history),
  });
  return getInquiry(id);
}
/** The latest enquiry from this person in this chat that the bot answered (for follow-ups / orders). */
export function findRecentInquiry(chatJid, senderJid, withinHours = 7 * 24) {
  if (!chatJid || !senderJid) return null;
  return hydrateInquiry(db.prepare(`SELECT * FROM inquiries WHERE group_jid = ? AND sender_jid = ?
      AND status IN ('Quoted','Negotiating','Awaiting Owner','On Hold') AND created_at >= datetime('now', ?)
    ORDER BY id DESC LIMIT 1`).get(chatJid, senderJid, `-${Number(withinHours)} hours`));
}

/** Hand an enquiry to the owner: status → Awaiting Owner, log the buyer's new message, remember it for replies. */
export function flagInquiry(id, { text, kind, msg_key }) {
  const cur = getInquiry(id);
  if (!cur) return null;
  const label = kind === 'order' ? '🛒 Wants to place an order' : '💬 Follow-up';
  const history = [...cur.history, { at: new Date().toISOString(), by: 'buyer', text: `${label}: "${String(text).slice(0, 300)}"` }];
  db.prepare(`UPDATE inquiries SET status = 'Awaiting Owner', history = @history, updated_at = datetime('now')
      ${msg_key ? ', msg_key = @msg_key, message = @message' : ''}${kind === 'order' ? ", intent = 'order'" : ''} WHERE id = @id`)
    .run({ id, history: JSON.stringify(history), ...(msg_key ? { msg_key: JSON.stringify(msg_key), message: String(text).slice(0, 4000) } : {}) });
  return getInquiry(id);
}

export const deleteInquiry = id => db.prepare('DELETE FROM inquiries WHERE id = ?').run(id);

export function inquiryStats() {
  const today = db.prepare(`SELECT COUNT(*) n FROM inquiries WHERE date(created_at, '+330 minutes') = date('now', '+330 minutes')`).get().n;
  const quotedToday = db.prepare(`SELECT COUNT(*) n FROM inquiries WHERE quote_text IS NOT NULL AND date(created_at, '+330 minutes') = date('now', '+330 minutes')`).get().n;
  const pending = db.prepare(`SELECT COUNT(*) n FROM inquiries WHERE status IN ('New','Quoted','Negotiating','Awaiting Owner','On Hold')`).get().n;
  const negotiating = db.prepare(`SELECT COUNT(*) n FROM inquiries WHERE status IN ('Negotiating','Awaiting Owner')`).get().n;
  const confirmed = db.prepare(`SELECT COUNT(*) n FROM inquiries WHERE status IN ('Confirmed','Dispatched') AND date(updated_at, '+330 minutes') >= date('now', '+330 minutes', '-30 days')`).get().n;
  const unmatched = db.prepare(`SELECT COUNT(*) n FROM inquiries WHERE status = 'Unmatched'`).get().n;
  return { today, quotedToday, pending, negotiating, confirmed, unmatched };
}

/* ---------------- first-run seed ---------------- */
export function ensureSecrets() {
  if (!getStmt.get('session_secret')) setSetting('session_secret', crypto.randomBytes(32).toString('hex'));
  if (!getSetting('join_page_token')) setSetting('join_page_token', crypto.randomBytes(9).toString('base64url'));
}

export function seedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) n FROM chemicals').get().n;
  if (n > 0) return;
  const loc = SETTING_DEFAULTS.default_location;
  const seed = [
    { name: 'Phthalic Anhydride', aliases: 'pa, p.a., phthalic, phthalic anhydride, pthalic anhydride', price: null, unit: 'kg', manufacturer: 'IGPL', packaging: '25 kgs Bag', location: loc, stock_note: 'Ready Stock', status: 'Subject to Confirmation',
      origin_rates: [{ country: 'India', brand: 'Reliance / IGPL', rate: 108.5 }, { country: 'Russia', brand: 'Imported', rate: 105 }, { country: 'Korea', brand: 'Aekyung', rate: 110 }] },
    { name: 'Acrylic Acid', aliases: 'aa, a.a., acrylic, acrylic acid', price: null, unit: 'kg', manufacturer: '', packaging: '200 kg Drum', location: loc, stock_note: 'Ready Stock', status: 'Subject to Confirmation',
      origin_rates: [{ country: 'Korea', brand: '', rate: 150 }, { country: 'Indonesia', brand: '', rate: 144 }, { country: 'China', brand: '', rate: 138 }] },
    { name: 'Maleic Anhydride', aliases: 'ma, m.a, maleic, maleic anhydride, malic, malic china boiko', price: null, unit: 'kg', manufacturer: 'Tengda', packaging: '25 kg Bag', location: loc, stock_note: 'Ready Stock', status: 'Subject to Confirmation',
      origin_rates: [{ country: 'China', brand: 'Tengda', rate: 165 }, { country: 'China', brand: 'Boiko', rate: 168 }] },
    { name: 'Monosodium Glutamate', aliases: 'msg, m.s.g., ajinomoto, monosodium glutamate', price: 120, unit: 'kg', manufacturer: 'MEIHUA', packaging: '25 kgs Bag', location: loc, stock_note: 'Ready Stock', status: 'Limited', origin_rates: [] },
    { name: 'Caustic Soda Flakes', aliases: 'caustic, caustic soda, csf, sodium hydroxide, naoh', price: 48.5, unit: 'kg', manufacturer: 'GACL', packaging: '50 kg Bag', location: loc, stock_note: 'Ready Stock', status: 'In Stock', origin_rates: [] },
    { name: 'Isopropyl Alcohol', aliases: 'ipa, i.p.a., isopropyl, isopropyl alcohol, isopropanol', price: 102, unit: 'kg', manufacturer: 'Deepak', packaging: '160 kg Drum', location: loc, stock_note: 'Ready Stock', status: 'In Stock', origin_rates: [] },
  ];
  db.transaction(() => seed.forEach(createChemical))();
}
