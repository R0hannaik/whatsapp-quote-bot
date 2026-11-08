// Data protection: encrypted off-site backups, verification, tamper detection, restore from the cloud.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { setupEnv, startFakeS3 } from './helpers.js';
import { encryptBackup, decryptBackup } from '../src/backup-crypto.js';

const s3 = await startFakeS3();
const PASS = 'correct horse battery staple 2026';
setupEnv({ ...s3.env, BACKUP_ENCRYPTION_PASSPHRASE: PASS });
const db = await import('../src/db.js');
const bk = await import('../src/backup.js');
const { app } = await import('../src/server.js');
db.ensureSecrets(); db.seedIfEmpty();
after(() => s3.close());

describe('encryption', () => {
  const plain = Buffer.from('SQLite format 3\0 Phthalic Anhydride ₹199 buyer +919820000001');
  test('round trip', () => assert.deepEqual(decryptBackup(encryptBackup(plain, PASS), PASS), plain));
  test('encrypted file reveals nothing readable', () => {
    const enc = encryptBackup(plain, PASS).toString('latin1');
    for (const s of ['Phthalic', 'SQLite', '9820000001']) assert.ok(!enc.includes(s), s);
  });
  test('same data encrypts differently each time (random salt + IV)', () => {
    assert.notDeepEqual(encryptBackup(plain, PASS), encryptBackup(plain, PASS));
  });
  test('wrong passphrase is refused', () => assert.throws(() => decryptBackup(encryptBackup(plain, PASS), PASS + 'x'), /Wrong passphrase|altered/));
  test('a single changed byte is detected', () => {
    const enc = encryptBackup(plain, PASS);
    enc[enc.length - 5] ^= 1;
    assert.throws(() => decryptBackup(enc, PASS), /damaged|altered/);
  });
  test('weak or missing passphrase is refused', () => {
    assert.throws(() => encryptBackup(plain, 'short'), /at least 16/);
    assert.throws(() => encryptBackup(plain, ''), /not set/);
  });
  test('non-backup files are refused', () => assert.throws(() => decryptBackup(Buffer.from('hello world, this is not a backup file at all!!'), PASS), /Not a Quote Bot/));
});

describe('local backups are verified', () => {
  test('each backup gets an integrity check and a SHA-256 checksum', async () => {
    const b = await bk.createBackup({ manual: true });
    assert.equal(b.verified, true);
    assert.match(b.sha256, /^[0-9a-f]{64}$/);
    assert.equal(bk.getHealth().lastBackup.ok, true);
  });
  test('live database health check', () => {
    assert.equal(bk.checkLiveDb(), true);
    assert.equal(bk.getHealth().liveCheck.ok, true);
  });
  test('verifyDbFile rejects damaged / foreign files', () => {
    const junk = path.join(process.env.DATA_DIR, 'junk.db'); fs.writeFileSync(junk, 'not sqlite');
    assert.equal(bk.verifyDbFile(junk).ok, false);
  });
});

describe('off-site backups', () => {
  test('status: configured, nothing sent yet', () => {
    const st = bk.offsiteStatus();
    assert.equal(st.configured, true);
    assert.equal(st.bucket, 'qb-backups');
    assert.equal(st.lastSuccess, null);
  });
  test('upload: encrypted, checksummed, signed, under a dated name', async () => {
    db.createChemical({ name: 'Offsite Marker Chemical', aliases: 'omc', price: 5 });
    const r = await bk.runOffsiteBackup();
    assert.match(r.key, /^quotebot\/\d{4}\/\d{2}\/quotebot-\d{4}-\d{2}-\d{2}_\d{4}\.qbk$/);
    const obj = s3.objects.get(r.key);
    assert.ok(obj, 'stored');
    assert.ok(!obj.body.toString('latin1').includes('Offsite Marker Chemical'), 'not readable without the passphrase');
    assert.match(obj.meta['x-amz-meta-sha256'], /^[0-9a-f]{64}$/);
    const put = s3.requests.find(q => q.method === 'PUT');
    assert.ok(put.headers['content-md5'], 'MD5 sent for integrity in transit');
    assert.match(put.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d+\/ap-south-1\/s3\/aws4_request/);
    assert.ok(bk.offsiteStatus().lastSuccess);
  });
  test('restore drill: download → decrypt → verify, without touching the live data', async () => {
    const t = await bk.testOffsiteRestore();
    assert.equal(t.ok, true, t.error);
    assert.ok(t.counts.chemicals >= 1);
    assert.equal(bk.getHealth().offsite.lastTest.ok, true);
  });
  test('a tampered cloud copy is caught by the drill', async () => {
    const latest = await bk.latestOffsite();
    const o = s3.objects.get(latest.key);
    const saved = Buffer.from(o.body);
    o.body[60] ^= 0xff;
    const t = await bk.testOffsiteRestore();
    assert.equal(t.ok, false);
    assert.match(t.error, /damaged|altered/);
    o.body = saved;
  });
  test('storage unreachable → error recorded and shown after 6 hours of failures', async () => {
    const good = process.env.BACKUP_S3_ENDPOINT;
    process.env.BACKUP_S3_ENDPOINT = 'http://127.0.0.1:9';
    await assert.rejects(bk.runOffsiteBackup());
    assert.ok(bk.offsiteStatus().lastError);
    assert.equal(bk.backupProblem(), null, 'recent success → no alarm yet');
    assert.match(bk.backupProblem(Date.now() + 7 * 3600e3), /Off-site backup is failing/);
    process.env.BACKUP_S3_ENDPOINT = good;
    await bk.runOffsiteBackup();
    assert.equal(bk.offsiteStatus().lastError, null);
  });
  test('wrong credentials are reported clearly', async () => {
    const good = process.env.BACKUP_S3_ACCESS_KEY_ID;
    process.env.BACKUP_S3_ACCESS_KEY_ID = 'WRONGKEY';
    await assert.rejects(bk.runOffsiteBackup(), /HTTP 403 AccessDenied/);
    process.env.BACKUP_S3_ACCESS_KEY_ID = good;
  });
  test('only https endpoints are accepted (except local testing)', async () => {
    const { s3Config } = await import('../src/s3.js');
    assert.equal(s3Config({ ...s3.env, BACKUP_S3_ENDPOINT: 'http://s3.example.com' }).configured, false);
    assert.equal(s3Config({ ...s3.env, BACKUP_S3_ENDPOINT: 'https://s3.ap-south-1.amazonaws.com' }).configured, true);
  });
  test('the app never deletes anything in the bucket', () => {
    assert.equal(s3.requests.filter(q => q.method === 'DELETE').length, 0);
  });
});

describe('dashboard API', () => {
  let server, base, cookie;
  before(async () => {
    server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'test-password-123' }) });
    cookie = r.headers.get('set-cookie').split(';')[0];
  });
  after(() => server.close());
  const call = async (method, url) => { const r = await fetch(base + url, { method, headers: { Cookie: cookie, Origin: base } }); return { status: r.status, body: await r.json() }; };
  test('status, upload now, restore drill, health check — login required', async () => {
    assert.equal((await fetch(`${base}/api/backups/offsite`, { method: 'POST', headers: { Origin: base } })).status, 401);
    const st = await call('GET', '/api/backups');
    assert.equal(st.body.offsite.configured, true);
    assert.ok(!JSON.stringify(st.body).includes('secret-test-key'), 'secrets never sent to the browser');
    assert.ok(!JSON.stringify(st.body).includes(PASS), 'passphrase never sent to the browser');
    assert.equal((await call('POST', '/api/backups/offsite')).status, 200);
    assert.equal((await call('POST', '/api/backups/offsite/test')).body.ok, true);
    assert.equal((await call('POST', '/api/backups/check')).body.ok, true);
  });
});

describe('restore from the cloud (scripts/restore.js)', () => {
  // async on purpose: the fake storage server runs in this process and must keep answering while the script runs
  const run = args => new Promise(resolve => execFile(process.execPath, ['scripts/restore.js', ...args], { env: { ...process.env }, encoding: 'utf8', timeout: 60000 },
    (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout) + String(stderr) })));
  test('list, then restore the newest off-site backup', async () => {
    await bk.runOffsiteBackup();
    db.createChemical({ name: 'Added After Upload', aliases: 'aau', price: 1 });
    assert.match((await run(['--cloud', 'list'])).out, /quotebot\/\d{4}\/\d{2}\/quotebot-.*\.qbk/);
    db.db.close();                                   // "stop the app"
    const r = await run(['--cloud', 'latest']);
    assert.ok(r.ok, r.out);
    assert.match(r.out, /Restored/);
    const d = new (await import('better-sqlite3')).default(path.join(process.env.DATA_DIR, 'quotebot.db'), { readonly: true });
    assert.equal(d.prepare("SELECT COUNT(*) n FROM chemicals WHERE name = 'Offsite Marker Chemical'").get().n, 1);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM chemicals WHERE name = 'Added After Upload'").get().n, 0);
    d.close();
  });
  test('wrong passphrase → nothing is replaced', async () => {
    const before = fs.readFileSync(path.join(process.env.DATA_DIR, 'quotebot.db'));
    const saved = process.env.BACKUP_ENCRYPTION_PASSPHRASE;
    process.env.BACKUP_ENCRYPTION_PASSPHRASE = 'a completely wrong passphrase!!';
    const r = await run(['--cloud', 'latest']);
    process.env.BACKUP_ENCRYPTION_PASSPHRASE = saved;
    assert.equal(r.ok, false);
    assert.match(r.out, /Wrong passphrase/);
    assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR, 'quotebot.db')), before);
  });
  test('a local backup that no longer matches its checksum is refused', async () => {
    const dir = path.join(process.env.DATA_DIR, 'backups');
    const b = fs.readdirSync(dir).find(f => f.endsWith('.db'));
    fs.appendFileSync(path.join(dir, b), 'x');
    assert.match((await run([path.join(dir, b)])).out, /does not match its checksum/);
  });
});
