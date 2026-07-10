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
const { currentUser } = require('../lib/auth');
const { kvGet } = require('../lib/store');

// If an admin uploaded a schedule (stored in KV), it permanently replaces the
// Schedule tab's baseline. Only read the (larger) blob when rebuilding.
async function applyScheduleOverride(payload) {
  try {
    const raw = await kvGet('tkv:schedule');
    if (raw) {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.activities) && s.activities.length) {
        payload.schedule = { activities: s.activities, relationships: s.relationships || [], wbs: s.wbs || {} };
      }
    }
  } catch (e) { /* keep the baseline on any store error */ }
  return payload;
}

const DAV_BASE = 'https://dav.jianguoyun.com/dav/';
// Two P6 schedules: the Schedule tab shows the accepted BASELINE; the Delay &
// Disruption tab shows the TIA (Time Impact Analysis) schedule with delay events.
const DEFAULT_XER_PATH = 'Shared Folder/Schedule/Baseline Schedule/accepted baseline-Final/TKV-BL-A.xer';
const DELAY_XER_PATH = 'Shared Folder/Schedule/TKV-BL-A-2 (TIA-Bishan).xer';
const encPath = (p) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

// Module-level caches survive across requests on a warm serverless instance.
const fileCache = new Map(); // path -> { mtime, buffer }
const xerCache = new Map();  // path -> { mtime, text }  (baseline + delay schedules)
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
  // Milestone Payment Summary — provides ONLY each IPC's sub-activity work-item
  // breakdown ('IPCs and Details' sheet); merged into the EV-derived IPC list.
  // MUST be listed BEFORE the Earned Value workbook: this file also has a sheet
  // named 'Summary', and later sources win on name collision — so the Earned
  // Value workbook (loaded last) keeps ownership of the 'Summary' sheet.
  { name: 'Milestone Payment Summary.xlsx', url: 'https://www.dropbox.com/scl/fi/7vj9upjzp3vikdwopnz89/Milestone-Payment-Summary-Govin-Bardewa-s-conflicted-copy-2026-07-02.xlsx?rlkey=nt7dyrdm50zuqrvt6lkseeada&dl=1' },
  // Earned Value Calculation workbook — source of truth for the headline
  // financials (earned value, contract, received, financial-progress %).
  { name: 'Earned Value Calculation_Tamakoshi-V.xlsx', url: 'https://www.dropbox.com/scl/fi/v4dij9hy9ki9qc6acxv9a/Earned-Value-Calculation_Tamakoshi-V.xlsx?rlkey=tshumcv26pkuc4ceh0r33wxfp&dl=1' },
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
  const c = xerCache.get(p);
  if (c && c.mtime && c.mtime === mtime) return c.text;
  const res = await fetch(DAV_BASE + encPath(p), { headers });
  if (!res.ok) return null;
  const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
  xerCache.set(p, { mtime, text });
  return text;
}

// Parse buffers + XER into the API payload (no generatedAt — added fresh each send).
function assemble(buffers, xerText, delayXerText, source) {
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
  // Delay/TIA schedule for the Delay & Disruption tab; falls back to the main
  // schedule if a separate delay XER isn't available.
  const delaySchedule = delayXerText ? parseXer(delayXerText) : schedule;
  return {
    source,
    // tunnel/KPI "sheet not found" warnings are expected (those legacy sample
    // sheets aren't part of the live data) — omit them so the banner stays quiet.
    warnings: [...scurve.warnings, ...finance.warnings, ...manpower.warnings,
      ...ipc.warnings, ...schedule.warnings],
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
    delaySchedule: { activities: delaySchedule.activities, relationships: delaySchedule.relationships, wbs: delaySchedule.wbs },
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
    const delayXerPath = process.env.NUTSTORE_DELAY_XER_PATH || DELAY_XER_PATH;

    // Nutstore folder PROPFIND + both XER PROPFINDs + Dropbox fetches + the small
    // schedule-override version marker, all parallel.
    const [listing, xerInfo, delayXerInfo, dbx, schedVer] = await Promise.all([
      propfind(DAV_BASE + encPath(dir) + '/', headers, 1),
      propfind(DAV_BASE + encPath(xerPath), headers, 0),
      propfind(DAV_BASE + encPath(delayXerPath), headers, 0),
      fetchDropbox(),
      kvGet('tkv:schedule_ver').catch(() => null),
    ]);
    let entries = listing.filter((e) => /\.xlsx$/i.test(e.path) && !/\/~\$/.test(e.path));
    if (!entries.length) entries = process.env.NUTSTORE_FILE_PATH.split(';').map((p) => ({ path: p.trim(), mtime: '' })).filter((e) => e.path);
    // Drop any Nutstore file that Dropbox now supplies (Dropbox is the source of truth).
    entries = entries.filter((e) => !DBX_NAMEKEYS.has(normName(e.path.split('/').pop())));
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const xerMtime = (xerInfo[0] && xerInfo[0].mtime) || '';
    const delayXerMtime = (delayXerInfo[0] && delayXerInfo[0].mtime) || '';

    const sig = JSON.stringify({
      wb: entries.map((e) => e.path + '|' + e.mtime),
      xer: xerPath + '|' + xerMtime,
      dxer: delayXerPath + '|' + delayXerMtime,
      sched: schedVer || '',
      dbx: dbx.map((d) => d.name + '|' + d.etag),
    });
    if (payloadCache && payloadCache.sig === sig) { // nothing changed — reuse parsed payload
      payloadCache.ts = Date.now();
      return stamp(payloadCache.payload);
    }

    const [nutBuffers, xerText, delayXerText] = await Promise.all([
      Promise.all(entries.map((e) => getBuffer(e.path, e.mtime, headers))),
      getXer(xerPath, xerMtime, headers),
      getXer(delayXerPath, delayXerMtime, headers),
    ]);
    const buffers = [...nutBuffers, ...dbx.filter((d) => d.buffer).map((d) => d.buffer)];
    const payload = assemble(buffers, xerText, delayXerText, 'nutstore');
    payload.warnings = [...payload.warnings, ...dbx.filter((d) => d.warning).map((d) => d.warning)];
    if (schedVer) await applyScheduleOverride(payload);
    payloadCache = { sig, payload, ts: Date.now() };
    return stamp(payload);
  }

  // ----- local development: data/ folder (+ Dropbox), cached by file mtime/etag -----
  const dir = path.join(__dirname, '..', 'data');
  const files = fs.readdirSync(dir).filter((f) => (f.endsWith('.xlsx') || f.endsWith('.xer')) && !f.startsWith('~$')).sort();
  const dbx = await fetchDropbox();
  const schedVer = await kvGet('tkv:schedule_ver').catch(() => null);
  const sig = JSON.stringify({
    local: files.map((f) => f + '|' + fs.statSync(path.join(dir, f)).mtimeMs),
    sched: schedVer || '',
    dbx: dbx.map((d) => d.name + '|' + d.etag),
  });
  if (payloadCache && payloadCache.sig === sig) return stamp(payloadCache.payload);
  const localBuffers = files.filter((f) => f.endsWith('.xlsx') && !DBX_NAMEKEYS.has(normName(f)))
    .map((f) => fs.readFileSync(path.join(dir, f)));
  const buffers = [...localBuffers, ...dbx.filter((d) => d.buffer).map((d) => d.buffer)];
  const xerFiles = files.filter((f) => f.endsWith('.xer'));
  const baselineXf = xerFiles.find((f) => /baseline|TKV-BL-A\.xer/i.test(f)) || xerFiles[0];
  const delayXf = xerFiles.find((f) => /tia|delay|BL-A-2/i.test(f)) || baselineXf;
  const readXer = (f) => (f ? fs.readFileSync(path.join(dir, f), 'latin1') : null);
  const payload = assemble(buffers, readXer(baselineXf), readXer(delayXf), 'local-file');
  payload.warnings = [...payload.warnings, ...dbx.filter((d) => d.warning).map((d) => d.warning)];
  if (schedVer) await applyScheduleOverride(payload);
  payloadCache = { sig, payload, ts: Date.now() };
  return stamp(payload);
}

module.exports = async (req, res) => {
  // Allow the standalone TamakoshiTracker.html (opened from disk) to call this.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  // The dashboard data is private — a valid session is required.
  const me = await currentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = await buildPayload();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
};
module.exports.buildPayload = buildPayload;
