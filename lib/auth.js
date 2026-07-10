// Auth primitives: password hashing, signed session tokens, and resolving the
// current user from a request. No external deps (Node crypto only). Sections and
// admin status are looked up fresh from the store on every request, so access
// changes made in the admin panel take effect immediately.
const crypto = require('crypto');
const { getUsers } = require('./store');

// The nine grantable sections (must match the nav item data-v ids in the UI).
const SECTIONS = ['exec', 'fin', 'sched', 'tunnel', 'claims', 'inv', 'man', 'equip', 'safety'];
const TTL = 12 * 3600; // session lifetime, seconds
const secret = () => process.env.AUTH_SECRET || 'dev-insecure-secret-change-me';

const hmac = (data) => crypto.createHmac('sha256', secret()).update(data).digest();
const b64u = (buf) => Buffer.from(buf).toString('base64url');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signToken(username) {
  const payload = b64u(JSON.stringify({ u: username, exp: Math.floor(Date.now() / 1000) + TTL }));
  return `${payload}.${b64u(hmac(payload))}`;
}
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = b64u(hmac(payload));
  const a = Buffer.from(sig || '', 'utf8'), b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data; try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!data || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data; // { u, exp }
}

// Token from an Authorization: Bearer header (standalone) or the session cookie.
function readToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)tkv_session=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Resolve the authenticated user (fresh from the store) or null.
// { username, isAdmin, sections }. A bootstrap admin (env ADMIN_USER) works even
// with an empty store so the very first login can create real accounts.
async function currentUser(req) {
  const t = verifyToken(readToken(req));
  if (!t) return null;
  const users = await getUsers();
  const rec = users[t.u];
  if (rec) {
    return { username: t.u, isAdmin: !!rec.isAdmin, sections: rec.isAdmin ? SECTIONS.slice() : (rec.sections || []) };
  }
  if (process.env.ADMIN_USER && t.u === process.env.ADMIN_USER) {
    return { username: t.u, isAdmin: true, sections: SECTIONS.slice() };
  }
  return null;
}

const sessionCookie = (token) =>
  `tkv_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${TTL}; Secure`;
const clearCookie = () => 'tkv_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';

module.exports = {
  SECTIONS, TTL, hashPassword, verifyPassword, signToken, verifyToken,
  readToken, currentUser, sessionCookie, clearCookie,
};
