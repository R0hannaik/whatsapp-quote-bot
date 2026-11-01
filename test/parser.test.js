// Run: npm test  — checks the message parser against real-world style group messages.
import assert from 'node:assert/strict';
import { analyze, buildIndex } from '../src/parser.js';
import { buildVars, render } from '../src/quote.js';
import { DEFAULT_TEMPLATES } from '../src/presets.js';

const chems = [
  { id: 1, name: 'Phthalic Anhydride', alias_list: ['pa', 'p.a.', 'phthalic', 'phthalic anhydride', 'pthalic anhydride'], unit: 'kg', gst: 18, manufacturer: 'IGPL', packaging: '25 kgs Bag', location: 'Bhiwandi / Mumbai Ex-Godown', status: 'In Stock',
    origin_rates: [{ country: 'India', brand: 'Reliance / IGPL', rate: 108.5 }, { country: 'Russia', brand: 'Imported', rate: 105 }, { country: 'Korea', brand: 'Aekyung', rate: 110 }], price: null },
  { id: 2, name: 'Acrylic Acid', alias_list: ['aa', 'a.a.', 'acrylic', 'acrylic acid'], unit: 'kg', gst: 18, packaging: '200 kg Drum', status: 'In Stock', origin_rates: [{ country: 'China', brand: '', rate: 138 }], price: null },
  { id: 3, name: 'Maleic Anhydride', alias_list: ['ma', 'm.a', 'maleic', 'maleic anhydride', 'malic'], unit: 'kg', gst: 18, manufacturer: 'Tengda', packaging: '25 kg Bag', status: 'In Stock', origin_rates: [{ country: 'China', brand: 'Tengda', rate: 165 }, { country: 'China', brand: 'Boiko', rate: 168 }], price: null },
  { id: 4, name: 'Monosodium Glutamate', alias_list: ['msg', 'm.s.g.'], unit: 'kg', gst: 5, manufacturer: 'MEIHUA', packaging: '25 kgs Bag', status: 'Limited', origin_rates: [], price: 120 },
  { id: 5, name: 'Isopropyl Alcohol', alias_list: ['ipa', 'isopropyl alcohol', 'isopropanol'], unit: 'kg', gst: 18, packaging: '160 kg Drum', status: 'In Stock', origin_rates: [], price: 102 },
];
const index = buildIndex(chems);
const opts = { index, maxLength: 450, ignoreKeywords: 'selling, for sale, we offer, offering, avl with us, available with us' };
const A = t => analyze(t, chems, opts);
const names = r => r.items.map(i => i.chem.name);

const cases = [
  ['PA 2 ton Bhiwandi rate urgent chahiye', true, ['Phthalic Anhydride'], r => { assert.equal(r.quantity.text, '2 TON'); assert.equal(r.location, 'Bhiwandi'); }],
  ['Need p.a. 5mt', true, ['Phthalic Anhydride'], r => assert.equal(r.quantity.text, '5 MT')],
  ['pthalic anhydrite rate pls', true, ['Phthalic Anhydride']],
  ['Required MA china 10 MT Vapi', true, ['Maleic Anhydride'], r => { assert.deepEqual(r.origins, ['China']); assert.equal(r.location, 'Vapi'); }],
  ['MSG available?', true, ['Monosodium Glutamate']],
  ['kisi ke paas IPA hai kya? 20 drums', true, ['Isopropyl Alcohol'], r => assert.equal(r.quantity.text, '20 DRUMS')],
  ['AA and PA rate?', true, ['Acrylic Acid', 'Phthalic Anhydride']],
  ['PA last rate kya hai? 10 ton', true, ['Phthalic Anhydride'], r => assert.equal(r.intent, 'deal')],
  ['Korea PA rate', true, ['Phthalic Anhydride'], r => assert.deepEqual(r.origins, ['Korea'])],
  ['maleicanhydride chahiye', true, ['Maleic Anhydride']],
  // should NOT trigger
  ['PA Korea available with us @ 104/kg Bhiwandi', false],
  ['Selling MA china 160 ex Taloja', false],
  ['Good morning all 🙏', false],
  ['aa jao sab log party hai', false],
  ['Happy Diwali to all members', false],
];

let pass = 0;
for (const [msg, want, wantNames, extra] of cases) {
  const r = A(msg);
  const ok = r.isRequest === want && (!want || !r.items.length === !wantNames?.length);
  try {
    assert.equal(r.isRequest && r.items.length > 0, want, `${msg} -> isRequest=${r.isRequest} items=${names(r)} skip=${r.skipReason}`);
    if (wantNames) assert.deepEqual(names(r), wantNames, msg);
    if (extra) extra(r);
    pass++;
  } catch (e) { console.error('FAIL:', e.message); process.exitCode = 1; }
}
console.log(`${pass}/${cases.length} parser cases passed`);

// rendering
const r = A('PA 2 ton Bhiwandi rate urgent chahiye');
const vars = buildVars(r.items[0].chem, { ...r, alias: r.items[0].alias }, { business_name: 'Pawan Chemicals', contact_phone: '+91 90000 00000' });
const out = render(DEFAULT_TEMPLATES.quote, vars);
console.log('\n' + out + '\n');
assert.match(out, /Requirement:\* 2 TON – Bhiwandi/);
assert.match(out, /Phthalic Anhydride \(PA\)/);
const noQty = render(DEFAULT_TEMPLATES.quote, buildVars(chems[3], {}, {}));
assert.doesNotMatch(noQty, /Requirement/);
const korea = render('{rate_details}', buildVars(chems[0], A('Korea PA rate'), {}));
assert.match(korea, /Korea \(Aekyung\): ?|Rate – Korea/);
console.log('render checks passed');

// per-chemical quantities
const multi = A('Need ipa 20 drums and MSG 1 ton');
assert.deepEqual(multi.items.map(i => `${i.chem.name}:${i.quantity?.text}`), ['Isopropyl Alcohol:20 DRUMS', 'Monosodium Glutamate:1 TON']);
const shared = A('PA and MA rate 5 MT');
assert.deepEqual(shared.items.map(i => i.quantity?.text), ['5 MT', '5 MT']);  // one qty for the whole message is shared
console.log('per-item quantity checks passed:', shared.items.map(i => `${i.chem.name}:${i.quantity?.text}`));
