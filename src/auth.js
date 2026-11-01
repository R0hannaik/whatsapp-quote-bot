// Password protection for the dashboard: scrypt-hashed password, signed session cookie, login rate limit.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
const scryptAsync = promisify(crypto.scrypt);
import { getSetting, setSetting } from './db.js';

const COOKIE = 'qb_session';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 72);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
async function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = await scryptAsync(String(pw).slice(0, 256), salt, 64);   // async: doesn't freeze the bot while hashing
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

/** First run: take DASHBOARD_PASSWORD from .env. Afterwards the password can be changed in Settings. */
export function initPassword() {
  if (getSetting('password_hash')) return;
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw || pw.length < 8 || pw === 'change-me-please') {
    console.error('\n  ✖ Set DASHBOARD_PASSWORD (at least 8 characters, not the example value) in your .env file before the first start.\n');
    process.exit(1);
  }
  setSetting('password_hash', hashPassword(pw));
  setSetting('password_version', 1);
}

export async function changePassword(current, next) {
  if (!await verifyPassword(current || '', getSetting('password_hash'))) throw new Error('Current password is incorrect');
  if (!next || next.length < 8) throw new Error('New password must be at least 8 characters');
  if (next.length > 256) throw new Error('Password is too long');
  setSetting('password_hash', hashPassword(next));
  setSetting('password_version', (getSetting('password_version') || 1) + 1);   // logs out other sessions
}

const sign = payload => crypto.createHmac('sha256', getSetting('session_secret')).update(payload).digest('base64url');

function issueToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600e3, v: getSetting('password_version') || 1 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function validToken(token) {
  if (!token || token.length > 1000 || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const a = Buffer.from(String(sig || '')), b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp, v } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return exp > Date.now() && v === (getSetting('password_version') || 1);
  } catch { return false; }
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  if (!m) return null;
  try { return decodeURIComponent(m.slice(COOKIE.length + 1)); } catch { return null; }
}

export const isAuthed = req => validToken(readCookie(req));

const WINDOW = 15 * 60000;
const attempts = new Map();   // ip -> [failure timestamps]
let globalFails = [];         // all failures, to slow attackers who rotate IP addresses
setInterval(() => {           // forget old entries so the map can't grow forever
  const now = Date.now();
  for (const [ip, list] of attempts) { const keep = list.filter(t => now - t < WINDOW); keep.length ? attempts.set(ip, keep) : attempts.delete(ip); }
  globalFails = globalFails.filter(t => now - t < WINDOW);
}, 60000).unref();

export async function login(req, res) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter(t => now - t < WINDOW);
  globalFails = globalFails.filter(t => now - t < WINDOW);
  if (recent.length >= 8) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (globalFails.length >= 50) return res.status(429).json({ error: 'Login temporarily locked after many failed attempts. Try again in a few minutes.' });
  const ok = await verifyPassword(typeof req.body?.password === 'string' ? req.body.password : '', getSetting('password_hash'));
  if (!ok) {
    recent.push(now); attempts.set(ip, recent); globalFails.push(now);
    if (!process.env.QB_QUIET) console.warn(`[auth] failed login from ${ip} (${recent.length} in 15 min)`);
    await new Promise(r => setTimeout(r, 400 + Math.random() * 400));
    return res.status(401).json({ error: 'Incorrect password' });
  }
  attempts.delete(ip);
  const secure = req.secure || (req.app.get('trust proxy') && req.headers['x-forwarded-proto'] === 'https');
  res.setHeader('Set-Cookie', `${COOKIE}=${issueToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
}
export function logoutEverywhere() {
  setSetting('password_version', (getSetting('password_version') || 1) + 1);
}
export function logout(_req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
  res.redirect('/login');
}
