// The dashboard server over real HTTP: login, every endpoint, validation and the security protections.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers.js';

setupEnv({ CONTACT_PHONE: '+91 90000 00000' });
const { app } = await import('../src/server.js');
const db = await import('../src/db.js');

let server, base, cookie = '';
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** fetch as the browser would: same-origin headers + session cookie */
async function call(method, url, body, { auth = true, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Origin: base, 'Sec-Fetch-Site': 'same-origin', ...(auth && cookie ? { Cookie: cookie } : {}), ...headers },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
}
async function login(password = 'test-password-123') {
  const r = await call('POST', '/api/login', { password }, { auth: false });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return r;
}

describe('login protection', () => {
  test('every dashboard API needs login', async () => {
    for (const u of ['/api/status', '/api/chemicals', '/api/groups', '/api/inquiries', '/api/inquiries.csv', '/api/settings', '/api/activity', '/api/join', '/api/templates']) {
      assert.equal((await call('GET', u, undefined, { auth: false })).status, 401, u);
    }
  });
  test('pages redirect to the login page', async () => {
    const r = await call('GET', '/', undefined, { auth: false });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/login');
  });
  test('wrong password rejected, right one gives an HttpOnly session cookie', async () => {
    assert.equal((await login('nope')).status, 401);
    const r = await login();
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /HttpOnly; Path=\/; SameSite=Lax/);
    assert.equal((await call('GET', '/api/status')).status, 200);
  });
  test('forged or tampered cookies are rejected', async () => {
    const payload = Buffer.from(JSON.stringify({ exp: 9999999999999, v: 1 })).toString('base64url');
    for (const c of ['qb_session=abc.def', 'qb_session=%E0%A4%A', `qb_session=${payload}.AAAA`, `qb_session=${payload}.ünïcode`]) {
      assert.equal((await call('GET', '/api/status', undefined, { auth: false, headers: { Cookie: c } })).status, 401, c);
    }
  });
});

describe('security headers & cross-site protection', () => {
  test('headers', async () => {
    const r = await call('GET', '/api/status');
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-powered-by'), null);
  });
  test('requests from another website are blocked even with a valid cookie', async () => {
    assert.equal((await call('POST', '/api/groups/all-off', {}, { headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await call('PUT', '/api/settings', { business_name: 'x' }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  });
  test('non-JSON form posts are refused', async () => {
    assert.equal((await call('POST', '/api/groups/all-off', 'a=1', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  });
  test('no file access outside the public folder', async () => {
    const res = await fetch(`${base}/assets/..%2f..%2fsrc%2fdb.js`, { headers: { Cookie: cookie } });
    assert.notEqual(res.status, 200);
  });
  test('oversized bodies are rejected', async () => {
    assert.equal((await call('PUT', '/api/templates/quote', { body: 'a'.repeat(300000) })).status, 413);
  });
});

describe('chemicals API', () => {
  let id;
  test('create, edit, delete', async () => {
    const c = await call('POST', '/api/chemicals', { name: 'Toluene', aliases: 'tol, toluene', price: '88', origin_rates: [] });
    assert.equal(c.status, 200);
    id = c.body.id;
    const u = await call('PUT', `/api/chemicals/${id}`, { ...c.body, price: '90', aliases: 'tol' });
    assert.equal(u.body.price, 90);
    assert.equal((await call('DELETE', `/api/chemicals/${id}`)).status, 200);
    assert.ok(!(await call('GET', '/api/chemicals')).body.some(x => x.id === id));
  });
  test('name is required; unknown id rejected', async () => {
    assert.equal((await call('POST', '/api/chemicals', { name: '  ' })).status, 400);
    assert.equal((await call('PUT', '/api/chemicals/99999', { name: 'x' })).status, 400);
  });
});

describe('groups API', () => {
  test('adding a custom group needs a linked WhatsApp number', async () => {
    const r = await call('POST', '/api/groups', { name: 'X', jid: '120363000000000001@g.us' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Link a WhatsApp number first/);
  });
  test('with a linked number: add by group ID or phone, toggle, remove', async () => {
    db.setCurrentAccount('919000000009@s.whatsapp.net');
    assert.equal((await call('POST', '/api/groups', { name: 'Vapi', jid: '120363000000000001@g.us' })).body.jid, '120363000000000001@g.us');
    assert.equal((await call('POST', '/api/groups', { name: 'Direct', jid: '+91 98200 11111' })).body.jid, '919820011111@s.whatsapp.net');
    assert.equal((await call('POST', '/api/groups', { name: 'Bad', jid: 'hello' })).status, 400);
    const t = await call('PATCH', `/api/groups/${encodeURIComponent('120363000000000001@g.us')}`, { auto_reply: true });
    assert.equal(t.body.auto_reply, true);
    assert.equal((await call('GET', '/api/status')).body.counts.autoReplyOn, 1);
    await call('POST', '/api/groups/all-off', {});
    assert.equal((await call('GET', '/api/status')).body.counts.autoReplyOn, 0);
    assert.equal((await call('DELETE', `/api/groups/${encodeURIComponent('919820011111@s.whatsapp.net')}`)).status, 200);
  });
});

describe('templates & preview API', () => {
  test('save, validate and reset', async () => {
    assert.equal((await call('PUT', '/api/templates/quote', { body: '*{product_name}* {rate_details}' })).status, 200);
    assert.equal((await call('GET', '/api/templates')).body.templates.quote, '*{product_name}* {rate_details}');
    assert.equal((await call('PUT', '/api/templates/quote', { body: '  ' })).status, 400);
    assert.equal((await call('PUT', '/api/templates/nope', { body: 'x' })).status, 400);
    assert.match((await call('PUT', '/api/templates/multi', { body: 'no list here' })).body.error, /\{items\}/);
    assert.equal((await call('POST', '/api/templates/quote/reset', {})).status, 200);
    assert.notEqual((await call('GET', '/api/templates')).body.templates.quote, '*{product_name}* {rate_details}');
  });
  test('preview shows what the bot would reply, without sending', async () => {
    const r = await call('POST', '/api/simulate', { message: 'Need PA 2 MT, MA 5 MT, DOP 1 tanker' });
    assert.equal(r.body.replies.length, 1);
    assert.equal(r.body.replies[0].kind, 'multi');
    assert.deepEqual(r.body.unavailable.map(u => u.name), ['DOP']);
    const o = await call('POST', '/api/simulate', { message: 'PA 2 MT rate', overrides: { quote: 'HELLO {product_name}' }, forceMode: 'quote' });
    assert.equal(o.body.replies[0].text, 'HELLO Phthalic Anhydride (PA)');
  });
});

describe('orders API', () => {
  let id;
  before(() => {
    id = db.createInquiry({ group_jid: 'g', group_name: 'G', sender_name: '=cmd|calc', message: '=HYPERLINK("http://evil","x")', chemical_name: 'Phthalic Anhydride', status: 'Quoted', intent: 'quote' });
  });
  test('owner sets the decision', async () => {
    const r = await call('PATCH', `/api/inquiries/${id}`, { status: 'Confirmed', final_rate: '₹106' });
    assert.equal(r.body.status, 'Confirmed');
    assert.equal((await call('PATCH', `/api/inquiries/${id}`, { status: 'Made up' })).status, 400);
  });
  test('reply in group fails clearly when WhatsApp is not connected', async () => {
    const r = await call('POST', `/api/inquiries/${id}/message`, { text: 'hi' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not connected/);
  });
  test('CSV export neutralises spreadsheet formulas', async () => {
    const r = await call('GET', '/api/inquiries.csv?status=all');
    assert.match(r.body, /"'=HYPERLINK/);
    assert.match(r.body, /"'=cmd\|calc"/);
  });
});

describe('settings API', () => {
  test('values are validated', async () => {
    assert.equal((await call('PUT', '/api/settings', { cooldown_minutes: 'abc' })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { multi_reply_style: 'weird' })).status, 400);
    assert.equal((await call('PUT', '/api/settings', { cooldown_minutes: 5, multi_reply_style: 'separate' })).body.settings.cooldown_minutes, 5);
  });
  test('the phone number set in .env cannot be changed from the dashboard', async () => {
    const r = await call('PUT', '/api/settings', { contact_phone: '+91 11111 11111' });
    assert.equal(r.body.settings.contact_phone, '+91 90000 00000');
    assert.deepEqual((await call('GET', '/api/settings')).body.envLocked, ['contact_phone']);
  });
});

describe('public join-QR page', () => {
  test('needs the secret link; does not reveal group IDs', async () => {
    assert.equal((await call('GET', '/join/wrong-token', undefined, { auth: false })).status, 404);
    const { token } = (await call('GET', '/api/join')).body;
    assert.equal((await call('GET', `/join/${token}`, undefined, { auth: false })).status, 200);
    const pub = await call('GET', `/api/public/join/${token}`, undefined, { auth: false });
    assert.equal(pub.status, 200);
    assert.ok(!JSON.stringify(pub.body).includes('@g.us'));
  });
  test('"New link" retires the old one', async () => {
    const { token: oldToken } = (await call('GET', '/api/join')).body;
    await call('POST', '/api/join/token', {});
    assert.equal((await call('GET', `/join/${oldToken}`, undefined, { auth: false })).status, 404);
  });
});

describe('password & sessions (runs last: ends with a lockout)', () => {
  test('change password: wrong current / too short refused; success logs everyone out', async () => {
    assert.equal((await call('POST', '/api/settings/password', { current: 'bad', next: 'new-password-456' })).status, 400);
    assert.equal((await call('POST', '/api/settings/password', { current: 'test-password-123', next: 'short' })).status, 400);
    assert.equal((await call('POST', '/api/settings/password', { current: 'test-password-123', next: 'new-password-456' })).status, 200);
    assert.equal((await call('GET', '/api/status')).status, 401, 'old session ended');
    assert.equal((await login('new-password-456')).status, 200);
  });
  test('"Log out all devices" ends existing sessions', async () => {
    assert.equal((await call('POST', '/api/settings/logout-all', {})).status, 200);
    assert.equal((await call('GET', '/api/status')).status, 401);
  });
  test('brute force: locked out after 8 wrong passwords', async () => {
    const codes = [];
    for (let i = 0; i < 9; i++) codes.push((await login('wrong-' + i)).status);
    assert.deepEqual(codes.slice(0, 7), Array(7).fill(401));
    assert.equal(codes.at(-1), 429);
    assert.equal((await login('new-password-456')).status, 429, 'even the right password waits');
  });
});
