// Demo mode (npm run demo / Render): sample data, simulated WhatsApp, Demo Chat, its own password, risky actions off.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers.js';

const dir = setupEnv({ DEMO_MODE: '1', DEMO_PASSWORD: 'client-demo-2026' });
const { app } = await import('../src/server.js');
const db = await import('../src/db.js');
const demo = await import('../src/demo.js');
const { wa } = await import('../src/whatsapp.js');

let server, base, cookie = '';
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, url, body, { headers = {} } = {}) {
  const res = await fetch(base + url, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Origin: base, 'Sec-Fetch-Site': 'same-origin', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
}
const MUMBAI = demo.DEMO_GROUPS[0].jid;
const FAMILY = demo.DEMO_GROUPS.find(g => g.name === 'Family Group').jid;

describe('demo mode', () => {
  test('uses DEMO_PASSWORD, not the dashboard password', async () => {
    assert.equal((await call('POST', '/api/login', { password: 'test-password-123' })).status, 401);
    const r = await call('POST', '/api/login', { password: 'client-demo-2026' });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie').split(';')[0];
  });

  test('starts with a simulated, connected WhatsApp and sample data', async () => {
    const s = (await call('GET', '/api/status')).body;
    assert.equal(s.demo, true);
    assert.equal(wa.status, 'open');
    assert.equal(s.backupProblem, null, 'no scary backup warnings in the demo');
    const groups = (await call('GET', '/api/groups')).body;
    assert.ok((groups.groups || groups).length >= 5, 'demo groups');
    const inq = db.listInquiries({ status: 'all' });
    assert.ok(inq.length >= 5, 'sample enquiries');
    assert.ok(inq.some(i => i.status === 'Awaiting Owner'), 'an order waiting for the owner');
    assert.ok(inq.some(i => i.status === 'Unmatched'), 'an unmatched request');
    const orders = (await call('GET', '/api/orders?status=all')).body;
    const list = orders.items;
    assert.ok(list.some(o => o.payment_status === 'Pending') && list.some(o => o.payment_status === 'Paid'), 'pending and paid orders');
  });

  test('Demo Chat: a rate request gets a real quote from the bot, replying to the buyer', async () => {
    const r = await call('POST', '/api/demo/message', { jid: MUMBAI, name: 'Test Buyer', phone: '9820099999', text: 'PA 2 MT Bhiwandi rate chahiye' });
    assert.equal(r.status, 200);
    const [buyer, bot] = r.body.added;
    assert.equal(buyer.from, 'buyer');
    assert.equal(bot?.from, 'bot', 'bot replied');
    assert.match(bot.text, /Phthalic Anhydride/);
    assert.equal(bot.quotedId, buyer.id, 'reply quotes the buyer message');
    const chat = (await call('GET', `/api/demo/chat?jid=${encodeURIComponent(MUMBAI)}`)).body;
    assert.ok(chat.messages.some(m => m.id === bot.id));
    assert.ok(chat.groups.find(g => g.jid === MUMBAI).auto_reply);
  });

  test('Demo Chat: replying "confirm" to the quote hands it to the owner (bot stays quiet)', async () => {
    const chat = (await call('GET', `/api/demo/chat?jid=${encodeURIComponent(MUMBAI)}`)).body.messages;
    const quote = chat.filter(m => m.from === 'bot').at(-1);
    const r = await call('POST', '/api/demo/message', { jid: MUMBAI, name: 'Test Buyer', phone: '9820099999', text: 'ok confirm karo, PO bhejta hu', replyToId: quote.id });
    assert.equal(r.body.added.length, 1, 'no bot reply');
    assert.ok(db.listInquiries({ status: 'all' }).some(i => i.status === 'Awaiting Owner' && /Test Buyer/.test(i.sender_name)));
  });

  test('Demo Chat: several products → one combined quotation', async () => {
    const r = await call('POST', '/api/demo/message', { jid: MUMBAI, name: 'Multi Buyer', text: 'Need: 1. PA 2 MT 2. IPA 20 drums 3. DOP 1 tanker' });
    const bot = r.body.added.filter(m => m.from === 'bot');
    assert.equal(bot.length, 1);
    assert.match(bot[0].text, /Phthalic Anhydride[\s\S]*Isopropyl Alcohol/);
  });

  test('Demo Chat: a group with auto-reply OFF gets no reply', async () => {
    const r = await call('POST', '/api/demo/message', { jid: FAMILY, name: 'Uncle', text: 'PA 2 MT rate?' });
    assert.equal(r.body.added.length, 1);
  });

  test('Demo Chat validates input', async () => {
    assert.equal((await call('POST', '/api/demo/message', { jid: 'nope@g.us', text: 'hi' })).status, 400);
    assert.equal((await call('POST', '/api/demo/message', { jid: MUMBAI, text: '   ' })).status, 400);
  });

  test('things that would affect the next visitor are switched off', async () => {
    for (const url of ['/api/wa/logout', '/api/wa/restart', '/api/settings/password', '/api/settings/logout-all', '/api/join/token', '/api/backups/offsite']) {
      const r = await call('POST', url, {});
      assert.equal(r.status, 400, url);
      assert.match(r.body.error, /demo/i);
    }
    assert.equal(wa.status, 'open', 'still "linked"');
  });

  test('Reset demo data puts the sample data back', async () => {
    db.updateInquiry(db.listInquiries({ status: 'all' })[0].id, { status: 'Rejected' });
    const r = await call('POST', '/api/demo/reset', {});
    assert.equal(r.status, 200);
    assert.ok(!db.listInquiries({ status: 'all' }).some(i => /Test Buyer|Multi Buyer/.test(i.sender_name)), 'visitor messages gone');
    assert.equal((await call('GET', '/api/demo/chat')).body.messages.length, 0);
    assert.equal(wa.status, 'open');
  });

  test('demo endpoints need login', async () => {
    const saved = cookie; cookie = '';
    assert.equal((await call('POST', '/api/demo/reset', {})).status, 401);
    cookie = saved;
  });

  test('a generated demo password is kept in the demo folder and reused', () => {
    const saved = process.env.DEMO_PASSWORD; delete process.env.DEMO_PASSWORD;
    const d = fs.mkdtempSync(path.join(dir, 'pw-'));
    const a = demo.demoPassword(d, fs, path);
    assert.equal(a.generated, true);
    assert.match(a.password, /^demo-.{8}$/);
    assert.equal(demo.demoPassword(d, fs, path).password, a.password);
    assert.equal(fs.statSync(path.join(d, 'demo-password.txt')).mode & 0o077, 0, 'owner-only file');
    process.env.DEMO_PASSWORD = saved;
  });
});

/* ---------- the Demo Chat screen in a real browser (skipped without Chrome) ---------- */
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && fs.existsSync(p));
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch { /* dev dependency not installed */ }

describe('Demo Chat in a browser', { skip: !CHROME || !puppeteer ? 'Chrome or puppeteer-core not available' : false }, () => {
  let browser, page; const errors = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  before(async () => {
    browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.on('pageerror', e => errors.push(e.message));
  });
  after(async () => { await browser?.close(); });

  test('opens on Demo Chat; a sample message gets a bot reply', async () => {
    await page.goto(`${base}/login`);
    await page.type('#pw', 'client-demo-2026');
    await Promise.all([page.waitForNavigation(), page.click('#go')]);
    await wait(1200);
    assert.ok(await page.$eval('#view-demo', e => !e.classList.contains('hidden')), 'demo tab shown first');
    assert.match(await page.$eval('.alert-bar', e => e.innerText), /demo/i, 'demo banner');
    const before = (await page.$$('#dChat .bubble')).length;
    await page.click('[data-sample="0"]');
    await page.click('#dSend');
    await page.waitForFunction(() => document.querySelector('#dWhat').innerText.trim(), { timeout: 10000 });
    await wait(300);
    assert.match(await page.$eval('#dWhat', e => e.innerText), /replied/i);
    assert.ok((await page.$$('#dChat .bubble')).length >= before + 2, 'buyer message + bot reply in the chat');
    assert.match(await page.$eval('#dChat', e => e.innerText), /Phthalic Anhydride/);
    assert.deepEqual(errors, []);
  });
});
