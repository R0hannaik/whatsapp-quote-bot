// Orders & payment reminders: schedule (day 28, then every other day until Paid), sending in the right chat,
// and handing order/follow-up replies to the owner.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, fakeSocket, waMessage } from './helpers.js';

setupEnv({ CONTACT_PHONE: '+91 90000 00000' });
const db = await import('../src/db.js');
const ord = await import('../src/orders.js');
const wam = await import('../src/whatsapp.js');
const { wa, handleMessage, runPaymentReminders, sendPaymentReminder, reminderText, activity } = wam;
db.ensureSecrets(); db.seedIfEmpty();
db.setSetting('reply_delay_min_sec', 0); db.setSetting('reply_delay_max_sec', 0);

const ME = '919000000009@s.whatsapp.net';
const G = '120363000000000001@g.us';
const BUYER = '919820000001@s.whatsapp.net';
let sock;
function link() { sock = fakeSocket(); wa.sock = sock; wa.status = 'open'; wa.me = { id: ME }; db.setCurrentAccount(ME); }
link();
db.upsertLiveGroup({ jid: G, name: 'Traders', members: 10 });
db.patchGroup(G, { auto_reply: true });

const today = ord.todayIST();
const NOON = Date.parse(`${today}T06:30:00Z`);          // 12:00 India time (after the 11 AM reminder hour)
const EARLY = Date.parse(`${today}T02:30:00Z`);         // 08:00 India time
const daysAgo = n => ord.addDays(today, -n);
const newOrder = (extra = {}) => ord.createOrder({ chat_jid: G, chat_name: 'Traders', customer_name: 'Rakesh', customer_jid: BUYER,
  customer_phone: '+919820000001', product: 'Phthalic Anhydride', quantity: '2 MT', amount: 256000, order_date: daysAgo(28),
  msg_key: { id: 'ORDERMSG', remoteJid: G, participant: BUYER, fromMe: false }, order_message: 'PA 2 MT confirm', ...extra });
const set = (id, cols) => db.db.prepare(`UPDATE orders SET ${Object.keys(cols).map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...cols, id });
const clearAll = () => db.db.prepare('DELETE FROM orders').run();

describe('reminder schedule', () => {
  test('30-day credit → first reminder on day 28, due on day 30', () => {
    const o = { order_date: '2026-11-01', credit_days: 30, payment_status: 'Pending', reminders_enabled: true };
    assert.equal(ord.firstReminderDate(o), '2026-11-29');
    assert.equal(ord.addDays(o.order_date, o.credit_days), '2026-12-01');
  });
  test('then every other day until paid', () => {
    const o = { order_date: '2026-11-01', credit_days: 30, payment_status: 'Pending', reminders_enabled: true };
    assert.equal(ord.nextReminderDate({ ...o, last_reminder_date: '2026-11-29' }), '2026-12-01');
    assert.equal(ord.nextReminderDate({ ...o, last_reminder_date: '2026-12-01' }), '2026-12-03');
    assert.equal(ord.nextReminderDate({ ...o, payment_status: 'Paid' }), null);
    assert.equal(ord.nextReminderDate({ ...o, reminders_enabled: false }), null);
  });
  test('an order recorded late gets its first reminder today', () => {
    assert.equal(ord.nextReminderDate({ order_date: '2026-01-01', credit_days: 30, payment_status: 'Pending', reminders_enabled: true }, '2026-03-10'), '2026-03-10');
  });
  test('due-date wording', () => {
    assert.match(ord.dueStatus({ due_date: '2026-12-01' }, '2026-11-29'), /due on \*01 Dec 2026\* \(in 2 days\)/);
    assert.match(ord.dueStatus({ due_date: '2026-12-01' }, '2026-12-01'), /due \*today\*/);
    assert.match(ord.dueStatus({ due_date: '2026-12-01' }, '2026-12-03'), /\*2 days overdue\*/);
  });
  test('validation', () => {
    assert.throws(() => newOrder({ amount: 0 }), /amount/);
    assert.throws(() => newOrder({ product: '' }), /product/);
    assert.throws(() => newOrder({ credit_days: 0 }), /Credit days/);
    assert.throws(() => newOrder({ order_date: ord.addDays(today, 10) }), /future/);
    assert.throws(() => newOrder({ chat_jid: 'nowhere' }), /where reminders/);
  });
});

describe('sending reminders', () => {
  beforeEach(() => { clearAll(); link(); db.setSetting('payment_reminders_enabled', true); });

  test('day 28: one reminder in the group, replying to the order message and tagging the buyer', async () => {
    const o = newOrder();
    const r = await runPaymentReminders({ now: NOON });
    assert.equal(r.sent, 1);
    assert.equal(sock.sent[0].jid, G);
    assert.equal(sock.sent[0].quoted, true);
    assert.match(sock.sent[0].text, /^@919820000001/);
    assert.match(sock.sent[0].text, /Payment Reminder/);
    assert.match(sock.sent[0].text, /₹2,56,000/);
    assert.match(sock.sent[0].text, /in 2 days/);
    const after = ord.getOrder(o.id);
    assert.equal(after.reminders_sent, 1);
    assert.equal(after.next_reminder_date, ord.addDays(today, 2), 'next one in 2 days');
    assert.match(after.history.at(-1).text, /reminder #1 sent/);
  });
  test('the mention is attached so WhatsApp notifies the buyer', async () => {
    const calls = [];
    sock.sendMessage = async (jid, content, opts) => { calls.push(content); return { key: { id: 'X' } }; };
    newOrder();
    await runPaymentReminders({ now: NOON });
    assert.deepEqual(calls[0].mentions, [BUYER]);
  });
  test('not before day 28', async () => {
    newOrder({ order_date: daysAgo(27) });
    assert.equal((await runPaymentReminders({ now: NOON })).sent, 0);
  });
  test('only once per day, and not before the reminder hour', async () => {
    newOrder();
    assert.equal((await runPaymentReminders({ now: EARLY })).sent, 0, 'too early');
    assert.equal((await runPaymentReminders({ now: NOON })).sent, 1);
    assert.equal((await runPaymentReminders({ now: NOON })).sent, 0, 'already sent today');
  });
  test('every other day until marked Paid', async () => {
    const o = newOrder({ order_date: daysAgo(34) });
    set(o.id, { reminders_sent: 3, last_reminder_date: daysAgo(2), next_reminder_date: today });     // sent on days 28, 30, 32
    assert.equal((await runPaymentReminders({ now: NOON })).sent, 1, 'day 34');
    assert.match(sock.sent[0].text, /4 days overdue/);
    ord.setPaymentStatus(o.id, 'Paid');
    set(o.id, { next_reminder_date: today, last_reminder_date: daysAgo(2) });
    assert.equal((await runPaymentReminders({ now: NOON })).sent, 0, 'paid → no reminders');
    assert.equal(ord.getOrder(o.id).payment_status, 'Paid');
  });
  test('Paid → Pending again resumes reminders', () => {
    const o = newOrder();
    ord.setPaymentStatus(o.id, 'Paid');
    assert.equal(ord.getOrder(o.id).next_reminder_date, null);
    assert.ok(ord.setPaymentStatus(o.id, 'Pending').next_reminder_date);
  });
  test('private chat: sent to the buyer directly, no tag, no quote of a group message', async () => {
    newOrder({ chat_jid: BUYER, chat_type: 'private', chat_name: 'Private chat' });
    await runPaymentReminders({ now: NOON });
    assert.equal(sock.sent[0].jid, BUYER);
    assert.equal(sock.sent[0].quoted, false);
    assert.doesNotMatch(sock.sent[0].text, /^@/);
  });
  test('paused reminders / switched off in Settings → nothing sent', async () => {
    newOrder({ reminders_enabled: false });
    assert.equal((await runPaymentReminders({ now: NOON })).sent, 0);
    clearAll(); newOrder();
    db.setSetting('payment_reminders_enabled', false);
    assert.equal((await runPaymentReminders({ now: NOON })).sent, 0);
  });
  test('WhatsApp disconnected → nothing sent; sent later the same day when it reconnects', async () => {
    newOrder();
    wa.status = 'connecting';
    assert.equal((await runPaymentReminders({ now: NOON })).sent, 0);
    wa.status = 'open';
    assert.equal((await runPaymentReminders({ now: NOON })).sent, 1);
  });
  test('a failed send is recorded and retried tomorrow (not every 10 minutes)', async () => {
    const o = newOrder();
    sock.sendMessage = async () => { throw new Error('not a participant'); };
    assert.equal((await runPaymentReminders({ now: NOON })).sent, 0);
    const after = ord.getOrder(o.id);
    assert.match(after.last_error, /not a participant/);
    assert.equal(after.next_reminder_date, ord.addDays(today, 1));
    assert.equal(after.reminders_sent, 0);
  });
  test('"Send reminder now" works any day and counts as a reminder', async () => {
    const o = newOrder({ order_date: daysAgo(3) });
    const r = await sendPaymentReminder(o.id, { manual: true });
    assert.equal(r.reminders_sent, 1);
    assert.match(r.history.at(-1).text, /sent now by owner/);
  });
  test('reminder text: invoice line hidden when empty; preview uses the saved template', () => {
    const o = newOrder();
    assert.doesNotMatch(reminderText(o), /Invoice/);
    assert.match(reminderText({ ...o, invoice_no: 'PC/1' }), /Invoice:\* PC\/1/);
    db.saveTemplate('reminder', 'Pay {amount} by {due_date}');
    assert.equal(reminderText(o), `Pay ₹2,56,000 by ${ord.fmtDate(o.due_date)}`);
    db.resetTemplate('reminder');
  });
});

describe('payments overview', () => {
  test('outstanding, overdue, due this week, paid this month', () => {
    clearAll();
    newOrder({ amount: 100000, order_date: daysAgo(40) });            // overdue
    newOrder({ amount: 50000, order_date: daysAgo(25) });             // due in 5 days
    const p = newOrder({ amount: 70000, order_date: daysAgo(5) });
    ord.setPaymentStatus(p.id, 'Paid');
    const s = ord.paymentStats();
    assert.equal(s.pending.amt, 150000);
    assert.equal(s.overdue.n, 1);
    assert.equal(s.dueSoon.n, 1);
    assert.equal(s.paidThisMonth.amt, 70000);
    assert.equal(ord.listOrders({ status: 'Overdue' }).length, 1);
    assert.equal(ord.listOrders({ status: 'Paid' }).length, 1);
  });
  test('recording an order from an enquiry confirms the enquiry', () => {
    const inq = db.createInquiry({ group_jid: G, group_name: 'Traders', sender_jid: BUYER, sender_name: 'Rakesh', message: 'PA 2 MT rate', chemical_name: 'Phthalic Anhydride', status: 'Awaiting Owner', intent: 'order' });
    const o = ord.createOrder({ inquiry_id: inq, chat_jid: G, product: 'Phthalic Anhydride', amount: 1000 });
    assert.equal(db.getInquiry(inq).status, 'Confirmed');
    assert.match(db.getInquiry(inq).history.at(-1).text, new RegExp(`Order #${o.id} recorded`));
  });
});

describe('steps 3–4: buyer replies to a quote → handed to the owner', () => {
  beforeEach(() => { link(); db.setSetting('cooldown_minutes', 0); });

  test('"confirm" as a reply to the bot\'s quote → no auto-reply, flagged as an order', async () => {
    const buyer = '919820000077@s.whatsapp.net';
    await handleMessage(waMessage('PA 2 MT rate chahiye', { from: buyer, id: 'Q1' }));
    assert.equal(sock.sent.length, 1, 'quote sent');
    await handleMessage(waMessage('ok confirm karo, dispatch kal', { from: buyer, replyTo: { id: 'BOT1', participant: ME } }));
    assert.equal(sock.sent.length, 1, 'bot stays quiet');
    const inq = db.listInquiries({ status: 'all' }).find(i => i.sender_jid === buyer);
    assert.equal(inq.status, 'Awaiting Owner');
    assert.equal(inq.intent, 'order');
    assert.match(inq.history.at(-1).text, /Wants to place an order: "ok confirm karo/);
    assert.equal(inq.message, 'ok confirm karo, dispatch kal', 'the order message is what reminders will reply to');
    assert.equal(activity[0].result, 'flagged');
  });
  test('a question soon after a quote is flagged as a follow-up', async () => {
    const buyer = '919820000078@s.whatsapp.net';
    await handleMessage(waMessage('MA 5 MT rate', { from: buyer }));
    await handleMessage(waMessage('payment terms kya hai?', { from: buyer }));
    const inq = db.listInquiries({ status: 'all' }).find(i => i.sender_jid === buyer);
    assert.equal(inq.status, 'Awaiting Owner');
    assert.match(inq.history.at(-1).text, /Follow-up: "payment terms/);
  });
  test('"confirm" from someone who got no quote is not treated as an order', async () => {
    const before = sock.sent.length;
    await handleMessage(waMessage('meeting confirm?', { from: '919820000079@s.whatsapp.net' }));
    assert.equal(sock.sent.length, before);
    assert.ok(!db.listInquiries({ status: 'all' }).some(i => i.sender_jid === '919820000079@s.whatsapp.net'));
  });
  test('a new product request from the same buyer is still auto-quoted', async () => {
    const buyer = '919820000080@s.whatsapp.net';
    await handleMessage(waMessage('PA 2 MT rate', { from: buyer }));
    const n = sock.sent.length;
    await handleMessage(waMessage('IPA 20 drums rate bhi', { from: buyer }));
    assert.equal(sock.sent.length, n + 1);
  });
});
