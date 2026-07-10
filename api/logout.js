// POST /api/logout -> clear the session cookie. (Standalone/token clients just
// drop their stored token client-side.)
const { clearCookie } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('Set-Cookie', clearCookie());
  return res.status(200).json({ ok: true });
};
