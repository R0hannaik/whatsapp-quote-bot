#!/usr/bin/env node
// Restore the database from a backup.  STOP THE APP FIRST.
//
//   From a backup on the server:      node scripts/restore.js data/backups/quotebot-2026-11-08_0300.db
//   From an encrypted backup file:    node scripts/restore.js quotebot-2026-11-08_1405.qbk
//   Newest off-site (cloud) backup:   node scripts/restore.js --cloud latest
//   A specific off-site backup:       node scripts/restore.js --cloud quotebot/2026/11/quotebot-2026-11-08_1405.qbk
//   List off-site backups:            node scripts/restore.js --cloud list
//
//   Docker:  docker compose stop app
//            docker compose run --rm --no-deps app node scripts/restore.js --cloud latest
//            docker compose start app
//
// Encrypted backups need BACKUP_ENCRYPTION_PASSPHRASE (and BACKUP_S3_* for --cloud) — taken from .env.
// The backup is fully checked before anything is replaced, and the current database is kept as
// data/quotebot.before-restore-<time>.db so a restore can be undone.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { decryptBackup, sha256 } from '../src/backup-crypto.js';
import { s3Config, listObjects, getObject } from '../src/s3.js';

if (!process.env.QB_NO_DOTENV && fs.existsSync('.env')) process.loadEnvFile('.env');
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const target = path.join(DATA_DIR, 'quotebot.db');
const fail = msg => { console.error(`\n  ✖ ${msg}\n`); process.exit(1); };
const args = process.argv.slice(2);

async function main() {
  if (!args.length) fail('Usage: node scripts/restore.js <backup.db | backup.qbk | --cloud latest|list|<key>>');
  let file, cleanup;

  if (args[0] === '--cloud') {
    const c = s3Config();
    if (!c.configured) fail(c.problem || 'Off-site storage is not configured (BACKUP_S3_* in .env)');
    const all = (await listObjects(c)).filter(o => o.key.endsWith('.qbk')).sort((a, b) => a.key.localeCompare(b.key));
    if (args[1] === 'list') {
      if (!all.length) console.log('  No off-site backups yet.');
      for (const o of all) console.log(`  ${o.key}   ${Math.round(o.size / 1024)} KB   ${o.lastModified}`);
      return;
    }
    const want = !args[1] || args[1] === 'latest' ? all.at(-1) : all.find(o => o.key === args[1]);
    if (!want) fail(args[1] && args[1] !== 'latest' ? `Off-site backup not found: ${args[1]}` : 'No off-site backups found');
    console.log(`  Downloading ${want.key} …`);
    const { body, meta } = await getObject(c, want.key);
    const plain = decryptBackup(body, process.env.BACKUP_ENCRYPTION_PASSPHRASE);
    if (meta.sha256 && meta.sha256 !== sha256(plain)) fail('Checksum mismatch after decryption — not restoring');
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-restore-')), 'restore.db');
    fs.writeFileSync(file, plain, { mode: 0o600 });
    cleanup = () => fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } else {
    const src = args[0];
    if (!fs.existsSync(src)) fail(`File not found: ${src}`);
    if (src.endsWith('.qbk')) {
      const plain = decryptBackup(fs.readFileSync(src), process.env.BACKUP_ENCRYPTION_PASSPHRASE);
      file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-restore-')), 'restore.db');
      fs.writeFileSync(file, plain, { mode: 0o600 });
      cleanup = () => fs.rmSync(path.dirname(file), { recursive: true, force: true });
    } else {
      file = src;
      const sum = `${src}.sha256`;
      if (fs.existsSync(sum) && fs.readFileSync(sum, 'utf8').trim() !== sha256(fs.readFileSync(src))) fail('This backup does not match its checksum (it was changed or damaged) — not restoring');
    }
  }

  try {
    // 1. Is it really a complete, healthy Quote Bot database?
    let check;
    try {
      check = new Database(file, { readonly: true, fileMustExist: true });
      const tables = new Set(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name));
      for (const t of ['settings', 'chemicals', 'groups', 'templates', 'inquiries']) if (!tables.has(t)) fail(`Not a Quote Bot backup (missing table "${t}")`);
      if (check.pragma('integrity_check', { simple: true }) !== 'ok') fail('The backup file is damaged (integrity check failed)');
      const n = t => tables.has(t) ? check.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n : 0;
      console.log(`  Backup looks good: ${n('chemicals')} chemicals, ${n('inquiries')} enquiries, ${n('orders')} orders.`);
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
    fs.copyFileSync(file, target);
    try { fs.chmodSync(target, 0o600); } catch { /* not supported */ }
    console.log('  ✔ Restored. Start the app again, then re-link WhatsApp if asked.\n');
  } finally { cleanup?.(); }
}

main().catch(e => fail(e.message));
