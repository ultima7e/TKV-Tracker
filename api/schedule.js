// Admin-only: persist an uploaded P6 schedule (progress or baseline).
// Progress: replaces the baseline shown on the Schedule tab (until reset).
// Baseline: stored separately for comparison. The client parses the XER
// and POSTs { activities, relationships?, wbs?, name?, kind? }; /api/data serves it.
// kind='baseline' -> tkv:baseline, tkv:baseline_ver; otherwise -> tkv:schedule, tkv:schedule_ver.
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
      const kind = s.kind === 'baseline' ? 'baseline' : 'progress';
      if (!Array.isArray(s.activities) || !s.activities.length) {
        return res.status(400).json({ error: 'No activities in the uploaded schedule.' });
      }
      await kvDel('tkv:schedule_cleared');   // any upload lifts the cleared-all state
      if (kind === 'baseline') {
        const blob = JSON.stringify({
          activities: s.activities, wbs: s.wbs || {},
          name: typeof s.name === 'string' ? s.name : '', uploadedAt: Date.now(),
        });
        await kvSet('tkv:baseline', blob);
        await kvSet('tkv:baseline_ver', String(Date.now()));
        return res.status(200).json({ ok: true, kind, activities: s.activities.length });
      }
      const blob = JSON.stringify({ activities: s.activities, relationships: s.relationships || [], wbs: s.wbs || {} });
      await kvSet('tkv:schedule', blob);
      await kvSet('tkv:schedule_ver', String(Date.now()));
      return res.status(200).json({ ok: true, kind, activities: s.activities.length });
    }

    if (req.method === 'DELETE') {
      const qk = req.query && req.query.kind;
      const kind = qk === 'baseline' ? 'baseline' : qk === 'all' ? 'all' : 'progress';
      if (kind === 'all') {
        // Wipe both uploaded slots AND flag the schedule cleared, so /api/data stops
        // falling back to the default Nutstore baseline until the next upload.
        await kvDel('tkv:schedule'); await kvDel('tkv:schedule_ver');
        await kvDel('tkv:baseline'); await kvDel('tkv:baseline_ver');
        await kvSet('tkv:schedule_cleared', String(Date.now()));
        return res.status(200).json({ ok: true, cleared: 'all' });
      }
      if (kind === 'baseline') {
        await kvDel('tkv:baseline');
        await kvDel('tkv:baseline_ver');
        return res.status(200).json({ ok: true, cleared: 'baseline' });
      }
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
