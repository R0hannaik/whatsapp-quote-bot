// Database backups: a consistent copy of the SQLite file, made while the app keeps running.
// Backups hold chemicals, rates, templates, groups, orders and settings (incl. the password hash) —
// NOT the WhatsApp login (data/wa-auth); after a restore you simply scan the QR again.
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR, getSetting } from './db.js';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const NAME_RE = /^quotebot-\d{4}-\d{2}-\d{2}_\d{4}(-manual)?\.db$/;

function stamp(d = new Date()) {
  // India time, e.g. 2026-11-08_0300
  const ist = new Date(d.getTime() + 330 * 60000).toISOString();
  return `${ist.slice(0, 10)}_${ist.slice(11, 13)}${ist.slice(14, 16)}`;
}

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(f => NAME_RE.test(f)).map(name => {
    const st = fs.statSync(path.join(BACKUP_DIR, name));
    return { name, size: st.size, created: st.mtime.toISOString(), manual: name.includes('-manual') };
  }).sort((a, b) => b.created.localeCompare(a.created) || b.name.localeCompare(a.name));
}

/** Make a backup now. Uses SQLite's online backup, so it's safe while the bot is writing. */
export async function createBackup({ manual = false } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  let name = `quotebot-${stamp()}${manual ? '-manual' : ''}.db`;
  if (fs.existsSync(path.join(BACKUP_DIR, name))) fs.rmSync(path.join(BACKUP_DIR, name));
  const file = path.join(BACKUP_DIR, name);
  await db.backup(file);
  try { fs.chmodSync(file, 0o600); } catch { /* not supported */ }
  prune();
  return listBackups().find(b => b.name === name);
}

/** Keep the newest N automatic backups (manual ones are kept until you delete them, max 20). */
export function prune(keep = Number(getSetting('backup_keep_days')) || 14) {
  const all = listBackups();
  const autos = all.filter(b => !b.manual).slice(keep);
  const manuals = all.filter(b => b.manual).slice(20);
  for (const b of [...autos, ...manuals]) fs.rmSync(path.join(BACKUP_DIR, b.name), { force: true });
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
  fs.rmSync(p);
}

/** Daily automatic backup at the configured India-time hour (default 3 AM). */
export function startBackupSchedule() {
  const tick = async () => {
    const hour = Number(getSetting('backup_hour_ist'));
    const now = new Date(Date.now() + 330 * 60000);
    if (!Number.isFinite(hour) || hour < 0 || now.getUTCHours() !== hour) return;
    const today = now.toISOString().slice(0, 10);
    if (listBackups().some(b => !b.manual && b.name.startsWith(`quotebot-${today}`))) return;
    try { const b = await createBackup(); console.log(`[backup] saved ${b.name}`); }
    catch (e) { console.error('[backup] failed:', e.message); }
  };
  setInterval(tick, 5 * 60000).unref();
  tick();
}
