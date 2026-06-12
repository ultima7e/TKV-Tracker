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
const { workbookToRows } = require('../lib/workbook');
const { parseTunnel, parseKpis } = require('../lib/parsers');

const DAV_BASE = 'https://dav.jianguoyun.com/dav/';

async function fetchWorkbookBuffer() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD, NUTSTORE_FILE_PATH } = process.env;
  if (NUTSTORE_USER && NUTSTORE_PASSWORD && NUTSTORE_FILE_PATH) {
    const url = DAV_BASE + NUTSTORE_FILE_PATH.replace(/^\/+/, '')
      .split('/').map(encodeURIComponent).join('/');
    const auth = Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64');
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) {
      throw new Error(`Nutstore responded ${res.status} ${res.statusText}`);
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), source: 'nutstore' };
  }
  const local = path.join(__dirname, '..', 'data', 'sample.xlsx');
  return { buffer: fs.readFileSync(local), source: 'local-file' };
}

async function buildPayload() {
  const { buffer, source } = await fetchWorkbookBuffer();
  const sheets = workbookToRows(buffer);
  const tunnel = parseTunnel(sheets);
  const executive = parseKpis(sheets);
  return {
    generatedAt: new Date().toISOString(),
    source,
    warnings: [...tunnel.warnings, ...executive.warnings],
    tunnel: { tunnels: tunnel.tunnels, monthlyAdvance: tunnel.monthlyAdvance },
    executive: { kpis: executive.kpis },
  };
}

module.exports = async (req, res) => {
  try {
    const payload = await buildPayload();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};
module.exports.buildPayload = buildPayload;
