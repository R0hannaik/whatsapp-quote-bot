// Running behind HTTPS on a web server (Caddy/Nginx in front, TRUST_PROXY=1).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers.js';

setupEnv({ TRUST_PROXY: '1' });
const { app } = await import('../src/server.js');

let server, base;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

const login = (password, headers = {}) => fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://quotes.example.in', 'X-Forwarded-Host': 'quotes.example.in', 'X-Forwarded-Proto': 'https', ...headers },
  body: JSON.stringify({ password }),
});

describe('behind an HTTPS proxy', () => {
  test('session cookie is marked Secure and HSTS is sent', async () => {
    const r = await login('test-password-123', { 'X-Forwarded-For': '203.0.113.5' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /; Secure/);
    assert.match(r.headers.get('strict-transport-security') || '', /max-age=/);
  });
  test("a visitor can't dodge the login lockout by faking X-Forwarded-For", async () => {
    // The attacker sends a different fake IP each time; the proxy appends the real one (198.51.100.7) last.
    const codes = [];
    for (let i = 0; i < 9; i++) codes.push((await login('wrong', { 'X-Forwarded-For': `10.0.0.${i}, 198.51.100.7` })).status);
    assert.equal(codes.at(-1), 429, `codes: ${codes}`);
  });
  test('a different real visitor is not locked out', async () => {
    assert.equal((await login('test-password-123', { 'X-Forwarded-For': '203.0.113.9' })).status, 200);
  });
});
