// Vercel serverless function. In production it pulls the project workbooks +
// P6 schedule from Nutstore (WebDAV); locally it reads data/*. To keep refreshes
// fast as the data grows it:
//   - lists files with one PROPFIND and reads each file's Last-Modified,
//   - only re-downloads files whose mtime changed (per-file buffer cache),
//   - returns a cached, already-parsed payload when nothing changed at all,
//   - fetches everything in parallel and parses each workbook only once.
const fs = require('fs');
const path = require('path');
const { workbookToBoth } = require('../lib/workbook');
const { parseTunnel, parseKpis, parseSCurve, parseFinance, parseManpower, parseIpc, parseFinanceDetail } = require('../lib/parsers');
const { parseXer } = require('../lib/xer');

const DAV_BASE = 'https://dav.jianguoyun.com/dav/';
const DEFAULT_XER_PATH = 'Shared Folder/Schedule/TKV-BL-A-2 (TIA-Bishan).xer';
const encPath = (p) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

// Module-level caches survive across requests on a warm serverless instance.
const fileCache = new Map(); // path -> { mtime, buffer }
let xerCache = null;         // { path, mtime, text }
let payloadCache = null;     // { sig, payload, ts }
// Within this window a refresh is served straight from memory without even
// checking Nutstore. Kept short, and safe because Nutstore's own upload/sync
// lag is longer — a freshly edited file isn't on the server instantly anyway.
const FRESH_WINDOW_MS = 20000;

// Extra workbooks pulled from Dropbox shared links (direct-download, dl=1).
// Loaded AFTER the Nutstore files so their sheets win — and any Nutstore file
// with the same name is skipped. Dropbox returns an ETag that changes on every
// edit, so a conditional GET both detects changes and avoids re-downloading.
const DROPBOX_SOURCES = [
  { name: 'Milestone Payment Summary.xlsx', url: 'https://www.dropbox.com/scl/fi/pn3b7yp72hhjnky8jg1de/Milestone-Payment-Summary.xlsx?rlkey=obqj3v3t9siif2ujqgb35511j&dl=1' },
];
const dbxCache = new Map(); // url -> { etag, buffer }
const normName = (s) => s.toLowerCase().replace(/[\s\-_]/g, '');
const DBX_NAMEKEYS = new Set(DROPBOX_SOURCES.map((s) => normName(s.name)));

async function dbxFetch(url) {
  const c = dbxCache.get(url);
  const r = await fetch(url, { headers: c && c.etag ? { 'If-None-Match': c.etag } : {} });
  if (r.status === 304 && c) return { etag: c.etag, buffer: c.buffer };
  if (!r.ok) throw new Error(`Dropbox responded ${r.status} for "${url}"`);
  const etag = r.headers.get('etag') || '';
  const buffer = Buffer.from(await r.arrayBuffer());
  dbxCache.set(url, { etag, buffer });
  return { etag, buffer };
}

async function fetchDropbox() {
  return Promise.all(DROPBOX_SOURCES.map(async (s) => {
    try { const { etag, buffer } = await dbxFetch(s.url); return { name: s.name, etag, buffer }; }
    catch (e) { return { name: s.name, etag: 'ERR', buffer: null, warning: `Dropbox '${s.name}' fetch failed: ${e.message}` }; }
  }));
}

function davHeaders() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD } = process.env;
  if (!NUTSTORE_USER || !NUTSTORE_PASSWORD) return null;
  return { Authorization: 'Basic ' + Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64') };
}

// PROPFIND -> [{ path, mtime }] pairing each href with its Last-Modified.
async function propfind(url, headers, depth) {
  const res = await fetch(url, { method: 'PROPFIND', headers: { ...headers, Depth: String(depth) } });
  if (!res.ok) return [];
  const xml = await res.text();
  const out = [];
  for (const block of xml.split(/<[a-z]*:?response>/i).slice(1)) {
    const href = (block.match(/<[a-z]*:?href>([^<]*)<\/[a-z]*:?href>/i) || [])[1];
    const lm = (block.match(/<[a-z]*:?getlastmodified>([^<]*)<\/[a-z]*:?getlastmodified>/i) || [])[1];
    if (href) out.push({ path: decodeURIComponent(href).replace(/^\/dav\//, '').replace(/\/$/, ''), mtime: lm || '' });
  }
  return out;
}

async function getBuffer(p, mtime, headers) {
  const c = fileCache.get(p);
  if (c && c.mtime && c.mtime === mtime) return c.buffer;
  const res = await fetch(DAV_BASE + encPath(p), { headers });
  if (!res.ok) throw new Error(`Nutstore responded ${res.status} ${res.statusText} for "${p}"`);
  const buf = Buffer.from(await res.arrayBuffer());
  fileCache.set(p, { mtime, buffer: buf });
  return buf;
}

async function getXer(p, mtime, headers) {
  if (xerCache && xerCache.path === p && xerCache.mtime && xerCache.mtime === mtime) return xerCache.text;
  const res = await fetch(DAV_BASE + encPath(p), { headers });
  if (!res.ok) return null;
  const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
  xerCache = { path: p, mtime, text };
  return text;
}

// Parse buffers + XER into the API payload (no generatedAt — added fresh each send).
function assemble(buffers, xerText, source) {
  const sheets = {}, matrices = {};
  for (const buffer of buffers) {
    const { rows, matrices: m } = workbookToBoth(buffer);
    Object.assign(sheets, rows);
    Object.assign(matrices, m);
  }
  const tunnel = parseTunnel(sheets);
  const executive = parseKpis(sheets);
  const scurve = parseSCurve(matrices);
  const finance = parseFinance(matrices);
  const manpower = parseManpower(matrices);
  const ipc = parseIpc(matrices);
  const financeDetail = parseFinanceDetail(matrices);
  const schedule = xerText ? parseXer(xerText) : { activities: [], relationships: [], wbs: {}, warnings: [] };
  return {
    source,
    warnings: [...tunnel.warnings, ...executive.warnings, ...scurve.warnings,
      ...finance.warnings, ...manpower.warnings, ...ipc.warnings, ...schedule.warnings],
    tunnel: { tunnels: tunnel.tunnels, monthlyAdvance: tunnel.monthlyAdvance },
    executive: { kpis: executive.kpis },
    scurve: { months: scurve.months, plannedPct: scurve.plannedPct, actualPct: scurve.actualPct },
    finance,
    manpower: {
      date: manpower.date, mobilized: manpower.mobilized, mobilizedTotal: manpower.mobilizedTotal,
      idle: manpower.idle, idleTotal: manpower.idleTotal,
    },
    ipc: { rows: ipc.rows, total: ipc.total },
    financeDetail,
    schedule: { activities: schedule.activities, relationships: schedule.relationships, wbs: schedule.wbs },
  };
}

const stamp = (payload) => ({ ...payload, generatedAt: new Date().toISOString() });

async function buildPayload() {
  const headers = davHeaders();

  if (headers && process.env.NUTSTORE_FILE_PATH) {
    // Fast path: recently validated — skip Nutstore entirely.
    if (payloadCache && Date.now() - payloadCache.ts < FRESH_WINDOW_MS) return stamp(payloadCache.payload);

    const first = process.env.NUTSTORE_FILE_PATH.split(';')[0].trim().replace(/^\/+/, '');
    const dir = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : '';
    const xerPath = process.env.NUTSTORE_XER_PATH || DEFAULT_XER_PATH;

    // Nutstore folder PROPFIND + XER PROPFIND + Dropbox conditional fetches, all parallel.
    const [listing, xerInfo, dbx] = await Promise.all([
      propfind(DAV_BASE + encPath(dir) + '/', headers, 1),
      propfind(DAV_BASE + encPath(xerPath), headers, 0),
      fetchDropbox(),
    ]);
    let entries = listing.filter((e) => /\.xlsx$/i.test(e.path) && !/\/~\$/.test(e.path));
    if (!entries.length) entries = process.env.NUTSTORE_FILE_PATH.split(';').map((p) => ({ path: p.trim(), mtime: '' })).filter((e) => e.path);
    // Drop any Nutstore file that Dropbox now supplies (Dropbox is the source of truth).
    entries = entries.filter((e) => !DBX_NAMEKEYS.has(normName(e.path.split('/').pop())));
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const xerMtime = (xerInfo[0] && xerInfo[0].mtime) || '';

    const sig = JSON.stringify({
      wb: entries.map((e) => e.path + '|' + e.mtime),
      xer: xerPath + '|' + xerMtime,
      dbx: dbx.map((d) => d.name + '|' + d.etag),
    });
    if (payloadCache && payloadCache.sig === sig) { // nothing changed — reuse parsed payload
      payloadCache.ts = Date.now();
      return stamp(payloadCache.payload);
    }

    const [nutBuffers, xerText] = await Promise.all([
      Promise.all(entries.map((e) => getBuffer(e.path, e.mtime, headers))),
      getXer(xerPath, xerMtime, headers),
    ]);
    const buffers = [...nutBuffers, ...dbx.filter((d) => d.buffer).map((d) => d.buffer)];
    const payload = assemble(buffers, xerText, 'nutstore');
    payload.warnings = [...payload.warnings, ...dbx.filter((d) => d.warning).map((d) => d.warning)];
    payloadCache = { sig, payload, ts: Date.now() };
    return stamp(payload);
  }

  // ----- local development: data/ folder (+ Dropbox), cached by file mtime/etag -----
  const dir = path.join(__dirname, '..', 'data');
  const files = fs.readdirSync(dir).filter((f) => (f.endsWith('.xlsx') || f.endsWith('.xer')) && !f.startsWith('~$')).sort();
  const dbx = await fetchDropbox();
  const sig = JSON.stringify({
    local: files.map((f) => f + '|' + fs.statSync(path.join(dir, f)).mtimeMs),
    dbx: dbx.map((d) => d.name + '|' + d.etag),
  });
  if (payloadCache && payloadCache.sig === sig) return stamp(payloadCache.payload);
  const localBuffers = files.filter((f) => f.endsWith('.xlsx') && !DBX_NAMEKEYS.has(normName(f)))
    .map((f) => fs.readFileSync(path.join(dir, f)));
  const buffers = [...localBuffers, ...dbx.filter((d) => d.buffer).map((d) => d.buffer)];
  const xf = files.find((f) => f.endsWith('.xer'));
  const xerText = xf ? fs.readFileSync(path.join(dir, xf), 'latin1') : null;
  const payload = assemble(buffers, xerText, 'local-file');
  payload.warnings = [...payload.warnings, ...dbx.filter((d) => d.warning).map((d) => d.warning)];
  payloadCache = { sig, payload, ts: Date.now() };
  return stamp(payload);
}

module.exports = async (req, res) => {
  // Allow the standalone TamakoshiTracker.html (opened from disk) to call this.
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
