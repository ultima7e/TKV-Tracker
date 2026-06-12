// Vercel serverless function. Downloads the workbook from Nutstore via
// WebDAV (plain HTTPS GET + Basic auth) when NUTSTORE_* env vars are set;
// otherwise reads data/sample.xlsx (local development).
//
// Required env vars in production (set in Vercel project settings):
//   NUTSTORE_USER      - Nutstore account email
//   NUTSTORE_PASSWORD  - Nutstore APP password (not the login password)
//   NUTSTORE_FILE_PATH - path under /dav/, e.g. "ProjectData/tracker.xlsx"
const fs = require('fs');
const path = require('path');
const { workbookToRows, workbookToMatrices } = require('../lib/workbook');
const { parseTunnel, parseKpis, parseSCurve, parseFinance, parseManpower } = require('../lib/parsers');

const DAV_BASE = 'https://dav.jianguoyun.com/dav/';

// NUTSTORE_FILE_PATH may list several files separated by ';' — each is
// fetched and their sheets merged (later files win on duplicate names).
async function fetchWorkbookBuffers() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD, NUTSTORE_FILE_PATH } = process.env;
  if (NUTSTORE_USER && NUTSTORE_PASSWORD && NUTSTORE_FILE_PATH) {
    const auth = Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64');
    const paths = NUTSTORE_FILE_PATH.split(';').map((p) => p.trim()).filter(Boolean);
    const buffers = [];
    for (const p of paths) {
      const url = DAV_BASE + p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
      const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
      if (!res.ok) {
        throw new Error(`Nutstore responded ${res.status} ${res.statusText} for "${p}"`);
      }
      buffers.push(Buffer.from(await res.arrayBuffer()));
    }
    return { buffers, source: 'nutstore' };
  }
  // Local development: merge every workbook in data/ (Excel lock files excluded).
  const dir = path.join(__dirname, '..', 'data');
  const buffers = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.xlsx') && !f.startsWith('~$'))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f)));
  return { buffers, source: 'local-file' };
}

async function buildPayload() {
  const { buffers, source } = await fetchWorkbookBuffers();
  const sheets = {};
  const matrices = {};
  for (const buffer of buffers) {
    Object.assign(sheets, workbookToRows(buffer));
    Object.assign(matrices, workbookToMatrices(buffer));
  }
  const tunnel = parseTunnel(sheets);
  const executive = parseKpis(sheets);
  const scurve = parseSCurve(matrices);
  const finance = parseFinance(matrices);
  const manpower = parseManpower(matrices);
  return {
    generatedAt: new Date().toISOString(),
    source,
    warnings: [...tunnel.warnings, ...executive.warnings, ...scurve.warnings,
      ...finance.warnings, ...manpower.warnings],
    tunnel: { tunnels: tunnel.tunnels, monthlyAdvance: tunnel.monthlyAdvance },
    executive: { kpis: executive.kpis },
    scurve: { months: scurve.months, plannedPct: scurve.plannedPct, actualPct: scurve.actualPct },
    finance,
    manpower: {
      date: manpower.date,
      mobilized: manpower.mobilized,
      mobilizedTotal: manpower.mobilizedTotal,
      idle: manpower.idle,
      idleTotal: manpower.idleTotal,
    },
  };
}

module.exports = async (req, res) => {
  // Allow the standalone TamakoshiTracker.html (opened from disk, origin
  // "null") to call this API. Exposes project data read-only; credentials
  // never leave the server.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const payload = await buildPayload();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};
module.exports.buildPayload = buildPayload;
