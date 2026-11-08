/* WhatsApp Quote Bot — dashboard (vanilla JS, no build step) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => n == null || n === '' ? '' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const parseDbDate = s => s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z') : null;
const fmtTime = s => { const d = parseDbDate(s); return d ? d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; };

const ICON = {
  search: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  sync: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/></svg>',
  plus: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>',
  save: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 14v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/><path d="M12 4v11m-4-4 4 4 4-4"/></svg>',
  ban: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>',
  dl: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 4v11m-4-4 4 4 4-4M4 20h16"/></svg>',
};

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { location.href = '/login'; throw new Error('Logged out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 3200);
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

/** WhatsApp markup -> HTML for previews */
function waFormat(text) {
  let s = esc(text);
  s = s.replace(/```([\s\S]+?)```/g, '<code>$1</code>');
  s = s.replace(/(^|[\s(>])\*([^*\n]+?)\*(?=[\s).,:!?<]|$)/gm, '$1<b>$2</b>');
  s = s.replace(/(^|[\s(>])_([^_\n]+?)_(?=[\s).,:!?<]|$)/gm, '$1<i>$2</i>');
  s = s.replace(/(^|[\s(>])~([^~\n]+?)~(?=[\s).,:!?<]|$)/gm, '$1<s>$2</s>');
  return s.replace(/\n/g, '<br>');
}

const CHEM_STATUSES = ['In Stock', 'Limited', 'Subject to Confirmation', 'On Order', 'Out of Stock'];
const chemStatusClass = s => ({ 'In Stock': 'b-green', Limited: 'b-amber', 'Subject to Confirmation': 'b-amber', 'On Order': 'b-blue', 'Out of Stock': 'b-red' }[s] || 'b-gray');
const ORDER_CLASS = { New: 'b-blue', Quoted: 'b-violet', Negotiating: 'b-amber', 'Awaiting Owner': 'b-amber', Confirmed: 'b-green', 'On Hold': 'b-gray', Rejected: 'b-red', Dispatched: 'b-navy', Unmatched: 'b-gray' };
const COUNTRIES = ['India', 'China', 'Russia', 'Korea', 'Indonesia', 'Japan', 'Saudi', 'Thailand', 'Taiwan', 'Spain', 'USA', 'Iran', 'Malaysia', 'Singapore', 'UAE', 'Qatar', 'Kuwait', 'Vietnam', 'Turkey', 'Germany', 'Europe', 'Imported'];

const state = {
  tab: 'chemicals',
  status: null,
  chemicals: [], chemFilter: { q: '', brand: '' },
  groups: [], groupFilter: { q: '', status: '', type: '' },
  tpl: null, tplMode: 'quote', tplDraft: {}, tplPreset: {}, sampleChem: null, sampleMsg: '',
  orders: { items: [], stats: {}, statuses: [] }, orderFilter: { status: 'open', q: '' },
  join: null, settings: null,
};

/* =========================================================== shell */
const TAB_ACTIONS = {
  chemicals: () => `<button class="btn btn-dark" data-act="add-chem">${ICON.plus} Add Chemical</button>`,
  groups: () => `<button class="btn btn-green" data-act="sync">${ICON.sync} Sync Live Groups</button>`,
  orders: () => `<a class="btn btn-light" href="/api/inquiries.csv" download>${ICON.dl} Export CSV</a>`,
  payments: () => `<button class="btn btn-dark" data-act="new-order">${ICON.plus} New Order</button>`,
};
const LOADERS = { chemicals: loadChemicals, groups: loadGroups, templates: loadTemplates, orders: loadOrders, payments: loadPayments, join: loadJoin, settings: loadSettings };

function switchTab(tab) {
  state.tab = tab;
  $$('#tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('main > section').forEach(s => s.classList.toggle('hidden', s.id !== `view-${tab}`));
  $('#tabActions').innerHTML = TAB_ACTIONS[tab] ? TAB_ACTIONS[tab]() : '';
  history.replaceState(null, '', '#' + tab);
  guard(LOADERS[tab])();
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) switchTab(b.dataset.tab); });
$('#tabActions').addEventListener('click', e => {
  const a = e.target.closest('[data-act]')?.dataset.act;
  if (a === 'add-chem') openChemModal(null);
  if (a === 'sync') syncGroups();
  if (a === 'new-order') openPaymentOrderModal(null);
});
$('#logoutBtn').onclick = async () => { await api('POST', '/api/logout'); location.href = '/login'; };
$('#waPill').onclick = () => openConnectionModal();

/* =========================================================== status polling */
const WA_TEXT = { open: 'WhatsApp connected', qr: 'Scan QR to link', qr_expired: 'Not linked', connecting: 'Connecting…', logged_out: 'Logged out – relink', disconnected: 'Disconnected', disabled: 'WhatsApp disabled' };
async function pollStatus() {
  try {
    const s = await api('GET', '/api/status');
    const prevAccount = state.status?.whatsapp?.me?.id ?? null;
    state.status = s;
    const st = s.whatsapp.status;
    const account = s.whatsapp.me?.id ?? null;
    if (account !== prevAccount && (account || st === 'logged_out') && ['groups', 'join'].includes(state.tab)) guard(LOADERS[state.tab])();
    $('#waPill').dataset.status = st;
    $('#waPillText').textContent = st === 'open' && s.whatsapp.me ? `Connected · +${(s.whatsapp.me.id || '').split('@')[0]}` : WA_TEXT[st] || st;
    const alert = $('#connAlert');
    if (st !== 'open') {
      alert.classList.remove('hidden');
      alert.innerHTML = ['qr', 'logged_out', 'qr_expired'].includes(st)
        ? `<span>📱 <b>WhatsApp is not linked.</b> Link the bot's WhatsApp number to start quoting in groups.</span><button class="btn btn-dark btn-sm" data-open-conn>Link WhatsApp</button>`
        : st === 'disabled' ? `<span><b>WhatsApp is disabled</b> (WA_DISABLED=1). The dashboard works but nothing is sent.</span>`
        : `<span>⏳ <b>Connecting to WhatsApp…</b> ${esc(s.whatsapp.lastError || '')}</span><button class="btn btn-light btn-sm" data-open-conn>Details</button>`;
      alert.querySelector('[data-open-conn]')?.addEventListener('click', openConnectionModal);
    } else if (s.backupProblem) {
      alert.classList.remove('hidden');
      alert.innerHTML = `<span>⚠️ <b>Backups need attention:</b> ${esc(s.backupProblem)}</span><button class="btn btn-light btn-sm" id="goBackups">Open Settings</button>`;
      $('#goBackups').onclick = () => switchTab('settings');
    } else alert.classList.add('hidden');
    const pc = $('#pendingCount');
    const od = s.payments?.overdue?.n || 0;
    $('#overdueCount').textContent = od; $('#overdueCount').classList.toggle('hidden', !od);
    const pending = s.stats.negotiating;
    pc.textContent = pending; pc.classList.toggle('hidden', !pending);
    if (connModalOpen) renderConnectionModal();
    if (state.tab === 'groups') loadActivity().catch(() => {});
  } catch { /* ignore */ }
}

/* =========================================================== modal helpers */
let connModalOpen = false;
function openModal(html, { size = '', onClose } = {}) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="overlay"><div class="modal ${size}">${html}</div></div>`;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('.overlay', root).addEventListener('mousedown', e => { if (e.target.classList.contains('overlay')) close(); });
  $$('[data-close]', root).forEach(b => b.onclick = close);
  return { el: $('.modal', root), close };
}
function confirmBox(title, text, okLabel = 'Confirm', danger = true) {
  return new Promise(resolve => {
    const m = openModal(`<div class="modal-head"><h3>${esc(title)}</h3><button class="x" data-close>×</button></div>
      <div class="modal-body"><p style="margin:0">${text}</p></div>
      <div class="modal-foot"><div class="push"></div><button class="btn btn-light" data-close>Cancel</button>
      <button class="btn ${danger ? 'btn-danger-soft' : 'btn-dark'}" id="okBtn">${esc(okLabel)}</button></div>`, { size: 'sm', onClose: () => resolve(false) });
    $('#okBtn', m.el).onclick = () => { resolve(true); m.close(); };
  });
}

/* =========================================================== WhatsApp connection */
function openConnectionModal() {
  connModalOpen = true;
  // Expired QR: opening this window means you're ready to scan, so fetch a fresh one straight away.
  if (state.status?.whatsapp?.status === 'qr_expired') api('POST', '/api/wa/restart').catch(() => {});
  openModal(`<div class="modal-head"><h3>WhatsApp Connection</h3><button class="x" data-close>×</button></div><div class="modal-body" id="connBody"></div>
    <div class="modal-foot"><button class="btn btn-light" id="restartWa">Restart connection</button><div class="push"></div>
    <button class="btn btn-danger-soft" id="logoutWa">Unlink this number</button></div>`, { size: 'sm', onClose: () => { connModalOpen = false; } });
  renderConnectionModal();
  $('#restartWa').onclick = guard(async () => { await api('POST', '/api/wa/restart'); toast('Restarting connection…'); });
  $('#logoutWa').onclick = guard(async () => {
    if (!await confirmBox('Unlink WhatsApp?', 'The bot will stop replying until you scan a new QR.', 'Unlink')) return openConnectionModal();
    // The confirm dialog replaced the connection window, so show a fresh "working" window instead of touching old buttons.
    const busy = openModal(`<div class="modal-head"><h3>Unlinking…</h3></div>
      <div class="modal-body"><p style="margin:0">Asking WhatsApp to remove this device from your phone. This can take up to 15 seconds.</p></div>`, { size: 'sm' });
    let r;
    try { r = await api('POST', '/api/wa/logout'); } finally { busy.close(); }
    if (r.confirmed) toast('Unlinked — also removed from Linked devices on your phone.');
    else await confirmBox('Unlinked here — please also remove it on your phone',
      `The bot is unlinked from this dashboard, but WhatsApp didn't confirm the removal (${esc(r.reason || 'no answer')}).<br><br>
      On the phone, open <b>WhatsApp → Settings → Linked devices</b>, tap the bot's device (it may say <b>Ubuntu</b> or <b>Quote Bot</b>) and choose <b>Log out</b>.`, 'OK', false);
    openConnectionModal();
  });
}
function renderConnectionModal() {
  const body = $('#connBody'); if (!body || !state.status) return;
  const w = state.status.whatsapp;
  if (w.status === 'open') {
    body.innerHTML = `<p style="margin-top:0"><span class="badge b-green">Connected</span></p>
      <p><b>Number:</b> +${esc((w.me?.id || '').split('@')[0])}<br><b>Name:</b> ${esc(w.me?.name || '—')}<br>
      <b>Last group sync:</b> ${w.lastSync ? fmtTime(w.lastSync) : '—'}</p>
      <p class="muted" style="margin-bottom:0">The bot replies only in groups whose Auto-reply toggle is ON.</p>`;
  } else if (w.status === 'qr_expired') {
    body.innerHTML = `<p style="margin-top:0"><span class="badge b-gray">Not linked</span></p>
      <p>The last QR code expired because it wasn't scanned. To save WhatsApp from being asked again and again, the bot waits until you're ready.</p>
      <button class="btn btn-dark" id="newQr">Show a new QR code</button>`;
    $('#newQr').onclick = guard(async () => { $('#newQr').disabled = true; $('#newQr').textContent = 'Getting a QR code…'; await api('POST', '/api/wa/restart'); });
  } else if (w.qr) {
    body.innerHTML = `<div class="qr-box"><img src="${w.qr}" alt="WhatsApp link QR"></div>
      <ol class="steps"><li>Open WhatsApp on the phone with the bot's number</li><li>Go to <b>Settings → Linked devices → Link a device</b></li>
      <li>Scan this QR. It refreshes by itself every ~20 seconds.</li></ol>`;
  } else {
    body.innerHTML = `<p style="margin-top:0"><span class="badge b-amber">${esc(WA_TEXT[w.status] || w.status)}</span></p>
      <p class="muted">${esc(w.lastError || 'Waiting for WhatsApp…')}</p><p class="muted" style="margin-bottom:0">If no QR appears within a minute, press <b>Restart connection</b>.</p>`;
  }
}

/* =========================================================== CHEMICALS */
async function loadChemicals() {
  state.chemicals = await api('GET', '/api/chemicals');
  const v = $('#view-chemicals');
  if (!v.dataset.ready) {
    v.innerHTML = `<div class="card">
      <div class="toolbar">
        <div class="search">${ICON.search}<input class="input" id="chemSearch" placeholder="Search chemical name or common name (PA, AA, MSG…)"></div>
        <div class="spacer"></div>
        <select class="input" id="chemBrand"></select>
        <span class="showing" id="chemShowing"></span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th style="width:26%">Chemical &amp; Common Names (Aliases)</th><th>Manufacturer / Brand</th><th>Packaging</th>
        <th class="right">Price / Origin Rates (₹)</th><th>Status</th><th class="center">Action</th></tr></thead>
        <tbody id="chemRows"></tbody></table></div></div>`;
    v.dataset.ready = 1;
    $('#chemSearch').oninput = e => { state.chemFilter.q = e.target.value; renderChemRows(); };
    $('#chemBrand').onchange = e => { state.chemFilter.brand = e.target.value; renderChemRows(); };
    $('#chemRows').onclick = e => {
      const id = e.target.closest('[data-edit]')?.dataset.edit;
      if (id) openChemModal(state.chemicals.find(c => c.id === Number(id)));
    };
  }
  const brands = [...new Set(state.chemicals.flatMap(c => [c.manufacturer, ...c.origin_rates.map(o => o.brand)]).filter(Boolean))].sort();
  $('#chemBrand').innerHTML = `<option value="">All Brands / Mfrs</option>` + brands.map(b => `<option ${b === state.chemFilter.brand ? 'selected' : ''}>${esc(b)}</option>`).join('');
  renderChemRows();
}
function renderChemRows() {
  const q = state.chemFilter.q.trim().toLowerCase().replace(/\./g, '');
  const rows = state.chemicals.filter(c => {
    if (state.chemFilter.brand && c.manufacturer !== state.chemFilter.brand && !c.origin_rates.some(o => o.brand === state.chemFilter.brand)) return false;
    if (!q) return true;
    return [c.name, ...c.alias_list].some(a => a.toLowerCase().replace(/\./g, '').includes(q));
  });
  $('#chemShowing').textContent = `Showing ${rows.length} chemical${rows.length === 1 ? '' : 's'}`;
  $('#chemRows').innerHTML = rows.length ? rows.map(c => {
    const unit = `<div class="sub">/${esc(c.unit)}${c.gst ? ` +${c.gst}%` : ''}</div>`;
    const price = c.origin_rates.length
      ? (c.price != null ? `<div class="origin-line"><span class="origin-tag">Base:</span><span class="origin-rate">${inr(c.price)}</span></div>` : '') +
        c.origin_rates.map(o => `<div class="origin-line" title="${esc(o.brand)}"><span class="origin-tag">${esc(o.country)}${o.brand ? ` · ${esc(o.brand)}` : ''}:</span><span class="origin-rate">${inr(o.rate)}</span></div>`).join('') + unit
      : c.price != null ? `<div class="rate-big">${inr(c.price)}</div>${unit}` : `<span class="faint">On request</span>`;
    return `<tr class="${c.active ? '' : 'inactive-row'}">
      <td><div class="chem-name">${esc(c.name)}${c.active ? '' : ' <span class="badge b-gray">Paused</span>'}</div><div class="chips">${c.alias_list.map(a => `<span class="alias">${esc(a)}</span>`).join('')}</div></td>
      <td><div>${esc(c.manufacturer)}</div><div class="sub">${esc(c.location)}</div></td>
      <td><div>${esc(c.packaging)}</div><div class="stock-note">${esc(c.stock_note)}</div></td>
      <td class="right">${price}</td>
      <td><span class="badge ${chemStatusClass(c.status)}">${esc(c.status)}</span></td>
      <td class="center"><button class="btn btn-outline-amber" data-edit="${c.id}">Edit Chemical</button></td></tr>`;
  }).join('') : `<tr><td colspan="6" class="empty">No chemicals match. Add one with “+ Add Chemical”.</td></tr>`;
}

function originRowHtml(o = {}) {
  return `<div class="origin-row">
    <input class="input" list="countryList" placeholder="Country (e.g. China)" data-o="country" value="${esc(o.country || '')}">
    <input class="input" placeholder="Brand / Mfr (optional)" data-o="brand" value="${esc(o.brand || '')}">
    <input class="input price-input" type="number" step="0.01" min="0" placeholder="Rate ₹" data-o="rate" value="${o.rate ?? ''}">
    <button class="link-danger" title="Remove" data-rm-origin>×</button></div>`;
}
function openChemModal(c) {
  const isNew = !c;
  c = c || { name: '', aliases: '', price: '', unit: 'kg', gst: state.settings?.default_gst ?? 18, manufacturer: '', packaging: '', location: state.settings?.default_location || 'Bhiwandi / Mumbai Ex-Godown', stock_note: 'Ready Stock', status: 'In Stock', origin_rates: [], active: true };
  const m = openModal(`<div class="modal-head"><h3>${isNew ? 'Add Chemical' : 'Edit Chemical Details &amp; Price'}</h3><button class="x" data-close>×</button></div>
    <form class="modal-body" id="chemForm" autocomplete="off">
      <div class="field"><label>Chemical Name *</label><input class="input" name="name" required value="${esc(c.name)}"></div>
      <div class="field"><label>Common Name(s) / Aliases *</label><input class="input mono" name="aliases" value="${esc(c.aliases)}" placeholder="pa, p.a., phthalic">
        <div class="help">Short abbreviations or market trade names brokers type in groups. Separate with commas.</div></div>
      <div class="grid3">
        <div class="field"><label>Price / Rate (₹)</label><input class="input price-input" name="price" type="number" step="0.01" min="0" value="${c.price ?? ''}" placeholder="e.g. 199"></div>
        <div class="field"><label>Per Unit</label><input class="input" name="unit" value="${esc(c.unit)}"></div>
        <div class="field"><label>GST %</label><input class="input" name="gst" type="number" step="0.01" min="0" value="${c.gst ?? 18}"></div>
      </div>
      <div class="grid2">
        <div class="field"><label>Manufacturer / Brand</label><input class="input" name="manufacturer" value="${esc(c.manufacturer)}"></div>
        <div class="field"><label>Packaging</label><input class="input" name="packaging" value="${esc(c.packaging)}" placeholder="25 kgs Bag"></div>
        <div class="field"><label>Location</label><input class="input" name="location" value="${esc(c.location)}"></div>
        <div class="field"><label>Stock Note</label><input class="input" name="stock_note" value="${esc(c.stock_note)}" placeholder="Ready Stock / In Transit"></div>
      </div>
      <div class="field"><div class="sec-head" style="margin-bottom:8px"><span class="flabel" style="margin:0">Country Origin Rates (China, Russia, Korea, etc.)</span>
        <button type="button" class="link-btn" id="addOrigin">+ Add Origin Rate</button></div>
        <div id="originRows">${c.origin_rates.map(originRowHtml).join('')}</div>
        <div class="origin-empty ${c.origin_rates.length ? 'hidden' : ''}" id="originEmpty">No origin rates. The single price above will be quoted.</div>
        <div class="help">Add specific rates for China, Russia, USA, Korea, Indonesia, Japan, Saudi, Thailand, Taiwan, Spain, etc. If a buyer names an origin (“Korea PA rate”), only that rate is sent.</div>
        <datalist id="countryList">${COUNTRIES.map(x => `<option value="${x}">`).join('')}</datalist></div>
      <div class="grid2">
        <div class="field"><label>Stock Status</label><select class="input" name="status">${CHEM_STATUSES.map(s => `<option ${s === c.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label>Bot Quoting</label><label class="check" style="text-transform:none;letter-spacing:0;font-size:15px;margin-top:12px"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Bot may quote this chemical</label></div>
      </div>
    </form>
    <div class="modal-foot">${isNew ? '' : '<button class="link-danger" style="font-size:17px" id="delChem">Delete Chemical</button>'}<div class="push"></div>
      <button class="btn btn-light" data-close style="border:0;background:none">Cancel</button><button class="btn btn-dark" id="saveChem">Save Changes</button></div>`);

  const rows = $('#originRows', m.el);
  const syncEmpty = () => $('#originEmpty', m.el).classList.toggle('hidden', rows.children.length > 0);
  $('#addOrigin', m.el).onclick = () => { rows.insertAdjacentHTML('beforeend', originRowHtml()); syncEmpty(); rows.lastElementChild.querySelector('input').focus(); };
  rows.onclick = e => { if (e.target.closest('[data-rm-origin]')) { e.target.closest('.origin-row').remove(); syncEmpty(); } };

  $('#saveChem', m.el).onclick = guard(async () => {
    const f = $('#chemForm', m.el);
    if (!f.name.value.trim()) { f.name.focus(); throw new Error('Chemical name is required'); }
    if (!f.aliases.value.trim()) { f.aliases.focus(); throw new Error('Add at least one common name / alias'); }
    const origin_rates = $$('.origin-row', m.el).map(r => ({ country: $('[data-o=country]', r).value, brand: $('[data-o=brand]', r).value, rate: $('[data-o=rate]', r).value }))
      .filter(o => o.country.trim() || o.rate !== '');
    if (origin_rates.some(o => !o.country.trim() || o.rate === '')) throw new Error('Each origin rate needs a country and a rate');
    if (f.price.value === '' && !origin_rates.length) throw new Error('Enter a price or at least one origin rate');
    const body = { name: f.name.value, aliases: f.aliases.value, price: f.price.value, unit: f.unit.value, gst: f.gst.value, manufacturer: f.manufacturer.value,
      packaging: f.packaging.value, location: f.location.value, stock_note: f.stock_note.value, status: f.status.value, active: f.active.checked, origin_rates };
    await api(isNew ? 'POST' : 'PUT', isNew ? '/api/chemicals' : `/api/chemicals/${c.id}`, body);
    m.close(); toast(isNew ? 'Chemical added' : 'Changes saved'); loadChemicals();
  });
  $('#delChem', m.el)?.addEventListener('click', guard(async () => {
    if (!await confirmBox('Delete chemical?', `<b>${esc(c.name)}</b> will be removed and the bot will stop quoting it.`, 'Delete')) return openChemModal(c);
    await api('DELETE', `/api/chemicals/${c.id}`); toast('Chemical deleted'); loadChemicals();
  }));
}

/* =========================================================== GROUPS */
async function loadGroups() {
  state.groups = await api('GET', '/api/groups');
  const v = $('#view-groups');
  if (!v.dataset.ready) {
    v.innerHTML = `<div class="card">
      <div class="banner">🔒 <div><b>Safe Mode Active:</b> All group auto-replies are <code>OFF</code> by default. The bot will <i>only</i> quote in groups where you explicitly turn the toggle <b style="color:var(--green-ink)">ON</b>.</div>
        <button class="btn btn-green" data-sync>${ICON.sync} Sync Live Groups</button></div>
      <div class="dir-head"><div><h2>WhatsApp Groups Directory <span class="pill-count" id="grpCount"></span></h2>
        <p>Live participating groups synced from WhatsApp. Search the directory and toggle switches to enable quotes.</p></div>
        <div class="actions"><button class="btn btn-danger-soft" id="allOff">${ICON.ban} Turn All OFF</button><button class="btn btn-dark" id="addGroup">+ Add Custom Group</button></div></div>
      <div class="toolbar">
        <div class="search">${ICON.search}<input class="input" id="grpSearch" placeholder="Search WhatsApp groups by name or ID (e.g. 1203…@g.us)"></div>
        <select class="input" id="grpStatus"><option value="">All Statuses</option><option value="on">Auto-reply ON</option><option value="off">Auto-reply OFF</option><option value="left">Left / removed</option></select>
        <select class="input" id="grpType"><option value="">All Types</option><option value="live">Live WhatsApp Group</option><option value="custom">Custom</option></select>
        <button class="link-btn" id="grpReset">Reset</button>
      </div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Group Name &amp; ID</th><th>Type</th><th>Members</th><th>Quotes Sent</th><th class="center">Auto-Reply Toggle</th><th></th></tr></thead>
      <tbody id="grpRows"></tbody></table></div></div>
      <div class="card" style="margin-top:20px">
        <div class="dir-head"><div><h2>Live Bot Activity</h2><p>Every message the bot sees and what it decided — use this to check why a message did or didn't get a reply.</p></div></div>
        <div class="table-wrap" style="max-height:420px"><table class="data"><thead><tr><th style="width:110px">Time</th><th>Chat &amp; Sender</th><th>Message</th><th>Result</th></tr></thead>
        <tbody id="actRows"></tbody></table></div></div>`;
    v.dataset.ready = 1;
    $('[data-sync]', v).onclick = syncGroups;
    $('#grpSearch').oninput = e => { state.groupFilter.q = e.target.value; renderGroupRows(); };
    $('#grpStatus').onchange = e => { state.groupFilter.status = e.target.value; renderGroupRows(); };
    $('#grpType').onchange = e => { state.groupFilter.type = e.target.value; renderGroupRows(); };
    $('#grpReset').onclick = () => { state.groupFilter = { q: '', status: '', type: '' }; $('#grpSearch').value = ''; $('#grpStatus').value = ''; $('#grpType').value = ''; renderGroupRows(); };
    $('#allOff').onclick = guard(async () => {
      if (!await confirmBox('Turn all auto-replies OFF?', 'The bot will stop quoting in every group until you switch groups back ON.', 'Turn All OFF')) return;
      await api('POST', '/api/groups/all-off'); toast('All auto-replies are OFF'); loadGroups();
    });
    $('#addGroup').onclick = openAddGroupModal;
    $('#grpRows').addEventListener('change', guard(async e => {
      const t = e.target.closest('input[data-toggle]'); if (!t) return;
      const g = await api('PATCH', `/api/groups/${encodeURIComponent(t.dataset.toggle)}`, { auto_reply: t.checked });
      Object.assign(state.groups.find(x => x.jid === g.jid), g);
      renderGroupRows();
      toast(`${g.name}: auto-reply ${g.auto_reply ? 'ON' : 'OFF'}`);
    }));
    $('#grpRows').addEventListener('click', guard(async e => {
      const jid = e.target.closest('[data-del-group]')?.dataset.delGroup; if (!jid) return;
      if (!await confirmBox('Remove group?', 'This removes it from the dashboard only. It does not leave the WhatsApp group.', 'Remove')) return;
      await api('DELETE', `/api/groups/${encodeURIComponent(jid)}`); loadGroups();
    }));
  }
  renderGroupRows();
  loadActivity();
}
const ACT_CLASS = { replied: 'b-green', skipped: 'b-gray', unmatched: 'b-amber', error: 'b-red', flagged: 'b-violet' };
async function loadActivity() {
  const el = $('#actRows'); if (!el) return;
  const items = await api('GET', '/api/activity');
  el.innerHTML = items.length ? items.map(a => `<tr>
    <td style="white-space:nowrap">${new Date(a.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
    <td><div style="font-weight:600">${esc(a.chatName || a.chat || '')}</div><div class="sub">${esc(a.sender || '')}</div></td>
    <td class="msg-cell"><div class="txt">${esc(a.text || '')}</div></td>
    <td><span class="badge ${ACT_CLASS[a.result] || 'b-gray'}">${esc(a.result)}</span><div class="sub" style="margin-top:4px;color:var(--ink-2)">${esc(a.detail || '')}</div></td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">No messages seen yet. Send a message in a WhatsApp group the bot's number is in — it shows up here within a second.</td></tr>`;
}
function renderGroupRows() {
  const { q, status, type } = state.groupFilter;
  const ql = q.trim().toLowerCase();
  const rows = state.groups.filter(g => {
    if (status === 'on' && !g.auto_reply) return false;
    if (status === 'off' && (g.auto_reply || g.left_group)) return false;
    if (status === 'left' && !g.left_group) return false;
    if (status !== 'left' && g.left_group && status) return false;
    if (type && g.type !== type) return false;
    return !ql || g.name.toLowerCase().includes(ql) || g.jid.includes(ql);
  });
  const me = state.status?.whatsapp?.me?.id;
  $('#grpCount').textContent = `Showing ${rows.length} of ${state.groups.length} groups${me ? ` · +${me.split('@')[0]}` : ''}`;
  $('#grpRows').innerHTML = rows.length ? rows.map(g => `<tr>
    <td><div class="chem-name" style="margin-bottom:2px">${esc(g.name)} ${g.is_admin ? '<span class="badge b-blue" style="font-size:11.5px;padding:1px 7px">Admin</span>' : ''}</div><div class="mono faint" style="font-size:13.5px">${esc(g.jid)}</div></td>
    <td>${g.left_group ? '<span class="badge b-red">Left / Removed</span>' : g.type === 'custom' ? '<span class="badge b-violet">Custom</span>' : '<span class="badge b-green">Live WhatsApp Group</span>'}</td>
    <td>${g.members ? `${g.members} members` : '<span class="faint">—</span>'}</td>
    <td><b>${g.quotes_sent}</b></td>
    <td class="center"><label class="toggle"><input type="checkbox" data-toggle="${esc(g.jid)}" ${g.auto_reply ? 'checked' : ''} ${g.left_group ? 'disabled' : ''}><span></span></label>
      <span class="toggle-label ${g.auto_reply ? 'on' : ''}">${g.auto_reply ? 'ON' : 'OFF'}</span></td>
    <td class="center">${g.type === 'custom' || g.left_group ? `<button class="link-danger" title="Remove from dashboard" data-del-group="${esc(g.jid)}">×</button>` : ''}</td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">${state.groups.length ? 'No groups match your filters.'
      : ['logged_out', 'qr'].includes(state.status?.whatsapp?.status) ? 'No WhatsApp number is linked. <b>Link WhatsApp</b> to see its groups.'
      : 'No groups yet. Press <b>Sync Live Groups</b>.'}</td></tr>`;
}
const syncGroups = guard(async () => {
  const btns = $$('[data-sync], [data-act=sync]'); btns.forEach(b => b.disabled = true);
  try { const r = await api('POST', '/api/groups/sync'); toast(`Synced ${r.count} groups from WhatsApp`); if (state.tab === 'groups') loadGroups(); }
  finally { btns.forEach(b => b.disabled = false); }
});
function openAddGroupModal() {
  const m = openModal(`<div class="modal-head"><h3>Add Custom Group</h3><button class="x" data-close>×</button></div>
    <div class="modal-body">
      <div class="seg" style="margin-bottom:20px"><button class="active" data-mode="id">Group ID / Phone</button><button data-mode="invite">Join via Invite Link</button></div>
      <div data-pane="id"><div class="field"><label>Display Name</label><input class="input" id="cgName" placeholder="e.g. Vapi Chemical Traders"></div>
        <div class="field"><label>WhatsApp Group ID or Phone Number</label><input class="input mono" id="cgJid" placeholder="120363xxxxxxxxxx@g.us  or  +91 98xxxxxxxx">
        <div class="help">Use a phone number to let the bot quote in a direct (1-to-1) chat too.</div></div></div>
      <div data-pane="invite" class="hidden"><div class="field"><label>Invite Link</label><input class="input mono" id="cgInvite" placeholder="https://chat.whatsapp.com/XXXXXXXX">
        <div class="help">The bot's number will join the group, and it appears here with auto-reply OFF.</div></div></div>
    </div>
    <div class="modal-foot"><div class="push"></div><button class="btn btn-light" data-close>Cancel</button><button class="btn btn-dark" id="cgSave">Add Group</button></div>`, { size: 'sm' });
  let mode = 'id';
  $$('.seg button', m.el).forEach(b => b.onclick = () => {
    mode = b.dataset.mode;
    $$('.seg button', m.el).forEach(x => x.classList.toggle('active', x === b));
    $$('[data-pane]', m.el).forEach(p => p.classList.toggle('hidden', p.dataset.pane !== mode));
  });
  $('#cgSave', m.el).onclick = guard(async () => {
    const body = mode === 'invite' ? { invite: $('#cgInvite', m.el).value } : { name: $('#cgName', m.el).value, jid: $('#cgJid', m.el).value };
    await api('POST', '/api/groups', body); m.close(); toast('Group added'); loadGroups();
  });
}

/* =========================================================== TEMPLATES */
const TPL_MODES = ['quote', 'deal', 'multi', 'multi_item', 'reminder'];
const EDITOR_LABEL = { multi: 'Message (wraps the product list)', multi_item: 'Product block — repeated for every product' };
const WRAPPER_VARS = ['business_name', 'contact_phone', 'sender_name', 'date', 'customer_location'];
const editorHtml = (target, label) => `<div class="editor" data-editor="${target}">
  ${label ? `<div class="editor-label">${label}</div>` : ''}
  <div class="editor-bar"><button data-wrap="*" title="Bold"><b>B</b></button><button data-wrap="_" title="Italic"><i>I</i></button><button data-wrap="~" title="Strikethrough"><s>S</s></button>
    <button data-wrap="\`\`\`" class="mono" title="Monospace">mono</button><span class="sep"></span><button data-divider>— Divider</button><span class="chars"></span></div>
  <textarea spellcheck="false" data-target="${target}"></textarea></div>`;
// which textareas belong to a mode (Multi-Product has two)
const targetsOf = mode => mode === 'multi' ? ['multi', 'multi_item'] : [mode];

async function loadTemplates() {
  if (!state.chemicals.length) state.chemicals = await api('GET', '/api/chemicals');
  const data = await api('GET', '/api/templates');
  state.tpl = data;
  for (const k of TPL_MODES) if (state.tplDraft[k] === undefined) state.tplDraft[k] = data.templates[k];
  if (!state.sampleChem && state.chemicals.length) state.sampleChem = (state.chemicals.find(c => c.origin_rates.length > 1) || state.chemicals[0]).id;
  const v = $('#view-templates');
  if (!v.dataset.ready) {
    v.innerHTML = `<div class="card">
      <div class="tpl-top"><span class="label-caps">Template Mode:</span>
        <div class="seg" id="tplMode"><button data-mode="quote" class="active">📦 Price Quotation</button><button data-mode="deal">🤝 Deal &amp; Negotiation</button><button data-mode="multi">🧾 Multi-Product</button><button data-mode="reminder">🔔 Payment Reminder</button></div>
        <div class="spacer"></div>
        <button class="btn btn-amber" id="tplSave">${ICON.save} Save Template</button><button class="btn btn-light" id="tplReset">Reset Default</button></div>
      <div class="tpl-grid">
        <div class="tpl-left">
          <div class="sec-head"><span class="label-caps">Quick Presets</span><span class="hint">Click to apply formatting</span></div>
          <div class="chips" id="tplPresets" style="gap:10px"></div>
          <div class="sec-head" style="margin-top:26px"><span class="label-caps">Dynamic Variables (click to insert)</span><span class="hint" id="tplVarsHint">Substituted live per chemical</span></div>
          <div class="chips" id="tplVars" style="gap:8px"></div>
          <div id="tplEditors"></div>
          <div class="tip" id="tplTip"></div>
        </div>
        <div class="tpl-right">
          <div class="sec-head" style="align-items:center"><span class="label-caps" style="color:var(--green-ink)">● WhatsApp Live Preview</span>
            <select class="input" id="tplSample" style="max-width:300px"></select></div>
          <div class="phone"><div class="phone-head"><div class="av">${esc((state.settings?.business_name || 'P')[0])}</div><div><b>Chemical Traders Group</b><small>tap here for group info</small></div></div>
            <div class="phone-body">
              <div class="bubble"><div class="who">Broker</div><textarea class="bubble-input" id="tplMsg" rows="2" title="Edit this message to test what the bot understands"></textarea><div class="meta">11:42 AM</div></div>
              <div id="tplReplies"></div>
            </div></div>
          <div class="analysis" id="tplAnalysis"></div>
          <p class="muted" style="font-size:14.5px;margin-top:16px">💬 <b>Live Preview Note:</b> Edits in the textarea render in real time inside the bubble. Type your own message in the grey bubble to test exactly what the bot understands — nothing is sent.</p>
        </div>
      </div></div>`;
    v.dataset.ready = 1;
    $('#tplMode').onclick = e => { const b = e.target.closest('button'); if (b) setTplMode(b.dataset.mode); };
    const eds = $('#tplEditors');
    eds.addEventListener('input', e => {
      const t = e.target.closest('textarea[data-target]'); if (!t) return;
      state.tplDraft[t.dataset.target] = t.value; state.tplPreset[state.tplMode] = null;
      $$('#tplPresets .preset').forEach(b => b.classList.remove('active'));
      renderTplMeta(); preview();
    });
    eds.addEventListener('focusin', e => { const t = e.target.closest('textarea[data-target]'); if (t && t.dataset.target !== state.tplFocus) { state.tplFocus = t.dataset.target; renderTplVars(); } });
    eds.addEventListener('click', e => {
      const ed = e.target.closest('[data-editor]'); if (!ed) return;
      const w = e.target.closest('[data-wrap]')?.dataset.wrap;
      if (w) { state.tplFocus = ed.dataset.editor; wrapSelection(w); }
      if (e.target.closest('[data-divider]')) { state.tplFocus = ed.dataset.editor; insertAtCursor('\n━━━━━━━━━━━━━━━━\n'); }
    });
    $('#tplPresets').onclick = e => {
      const b = e.target.closest('[data-preset]'); if (!b) return;
      const p = state.tpl.presets[state.tplMode].find(x => x.id === b.dataset.preset);
      state.tplDraft[state.tplMode] = p.body;
      if (state.tplMode === 'multi') state.tplDraft.multi_item = p.item;
      state.tplPreset[state.tplMode] = p.id; renderTplEditor();
    };
    $('#tplVars').onclick = e => { const b = e.target.closest('[data-var]'); if (b) insertAtCursor(`{${b.dataset.var}}`); };
    $('#tplSample').onchange = e => { state.sampleChem = Number(e.target.value); setSampleMessage(); };
    $('#tplMsg').oninput = e => { state.sampleMsg = e.target.value; preview(); };
    $('#tplSave').onclick = guard(async () => {
      const dirty = targetsOf(state.tplMode).filter(t => state.tplDraft[t] !== state.tpl.templates[t]);
      if (!dirty.length) return toast('No changes to save');
      for (const t of dirty) { await api('PUT', `/api/templates/${t}`, { body: state.tplDraft[t] }); state.tpl.templates[t] = state.tplDraft[t]; }
      renderTplMeta(); toast('Template saved — the bot uses it from the next message');
    });
    $('#tplReset').onclick = guard(async () => {
      if (!await confirmBox('Reset to default?', 'Your saved template for this mode will be replaced with the default.', 'Reset')) return;
      for (const t of targetsOf(state.tplMode)) {
        const r = await api('POST', `/api/templates/${t}/reset`);
        state.tpl.templates[t] = r.body; state.tplDraft[t] = r.body;
      }
      state.tplPreset[state.tplMode] = null; renderTplEditor(); toast('Template reset to default');
    });
  }
  $('#tplSample').innerHTML = state.chemicals.map(c => `<option value="${c.id}" ${c.id === state.sampleChem ? 'selected' : ''}>Sample: ${esc(c.name)}${c.alias_list[0] ? ` (${esc(c.alias_list[0].toUpperCase())})` : ''}</option>`).join('');
  setTplMode(state.tplMode, !!state.sampleMsg);
}
function setTplMode(mode, keepMessage = false) {
  state.tplMode = mode;
  state.tplFocus = targetsOf(mode)[0];
  $$('#tplMode button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('#tplPresets').innerHTML = state.tpl.presets[mode].map(p => `<button class="preset ${state.tplPreset[mode] === p.id ? 'active' : ''}" data-preset="${p.id}">${esc(p.label)}</button>`).join('');
  $('#tplEditors').innerHTML = mode === 'multi' ? editorHtml('multi', EDITOR_LABEL.multi) + editorHtml('multi_item', EDITOR_LABEL.multi_item) : editorHtml(mode);
  const isRem = mode === 'reminder';
  $('.phone-body .bubble:not(.out)', $('#view-templates'))?.classList.toggle('hidden', isRem);
  $('#tplSample').classList.toggle('hidden', isRem);
  $('#tplTip').innerHTML = isRem
    ? `💡 <b>Payment reminders</b> are sent for Pending orders in the chat where the order was placed — first on day ${(state.settings?.default_credit_days || 30) - (state.settings?.reminder_days_before_due ?? 2)}, then every ${state.settings?.reminder_repeat_days || 2} days until you mark the order Paid (timing in Settings).
       <code>{mention}</code> tags the buyer in groups and is hidden in private chats. <code>{due_status}</code> changes by itself: “due in 2 days”, “due today”, “4 days overdue”. Lines with an empty variable (e.g. no invoice number) are hidden.`
    : mode === 'multi'
    ? `💡 <b>How multi-product replies work:</b> when one message asks for 2 or more products (e.g. <i>“PA 2 MT, MA China 5 MT, IPA 20 drums”</i>), the bot sends <b>one</b> message. The <b>Product block</b> is filled in for every product with its own quantity and origin, and all blocks go where you put <code>{items}</code>.
       <code>{unavailable}</code> lists anything not in your matrix as “Will check &amp; revert”, and <code>{deal_note}</code> appears only when the buyer is negotiating. Lines with an empty variable are hidden. Prefer one message per product? Change it in Settings.`
    : `💡 <b>Formatting Tip:</b> Use <code>*bold*</code> for product/rates and <code>_italic_</code> for notes. Any line whose variable is empty is hidden automatically — so when <code>{requirement}</code> is in your template and the customer doesn’t mention a quantity, that line simply disappears.
       <br><br><b>When is each mode used?</b> The bot sends <b>Price Quotation</b> for normal single-product enquiries and <b>Deal &amp; Negotiation</b> when the message contains negotiation words like <i>last rate, best price, discount, target, kam</i> (edit the list in Settings). Enquiries for several products use <b>Multi-Product</b>.`;
  if (!keepMessage) setSampleMessage(); else $('#tplMsg').value = state.sampleMsg;
  renderTplVars();
  renderTplEditor();
}
function renderTplVars() {
  const f = state.tplFocus;
  let vars;
  if (f === 'reminder') vars = state.tpl.reminderVariables;
  else if (f === 'multi') vars = [...state.tpl.multiVariables.filter(x => x.for === 'multi'), ...state.tpl.variables.filter(x => WRAPPER_VARS.includes(x.key))];
  else if (f === 'multi_item') vars = [...state.tpl.multiVariables.filter(x => x.for === 'multi_item'), ...state.tpl.variables];
  else vars = state.tpl.variables;
  $('#tplVars').innerHTML = vars.map(x => `<button class="var-chip" data-var="${x.key}" title="${esc(x.hint)}">+ {${x.key}}</button>`).join('');
  $('#tplVarsHint').textContent = f === 'reminder' ? 'Filled in from each order' : f === 'multi' ? 'For the message around the list' : f === 'multi_item' ? 'For each product block' : 'Substituted live per chemical';
}
function setSampleMessage() {
  if (state.tplMode === 'reminder') { preview(); return; }
  const codeOf = c => (c.alias_list.find(a => a.replace(/\./g, '').length <= 4) || c.name).replace(/\./g, '').toUpperCase();
  const c = state.chemicals.find(x => x.id === state.sampleChem);
  if (!c) return;
  const code = codeOf(c);
  if (state.tplMode === 'multi') {
    const others = state.chemicals.filter(x => x.id !== c.id).slice(0, 2);
    const origin = c.origin_rates[0]?.country ? ` ${c.origin_rates[0].country}` : '';
    state.sampleMsg = [`Need rates Bhiwandi:`, `1. ${code}${origin} 2 MT`, ...others.map((o, k) => `${k + 2}. ${codeOf(o)} ${k ? '20 drums' : '5 MT'}`), `${others.length + 2}. DOP 1 tanker`].join('\n');
  } else {
    state.sampleMsg = state.tplMode === 'deal' ? `${code} last rate kya hai? 10 ton Vapi` : `${code} 2 ton Bhiwandi rate urgent chahiye`;
  }
  $('#tplMsg').value = state.sampleMsg;
  $('#tplMsg').rows = Math.min(7, state.sampleMsg.split('\n').length + 1);
  preview();
}
function renderTplEditor() {
  for (const t of targetsOf(state.tplMode)) { const ta = $(`#tplEditors textarea[data-target="${t}"]`); if (ta) ta.value = state.tplDraft[t]; }
  $$('#tplPresets .preset').forEach(b => b.classList.toggle('active', state.tplPreset[state.tplMode] === b.dataset.preset));
  renderTplMeta(); preview();
}
function renderTplMeta() {
  let dirty = false;
  for (const t of targetsOf(state.tplMode)) {
    const d = state.tplDraft[t] ?? '';
    if (d !== state.tpl.templates[t]) dirty = true;
    const ch = $(`#tplEditors [data-editor="${t}"] .chars`); if (ch) ch.textContent = `${d.length} chars`;
  }
  $('#tplSave').innerHTML = `${ICON.save} Save Template${dirty ? '<span class="dirty-dot" title="Unsaved changes"></span>' : ''}`;
}
const activeTextarea = () => $(`#tplEditors textarea[data-target="${state.tplFocus}"]`) || $('#tplEditors textarea');
function insertAtCursor(text) {
  const ta = activeTextarea(); const { selectionStart: s, selectionEnd: e, value } = ta;
  ta.value = value.slice(0, s) + text + value.slice(e); ta.focus(); ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
function wrapSelection(mark) {
  const ta = activeTextarea(); const { selectionStart: s, selectionEnd: e, value } = ta;
  const sel = value.slice(s, e) || 'text';
  ta.value = value.slice(0, s) + mark + sel + mark + value.slice(e); ta.focus();
  ta.selectionStart = s + mark.length; ta.selectionEnd = s + mark.length + sel.length;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
const preview = debounce(guard(async () => {
  if (state.tplMode === 'reminder') {
    const r = await api('POST', '/api/reminder-preview', { body: state.tplDraft.reminder });
    const now = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    $('#tplReplies').innerHTML = `<div class="bubble out">${waFormat(r.text)}<div class="meta">${now} <span class="ticks">✓✓</span></div></div>`;
    $('#tplAnalysis').innerHTML = '<span class="faint" style="font-size:13.5px">Sample: order for Phthalic Anhydride, 2 MT, ₹2,56,000 — day 28 of 30.</span>';
    return;
  }
  const overrides = Object.fromEntries(TPL_MODES.map(m => [m, state.tplDraft[m]]).filter(([, v]) => typeof v === 'string'));
  const r = await api('POST', '/api/simulate', { message: state.sampleMsg, overrides, forceMode: state.tplMode });
  const now = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const a = r.analysis;
  $('#tplReplies').innerHTML = r.replies.length
    ? r.replies.map(x => `<div class="bubble out">${waFormat(x.text)}<div class="meta">${now} <span class="ticks">✓✓</span></div></div>`).join('')
    : r.unmatchedReply ? `<div class="bubble out">${waFormat(r.unmatchedReply)}<div class="meta">${now} <span class="ticks">✓✓</span></div></div>`
    : `<div class="skip-note">🤫 The bot would <b>not reply</b> to this message${a.skipReason ? ` — ${esc(a.skipReason)}` : a.isRequest ? ' — no chemical from your matrix was recognised' : ''}.</div>`;
  const chips = [];
  a.chemicals.forEach(c => chips.push(`<span class="badge b-green">🧪 ${esc(c.name)}${c.quantity ? ` · ${esc(c.quantity)}` : ''}${c.origins.length ? ` · ${esc(c.origins.join('/'))}` : ''}${c.how !== 'exact' ? ` · ${c.how}` : ''}</span>`));
  (a.unmatchedItems || []).forEach(u => chips.push(`<span class="badge b-red" title="Not in your rates matrix">❓ ${esc(u.name)}${u.quantity ? ` · ${esc(u.quantity)}` : ''}</span>`));
  if (a.location) chips.push(`<span class="badge b-violet">📍 ${esc(a.location)}</span>`);
  if (a.isRequest) {
    const multi = r.replies.some(x => x.kind === 'multi');
    chips.push(`<span class="badge ${a.intent === 'deal' ? 'b-amber' : 'b-gray'}">${multi ? `🧾 ${r.replies[0].chemicals.length} products → one message` : a.intent === 'deal' ? '🤝 Negotiation → Deal template' : '📦 Enquiry → Price Quotation'}</span>`);
    if (multi && a.intent === 'deal') chips.push('<span class="badge b-amber">🤝 negotiating → deal note shown</span>');
  }
  $('#tplAnalysis').innerHTML = chips.length ? `<span class="faint" style="font-size:13.5px;align-self:center">Bot understood:</span>${chips.join('')}` : '';
}), 220);

/* =========================================================== ORDERS & DECISIONS */
async function loadOrders() {
  const qs = new URLSearchParams({ status: state.orderFilter.status, q: state.orderFilter.q, ...(state.orderFilter.batch ? { batch: state.orderFilter.batch } : {}) });
  state.orders = await api('GET', `/api/inquiries?${qs}`);
  const v = $('#view-orders');
  if (!v.dataset.ready) {
    v.innerHTML = `<div class="stats" id="ordStats"></div>
      <div class="card">
        <div class="banner info">🧑‍💼 <div><b>You make the final call.</b> The bot only sends indicative quotes. Every enquiry it answers lands here — confirm, negotiate, hold or reject it yourself, and optionally reply in the group from this screen.</div></div>
        <div class="toolbar"><div class="status-pills" id="ordPills"></div><div class="spacer"></div>
          <div class="search" style="max-width:340px">${ICON.search}<input class="input" id="ordSearch" placeholder="Search message, chemical, group, phone…"></div></div>
        <div class="table-wrap"><table class="data"><thead><tr><th>Received</th><th>Group &amp; Sender</th><th>Message</th><th>Chemical / Qty</th><th>Quoted</th><th>Decision</th><th></th></tr></thead>
        <tbody id="ordRows"></tbody></table></div></div>`;
    v.dataset.ready = 1;
    $('#ordPills').onclick = e => {
      if (e.target.closest('[data-clear-batch]')) { delete state.orderFilter.batch; state.orderFilter.status = 'open'; return loadOrders(); }
      const b = e.target.closest('[data-st]'); if (b) { state.orderFilter.status = b.dataset.st; delete state.orderFilter.batch; loadOrders(); }
    };
    $('#ordSearch').oninput = debounce(e => { state.orderFilter.q = e.target.value; loadOrders(); }, 300);
    $('#ordRows').addEventListener('change', guard(async e => {
      const sel = e.target.closest('select[data-status]'); if (!sel) return;
      await api('PATCH', `/api/inquiries/${sel.dataset.status}`, { status: sel.value }); toast(`Marked as ${sel.value}`); loadOrders(); pollStatus();
    }));
    $('#ordRows').addEventListener('click', e => {
      const po = e.target.closest('[data-pay-order]')?.dataset.payOrder; if (po) return openPaymentOrderModal(Number(po));
      const rec = e.target.closest('[data-record]')?.dataset.record;
      if (rec) return openPaymentOrderModal(null, state.orders.items.find(x => x.id === Number(rec)));
      const id = e.target.closest('[data-open]')?.dataset.open; if (id) openOrderModal(Number(id));
      const b = e.target.closest('[data-batch]')?.dataset.batch;
      if (b) { state.orderFilter = { status: 'all', q: '', batch: b }; $('#ordSearch').value = ''; loadOrders(); }
    });
  }
  const s = state.orders.stats;
  $('#ordStats').innerHTML = [
    ['Enquiries today', s.today], ['Quotes sent today', s.quotedToday], ['Open (needs decision)', s.pending, 'hl'], ['Negotiating', s.negotiating, 'hl'],
    ['Confirmed (30 days)', s.confirmed], ['Unmatched requests', s.unmatched],
  ].map(([k, v, c]) => `<div class="stat ${c || ''}"><div class="k">${k}</div><div class="v">${v ?? 0}</div></div>`).join('');
  const pills = [['open', 'Open'], ['all', 'All'], ['payment_pending', `💰 Payment pending${s.paymentPending ? ` (${s.paymentPending})` : ''}`], ...state.orders.statuses.map(x => [x, x])];
  $('#ordPills').innerHTML = state.orderFilter.batch
    ? `<span class="spill active">🧾 Showing one multi-product enquiry</span><button class="spill" data-clear-batch>✕ Back to all</button>`
    : pills.map(([k, l]) => `<button class="spill ${state.orderFilter.status === k ? 'active' : ''}" data-st="${esc(k)}">${esc(l)}</button>`).join('');
  const items = state.orders.items;
  $('#ordRows').innerHTML = items.length ? items.map(i => `<tr>
    <td style="white-space:nowrap">${fmtTime(i.created_at)}</td>
    <td><div style="font-weight:600">${esc(i.group_name || '—')}</div><div class="sub">${esc(i.sender_name || '')} ${i.sender_phone ? `· ${esc(i.sender_phone)}` : ''}</div></td>
    <td class="msg-cell"><div class="txt">${esc(i.message)}</div></td>
    <td>${i.chemical_name ? `<div style="font-weight:600">${esc(i.chemical_name)}</div>` : `<span class="badge b-gray">Not in matrix</span>${i.requested_text ? ` <b>${esc(i.requested_text)}</b>` : ''}`}<div class="sub">${esc([i.quantity, i.location, i.origin].filter(Boolean).join(' · '))}</div>
      ${i.batch_size > 1 ? `<button class="link-btn batch-link" data-batch="${esc(i.batch_key)}" title="Show all products from this message">🧾 ${i.batch_size}-product enquiry</button>` : ''}</td>
    <td style="max-width:220px"><div class="sub" style="color:var(--ink-2)">${esc(i.quoted_rate || '—')}</div>${i.final_rate ? `<div class="stock-note">Final: ${esc(i.final_rate)}</div>` : ''}</td>
    <td><select class="input status-select badge ${ORDER_CLASS[i.status] || 'b-gray'}" data-status="${i.id}">${state.orders.statuses.map(s => `<option ${s === i.status ? 'selected' : ''}>${s}</option>`).join('')}</select>${paymentBadge(i, state.orders.today)}</td>
    <td><button class="btn btn-light btn-sm" data-open="${i.id}">Open</button></td></tr>`).join('')
    : `<tr><td colspan="7" class="empty">No enquiries here yet. They appear automatically when someone asks for a rate in a group with auto-reply ON.</td></tr>`;
}

function openOrderModal(id) {
  const i = state.orders.items.find(x => x.id === id); if (!i) return;
  const quick = [
    ['✅ Confirm', () => `✅ *Order Confirmed*\n${i.chemical_name || ''}${$('#oQty').value ? ` – ${$('#oQty').value}` : ''}${$('#oRate').value ? `\nRate: ${$('#oRate').value}` : ''}\nOur team will share dispatch details shortly. 🙏`],
    ['📞 Call me', () => `Thanks for the enquiry 🙏 Please call ${state.settings?.contact_phone || 'us'} to finalise the best rate.`],
    ['❌ Regret', () => `Sorry, we can't offer at this rate right now. We'll update you if anything changes. 🙏`],
  ];
  const m = openModal(`<div class="modal-head"><h3>Enquiry #${i.id} · ${esc(i.chemical_name || (i.requested_text ? `${i.requested_text} (not in matrix)` : 'Unmatched request'))}</h3><button class="x" data-close>×</button></div>
    <div class="modal-body">
      <div class="grid2">
        <div>
          <span class="flabel">Customer message</span>
          <div class="wa-preview"><div class="bubble" style="max-width:100%;margin:0"><div class="who">${esc(i.sender_name || '')} ${esc(i.sender_phone || '')}</div>${waFormat(i.message)}<div class="meta">${fmtTime(i.created_at)} · ${esc(i.group_name || '')}</div></div>
          ${i.quote_text ? `<div class="bubble out" style="max-width:100%;margin:12px 0 0">${waFormat(i.quote_text)}<div class="meta">Bot · ${i.intent === 'deal' ? 'Deal template' : 'Price Quotation'}</div></div>` : ''}</div>
        </div>
        <div>
          <span class="flabel">Owner decision</span>
          <div class="decide" style="margin-bottom:16px">${['Confirmed', 'Negotiating', 'Awaiting Owner', 'On Hold', 'Rejected', 'Dispatched'].map(s => `<button class="btn btn-sm ${i.status === s ? 'btn-dark' : 'btn-light'}" data-set="${s}">${s}</button>`).join('')}</div>
          <div class="grid2"><div class="field"><label>Final Rate</label><input class="input" id="oRate" value="${esc(i.final_rate || '')}" placeholder="₹106 / kg + GST"></div>
          <div class="field"><label>Final Qty</label><input class="input" id="oQty" value="${esc(i.final_qty || i.quantity || '')}" placeholder="2 MT"></div></div>
          <div class="field"><label>Notes (private)</label><textarea class="input" id="oNotes" rows="3" placeholder="Payment terms, delivery date, buyer details…">${esc(i.owner_notes || '')}</textarea></div>
          <button class="btn btn-dark btn-sm" id="oSave">Save decision</button>
          ${i.order ? `<div style="margin-top:12px">${paymentBadge(i)} <button class="btn btn-light btn-sm" id="oOpenOrder">Open order #${i.order.order_id}</button></div>`
            : `<button class="btn btn-green btn-sm" id="oRecord" title="Saves the order and starts payment tracking & reminders">📦 Record order &amp; track payment</button>`}
        </div>
      </div>
      <hr style="border:0;border-top:1px solid var(--line);margin:24px 0">
      <div class="grid2">
        <div><span class="flabel">Reply in the group (as the bot number)</span>
          <div class="chips" style="margin-bottom:8px">${quick.map((q, k) => `<button class="btn btn-light btn-sm" data-quick="${k}">${q[0]}</button>`).join('')}</div>
          <textarea class="input" id="oMsg" rows="4" placeholder="Type a message… it will be sent quoting the customer's original message."></textarea>
          <div style="margin-top:10px"><button class="btn btn-green btn-sm" id="oSend" ${i.group_jid ? '' : 'disabled'}>Send in group</button></div></div>
        <div><span class="flabel">History</span><div class="timeline">${i.history.map(timelineEvent).join('')}</div></div>
      </div>
    </div>
    <div class="modal-foot"><button class="link-danger" id="oDel" style="font-size:15px">Delete enquiry</button><div class="push"></div><button class="btn btn-light" data-close>Close</button></div>`, { size: 'lg' });

  const save = async extra => {
    const body = { final_rate: $('#oRate', m.el).value, final_qty: $('#oQty', m.el).value, owner_notes: $('#oNotes', m.el).value, ...extra };
    const r = await api('PATCH', `/api/inquiries/${i.id}`, body);
    Object.assign(i, r); await loadOrders(); pollStatus(); return r;
  };
  $$('[data-set]', m.el).forEach(b => b.onclick = guard(async () => { await save({ status: b.dataset.set }); toast(`Marked as ${b.dataset.set}`); openOrderModal(i.id); }));
  $('#oSave', m.el).onclick = guard(async () => { await save({}); toast('Decision saved'); openOrderModal(i.id); });
  $('#oOpenOrder', m.el)?.addEventListener('click', () => openPaymentOrderModal(i.order.order_id));
  $('#oRecord', m.el) && ($('#oRecord', m.el).onclick = () => openPaymentOrderModal(null, { ...i, final_rate: $('#oRate', m.el).value, final_qty: $('#oQty', m.el).value }));
  $$('[data-quick]', m.el).forEach(b => b.onclick = () => { $('#oMsg', m.el).value = quick[Number(b.dataset.quick)][1](); });
  $('#oSend', m.el).onclick = guard(async () => {
    const text = $('#oMsg', m.el).value.trim(); if (!text) throw new Error('Type a message first');
    const r = await api('POST', `/api/inquiries/${i.id}/message`, { text }); Object.assign(i, r); toast('Sent in group'); await loadOrders(); openOrderModal(i.id);
  });
  $('#oDel', m.el).onclick = guard(async () => {
    if (!await confirmBox('Delete enquiry?', 'This removes the record from the dashboard.', 'Delete')) return openOrderModal(i.id);
    await api('DELETE', `/api/inquiries/${i.id}`); toast('Deleted'); loadOrders();
  });
}

/* =========================================================== JOIN QR */
let joinTimer = null, joinRefresh = null;
async function loadJoin() {
  const [join, groups] = await Promise.all([api('GET', '/api/join'), api('GET', '/api/groups')]);
  state.join = join; state.groups = groups;
  const v = $('#view-join');
  const url = `${location.origin}/join/${join.token}`;
  const candidates = groups.filter(g => !g.join_qr && !g.left_group && g.jid.endsWith('@g.us')).sort((a, b) => b.is_admin - a.is_admin);
  v.innerHTML = `<div class="card">
    <div class="banner info">🔄 <div><b>Rotating join QR:</b> every <b>${join.minutes} minutes</b> the bot revokes each selected group's invite link and creates a new one, so old screenshots and forwarded links stop working. The bot's number must be an <b>admin</b> of the group.</div></div>
    <div class="toolbar">
      <div style="flex:1;min-width:280px"><span class="flabel">Public QR page (no login needed — put it on a screen or your website)</span>
        <div class="copy-row"><input class="input" readonly value="${esc(url)}" id="joinUrl"><button class="btn btn-light btn-sm" id="copyJoin">Copy</button>
        <a class="btn btn-light btn-sm" href="${esc(url)}" target="_blank" rel="noopener">Open</a><button class="btn btn-light btn-sm" id="newToken" title="Old page link stops working">New link</button></div></div>
      <div style="min-width:280px"><span class="flabel">Add a group to the QR page</span>
        <div class="copy-row"><select class="input" id="joinPick">${candidates.length ? candidates.map(g => `<option value="${esc(g.jid)}">${g.is_admin ? '★ ' : ''}${esc(g.name)}</option>`).join('') : '<option value="">No groups — sync first</option>'}</select>
        <button class="btn btn-dark btn-sm" id="joinAdd" ${candidates.length ? '' : 'disabled'}>Add</button></div><div class="help faint" style="font-size:13px;margin-top:4px">★ = bot is admin</div></div>
    </div>
    <div class="qr-grid" id="joinGrid">${join.groups.length ? join.groups.map(g => `<div class="qr-card">
      ${g.qr ? `<img src="${g.qr}" alt="Join QR for ${esc(g.name)}">` : `<div class="ph-qr">${state.status?.whatsapp?.status === 'open' ? 'Creating invite link…' : 'Connect WhatsApp to create the invite link'}</div>`}
      <h4>${esc(g.name)}</h4><div class="sub">${g.members || 0} members</div>
      ${g.error ? `<div class="err">${esc(g.error)}</div>` : ''}
      ${g.expiresAt && g.qr ? `<p style="margin:10px 0">New QR in <span class="countdown" data-exp="${g.expiresAt}">--:--</span></p>` : ''}
      ${g.link ? `<div class="copy-row" style="margin-bottom:10px"><input class="input" readonly value="${esc(g.link)}"></div>` : ''}
      <div class="chips" style="justify-content:center"><button class="btn btn-light btn-sm" data-rotate="${esc(g.jid)}">Rotate now</button><button class="btn btn-danger-soft btn-sm" data-unjoin="${esc(g.jid)}">Remove</button></div>
    </div>`).join('') : `<div class="empty" style="grid-column:1/-1">No groups on the QR page yet. Pick a group above (ideally one where the bot is admin) and press <b>Add</b>.</div>`}</div></div>`;
  $('#copyJoin').onclick = () => { navigator.clipboard?.writeText(url); toast('Link copied'); };
  $('#newToken').onclick = guard(async () => {
    if (!await confirmBox('Create a new page link?', 'The current public QR page link will stop working.', 'Create new link')) return;
    await api('POST', '/api/join/token'); loadJoin();
  });
  $('#joinAdd').onclick = guard(async () => {
    const jid = $('#joinPick').value; if (!jid) return;
    await api('PATCH', `/api/groups/${encodeURIComponent(jid)}`, { join_qr: true }); toast('Group added to the QR page'); loadJoin();
  });
  $('#joinGrid').onclick = guard(async e => {
    const r = e.target.closest('[data-rotate]')?.dataset.rotate;
    const u = e.target.closest('[data-unjoin]')?.dataset.unjoin;
    if (r) { await api('POST', `/api/join/${encodeURIComponent(r)}/rotate`); toast('New invite link created'); loadJoin(); }
    if (u) { await api('PATCH', `/api/groups/${encodeURIComponent(u)}`, { join_qr: false }); loadJoin(); }
  });
  clearInterval(joinTimer); clearInterval(joinRefresh);
  const tick = () => $$('.countdown').forEach(el => {
    const ms = Date.parse(el.dataset.exp) - Date.now();
    el.textContent = ms > 0 ? `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}` : 'refreshing…';
  });
  tick(); joinTimer = setInterval(tick, 1000);
  joinRefresh = setInterval(() => { if (state.tab === 'join' && !$('#modalRoot').innerHTML) guard(loadJoin)(); else if (state.tab !== 'join') { clearInterval(joinTimer); clearInterval(joinRefresh); } }, 20000);
}

/* =========================================================== SETTINGS */
async function loadSettings() {
  const { settings: s, envLocked = [], aiKeyPresent } = await api('GET', '/api/settings');
  state.settings = s;
  const num = (k, label, help = '') => `<div class="field"><label>${label}</label><input class="input" type="number" min="0" name="${k}" value="${esc(s[k])}">${help ? `<div class="help">${help}</div>` : ''}</div>`;
  const txt = (k, label, help = '', ta = false) => {
    const locked = envLocked.includes(k);
    const h = locked ? 'Set in your <code>.env</code> file — edit it there and restart the app.' : help;
    return `<div class="field"><label>${label}</label>${ta ? `<textarea class="input" rows="3" name="${k}">${esc(s[k])}</textarea>` : `<input class="input" name="${k}" value="${esc(s[k])}" ${locked ? 'readonly disabled' : ''}>`}${h ? `<div class="help">${h}</div>` : ''}</div>`;
  };
  const chk = (k, label) => `<label class="check" style="margin-bottom:14px"><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''}> ${label}</label>`;
  $('#view-settings').innerHTML = `<form id="setForm" class="settings-grid">
    <div class="card card-pad"><h3>Business details</h3>
      ${txt('business_name', 'Business Name')}${txt('contact_phone', 'Contact Phone', 'Used in {contact_phone} in your templates. Tip: set CONTACT_PHONE in .env instead.')}
      ${txt('default_location', 'Default Dispatch Location')}${num('default_gst', 'Default GST %')}</div>
    <div class="card card-pad"><h3>Bot behaviour &amp; safety</h3>
      <div class="grid2">${num('cooldown_minutes', 'Cooldown (minutes)', 'Same person + same chemical in a group')}${num('group_max_replies_per_10min', 'Max replies / group / 10 min')}
      ${num('reply_delay_min_sec', 'Reply delay min (sec)')}${num('reply_delay_max_sec', 'Reply delay max (sec)')}
      ${num('max_products_per_message', 'Max products quoted per message')}${num('max_message_length', 'Ignore messages longer than', 'Long posts are usually price lists')}</div>
      ${num('invite_rotate_minutes', 'Join QR rotation (minutes)', 'Minimum 2. Default 10.')}
      <div class="field"><label>Multi-product enquiries</label><select class="input" name="multi_reply_style">
        <option value="combined" ${s.multi_reply_style !== 'separate' ? 'selected' : ''}>One combined message for all products (recommended)</option>
        <option value="separate" ${s.multi_reply_style === 'separate' ? 'selected' : ''}>A separate message per product</option></select>
        <div class="help">E.g. “PA 2 MT, MA 5 MT, IPA 20 drums”. Edit the combined layout in Reply Templates → Multi-Product.</div></div>
      ${chk('reply_to_own_messages', '<b>Test mode:</b> also reply to messages typed on the bot’s own phone')}
      <div class="help" style="margin:-8px 0 14px">Normally the bot ignores its own number. Turn this on only while testing from the linked phone, then switch it off.</div>
      ${chk('quote_out_of_stock', 'Still quote chemicals marked “Out of Stock”')}
      ${chk('reply_unmatched', 'Reply when someone asks for a chemical that isn’t in the matrix')}
      ${txt('unmatched_reply', 'Reply for unmatched requests', '', true)}</div>
    <div class="card card-pad"><h3>Understanding messages</h3>
      ${txt('deal_keywords', 'Negotiation words → Deal & Negotiation template', 'Comma-separated. Phrases allowed.', true)}
      ${txt('ignore_keywords', 'Seller-post words → bot stays silent', 'Messages offering material for sale are ignored unless they also say need/required/chahiye.', true)}
      <h3 style="margin-top:8px">AI fallback (optional)</h3>
      ${chk('ai_enabled', 'Use Claude to recognise chemicals the rules miss (typos, trade names)')}
      ${txt('ai_model', 'Model')}
      <div class="help" style="margin-top:-8px">${aiKeyPresent ? '<span class="badge b-green">API key found</span>' : '<span class="badge b-gray">No ANTHROPIC_API_KEY in .env — AI fallback stays off</span>'} AI only picks the chemical; prices always come from your matrix.</div></div>
    <div class="card card-pad"><h3>Security</h3>
      <div class="field"><label>Current password</label><input class="input" type="password" id="pwCur" autocomplete="current-password"></div>
      <div class="field"><label>New password</label><input class="input" type="password" id="pwNew" autocomplete="new-password" placeholder="At least 8 characters"></div>
      <button type="button" class="btn btn-dark btn-sm" id="pwSave">Change password</button>
      <p class="muted" style="font-size:14px">Changing the password logs out every other session.</p>
      <button type="button" class="btn btn-danger-soft btn-sm" id="logoutAll">Log out all devices</button>
      <h3 style="margin-top:22px">WhatsApp account</h3>
      <button type="button" class="btn btn-light btn-sm" id="openConn">Connection &amp; QR</button></div>
    <div class="card card-pad" style="grid-column:1/-1"><h3>Orders &amp; payment reminders</h3>
      ${chk('payment_reminders_enabled', '<b>Send payment reminders</b> for Pending orders (in the group or private chat where the order was placed)')}
      <div class="grid3">${num('default_credit_days', 'Default credit days', 'Payment period for new orders.')}
        ${num('reminder_days_before_due', 'First reminder … days before due', '2 → day 28 of 30.')}
        ${num('reminder_repeat_days', 'Then repeat every … days', '2 = every other day, until Paid.')}
        ${num('reminder_hour_ist', 'Send from (hour, India time)', '0–23. Default 11 = 11 AM.')}</div>
      ${txt('order_keywords', 'Order words → hand over to you', 'When a buyer who just got a quote writes one of these (e.g. “confirm”, “book”, “PO”), the bot stays quiet and flags it in Orders &amp; Decisions.', true)}
      <div class="help" style="margin-top:-6px">⚠️ Reminders are messages the bot starts on its own, which WhatsApp watches more closely than replies. Keep the bot on a separate number.</div></div>
    <div class="card card-pad" style="grid-column:1/-1"><h3>Database backups</h3>
      <p class="muted" style="margin-top:-6px">A copy of everything — chemicals, rates, templates, groups, orders, payments and settings — is saved automatically every day, and checked before it's kept.
        The WhatsApp login is not included; after restoring a backup, just scan the QR again.</p>
      <div id="offsiteBox" class="offsite-box"></div>
      <div class="grid3">${num('offsite_every_hours', 'Off-site copy every … hours', '0 = off. Default 1 = hourly.')}${num('backup_hour_ist', 'Daily backup time (hour, India time)', '0–23. Default 3 = 3 AM.')}${num('backup_keep_days', 'Keep last … daily backups', 'Older ones are deleted automatically.')}
        <div class="field"><label>&nbsp;</label><button type="button" class="btn btn-dark btn-sm" id="backupNow">Back up now</button></div></div>
      <div class="table-wrap" style="max-height:300px;border:1px solid var(--line);border-radius:12px"><table class="data"><thead><tr><th>Backup</th><th>Size</th><th>Created</th><th></th></tr></thead><tbody id="backupRows"></tbody></table></div>
      <p class="muted" style="font-size:14px;margin-bottom:0">💡 Backups listed here are stored on this server. With the off-site encrypted backup set up, a lost or hacked server can always be recovered — keep your backup passphrase in two safe places.</p></div>
    <div style="grid-column:1/-1;display:flex;justify-content:flex-end"><button class="btn btn-amber" type="submit">${ICON.save} Save Settings</button></div>
  </form>`;
  $('#setForm').onsubmit = guard(async e => {
    e.preventDefault();
    const f = e.target, body = {};
    for (const k of Object.keys(s)) { const el = f.elements[k]; if (!el || el.disabled) continue; body[k] = el.type === 'checkbox' ? el.checked : el.value; }
    const r = await api('PUT', '/api/settings', body); state.settings = r.settings; applyBrand(); toast('Settings saved');
  });
  $('#pwSave').onclick = guard(async () => {
    await api('POST', '/api/settings/password', { current: $('#pwCur').value, next: $('#pwNew').value });
    toast('Password changed — please log in again'); setTimeout(() => location.href = '/login', 1200);
  });
  $('#openConn').onclick = openConnectionModal;
  const fmtSize = n => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  const ago = iso => { if (!iso) return 'never'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  const loadBackups = guard(async () => {
    const { items, offsite: o, health: h, problem } = await api('GET', '/api/backups');
    $('#offsiteBox').innerHTML = `
      ${problem ? `<div class="alert-bar" style="margin-bottom:12px">⚠️ <span>${esc(problem)}</span></div>` : ''}
      <div class="offsite-grid">
        <div><span class="flabel">Database health</span>${h.liveCheck ? (h.liveCheck.ok ? '<span class="badge b-green">✓ Healthy</span>' : '<span class="badge b-red">Problem</span>') : '<span class="badge b-gray">Not checked yet</span>'}
          <div class="sub">Checked ${ago(h.liveCheck?.at)} · every backup is verified before it's kept</div>
          <button type="button" class="btn btn-light btn-sm" id="dbCheck" style="margin-top:8px">Check now</button></div>
        <div><span class="flabel">Off-site encrypted backup</span>
          ${o.configured ? `<span class="badge ${o.lastError && !o.lastSuccess ? 'b-red' : 'b-green'}">🔒 ${o.everyHours ? `Every ${o.everyHours} h` : 'Paused'} → ${esc(o.bucket)}</span>
            <div class="sub">Last upload ${ago(o.lastSuccess)}${o.lastError ? ` · <span style="color:var(--red)">last attempt failed: ${esc(o.lastError)}</span>` : ''}</div>
            <div class="sub">Restore drill: ${o.lastTest ? (o.lastTest.ok ? `✓ passed ${ago(o.lastTest.at)}` : `<span style="color:var(--red)">failed ${ago(o.lastTest.at)} — ${esc(o.lastTest.error)}</span>`) : 'not run yet'}</div>
            <div class="chips" style="margin-top:8px"><button type="button" class="btn btn-dark btn-sm" id="offsiteNow">Upload now</button><button type="button" class="btn btn-light btn-sm" id="offsiteTest">Run restore drill</button></div>`
          : `<span class="badge b-amber">Not set up</span><div class="sub">${o.problem ? esc(o.problem) + ' · ' : ''}Backups are only on this computer/server. Set up an encrypted off-site copy — see <b>DEPLOY.md → Off-site backups</b>.</div>`}</div>
      </div>`;
    $('#dbCheck').onclick = guard(async () => { const r = await api('POST', '/api/backups/check'); toast(r.ok ? 'Database is healthy' : 'Database check found a problem', !r.ok); loadBackups(); });
    $('#offsiteNow')?.addEventListener('click', guard(async e => { e.target.disabled = true; e.target.textContent = 'Uploading…'; try { const r = await api('POST', '/api/backups/offsite'); toast(`Encrypted backup uploaded (${Math.round(r.size / 1024)} KB)`); } finally { loadBackups(); } }));
    $('#offsiteTest')?.addEventListener('click', guard(async e => { e.target.disabled = true; e.target.textContent = 'Testing…'; try { const r = await api('POST', '/api/backups/offsite/test'); toast(r.ok ? `Restore drill passed — ${r.counts.chemicals} chemicals, ${r.counts.enquiries} enquiries, ${r.counts.orders} orders` : `Restore drill FAILED: ${r.error}`, !r.ok); } finally { loadBackups(); } }));
    $('#backupRows').innerHTML = items.length ? items.map(b => `<tr><td class="mono" style="font-size:13.5px">${esc(b.name)} ${b.manual ? '<span class="badge b-blue">manual</span>' : ''}</td>
      <td>${fmtSize(b.size)} ${b.verified ? '<span class="badge b-green" title="Integrity checked, SHA-256 recorded">✓ verified</span>' : ''}</td><td>${fmtTime(b.created)}</td>
      <td style="white-space:nowrap"><a class="btn btn-light btn-sm" href="/api/backups/${encodeURIComponent(b.name)}" download>Download</a>
        <button type="button" class="link-danger" title="Delete" data-del-backup="${esc(b.name)}">×</button></td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">No backups yet — the first one is made at the daily backup time, or press “Back up now”.</td></tr>';
  });
  loadBackups();
  $('#backupNow').onclick = guard(async () => { const b = await api('POST', '/api/backups'); toast(`Backup saved: ${b.name}`); loadBackups(); });
  $('#backupRows').onclick = guard(async e => {
    const n = e.target.closest('[data-del-backup]')?.dataset.delBackup; if (!n) return;
    if (!await confirmBox('Delete backup?', `<b>${esc(n)}</b> will be removed from the server.`, 'Delete')) return;
    await api('DELETE', `/api/backups/${encodeURIComponent(n)}`); toast('Backup deleted'); loadBackups();
  });
  $('#logoutAll').onclick = guard(async () => {
    if (!await confirmBox('Log out all devices?', 'Everyone signed in to this dashboard (including you) will need to log in again.', 'Log out all')) return;
    await api('POST', '/api/settings/logout-all'); location.href = '/login';
  });
}
function applyBrand() {
  const n = state.settings?.business_name || 'Quote Bot';
  $('#brandName').textContent = n; $('#brandMark').textContent = n[0]?.toUpperCase() || 'Q';
  document.title = `${n} · Quote Bot`;
}

/* =========================================================== PAYMENTS */
/** Read-only payment status for an enquiry row; the order itself is the one place payment is changed. */
function paymentBadge(i, today = istToday()) {
  const o = i.order;
  if (!o) return i.status === 'Confirmed'
    ? `<button class="link-btn pay-badge" data-record="${i.id}" title="Record the order to start payment tracking and reminders">📦 No order recorded yet</button>` : '';
  if (o.payment_status === 'Paid') return `<button class="badge b-green pay-badge" data-pay-order="${o.order_id}" title="Open order">✅ Paid ${fmtDay(o.paid_date)}</button>`;
  const d = dayDiff(today, o.due_date);
  const label = d < 0 ? `⚠ ${-d} day${d === -1 ? '' : 's'} overdue` : d === 0 ? '💰 Payment due today' : `💰 Payment pending · due ${fmtDay(o.due_date).replace(/ \d{4}$/, '')}`;
  return `<button class="badge ${d < 0 ? 'b-red' : 'b-amber'} pay-badge" data-pay-order="${o.order_id}" title="Open order">${label}</button>`;
}

const WHO = { bot: 'Bot', owner: 'You', buyer: 'Buyer' };
function timelineEvent(h) { return `<div class="ev ${esc(h.by)}"><small>${fmtTime(h.at)} · ${WHO[h.by] || esc(h.by)}</small>${esc(h.text)}</div>`; }
const rupees = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const plusDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + Number(n)); return x.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const fmtDay = d => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
function dueBadge(o, today = istToday()) {
  if (o.payment_status === 'Paid') return `<span class="badge b-green">Paid ${o.paid_date ? fmtDay(o.paid_date) : ''}</span>`;
  const d = dayDiff(today, o.due_date);
  if (d < 0) return `<span class="badge b-red">${-d} day${d === -1 ? '' : 's'} overdue</span>`;
  if (d === 0) return '<span class="badge b-amber">Due today</span>';
  return `<span class="badge ${d <= 7 ? 'b-amber' : 'b-gray'}">in ${d} day${d === 1 ? '' : 's'}</span>`;
}
state.payFilter = { status: 'Pending', q: '' };

async function loadPayments() {
  const qs = new URLSearchParams(state.payFilter);
  const data = await api('GET', `/api/orders?${qs}`);
  state.pay = data;
  const v = $('#view-payments');
  if (!v.dataset.ready) {
    v.innerHTML = `<div class="stats" id="payStats" style="grid-template-columns:repeat(4,minmax(0,1fr))"></div>
      <div class="card">
        <div class="banner info">🔔 <div><b>Payment reminders:</b> for every Pending order the buyer gets a reminder in the chat where the order was placed
          — first on <b>day ${(state.settings?.default_credit_days || 30) - (state.settings?.reminder_days_before_due ?? 2)}</b>, then every
          <b>${state.settings?.reminder_repeat_days || 2} days</b> until you mark it <b>Paid</b>. Change the timing in Settings and the message in Reply Templates.</div></div>
        <div class="toolbar"><div class="status-pills" id="payPills"></div><div class="spacer"></div>
          <div class="search" style="max-width:340px">${ICON.search}<input class="input" id="paySearch" placeholder="Search buyer, product, invoice…"></div></div>
        <div class="table-wrap"><table class="data"><thead><tr><th>Order date</th><th>Buyer &amp; chat</th><th>Material</th><th class="right">Amount</th><th>Due</th><th>Reminders</th><th>Payment</th><th></th></tr></thead>
        <tbody id="payRows"></tbody></table></div></div>`;
    v.dataset.ready = 1;
    $('#payPills').onclick = e => { const b = e.target.closest('[data-pst]'); if (b) { state.payFilter.status = b.dataset.pst; loadPayments(); } };
    $('#paySearch').oninput = debounce(e => { state.payFilter.q = e.target.value; loadPayments(); }, 300);
    $('#payRows').addEventListener('change', guard(async e => {
      const sel = e.target.closest('select[data-pay]'); if (!sel) return;
      await api('POST', `/api/orders/${sel.dataset.pay}/status`, { status: sel.value });
      toast(sel.value === 'Paid' ? 'Marked Paid — reminders stopped' : 'Marked Pending — reminders resumed'); loadPayments(); pollStatus();
    }));
    $('#payRows').addEventListener('click', e => { const id = e.target.closest('[data-open-order]')?.dataset.openOrder; if (id) openPaymentOrderModal(Number(id)); });
  }
  const st = data.stats;
  $('#payStats').innerHTML = [
    ['Outstanding', rupees(st.pending.amt), `${st.pending.n} pending order${st.pending.n === 1 ? '' : 's'}`, 'hl'],
    ['Overdue', rupees(st.overdue.amt), `${st.overdue.n} order${st.overdue.n === 1 ? '' : 's'}`, st.overdue.n ? 'od' : ''],
    ['Due in next 7 days', rupees(st.dueSoon.amt), `${st.dueSoon.n} order${st.dueSoon.n === 1 ? '' : 's'}`, ''],
    ['Received this month', rupees(st.paidThisMonth.amt), `${st.paidThisMonth.n} paid`, ''],
  ].map(([k, v, sub, c]) => `<div class="stat ${c}"><div class="k">${k}</div><div class="v">${v}</div><div class="sub">${sub}</div></div>`).join('');
  $('#payPills').innerHTML = [['Pending', 'Pending'], ['Overdue', 'Overdue'], ['DueSoon', 'Due this week'], ['Paid', 'Paid'], ['all', 'All']]
    .map(([k, l]) => `<button class="spill ${state.payFilter.status === k ? 'active' : ''}" data-pst="${k}">${l}</button>`).join('');
  $('#payRows').innerHTML = data.items.length ? data.items.map(o => `<tr>
    <td style="white-space:nowrap">${fmtDay(o.order_date)}${o.invoice_no ? `<div class="sub">${esc(o.invoice_no)}</div>` : ''}</td>
    <td><div style="font-weight:600">${esc(o.customer_name || '—')}</div><div class="sub">${o.chat_type === 'group' ? '👥' : '💬'} ${esc(o.chat_name || o.chat_jid)}</div></td>
    <td><div>${esc(o.product)}</div><div class="sub">${esc([o.quantity, o.rate].filter(Boolean).join(' · '))}</div></td>
    <td class="right rate-big">${rupees(o.amount)}</td>
    <td style="white-space:nowrap"><div>${fmtDay(o.due_date)}</div>${dueBadge(o, data.today)}</td>
    <td style="white-space:nowrap"><div>${o.reminders_sent} sent</div><div class="sub">${o.payment_status === 'Paid' ? '—' : !o.reminders_enabled ? '⏸ paused' : o.next_reminder_date ? `next ${fmtDay(o.next_reminder_date)}` : '—'}</div>
      ${o.last_error ? `<div class="sub" style="color:var(--red)" title="${esc(o.last_error)}">⚠ last attempt failed</div>` : ''}</td>
    <td><select class="input status-select badge ${o.payment_status === 'Paid' ? 'b-green' : 'b-amber'}" data-pay="${o.id}">${['Pending', 'Paid'].map(x => `<option ${x === o.payment_status ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
    <td><button class="btn btn-light btn-sm" data-open-order="${o.id}">Open</button></td></tr>`).join('')
    : `<tr><td colspan="8" class="empty">${state.payFilter.status === 'Pending' ? 'No pending payments. Record an order from <b>Orders &amp; Decisions → Open → 📦 Record order</b>, or use <b>+ New Order</b>.' : 'Nothing here.'}</td></tr>`;
}

const refreshOrderViews = () => { if (state.tab === 'orders') guard(loadOrders)(); else guard(loadPayments)(); pollStatus(); };

/** Create (from an enquiry or from scratch) or edit an order. */
async function openPaymentOrderModal(id, fromInquiry = null) {
  if (!state.settings) state.settings = (await api('GET', '/api/settings')).settings;
  const groups = state.groups?.length ? state.groups : (state.groups = await api('GET', '/api/groups').catch(() => []));
  const o = id ? (await api('GET', `/api/orders?status=all`)).items.find(x => x.id === id) : null;
  if (id && !o) return toast('Order not found', true);
  const inq = fromInquiry;
  const isNew = !o;
  const v = o || {
    customer_name: inq?.sender_name || '', customer_phone: inq?.sender_phone || '', product: inq?.chemical_name || inq?.requested_text || '',
    quantity: inq?.final_qty || inq?.quantity || '', rate: inq?.final_rate || '', amount: '', invoice_no: '', order_date: istToday(),
    credit_days: state.settings.default_credit_days || 30, reminders_enabled: true, notes: '',
    chat_type: inq && !String(inq.group_jid || '').endsWith('@g.us') ? 'private' : 'group', chat_jid: inq?.group_jid || '', chat_name: inq?.group_name || '',
  };
  const groupOpts = groups.filter(g => g.jid.endsWith('@g.us') && !g.left_group);
  const groupChoice = isNew && !inq
    ? `<select class="input" id="poGroup">${groupOpts.length ? groupOpts.map(g => `<option value="${esc(g.jid)}">${esc(g.name)}</option>`).join('') : '<option value="">No groups — sync first, or use private chat</option>'}</select>`
    : `<div class="input" style="background:var(--soft)">${esc(v.chat_type === 'group' ? v.chat_name || v.chat_jid : (inq?.group_name || 'the group'))}</div>`;
  const m = openModal(`<div class="modal-head"><h3>${isNew ? '📦 Record Order' : `Order #${o.id} · ${esc(o.customer_name || '')}`}</h3><button class="x" data-close>×</button></div>
    <form class="modal-body" id="poForm" autocomplete="off">
      ${inq ? `<div class="wa-preview" style="margin-bottom:18px"><div class="bubble" style="max-width:100%;margin:0"><div class="who">${esc(inq.sender_name || '')} ${esc(inq.sender_phone || '')}</div>${waFormat(inq.message || '')}<div class="meta">${esc(inq.group_name || '')}</div></div></div>` : ''}
      <div class="grid2">
        <div class="field"><label>Buyer name</label><input class="input" name="customer_name" value="${esc(v.customer_name || '')}"></div>
        <div class="field"><label>Buyer WhatsApp number</label><input class="input" name="customer_phone" value="${esc(v.customer_phone || '')}" placeholder="+91 98xxx xxxxx"></div>
      </div>
      <div class="grid3">
        <div class="field" style="grid-column:span 2"><label>Material / description *</label><input class="input" name="product" value="${esc(v.product || '')}" required></div>
        <div class="field"><label>Quantity</label><input class="input" name="quantity" value="${esc(v.quantity || '')}" placeholder="2 MT"></div>
        <div class="field"><label>Rate</label><input class="input" name="rate" value="${esc(v.rate || '')}" placeholder="₹106 / kg + GST"></div>
        <div class="field"><label>Order amount (₹) *</label><input class="input price-input" name="amount" type="number" min="1" step="0.01" value="${v.amount || ''}" required></div>
        <div class="field"><label>Invoice no.</label><input class="input" name="invoice_no" value="${esc(v.invoice_no || '')}"></div>
        <div class="field"><label>Order date</label><input class="input" type="date" name="order_date" value="${esc(v.order_date)}" max="${istToday()}"></div>
        <div class="field"><label>Credit days</label><input class="input" type="number" min="1" max="365" name="credit_days" value="${v.credit_days}"></div>
        <div class="field"><label>Due date</label><div class="input" id="poDue" style="background:var(--soft)"></div></div>
      </div>
      <div class="field"><label>Send payment reminders in</label>
        <div class="seg" id="poChat"><button type="button" data-ct="group">👥 Group</button><button type="button" data-ct="private">💬 Private chat with buyer</button></div>
        <div style="margin-top:10px" id="poGroupWrap">${groupChoice}</div>
        <div class="help" id="poChatHelp"></div></div>
      <label class="check" style="margin-bottom:8px"><input type="checkbox" name="reminders_enabled" ${v.reminders_enabled ? 'checked' : ''}> Send automatic payment reminders</label>
      <div class="help" id="poSchedule" style="margin:0 0 16px"></div>
      <div class="field"><label>Notes (private)</label><textarea class="input" name="notes" rows="2">${esc(v.notes || '')}</textarea></div>
      ${o ? `<div class="grid2"><div><span class="flabel">Next reminder preview</span><div class="wa-preview"><div class="bubble out" style="max-width:100%;margin:0" id="poPreview">…</div></div></div>
        <div><span class="flabel">History</span><div class="timeline">${o.history.map(timelineEvent).join('')}</div></div></div>` : ''}
    </form>
    <div class="modal-foot">
      ${o ? `<button class="link-danger" id="poDel" style="font-size:15px">Delete</button>` : ''}<div class="push"></div>
      ${o && o.payment_status === 'Pending' ? `<button class="btn btn-light" id="poRemind">🔔 Send reminder now</button><button class="btn btn-green" id="poPaid">✅ Mark Paid</button>` : ''}
      ${o && o.payment_status === 'Paid' ? `<button class="btn btn-light" id="poUnpaid">Mark Pending again</button>` : ''}
      <button class="btn btn-dark" id="poSave">${isNew ? 'Save order' : 'Save changes'}</button></div>`, { size: 'lg' });

  const f = $('#poForm', m.el);
  let chatType = v.chat_type || 'group';
  const refresh = () => {
    $$('#poChat button', m.el).forEach(b => b.classList.toggle('active', b.dataset.ct === chatType));
    $('#poGroupWrap', m.el).classList.toggle('hidden', chatType !== 'group');
    $('#poChatHelp', m.el).innerHTML = chatType === 'group'
      ? 'The reminder is posted in this group as a reply to the buyer’s order message, tagging the buyer.'
      : 'The reminder goes to the buyer’s own WhatsApp chat (uses the number above).';
    const od = f.order_date.value || istToday(), cd = Number(f.credit_days.value) || 30;
    const due = plusDays(od, cd);
    $('#poDue', m.el).textContent = fmtDay(due);
    const before = Number(state.settings.reminder_days_before_due ?? 2), every = Number(state.settings.reminder_repeat_days || 2);
    let first = plusDays(od, cd - before); if (first < od) first = od;
    if (o?.last_reminder_date || first < istToday()) first = o?.next_reminder_date || istToday();
    $('#poSchedule', m.el).innerHTML = !f.reminders_enabled.checked ? '⏸ No automatic reminders for this order.'
      : (o && o.payment_status === 'Paid') ? 'Paid — no reminders.'
      : `🔔 ${o?.reminders_sent ? 'Next' : 'First'} reminder <b>${fmtDay(first)}</b> (from ${state.settings.reminder_hour_ist ?? 11}:00), then every ${every} day${every === 1 ? '' : 's'} until marked Paid.`;
  };
  $('#poChat', m.el).onclick = e => { const b = e.target.closest('[data-ct]'); if (b) { chatType = b.dataset.ct; refresh(); } };
  f.addEventListener('input', refresh); f.addEventListener('change', refresh);
  refresh();
  if (o) api('GET', `/api/orders/${o.id}/preview`).then(r => { $('#poPreview', m.el).innerHTML = waFormat(r.text); }).catch(() => {});

  $('#poSave', m.el).onclick = guard(async () => {
    const body = {
      customer_name: f.customer_name.value, customer_phone: f.customer_phone.value, product: f.product.value, quantity: f.quantity.value,
      rate: f.rate.value, amount: f.amount.value, invoice_no: f.invoice_no.value, order_date: f.order_date.value, credit_days: f.credit_days.value,
      reminders_enabled: f.reminders_enabled.checked, notes: f.notes.value, chat_type: chatType,
    };
    if (isNew && inq) body.inquiry_id = inq.id;
    if (isNew && !inq && chatType === 'group') { body.chat_jid = $('#poGroup', m.el)?.value; if (!body.chat_jid) throw new Error('Choose a group, or switch to private chat'); }
    if (!isNew && chatType === 'group' && o.chat_type !== 'group') throw new Error('This order was set up for a private chat — create a new order to remind in a group');
    const saved = await api(isNew ? 'POST' : 'PATCH', isNew ? '/api/orders' : `/api/orders/${o.id}`, body);
    m.close(); toast(isNew ? `Order #${saved.id} saved — payment tracking started` : 'Order updated');
    refreshOrderViews();
  });
  $('#poPaid', m.el)?.addEventListener('click', guard(async () => { await api('POST', `/api/orders/${o.id}/status`, { status: 'Paid' }); m.close(); toast('Marked Paid — reminders stopped'); refreshOrderViews(); }));
  $('#poUnpaid', m.el)?.addEventListener('click', guard(async () => { await api('POST', `/api/orders/${o.id}/status`, { status: 'Pending' }); m.close(); toast('Marked Pending — reminders resumed'); refreshOrderViews(); }));
  $('#poRemind', m.el)?.addEventListener('click', guard(async () => {
    const r = await api('POST', `/api/orders/${o.id}/remind`); toast(`Reminder #${r.reminders_sent} sent`); m.close(); refreshOrderViews();
  }));
  $('#poDel', m.el)?.addEventListener('click', guard(async () => {
    if (!await confirmBox('Delete order?', 'The order and its reminders are removed. This cannot be undone.', 'Delete')) return openPaymentOrderModal(o.id);
    await api('DELETE', `/api/orders/${o.id}`); toast('Order deleted'); refreshOrderViews();
  }));
}

/* =========================================================== boot */
(async () => {
  try { state.settings = (await api('GET', '/api/settings')).settings; applyBrand(); } catch { /* ignore */ }
  await pollStatus();
  setInterval(pollStatus, 3000);
  const start = location.hash.slice(1);
  switchTab(LOADERS[start] ? start : 'chemicals');
})();
