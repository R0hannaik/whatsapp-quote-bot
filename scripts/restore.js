#!/usr/bin/env node
// Restore the database from a backup file.  STOP THE APP FIRST.
//
//   Docker:  docker compose stop app
//            docker compose run --rm --no-deps app node scripts/restore.js data/backups/quotebot-2026-11-08_0300.db
//            docker compose start app
//   Plain:   (stop the app)  node scripts/restore.js path/to/backup.db  (start the app)
//
// The current database is kept as data/quotebot.before-restore-<time>.db, so a restore can be undone.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const src = process.argv[2];
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const target = path.join(DATA_DIR, 'quotebot.db');
const fail = msg => { console.error(`\n  ✖ ${msg}\n`); process.exit(1); };

if (!src) fail('Usage: node scripts/restore.js <backup-file.db>');
if (!fs.existsSync(src)) fail(`File not found: ${src}`);

// 1. Is it really a Quote Bot database?
let check;
try {
  check = new Database(src, { readonly: true, fileMustExist: true });
  const tables = new Set(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name));
  for (const t of ['settings', 'chemicals', 'groups', 'templates', 'inquiries']) if (!tables.has(t)) fail(`Not a Quote Bot backup (missing table "${t}")`);
  if (check.pragma('integrity_check', { simple: true }) !== 'ok') fail('The backup file is damaged (integrity check failed)');
  const n = check.prepare('SELECT COUNT(*) n FROM chemicals').get().n;
  const o = check.prepare('SELECT COUNT(*) n FROM inquiries').get().n;
  console.log(`  Backup looks good: ${n} chemicals, ${o} orders/enquiries.`);
} catch (e) {
  fail(`Could not read the backup: ${e.message}`);
} finally { check?.close(); }

// 2. Make sure the app isn't running (it would keep writing to the old file).
if (fs.existsSync(target)) {
  try {
    const live = new Database(target);
    live.pragma('locking_mode = EXCLUSIVE');
    live.prepare('BEGIN EXCLUSIVE').run(); live.prepare('ROLLBACK').run();
    live.close();
  } catch { fail('The database is in use — stop the app first (docker compose stop app).'); }
}

// 3. Keep the current database, then put the backup in place.
fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(target)) {
  const keep = path.join(DATA_DIR, `quotebot.before-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`);
  const cur = new Database(target);
  cur.pragma('wal_checkpoint(TRUNCATE)');
  cur.close();
  fs.copyFileSync(target, keep);
  console.log(`  Current database saved as ${path.basename(keep)}`);
}
for (const f of [`${target}-wal`, `${target}-shm`]) fs.rmSync(f, { force: true });
fs.copyFileSync(src, target);
try { fs.chmodSync(target, 0o600); } catch { /* not supported */ }
console.log('  ✔ Restored. Start the app again, then re-link WhatsApp if asked.\n');
