// Admin-only: persist app-entered financials (stored in KV as tkv:finance) that
// /api/data then applies on top of the Earned Value workbook, so the dashboard
// is driven by what's entered here. Also serves a formatted Excel export.
//   GET    /api/finance          -> the saved override (or {saved:false})
//   POST   /api/finance          -> save the override  { budget, received, ... }
//   DELETE /api/finance          -> clear it (revert to the live workbook)
//   GET    /api/finance?export=1 -> download the Milestone Payment Summary xlsx
const { kvGet, kvSet, kvDel } = require('../lib/store');
const { currentUser } = require('../lib/auth');
const { buildFinanceWorkbook } = require('../lib/finance-export');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const me = await currentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });

    // Export is available to anyone who can see the finance section; edits are
    // admin-only. Accepts the current form data in the POST body (so exporting
    // reflects unsaved edits); otherwise falls back to the saved override.
    const wantsExport = req.query && (req.query.export || req.query.export === '');
    if (wantsExport && (req.method === 'GET' || req.method === 'POST')) {
      const posted = req.body && req.body.data;
      const raw = posted ? null : await kvGet('tkv:finance');
      const data = posted || (raw ? JSON.parse(raw) : null);
      if (!data) return res.status(404).json({ error: 'No financial data to export yet.' });
      const buf = await buildFinanceWorkbook(data);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="Milestone Payment Summary.xlsx"');
      return res.status(200).send(buf);
    }

    if (req.method === 'GET') {
      const raw = await kvGet('tkv:finance');
      return res.status(200).json(raw ? { saved: true, data: JSON.parse(raw) } : { saved: false });
    }

    if (!me.isAdmin) return res.status(403).json({ error: 'Admin only' });

    if (req.method === 'POST') {
      const data = (req.body && req.body.data) || req.body || {};
      if (!data || typeof data !== 'object') return res.status(400).json({ error: 'No data.' });
      await kvSet('tkv:finance', JSON.stringify(data));
      await kvSet('tkv:finance_ver', String(Date.now()));
      return res.status(200).json({ ok: true, ipcs: Array.isArray(data.ipcs) ? data.ipcs.length : 0 });
    }

    if (req.method === 'DELETE') {
      await kvDel('tkv:finance');
      await kvDel('tkv:finance_ver');
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
