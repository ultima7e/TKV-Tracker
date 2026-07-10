// Minimal local stand-in for Vercel: serves public/ and routes every /api/<name>
// to the matching api/<name>.js serverless handler (with just enough of Vercel's
// req/res shape: query, cookies, JSON body, and res.status()/json()/send()).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, '..', 'public');
const API = path.join(__dirname, '..', 'api');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp',
};

const readBody = (req) => new Promise((resolve) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => resolve(b));
});

function shimRes(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
  res.send = (s) => { res.end(s); return res; };
  return res;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/api/')) {
    const name = u.pathname.slice('/api/'.length).split('/')[0];
    const file = path.join(API, name + '.js');
    if (!file.startsWith(API) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    shimRes(res);
    req.query = Object.fromEntries(u.searchParams.entries());
    req.cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
      const i = c.indexOf('='); return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    }).filter(([k]) => k));
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const raw = await readBody(req);
      try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    }
    try {
      await require(file)(req, res);
    } catch (err) {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(err.message || err) })); }
    }
    return;
  }
  const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
  const file = path.join(PUB, rel);
  if (file.startsWith(PUB) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  } else {
    res.writeHead(404); res.end('Not found');
  }
}).listen(PORT, () => console.log(`Dev server: http://localhost:${PORT}`));
