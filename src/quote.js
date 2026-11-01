// Turns a chemical + parsed message into template variables, and renders a template.

const inr = n => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function shortCode(chem, usedAlias) {
  const aliases = (chem.alias_list || []).map(a => a.replace(/\./g, '').trim()).filter(Boolean);
  const used = usedAlias && usedAlias.replace(/ /g, '');
  if (used && used.length <= 4) return used.toUpperCase();
  const short = aliases.filter(a => a.length <= 4 && !a.includes(' ')).sort((a, b) => a.length - b.length)[0];
  return short ? short.toUpperCase() : '';
}

export function rateDetails(chem, { origins = [], brands = [] } = {}) {
  const unit = chem.unit || 'kg';
  const gst = chem.gst ?? 18;
  const gstNote = gst ? `_(+ ${gst}% GST)_` : '';
  let rates = chem.origin_rates || [];
  let note = '';

  if (rates.length && (origins.length || brands.length)) {
    const want = rates.filter(r =>
      origins.some(o => r.country.toLowerCase() === o.toLowerCase()) ||
      brands.some(b => (r.brand || '').toLowerCase().includes(b.toLowerCase())));
    if (want.length) rates = want;
    else if (origins.length) note = `_${origins.join(' / ')} origin not available right now — current options below._`;
  }

  if (!rates.length) {
    if (chem.price == null) return `💰 *Rate:* On request`;
    const brand = chem.manufacturer ? ` (${chem.manufacturer})` : '';
    return `💰 *Rate${brand}:* ${inr(chem.price)} / ${unit} ${gstNote}`.trim();
  }

  const lines = rates.map(r => `  • ${r.country}${r.brand ? ` (${r.brand})` : ''}: ${inr(r.rate)} / ${unit}`);
  if (chem.price != null && rates === chem.origin_rates) {
    lines.unshift(`  • ${chem.manufacturer || 'Standard'}: ${inr(chem.price)} / ${unit}`);
  }
  if (lines.length === 1) {
    const r = rates[0];
    return [note, `💰 *Rate – ${r.country}${r.brand ? ` (${r.brand})` : ''}:* ${inr(r.rate)} / ${unit} ${gstNote}`.trim()].filter(Boolean).join('\n');
  }
  return [note, '💰 *Rates by Origin / Mfr:*', ...lines, gstNote ? `  ${gstNote}` : ''].filter(Boolean).join('\n');
}

/** One-line rate for compact lists: "Korea ₹110.00 · China ₹138.00 /kg". */
export function rateShort(chem, { origins = [], brands = [] } = {}) {
  const unit = chem.unit || 'kg';
  let rates = chem.origin_rates || [];
  if (rates.length && (origins.length || brands.length)) {
    const want = rates.filter(r => origins.some(o => r.country.toLowerCase() === o.toLowerCase()) ||
      brands.some(b => (r.brand || '').toLowerCase().includes(b.toLowerCase())));
    if (want.length) rates = want;
  }
  if (!rates.length) return chem.price != null ? `${inr(chem.price)} /${unit}` : 'On request';
  const parts = rates.map(r => `${r.country}${r.brand ? ` (${r.brand})` : ''} ${inr(r.rate)}`);
  if (chem.price != null && rates === chem.origin_rates) parts.unshift(`${chem.manufacturer || 'Standard'} ${inr(chem.price)}`);
  return `${parts.join(' · ')} /${unit}`;
}

export function buildVars(chem, analysis = {}, settings = {}, extra = {}) {
  const code = shortCode(chem, analysis.alias);
  const qty = analysis.quantity;
  const loc = analysis.location;
  const now = new Date();
  return {
    product_name: code && code.toLowerCase() !== chem.name.toLowerCase() ? `${chem.name} (${code})` : chem.name,
    rate_details: rateDetails(chem, analysis),
    rate_short: rateShort(chem, analysis),
    quantity: qty ? qty.text : '',
    n: extra.n != null ? String(extra.n) : '',
    packaging: chem.packaging || '',
    location: chem.location || settings.default_location || '',
    status: chem.status || '',
    requirement: qty ? `📝 *Requirement:* ${qty.text}${loc ? ` – ${loc}` : ''}` : '',
    contact_phone: settings.contact_phone || '',
    business_name: settings.business_name || '',
    brand: chem.manufacturer || [...new Set((chem.origin_rates || []).map(r => r.brand).filter(Boolean))].join(', '),
    customer_location: loc || '',
    sender_name: extra.sender_name || 'Sir/Madam',
    price: chem.price != null ? inr(chem.price) : '',
    unit: chem.unit || 'kg',
    gst: String(chem.gst ?? ''),
    date: now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
  };
}

/** Replace {vars}. A line that contains a variable resolving to empty is dropped (e.g. {requirement} with no qty). */
export function render(template, vars) {
  const out = [];
  for (const line of String(template || '').split('\n')) {
    let drop = false;
    const replaced = line.replace(/\{([a-z_]+)\}/g, (m, key) => {
      if (!(key in vars)) return m;
      const v = vars[key];
      if (v === '' || v === null || v === undefined) { drop = true; return ''; }
      return String(v);
    });
    if (!drop) out.push(replaced);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The rate actually quoted, as a short string for the orders table. */
export function quotedRateSummary(chem, analysis) {
  const d = rateDetails(chem, analysis).replace(/[*_💰]/g, '').replace(/\s+/g, ' ').trim();
  // "Rate – Korea (Aekyung): ₹110" → "Korea (Aekyung): ₹110" · "Rate (IGPL): ₹199" → "IGPL: ₹199" · "Rate: ₹102" → "₹102"
  return d.replace(/^Rates? by Origin \/ Mfr: ?/, '')
    .replace(/^Rate – /, '')
    .replace(/^Rate \(([^)]*)\): /, '$1: ')
    .replace(/^Rate: /, '')
    .slice(0, 160);
}
