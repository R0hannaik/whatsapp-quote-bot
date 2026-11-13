// Switching WhatsApp numbers on one server: enquiries and orders remember which number they came in on,
// replies and payment reminders only ever go out from that number, and the dashboard can filter by number.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, fakeSocket, waMessage } from './helpers.js';

setupEnv({ CONTACT_PHONE: '+91 90000 00000' });
const db = await import('../src/db.js');
const ord = await import('../src/orders.js');
const wam = await import('../src/whatsapp.js');
const { app } = await import('../src/server.js');
const { wa, handleMessage, runPaymentReminders, sendPaymentReminder, sendOwnerMessage } = wam;
db.setSetting('reply_delay_min_sec', 0); db.setSetting('reply_delay_max_sec', 0);
db.setSetting('reply_cooldown_minutes', 0);

const A = '919876500001@s.whatsapp.net';     // e.g. the sales number
const B = '919876500002@s.whatsapp.net';     // e.g. the accounts number
const GA = '120363000000000A01@g.us';
const GB = '120363000000000B01@g.us';
const BUYER = '919820000001@s.whatsapp.net';
const today = ord.todayIST();
const NOON = Date.parse(`${today}T06:30:00Z`);   // after the 11 AM reminder hour
let sock;
function link(account, name = '') {
  sock = fakeSocket(); wa.sock = sock; wa.status = 'open'; wa.me = { id: account, name };
  db.setCurrentAccount(account, name);
}
const groupFor = (jid, name) => { db.upsertLiveGroup({ jid, name, members: 5 }); db.patchGroup(jid, { auto_reply: true }); };
const orderIn = (chat, extra = {}) => ord.createOrder({ chat_jid: chat, chat_name: 'Traders', customer_name: 'Rakesh', customer_jid: BUYER,
  customer_phone: '+919820000001', product: 'Phthalic Anhydride', amount: 100000, order_date: ord.addDays(today, -28), ...extra });

describe('enquiries remember their number', () => {
  test('number formatting', () => {
    assert.equal(db.formatAccount(A), '+91 98765 00001');
    assert.equal(db.formatAccount('14155550100@s.whatsapp.net'), '+14155550100');
    assert.equal(db.formatAccount(''), '');
  });

  test('records saved before numbers were tracked go to the next number that links', () => {
    db.setCurrentAccount('');
    const old = db.createInquiry({ group_jid: GA, group_name: 'Old', sender_jid: BUYER, message: 'PA rate', status: 'Quoted', quote_text: 'x' });
    assert.equal(db.getInquiry(old).account, '');
    link(A, 'Sales');
    assert.equal(db.getInquiry(old).account, A);
  });

  test('a message on number A is saved as A; after switching to B, new ones are saved as B', async () => {
    groupFor(GA, 'Group on A');
    await handleMessage(waMessage('PA 2 MT rate chahiye', { group: GA, from: BUYER, id: 'QA1' }));
    const a = db.listInquiries({ status: 'all' }).find(i => i.group_jid === GA && i.message.includes('2 MT'));
    assert.equal(a.account, A);

    link(B, 'Accounts');
    groupFor(GB, 'Group on B');
    await handleMessage(waMessage('IPA 20 drums rate', { group: GB, from: BUYER, id: 'QB1' }));
    const b = db.listInquiries({ status: 'all' }).find(i => i.group_jid === GB);
    assert.equal(b.account, B);

    assert.ok(db.listInquiries({ status: 'all', account: A }).every(i => i.account === A));
    assert.ok(db.listInquiries({ status: 'all', account: B }).every(i => i.account === B));
    assert.equal(db.listInquiries({ status: 'all', account: 'all' }).length, db.listInquiries({ status: 'all' }).length);
  });

  test("a follow-up is never attached to the other number's enquiry", async () => {
    // B is linked and also happens to be in GA: "confirm" there must not flag A's enquiry
    const aEnq = db.listInquiries({ status: 'all', account: A }).find(i => i.group_jid === GA && i.message.includes('2 MT'));
    assert.ok(!db.findRecentInquiry(GA, BUYER), 'B sees no enquiry of its own there');
    link(A, 'Sales');
    assert.equal(db.findRecentInquiry(GA, BUYER)?.id, aEnq.id);
    link(B, 'Accounts');
  });

  test("the owner can't reply to A's enquiry while B is linked", async () => {
    const aEnq = db.listInquiries({ status: 'all', account: A })[0];
    await assert.rejects(sendOwnerMessage(aEnq, 'Confirmed 🙏'), /came in on WhatsApp number \+91 98765 00001/);
    assert.equal(sock.sent.length, 0);
  });

  test('the dashboard lists both numbers, with names', () => {
    const list = db.listAccounts();
    assert.deepEqual(list.map(a => [a.phone, a.name, a.current]), [['+91 98765 00002', 'Accounts', true], ['+91 98765 00001', 'Sales', false]]);
    assert.ok(list.find(a => a.id === A).enquiries >= 2);
  });
});

describe('payment reminders only go out from the right number', () => {
  let orderA, orderB;
  before(() => {
    db.db.prepare('DELETE FROM orders').run();
    link(A, 'Sales');
    const aEnq = db.listInquiries({ status: 'all', account: A }).find(i => i.group_jid === GA);
    link(B, 'Accounts');
    orderA = orderIn(GA, { inquiry_id: aEnq.id });     // recorded while B is linked, from A's enquiry
    orderB = orderIn(GB);
  });

  test("an order takes its enquiry's number, otherwise the number linked now", () => {
    assert.equal(orderA.account, A);
    assert.equal(orderB.account, B);
  });

  test('while B is linked: B\'s reminder goes out, A\'s waits (never sent from B)', async () => {
    const r = await runPaymentReminders({ now: NOON });
    assert.equal(r.sent, 1);
    assert.deepEqual(sock.sent.map(m => m.jid), [GB]);
    assert.equal(ord.getOrder(orderA.id).reminders_sent, 0);
    assert.equal(ord.getOrder(orderA.id).last_error, null, 'not counted as a failure');
    assert.match(ord.wrongNumber(ord.getOrder(orderA.id)), /\+91 98765 00001.*wait/);
    await assert.rejects(sendPaymentReminder(orderA.id, { manual: true }), /belongs to WhatsApp number \+91 98765 00001/);
    assert.equal(sock.sent.length, 1);
  });

  test("when A is linked again, A's waiting reminder goes out from A", async () => {
    link(A, 'Sales');
    const r = await runPaymentReminders({ now: NOON });
    assert.equal(r.sent, 1);
    assert.deepEqual(sock.sent.map(m => m.jid), [GA]);
    assert.equal(ord.getOrder(orderA.id).reminders_sent, 1);
    assert.equal(ord.getOrder(orderB.id).reminders_sent, 1, "B's order untouched");
  });

  test('orders filter by number', () => {
    assert.deepEqual(ord.listOrders({ status: 'all', account: B }).map(o => o.id), [orderB.id]);
    assert.equal(ord.listOrders({ status: 'all', account: 'all' }).length, 2);
  });
});

describe('API', () => {
  let server, base, cookie;
  before(async () => {
    server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ password: 'test-password-123' }) });
    cookie = r.headers.get('set-cookie').split(';')[0];
    link(B, 'Accounts');
  });
  after(() => server.close());
  const get = async url => { const r = await fetch(base + url, { headers: { Cookie: cookie } }); return (r.headers.get('content-type') || '').includes('json') ? r.json() : r.text(); };

  test('status lists the numbers', async () => {
    const s = await get('/api/status');
    assert.equal(s.accounts.length, 2);
    assert.equal(s.accounts.find(a => a.current).id, B);
  });
  test("orders show when they're waiting for their number", async () => {
    const { items } = await get('/api/orders?status=all');
    assert.match(items.find(o => o.account === A).waiting_for_number, /\+91 98765 00001/);
    assert.equal(items.find(o => o.account === B).waiting_for_number, null);
    assert.equal((await get(`/api/orders?status=all&account=${encodeURIComponent(A)}`)).items.length, 1);
  });
  test('enquiries filter by number', async () => {
    const { items } = await get(`/api/inquiries?status=all&account=${encodeURIComponent(B)}`);
    assert.ok(items.length >= 1 && items.every(i => i.account === B));
  });
  test('CSV export has the WhatsApp number column', async () => {
    const csv = await get('/api/inquiries.csv?status=all');
    assert.match(csv.split('\n')[0], /whatsapp_number/);
    assert.match(csv, /\+91 98765 00002/);
  });
});
