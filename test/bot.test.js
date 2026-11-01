// Reply planning against the real database: single vs combined replies, settings, template overrides.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv } from './helpers.js';

setupEnv({ CONTACT_PHONE: '+91 90000 00000' });
const db = await import('../src/db.js');
const { planReplies, invalidateCatalogue, describe: describeAnalysis } = await import('../src/bot.js');
db.ensureSecrets();
db.seedIfEmpty();   // Phthalic Anhydride, Acrylic Acid, Maleic Anhydride, MSG, Caustic Soda Flakes, IPA

const set = (k, v) => { db.setSetting(k, v); invalidateCatalogue(); };
const LIST = 'Need rates:\n1. PA korea 2 MT\n2. MA china 5 MT\n3. IPA 20 drums\n4. DOP 1 tanker';

describe('single product', () => {
  test('one Price Quotation message', async () => {
    const p = await planReplies('PA 2 MT rate chahiye');
    assert.equal(p.replies.length, 1);
    assert.equal(p.replies[0].kind, 'single');
    assert.equal(p.replies[0].intent, 'quote');
    assert.match(p.replies[0].text, /Phthalic Anhydride \(PA\)/);
    assert.match(p.replies[0].text, /Requirement:\* 2 MT/);
    assert.match(p.replies[0].text, /\+91 90000 00000/, 'phone comes from CONTACT_PHONE');
  });
  test('negotiation → Deal template', async () => {
    const p = await planReplies('PA last rate kya hai? 10 MT');
    assert.equal(p.replies[0].intent, 'deal');
    assert.match(p.replies[0].text, /🤝/);
  });
  test('not an enquiry → no replies', async () => {
    assert.equal((await planReplies('Good morning 🙏')).replies.length, 0);
  });
});

describe('multi-product', () => {
  test('one combined message with per-product details and the unknown item', async () => {
    const p = await planReplies(LIST);
    assert.equal(p.replies.length, 1);
    const r = p.replies[0];
    assert.equal(r.kind, 'multi');
    assert.deepEqual(r.items.map(i => i.chem.name), ['Phthalic Anhydride', 'Maleic Anhydride', 'Isopropyl Alcohol']);
    assert.match(r.text, /Quotation for 3 products/);
    assert.match(r.text, /1\. Phthalic Anhydride[\s\S]*Korea \(Aekyung\)/);
    assert.doesNotMatch(r.text.split('2. Maleic')[0], /Russia/, 'PA quoted for Korea only');
    assert.match(r.text, /Will check & revert:\* DOP \(1 TANKER\)/);
    assert.deepEqual(p.unavailable.map(u => u.name), ['DOP']);
  });
  test('one known product + one unknown still uses the combined message', async () => {
    const p = await planReplies('Need PA 2 MT, DOP 1 tanker');
    assert.equal(p.replies[0].kind, 'multi');
    assert.match(p.replies[0].text, /DOP/);
  });
  test('deal note only when negotiating', async () => {
    assert.match((await planReplies('PA, MA last rate kya hai? 10 MT each')).replies[0].text, /our team will call you/);
    assert.doesNotMatch((await planReplies('PA, MA rate? 10 MT each')).replies[0].text, /our team will call you/);
  });
  test('"separate" setting sends one message per product', async () => {
    set('multi_reply_style', 'separate');
    const p = await planReplies('Need AA 10 MT and IPA 5 drums');
    assert.deepEqual(p.replies.map(r => r.kind), ['single', 'single']);
    set('multi_reply_style', 'combined');
  });
  test('max products per message', async () => {
    set('max_products_per_message', 2);
    const p = await planReplies('Need PA 1 MT, MA 2 MT, IPA 3 drums');
    assert.equal(p.replies[0].items.length, 2);
    set('max_products_per_message', 10);
  });
  test('out-of-stock products are listed as unavailable, not quoted', async () => {
    const ipa = db.listChemicals().find(c => c.name === 'Isopropyl Alcohol');
    db.updateChemical(ipa.id, { ...ipa, status: 'Out of Stock' }); invalidateCatalogue();
    set('quote_out_of_stock', false);
    const p = await planReplies('Need PA 2 MT, IPA 20 drums');
    assert.deepEqual(p.replies[0].items.map(i => i.chem.name), ['Phthalic Anhydride']);
    assert.match(p.replies[0].text, /Isopropyl Alcohol \(20 DRUMS\) – currently out of stock/);
    set('quote_out_of_stock', true);
    db.updateChemical(ipa.id, { ...ipa, status: 'In Stock' }); invalidateCatalogue();
  });
  test('a paused chemical is never quoted', async () => {
    const ma = db.listChemicals().find(c => c.name === 'Maleic Anhydride');
    db.updateChemical(ma.id, { ...ma, active: false }); invalidateCatalogue();
    assert.equal((await planReplies('MA 2 MT rate')).replies.length, 0);
    db.updateChemical(ma.id, { ...ma, active: true }); invalidateCatalogue();
  });
});

describe('unmatched requests', () => {
  test('no reply by default', async () => {
    const p = await planReplies('Need DOP 5 drums rate pls');
    assert.equal(p.replies.length, 0);
    assert.equal(p.unmatchedReply, null);
  });
  test('optional polite reply when switched on', async () => {
    set('reply_unmatched', true);
    const p = await planReplies('Need DOP 5 drums rate pls');
    assert.match(p.unmatchedReply, /get back to you.*\+91 90000 00000/);
    set('reply_unmatched', false);
  });
});

describe('dashboard preview (overrides / forceMode)', () => {
  test('unsaved template text is used for the preview', async () => {
    const p = await planReplies('PA 2 MT rate', { overrides: { quote: 'CUSTOM {product_name}' } });
    assert.equal(p.replies[0].text, 'CUSTOM Phthalic Anhydride (PA)');
  });
  test('forceMode shows the Multi-Product layout even for one product', async () => {
    const p = await planReplies('PA 2 MT rate', { forceMode: 'multi' });
    assert.equal(p.replies[0].kind, 'multi');
  });
  test('describe() is JSON-safe and includes per-product details', async () => {
    const d = describeAnalysis((await planReplies(LIST)).analysis);
    assert.doesNotThrow(() => JSON.stringify(d));
    assert.equal(d.chemicals[0].origins[0], 'Korea');
    assert.equal(d.unmatchedItems[0].name, 'DOP');
  });
});
