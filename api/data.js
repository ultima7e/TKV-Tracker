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
const { parseTunnel, parseKpis, parseSCurve, parseFinance, parseManpower, parseIpc, parseFinanceDetail } = require('../lib/parsers');
const { parseXer } = require('../lib/xer');

const DAV_BASE = 'https://dav.jianguoyun.com/dav/';

const encPath = (p) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

// Production: load EVERY .xlsx in the Nutstore folder so newly-added workbooks
// (e.g. the daily manpower sheet) are picked up automatically — no env-var
// change needed. The folder is taken from NUTSTORE_FILE_PATH (dir of the first
// entry). Falls back to the explicit ';'-separated list if listing fails.
async function fetchWorkbookBuffers() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD, NUTSTORE_FILE_PATH } = process.env;
  if (NUTSTORE_USER && NUTSTORE_PASSWORD && NUTSTORE_FILE_PATH) {
    const auth = Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };
    const first = NUTSTORE_FILE_PATH.split(';')[0].trim().replace(/^\/+/, '');
    const dir = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : '';

    let paths = [];
    try {
      const res = await fetch(DAV_BASE + encPath(dir) + '/', { method: 'PROPFIND', headers: { ...headers, Depth: '1' } });
      if (res.ok) {
        const xml = await res.text();
        paths = [...xml.matchAll(/<[a-z]*:?href>([^<]*)<\/[a-z]*:?href>/gi)]
          .map((m) => decodeURIComponent(m[1]).replace(/^\/dav\//, '').replace(/\/$/, ''))
          .filter((h) => /\.xlsx$/i.test(h) && !/\/~\$/.test(h));
      }
    } catch { /* fall through to explicit list */ }
    if (!paths.length) paths = NUTSTORE_FILE_PATH.split(';').map((p) => p.trim()).filter(Boolean);

    const buffers = [];
    for (const p of paths) {
      const res = await fetch(DAV_BASE + encPath(p), { headers });
      if (!res.ok) throw new Error(`Nutstore responded ${res.status} ${res.statusText} for "${p}"`);
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

// Default Nutstore location of the P6 schedule. Kept in code (not a secret) so
// the live site works without a Vercel env-var change; override with NUTSTORE_XER_PATH.
const DEFAULT_XER_PATH = 'Shared Folder/Schedule/TKV-BL-A-2 (TIA-Bishan).xer';

// The P6 schedule (.xer) — fetched from Nutstore in production, or the first
// .xer in data/ during local dev. Returns null if none is found.
async function fetchXerText() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD, NUTSTORE_XER_PATH } = process.env;
  if (NUTSTORE_USER && NUTSTORE_PASSWORD) {
    const auth = Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64');
    const res = await fetch(DAV_BASE + encPath(NUTSTORE_XER_PATH || DEFAULT_XER_PATH), { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer()).toString('latin1');
  }
  const dir = path.join(__dirname, '..', 'data');
  const f = fs.readdirSync(dir).find((x) => x.endsWith('.xer') && !x.startsWith('~$'));
  return f ? fs.readFileSync(path.join(dir, f), 'latin1') : null;
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
  const ipc = parseIpc(matrices);
  const financeDetail = parseFinanceDetail(matrices);
  const xerText = await fetchXerText().catch(() => null);
  const schedule = xerText ? parseXer(xerText)
    : { activities: [], relationships: [], wbs: {}, warnings: [] };
  return {
    generatedAt: new Date().toISOString(),
    source,
    warnings: [...tunnel.warnings, ...executive.warnings, ...scurve.warnings,
      ...finance.warnings, ...manpower.warnings, ...ipc.warnings, ...schedule.warnings],
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
    ipc: { rows: ipc.rows, total: ipc.total },
    financeDetail,
    schedule: { activities: schedule.activities, relationships: schedule.relationships, wbs: schedule.wbs },
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
