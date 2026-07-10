// POST /api/login {username, password} -> verify (store account or bootstrap
// admin) -> set session cookie + return the token (for the standalone file).
const { getUsers } = require('../lib/store');
const { verifyPassword, signToken, sessionCookie, SECTIONS } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Enter a username and password.' });
    const users = await getUsers();
    const rec = users[username];
    let ok = false, isAdmin = false, sections = [];
    if (rec) {
      ok = verifyPassword(password, rec.pass);
      isAdmin = !!rec.isAdmin;
      sections = isAdmin ? SECTIONS.slice() : (rec.sections || []);
    } else if (process.env.ADMIN_USER && username === process.env.ADMIN_USER
      && process.env.ADMIN_PASSWORD && password === process.env.ADMIN_PASSWORD) {
      ok = true; isAdmin = true; sections = SECTIONS.slice();
    }
    if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
    const token = signToken(username);
    res.setHeader('Set-Cookie', sessionCookie(token));
    return res.status(200).json({ ok: true, username, isAdmin, sections, token });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
