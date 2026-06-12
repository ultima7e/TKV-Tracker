// Minimal local stand-in for Vercel: serves public/ and routes /api/data
// to the same buildPayload used by the serverless function.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildPayload } = require('../api/data');

const PUB = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/data')) {
    try {
      const payload = await buildPayload();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }
  const rel = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0];
  const file = path.join(PUB, rel);
  if (file.startsWith(PUB) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  } else {
    res.writeHead(404); res.end('Not found');
  }
}).listen(3000, () => console.log('Dev server: http://localhost:3000'));
