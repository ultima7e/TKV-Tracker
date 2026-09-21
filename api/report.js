// GET /api/report -> the Detailed Design Report explorer, for authorised users only.
//
// The report is CONFIDENTIAL (NEA / Tractebel design + cost data), so it deliberately
// lives NEITHER in the repo (github.com/ultima7e/TKV-Tracker is public — anything
// committed is downloadable from raw.githubusercontent.com) NOR in public/ (Vercel
// serves that directory with no authentication at all). It is stored in Nutstore and
// fetched here with the same WebDAV credentials the data feed already uses, behind the
// same session gate as every other section.
//
// The response is STREAMED rather than buffered: a serverless function's response body
// is capped at 4.5 MB, and the report is ~10.4 MB. Piping the upstream body straight to
// the client sidesteps that cap and starts painting sooner. An ETag round-trip means a
// returning reader revalidates instead of re-pulling 10 MB.
const { currentUser } = require('../lib/auth');
const { Readable } = require('node:stream');

const DAV_BASE = 'https://dav.jianguoyun.com/dav/';
// Rename-proof, like the other Nutstore sources: scan the folder and take the newest
// matching file, so replacing the report with a newer export just works.
const REPORT_DIR = 'Shared Folder/Reports';
const REPORT_RE = /\.html?$/i;

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

function davHeaders() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD } = process.env;
  if (!NUTSTORE_USER || !NUTSTORE_PASSWORD) return null;
  return { Authorization: 'Basic ' + Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64') };
}

// PROPFIND the report folder -> the newest *.html in it.
async function findReport(headers) {
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
  return best;
}

module.exports = async (req, res) => {
  // The standalone TamakoshiTracker.html calls this API cross-origin with a Bearer
  // token, so it needs the same CORS headers the other endpoints set. A wildcard is
  // safe here precisely because it forbids credentialed (cookie) requests — a third
  // party site still cannot borrow a visitor's session to pull the report.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

    const up = await fetch(DAV_BASE + encPath(file.path), { headers });
    if (!up.ok || !up.body) {
      return res.status(502).json({ error: `Storage responded ${up.status} for the report` });
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const len = up.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);   // lets the browser show real progress
    res.status(200);
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) {
    if (!res.headersSent) return res.status(500).json({ error: String(e.message || e) });
    res.end();
  }
};
