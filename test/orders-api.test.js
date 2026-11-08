// Orders & payments through the dashboard server: record from an enquiry, edit, Paid/Pending, validation, preview.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers.js';

setupEnv({ CONTACT_PHONE: '+91 90000 00000' });
const { app } = await import('../src/server.js');
const db = await import('../src/db.js');

let server, base, cookie;
before(async () => {
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'test-password-123' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  db.setCurrentAccount('919000000009@s.whatsapp.net');
  db.upsertLiveGroup({ jid: '120363000000000001@g.us', name: 'Traders', members: 5 });
});
after(() => server.close());
const call = async (method, url, body, auth = true) => {
  const r = await fetch(base + url, { method, headers: { ...(auth ? { Cookie: cookie } : {}), Origin: base, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

describe('orders API', () => {
  let inqId, orderId;
  test('login required', async () => {
    assert.equal((await call('GET', '/api/orders', null, false)).status, 401);
    assert.equal((await call('POST', '/api/orders', { product: 'x', amount: 1 }, false)).status, 401);
  });
  test('record an order from an enquiry: buyer, chat and message are filled in', async () => {
    inqId = db.createInquiry({ group_jid: '120363000000000001@g.us', group_name: 'Traders', sender_jid: '919820000001@s.whatsapp.net', sender_name: 'Rakesh',
      sender_phone: '+919820000001', message: 'PA 2 MT confirm', msg_key: { id: 'M1', remoteJid: '120363000000000001@g.us', participant: '919820000001@s.whatsapp.net' },
      chemical_name: 'Phthalic Anhydride', quantity: '2 MT', status: 'Awaiting Owner', intent: 'order' });
    const r = await call('POST', '/api/orders', { inquiry_id: inqId, amount: '2,56,000', invoice_no: 'PC/1', chat_type: 'group' });
    assert.equal(r.status, 200, r.body.error);
    orderId = r.body.id;
    assert.equal(r.body.customer_name, 'Rakesh');
    assert.equal(r.body.chat_jid, '120363000000000001@g.us');
    assert.equal(r.body.product, 'Phthalic Anhydride');
    assert.equal(r.body.amount, 256000);
    assert.equal(r.body.msg_key.id, 'M1');
    assert.equal(r.body.order_message, 'PA 2 MT confirm');
    assert.equal(db.getInquiry(inqId).status, 'Confirmed');
  });
  test('private-chat reminders use the buyer number', async () => {
    const r = await call('POST', '/api/orders', { product: 'IPA', amount: 1000, customer_phone: '98200 00002', chat_type: 'private' });
    assert.equal(r.body.chat_jid, '919820000002@s.whatsapp.net');
    assert.equal(r.body.chat_type, 'private');
    assert.equal((await call('POST', '/api/orders', { product: 'IPA', amount: 1000, chat_type: 'private' })).status, 400, 'needs a number');
  });
  test('validation', async () => {
    assert.match((await call('POST', '/api/orders', { product: 'X', amount: 0, chat_jid: '120363000000000001@g.us' })).body.error, /amount/);
    assert.match((await call('POST', '/api/orders', { amount: 10, chat_jid: '120363000000000001@g.us' })).body.error, /product/);
    assert.match((await call('POST', '/api/orders', { product: 'X', amount: 10 })).body.error, /where reminders/);
    assert.equal((await call('POST', '/api/orders', { inquiry_id: 99999, amount: 10 })).status, 400);
  });
  test('edit recalculates the due date; history records it', async () => {
    const r = await call('PATCH', `/api/orders/${orderId}`, { credit_days: 45 });
    assert.equal(r.body.credit_days, 45);
    assert.equal(r.body.due_date > r.body.order_date, true);
    assert.match(r.body.history.at(-1).text, /credit days/);
  });
  test('Paid stops reminders, Pending resumes; only these two statuses', async () => {
    assert.equal((await call('POST', `/api/orders/${orderId}/status`, { status: 'Paid' })).body.next_reminder_date, null);
    assert.ok((await call('POST', `/api/orders/${orderId}/status`, { status: 'Pending' })).body.next_reminder_date);
    assert.equal((await call('POST', `/api/orders/${orderId}/status`, { status: 'Cancelled' })).status, 400);
  });
  test('lists, filters and totals', async () => {
    const r = await call('GET', '/api/orders?status=Pending');
    assert.equal(r.body.items.length, 2);
    assert.equal(r.body.stats.pending.amt, 257000);
    assert.equal((await call('GET', '/api/orders?status=Pending&q=Rakesh')).body.items.length, 1);
    assert.ok((await call('GET', '/api/status')).body.payments.pending.n >= 2);
  });
  test('reminder preview and the template editor preview', async () => {
    assert.match((await call('GET', `/api/orders/${orderId}/preview`)).body.text, /Rakesh[\s\S]*₹2,56,000[\s\S]*Invoice:\* PC\/1/);
    assert.match((await call('POST', '/api/reminder-preview', { body: 'Pay {amount} — {due_status}' })).body.text, /^Pay ₹2,56,000 — Payment due on/);
    assert.equal((await call('PUT', '/api/templates/reminder', { body: 'Hi {customer_name}, {amount} pending' })).status, 200);
  });
  test('"Send reminder now" fails clearly when WhatsApp is not connected', async () => {
    const r = await call('POST', `/api/orders/${orderId}/remind`);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not connected/);
  });
  test('reminder settings are validated', async () => {
    assert.equal((await call('PUT', '/api/settings', { reminder_hour_ist: 30 })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { reminder_repeat_days: 0 })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { default_credit_days: 45, reminder_repeat_days: 3 })).body.settings.default_credit_days, 45);
  });
  test('delete', async () => {
    assert.equal((await call('DELETE', `/api/orders/${orderId}`)).status, 200);
    assert.ok(!(await call('GET', '/api/orders?status=all')).body.items.some(o => o.id === orderId));
  });
});
