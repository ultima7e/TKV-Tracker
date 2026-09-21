// GET /api/report -> the Detailed Design Report explorer, for authorised users only.
//
// The report is CONFIDENTIAL (NEA / Tractebel design + cost data), so it deliberately
// lives NEITHER in the repo (github.com/ultima7e/TKV-Tracker is public — anything
// committed is downloadable from raw.githubusercontent.com) NOR in public/ (Vercel
// serves that directory with no authentication at all). It is stored in Nutstore and
// fetched here with the same WebDAV credentials the data feed already uses, behind the
// same session gate as every other section.
//
// Speed notes — the report is ~10.4 MB and Nutstore is a slow hop (measured ~6 s for
// the body plus ~0.8 s for the folder scan), so this route does three things:
//   1. caches the document on the warm instance, keyed by the storage ETag, so only a
//      cold instance pays the Nutstore round-trip;
//   2. caches it gzipped (10.4 MB -> ~6.8 MB) and serves that, roughly a third fewer
//      bytes over a long link;
//   3. caches the folder scan briefly, so an unchanged report revalidates to a 304 in
//      milliseconds instead of re-running PROPFIND.
// The response is always written in chunks: a function's response body is capped at
// 4.5 MB, and streamed responses are exempt from that cap.
const { currentUser } = require('../lib/auth');
const { Readable } = require('node:stream');
const zlib = require('node:zlib');

const DAV_BASE = 'https://dav.jianguoyun.com/dav/';
// Rename-proof, like the other Nutstore sources: scan the folder and take the newest
// matching file, so replacing the report with a newer export just works.
const REPORT_DIR = 'Shared Folder/Reports';
const REPORT_RE = /\.html?$/i;
const DIR_TTL_MS = 60 * 1000;

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

// Warm-instance caches (module scope survives between invocations on the same instance).
let dirCache = null;    // { at, file }
let docCache = null;    // { etag, gz, rawLength }

function davHeaders() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD } = process.env;
  if (!NUTSTORE_USER || !NUTSTORE_PASSWORD) return null;
  return { Authorization: 'Basic ' + Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64') };
}

// PROPFIND the report folder -> the newest *.html in it.
async function findReport(headers) {
  if (dirCache && Date.now() - dirCache.at < DIR_TTL_MS) return dirCache.file;
  const res = await fetch(DAV_BASE + encPath(REPORT_DIR) + '/', {
    method: 'PROPFIND', headers: { ...headers, Depth: '1' },
  });
  if (!res.ok) return null;
  const xml = await res.text();
  let best = null;
  for (const block of xml.split(/<[a-z]*:?response>/i).slice(1)) {
    const href = (block.match(/<[a-z]*:?href>([^<]*)<\/[a-z]*:?href>/i) || [])[1];
    if (!href) continue;
    const path = decodeURIComponent(href).replace(/^\/dav\//, '').replace(/\/$/, '');
    const name = path.split('/').pop() || '';
    if (!REPORT_RE.test(name) || name.startsWith('~$')) continue;
    const mtime = (block.match(/<[a-z]*:?getlastmodified>([^<]*)<\/[a-z]*:?getlastmodified>/i) || [])[1] || '';
    const etag = (block.match(/<[a-z]*:?getetag>([^<]*)<\/[a-z]*:?getetag>/i) || [])[1] || '';
    const t = Date.parse(mtime) || 0;
    if (!best || t > best.t) best = { path, mtime, etag, t };
  }
  if (best) dirCache = { at: Date.now(), file: best };
  return best;
}

// Write a buffer as a real stream — a single big write would be a buffered body and
// would trip the 4.5 MB response cap.
function sendChunked(res, buf) {
  Readable.from((function* () {
    const SIZE = 256 * 1024;
    for (let i = 0; i < buf.length; i += SIZE) yield buf.subarray(i, i + SIZE);
  })()).pipe(res);
}

module.exports = async (req, res) => {
  // The standalone TamakoshiTracker.html calls this API cross-origin with a Bearer
  // token, so it needs the same CORS headers the other endpoints set. A wildcard is
  // safe here precisely because it forbids credentialed (cookie) requests — a third
  // party site still cannot borrow a visitor's session to pull the report.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'ETag, X-Uncompressed-Length');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    // Same gate as the rest of the app: a valid session, plus the 'dpr' grant.
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: 'Not authenticated' });
    if (!u.isAdmin && !(u.sections || []).includes('dpr')) {
      return res.status(403).json({ error: 'Not authorised for the project report' });
    }

    const headers = davHeaders();
    if (!headers) return res.status(503).json({ error: 'Report storage is not configured' });

    const file = await findReport(headers);
    if (!file) return res.status(404).json({ error: 'Report not found in storage' });

    // Revalidate cheaply: the storage ETag doubles as ours, so an unchanged report
    // costs a 304 instead of ~10 MB.
    const tag = `W/"${(file.etag || file.mtime || '').replace(/"/g, '')}"`;
    res.setHeader('ETag', tag);
    // Private: this must never be held in a shared/CDN cache.
    res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === tag) return res.status(304).end();

    // Warm hit — no Nutstore round-trip at all.
    if (!docCache || docCache.etag !== tag) {
      const up = await fetch(DAV_BASE + encPath(file.path), { headers });
      if (!up.ok) return res.status(502).json({ error: `Storage responded ${up.status} for the report` });
      const raw = Buffer.from(await up.arrayBuffer());
      docCache = { etag: tag, rawLength: raw.length, gz: zlib.gzipSync(raw, { level: 6 }) };
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // The real (decompressed) size, so the client can show honest progress — fetch()
    // inflates transparently, so Content-Length alone would undercount.
    res.setHeader('X-Uncompressed-Length', String(docCache.rawLength));

    const accepts = String(req.headers['accept-encoding'] || '').includes('gzip');
    const body = accepts ? docCache.gz : zlib.gunzipSync(docCache.gz);
    if (accepts) res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', String(body.length));
    res.status(200);
    sendChunked(res, body);
  } catch (e) {
    if (!res.headersSent) return res.status(500).json({ error: String(e.message || e) });
    res.end();
  }
};
