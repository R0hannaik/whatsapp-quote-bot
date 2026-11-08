import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Tests set QB_NO_DOTENV so your real .env (password, phone, data folder) never leaks into them.
if (!process.env.QB_NO_DOTENV && fs.existsSync('.env')) process.loadEnvFile('.env');

const express = (await import('express')).default;
const db = await import('./db.js');
const { initPassword, changePassword, login, logout, logoutEverywhere, requireAuth, isAuthed } = await import('./auth.js');
const { planReplies, describe, invalidateCatalogue } = await import('./bot.js');
const { PRESETS, DEFAULT_TEMPLATES, TEMPLATE_VARIABLES, MULTI_VARIABLES, REMINDER_VARIABLES } = await import('./presets.js');
const waMod = await import('./whatsapp.js');
const backups = await import('./backup.js');
const orders = await import('./orders.js');
const { wa } = waMod;

const demo = await import('./demo.js');
const DEMO = demo.isDemo();
db.ensureSecrets();
db.seedIfEmpty();
if (DEMO) {
  // Demo: its own password (DEMO_PASSWORD, or generated once), always applied so the link you share keeps working.
  const { password, generated } = demo.demoPassword(db.DATA_DIR, fs, path);
  process.env.DASHBOARD_PASSWORD = password;
  db.setSetting('password_hash', null);
  if (!process.env.QB_QUIET) console.log(`\n  🎬 DEMO MODE — sample data, simulated WhatsApp. Login password: ${generated ? password : '(DEMO_PASSWORD)'}\n`);
}
// Trial: the client links THEIR OWN WhatsApp to try the real bot. Separate data, sample chemicals, Test mode on at first start.
const TRIAL = !DEMO && process.env.TRIAL_MODE === '1';
if (TRIAL) {
  let shown = '(DASHBOARD_PASSWORD)';
  if (!process.env.DASHBOARD_PASSWORD || process.env.TRIAL_PASSWORD) {
    const { password, generated } = demo.demoPassword(db.DATA_DIR, fs, path, { env: 'TRIAL_PASSWORD', prefix: 'trial' });
    process.env.DASHBOARD_PASSWORD = password;
    shown = generated ? `${password}${db.getSetting('password_hash') ? '  (unless changed in Settings)' : ''}` : '(TRIAL_PASSWORD)';
  }
  if (!db.getSetting('trial_initialized')) {
    db.setSetting('reply_to_own_messages', true);   // so the client can test by typing on their own phone
    db.setSetting('trial_initialized', true);
  }
  if (!process.env.QB_QUIET) console.log(`\n  🧪 TRIAL MODE — link your own WhatsApp and try the real bot. Login password: ${shown}\n`);
}
initPassword();
if (DEMO) { await demo.seedDemo(); demo.attachDemoSocket(); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const app = express();
// Behind one reverse proxy (Caddy/Nginx): trust exactly one hop, so visitors can't fake their IP to dodge the login lockout.
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Only our own scripts may run; blocks injected <script> even if something slips past escaping.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
  ].join('; '));
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// CSRF protection: state-changing requests must come from this dashboard's own pages.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Browsers set Sec-Fetch-Site themselves and pages can't fake it — the most reliable check, and it keeps working behind
  // tunnels/proxies that rewrite the Host header. Older clients without it fall back to comparing Origin with Host.
  const site = req.headers['sec-fetch-site'];
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] && app.get('trust proxy') ? req.headers['x-forwarded-host'] : req.headers.host;
  let sameOrigin;
  if (site) sameOrigin = site === 'same-origin' || site === 'none';
  else if (origin) { try { sameOrigin = new URL(origin).host === host; } catch { sameOrigin = false; } }
  else sameOrigin = true;
  if (!sameOrigin) return res.status(403).json({ error: 'Cross-site request blocked' });
  if (req.headers['content-length'] > 0 && !req.is('application/json')) return res.status(415).json({ error: 'JSON only' });
  next();
});
app.use(express.json({ limit: '256kb' }));

const sameToken = t => {
  const a = Buffer.from(String(t || '')), b = Buffer.from(String(db.getSetting('join_page_token') || ''));
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
};

const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => res.status(400).json({ error: e.message }));

/* ---------------- public ---------------- */
app.use('/assets', express.static(path.join(PUB, 'assets')));
// Health check for hosting platforms / Docker (reveals nothing).
app.get('/healthz', (_req, res) => { try { db.db.prepare('SELECT 1').get(); res.json({ ok: true }); } catch { res.status(500).json({ ok: false }); } });

app.get('/login', (req, res) => isAuthed(req) ? res.redirect('/') : res.sendFile(path.join(PUB, 'login.html')));
app.post('/api/login', login);
app.post('/api/logout', logout);

// Public rotating join-QR page — only shows groups you switched on for it, protected by an unguessable token.
app.get('/join/:token', (req, res) => {
  if (!sameToken(req.params.token)) return res.status(404).send('Not found');
  res.sendFile(path.join(PUB, 'join.html'));
});
app.get('/api/public/join/:token', wrap(async (req, res) => {
  if (!sameToken(req.params.token)) return res.status(404).json({ error: 'Not found' });
  res.json(await joinPayload(false));
}));

async function joinPayload(includeErrors) {
  const minutes = Number(db.getSetting('invite_rotate_minutes')) || 10;
  const s = db.getSettings();
  const groups = db.listGroups().filter(g => g.join_qr && !g.left_group);
  const out = [];
  for (const g of groups) {
    if (!g.invite_code && !includeErrors) continue;
    const rotated = g.invite_rotated_at ? Date.parse(g.invite_rotated_at) : null;
    out.push({
      ...(includeErrors ? { jid: g.jid, members: g.members } : {}), name: g.name, link: g.invite_code ? `https://chat.whatsapp.com/${g.invite_code}` : null,
      qr: await waMod.qrFor(g.invite_code), rotatedAt: g.invite_rotated_at,
      expiresAt: rotated ? new Date(rotated + minutes * 60000).toISOString() : null,
      ...(includeErrors ? { error: g.invite_error, is_admin: g.is_admin } : {}),
    });
  }
  return { business: s.business_name, phone: s.contact_phone, minutes, groups: out, serverTime: new Date().toISOString() };
}

/* ---------------- everything below needs login ---------------- */
app.use(requireAuth);
app.get('/', (_req, res) => res.sendFile(path.join(PUB, 'app.html')));

app.get('/api/status', (_req, res) => {
  const groups = db.listGroups();
  res.json({
    whatsapp: { status: wa.status, qr: wa.qr, me: wa.me, lastError: wa.lastError, lastSync: wa.lastSync },
    counts: {
      chemicals: db.listChemicals().length,
      groups: groups.filter(g => !g.left_group).length,
      autoReplyOn: groups.filter(g => g.auto_reply && !g.left_group).length,
    },
    stats: db.inquiryStats(),
    payments: orders.paymentStats(),
    backupProblem: DEMO ? null : backups.backupProblem(),
    demo: DEMO,
    trial: TRIAL ? {
      testMode: !!db.getSettings().reply_to_own_messages,
      quotes: db.db.prepare('SELECT COUNT(*) n FROM inquiries WHERE quote_text IS NOT NULL').get().n,
    } : null,
  });
});
app.get('/api/activity', (_req, res) => res.json(waMod.activity.slice(0, 60)));
// Things that would break the demo for the next viewer are switched off in demo mode.
const notInDemo = (_req, res, next) => DEMO ? res.status(400).json({ error: 'Not available in the demo' }) : next();
app.use(['/api/wa/restart', '/api/wa/logout', '/api/settings/password', '/api/settings/logout-all', '/api/join/token', '/api/backups/offsite'], notInDemo);

/* demo chat (demo mode only) */
app.get('/api/demo/chat', (req, res) => {
  if (!DEMO) return res.status(404).json({ error: 'Not found' });
  const jid = String(req.query.jid || '');
  res.json({ groups: demo.DEMO_GROUPS.map(g => ({ jid: g.jid, name: g.name, members: g.members, auto_reply: !!db.getGroup(g.jid)?.auto_reply })),
    messages: demo.chat.filter(m => !jid || m.jid === jid) });
});
app.post('/api/demo/message', wrap(async (req, res) => {
  if (!DEMO) return res.status(404).json({ error: 'Not found' });
  res.json(await demo.demoMessage(req.body || {}));
}));
app.post('/api/demo/reset', wrap(async (_req, res) => {
  if (!DEMO) return res.status(404).json({ error: 'Not found' });
  await demo.seedDemo({ force: true }); demo.attachDemoSocket(); res.json({ ok: true });
}));

app.post('/api/wa/restart', wrap(async (_req, res) => { await waMod.restartWhatsApp(); res.json({ ok: true }); }));
app.post('/api/wa/logout', wrap(async (_req, res) => res.json({ ok: true, ...(await waMod.logoutWhatsApp()) })));

/* chemicals */
app.get('/api/chemicals', (_req, res) => res.json(db.listChemicals()));
app.post('/api/chemicals', wrap((req, res) => {
  if (!req.body?.name?.trim()) throw new Error('Chemical name is required');
  const c = db.createChemical(req.body); invalidateCatalogue(); res.json(c);
}));
app.put('/api/chemicals/:id', wrap((req, res) => {
  if (!db.getChemical(req.params.id)) throw new Error('Chemical not found');
  if (!req.body?.name?.trim()) throw new Error('Chemical name is required');
  const c = db.updateChemical(Number(req.params.id), req.body); invalidateCatalogue(); res.json(c);
}));
app.delete('/api/chemicals/:id', wrap((req, res) => { db.deleteChemical(req.params.id); invalidateCatalogue(); res.json({ ok: true }); }));

/* groups */
app.get('/api/groups', (_req, res) => res.json(db.listGroups()));
app.post('/api/groups/sync', wrap(async (_req, res) => res.json({ ok: true, count: await waMod.syncGroups() })));
app.post('/api/groups', wrap(async (req, res) => {
  const { name, jid, invite } = req.body || {};
  if (invite) return res.json(db.getGroup(await waMod.joinByInvite(invite)));
  let id = String(jid || '').trim();
  if (/^\+?\d{8,15}$/.test(id.replace(/[\s-]/g, ''))) id = id.replace(/[^\d]/g, '') + '@s.whatsapp.net';  // a phone number = direct chat
  else if (/^\d{10,}(-\d+)?$/.test(id)) id += '@g.us';
  if (!/@(g\.us|s\.whatsapp\.net|lid)$/.test(id)) throw new Error('Enter a group ID (…@g.us), a phone number, or an invite link');
  res.json(db.addCustomGroup({ jid: id, name: String(name || '').trim() || id }));
}));
app.patch('/api/groups/:jid', wrap(async (req, res) => {
  const jid = req.params.jid;
  if (!db.getGroup(jid)) throw new Error('Group not found');
  const patch = {};
  for (const k of ['auto_reply', 'join_qr', 'name']) if (k in req.body) patch[k] = req.body[k];
  let g = db.patchGroup(jid, patch);
  if (patch.join_qr === true && wa.status === 'open') g = await waMod.rotateInvite(jid);
  res.json(g);
}));
app.post('/api/groups/all-off', (_req, res) => { db.allAutoReplyOff(); res.json({ ok: true }); });
app.delete('/api/groups/:jid', wrap((req, res) => { db.deleteGroup(req.params.jid); res.json({ ok: true }); }));

/* templates */
app.get('/api/templates', (_req, res) => res.json({ templates: db.getTemplates(), defaults: DEFAULT_TEMPLATES, presets: PRESETS,
  variables: TEMPLATE_VARIABLES, multiVariables: MULTI_VARIABLES, reminderVariables: REMINDER_VARIABLES }));
app.put('/api/templates/:mode', wrap((req, res) => {
  if (!db.TEMPLATE_MODES.includes(req.params.mode)) throw new Error('Unknown template');
  if (!String(req.body?.body || '').trim()) throw new Error('Template cannot be empty');
  if (String(req.body.body).length > 5000) throw new Error('Template is too long (max 5000 characters)');
  if (req.params.mode === 'multi' && !String(req.body.body).includes('{items}')) throw new Error('The Multi-Product template must contain {items}');
  db.saveTemplate(req.params.mode, String(req.body.body)); res.json({ ok: true });
}));
app.post('/api/templates/:mode/reset', wrap((req, res) => {
  if (!db.TEMPLATE_MODES.includes(req.params.mode)) throw new Error('Unknown template');
  db.resetTemplate(req.params.mode); res.json({ ok: true, body: DEFAULT_TEMPLATES[req.params.mode] });
}));

// "Try a message": runs the real parser + templates without sending anything.
// overrides = unsaved editor text ({quote, deal, multi, multi_item}); forceMode shows that template even if the message wouldn't use it.
app.post('/api/simulate', wrap(async (req, res) => {
  const { message, overrides = {}, forceMode, useAi } = req.body || {};
  const ov = {};
  for (const m of db.TEMPLATE_MODES) if (typeof overrides[m] === 'string') {
    if (overrides[m].length > 5000) throw new Error('Template is too long');
    ov[m] = overrides[m];
  }
  const fm = ['quote', 'deal', 'multi'].includes(forceMode) ? forceMode : undefined;
  const plan = await planReplies(String(message || '').slice(0, 4000), { overrides: ov, forceMode: fm, senderName: 'Rakesh', useAi: !!useAi });
  res.json({
    analysis: describe(plan.analysis),
    replies: plan.replies.map(r => ({ kind: r.kind, intent: r.intent, text: r.text, chemicals: r.items.map(i => i.chem.name) })),
    unavailable: plan.unavailable.map(u => ({ name: u.name, quantity: u.quantity?.text || null, reason: u.reason })),
    unmatchedReply: plan.unmatchedReply,
  });
}));

/* inquiries / orders */
app.get('/api/inquiries', (req, res) => {
  const q = { ...req.query, limit: 500 };
  delete q.ids;
  if (q.status === 'payment_pending') q.ids = orders.pendingInquiryIds();
  const items = db.listInquiries(q);
  const pay = orders.ordersForInquiries(items.map(i => i.id));
  for (const i of items) i.order = pay[i.id] || null;   // payment info lives on the order — shown here read-only
  res.json({ items, stats: { ...db.inquiryStats(), paymentPending: orders.pendingInquiryIds().length }, statuses: db.INQUIRY_STATUSES, today: orders.todayIST() });
});
app.patch('/api/inquiries/:id', wrap((req, res) => {
  const { status } = req.body || {};
  if (status && !db.INQUIRY_STATUSES.includes(status)) throw new Error('Unknown status');
  const r = db.updateInquiry(Number(req.params.id), req.body); if (!r) throw new Error('Not found'); res.json(r);
}));
app.delete('/api/inquiries/:id', (req, res) => { db.deleteInquiry(req.params.id); res.json({ ok: true }); });
app.post('/api/inquiries/:id/message', wrap(async (req, res) => {
  const inq = db.getInquiry(Number(req.params.id));
  const text = String(req.body?.text || '').trim();
  if (!inq) throw new Error('Not found');
  if (!text) throw new Error('Message is empty');
  await waMod.sendOwnerMessage(inq, text);
  res.json(db.updateInquiry(inq.id, { log: `Owner replied in group: "${text.slice(0, 120)}"` }));
}));
app.get('/api/inquiries.csv', (req, res) => {
  const rows = db.listInquiries({ ...req.query, limit: 50000 });
  const cols = ['id', 'created_at', 'group_name', 'sender_name', 'sender_phone', 'message', 'chemical_name', 'quantity', 'location', 'origin', 'intent', 'quoted_rate', 'status', 'final_rate', 'final_qty', 'owner_notes'];
  // Prefix cells that Excel would treat as formulas (=, +, -, @) — WhatsApp text is untrusted.
  const esc = v => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send('﻿' + [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n'));
});

/* join QR (admin view) */
app.get('/api/join', wrap(async (_req, res) => res.json({ ...(await joinPayload(true)), token: db.getSetting('join_page_token') })));
app.post('/api/join/:jid/rotate', wrap(async (req, res) => res.json(await waMod.rotateInvite(req.params.jid))));
app.post('/api/join/token', (_req, res) => { db.setSetting('join_page_token', crypto.randomBytes(9).toString('base64url')); res.json({ token: db.getSetting('join_page_token') }); });

/* settings */
app.get('/api/settings', (_req, res) => res.json({ settings: db.getSettings(), envLocked: db.envLockedSettings(), aiKeyPresent: !!process.env.ANTHROPIC_API_KEY }));
app.put('/api/settings', wrap((req, res) => {
  const body = req.body || {};
  for (const k of Object.keys(db.SETTING_DEFAULTS)) {
    if (!(k in body) || k === 'join_page_token' || db.envLockedSettings().includes(k)) continue;
    const def = db.SETTING_DEFAULTS[k];
    let v = body[k];
    if (typeof def === 'number') { v = Number(v); if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid value for ${k}`); }
    if (typeof def === 'boolean') v = !!v;
    if (typeof def === 'string') { v = String(v); if (v.length > 2000) throw new Error(`${k} is too long`); }
    if (k === 'reminder_hour_ist' && (v > 23 || !Number.isInteger(v))) throw new Error('Reminder time must be a whole hour from 0 to 23');
    if (k === 'default_credit_days' && (v < 1 || v > 365)) throw new Error('Credit days must be between 1 and 365');
    if (k === 'reminder_repeat_days' && (v < 1 || v > 30)) throw new Error('Repeat every 1–30 days');
    if (k === 'reminder_days_before_due' && v > 30) throw new Error('First reminder can be at most 30 days before the due date');
    if (k === 'backup_hour_ist' && (v > 23 || !Number.isInteger(v))) throw new Error('Backup time must be a whole hour from 0 to 23');
    if (k === 'offsite_every_hours' && (v > 168 || !Number.isInteger(v))) throw new Error('Off-site backup interval must be 0–168 hours');
    if (k === 'backup_keep_days' && (v < 1 || v > 365)) throw new Error('Keep between 1 and 365 backups');
    if (k === 'multi_reply_style' && !['combined', 'separate'].includes(v)) throw new Error('multi_reply_style must be combined or separate');
    db.setSetting(k, v);
  }
  if (Number(db.getSetting('invite_rotate_minutes')) < 2) db.setSetting('invite_rotate_minutes', 2);
  invalidateCatalogue();
  res.json({ settings: db.getSettings() });
}));
/* orders & payments */
const phoneJid = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; return d.length >= 11 && d.length <= 15 ? `${d}@s.whatsapp.net` : null; };
function orderInput(body, existing) {
  const b = { ...body };
  delete b.payment_status; delete b.reminders_sent; delete b.last_reminder_date; delete b.next_reminder_date; delete b.history;
  const inq = b.inquiry_id ? db.getInquiry(Number(b.inquiry_id)) : null;
  if (b.inquiry_id && !inq) throw new Error('Enquiry not found');
  if (inq && !existing) {   // fill in who/where from the enquiry
    b.customer_name ??= inq.sender_name; b.customer_phone ??= inq.sender_phone; b.customer_jid ??= inq.sender_jid;
    b.chat_jid ??= inq.group_jid; b.chat_name ??= inq.group_name; b.msg_key ??= inq.msg_key; b.order_message ??= inq.message;
    b.product ??= inq.chemical_name || inq.requested_text; b.quantity ??= inq.final_qty || inq.quantity; b.rate ??= inq.final_rate;
  }
  if (b.chat_type === 'private') {   // remind in the buyer's private chat
    const jid = phoneJid(b.customer_phone);
    if (!jid) throw new Error("Enter the buyer's WhatsApp number for private-chat reminders");
    b.chat_jid = jid; b.chat_name = `Private chat · ${b.customer_phone}`;
    if (!existing || existing.chat_jid !== jid) { b.msg_key = null; }
  } else if (b.chat_type === 'group' && b.chat_jid && !b.chat_name) {
    b.chat_name = db.getGroup(b.chat_jid)?.name || b.chat_jid;
  }
  return b;
}
app.get('/api/orders', (req, res) => res.json({ items: orders.listOrders({ status: String(req.query.status || 'Pending'), q: req.query.q }), stats: orders.paymentStats(), today: orders.todayIST() }));
app.post('/api/orders', wrap((req, res) => res.json(orders.createOrder(orderInput(req.body || {})))));
app.patch('/api/orders/:id', wrap((req, res) => {
  const cur = orders.getOrder(Number(req.params.id)); if (!cur) throw new Error('Order not found');
  res.json(orders.updateOrder(cur.id, orderInput(req.body || {}, cur)));
}));
app.post('/api/orders/:id/status', wrap((req, res) => res.json(orders.setPaymentStatus(Number(req.params.id), req.body?.status))));
app.post('/api/orders/:id/remind', wrap(async (req, res) => res.json(await waMod.sendPaymentReminder(Number(req.params.id), { manual: true }))));
app.get('/api/orders/:id/preview', wrap((req, res) => {
  const o = orders.getOrder(Number(req.params.id)); if (!o) throw new Error('Order not found');
  res.json({ text: waMod.reminderText(o) });
}));
app.delete('/api/orders/:id', wrap((req, res) => { orders.deleteOrder(Number(req.params.id)); res.json({ ok: true }); }));
// Template editor preview with a sample order
app.post('/api/reminder-preview', wrap((req, res) => {
  const body = String(req.body?.body ?? db.getTemplates().reminder);
  if (body.length > 5000) throw new Error('Template is too long');
  const today = orders.todayIST();
  const sample = { id: 0, chat_type: 'group', customer_name: 'Rakesh Shah', customer_jid: '919820000000@s.whatsapp.net', product: 'Phthalic Anhydride',
    quantity: '2 MT', amount: 256000, invoice_no: 'PC/2026/1182', order_date: orders.addDays(today, -28), credit_days: 30,
    due_date: orders.addDays(today, 2), reminders_sent: 0 };
  res.json({ text: waMod.reminderText(sample, body) });
}));

/* backups */
app.get('/api/backups', (_req, res) => res.json({ items: backups.listBackups(), hour: db.getSetting('backup_hour_ist'), keep: db.getSetting('backup_keep_days'),
  health: backups.getHealth(), offsite: backups.offsiteStatus(), problem: backups.backupProblem() }));
app.post('/api/backups/offsite', wrap(async (_req, res) => res.json(await backups.runOffsiteBackup())));
app.post('/api/backups/offsite/test', wrap(async (_req, res) => res.json(await backups.testOffsiteRestore())));
app.post('/api/backups/check', wrap((_req, res) => res.json({ ok: backups.checkLiveDb(), health: backups.getHealth() })));
app.post('/api/backups', wrap(async (_req, res) => res.json(await backups.createBackup({ manual: true }))));
app.get('/api/backups/:name', (req, res) => {
  const p = backups.backupPath(req.params.name);
  if (!p) return res.status(404).json({ error: 'Backup not found' });
  res.download(p, req.params.name);
});
app.delete('/api/backups/:name', wrap((req, res) => { backups.deleteBackup(req.params.name); res.json({ ok: true }); }));

app.post('/api/settings/logout-all', (req, res) => { logoutEverywhere(); logout(req, res); });
app.post('/api/settings/password', wrap(async (req, res) => { await changePassword(req.body?.current, req.body?.next); logout(req, res); }));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => { if (!err.status || err.status >= 500) console.error(err); res.status(err.status || 500).json({ error: err.expose ? err.message : 'Server error' }); });

export { app };

// Start the web server and WhatsApp only when run directly (`npm start`), not when imported by the tests.
const isMain = process.env.QB_START === '1' || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) {
  const PORT = Number(process.env.PORT || 3000);
  const HOST = process.env.HOST || '127.0.0.1';   // only this computer by default; set HOST=0.0.0.0 to open to the network
  app.listen(PORT, HOST, () => {
    console.log(`\n  ✔ Dashboard running on http://localhost:${PORT}${HOST === '127.0.0.1' ? '  (this computer only)' : `  (listening on ${HOST})`}\n`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.log('  ⚠  The dashboard is reachable from other devices. Use HTTPS (a reverse proxy) before exposing it to the internet.\n');
  });
  if (!DEMO) waMod.startWhatsApp().catch(e => { console.error('[wa] failed to start:', e); wa.status = 'disconnected'; wa.lastError = e.message; });
  waMod.startInviteRotation();
  backups.startBackupSchedule();
  waMod.startPaymentReminders();

  // Clean shutdown (server restarts, `docker compose down`, deploys): finish writes and close WhatsApp properly.
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
    if (stopping) return; stopping = true;
    console.log(`\n  Shutting down (${sig})…`);
    try { wa.sock?.end(new Error('shutdown')); } catch { /* ignore */ }
    try { db.db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
}
