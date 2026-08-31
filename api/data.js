// Vercel serverless function. In production it pulls the project workbooks +
// P6 schedule from Nutstore (WebDAV); locally it reads data/*. To keep refreshes
// fast as the data grows it:
//   - lists files with one PROPFIND and reads each file's Last-Modified,
//   - only re-downloads files whose mtime changed (per-file buffer cache),
//   - returns a cached, already-parsed payload when nothing changed at all,
//   - fetches everything in parallel and parses each workbook only once.
const fs = require('fs');
const path = require('path');
const { workbookToBoth, workbookSheets } = require('../lib/workbook');
const { parseTunnel, parseKpis, parseSCurve, parseFinance, parseManpower, parseIpc, parseFinanceDetail, parseClaims, parseExplosives, parseInsurance, parseFuel, parseClaimsRegister } = require('../lib/parsers');
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

// Overlay the FIXED baseline (tkv:baseline) onto the working schedule: set each
// activity's baseline bars from the baseline file (by Activity ID), append
// baseline-only rows for activities not yet in the monthly progress file, and
// expose a small status for the UI badge. Progress (%/actual dates) is untouched.
async function applyBaselineOverlay(payload) {
  try {
    const raw = await kvGet('tkv:baseline');
    const sched = payload.schedule = payload.schedule || { activities: [], relationships: [], wbs: {} };
    if (!raw) { sched.baseline = { set: false }; return payload; }
    const b = JSON.parse(raw);
    const acts = Array.isArray(b.activities) ? b.activities : [];
    const byId = new Map(acts.map((a) => [a.id, a]));
    const present = new Set();
    for (const a of sched.activities) {
      present.add(a.id);
      const ba = byId.get(a.id);
      if (ba) { a.baselineStart = ba.start || null; a.baselineFinish = ba.finish || null; }
    }
    for (const a of acts) {
      if (present.has(a.id)) continue;
      sched.activities.push({
        // taskId is null for baseline-only rows: they carry no P6 relationships,
        // so they never participate in predecessor/successor lookups.
        taskId: null, id: a.id, name: a.name, wbsId: a.wbsId,
        status: 'Not started', pct: 0, isMilestone: !!a.isMilestone,
        start: null, finish: null, actualStart: null, actualFinish: null,
        baselineStart: a.start || null, baselineFinish: a.finish || null,
        totalFloatDays: 0, critical: false,
      });
    }
    // Working schedule wins shared WBS keys (it's the live source of truth for
    // grouping/names); baseline-only WBS nodes are merged in additively so
    // baseline-only rows still group correctly.
    if (b.wbs) sched.wbs = { ...b.wbs, ...sched.wbs };
    sched.baseline = { set: true, uploadedAt: b.uploadedAt || null, name: b.name || '', count: acts.length };
  } catch (e) { if (payload.schedule) payload.schedule.baseline = { set: false }; }
  return payload;
}

const DAV_BASE = 'https://dav.jianguoyun.com/dav/';
// Two P6 schedules: the Schedule tab shows the accepted BASELINE; the Delay &
// Disruption tab shows the TIA (Time Impact Analysis) schedule with delay events.
const DEFAULT_XER_PATH = 'Shared Folder/Schedule/Baseline Schedule/accepted baseline-Final/TKV-BL-A.xer';
const DELAY_XER_PATH = 'Shared Folder/Schedule/TKV-BL-A-2 (TIA-Bishan).xer';
// Claims & Variations register — a separate Nutstore workbook (its sheets are
// parsed in isolation so 'Summary'/'Variation'/'Sheet1' can't collide with the
// finance workbooks). Editing this file live-updates the Claims panel.
// NB: two copies of this filename exist in the account; this — the maintained
// one under "Contractor's Claims" — is the current register (the "Summary and
// other details" copy is stale and stops at Claim 9).
const CLAIMS_XLSX_PATH = "Shared Folder/Claims & Variation/Contractor's Claims/Claim & Variation Log.xlsx";
// Explosive consumption workbook — its own Nutstore file, parsed in isolation.
const EXPLOSIVES_XLSX_PATH = 'Shared Folder/Explosive Record/Daily Explosive Consumption.xlsx';
// Insurance register — its own Nutstore file (only the 'Summary' sheet is read).
const INSURANCE_XLSX_PATH = 'Insurance and Bank Gurantee/Insurance/Insurance.xlsx';
// Claims & Variations register — its own Nutstore workbook (Claim + Variation
// sheets), parsed in isolation. Host the register file at this path.
const CLAIMS_REGISTER_XLSX_PATH = 'Shared Folder/Claims & Variation/claim and variation (details for presentation)(1).xlsx';
// Fuel consumption workbook — hosted on Dropbox, fetched live and parsed in
// ISOLATION (only 'Appended_Table') so its 10k rows never merge into finance.
const FUEL_DBX_URL = 'https://www.dropbox.com/scl/fi/sd47gb80i8857yeq2n8j2/Fuel_Consumption_EN_Categorized.xlsx?rlkey=wx53urwmerfralt5dwhj4mz4f&dl=1';
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
  // Milestone Payment Summary — the per-IPC sub-activity breakdown ('IPCs and
  // Details' sheet) that powers each IPC's Details panel. Back on Dropbox after
  // the Nutstore copy (Shared Folder/ProgressTracker/Milestone Payment Summary.xlsx)
  // was deleted. It also has a 'Summary' sheet, so it MUST be listed BEFORE the EV
  // workbook below — later Dropbox sources win, and EV must win the shared
  // 'Summary' sheet (source of truth for the headline financials).
  { name: 'Milestone Payment Summary.xlsx', url: 'https://www.dropbox.com/scl/fi/6vdehgln4vzy2yxak108s/Milestone-Payment-Summary.xlsx?rlkey=7oh560te8pwoop875ngwzjxhe&dl=1' },
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

// Parse the Claims workbook in isolation (its own matrices) so its sheet names
// never merge into the finance bag. Returns null if unreadable, letting the
// frontend fall back to its built-in snapshot.
function claimsFromBuffer(buffer) {
  if (!buffer) return null;
  try {
    const { matrices } = workbookToBoth(buffer);
    const c = parseClaims(matrices);
    return c && !c.missing ? c : null;
  } catch (e) { return null; }
}

// Explosive consumption workbook, parsed in isolation (same collision-safety).
function explosivesFromBuffer(buffer) {
  if (!buffer) return null;
  try {
    const { matrices } = workbookToBoth(buffer);
    const e = parseExplosives(matrices);
    return e && !e.missing ? e : null;
  } catch (e) { return null; }
}

// Insurance workbook — only the 'Summary' sheet is converted (the file has a
// 13k-row equipment sheet we don't need).
function insuranceFromBuffer(buffer) {
  if (!buffer) return null;
  try {
    const { matrices } = workbookSheets(buffer, ['Summary', 'CAR Policy', 'Professional Indemnity Insuranc']);
    const i = parseInsurance(matrices);
    return i && !i.missing ? i : null;
  } catch (e) { return null; }
}

function fuelFromBuffer(buffer) {
  if (!buffer) return { missing: true, warnings: ['Fuel workbook not available'] };
  try {
    const { matrices } = workbookSheets(buffer, ['Appended_Table']);
    return parseFuel(matrices);
  } catch (e) {
    return { missing: true, warnings: ['Fuel parse failed: ' + String(e.message || e)] };
  }
}

function claimsRegisterFromBuffer(buffer) {
  if (!buffer) return { missing: true, warnings: ['Claims register workbook not available'] };
  try {
    const { matrices } = workbookSheets(buffer, ['Claim', 'Variation', 'Potential Claim', 'Potential Variation']);
    return parseClaimsRegister(matrices);
  } catch (e) {
    return { missing: true, warnings: ['Claims register parse failed: ' + String(e.message || e)] };
  }
}

// Parse buffers + XER into the API payload (no generatedAt — added fresh each send).
function assemble(buffers, xerText, delayXerText, source, claimsBuffer, explosivesBuffer, insuranceBuffer, fuelBuffer, claimsRegBuffer) {
  const sheets = {}, matrices = {};
  const skipWarnings = [];
  for (const buffer of buffers) {
    // A single unreadable source (e.g. a Dropbox link that now returns an HTML
    // error page instead of the .xlsx) must not blank the whole dashboard.
    try {
      const { rows, matrices: m } = workbookToBoth(buffer);
      Object.assign(sheets, rows);
      Object.assign(matrices, m);
    } catch (e) {
      skipWarnings.push('Skipped an unreadable source file (' + String(e.message || e) + ')');
    }
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
    warnings: [...skipWarnings, ...scurve.warnings, ...finance.warnings, ...manpower.warnings,
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
    claims: claimsFromBuffer(claimsBuffer),
    explosives: explosivesFromBuffer(explosivesBuffer),
    insurance: insuranceFromBuffer(insuranceBuffer),
    claimsRegister: claimsRegisterFromBuffer(claimsRegBuffer),
    fuel: fuelFromBuffer(fuelBuffer),
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

    // Nutstore folder PROPFIND + both XER PROPFINDs + claims PROPFIND + Dropbox
    // fetches + the small schedule-override version marker, all parallel.
    const [listing, xerInfo, delayXerInfo, claimsInfo, explInfo, insInfo, dbx, schedVer, baseVer, fuelDbx, cvInfo, schedCleared] = await Promise.all([
      propfind(DAV_BASE + encPath(dir) + '/', headers, 1),
      propfind(DAV_BASE + encPath(xerPath), headers, 0),
      propfind(DAV_BASE + encPath(delayXerPath), headers, 0),
      propfind(DAV_BASE + encPath(CLAIMS_XLSX_PATH), headers, 0).catch(() => []),
      propfind(DAV_BASE + encPath(EXPLOSIVES_XLSX_PATH), headers, 0).catch(() => []),
      propfind(DAV_BASE + encPath(INSURANCE_XLSX_PATH), headers, 0).catch(() => []),
      fetchDropbox(),
      kvGet('tkv:schedule_ver').catch(() => null),
      kvGet('tkv:baseline_ver').catch(() => null),
      dbxFetch(FUEL_DBX_URL).catch(() => null),
      propfind(DAV_BASE + encPath(CLAIMS_REGISTER_XLSX_PATH), headers, 0).catch(() => []),
      kvGet('tkv:schedule_cleared').catch(() => null),
    ]);
    const claimsMtime = (claimsInfo[0] && claimsInfo[0].mtime) || '';
    const explMtime = (explInfo[0] && explInfo[0].mtime) || '';
    const insMtime = (insInfo[0] && insInfo[0].mtime) || '';
    const cvMtime = (cvInfo[0] && cvInfo[0].mtime) || '';
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
      claims: CLAIMS_XLSX_PATH + '|' + claimsMtime,
      expl: EXPLOSIVES_XLSX_PATH + '|' + explMtime,
      ins: INSURANCE_XLSX_PATH + '|' + insMtime,
      sched: schedVer || '',
      base: baseVer || '',
      cleared: schedCleared || '',
      dbx: dbx.map((d) => d.name + '|' + d.etag),
      fuel: fuelDbx ? fuelDbx.etag : '',
      cvreg: CLAIMS_REGISTER_XLSX_PATH + '|' + cvMtime,
    });
    if (payloadCache && payloadCache.sig === sig) { // nothing changed — reuse parsed payload
      payloadCache.ts = Date.now();
      return stamp(payloadCache.payload);
    }

    const [nutBuffers, xerText, delayXerText, claimsBuffer, explosivesBuffer, insuranceBuffer, claimsRegBuffer] = await Promise.all([
      Promise.all(entries.map((e) => getBuffer(e.path, e.mtime, headers))),
      getXer(xerPath, xerMtime, headers),
      getXer(delayXerPath, delayXerMtime, headers),
      claimsMtime ? getBuffer(CLAIMS_XLSX_PATH, claimsMtime, headers).catch(() => null) : Promise.resolve(null),
      explMtime ? getBuffer(EXPLOSIVES_XLSX_PATH, explMtime, headers).catch(() => null) : Promise.resolve(null),
      insMtime ? getBuffer(INSURANCE_XLSX_PATH, insMtime, headers).catch(() => null) : Promise.resolve(null),
      cvMtime ? getBuffer(CLAIMS_REGISTER_XLSX_PATH, cvMtime, headers).catch(() => null) : Promise.resolve(null),
    ]);
    const buffers = [...nutBuffers, ...dbx.filter((d) => d.buffer).map((d) => d.buffer)];
    const payload = assemble(buffers, xerText, delayXerText, 'nutstore', claimsBuffer, explosivesBuffer, insuranceBuffer, fuelDbx && fuelDbx.buffer, claimsRegBuffer);
    payload.warnings = [...payload.warnings, ...dbx.filter((d) => d.warning).map((d) => d.warning)];
    if (schedCleared) payload.schedule = { activities: [], relationships: [], wbs: {}, cleared: true };
    if (schedVer) await applyScheduleOverride(payload);
    await applyBaselineOverlay(payload);
    payloadCache = { sig, payload, ts: Date.now() };
    return stamp(payload);
  }

  // ----- local development: data/ folder (+ Dropbox), cached by file mtime/etag -----
  const dir = path.join(__dirname, '..', 'data');
  const files = fs.readdirSync(dir).filter((f) => (f.endsWith('.xlsx') || f.endsWith('.xer')) && !f.startsWith('~$')).sort();
  const dbx = await fetchDropbox();
  const fuelDbx = await dbxFetch(FUEL_DBX_URL).catch(() => null);
  const schedVer = await kvGet('tkv:schedule_ver').catch(() => null);
  const baseVer = await kvGet('tkv:baseline_ver').catch(() => null);
  const schedCleared = await kvGet('tkv:schedule_cleared').catch(() => null);
  const sig = JSON.stringify({
    local: files.map((f) => f + '|' + fs.statSync(path.join(dir, f)).mtimeMs),
    sched: schedVer || '',
    base: baseVer || '',
    cleared: schedCleared || '',
    dbx: dbx.map((d) => d.name + '|' + d.etag),
    fuel: fuelDbx ? fuelDbx.etag : '',
  });
  if (payloadCache && payloadCache.sig === sig) return stamp(payloadCache.payload);
  const localBuffers = files.filter((f) => f.endsWith('.xlsx') && !DBX_NAMEKEYS.has(normName(f))
      && !/claim.*variation.*log\.xlsx$/i.test(f)   // claims workbook is parsed in isolation below
      && !/claims.*variations.*register\.xlsx$/i.test(f) // claims register likewise
      && !/explosive.*consumption\.xlsx$/i.test(f)  // explosives workbook likewise
      && !/^insurance\.xlsx$/i.test(f))             // insurance workbook likewise
    .map((f) => fs.readFileSync(path.join(dir, f)));
  const buffers = [...localBuffers, ...dbx.filter((d) => d.buffer).map((d) => d.buffer)];
  const xerFiles = files.filter((f) => f.endsWith('.xer'));
  const baselineXf = xerFiles.find((f) => /baseline|TKV-BL-A\.xer/i.test(f)) || xerFiles[0];
  const delayXf = xerFiles.find((f) => /tia|delay|BL-A-2/i.test(f)) || baselineXf;
  const readXer = (f) => (f ? fs.readFileSync(path.join(dir, f), 'latin1') : null);
  // Optional local claims + explosives workbooks (parsed in isolation).
  const claimsFile = files.find((f) => /claim.*variation.*log\.xlsx$/i.test(f));
  const claimsBuffer = claimsFile ? fs.readFileSync(path.join(dir, claimsFile)) : null;
  const explFile = files.find((f) => /explosive.*consumption\.xlsx$/i.test(f));
  const explosivesBuffer = explFile ? fs.readFileSync(path.join(dir, explFile)) : null;
  const insFile = files.find((f) => /^insurance\.xlsx$/i.test(f));
  const insuranceBuffer = insFile ? fs.readFileSync(path.join(dir, insFile)) : null;
  const cvFile = files.find((f) => /claims.*variations.*register\.xlsx$/i.test(f));
  const claimsRegBuffer = cvFile ? fs.readFileSync(path.join(dir, cvFile)) : null;
  const payload = assemble(buffers, readXer(baselineXf), readXer(delayXf), 'local-file', claimsBuffer, explosivesBuffer, insuranceBuffer, fuelDbx && fuelDbx.buffer, claimsRegBuffer);
  payload.warnings = [...payload.warnings, ...dbx.filter((d) => d.warning).map((d) => d.warning)];
  if (schedCleared) payload.schedule = { activities: [], relationships: [], wbs: {}, cleared: true };
  if (schedVer) await applyScheduleOverride(payload);
  await applyBaselineOverlay(payload);
  payloadCache = { sig, payload, ts: Date.now() };
  return stamp(payload);
}

module.exports = async (req, res) => {
  // Allow the standalone TamakoshiTracker.html (opened from disk) to call this.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    // The dashboard data is private — a valid session is required. currentUser()
    // reads the user store from KV, so keep it INSIDE the try: a KV outage here
    // must return a readable JSON error, not throw unhandled (which Vercel turns
    // into an opaque "An error occurred" HTML page the client can't parse).
    const me = await currentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });
    const payload = await buildPayload();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  } catch (err) {
    const msg = String((err && err.message) || err);
    // A KV/Upstash failure means the session can't be validated — surface it as
    // 503 with a clear pointer, since it's the data store (often paused on the
    // free tier or over its request limit), not the dashboard, that's down.
    const kvDown = /KV (get|set|del) failed|UPSTASH|ECONNRESET|fetch failed/i.test(msg);
    res.status(kvDown ? 503 : 502).json({ error: kvDown
      ? `Data store unavailable (${msg}). The KV / Upstash store may be paused or over its limit — check Vercel → Storage.`
      : msg });
  }
};
module.exports.buildPayload = buildPayload;
