// Building the quotation text: variables, rates by origin, hidden empty lines, templates and presets.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildVars, render, rateDetails, rateShort, quotedRateSummary } from '../src/quote.js';
import { DEFAULT_TEMPLATES, PRESETS } from '../src/presets.js';
import { CHEMS } from './helpers.js';

const [PA, AA, MA, MSG, IPA] = CHEMS;
const settings = { business_name: 'Test Traders', contact_phone: '+91 90000 00000', default_location: 'Bhiwandi' };

describe('render()', () => {
  test('replaces variables', () => {
    assert.equal(render('Hi {name}', { name: 'Ravi' }), 'Hi Ravi');
  });
  test('drops a line whose variable is empty', () => {
    assert.equal(render('A\nQty: {q}\nB', { q: '' }), 'A\nB');
  });
  test('leaves unknown {words} alone', () => {
    assert.equal(render('Use {unknown}', {}), 'Use {unknown}');
  });
  test('collapses extra blank lines', () => {
    assert.equal(render('A\n\n\n\nB', {}), 'A\n\nB');
  });
});

describe('rates', () => {
  test('single price with brand and GST', () => {
    assert.equal(rateDetails(IPA), '💰 *Rate:* ₹102.00 / kg _(+ 18% GST)_');
    assert.match(rateDetails(MSG), /MEIHUA.*₹120\.00 \/ kg.*5% GST/);
  });
  test('all origins listed when none asked', () => {
    const d = rateDetails(PA);
    assert.match(d, /Rates by Origin/);
    for (const c of ['India', 'Russia', 'Korea']) assert.match(d, new RegExp(c));
  });
  test('only the asked origin is quoted', () => {
    const d = rateDetails(PA, { origins: ['Korea'] });
    assert.match(d, /Korea \(Aekyung\).*₹110\.00/);
    assert.doesNotMatch(d, /Russia|India/);
  });
  test('asked origin not available → note + all options', () => {
    const d = rateDetails(PA, { origins: ['China'] });
    assert.match(d, /China origin not available/);
    assert.match(d, /Korea/);
  });
  test('brand filter', () => {
    assert.match(rateDetails(MA, { brands: ['Boiko'] }), /Boiko.*₹168\.00/);
  });
  test('no price at all → "On request"', () => {
    assert.match(rateDetails({ name: 'X', unit: 'kg', origin_rates: [], price: null }), /On request/);
  });
  test('rate_short is one line', () => {
    assert.equal(rateShort(IPA), '₹102.00 /kg');
    assert.equal(rateShort(PA, { origins: ['Korea'] }), 'Korea (Aekyung) ₹110.00 /kg');
    assert.ok(!rateShort(PA).includes('\n'));
  });
  test('quoted rate summary for the orders table', () => {
    assert.match(quotedRateSummary(PA, { origins: ['Korea'] }), /Korea.*110/);
    assert.match(quotedRateSummary(MSG), /^MEIHUA: ₹120\.00/);
    assert.match(quotedRateSummary(IPA), /^₹102\.00/);
    assert.match(quotedRateSummary(PA), /^• India/);
  });
});

describe('buildVars()', () => {
  test('product name gets its short code', () => {
    assert.equal(buildVars(PA, { alias: 'pa' }, settings).product_name, 'Phthalic Anhydride (PA)');
  });
  test('requirement line only when a quantity was asked', () => {
    assert.equal(buildVars(PA, { quantity: { text: '2 MT' }, location: 'Vapi' }, settings).requirement, '📝 *Requirement:* 2 MT – Vapi');
    assert.equal(buildVars(PA, {}, settings).requirement, '');
  });
  test('falls back to the default location', () => {
    assert.equal(buildVars({ ...AA, location: '' }, {}, settings).location, 'Bhiwandi');
  });
  test('product number for multi-product blocks', () => {
    assert.equal(buildVars(PA, {}, settings, { n: 2 }).n, '2');
  });
});

describe('default templates and presets render cleanly', () => {
  const vars = buildVars(PA, { alias: 'pa', quantity: { text: '2 MT' } }, settings);
  for (const mode of ['quote', 'deal']) {
    test(`${mode} default`, () => {
      const out = render(DEFAULT_TEMPLATES[mode], vars);
      assert.doesNotMatch(out, /\{[a-z_]+\}/, 'no unfilled variables');
      assert.match(out, /Phthalic Anhydride \(PA\)/);
      assert.match(out, /\+91 90000 00000/);
    });
    for (const p of PRESETS[mode]) test(`${mode} preset "${p.label}"`, () => {
      assert.doesNotMatch(render(p.body, { ...vars, sender_name: 'Ravi' }), /\{[a-z_]+\}/);
    });
  }
  test('no contact number set → phone line removed', () => {
    const out = render(DEFAULT_TEMPLATES.quote, buildVars(PA, {}, { ...settings, contact_phone: '' }));
    assert.doesNotMatch(out, /📞/);
  });
  test('multi presets all contain {items}', () => {
    for (const p of PRESETS.multi) { assert.match(p.body, /\{items\}/); assert.ok(p.item); }
  });
});
