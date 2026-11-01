// Understands a WhatsApp group message: is it a buy enquiry? which chemical(s), how much, where, which origin,
// and is the person negotiating? Pure functions — no WhatsApp or DB access — so it is easy to test.

/* ---------- vocabulary ---------- */
const STRONG_REQUEST = [
  'need', 'needed', 'needs', 'require', 'required', 'requirement', 'req', 'reqd', 'rqd', 'reqt', 'chahiye', 'chaiye', 'chahie', 'chahye',
  'chaye', 'chahiyee', 'mangta', 'lena', 'leni', 'lene', 'want', 'wanted', 'buy', 'buyer', 'purchase', 'enquiry', 'inquiry', 'enq', 'inq',
  'rate', 'rates', 'price', 'prices', 'pricing', 'quote', 'quotation', 'bhav', 'bhaav', 'daam', 'kitna', 'kitne', 'kya', 'anyone', 'urgent',
  'urgently', 'looking', 'availability', 'pls', 'please', 'plz', 'share', 'send', 'best', 'offer',
];
const WEAK_REQUEST = ['available', 'avl', 'avail', 'stock', 'hai', 'milega', 'milegi', 'paas', 'pass', 'kisi', 'kiske', 'who', 'has'];
const DEAL_DEFAULT = ['last', 'final', 'lowest', 'negotiable', 'nego', 'discount', 'kam', 'kum', 'reduce', 'target', 'counter', 'workable', 'best price', 'best rate', 'bulk rate'];

const UNIT_MAP = {
  mt: 'MT', mts: 'MT', 'm.t': 'MT', 'm.t.': 'MT', ton: 'TON', tons: 'TON', tonne: 'TON', tonnes: 'TON', tn: 'TON', tonn: 'TON', t: 'TON',
  kg: 'KG', kgs: 'KG', kilo: 'KG', kilos: 'KG', bag: 'BAG', bags: 'BAGS', drum: 'DRUM', drums: 'DRUMS', ltr: 'LTR', ltrs: 'LTR', litre: 'LTR',
  litres: 'LTR', liter: 'LTR', liters: 'LTR', ibc: 'IBC', ibcs: 'IBC', tanker: 'TANKER', tankers: 'TANKERS', fcl: 'FCL', container: 'CONTAINER',
  containers: 'CONTAINERS', truck: 'TRUCK', trucks: 'TRUCKS', load: 'LOAD', loads: 'LOADS', gaadi: 'TRUCK', gadi: 'TRUCK', pallet: 'PALLET',
  pallets: 'PALLETS', carboy: 'CARBOY', carboys: 'CARBOYS', jumbo: 'JUMBO BAG', jumbos: 'JUMBO BAGS', pcs: 'PCS',
};
const QTY_RE = /(\d{1,3}(?:,\d{2,3})+(?![\d.])|\d+(?:[.,]\d+)?)\s*(m\.t\.?|mts?|tonnes?|tons?|tonn|tn|kgs?|kilos?|bags?|drums?|ltrs?|litres?|liters?|ibcs?|tankers?|fcl|containers?|trucks?|loads?|gaadi|gadi|pallets?|carboys?|jumbos?|pcs)(?![a-z])/i;
const QTY_T_RE = /(\d+(?:\.\d+)?)t(?![a-z])/i;

export const ORIGINS = {
  china: 'China', chinese: 'China', chaina: 'China', russia: 'Russia', russian: 'Russia', korea: 'Korea', korean: 'Korea', indonesia: 'Indonesia',
  indonesian: 'Indonesia', indo: 'Indonesia', japan: 'Japan', japanese: 'Japan', saudi: 'Saudi', ksa: 'Saudi', thailand: 'Thailand', thai: 'Thailand',
  taiwan: 'Taiwan', taiwanese: 'Taiwan', spain: 'Spain', usa: 'USA', america: 'USA', american: 'USA', iran: 'Iran', iranian: 'Iran',
  india: 'India', indian: 'India', local: 'India', domestic: 'India', desi: 'India', imported: 'Imported', import: 'Imported', europe: 'Europe',
  european: 'Europe', germany: 'Germany', german: 'Germany', malaysia: 'Malaysia', singapore: 'Singapore', uae: 'UAE', dubai: 'UAE', qatar: 'Qatar',
  kuwait: 'Kuwait', vietnam: 'Vietnam', turkey: 'Turkey', brazil: 'Brazil', belgium: 'Belgium', netherlands: 'Netherlands', israel: 'Israel',
  egypt: 'Egypt', oman: 'Oman', bahrain: 'Bahrain', philippines: 'Philippines',
};

export const LOCATIONS = [
  'Bhiwandi', 'Mumbai', 'Navi Mumbai', 'Thane', 'Taloja', 'Turbhe', 'Rabale', 'Mahape', 'Vashi', 'Panvel', 'Kalyan', 'Dombivli', 'Ambernath',
  'Badlapur', 'Vasai', 'Virar', 'Palghar', 'Boisar', 'Tarapur', 'Dahisar', 'Andheri', 'Goregaon', 'Sakinaka', 'Kurla', 'Mira Road', 'Bhayandar',
  'Vapi', 'Silvassa', 'Daman', 'Sarigam', 'Umbergaon', 'Valsad', 'Navsari', 'Surat', 'Ankleshwar', 'Jhagadia', 'Bharuch', 'Dahej', 'Vadodara',
  'Baroda', 'Ahmedabad', 'Vatva', 'Naroda', 'Sanand', 'Rajkot', 'Morbi', 'Jamnagar', 'Kandla', 'Mundra', 'Gandhidham', 'Pune', 'Chakan',
  'Ranjangaon', 'Kurkumbh', 'Nashik', 'Aurangabad', 'Waluj', 'Nagpur', 'Kolhapur', 'Satara', 'Mahad', 'Roha', 'Lote', 'Ratnagiri', 'Goa',
  'Delhi', 'Noida', 'Ghaziabad', 'Gurgaon', 'Gurugram', 'Faridabad', 'Sonipat', 'Panipat', 'Ludhiana', 'Jalandhar', 'Amritsar', 'Baddi',
  'Kanpur', 'Lucknow', 'Agra', 'Jaipur', 'Bhiwadi', 'Indore', 'Pithampur', 'Dewas', 'Bhopal', 'Raipur', 'Kolkata', 'Howrah', 'Haldia',
  'Chennai', 'Bangalore', 'Bengaluru', 'Hyderabad', 'Secunderabad', 'Vizag', 'Visakhapatnam', 'Coimbatore', 'Kochi', 'Cochin', 'JNPT', 'Nhava Sheva',
];

/* ---------- helpers ---------- */
export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/(\w)\.(?=\w)/g, '$1')      // p.a. -> pa. , m.s.g -> msg
    .replace(/[^a-z0-9ऀ-ॿ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const tokens = s => normalize(s).split(' ').filter(Boolean);

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const splitList = s => (Array.isArray(s) ? s : String(s || '').split(',')).map(x => normalize(x)).filter(Boolean);

/* ---------- index of chemicals ---------- */
export function buildIndex(chemicals) {
  const entries = [];
  for (const c of chemicals) {
    if (c.active === false) continue;
    const names = new Set([c.name, ...(c.alias_list || String(c.aliases || '').split(','))].map(normalize).filter(Boolean));
    for (const n of names) entries.push({ chem: c, alias: n, words: n.split(' '), compact: n.replace(/ /g, '') });
  }
  // longest aliases first so "maleic anhydride" beats "ma"
  entries.sort((a, b) => b.alias.length - a.alias.length);
  return entries;
}

/* ---------- detection ---------- */
function toQty(m) {
  // "1,000" / "1,00,000" are thousands separators; "2,5" is a decimal comma
  const num = /^\d{1,3}(,\d{2,3})+$/.test(m[1]) && /,\d{3}$/.test(m[1]) ? m[1].replace(/,/g, '') : m[1].replace(',', '.');
  const key = (m[2] || 't').toLowerCase();
  const unit = UNIT_MAP[key.replace(/\.$/, '')] || UNIT_MAP[key] || key.toUpperCase();
  return { value: Number(num), unit, text: `${num} ${unit}`, index: m.index, raw: m[0] };
}
function detectQuantities(text) {
  const out = [];
  for (const re of [QTY_RE, QTY_T_RE]) {
    for (const m of text.matchAll(new RegExp(re.source, 'gi'))) {
      if (!out.some(q => m.index >= q.index && m.index < q.index + q.raw.length)) out.push(toQty(m));
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Where an alias appears in the original text (dots/spaces tolerant), or -1. */
function rawIndex(original, alias) {
  if (!alias) return -1;
  const pat = alias.split(' ').map(w => w.split('').map(escapeRe).join('\\.?')).join('[\\s.\\-]*');
  const m = new RegExp(`(^|[^A-Za-z0-9])(${pat})(?![A-Za-z0-9])`, 'i').exec(original);
  return m ? m.index + m[1].length : -1;
}

function detectLocation(norm) {
  for (const loc of [...LOCATIONS].sort((a, b) => b.length - a.length)) {
    if (new RegExp(`(^| )${escapeRe(normalize(loc))}( |$)`).test(norm)) return loc;
  }
  return null;
}

function detectOrigins(toks) {
  const out = new Set();
  for (const t of toks) if (ORIGINS[t]) out.add(ORIGINS[t]);
  return [...out];
}

function hasPhrase(norm, phrase) {
  const p = normalize(phrase);
  return p && new RegExp(`(^| )${escapeRe(p)}( |$)`).test(norm);
}

/** Short aliases like "pa", "aa", "ma" collide with Hindi/English words, so they need extra evidence. */
function shortAliasOk(original, alias, normTokens, idx, hasQty) {
  const letters = alias.replace(/ /g, '');
  const pattern = letters.split('').map(escapeRe).join('\\.?\\s?');
  const re = new RegExp(`(^|[^A-Za-z0-9])(${pattern})\\.?(?![A-Za-z0-9])`, 'gi');
  let m;
  while ((m = re.exec(original))) {
    const raw = m[2];
    if (raw === raw.toUpperCase() && /[A-Z]/.test(raw)) return true;   // "PA", "MSG"
    if (raw.includes('.')) return true;                                 // "p.a."
  }
  // lowercase short code: accept if a request word or quantity sits right next to it
  const near = [normTokens[idx - 1], normTokens[idx + 1], normTokens[idx + 2]].filter(Boolean);
  const reqWords = new Set([...STRONG_REQUEST, ...WEAK_REQUEST]);
  if (near.some(t => reqWords.has(t) || /^\d/.test(t) || UNIT_MAP[t])) return true;
  return hasQty && normTokens.length <= 6;
}

function findChemicals(original, norm, index, hasQty) {
  const toks = norm.split(' ');
  const used = new Array(toks.length).fill(false);
  const hits = [];
  const take = (entry, start, len, how) => {
    for (let k = start; k < start + len; k++) used[k] = true;
    if (!hits.some(h => h.chem.id === entry.chem.id)) hits.push({ chem: entry.chem, alias: entry.alias, pos: start, len, how });
  };

  // 1) exact token-sequence matches (longest alias first)
  for (const e of index) {
    const L = e.words.length;
    for (let i = 0; i + L <= toks.length; i++) {
      if (used.slice(i, i + L).some(Boolean)) continue;
      if (toks.slice(i, i + L).join(' ') !== e.alias) continue;
      if (e.compact.length <= 3 && !shortAliasOk(original, e.alias, toks, i, hasQty)) continue;
      take(e, i, L, 'exact');
    }
  }
  // 2) joined spelling, e.g. "maleicanhydride"
  for (const e of index) {
    if (e.words.length < 2) continue;
    const i = toks.findIndex((t, k) => !used[k] && t === e.compact);
    if (i >= 0) take(e, i, 1, 'joined');
  }
  // 3) typo tolerance for longer names ("pthalic", "malaic anhydrite")
  for (const e of index) {
    if (e.compact.length < 6) continue;
    const L = e.words.length;
    for (let i = 0; i + L <= toks.length; i++) {
      if (used.slice(i, i + L).some(Boolean)) continue;
      const cand = toks.slice(i, i + L).join(' ');
      if (Math.abs(cand.length - e.alias.length) > 2 || /^\d/.test(cand)) continue;
      const maxD = e.alias.length >= 9 ? 2 : 1;
      if (levenshtein(cand, e.alias) <= maxD) { take(e, i, L, 'fuzzy'); break; }
    }
  }
  return hits.sort((a, b) => a.pos - b.pos);
}

/* ---------- list handling: "PA 2 MT, MA china 5 MT & IPA 20 drums" ---------- */

/** Character offset of every normalised token in the original text (same tokenisation as normalize()). */
function tokenOffsets(original) {
  const out = [];
  const re = /[a-z0-9ऀ-ॿ]+(?:\.(?=[a-z0-9])[a-z0-9ऀ-ॿ]+)*/gi;
  let m;
  while ((m = re.exec(original))) out.push(m.index);
  return out;
}

/** Split points between list items: new lines, ; , & + and aur (but not "1,000"). */
function segmentStarts(original) {
  const starts = [0];
  const re = /\n|;|,(?!\d)|\s&\s|\s\+\s|\s(?:and|aur|or|n)\s/gi;
  let m;
  while ((m = re.exec(original))) starts.push(m.index + m[0].length);
  return starts;
}
const segOf = (starts, offset) => { let k = 0; while (k + 1 < starts.length && starts[k + 1] <= offset) k++; return k; };

// Words that are not product names (used to pull "DOP" out of "4. DOP 1 tanker rate pls").
const FILLER = new Set(['for', 'of', 'the', 'a', 'an', 'to', 'in', 'at', 'ex', 'on', 'with', 'is', 'are', 'also', 'bhi', 'hai', 'he', 'kya', 'ka', 'ki',
  'ke', 'ko', 'se', 'me', 'mein', 'and', 'aur', 'or', 'each', 'har', 'ek', 'all', 'total', 'approx', 'around', 'qty', 'quantity', 'delivery', 'dispatch',
  'material', 'materials', 'product', 'products', 'item', 'items', 'grade', 'today', 'kal', 'aaj', 'asap', 'immediate', 'immediately', 'sir', 'ji',
  'bhai', 'dear', 'hi', 'hello', 'good', 'morning', 'team', 'origin', 'make', 'brand', 'basis', 'ready', 'stock', 'nos', 'no', 'pcs', 'month', 'monthly',
  'per', 'every', 'week', 'weekly', 'regular', 'urgently']);

/**
 * analyze(text, chemicals, opts) -> {
 *   isRequest, skipReason, intent: 'quote'|'deal',
 *   items: [{chem, alias, how, quantity, origins, brands}],   // one per product, with its own details
 *   unmatchedItems: [{name, quantity}],                        // list lines naming products not in the matrix
 *   quantity, location, origins, brands                        // message-wide (first qty, all origins…)
 * }
 */
export function analyze(text, chemicals, opts = {}) {
  const original = String(text || '').trim();
  const norm = normalize(original);
  const toks = norm.split(' ').filter(Boolean);
  const res = { isRequest: false, skipReason: null, intent: 'quote', items: [], unmatchedItems: [], quantity: null, location: null, origins: [], brands: [] };
  if (!norm) { res.skipReason = 'empty'; return res; }
  const limit = Math.min(Number(opts.maxLength) || 2000, 2000);   // hard cap keeps typo-matching cheap
  if (original.length > limit) { res.skipReason = 'too long (looks like a price list / broadcast)'; return res; }

  const index = opts.index || buildIndex(chemicals);
  const qtys = detectQuantities(original);
  const qty = qtys[0] || null;
  res.quantity = qty;
  res.location = detectLocation(norm);
  res.origins = detectOrigins(toks);
  res.items = findChemicals(original, norm, index, !!qty);

  // ---- where is everything in the text? ----
  let offs = tokenOffsets(original);
  if (offs.length !== toks.length) offs = null;                        // unusual script mix: fall back to text search
  const at = it => offs ? offs[it.pos] : rawIndex(original, it.alias);
  const starts = segmentStarts(original);
  const placed = res.items.map(it => ({ it, at: at(it) })).sort((a, b) => a.at - b.at);
  const itemSegs = new Set(placed.filter(p => p.at >= 0).map(p => segOf(starts, p.at)));
  const lastItemAt = Math.max(-1, ...placed.map(p => p.at));
  const eachWord = /\b(each|every one|har ek|sab|all)\b/i.test(original);

  // origins with their positions; an origin in a line without any product applies to all products ("All China origin")
  const originAt = offs ? toks.map((t, i) => ORIGINS[t] ? { name: ORIGINS[t], seg: segOf(starts, offs[i]) } : null).filter(Boolean) : [];
  const globalOrigins = offs ? [...new Set(originAt.filter(o => !itemSegs.has(o.seg)).map(o => o.name))] : res.origins;

  placed.forEach((p, k) => {
    const it = p.it;
    const seg = p.at >= 0 ? segOf(starts, p.at) : -1;
    const next = placed[k + 1]?.at ?? Infinity;
    // quantity: right after this product (before the next one), else anywhere in its line/segment
    let own = p.at >= 0 ? qtys.find(q => q.index > p.at && q.index < next && segOf(starts, q.index) === seg) : null;
    if (!own && seg >= 0) own = qtys.find(q => segOf(starts, q.index) === seg && !placed.some(o => o !== p && o.at >= 0 && segOf(starts, o.at) === seg && o.at < q.index && o.at > p.at));
    // one quantity for the whole list ("PA, MA, IPA – 5 MT each" / "PA and MA rate 5 MT")
    if (!own && qtys.length === 1 && (eachWord || qtys[0].index > lastItemAt || p.at < 0)) own = qtys[0];
    it.quantity = own || null;
    // origin(s) named for this product, else ones stated for the whole list
    const segOrigins = offs && seg >= 0 ? [...new Set(originAt.filter(o => o.seg === seg).map(o => o.name))] : [];
    it.origins = segOrigins.length ? segOrigins : (placed.length === 1 ? res.origins : globalOrigins);
    // brand mentions for this product (e.g. "IGPL", "Tengda", "Aekyung")
    const segText = seg >= 0 ? normalize(original.slice(starts[seg], starts[seg + 1] ?? original.length)) : norm;
    const cands = [it.chem.manufacturer, ...(it.chem.origin_rates || []).map(o => o.brand)].filter(Boolean)
      .flatMap(b => String(b).split(/[\/,&]/)).map(b => b.trim()).filter(b => b.length >= 3);
    it.brands = [...new Set(cands.filter(b => hasPhrase(segText, b) || (placed.length === 1 && hasPhrase(norm, b))))];
  });
  res.brands = [...new Set(res.items.flatMap(i => i.brands))];

  // ---- list lines that name a product we don't have ("4. DOP 1 tanker") ----
  if (starts.length > 1) {
    const stop = new Set([...STRONG_REQUEST, ...WEAK_REQUEST, ...FILLER, ...Object.keys(ORIGINS), ...Object.keys(UNIT_MAP), ...LOCATIONS.map(l => normalize(l))]);
    for (let sIdx = 0; sIdx < starts.length; sIdx++) {
      if (itemSegs.has(sIdx)) continue;
      const raw = original.slice(starts[sIdx], starts[sIdx + 1] ?? original.length);
      const segQty = qtys.find(q => segOf(starts, q.index) === sIdx);
      if (!segQty) continue;                                            // only lines that ask for an amount
      const words = raw.replace(/^\s*(\d+\s*[.)\-:]|[-•*·]+)\s*/, '').replace(segQty.raw, ' ')
        .split(/[^A-Za-z0-9ऀ-ॿ.\-]+/).filter(w => w && !stop.has(normalize(w)) && !/^\d/.test(w) && normalize(w).length >= 2);
      if (words.length && words.length <= 5) res.unmatchedItems.push({ name: words.join(' ').slice(0, 40), quantity: segQty });
    }
  }

  // --- is this a request (buyer) or an offer (seller) / chit-chat? ---
  const tokSet = new Set(toks);
  const strong = STRONG_REQUEST.some(w => tokSet.has(w));
  const weak = WEAK_REQUEST.some(w => tokSet.has(w));
  const question = /\?/.test(original);
  const ignoreHit = splitList(opts.ignoreKeywords).find(k => hasPhrase(norm, k));
  const priceStated = /(₹|rs\.?|inr|@)\s*\d|\d+\s*\/\s*-|\d+\s*\/\s*(kg|ltr|mt)|\d+\s*(rs|rupees)\b/i.test(original);
  const buyerWords = ['need', 'needed', 'require', 'required', 'requirement', 'req', 'reqd', 'rqd', 'chahiye', 'chaiye', 'chahie', 'chaye', 'buy', 'buyer', 'want', 'wanted', 'enquiry', 'inquiry', 'lena', 'mangta'];
  const buyer = buyerWords.some(w => tokSet.has(w));

  if (ignoreHit && !buyer) { res.skipReason = `seller post ("${ignoreHit}")`; return res; }
  if (priceStated && !buyer && !question) { res.skipReason = 'message states its own price (likely an offer)'; return res; }

  // A bare chemical name with a quantity ("PA 2 ton") is treated as an enquiry in broker groups.
  const shortAsk = res.items.length > 0 && toks.length <= 4 && (qty || question);
  res.isRequest = strong || (weak && (question || !!qty)) || shortAsk || (question && res.items.length > 0);
  if (!res.isRequest) { res.skipReason = 'no request words found'; return res; }

  // Worth logging as "Unmatched" for the owner only when it clearly looks like a buy enquiry.
  const core = ['rate', 'rates', 'price', 'quote', 'quotation', 'bhav', 'bhaav', 'daam'];
  res.unmatchedWorthy = res.items.length === 0 && (buyer || core.some(w => tokSet.has(w))) && (!!qty || question || toks.length <= 12);

  const dealWords = splitList(opts.dealKeywords?.length ? opts.dealKeywords : DEAL_DEFAULT);
  if (dealWords.some(w => hasPhrase(norm, w))) res.intent = 'deal';
  return res;
}
