// Storage: groups per linked number (incl. upgrading old databases), settings from .env, orders history and filters.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { setupEnv } from './helpers.js';

const dir = setupEnv({ CONTACT_PHONE: '+91 91111 22222' });

// Build a database in the OLD format (groups keyed by jid only) before the app opens it, to test the upgrade.
const Database = (await import('better-sqlite3')).default;
const old = new Database(path.join(dir, 'quotebot.db'));
old.exec(`CREATE TABLE groups (jid TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'live', members INTEGER NOT NULL DEFAULT 0,
  quotes_sent INTEGER NOT NULL DEFAULT 0, auto_reply INTEGER NOT NULL DEFAULT 0, is_admin INTEGER NOT NULL DEFAULT 0, join_qr INTEGER NOT NULL DEFAULT 0,
  invite_code TEXT, invite_rotated_at TEXT, invite_error TEXT, left_group INTEGER NOT NULL DEFAULT 0, last_synced TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO groups(jid, name, auto_reply, quotes_sent) VALUES ('111@g.us', 'Old Traders Group', 1, 7), ('222@g.us', 'Old Brokers', 0, 0);`);
old.close();

const db = await import('../src/db.js');
db.ensureSecrets();
db.seedIfEmpty();
const A = '919000000001@s.whatsapp.net', B = '919000000002@s.whatsapp.net';
const names = () => db.listGroups().map(g => g.name).sort();

describe('groups belong to the linked WhatsApp number', () => {
  test('old groups are hidden until a number links, then kept with their toggles', () => {
    assert.deepEqual(db.listGroups(), []);
    db.setCurrentAccount(A);
    assert.deepEqual(names(), ['Old Brokers', 'Old Traders Group']);
    const g = db.getGroup('111@g.us');
    assert.equal(g.auto_reply, true);
    assert.equal(g.quotes_sent, 7);
  });
  test('unlinking hides everything; adding a group needs a linked number', () => {
    db.setCurrentAccount('');
    assert.deepEqual(db.listGroups(), []);
    assert.equal(db.getGroup('111@g.us'), undefined);
    assert.throws(() => db.addCustomGroup({ jid: '333@g.us', name: 'x' }), /Link a WhatsApp number first/);
  });
  test("another number sees only its own groups, even for a shared group", () => {
    db.setCurrentAccount(B);
    assert.deepEqual(db.listGroups(), []);
    db.upsertLiveGroup({ jid: '222@g.us', name: 'Shared Group', members: 4 });
    db.upsertLiveGroup({ jid: '999@g.us', name: 'B Only', members: 2 });
    db.patchGroup('222@g.us', { auto_reply: true });
    assert.deepEqual(names(), ['B Only', 'Shared Group']);
  });
  test('relinking the first number brings its groups back unchanged', () => {
    db.setCurrentAccount(''); db.setCurrentAccount(A);
    assert.deepEqual(names(), ['Old Brokers', 'Old Traders Group']);
    assert.equal(db.getGroup('222@g.us').auto_reply, false, "B's toggle didn't leak into A");
    assert.equal(db.getGroup('999@g.us'), undefined);
  });
  test('left groups are switched off; "Turn All OFF" works', () => {
    db.markGroupsLeft(['111@g.us']);
    const g = db.getGroup('111@g.us');
    assert.equal(g.left_group, true);
    assert.equal(g.auto_reply, false);
    db.patchGroup('222@g.us', { auto_reply: true });
    db.allAutoReplyOff();
    assert.ok(db.listGroups().every(x => !x.auto_reply));
  });
  test('patchGroup ignores columns that are not allowed', () => {
    db.patchGroup('222@g.us', { quotes_sent: 999, account: 'evil', name: 'Renamed' });
    const g = db.getGroup('222@g.us');
    assert.equal(g.name, 'Renamed');
    assert.equal(g.quotes_sent, 0);
  });
});

describe('settings', () => {
  test('CONTACT_PHONE from .env wins and is locked', () => {
    assert.equal(db.getSetting('contact_phone'), '+91 91111 22222');
    db.setSetting('contact_phone', '+91 00000 00000');
    assert.equal(db.getSettings().contact_phone, '+91 91111 22222');
    assert.deepEqual(db.envLockedSettings(), ['contact_phone']);
  });
  test('defaults and saved values', () => {
    assert.equal(db.getSetting('multi_reply_style'), 'combined');
    db.setSetting('cooldown_minutes', 7);
    assert.equal(db.getSettings().cooldown_minutes, 7);
  });
  test('data folder is private to the owner', { skip: process.platform === 'win32' }, () => {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });
});

describe('chemicals', () => {
  test('seeded catalogue', () => {
    assert.ok(db.listChemicals().some(c => c.name === 'Phthalic Anhydride'));
  });
  test('create cleans input: aliases, numbers, empty origin rows', () => {
    const c = db.createChemical({ name: '  Toluene ', aliases: 'tol, , toluene ,', price: '88.5', origin_rates: [{ country: 'Korea', rate: '87' }, { country: '', rate: '' }] });
    assert.equal(c.name, 'Toluene');
    assert.deepEqual(c.alias_list, ['tol', 'toluene']);
    assert.equal(c.price, 88.5);
    assert.deepEqual(c.origin_rates, [{ country: 'Korea', brand: '', rate: 87 }]);
    db.deleteChemical(c.id);
    assert.equal(db.getChemical(c.id), undefined);
  });
});

describe('templates', () => {
  test('all template modes have defaults, save and reset', () => {
    const t = db.getTemplates();
    assert.deepEqual(Object.keys(t), ['quote', 'deal', 'multi', 'multi_item', 'reminder']);
    db.saveTemplate('multi_item', 'X {n}');
    assert.equal(db.getTemplates().multi_item, 'X {n}');
    db.resetTemplate('multi_item');
    assert.equal(db.getTemplates().multi_item, t.multi_item);
  });
});

describe('orders (inquiries)', () => {
  const base = { group_jid: '111@g.us', group_name: 'G', sender_name: 'Rakesh', message: 'Need PA 2 MT, DOP 1 tanker', intent: 'quote' };
  let id;
  test('create with history; multi-product rows share a batch', () => {
    id = db.createInquiry({ ...base, chemical_name: 'Phthalic Anhydride', status: 'Quoted', batch_key: 'M1', batch_size: 2, history_text: 'Auto-quote sent (Multi-Product, 1 products)' });
    db.createInquiry({ ...base, requested_text: 'DOP', status: 'Unmatched', intent: 'unmatched', batch_key: 'M1', batch_size: 2 });
    const rows = db.listInquiries({ status: 'all', batch: 'M1' });
    assert.equal(rows.length, 2);
    assert.equal(db.getInquiry(id).history[0].text, 'Auto-quote sent (Multi-Product, 1 products)');
    assert.equal(rows.find(r => !r.chemical_name).requested_text, 'DOP');
  });
  test('owner decision is recorded in the history', () => {
    const r = db.updateInquiry(id, { status: 'Confirmed', final_rate: '₹106/kg', owner_notes: '30 days' });
    assert.equal(r.status, 'Confirmed');
    assert.match(r.history.at(-1).text, /Status → Confirmed · Final rate: ₹106\/kg · Notes updated/);
    assert.equal(r.history.at(-1).by, 'owner');
  });
  test('filters: open / search / limit; hostile input is harmless', () => {
    assert.ok(db.listInquiries({ status: 'open' }).every(r => ['New', 'Quoted', 'Negotiating', 'Awaiting Owner', 'On Hold'].includes(r.status)));
    assert.equal(db.listInquiries({ status: 'all', q: 'Phthalic' }).length, 1);
    assert.equal(db.listInquiries({ status: 'all', q: 'DOP' }).length, 2, 'search also looks in the message text');
    assert.equal(db.listInquiries({ status: 'all', q: "' OR 1=1 --" }).length, 0);
    assert.equal(db.listInquiries({ status: 'all', limit: 1 }).length, 1);
    assert.doesNotThrow(() => db.listInquiries({ status: 'all', limit: '-1; DROP TABLE inquiries' }));
    assert.ok(db.listInquiries({ status: 'all' }).length >= 2, 'table still there');
  });
  test('stats', () => {
    const s = db.inquiryStats();
    assert.equal(s.unmatched, 1);
    assert.equal(s.confirmed, 1);
  });
});
