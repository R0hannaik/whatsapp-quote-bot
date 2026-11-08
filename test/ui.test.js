// Clicks through the real dashboard in Chrome (headless). Skipped automatically if Chrome isn't installed.
// Set CHROME_PATH to point at another Chrome/Chromium.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupEnv } from './helpers.js';

const CHROME = [process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(p => p && fs.existsSync(p));
let puppeteer = null;
try { puppeteer = (await import('puppeteer-core')).default; } catch { /* dev dependency not installed */ }
const skip = !CHROME || !puppeteer ? 'Chrome or puppeteer-core not available' : false;

setupEnv({ CONTACT_PHONE: '+91 90000 00000' });
const { app } = await import('../src/server.js');
const db = await import('../src/db.js');

let server, base, browser, page;
const errors = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
const text = sel => page.$eval(sel, e => e.innerText);
const tab = async name => { await page.click(`.tab[data-tab=${name}]`); await wait(500); };

describe('dashboard in a browser', { skip }, () => {
  before(async () => {
    db.setCurrentAccount('919000000009@s.whatsapp.net');
    db.upsertLiveGroup({ jid: '120363000000000001@g.us', name: 'Traders Group', members: 12 });
    for (const [chem, req] of [['Phthalic Anhydride', null], [null, 'DOP']]) {
      db.createInquiry({ group_jid: '120363000000000001@g.us', group_name: 'Traders Group', sender_name: 'Rakesh', message: 'Need PA 2 MT, DOP 1 tanker',
        chemical_name: chem, requested_text: req, status: chem ? 'Quoted' : 'Unmatched', intent: chem ? 'quote' : 'unmatched', batch_key: 'B1', batch_size: 2, quantity: '2 MT' });
    }
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  });
  after(async () => { await browser?.close(); server?.close(); });

  test('log in', async () => {
    await page.goto(`${base}/login`);
    await page.type('#pw', 'wrong-password'); await page.click('#go'); await wait(1200);
    assert.match(await text('#err'), /Incorrect password/);
    await page.$eval('#pw', e => { e.value = ''; });
    await page.type('#pw', 'test-password-123');
    await Promise.all([page.waitForNavigation(), page.click('#go')]);
    assert.equal(new URL(page.url()).pathname, '/');
  });

  test('every tab opens without errors', async () => {
    for (const t of ['chemicals', 'groups', 'templates', 'orders', 'join', 'settings']) {
      await tab(t);
      assert.ok(await page.$eval(`#view-${t}`, e => !e.classList.contains('hidden') && e.innerText.length > 20), t);
    }
    assert.deepEqual(errors, []);
  });

  test('Edit Chemical modal opens, saves and shows the change', async () => {
    await tab('chemicals');
    await page.click('[data-edit]'); await wait(300);
    assert.match(await text('.modal-head h3'), /Edit Chemical Details & Price/);
    await page.click('#addOrigin');
    const rows = await page.$$('.origin-row');
    const last = rows.at(-1);
    await (await last.$('[data-o=country]')).type('Japan');
    await (await last.$('[data-o=rate]')).type('99');
    await page.click('#saveChem'); await wait(700);
    assert.match(await text('#chemRows'), /Japan/);
  });

  test('Add Chemical validates required fields', async () => {
    await page.click('[data-act=add-chem]'); await wait(300);
    await page.click('#saveChem'); await wait(300);
    assert.match(await text('#toasts'), /name is required/i);
    await page.keyboard.press('Escape');
  });

  test('group auto-reply toggle', async () => {
    await tab('groups');
    await page.click('label.toggle span'); await wait(500);          // the visible slider (the checkbox itself is hidden)
    assert.equal(db.getGroup('120363000000000001@g.us').auto_reply, true);
    assert.match(await text('#grpRows'), /ON/);
  });

  test('Unlink this number works (no "Cannot set properties of null")', async () => {
    await page.click('#waPill'); await wait(300);
    await page.click('#logoutWa'); await wait(300);
    await page.click('#okBtn'); await wait(1500);
    assert.match(await text('.modal-head h3'), /Unlinked here|WhatsApp Connection/);
    await page.keyboard.press('Escape'); await wait(300);            // closes the notice → connection window reopens
    assert.match(await text('.modal-head h3'), /WhatsApp Connection/);
    await page.keyboard.press('Escape'); await wait(300);
    assert.equal(await page.$eval('#modalRoot', e => e.innerHTML), '');
    assert.deepEqual(errors, []);
  });

  test('Multi-Product template: two editors, presets, live preview, save', async () => {
    db.setCurrentAccount('919000000009@s.whatsapp.net');
    await tab('templates');
    await page.click('#tplMode button[data-mode=multi]'); await wait(1000);
    assert.equal((await page.$$('#tplEditors textarea')).length, 2);
    assert.match(await text('#tplReplies'), /Quotation for \d products/);
    await page.click('#tplPresets [data-preset=minimal]'); await wait(800);
    assert.match(await text('#tplReplies'), /Rates \(\d items\)/);
    await page.click('#tplSave'); await wait(600);
    assert.match(db.getTemplates().multi, /^\*Rates\*/);
  });

  test('typing a message in the preview shows what the bot understood', async () => {
    await page.click('#tplMode button[data-mode=quote]'); await wait(500);
    await page.$eval('#tplMsg', e => { e.value = ''; });
    await page.type('#tplMsg', 'Good morning all'); await wait(800);
    assert.match(await text('#tplReplies'), /would not reply/);
  });

  test('Orders: open an enquiry, record a decision, view the multi-product enquiry', async () => {
    await tab('orders');
    await page.click('.spill[data-st=all]'); await wait(500);
    await page.click('[data-open]'); await wait(300);
    await page.click('[data-set=Confirmed]'); await wait(700);
    assert.match(await text('.timeline'), /Status → Confirmed/);
    await page.keyboard.press('Escape'); await wait(200);
    await page.click('[data-batch]'); await wait(500);
    assert.equal((await page.$$('#ordRows tr')).length, 2);
    assert.match(await text('#ordRows'), /DOP/);
  });

  test('Settings save', async () => {
    await tab('settings');
    await page.select('select[name=multi_reply_style]', 'separate');
    await page.click('#setForm button[type=submit]'); await wait(500);
    assert.equal(db.getSetting('multi_reply_style'), 'separate');
    assert.ok(await page.$eval('input[name=contact_phone]', e => e.disabled), 'phone from .env is read-only');
  });

  test('Settings → Database backups: back up now and list it', async () => {
    await tab('settings'); await wait(300);
    await page.click('#backupNow'); await wait(800);
    assert.match(await text('#toasts'), /Backup saved/);
    assert.match(await text('#backupRows'), /quotebot-.*-manual\.db/);
    assert.ok(await page.$('#backupRows a[download]'), 'download link shown');
  });

  test('no JavaScript errors anywhere', () => assert.deepEqual(errors, []));

  test('log out', async () => {
    await Promise.all([page.waitForNavigation(), page.click('#logoutBtn')]);
    assert.equal(new URL(page.url()).pathname, '/login');
  });
});
