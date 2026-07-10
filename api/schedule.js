// Admin-only: persist an uploaded P6 schedule so it permanently replaces the
// baseline shown on the Schedule tab (until reset). The client parses the XER
// and POSTs { activities, relationships, wbs }; /api/data then serves it.
const { kvSet, kvDel } = require('../lib/store');
const { currentUser } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const me = await currentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });
    if (!me.isAdmin) return res.status(403).json({ error: 'Admin only' });

    if (req.method === 'POST') {
      const s = req.body || {};
      if (!Array.isArray(s.activities) || !s.activities.length) {
        return res.status(400).json({ error: 'No activities in the uploaded schedule.' });
      }
      const blob = JSON.stringify({ activities: s.activities, relationships: s.relationships || [], wbs: s.wbs || {} });
      await kvSet('tkv:schedule', blob);
      await kvSet('tkv:schedule_ver', String(Date.now()));
      return res.status(200).json({ ok: true, activities: s.activities.length });
    }

    if (req.method === 'DELETE') {
      await kvDel('tkv:schedule');
      await kvDel('tkv:schedule_ver');
      return res.status(200).json({ ok: true, reverted: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    const msg = String(e.message || e);
    if (/EROFS|read-only|KV (get|set|del) failed/i.test(msg)) {
      return res.status(503).json({ error: 'Storage not connected — add a Vercel KV / Upstash store, then redeploy.' });
    }
    return res.status(500).json({ error: msg });
  }
};
