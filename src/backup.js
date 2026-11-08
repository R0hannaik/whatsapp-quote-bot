// Database protection:
//  1. Local backups   — a consistent copy of the SQLite file (daily + on demand), each one VERIFIED and checksummed.
//  2. Off-site backups — every hour, an encrypted (AES-256-GCM) copy is uploaded to S3-compatible storage you own.
//  3. Health checks   — the live database is checked daily; problems show up in the dashboard.
// Backups hold chemicals, rates, templates, groups, orders, payments and settings (incl. the password hash) —
// NOT the WhatsApp login (data/wa-auth); after a restore you simply scan the QR again.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { db, DATA_DIR, getSetting, setSetting } from './db.js';
import { encryptBackup, decryptBackup, sha256, checkPassphrase } from './backup-crypto.js';
import { s3Config, putObject, getObject, listObjects } from './s3.js';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const NAME_RE = /^quotebot-\d{4}-\d{2}-\d{2}_\d{4}(-manual)?\.db$/;
const REQUIRED_TABLES = ['settings', 'chemicals', 'groups', 'templates', 'inquiries'];
const quiet = () => !!process.env.QB_QUIET;

function stamp(d = new Date()) {
  // India time, e.g. 2026-11-08_0300
  const ist = new Date(d.getTime() + 330 * 60000).toISOString();
  return `${ist.slice(0, 10)}_${ist.slice(11, 13)}${ist.slice(14, 16)}`;
}

/* ---------------- health record (kept in the database so it survives restarts) ---------------- */
export const getHealth = () => getSetting('backup_health') || {};
function setHealth(part) { setSetting('backup_health', { ...getHealth(), ...part }); }

/** Is this a complete, uncorrupted Quote Bot database? */
export function verifyDbFile(file) {
  let d;
  try {
    d = new Database(file, { readonly: true, fileMustExist: true });
    const tables = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name));
    const missing = REQUIRED_TABLES.filter(t => !tables.has(t));
    if (missing.length) return { ok: false, error: `missing table(s): ${missing.join(', ')}` };
    const ic = d.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') return { ok: false, error: `integrity check failed: ${ic}` };
    const count = t => (tables.has(t) ? d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n : 0);
    return { ok: true, counts: { chemicals: count('chemicals'), enquiries: count('inquiries'), orders: count('orders') } };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { try { d?.close(); } catch { /* ignore */ } }
}

/** Quick check of the live database (run daily, and from the dashboard). */
export function checkLiveDb() {
  let ok = false, detail;
  try { detail = db.pragma('quick_check', { simple: true }); ok = detail === 'ok'; }
  catch (e) { detail = e.message; }
  setHealth({ liveCheck: { at: new Date().toISOString(), ok, detail: ok ? 'ok' : String(detail).slice(0, 300) } });
  if (!ok) console.error('[backup] LIVE DATABASE CHECK FAILED:', detail);
  return ok;
}

/* ---------------- local backups ---------------- */
export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(f => NAME_RE.test(f)).map(name => {
    const st = fs.statSync(path.join(BACKUP_DIR, name));
    const sumFile = path.join(BACKUP_DIR, `${name}.sha256`);
    const checksum = fs.existsSync(sumFile) ? fs.readFileSync(sumFile, 'utf8').trim() : null;
    return { name, size: st.size, created: st.mtime.toISOString(), manual: name.includes('-manual'), verified: !!checksum, sha256: checksum };
  }).sort((a, b) => b.created.localeCompare(a.created) || b.name.localeCompare(a.name));
}

/** Make a backup now (SQLite online backup — safe while the bot is writing), then verify it before keeping it. */
export async function createBackup({ manual = false } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const name = `quotebot-${stamp()}${manual ? '-manual' : ''}.db`;
  const file = path.join(BACKUP_DIR, name);
  fs.rmSync(file, { force: true });
  await db.backup(file);
  const v = verifyDbFile(file);
  if (!v.ok) {
    fs.rmSync(file, { force: true });
    setHealth({ lastBackup: { at: new Date().toISOString(), ok: false, error: v.error } });
    throw new Error(`Backup failed verification (${v.error}) — it was not kept`);
  }
  fs.writeFileSync(`${file}.sha256`, sha256(fs.readFileSync(file)));
  for (const f of [file, `${file}.sha256`]) { try { fs.chmodSync(f, 0o600); } catch { /* not supported */ } }
  setHealth({ lastBackup: { at: new Date().toISOString(), ok: true, name } });
  prune();
  return listBackups().find(b => b.name === name);
}

/** Keep the newest N automatic backups (manual ones are kept until you delete them, max 20). */
export function prune(keep = Number(getSetting('backup_keep_days')) || 14) {
  const all = listBackups();
  const autos = all.filter(b => !b.manual).slice(keep);
  const manuals = all.filter(b => b.manual).slice(20);
  for (const b of [...autos, ...manuals]) for (const f of [b.name, `${b.name}.sha256`]) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
}

/** Absolute path of a backup by name, or null (never lets a name escape the backups folder). */
export function backupPath(name) {
  if (!NAME_RE.test(String(name))) return null;
  const p = path.join(BACKUP_DIR, name);
  return fs.existsSync(p) ? p : null;
}

export function deleteBackup(name) {
  const p = backupPath(name);
  if (!p) throw new Error('Backup not found');
  fs.rmSync(p); fs.rmSync(`${p}.sha256`, { force: true });
}

/* ---------------- off-site (encrypted, S3-compatible) ---------------- */
export function offsiteStatus() {
  const c = s3Config();
  let problem = c.problem || null;
  if (c.configured) { try { checkPassphrase(process.env.BACKUP_ENCRYPTION_PASSPHRASE); } catch (e) { problem = e.message; } }
  const h = getHealth().offsite || {};
  return {
    configured: c.configured && !problem, problem, bucket: c.bucket || null, endpoint: c.endpoint || null, prefix: c.prefix,
    everyHours: Number(getSetting('offsite_every_hours')) || 0,
    lastSuccess: h.lastSuccess || null, lastKey: h.lastKey || null, lastSize: h.lastSize || null,
    lastAttempt: h.lastAttempt || null, lastError: h.lastError || null, lastTest: h.lastTest || null,
  };
}

const offsiteKey = prefix => { const s = stamp(); return `${prefix}${s.slice(0, 4)}/${s.slice(5, 7)}/quotebot-${s}.qbk`; };

let offsiteRunning = false;
/** Take a fresh backup, verify it, encrypt it and upload it. Nothing unencrypted ever leaves the server. */
export async function runOffsiteBackup() {
  const st = offsiteStatus();
  if (!st.configured) throw new Error(st.problem || 'Off-site backup is not set up (see DEPLOY.md → Off-site backups)');
  if (offsiteRunning) throw new Error('An off-site backup is already running');
  offsiteRunning = true;
  const tmp = path.join(BACKUP_DIR, `.offsite-${process.pid}.tmp`);
  const attempt = new Date().toISOString();
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    await db.backup(tmp);
    const v = verifyDbFile(tmp);
    if (!v.ok) throw new Error(`fresh copy failed verification (${v.error})`);
    const plain = fs.readFileSync(tmp);
    const enc = encryptBackup(plain, process.env.BACKUP_ENCRYPTION_PASSPHRASE);
    const key = offsiteKey(st.prefix);
    await putObject(s3Config(), key, enc, { sha256: sha256(plain), app: 'quotebot', format: 'qbk1' });
    setHealth({ offsite: { ...getHealth().offsite, lastAttempt: attempt, lastSuccess: new Date().toISOString(), lastKey: key, lastSize: enc.length, lastError: null } });
    if (!quiet()) console.log(`[backup] off-site copy uploaded: ${key} (${Math.round(enc.length / 1024)} KB, encrypted)`);
    return { key, size: enc.length, counts: v.counts };
  } catch (e) {
    setHealth({ offsite: { ...getHealth().offsite, lastAttempt: attempt, lastError: e.message } });
    if (!quiet()) console.error('[backup] off-site upload failed:', e.message);
    throw e;
  } finally {
    offsiteRunning = false;
    fs.rmSync(tmp, { force: true });
  }
}

/** Newest off-site backup, or null. */
export async function latestOffsite(c = s3Config()) {
  const all = (await listObjects(c)).filter(o => o.key.endsWith('.qbk'));
  all.sort((a, b) => a.key.localeCompare(b.key));
  return all.at(-1) || null;
}

/** Restore drill without touching anything: download the newest off-site backup, decrypt, verify. */
export async function testOffsiteRestore() {
  const st = offsiteStatus();
  if (!st.configured) throw new Error(st.problem || 'Off-site backup is not set up');
  const c = s3Config();
  const result = { at: new Date().toISOString() };
  const tmp = path.join(BACKUP_DIR, `.restore-test-${process.pid}.tmp`);
  try {
    const latest = await latestOffsite(c);
    if (!latest) throw new Error('No off-site backups found yet');
    const { body, meta } = await getObject(c, latest.key);
    const plain = decryptBackup(body, process.env.BACKUP_ENCRYPTION_PASSPHRASE);
    if (meta.sha256 && meta.sha256 !== sha256(plain)) throw new Error('Checksum mismatch after decryption');
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, plain, { mode: 0o600 });
    const v = verifyDbFile(tmp);
    if (!v.ok) throw new Error(`Downloaded backup failed verification (${v.error})`);
    Object.assign(result, { ok: true, key: latest.key, counts: v.counts });
  } catch (e) {
    Object.assign(result, { ok: false, error: e.message });
  } finally { fs.rmSync(tmp, { force: true }); }
  setHealth({ offsite: { ...getHealth().offsite, lastTest: result } });
  return result;
}

/** One line for the dashboard when something needs attention, else null. */
export function backupProblem(now = Date.now()) {
  const h = getHealth();
  if (h.liveCheck && !h.liveCheck.ok) return `Database health check failed (${h.liveCheck.detail}). Restore the latest backup — see DEPLOY.md.`;
  if (h.lastBackup && !h.lastBackup.ok) return `Last backup failed: ${h.lastBackup.error}`;
  const st = offsiteStatus();
  if (st.configured && st.everyHours > 0) {
    const last = st.lastSuccess ? Date.parse(st.lastSuccess) : null;
    if (st.lastError && (!last || now - last > 6 * 3600e3)) return `Off-site backup is failing: ${st.lastError}`;
  }
  return null;
}

/* ---------------- schedules ---------------- */
export function startBackupSchedule() {
  const tick = async () => {
    const now = new Date(Date.now() + 330 * 60000);
    const today = now.toISOString().slice(0, 10);
    // daily local backup at the set hour
    const hour = Number(getSetting('backup_hour_ist'));
    if (Number.isFinite(hour) && hour >= 0 && now.getUTCHours() === hour && !listBackups().some(b => !b.manual && b.name.startsWith(`quotebot-${today}`))) {
      try { const b = await createBackup(); if (!quiet()) console.log(`[backup] saved ${b.name}`); }
      catch (e) { console.error('[backup] failed:', e.message); }
    }
    // daily health check of the live database
    const lc = getHealth().liveCheck;
    if (!lc || Date.now() - Date.parse(lc.at) > 24 * 3600e3) checkLiveDb();
    // off-site copy every N hours (failures retried after 30 minutes)
    const st = offsiteStatus();
    if (st.configured && st.everyHours > 0) {
      const lastOk = st.lastSuccess ? Date.parse(st.lastSuccess) : 0;
      const lastTry = st.lastAttempt ? Date.parse(st.lastAttempt) : 0;
      if (Date.now() - lastOk >= st.everyHours * 3600e3 - 60e3 && Date.now() - lastTry >= 30 * 60e3) {
        await runOffsiteBackup().catch(() => { /* recorded in health */ });
      }
      // weekly automatic restore drill: proves the cloud copies can really be decrypted and used
      const lt = getHealth().offsite?.lastTest;
      if (st.lastSuccess && (!lt || Date.now() - Date.parse(lt.at) > 7 * 24 * 3600e3)) await testOffsiteRestore();
    }
  };
  setInterval(() => tick().catch(e => console.error('[backup] schedule error:', e.message)), 5 * 60000).unref();
  setTimeout(() => tick().catch(e => console.error('[backup] schedule error:', e.message)), 15000).unref();
}
