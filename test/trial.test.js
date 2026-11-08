// Trial mode (npm run trial): the client links their OWN WhatsApp to try the real bot.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers.js';

const dir = setupEnv({ TRIAL_MODE: '1' });
delete process.env.DASHBOARD_PASSWORD;                     // npm run trial never uses your real password
const { app } = await import('../src/server.js');
const db = await import('../src/db.js');
const { wa } = await import('../src/whatsapp.js');

let server, base, cookie = '';
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
async function call(method, url, body) {
  const res = await fetch(base + url, { method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'Sec-Fetch-Site': 'same-origin', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, headers: res.headers, body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text() };
}

describe('trial mode', () => {
  test('a password is generated, saved owner-only in the trial folder, and works', async () => {
    const file = path.join(dir, 'trial-password.txt');
    const pw = fs.readFileSync(file, 'utf8').trim();
    assert.match(pw, /^trial-.{8}$/);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    const r = await call('POST', '/api/login', { password: pw });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie').split(';')[0];
  });

  test('starts with sample chemicals, no groups, and Test mode ON', async () => {
    const s = (await call('GET', '/api/status')).body;
    assert.equal(s.demo, false);
    assert.deepEqual(s.trial, { testMode: true, quotes: 0 });
    assert.ok(s.counts.chemicals >= 5);
    assert.equal(s.counts.autoReplyOn, 0, 'nothing is switched on');
    assert.equal(db.getSettings().reply_to_own_messages, true);
  });

  test('Test mode is only switched on at the first start — turning it off sticks', async () => {
    assert.equal(db.getSetting('trial_initialized'), true);
    assert.equal((await call('PUT', '/api/settings', { reply_to_own_messages: false })).status, 200);
    assert.equal((await call('GET', '/api/status')).body.trial.testMode, false);
  });

  test('the client can unlink and change the password (unlike the demo)', async () => {
    const r = await call('POST', '/api/wa/logout', {});
    assert.notEqual(r.status, 400, JSON.stringify(r.body));
    assert.equal(wa.sock ?? null, null);
    const c = await call('POST', '/api/settings/password', { current: fs.readFileSync(path.join(dir, 'trial-password.txt'), 'utf8').trim(), next: 'client-own-pass-1' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const r2 = await call('POST', '/api/login', { password: 'client-own-pass-1' });
    assert.equal(r2.status, 200);
    cookie = r2.headers.get('set-cookie').split(';')[0];
  });

  test('demo endpoints are not available', async () => {
    assert.equal((await call('POST', '/api/demo/reset', {})).status, 404);
  });
});
