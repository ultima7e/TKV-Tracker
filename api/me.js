// GET /api/me -> the current session's identity + granted sections, or 401.
const { currentUser } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: 'Not authenticated' });
    return res.status(200).json({ username: u.username, isAdmin: u.isAdmin, sections: u.sections });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
