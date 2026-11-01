import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
if (fs.existsSync('.env')) process.loadEnvFile('.env');

const express = (await import('express')).default;
const db = await import('./db.js');
const { initPassword, changePassword, login, logout, requireAuth, isAuthed } = await import('./auth.js');
const { planReplies, describe, invalidateCatalogue } = await import('./bot.js');
const { PRESETS, DEFAULT_TEMPLATES, TEMPLATE_VARIABLES } = await import('./presets.js');
const waMod = await import('./whatsapp.js');
const { wa } = waMod;

db.ensureSecrets();
db.seedIfEmpty();
initPassword();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const wrap = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => res.status(400).json({ error: e.message }));

/* ---------------- public ---------------- */
app.use('/assets', express.static(path.join(PUB, 'assets')));
app.get('/login', (req, res) => isAuthed(req) ? res.redirect('/') : res.sendFile(path.join(PUB, 'login.html')));
app.post('/api/login', login);
app.post('/api/logout', logout);

// Public rotating join-QR page — only shows groups you switched on for it, protected by an unguessable token.
app.get('/join/:token', (req, res) => {
  if (req.params.token !== db.getSetting('join_page_token')) return res.status(404).send('Not found');
  res.sendFile(path.join(PUB, 'join.html'));
});
app.get('/api/public/join/:token', wrap(async (req, res) => {
  if (req.params.token !== db.getSetting('join_page_token')) return res.status(404).json({ error: 'Not found' });
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
      jid: g.jid, name: g.name, members: g.members, link: g.invite_code ? `https://chat.whatsapp.com/${g.invite_code}` : null,
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
  });
});
app.get('/api/activity', (_req, res) => res.json(waMod.activity.slice(0, 60)));
app.post('/api/wa/restart', wrap(async (_req, res) => { await waMod.restartWhatsApp(); res.json({ ok: true }); }));
app.post('/api/wa/logout', wrap(async (_req, res) => { await waMod.logoutWhatsApp(); res.json({ ok: true }); }));

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
app.get('/api/templates', (_req, res) => res.json({ templates: db.getTemplates(), defaults: DEFAULT_TEMPLATES, presets: PRESETS, variables: TEMPLATE_VARIABLES }));
app.put('/api/templates/:mode', wrap((req, res) => {
  if (!['quote', 'deal'].includes(req.params.mode)) throw new Error('Unknown template');
  if (!String(req.body?.body || '').trim()) throw new Error('Template cannot be empty');
  db.saveTemplate(req.params.mode, String(req.body.body)); res.json({ ok: true });
}));
app.post('/api/templates/:mode/reset', (req, res) => { db.resetTemplate(req.params.mode); res.json({ ok: true, body: DEFAULT_TEMPLATES[req.params.mode] }); });

// "Try a message": runs the real parser + template without sending anything.
app.post('/api/simulate', wrap(async (req, res) => {
  const { message, mode, body, forceMode, useAi } = req.body || {};
  const plan = await planReplies(String(message || ''), { templateOverride: mode && body ? { mode, body } : null, senderName: 'Rakesh', useAi: !!useAi });
  let replies = plan.replies;
  // When previewing a template mode the message wouldn't trigger, render that mode anyway so the editor always shows something.
  if (forceMode && body && plan.analysis.items.length && !replies.some(r => r.intent === forceMode)) {
    const { buildVars, render } = await import('./quote.js');
    replies = plan.analysis.items.slice(0, 1).map(it => ({ chem: it.chem, intent: forceMode,
      text: render(body, buildVars(it.chem, { ...plan.analysis, alias: it.alias, quantity: it.quantity ?? plan.analysis.quantity }, db.getSettings(), { sender_name: 'Rakesh' })) }));
  }
  res.json({ analysis: describe(plan.analysis), replies: replies.map(r => ({ chemical: r.chem.name, intent: r.intent, text: r.text })), unmatchedReply: plan.unmatchedReply });
}));

/* inquiries / orders */
app.get('/api/inquiries', (req, res) => res.json({ items: db.listInquiries(req.query), stats: db.inquiryStats(), statuses: db.INQUIRY_STATUSES }));
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
  const rows = db.listInquiries({ ...req.query, limit: 100000 });
  const cols = ['id', 'created_at', 'group_name', 'sender_name', 'sender_phone', 'message', 'chemical_name', 'quantity', 'location', 'origin', 'intent', 'quoted_rate', 'status', 'final_rate', 'final_qty', 'owner_notes'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send('﻿' + [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n'));
});

/* join QR (admin view) */
app.get('/api/join', wrap(async (_req, res) => res.json({ ...(await joinPayload(true)), token: db.getSetting('join_page_token') })));
app.post('/api/join/:jid/rotate', wrap(async (req, res) => res.json(await waMod.rotateInvite(req.params.jid))));
app.post('/api/join/token', (_req, res) => { db.setSetting('join_page_token', crypto.randomBytes(9).toString('base64url')); res.json({ token: db.getSetting('join_page_token') }); });

/* settings */
app.get('/api/settings', (_req, res) => res.json({ settings: db.getSettings(), aiKeyPresent: !!process.env.ANTHROPIC_API_KEY }));
app.put('/api/settings', wrap((req, res) => {
  const body = req.body || {};
  for (const k of Object.keys(db.SETTING_DEFAULTS)) {
    if (!(k in body) || k === 'join_page_token') continue;
    const def = db.SETTING_DEFAULTS[k];
    let v = body[k];
    if (typeof def === 'number') { v = Number(v); if (!Number.isFinite(v) || v < 0) throw new Error(`Invalid value for ${k}`); }
    if (typeof def === 'boolean') v = !!v;
    if (typeof def === 'string') v = String(v);
    db.setSetting(k, v);
  }
  if (Number(db.getSetting('invite_rotate_minutes')) < 2) db.setSetting('invite_rotate_minutes', 2);
  invalidateCatalogue();
  res.json({ settings: db.getSettings() });
}));
app.post('/api/settings/password', wrap((req, res) => { changePassword(req.body?.current, req.body?.next); logout(req, res); }));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => { console.error(err); res.status(err.status || 500).json({ error: err.expose ? err.message : 'Server error' }); });

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`\n  ✔ Dashboard running on http://localhost:${PORT}\n`));

waMod.startWhatsApp().catch(e => { console.error('[wa] failed to start:', e); wa.status = 'disconnected'; wa.lastError = e.message; });
waMod.startInviteRotation();
