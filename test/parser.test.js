// Message understanding: is it an enquiry, which chemicals, quantities, origins, places, negotiation, lists.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, buildIndex, normalize } from '../src/parser.js';
import { CHEMS } from './helpers.js';

const index = buildIndex(CHEMS);
const opts = { index, maxLength: 450, ignoreKeywords: 'selling, for sale, we offer, offering, avl with us, available with us' };
const A = t => analyze(t, CHEMS, opts);
const names = r => r.items.map(i => i.chem.name);

describe('recognises buy enquiries', () => {
  const cases = [
    ['PA 2 ton Bhiwandi rate urgent chahiye', ['Phthalic Anhydride']],
    ['Need p.a. 5mt', ['Phthalic Anhydride']],
    ['pthalic anhydrite rate pls', ['Phthalic Anhydride']],                 // typo
    ['Required MA china 10 MT Vapi', ['Maleic Anhydride']],
    ['MSG available?', ['Monosodium Glutamate']],
    ['kisi ke paas IPA hai kya? 20 drums', ['Isopropyl Alcohol']],           // Hinglish
    ['AA and PA rate?', ['Acrylic Acid', 'Phthalic Anhydride']],
    ['maleicanhydride chahiye', ['Maleic Anhydride']],                      // joined words
    ['Korea PA rate', ['Phthalic Anhydride']],
  ];
  for (const [msg, want] of cases) test(msg, () => {
    const r = A(msg);
    assert.equal(r.isRequest, true, r.skipReason);
    assert.deepEqual(names(r), want);
  });
});

describe('stays silent on non-enquiries', () => {
  const cases = [
    ['PA Korea available with us @ 104/kg Bhiwandi', /seller|price/],
    ['Selling MA china 160 ex Taloja', /seller|price/],
    ['Good morning all 🙏', /request|empty/],
    ['aa jao sab log party hai', /request/],                               // "aa" is Hindi here, not Acrylic Acid
    ['Happy Diwali to all members', /request/],
    ['pa', /request/],
  ];
  for (const [msg, reason] of cases) test(msg, () => {
    const r = A(msg);
    assert.ok(!(r.isRequest && r.items.length), `should not reply: ${JSON.stringify(names(r))}`);
    if (!r.isRequest) assert.match(r.skipReason, reason);
  });
  test('very long messages (price lists) are skipped', () => {
    assert.match(A('PA rate need '.repeat(60)).skipReason, /too long/);
  });
  test('hard cap of 2000 characters even if the setting is 0', () => {
    assert.match(analyze('x '.repeat(1100), CHEMS, { index, maxLength: 0 }).skipReason, /too long/);
  });
});

describe('details', () => {
  test('quantity, unit and place', () => {
    const r = A('PA 2 ton Bhiwandi rate urgent chahiye');
    assert.equal(r.quantity.text, '2 TON');
    assert.equal(r.location, 'Bhiwandi');
  });
  test('units', () => {
    assert.equal(A('Need p.a. 5mt').quantity.text, '5 MT');
    assert.equal(A('IPA 20 drums need').quantity.text, '20 DRUMS');
    assert.equal(A('PA 12.5 MT need').quantity.text, '12.5 MT');
  });
  test('thousands separators vs decimal comma', () => {
    assert.equal(A('maleic 1,000 kg need').quantity.text, '1000 KG');
    assert.equal(A('PA 1,00,000 kg need').quantity.text, '100000 KG');
    assert.equal(A('PA 2,5 MT need').quantity.text, '2.5 MT');
  });
  test('origin and brand', () => {
    assert.deepEqual(A('Required MA china 10 MT Vapi').origins, ['China']);
    assert.deepEqual(A('IGPL PA 2 mt rate?').items[0].brands, ['IGPL']);
  });
  test('negotiation words switch to the Deal template', () => {
    assert.equal(A('PA last rate kya hai? 10 ton').intent, 'deal');
    assert.equal(A('PA rate kya hai? 10 ton').intent, 'quote');
    assert.equal(analyze('PA rate pls, workable?', CHEMS, { index, dealKeywords: 'workable' }).intent, 'deal');
  });
  test('normalize strips dots inside codes', () => {
    assert.equal(normalize('P.A. / M.S.G!'), 'pa msg');
  });
  test('an enquiry for something not in the list is flagged for the owner', () => {
    const r = A('Need DOP 5 drums rate pls');
    assert.equal(r.isRequest, true);
    assert.equal(r.items.length, 0);
    assert.equal(r.unmatchedWorthy, true);
  });
});

describe('multi-product lists', () => {
  const L = msg => A(msg).items.map(i => `${i.chem.name}|${i.quantity?.text || '-'}|${(i.origins || []).join('/') || '-'}`);
  test('numbered list: own quantity and origin per product', () => {
    assert.deepEqual(L('Need rates:\n1. PA korea 2 MT\n2. MA china 5 MT\n3. IPA 20 drums'),
      ['Phthalic Anhydride|2 MT|Korea', 'Maleic Anhydride|5 MT|China', 'Isopropyl Alcohol|20 DRUMS|-']);
  });
  test('comma / & list: an origin only applies to its own product', () => {
    assert.deepEqual(L('PA 2 MT, AA china 10 MT & IPA 5 drums rate pls'),
      ['Phthalic Anhydride|2 MT|-', 'Acrylic Acid|10 MT|China', 'Isopropyl Alcohol|5 DRUMS|-']);
  });
  test('"each" shares one quantity', () => {
    assert.deepEqual(L('Rates for PA, MA, IPA - 5 MT each'), ['Phthalic Anhydride|5 MT|-', 'Maleic Anhydride|5 MT|-', 'Isopropyl Alcohol|5 MT|-']);
  });
  test('a quantity after all products is shared', () => {
    assert.deepEqual(L('PA and MA rate 5 MT'), ['Phthalic Anhydride|5 MT|-', 'Maleic Anhydride|5 MT|-']);
  });
  test("a product doesn't borrow another product's quantity", () => {
    assert.deepEqual(L('PA 2 MT, MA rate pls'), ['Phthalic Anhydride|2 MT|-', 'Maleic Anhydride|-|-']);
  });
  test('two products, two quantities, joined by "and"', () => {
    assert.deepEqual(L('Need ipa 20 drums and MSG 1 ton'), ['Isopropyl Alcohol|20 DRUMS|-', 'Monosodium Glutamate|1 TON|-']);
  });
  test('origin line for the whole list', () => {
    assert.deepEqual(L('Required, all china origin:\nAA 10 MT\nMA 5 MT'), ['Acrylic Acid|10 MT|China', 'Maleic Anhydride|5 MT|China']);
  });
  test('list lines with products not in the matrix are picked out', () => {
    const r = A('Need:\n- PA 3 MT\n- DOP 1 tanker\n- Toluene 5 MT');
    assert.deepEqual(r.unmatchedItems.map(u => `${u.name}|${u.quantity.text}`), ['DOP|1 TANKER', 'Toluene|5 MT']);
  });
  test('header lines without an amount are not treated as products', () => {
    assert.deepEqual(A('Please share best rates\nPA 2 MT\nMA 5 MT').unmatchedItems, []);
  });
});
