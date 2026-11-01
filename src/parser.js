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
const QTY_RE = /(\d+(?:[.,]\d+)?)\s*(m\.t\.?|mts?|tonnes?|tons?|tonn|tn|kgs?|kilos?|bags?|drums?|ltrs?|litres?|liters?|ibcs?|tankers?|fcl|containers?|trucks?|loads?|gaadi|gadi|pallets?|carboys?|jumbos?|pcs)(?![a-z])/i;
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
  const num = m[1].replace(',', '.');
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
    if (!hits.some(h => h.chem.id === entry.chem.id)) hits.push({ chem: entry.chem, alias: entry.alias, pos: start, how });
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

/**
 * analyze(text, chemicals, opts) -> {
 *   isRequest, skipReason, intent: 'quote'|'deal', items: [{chem, alias, how}], quantity, location, origins, brands
 * }
 */
export function analyze(text, chemicals, opts = {}) {
  const original = String(text || '').trim();
  const norm = normalize(original);
  const toks = norm.split(' ').filter(Boolean);
  const res = { isRequest: false, skipReason: null, intent: 'quote', items: [], quantity: null, location: null, origins: [], brands: [] };
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

  // Give each chemical its own quantity: "IPA 20 drums and MSG 1 ton"
  const placed = res.items.map(it => ({ it, at: rawIndex(original, it.alias) })).sort((a, b) => a.at - b.at);
  placed.forEach((p, k) => {
    const next = placed[k + 1]?.at ?? Infinity;
    const own = p.at >= 0 ? qtys.find(q => q.index > p.at && q.index < next) : null;
    p.it.quantity = own || (qtys.length === 1 || p.at < 0 ? qty : null);
  });

  // brand mentions (e.g. "IGPL", "Tengda", "Aekyung")
  const brands = new Set();
  for (const it of res.items) {
    const cands = [it.chem.manufacturer, ...(it.chem.origin_rates || []).map(o => o.brand)].filter(Boolean)
      .flatMap(b => String(b).split(/[\/,&]/)).map(b => b.trim()).filter(b => b.length >= 3);
    for (const b of cands) if (hasPhrase(norm, b)) brands.add(b);
  }
  res.brands = [...brands];

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
