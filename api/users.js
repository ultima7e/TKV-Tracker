// Admin-only user management. GET list · POST create/update · DELETE remove.
// Password hashes are never returned to the client.
const { getUsers, saveUsers } = require('../lib/store');
const { currentUser, hashPassword, SECTIONS, findUserKey, eqUser } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const me = await currentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });
    if (!me.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const users = await getUsers();

    if (req.method === 'GET') {
      const list = Object.entries(users).map(([username, r]) => ({
        username, sections: r.sections || [], isAdmin: !!r.isAdmin,
      })).sort((a, b) => a.username.localeCompare(b.username));
      return res.status(200).json({ users: list, sections: SECTIONS });
    }

    if (req.method === 'POST') {
      const { username, password, sections, isAdmin } = req.body || {};
      const name = typeof username === 'string' ? username.trim() : '';
      if (!name) return res.status(400).json({ error: 'Username is required.' });
      // Match an existing account case-insensitively, so editing "Admin" when
      // it was created as "admin" updates the same record instead of duplicating.
      const key = findUserKey(users, name);
      const existing = key ? users[key] : null;
      if (!existing && !password) return res.status(400).json({ error: 'A password is required for a new user.' });
      const rec = existing || {};
      if (password) rec.pass = hashPassword(password);
      if (Array.isArray(sections)) rec.sections = sections.filter((s) => SECTIONS.includes(s));
      else if (!rec.sections) rec.sections = [];
      rec.isAdmin = !!isAdmin;
      users[key || name] = rec;
      await saveUsers(users);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const u = (req.query && req.query.u) || (req.body && req.body.username);
      if (!u) return res.status(400).json({ error: 'username required' });
      if (eqUser(u, me.username)) return res.status(400).json({ error: "You can't delete your own account." });
      const key = findUserKey(users, u);
      if (key) delete users[key];
      await saveUsers(users);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    const msg = String(e.message || e);
    if (/EROFS|read-only|KV (get|set) failed|ENOENT/i.test(msg)) {
      return res.status(503).json({ error: 'User database not connected yet. In Vercel, add a KV / Upstash Redis store (Storage → Create → Upstash for Redis → Connect to project), then redeploy.' });
    }
    return res.status(500).json({ error: msg });
  }
};
