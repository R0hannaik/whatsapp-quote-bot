// Placed orders and payment follow-up.
// An order belongs to the chat (group or private) where it was placed. While it is Pending, the buyer gets a
// payment reminder there on day (credit_days − reminder_days_before_due) — day 28 for 30-day credit — and then
// every `reminder_repeat_days` days until the owner marks it Paid.
import { db, getSetting, getSettings, getInquiry, updateInquiry } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  inquiry_id         INTEGER,
  chat_jid           TEXT NOT NULL,              -- where reminders go: group jid or person@s.whatsapp.net
  chat_name          TEXT,
  chat_type          TEXT NOT NULL DEFAULT 'group',  -- group | private
  customer_name      TEXT,
  customer_phone     TEXT,
  customer_jid       TEXT,                       -- for @mentions in groups
  msg_key            TEXT,                       -- the buyer's message to reply to (JSON)
  order_message      TEXT,                       -- that message's text (needed to quote it)
  product            TEXT NOT NULL,
  quantity           TEXT,
  rate               TEXT,
  amount             REAL NOT NULL,
  invoice_no         TEXT,
  order_date         TEXT NOT NULL,              -- YYYY-MM-DD (India time)
  credit_days        INTEGER NOT NULL DEFAULT 30,
  due_date           TEXT NOT NULL,
  payment_status     TEXT NOT NULL DEFAULT 'Pending',   -- Pending | Paid
  paid_date          TEXT,
  reminders_enabled  INTEGER NOT NULL DEFAULT 1,
  reminders_sent     INTEGER NOT NULL DEFAULT 0,
  last_reminder_date TEXT,
  next_reminder_date TEXT,
  last_error         TEXT,
  notes              TEXT,
  history            TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(payment_status, next_reminder_date);
`);

/* ---------------- dates (India time, as YYYY-MM-DD strings) ---------------- */
export const todayIST = (now = Date.now()) => new Date(now + 330 * 60000).toISOString().slice(0, 10);
export const hourIST = (now = Date.now()) => new Date(now + 330 * 60000).getUTCHours();
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(n));
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const fmtDate = s => s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
export const fmtAmount = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/* ---------------- reminder schedule ---------------- */
const daysBefore = () => Math.max(0, Number(getSetting('reminder_days_before_due')) || 0);
const repeatDays = () => Math.max(1, Number(getSetting('reminder_repeat_days')) || 2);

/** First reminder day for an order: due date minus N days (day 28 of 30), never before the order date. */
export function firstReminderDate(o) {
  const first = addDays(o.order_date, Number(o.credit_days) - daysBefore());
  return first < o.order_date ? o.order_date : first;
}

/** When the next reminder should go, given what has been sent so far. null = no more reminders. */
export function nextReminderDate(o, today = todayIST()) {
  if (o.payment_status === 'Paid' || !o.reminders_enabled) return null;
  const first = firstReminderDate(o);
  let next = o.last_reminder_date ? addDays(o.last_reminder_date, repeatDays()) : first;
  if (next < first) next = first;
  if (next < today && !o.last_reminder_date) next = today;   // order recorded late: remind from today, once
  return next;
}

/* ---------------- CRUD ---------------- */
function hydrate(r) {
  if (!r) return r;
  return { ...r, reminders_enabled: !!r.reminders_enabled, msg_key: r.msg_key ? JSON.parse(r.msg_key) : null, history: JSON.parse(r.history || '[]') };
}
export const getOrder = id => hydrate(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));

function clean(input, existing = {}) {
  const s = getSettings();
  const o = { ...existing };
  const str = (k, max = 200) => { if (k in input) o[k] = input[k] == null ? null : String(input[k]).trim().slice(0, max) || null; };
  str('order_message', 1000);
  ['chat_jid', 'chat_name', 'customer_name', 'customer_phone', 'customer_jid', 'product', 'quantity', 'rate', 'invoice_no'].forEach(k => str(k));
  str('notes', 2000);
  if ('chat_type' in input) o.chat_type = input.chat_type === 'private' ? 'private' : 'group';
  if ('amount' in input) o.amount = Number(String(input.amount).replace(/[₹,\s]/g, ''));
  if ('order_date' in input) o.order_date = String(input.order_date || '').slice(0, 10);
  if ('credit_days' in input) o.credit_days = parseInt(input.credit_days, 10);
  if ('reminders_enabled' in input) o.reminders_enabled = input.reminders_enabled === false || input.reminders_enabled === 0 ? 0 : 1;
  if ('msg_key' in input) o.msg_key = input.msg_key ? JSON.stringify(input.msg_key) : null;
  if ('inquiry_id' in input) o.inquiry_id = input.inquiry_id ? Number(input.inquiry_id) : null;
  o.order_date ??= todayIST();
  o.credit_days ??= Number(s.default_credit_days) || 30;
  o.reminders_enabled ??= 1;
  o.chat_type ??= String(o.chat_jid || '').endsWith('@g.us') ? 'group' : 'private';

  if (!o.product) throw new Error('Enter the product / order description');
  if (!Number.isFinite(o.amount) || o.amount <= 0) throw new Error('Enter the order amount in ₹');
  if (!isDate(o.order_date)) throw new Error('Order date must be a valid date');
  if (o.order_date > addDays(todayIST(), 1)) throw new Error('Order date cannot be in the future');
  if (!Number.isInteger(o.credit_days) || o.credit_days < 1 || o.credit_days > 365) throw new Error('Credit days must be between 1 and 365');
  if (!/@(g\.us|s\.whatsapp\.net|lid)$/.test(String(o.chat_jid || ''))) throw new Error('Choose where reminders should be sent (group or the buyer’s number)');
  o.due_date = addDays(o.order_date, o.credit_days);
  return o;
}

const COLS = ['inquiry_id', 'order_message', 'chat_jid', 'chat_name', 'chat_type', 'customer_name', 'customer_phone', 'customer_jid', 'msg_key', 'product', 'quantity', 'rate',
  'amount', 'invoice_no', 'order_date', 'credit_days', 'due_date', 'payment_status', 'paid_date', 'reminders_enabled', 'reminders_sent',
  'last_reminder_date', 'next_reminder_date', 'last_error', 'notes', 'history'];

function save(o) {
  const row = Object.fromEntries(COLS.map(c => [c, o[c] ?? null]));
  row.history = JSON.stringify(o.history || []);
  if (typeof row.msg_key === 'object' && row.msg_key) row.msg_key = JSON.stringify(row.msg_key);
  row.reminders_enabled = row.reminders_enabled === false || row.reminders_enabled === 0 ? 0 : 1;
  row.reminders_sent ??= 0;
  row.payment_status ??= 'Pending';
  if (o.id) {
    db.prepare(`UPDATE orders SET ${COLS.map(c => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...row, id: o.id });
    return o.id;
  }
  return db.prepare(`INSERT INTO orders(${COLS.join(', ')}) VALUES(${COLS.map(c => '@' + c).join(', ')})`).run(row).lastInsertRowid;
}
const event = (o, text, by = 'owner') => { o.history = [...(o.history || []), { at: new Date().toISOString(), by, text }]; };

export function createOrder(input) {
  const o = clean(input);
  o.payment_status = 'Pending';
  o.reminders_sent = 0;
  o.next_reminder_date = nextReminderDate(o);
  event(o, `Order recorded: ${o.product}${o.quantity ? ` · ${o.quantity}` : ''} · ${fmtAmount(o.amount)} · due ${fmtDate(o.due_date)}`);
  const id = save(o);
  if (o.inquiry_id && getInquiry(o.inquiry_id)) updateInquiry(o.inquiry_id, { status: 'Confirmed', log: `Order #${id} recorded (${fmtAmount(o.amount)})` });
  return getOrder(id);
}

export function updateOrder(id, input) {
  const cur = getOrder(id);
  if (!cur) throw new Error('Order not found');
  const o = clean(input, { ...cur, msg_key: cur.msg_key ? JSON.stringify(cur.msg_key) : null });
  const changed = ['product', 'quantity', 'rate', 'amount', 'invoice_no', 'order_date', 'credit_days', 'chat_jid', 'reminders_enabled']
    .filter(k => String(o[k] ?? '') !== String(cur[k] === true ? 1 : cur[k] === false ? 0 : cur[k] ?? ''));
  o.next_reminder_date = nextReminderDate(o);
  if (changed.length) event(o, `Edited: ${changed.join(', ').replace(/_/g, ' ')}${changed.includes('reminders_enabled') ? (o.reminders_enabled ? ' (reminders ON)' : ' (reminders paused)') : ''}`);
  else if ('notes' in input) event(o, 'Notes updated');
  save(o);
  return getOrder(id);
}

export function setPaymentStatus(id, status) {
  const o = getOrder(id);
  if (!o) throw new Error('Order not found');
  if (!['Pending', 'Paid'].includes(status)) throw new Error('Status must be Pending or Paid');
  if (o.payment_status === status) return o;
  o.payment_status = status;
  o.paid_date = status === 'Paid' ? todayIST() : null;
  o.next_reminder_date = nextReminderDate(o);
  event(o, status === 'Paid' ? 'Marked Paid — reminders stopped' : 'Marked Pending again — reminders resumed');
  save(o);
  return getOrder(id);
}

/** Latest order recorded for each of these enquiries: { inquiryId: {order_id, payment_status, due_date, paid_date, amount} } */
export function ordersForInquiries(ids) {
  const list = ids.map(Number).filter(Number.isInteger);
  if (!list.length) return {};
  const rows = db.prepare(`SELECT id, inquiry_id, payment_status, due_date, paid_date, amount FROM orders
    WHERE inquiry_id IN (${list.join(',')}) ORDER BY id`).all();
  return Object.fromEntries(rows.map(r => [r.inquiry_id, { order_id: r.id, payment_status: r.payment_status, due_date: r.due_date, paid_date: r.paid_date, amount: r.amount }]));
}
/** Enquiries whose order still has a pending payment. */
export const pendingInquiryIds = () => db.prepare("SELECT DISTINCT inquiry_id FROM orders WHERE payment_status = 'Pending' AND inquiry_id IS NOT NULL").all().map(r => r.inquiry_id);

export const deleteOrder = id => db.prepare('DELETE FROM orders WHERE id = ?').run(id);

export function listOrders({ status = 'Pending', q } = {}) {
  const where = []; const p = { today: todayIST() };
  if (status === 'Pending' || status === 'Paid') { where.push('payment_status = @status'); p.status = status; }
  if (status === 'Overdue') where.push("payment_status = 'Pending' AND due_date < @today");
  if (status === 'DueSoon') { where.push("payment_status = 'Pending' AND due_date >= @today AND due_date <= @soon"); p.soon = addDays(p.today, 7); }
  if (q) { where.push('(product LIKE @q OR customer_name LIKE @q OR customer_phone LIKE @q OR chat_name LIKE @q OR invoice_no LIKE @q)'); p.q = `%${String(q).slice(0, 100)}%`; }
  const order = status === 'Paid' ? 'paid_date DESC, id DESC' : 'due_date ASC, id ASC';
  return db.prepare(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 2000`).all(p).map(hydrate);
}

export function paymentStats(today = todayIST()) {
  const one = sql => db.prepare(sql).get({ today, soon: addDays(today, 7), month: today.slice(0, 7) });
  const pending = one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM orders WHERE payment_status = 'Pending'");
  const overdue = one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM orders WHERE payment_status = 'Pending' AND due_date < @today");
  const soon = one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM orders WHERE payment_status = 'Pending' AND due_date >= @today AND due_date <= @soon");
  const paid = one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM orders WHERE payment_status = 'Paid' AND substr(paid_date,1,7) = @month");
  return { pending, overdue, dueSoon: soon, paidThisMonth: paid };
}

/** Orders whose reminder is due today (or was missed while the bot was offline). */
export const remindersDue = (today = todayIST()) => db.prepare(`SELECT * FROM orders WHERE payment_status = 'Pending' AND reminders_enabled = 1
  AND next_reminder_date IS NOT NULL AND next_reminder_date <= ? AND (last_reminder_date IS NULL OR last_reminder_date < ?) ORDER BY due_date`).all(today, today).map(hydrate);

export function markReminderSent(id, { manual = false } = {}) {
  const o = getOrder(id);
  const today = todayIST();
  o.reminders_sent = (o.reminders_sent || 0) + 1;
  o.last_reminder_date = today;
  o.last_error = null;
  o.next_reminder_date = nextReminderDate(o, today);
  event(o, `Payment reminder #${o.reminders_sent} sent${manual ? ' (sent now by owner)' : ''} in ${o.chat_type === 'group' ? `group "${o.chat_name || o.chat_jid}"` : 'private chat'} · next: ${o.next_reminder_date ? fmtDate(o.next_reminder_date) : '—'}`, manual ? 'owner' : 'bot');
  save(o);
  return getOrder(id);
}
export function markReminderFailed(id, error) {
  const o = getOrder(id);
  o.last_error = String(error).slice(0, 300);
  // try again tomorrow rather than every few minutes
  o.next_reminder_date = addDays(todayIST(), 1);
  event(o, `Reminder could not be sent: ${o.last_error} — will retry tomorrow`, 'bot');
  save(o);
  return getOrder(id);
}

/* ---------------- reminder text ---------------- */
export function dueStatus(o, today = todayIST()) {
  const d = daysBetween(today, o.due_date);
  if (d > 1) return `Payment due on *${fmtDate(o.due_date)}* (in ${d} days)`;
  if (d === 1) return `Payment due *tomorrow* (${fmtDate(o.due_date)})`;
  if (d === 0) return `Payment due *today* (${fmtDate(o.due_date)})`;
  return `Payment was due on *${fmtDate(o.due_date)}* — *${-d} day${d === -1 ? '' : 's'} overdue*`;
}

export function reminderVars(o, settings = getSettings(), today = todayIST()) {
  const mentionNo = o.chat_type === 'group' && o.customer_jid ? o.customer_jid.split('@')[0].split(':')[0] : '';
  return {
    customer_name: o.customer_name || 'Sir/Madam',
    mention: mentionNo ? `@${mentionNo}` : '',
    item: o.quantity ? `${o.product} · ${o.quantity}` : o.product,
    product: o.product,
    quantity: o.quantity || '',
    rate: o.rate || '',
    amount: fmtAmount(o.amount),
    order_date: fmtDate(o.order_date),
    due_date: fmtDate(o.due_date),
    due_status: dueStatus(o, today),
    credit_days: String(o.credit_days),
    invoice_no: o.invoice_no || '',
    reminder_no: String((o.reminders_sent || 0) + 1),
    business_name: settings.business_name || '',
    contact_phone: settings.contact_phone || '',
  };
}
