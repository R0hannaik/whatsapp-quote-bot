const token = location.pathname.split('/').pop();
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let data = null, offset = 0, lastCodes = null, lastLoad = 0;
async function load() {
  lastLoad = Date.now();
  try {
    const r = await fetch('/api/public/join/' + token);
    if (!r.ok) throw new Error();
    data = await r.json();
    offset = Date.parse(data.serverTime) - Date.now();
    document.getElementById('title').textContent = `Join ${data.business} on WhatsApp`;
    document.getElementById('note').textContent = `QR codes change every ${data.minutes} minutes for security.${data.phone ? ' Questions? ' + data.phone : ''}`;
    const codes = data.groups.map(g => g.link).join('|');
    if (codes !== lastCodes) {
      lastCodes = codes;
      document.getElementById('grid').innerHTML = data.groups.length ? data.groups.map(g => `<div class="qr-card">
        <img src="${g.qr}" alt="QR code to join ${esc(g.name)}"><h4>${esc(g.name)}</h4>
        <a class="btn btn-green btn-sm" style="margin-top:10px" href="${esc(g.link)}">Open in WhatsApp</a>
        <div class="bar"><i data-exp="${g.expiresAt}" data-rot="${g.rotatedAt}"></i></div>
        <div class="sub" style="margin-top:6px">Refreshes in <span class="countdown" data-exp="${g.expiresAt}">--:--</span></div></div>`).join('')
        : '<div class="qr-card"><p class="muted">No groups are open for joining right now.</p></div>';
    }
  } catch { document.getElementById('grid').innerHTML = '<div class="qr-card"><p class="muted">This page is not available.</p></div>'; }
}
function tick() {
  const now = Date.now() + offset;
  let due = false;
  document.querySelectorAll('.countdown').forEach(el => {
    const ms = Date.parse(el.dataset.exp) - now;
    if (ms <= 0) due = true;
    el.textContent = ms > 0 ? `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}` : 'updating…';
  });
  document.querySelectorAll('.bar i').forEach(el => {
    const total = Date.parse(el.dataset.exp) - Date.parse(el.dataset.rot);
    const left = Date.parse(el.dataset.exp) - now;
    el.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
  });
  return due;
}
load();
setInterval(() => { if (tick() && Date.now() - lastLoad > 5000) load(); }, 1000);
setInterval(load, 30000);
