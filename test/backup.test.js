// Database backups: consistent copies, retention, safe file names, download through the dashboard.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupEnv } from './helpers.js';

setupEnv();
const { app } = await import('../src/server.js');
const db = await import('../src/db.js');
const bk = await import('../src/backup.js');
const Database = (await import('better-sqlite3')).default;

describe('backups', () => {
  test('a backup is a complete, readable copy of the database', async () => {
    db.createChemical({ name: 'Backup Test Chemical', aliases: 'btc', price: 10 });
    const b = await bk.createBackup({ manual: true });
    assert.match(b.name, /^quotebot-\d{4}-\d{2}-\d{2}_\d{4}-manual\.db$/);
    const copy = new Database(path.join(bk.BACKUP_DIR, b.name), { readonly: true });
    assert.equal(copy.prepare("SELECT name FROM chemicals WHERE name = 'Backup Test Chemical'").get().name, 'Backup Test Chemical');
    assert.ok(copy.prepare('SELECT COUNT(*) n FROM settings').get().n > 0);
    copy.close();
  });
  test('backup files are private to the owner', { skip: process.platform === 'win32' }, async () => {
    const b = bk.listBackups()[0];
    assert.equal(fs.statSync(path.join(bk.BACKUP_DIR, b.name)).mode & 0o777, 0o600);
  });
  test('old automatic backups are removed, keeping the newest N', () => {
    for (let d = 1; d <= 6; d++) fs.writeFileSync(path.join(bk.BACKUP_DIR, `quotebot-2026-01-0${d}_0300.db`), 'x');
    bk.prune(3);
    const autos = bk.listBackups().filter(b => !b.manual).map(b => b.name);
    assert.equal(autos.length, 3);
    assert.ok(bk.listBackups().some(b => b.manual), 'manual backups are kept');
  });
  test('only real backup names are accepted (no reading other files)', () => {
    for (const bad of ['../quotebot.db', 'quotebot.db', '..%2Fquotebot.db', 'quotebot-2026-01-01_0300.db/../../x', 'wa-auth/creds.json']) {
      assert.equal(bk.backupPath(bad), null, bad);
    }
    assert.throws(() => bk.deleteBackup('../quotebot.db'), /not found/);
  });
});

describe('backups in the dashboard', () => {
  let server, base, cookie;
  before(async () => {
    server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'test-password-123' }) });
    cookie = r.headers.get('set-cookie').split(';')[0];
  });
  after(() => server.close());
  const call = (method, url) => fetch(base + url, { method, headers: { Cookie: cookie, Origin: base, 'Sec-Fetch-Site': 'same-origin' } });

  test('health check is public and reveals nothing', async () => {
    const r = await fetch(`${base}/healthz`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });
  test('list / back up now / download / delete — login required', async () => {
    assert.equal((await fetch(`${base}/api/backups`)).status, 401);
    const made = await (await call('POST', '/api/backups')).json();
    const list = await (await call('GET', '/api/backups')).json();
    assert.ok(list.items.some(b => b.name === made.name));
    const dl = await call('GET', `/api/backups/${made.name}`);
    assert.equal(dl.status, 200);
    assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
    assert.equal((await fetch(`${base}/api/backups/${made.name}`)).status, 401, 'no download without login');
    assert.equal((await call('GET', '/api/backups/..%2Fquotebot.db')).status, 404);
    assert.equal((await call('DELETE', `/api/backups/${made.name}`)).status, 200);
  });
  test('backup settings are validated', async () => {
    const put = body => fetch(`${base}/api/settings`, { method: 'PUT', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await put({ backup_hour_ist: 25 })).status, 400);
    assert.equal((await put({ backup_keep_days: 0 })).status, 400);
    assert.equal((await put({ backup_hour_ist: 2, backup_keep_days: 30 })).status, 200);
  });
});

describe('restore script', () => {
  test('restores a backup, keeps the old database, rejects non-backups', async () => {
    const { execFileSync } = await import('node:child_process');
    const run = file => { try { return { ok: true, out: execFileSync(process.execPath, ['scripts/restore.js', file], { env: { ...process.env }, encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { ok: false, out: String(e.stderr) }; } };
    const b = await bk.createBackup({ manual: true });
    db.createChemical({ name: 'Added After Backup', aliases: 'aab', price: 1 });
    // the app (this test process) still has the database open → refused
    assert.match(run(path.join(bk.BACKUP_DIR, b.name)).out, /in use|stop the app/);
    db.db.close();
    assert.match(run(path.join(process.env.DATA_DIR, 'nope.db')).out, /not found/i);
    const junk = path.join(process.env.DATA_DIR, 'junk.db'); fs.writeFileSync(junk, 'hello');
    assert.equal(run(junk).ok, false);
    const r = run(path.join(bk.BACKUP_DIR, b.name));
    assert.ok(r.ok, r.out);
    const restored = new Database(path.join(process.env.DATA_DIR, 'quotebot.db'), { readonly: true });
    assert.equal(restored.prepare("SELECT COUNT(*) n FROM chemicals WHERE name = 'Added After Backup'").get().n, 0, 'back to the backup state');
    restored.close();
    assert.ok(fs.readdirSync(process.env.DATA_DIR).some(f => f.startsWith('quotebot.before-restore-')), 'old database kept');
  });
});
