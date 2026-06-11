# Tracker Dashboard Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation of the Tamakoshi-V project dashboard: static Sample-1 UI shell, Excel→JSON parsing pipeline with tests, serverless Nutstore fetcher with local-file dev fallback, working Refresh flow, and the Tunnel panel fully wired end-to-end.

**Architecture:** Static front end (`public/`) + one Vercel serverless function (`api/data.js`). The function downloads the `.xlsx` from Nutstore over WebDAV (plain HTTPS GET + Basic auth — no extra WebDAV library needed) or, when Nutstore env vars are absent (local dev), reads `data/sample.xlsx` from disk. Parsing happens server-side with SheetJS; the browser receives clean JSON. A small dev server emulates Vercel locally.

**Tech Stack:** Node.js (CommonJS), SheetJS `xlsx`, ECharts 5 (CDN), vanilla JS/CSS, `node:test` for tests, Vercel hosting.

**Reference:** Spec at `docs/superpowers/specs/2026-06-11-project-tracker-dashboard-design.md`. Visual reference: `mockup/dashboard-preview.html` (Sample 1).

**Data contract for Phase 1 (sample workbook, to be re-mapped to the user's real sheets later):**
- Sheet `Tunnel Progress`: columns `Tunnel | Length (m) | Completed (m)`
- Sheet `Monthly Advance`: columns `Month | Advance (m)`
- Sheet `KPI`: columns `Indicator | Value` (rows: Contract Amount, Financial Progress, Physical Progress, Earned Value, SPI, CPI)

---

### Task 1: Project scaffold

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Configure repo-local git identity** (global identity is not set on this machine; matches existing commits)

```bash
cd C:/Users/bhsag/Desktop/sp
git config user.name "bhsag"
git config user.email "bhsagr2@gmail.com"
```

- [ ] **Step 2: Replace `package.json`** (xlsx moves to dependencies — the serverless function needs it at runtime; exceljs stays dev-only for the sample-workbook generator)

```json
{
  "name": "tamakoshi-tracker",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "node --test tests/",
    "dev": "node scripts/dev-server.js",
    "make-sample": "node scripts/make-sample-xlsx.js"
  },
  "dependencies": {
    "xlsx": "^0.18.5"
  },
  "devDependencies": {
    "exceljs": "^4.4.0"
  }
}
```

- [ ] **Step 3: Append to `.gitignore`**

```
.vercel/
.env
.env.local
```

- [ ] **Step 4: Install and verify**

Run: `npm install`
Expected: completes without errors; `node_modules/xlsx` exists.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: scaffold project for dashboard phase 1"
```

---

### Task 2: Workbook loader (xlsx buffer → rows per sheet)

**Files:**
- Create: `lib/workbook.js`
- Test: `tests/workbook.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/workbook.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { workbookToRows } = require('../lib/workbook');

function makeXlsxBuffer() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Tunnel', 'Length (m)', 'Completed (m)'],
    ['Headrace Tunnel', 7519, 6300],
    ['Surge Shaft', 566, 408],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Tunnel Progress');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('workbookToRows returns row objects keyed by sheet name', () => {
  const rows = workbookToRows(makeXlsxBuffer());
  assert.deepEqual(Object.keys(rows), ['Tunnel Progress']);
  assert.equal(rows['Tunnel Progress'].length, 2);
  assert.deepEqual(rows['Tunnel Progress'][0], {
    'Tunnel': 'Headrace Tunnel',
    'Length (m)': 7519,
    'Completed (m)': 6300,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/workbook'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/workbook.js
const XLSX = require('xlsx');

// Parse an .xlsx buffer into { [sheetName]: arrayOfRowObjects }.
// defval:null keeps blank cells present so parsers can detect missing data.
function workbookToRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out = {};
  for (const name of wb.SheetNames) {
    out[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null });
  }
  return out;
}

module.exports = { workbookToRows };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add lib/workbook.js tests/workbook.test.js
git commit -m "feat: workbook loader parses xlsx buffer to rows per sheet"
```

---

### Task 3: Tunnel + KPI parsers (rows → dashboard JSON)

**Files:**
- Create: `lib/parsers.js`
- Test: `tests/parsers.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/parsers.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTunnel, parseKpis } = require('../lib/parsers');

test('parseTunnel computes progress and passes advance through', () => {
  const sheets = {
    'Tunnel Progress': [
      { 'Tunnel': 'Headrace Tunnel', 'Length (m)': 7519, 'Completed (m)': 6300 },
      { 'Tunnel': null, 'Length (m)': null, 'Completed (m)': null }, // blank row ignored
    ],
    'Monthly Advance': [
      { 'Month': 'Apr-26', 'Advance (m)': 215 },
      { 'Month': 'May-26', 'Advance (m)': 235 },
    ],
  };
  const result = parseTunnel(sheets);
  assert.equal(result.tunnels.length, 1);
  assert.equal(result.tunnels[0].name, 'Headrace Tunnel');
  assert.equal(result.tunnels[0].progressPct, 84); // round(6300/7519*100)
  assert.deepEqual(result.monthlyAdvance, [
    { month: 'Apr-26', advanceM: 215 },
    { month: 'May-26', advanceM: 235 },
  ]);
  assert.deepEqual(result.warnings, []);
});

test('parseTunnel warns when sheet is missing instead of throwing', () => {
  const result = parseTunnel({});
  assert.deepEqual(result.tunnels, []);
  assert.equal(result.warnings.length >= 1, true);
});

test('parseKpis maps Indicator/Value rows to a keyed object', () => {
  const sheets = {
    'KPI': [
      { 'Indicator': 'Physical Progress', 'Value': 72.3 },
      { 'Indicator': 'SPI', 'Value': 1.05 },
    ],
  };
  const result = parseKpis(sheets);
  assert.equal(result.kpis['Physical Progress'], 72.3);
  assert.equal(result.kpis['SPI'], 1.05);
  assert.deepEqual(result.warnings, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/parsers'`

- [ ] **Step 3: Write the implementation**

```js
// lib/parsers.js

// Each parser takes { [sheetName]: rows } and returns data plus a warnings
// array — a missing/renamed sheet degrades that panel, never the whole API.

function parseTunnel(sheets) {
  const warnings = [];

  const progressRows = sheets['Tunnel Progress'];
  let tunnels = [];
  if (!progressRows) {
    warnings.push("Sheet 'Tunnel Progress' not found");
  } else {
    tunnels = progressRows
      .filter((r) => r['Tunnel'] && typeof r['Length (m)'] === 'number')
      .map((r) => {
        const lengthM = r['Length (m)'];
        const completedM = typeof r['Completed (m)'] === 'number' ? r['Completed (m)'] : 0;
        return {
          name: String(r['Tunnel']).trim(),
          lengthM,
          completedM,
          progressPct: lengthM > 0 ? Math.round((completedM / lengthM) * 100) : 0,
        };
      });
  }

  const advanceRows = sheets['Monthly Advance'];
  let monthlyAdvance = [];
  if (!advanceRows) {
    warnings.push("Sheet 'Monthly Advance' not found");
  } else {
    monthlyAdvance = advanceRows
      .filter((r) => r['Month'] && typeof r['Advance (m)'] === 'number')
      .map((r) => ({ month: String(r['Month']).trim(), advanceM: r['Advance (m)'] }));
  }

  return { tunnels, monthlyAdvance, warnings };
}

function parseKpis(sheets) {
  const warnings = [];
  const rows = sheets['KPI'];
  const kpis = {};
  if (!rows) {
    warnings.push("Sheet 'KPI' not found");
  } else {
    for (const r of rows) {
      if (r['Indicator'] != null && r['Value'] != null) {
        kpis[String(r['Indicator']).trim()] = r['Value'];
      }
    }
  }
  return { kpis, warnings };
}

module.exports = { parseTunnel, parseKpis };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (4 tests total)

- [ ] **Step 5: Commit**

```bash
git add lib/parsers.js tests/parsers.test.js
git commit -m "feat: tunnel and KPI parsers with per-sheet warnings"
```

---

### Task 4: Sample workbook generator

**Files:**
- Create: `scripts/make-sample-xlsx.js`
- Create (generated): `data/sample.xlsx`

- [ ] **Step 1: Write the generator**

```js
// scripts/make-sample-xlsx.js
// Generates data/sample.xlsx matching the Phase 1 data contract.
// This file stands in for the user's real workbook during development.
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const wb = XLSX.utils.book_new();

XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['Tunnel', 'Length (m)', 'Completed (m)'],
  ['Headrace Tunnel', 7519, 6300],
  ['Surge Shaft', 566, 408],
  ['Pressure Shaft', 385, 240],
  ['Access Tunnel', 1200, 860],
  ['Tailrace Tunnel', 1302, 1186],
]), 'Tunnel Progress');

XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['Month', 'Advance (m)'],
  ['Nov-25', 168], ['Dec-25', 185], ['Jan-26', 190],
  ['Feb-26', 220], ['Mar-26', 205], ['Apr-26', 215], ['May-26', 235],
]), 'Monthly Advance');

XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['Indicator', 'Value'],
  ['Contract Amount', 98.67],
  ['Financial Progress', 68.45],
  ['Physical Progress', 72.3],
  ['Earned Value', 67.46],
  ['SPI', 1.05],
  ['CPI', 1.02],
]), 'KPI');

const out = path.join(__dirname, '..', 'data', 'sample.xlsx');
fs.mkdirSync(path.dirname(out), { recursive: true });
XLSX.writeFile(wb, out);
console.log('Wrote', out);
```

- [ ] **Step 2: Run it and verify output**

Run: `npm run make-sample`
Expected: prints `Wrote ...data\sample.xlsx`; file exists.

- [ ] **Step 3: Commit** (the generated file is committed so dev works on a fresh clone)

```bash
git add scripts/make-sample-xlsx.js data/sample.xlsx
git commit -m "feat: sample workbook generator for local development"
```

---

### Task 5: API handler (Nutstore fetch with local-file fallback)

**Files:**
- Create: `api/data.js`
- Test: `tests/api-data.test.js`

- [ ] **Step 1: Write the failing test** (tests the handler's core via the local-file path)

```js
// tests/api-data.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPayload } = require('../api/data');

test('buildPayload assembles panels and metadata from local sample file', async () => {
  delete process.env.NUTSTORE_USER; // force local-file fallback
  const payload = await buildPayload();
  assert.equal(typeof payload.generatedAt, 'string');
  assert.equal(payload.source, 'local-file');
  assert.equal(payload.tunnel.tunnels.length, 5);
  assert.equal(payload.executive.kpis['SPI'], 1.05);
  assert.deepEqual(payload.warnings, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../api/data'`

- [ ] **Step 3: Write the implementation**

```js
// api/data.js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (5 tests total)

- [ ] **Step 5: Commit**

```bash
git add api/data.js tests/api-data.test.js
git commit -m "feat: data API with Nutstore WebDAV fetch and local fallback"
```

---

### Task 6: Local dev server

**Files:**
- Create: `scripts/dev-server.js`

- [ ] **Step 1: Write the dev server**

```js
// scripts/dev-server.js
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
```

- [ ] **Step 2: Smoke-test the API route** (public/ doesn't exist yet — that's fine, only test /api/data)

Run: `npm run dev` in the background, then `curl http://localhost:3000/api/data`
Expected: JSON containing `"source":"local-file"` and 5 tunnels. Stop the server after.

- [ ] **Step 3: Commit**

```bash
git add scripts/dev-server.js
git commit -m "feat: local dev server emulating Vercel routes"
```

---

### Task 7: Dashboard shell (Sample 1 UI) — static structure and styles

**Files:**
- Create: `public/index.html`
- Create: `public/css/styles.css`

The shell reproduces the approved Sample 1 design (visual reference `mockup/dashboard-preview.html`): navy left sidebar with 9 nav items, topbar with title/date/Refresh, fade-switching views. Executive Summary and Tunnel views have live widget containers; the other 7 views are labeled placeholders awaiting their phase-2 data sheets.

- [ ] **Step 1: Create `public/css/styles.css`** — copy the full `<style>` block contents from `mockup/dashboard-preview.html` (lines between `<style>` and `</style>`) into this file verbatim, then add at the end:

```css
/* ---- additions for live app ---- */
.banner{display:none;background:#fdecea;color:#b3261e;border:1px solid #f5c6c0;
  border-radius:8px;padding:10px 14px;font-size:12.5px;margin-bottom:14px}
.banner.show{display:block}
.banner.warn{background:#fff8e6;color:#8a6400;border-color:#f0dca8}
.last-refresh{font-size:11px;color:#b9c7dc}
```

- [ ] **Step 2: Create `public/index.html`** — same body structure as the mockup with these changes: stylesheet linked externally, scripts split out, an error banner div added at the top of `.content`, all hardcoded numbers replaced by `data-kpi` placeholders, and tunnel widgets given stable ids:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tamakoshi-V Project Tracker</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<link rel="stylesheet" href="/css/styles.css">
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><div class="logo">TV</div><div>TAMAKOSHI-V</div></div>
    <nav class="nav" id="nav">
      <div class="nav-item active" data-v="exec"><span class="ic">▰</span>Executive Summary</div>
      <div class="nav-item" data-v="fin"><span class="ic">₿</span>Financial</div>
      <div class="nav-item" data-v="sched"><span class="ic">◷</span>Schedule &amp; Progress</div>
      <div class="nav-item" data-v="tunnel"><span class="ic">⛏</span>Tunnel</div>
      <div class="nav-item" data-v="claims"><span class="ic">§</span>Claims &amp; Variations</div>
      <div class="nav-item" data-v="inv"><span class="ic">⛁</span>Inventory &amp; Explosives</div>
      <div class="nav-item" data-v="man"><span class="ic">☷</span>Manpower</div>
      <div class="nav-item" data-v="equip"><span class="ic">⚙</span>Equipment</div>
      <div class="nav-item" data-v="safety"><span class="ic">⛨</span>Safety</div>
    </nav>
    <div class="nav-foot">Data source: <span id="data-source">—</span><br>
      <span class="last-refresh" id="last-refresh">Not loaded yet</span></div>
  </aside>
  <div class="main">
    <header class="topbar">
      <h1><span class="dot"></span>TAMAKOSHI-V HYDROELECTRIC PROJECT</h1>
      <div class="right">
        <span id="today"></span>
        <button class="btn-refresh" id="refresh"><span class="ic">⟳</span>Refresh</button>
      </div>
    </header>
    <div class="content">
      <div class="banner" id="banner"></div>

      <section class="view active" id="exec">
        <div class="grid kpis" style="margin-bottom:16px">
          <div class="card kpi"><h3>Contract Amount</h3><div class="val">NPR <span data-kpi="Contract Amount">—</span> Bn</div></div>
          <div class="card kpi"><h3>Financial Progress</h3><div class="val"><span data-kpi="Financial Progress">—</span>%</div></div>
          <div class="card kpi"><h3>Physical Progress</h3><div class="val"><span data-kpi="Physical Progress">—</span>%</div></div>
          <div class="card kpi"><h3>Earned Value (EV)</h3><div class="val">NPR <span data-kpi="Earned Value">—</span> Bn</div></div>
          <div class="card kpi"><h3>SPI</h3><div class="val"><span data-kpi="SPI">—</span></div><div class="sub">Schedule Performance</div></div>
          <div class="card kpi"><h3>CPI</h3><div class="val"><span data-kpi="CPI">—</span></div><div class="sub">Cost Performance</div></div>
        </div>
        <div class="grid row-2">
          <div class="card"><h3>Monthly Advance (m)</h3><div id="ch-exec-advance" class="chart"></div></div>
          <div class="card"><h3>Tunnel Completion (%)</h3><div id="ch-exec-tunnel" class="chart"></div></div>
        </div>
      </section>

      <section class="view" id="tunnel">
        <div class="grid row-2" style="margin-bottom:16px">
          <div class="card"><h3>Tunnel Progress (% complete)</h3><div id="tunnel-bars"></div></div>
          <div class="card"><h3>Monthly Advance (m)</h3><div id="ch-tunnel-advance" class="chart"></div></div>
        </div>
      </section>

      <section class="view" id="fin"><div class="card"><h3>Financial Dashboard</h3><p class="muted">Awaiting finance data sheet (Phase 2).</p></div></section>
      <section class="view" id="sched"><div class="card"><h3>Schedule &amp; Progress</h3><p class="muted">Awaiting schedule data sheet (Phase 2).</p></div></section>
      <section class="view" id="claims"><div class="card"><h3>Claims &amp; Variations</h3><p class="muted">Awaiting claims data sheet (Phase 2).</p></div></section>
      <section class="view" id="inv"><div class="card"><h3>Inventory &amp; Explosives</h3><p class="muted">Awaiting inventory data sheet (Phase 2).</p></div></section>
      <section class="view" id="man"><div class="card"><h3>Manpower</h3><p class="muted">Awaiting manpower data sheet (Phase 2).</p></div></section>
      <section class="view" id="equip"><div class="card"><h3>Equipment</h3><p class="muted">Awaiting equipment data sheet (Phase 2).</p></div></section>
      <section class="view" id="safety"><div class="card"><h3>Safety</h3><p class="muted">Awaiting safety data sheet (Phase 2).</p></div></section>
    </div>
  </div>
</div>
<script src="/js/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Visual smoke test**

Run: `npm run dev`, open `http://localhost:3000`.
Expected: sidebar + topbar render with Sample-1 styling; views switch is NOT yet wired (app.js comes next); KPIs show `—`. No console 404 except `/js/app.js`.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/css/styles.css
git commit -m "feat: dashboard shell with Sample 1 styling"
```

---

### Task 8: Front-end app — data loading, rendering, nav, refresh

**Files:**
- Create: `public/js/app.js`

- [ ] **Step 1: Write `public/js/app.js`**

```js
// public/js/app.js
(() => {
  const charts = {};
  let data = null;

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const COL = { accent: '#2f7de1', accent2: '#36c5a8', muted: '#7b8aa0', grid: '#eef2f7' };

  function countUp(el, to, dec) {
    let start = null;
    const dur = 1100;
    function step(t) {
      if (!start) start = t;
      const p = Math.min((t - start) / dur, 1);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = (to * e).toFixed(dec);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function showBanner(msg, isWarning) {
    const b = $('#banner');
    b.textContent = msg;
    b.className = 'banner show' + (isWarning ? ' warn' : '');
  }
  function hideBanner() { $('#banner').className = 'banner'; }

  function makeChart(id) {
    const el = document.getElementById(id);
    if (!charts[id]) charts[id] = echarts.init(el);
    return charts[id];
  }

  // ---------- renderers ----------
  function renderKpis() {
    const kpis = (data.executive && data.executive.kpis) || {};
    document.querySelectorAll('[data-kpi]').forEach((el) => {
      const v = kpis[el.dataset.kpi];
      if (typeof v === 'number') {
        const dec = Number.isInteger(v) ? 0 : 2;
        countUp(el, v, dec);
      } else {
        el.textContent = '—';
      }
    });
  }

  function renderAdvanceChart(id) {
    const rows = (data.tunnel && data.tunnel.monthlyAdvance) || [];
    makeChart(id).setOption({
      grid: { left: 38, right: 12, top: 18, bottom: 24 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: rows.map((r) => r.month),
        axisLabel: { fontSize: 10, color: COL.muted }, axisLine: { lineStyle: { color: '#cfd8e6' } } },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: COL.grid } },
        axisLabel: { fontSize: 10, color: COL.muted } },
      series: [{ type: 'bar', data: rows.map((r) => r.advanceM), barWidth: '52%',
        itemStyle: { borderRadius: [4, 4, 0, 0],
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1,
            [{ offset: 0, color: COL.accent }, { offset: 1, color: COL.accent2 }]) } }],
    });
  }

  function renderTunnelCompletionChart(id) {
    const tunnels = (data.tunnel && data.tunnel.tunnels) || [];
    makeChart(id).setOption({
      grid: { left: 110, right: 30, top: 10, bottom: 24 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'value', max: 100, splitLine: { lineStyle: { color: COL.grid } },
        axisLabel: { fontSize: 10, color: COL.muted } },
      yAxis: { type: 'category', data: tunnels.map((t) => t.name),
        axisLabel: { fontSize: 10, color: COL.muted } },
      series: [{ type: 'bar', data: tunnels.map((t) => t.progressPct), barWidth: '55%',
        label: { show: true, position: 'right', fontSize: 10, formatter: '{c}%' },
        itemStyle: { borderRadius: [0, 4, 4, 0], color: COL.accent } }],
    });
  }

  function renderTunnelBars() {
    const wrap = $('#tunnel-bars');
    const tunnels = (data.tunnel && data.tunnel.tunnels) || [];
    wrap.innerHTML = tunnels.map((t) => `
      <div class="pbar">
        <div class="lab"><span>${t.name} <span class="muted">(${t.completedM.toLocaleString()} / ${t.lengthM.toLocaleString()} m)</span></span><span>${t.progressPct}%</span></div>
        <div class="track"><i data-w="${t.progressPct}"></i></div>
      </div>`).join('');
    requestAnimationFrame(() => {
      wrap.querySelectorAll('.track > i').forEach((b) => { b.style.width = b.dataset.w + '%'; });
    });
  }

  function renderAll() {
    renderKpis();
    renderAdvanceChart('ch-exec-advance');
    renderTunnelCompletionChart('ch-exec-tunnel');
    renderAdvanceChart('ch-tunnel-advance');
    renderTunnelBars();
    $('#data-source').textContent = data.source === 'nutstore' ? 'Nutstore' : 'Local sample';
    $('#last-refresh').textContent = 'Last refresh: ' + new Date(data.generatedAt).toLocaleTimeString();
    if (data.warnings && data.warnings.length) {
      showBanner('Data warnings: ' + data.warnings.join(' · '), true);
    }
  }

  // ---------- data ----------
  async function load() {
    const btn = $('#refresh');
    btn.classList.add('spin');
    try {
      const res = await fetch('/api/data');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
      data = json;
      hideBanner();
      renderAll();
    } catch (err) {
      showBanner(
        data
          ? "Couldn't refresh from data source — showing last loaded data. (" + err.message + ')'
          : "Couldn't load data: " + err.message,
        false
      );
    } finally {
      btn.classList.remove('spin');
    }
  }

  // ---------- nav ----------
  document.getElementById('nav').addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (!item) return;
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.view').forEach((s) => s.classList.remove('active'));
    document.getElementById(item.dataset.v).classList.add('active');
    if (data) renderAll(); // re-trigger animations on the newly visible view
    setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 60);
  });

  $('#refresh').addEventListener('click', load);
  window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()));
  $('#today').textContent = new Date().toLocaleDateString('en-GB',
    { day: '2-digit', month: 'short', year: 'numeric' });

  load();
})();
```

- [ ] **Step 2: End-to-end manual verification**

Run: `npm run dev`, open `http://localhost:3000`. Verify ALL of:
1. KPI cards count up to sample values (98.67, 68.45, 72.30, 67.46, 1.05, 1.02).
2. Executive charts render (advance bars + horizontal completion bars).
3. Tunnel view: 5 animated progress bars with metres, advance chart.
4. Refresh button spins and re-renders; "Last refresh" timestamp updates.
5. Footer shows "Data source: Local sample".
6. Edit `data/sample.xlsx` (change a Completed value), save, click Refresh → number changes. Revert after (`npm run make-sample`).
7. Temporarily rename sheet `KPI` in the sample file → Refresh shows amber warning banner; KPIs show `—`; tunnel still renders. Regenerate after (`npm run make-sample`).

- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "feat: live dashboard app with refresh, nav, and tunnel panel"
```

---

### Task 9: Vercel configuration + deploy docs

**Files:**
- Create: `vercel.json`
- Create: `docs/DEPLOY.md`

- [ ] **Step 1: Create `vercel.json`** (static `public/` + Node functions in `api/` are Vercel defaults; pin the function runtime and make the output explicit)

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "api/data.js": { "maxDuration": 15 }
  }
}
```

- [ ] **Step 2: Create `docs/DEPLOY.md`**

```markdown
# Deploying the Tamakoshi-V Tracker

## One-time setup (done by the project owner — credentials never leave your hands)

1. **Nutstore app password:** Nutstore web → Account → Security →
   "Third-party application management" → generate an app password.
   Note your account email, the app password, and the file's path
   relative to the WebDAV root (e.g. `ProjectData/tracker.xlsx`).
2. **Vercel account:** sign up free at vercel.com (no card needed).
3. Install CLI and deploy from the project root:
   ```bash
   npm i -g vercel
   vercel        # link/create the project, accept defaults
   ```
4. In the Vercel dashboard → Project → Settings → Environment Variables, add:
   - `NUTSTORE_USER` = your Nutstore email
   - `NUTSTORE_PASSWORD` = the app password (mark as Sensitive)
   - `NUTSTORE_FILE_PATH` = e.g. `ProjectData/tracker.xlsx`
5. Redeploy: `vercel --prod`. Open the URL; footer should say
   "Data source: Nutstore".

## Verifying the Nutstore connection (the day-one spike)

Visit `https://<your-app>.vercel.app/api/data` directly:
- JSON with `"source":"nutstore"` → connection works.
- `{"error":"Nutstore responded 401 ..."}` → wrong app password/user.
- `{"error":"Nutstore responded 404 ..."}` → wrong `NUTSTORE_FILE_PATH`.

## Local development

`npm run dev` — uses `data/sample.xlsx`, no credentials needed.
```

- [ ] **Step 3: Run full test suite one final time**

Run: `npm test`
Expected: all 5 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add vercel.json docs/DEPLOY.md
git commit -m "chore: Vercel config and deployment guide"
```

---

## Phase boundaries (explicitly deferred)

- **Phase 2:** real data contract per user's actual workbook (re-map `lib/parsers.js` sheet/column names — tests make this safe), then Financial, Schedule, Claims, Inventory, Manpower, Equipment, Safety panels one at a time.
- **Phase 3:** 3D project view (Three.js, true alignment from user's documents).
- **User-owned steps:** Nutstore app password, Vercel account + env vars, production deploy verification (`docs/DEPLOY.md`).
