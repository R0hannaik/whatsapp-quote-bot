// Password protection for the dashboard: scrypt-hashed password, signed session cookie, login rate limit.
import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';

const COOKIE = 'qb_session';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 72);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

/** First run: take DASHBOARD_PASSWORD from .env. Afterwards the password can be changed in Settings. */
export function initPassword() {
  if (getSetting('password_hash')) return;
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw || pw.length < 6) {
    console.error('\n  ✖ Set DASHBOARD_PASSWORD (min 6 characters) in your .env file before the first start.\n');
    process.exit(1);
  }
  setSetting('password_hash', hashPassword(pw));
  setSetting('password_version', 1);
}

export function changePassword(current, next) {
  if (!verifyPassword(current, getSetting('password_hash'))) throw new Error('Current password is incorrect');
  if (!next || next.length < 8) throw new Error('New password must be at least 8 characters');
  setSetting('password_hash', hashPassword(next));
  setSetting('password_version', (getSetting('password_version') || 1) + 1);   // logs out other sessions
}

const sign = payload => crypto.createHmac('sha256', getSetting('session_secret')).update(payload).digest('base64url');

function issueToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600e3, v: getSetting('password_version') || 1 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function validToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expect = sign(payload);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  try {
    const { exp, v } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return exp > Date.now() && v === (getSetting('password_version') || 1);
  } catch { return false; }
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : null;
}

export const isAuthed = req => validToken(readCookie(req));

const attempts = new Map(); // ip -> [timestamps]
export function login(req, res) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter(t => now - t < 15 * 60000);
  if (recent.length >= 8) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!verifyPassword(req.body?.password || '', getSetting('password_hash'))) {
    recent.push(now); attempts.set(ip, recent);
    return res.status(401).json({ error: 'Incorrect password' });
  }
  attempts.delete(ip);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${issueToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
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
