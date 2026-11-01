document.getElementById('f').onsubmit = async e => {
  e.preventDefault();
  const btn = document.getElementById('go'), err = document.getElementById('err');
  btn.disabled = true; err.textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pw').value }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) location.href = '/'; else err.textContent = d.error || 'Login failed';
  } catch { err.textContent = 'Could not reach the server'; }
  btn.disabled = false;
};
