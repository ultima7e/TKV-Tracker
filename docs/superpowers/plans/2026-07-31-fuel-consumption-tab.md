# Fuel Consumption Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Fuel" sub-tab to the Inventory & Explosives panel showing a stacked monthly bar chart of fuel consumption (litres) by equipment category, live from a Dropbox workbook.

**Architecture:** New `parseFuel()` reads the `Appended_Table` sheet and aggregates litres by month × category. `api/data.js` fetches the workbook live from Dropbox, parses it in isolation (never merged into the finance matrices), and exposes `payload.fuel`. Both synced frontends gain an Explosives|Fuel sub-tab bar; the Fuel tab renders a stacked ECharts bar with category filter chips + month range, mirroring the existing explosives chart.

**Tech Stack:** Node serverless (`api/data.js`), `openpyxl`/`xlsx` for verification, vanilla JS + ECharts frontends, `lib/parsers.js`, `lib/workbook.js` (`workbookSheets`).

## Global Constraints

- No unit-test framework in this repo — "testing" is Node scripts against fixtures/live data, and cloud-dev browser checks. Do not add a test runner.
- **Public GitHub repo:** never commit secrets or data workbooks. Any scratch/verification file must not be committed.
- **Two synced frontends must stay identical:** `public/index.html` (+ `css/styles.css` + `js/app.js`) AND self-contained `public/TamakoshiTracker.html` (inline CSS+JS, `API_BASE='https://tkv-tracker.vercel.app'` — never change it). The repo-root `TamakoshiTracker.html` is a byte-copy of the public one.
- Litres only (no NPR view). Combined sites (no Powerhouse/Headworks split).
- Reuse existing CSS classes — `.sched-tabs`/`.sched-tab`/`.stab-pane` (sub-tabs) and `.expl-summary`/`.expl-tile`/`.expl-controls`/`.expl-loc-wrap`/`.expl-locs`/`.expl-chip` (controls). Add NO new CSS.
- Fuel Dropbox URL (dl=1): `https://www.dropbox.com/scl/fi/sd47gb80i8857yeq2n8j2/Fuel_Consumption_EN_Categorized.xlsx?rlkey=wx53urwmerfralt5dwhj4mz4f&dl=1`

---

## File Structure

- `lib/parsers.js` — add `parseFuel(matrices)` + export (parsing/aggregation).
- `api/data.js` — Dropbox fetch + isolated parse + `payload.fuel` wiring.
- `public/index.html` — sub-tab bar + Fuel pane markup.
- `public/js/app.js` — `fuelState` + `renderFuel`/`drawFuelChart`/chips/controls + sub-tab wiring.
- `public/TamakoshiTracker.html` — mirror of markup + JS.
- `TamakoshiTracker.html` (repo root) — byte-copy refresh.

---

## Task 1: `parseFuel()` parser

**Files:**
- Modify: `lib/parsers.js` (add function + add to `module.exports`)

**Interfaces:**
- Produces: `parseFuel(matrices) -> { warnings:[], missing?:true, months:string[], categories:{name:string,total:number}[], byMonth:{[month]:{[category]:number}}, grandTotal:number }`. `months` sorted asc (`'YYYY-MM'`); `categories` sorted by `total` desc; litres rounded to 1 dp.

- [ ] **Step 1: Add `parseFuel` to `lib/parsers.js`**

Add this function just before the `module.exports` line (or beside `parseExplosives`):

```js
// Fuel consumption — reads the 'Appended_Table' sheet of the fuel workbook and
// aggregates litres by month × equipment category. Columns are located by header
// text (row 0), tolerant of ordering. Litres rounded to 1 dp.
function parseFuel(matrices) {
  const warnings = [];
  const grid = matrices['Appended_Table'];
  if (!grid || !grid.length) { warnings.push("Fuel: 'Appended_Table' sheet not found"); return { warnings, missing: true }; }
  const num = (v) => (typeof v === 'number' ? v : (parseFloat(v) || 0));
  const rnd = (v) => Math.round(v * 10) / 10;
  const ym = (v) => {
    let d = null;
    if (v instanceof Date) d = v;
    else if (typeof v === 'number' && v > 20000 && v < 80000) d = new Date(Math.round((v - 25569) * 86400 * 1000));
    else if (typeof v === 'string') { const t = Date.parse(v); if (!isNaN(t)) d = new Date(t); }
    return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 7) : null;
  };
  const hdr = grid[0] || [];
  const findCol = (re) => hdr.findIndex((h) => typeof h === 'string' && re.test(h));
  const dCol = findCol(/date/i);
  const lCol = findCol(/\(l\)/i);
  const cCol = findCol(/category/i);
  if (dCol < 0 || lCol < 0 || cCol < 0) {
    warnings.push('Fuel: expected columns (Date / (L) / Category) not found');
    return { warnings, missing: true };
  }
  const byMonth = {}, catTot = {}, monthSet = new Set();
  let grand = 0;
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i]; if (!r) continue;
    const m = ym(r[dCol]); if (!m) continue;
    const li = num(r[lCol]); if (!li) continue;
    const cat = (r[cCol] == null ? '' : String(r[cCol]).replace(/\s+/g, ' ').trim()) || 'Other';
    (byMonth[m] = byMonth[m] || {});
    byMonth[m][cat] = (byMonth[m][cat] || 0) + li;
    catTot[cat] = (catTot[cat] || 0) + li;
    monthSet.add(m); grand += li;
  }
  for (const m of Object.keys(byMonth)) for (const c of Object.keys(byMonth[m])) byMonth[m][c] = rnd(byMonth[m][c]);
  const categories = Object.keys(catTot).map((name) => ({ name, total: rnd(catTot[name]) })).sort((a, b) => b.total - a.total);
  return { warnings, months: [...monthSet].sort(), categories, byMonth, grandTotal: rnd(grand) };
}
```

Then add `parseFuel` to the `module.exports` object in `lib/parsers.js` (the same object that already exports `parseExplosives`).

- [ ] **Step 2: Write the verification script**

Create `scratch-verify-fuel1.js` in the repo root:

```js
const { parseFuel } = require('./lib/parsers');
// synthetic Appended_Table matrix (header row + data rows)
const matrices = { 'Appended_Table': [
  ['Fueling Date', 'Vehicle / Equipment No.', 'Fuel Amount (L)', 'Mileage / Duration', 'Unit Price', 'Amount', 'Issued By', 'Remarks', 'Category'],
  [new Date(Date.UTC(2024, 2, 18)), 'Truck A', 100, null, 163, 0, 'x', null, 'Truck'],
  [new Date(Date.UTC(2024, 2, 25)), 'Gen 1', 50, null, 163, 0, 'x', null, 'Generator'],
  [45658, 'Gen 1', 25.5, null, 163, 0, 'x', null, 'Generator'],   // 45658 = 2025-01-27 serial
  ['2024-03-30', 'Truck B', 10, null, 163, 0, 'x', null, ''],     // blank category -> Other
  [new Date(Date.UTC(2024, 2, 1)), 'Zero', 0, null, 0, 0, 'x', null, 'Truck'], // 0 L skipped
];
};
const f = parseFuel(matrices);
console.log('months:', f.months);
console.log('categories:', JSON.stringify(f.categories));
console.log('byMonth 2024-03:', JSON.stringify(f.byMonth['2024-03']));
console.log('grandTotal:', f.grandTotal);
const assert = require('assert');
assert.deepStrictEqual(f.months, ['2024-03', '2025-01']);
assert.strictEqual(f.grandTotal, 185.5);
assert.deepStrictEqual(f.byMonth['2024-03'], { Truck: 100, Generator: 50, Other: 10 });
assert.deepStrictEqual(f.byMonth['2025-01'], { Generator: 25.5 });
// categories sorted by total desc: Truck 100, Generator 75.5, Other 10
assert.deepStrictEqual(f.categories.map((c) => c.name), ['Truck', 'Generator', 'Other']);
assert.strictEqual(f.categories[1].total, 75.5);
console.log('ALL ASSERTIONS PASSED');
```

- [ ] **Step 3: Run it to verify it fails first (function not yet exported)**

If you run Step 2 before Step 1 is complete, expect: `TypeError: parseFuel is not a function`. After Step 1, proceed.

Run: `node scratch-verify-fuel1.js`
Expected (after Step 1): prints the values and `ALL ASSERTIONS PASSED`, exit 0.

- [ ] **Step 4: Delete the scratch file and commit**

```bash
rm scratch-verify-fuel1.js
git add lib/parsers.js
git commit -m "feat(fuel): parseFuel — aggregate litres by month x category"
```

---

## Task 2: Backend — fetch fuel from Dropbox + expose `payload.fuel`

**Files:**
- Modify: `api/data.js` (import, constant, `fuelFromBuffer`, both `buildPayload` paths, `assemble`)

**Interfaces:**
- Consumes: `parseFuel` (Task 1); existing `workbookSheets(buffer, names)`, `dbxFetch(url) -> {etag, buffer}` (throws on error), `assemble(...)`.
- Produces: `payload.fuel = parseFuel(...)` (same shape as Task 1), or `{ missing:true, warnings }` when the workbook is unavailable.

- [ ] **Step 1: Import `parseFuel`**

In `api/data.js`, add `parseFuel` to the destructured `require('../lib/parsers')` list (the line that already imports `parseExplosives`, `parseInsurance`, etc.).

- [ ] **Step 2: Add the URL constant + `fuelFromBuffer`**

Near the other path constants (e.g. just after `EXPLOSIVES_XLSX_PATH` / `INSURANCE_XLSX_PATH`), add:

```js
// Fuel consumption workbook — hosted on Dropbox, fetched live and parsed in
// ISOLATION (only 'Appended_Table') so its 10k rows never merge into finance.
const FUEL_DBX_URL = 'https://www.dropbox.com/scl/fi/sd47gb80i8857yeq2n8j2/Fuel_Consumption_EN_Categorized.xlsx?rlkey=wx53urwmerfralt5dwhj4mz4f&dl=1';
```

Add this helper next to `explosivesFromBuffer`:

```js
function fuelFromBuffer(buffer) {
  if (!buffer) return { missing: true, warnings: ['Fuel workbook not available'] };
  try {
    const { matrices } = workbookSheets(buffer, ['Appended_Table']);
    return parseFuel(matrices);
  } catch (e) {
    return { missing: true, warnings: ['Fuel parse failed: ' + String(e.message || e)] };
  }
}
```

- [ ] **Step 3: Thread `fuelBuffer` through `assemble`**

Change the `assemble(...)` signature to accept a trailing `fuelBuffer` parameter, and add `fuel` to the returned payload object next to `explosives`/`insurance`:

```js
function assemble(buffers, xerText, delayXerText, source, claimsBuffer, explosivesBuffer, insuranceBuffer, fuelBuffer) {
```

In the returned object (near `explosives: explosivesFromBuffer(explosivesBuffer),`):

```js
    fuel: fuelFromBuffer(fuelBuffer),
```

- [ ] **Step 4: Fetch fuel in the Nutstore path**

In `buildPayload()`, the Nutstore-path `Promise.all([...])` that yields `[listing, xerInfo, delayXerInfo, claimsInfo, explInfo, insInfo, dbx, schedVer]` — add a fuel fetch as the last element:

```js
      dbxFetch(FUEL_DBX_URL).catch(() => null),
```

and add `, fuelDbx` to the destructured names. Add its etag to the `sig` object (next to the `dbx:` line):

```js
      fuel: fuelDbx ? fuelDbx.etag : '',
```

Pass its buffer into the `assemble(...)` call for this path:

```js
    const payload = assemble(buffers, xerText, delayXerText, 'nutstore', claimsBuffer, explosivesBuffer, insuranceBuffer, fuelDbx && fuelDbx.buffer);
```

- [ ] **Step 5: Fetch fuel in the local-dev path**

In the local-dev path of `buildPayload()` (the branch that reads `data/` files), after the existing `const dbx = await fetchDropbox();` line add:

```js
  const fuelDbx = await dbxFetch(FUEL_DBX_URL).catch(() => null);
```

Add its etag to that path's `sig` object:

```js
    fuel: fuelDbx ? fuelDbx.etag : '',
```

Pass its buffer into the local-path `assemble(...)` call:

```js
  const payload = assemble(buffers, readXer(baselineXf), readXer(delayXf), 'local-file', claimsBuffer, explosivesBuffer, insuranceBuffer, fuelDbx && fuelDbx.buffer);
```

- [ ] **Step 6: Verify with a live buildPayload run**

Create `scratch-verify-fuel2.js` in the repo root:

```js
const data = require('./api/data.js');
(async () => {
  const p = await data.buildPayload();
  const f = p.fuel || {};
  console.log('has fuel:', !!p.fuel, '| missing:', !!f.missing);
  console.log('months:', (f.months || []).length, (f.months || []).slice(0, 2), '…');
  console.log('categories:', (f.categories || []).map((c) => c.name + ':' + c.total));
  console.log('grandTotal:', f.grandTotal);
  // sanity vs the workbook's own Category Summary grand total (~1,336,456 L)
  if (!f.grandTotal || f.grandTotal < 1000000) throw new Error('grandTotal looks wrong: ' + f.grandTotal);
  console.log('OK');
})().catch((e) => { console.error('THREW', e.stack); process.exit(1); });
```

Run: `node --env-file=.env scratch-verify-fuel2.js`
(The `.env` has the Nutstore creds so it exercises the Nutstore path; the fuel file is fetched from Dropbox over the network, ~a few seconds.)
Expected: `has fuel: true | missing: false`, ~28 months, the 12 categories with litre totals, `grandTotal` ≈ `1336455.7`, then `OK`.

- [ ] **Step 7: Delete the scratch file and commit**

```bash
rm scratch-verify-fuel2.js
git add api/data.js
git commit -m "feat(fuel): fetch fuel workbook from Dropbox, expose payload.fuel"
```

---

## Task 3: Frontend — Fuel sub-tab (index.html + app.js)

**Files:**
- Modify: `public/index.html` (`#inv` section markup)
- Modify: `public/js/app.js` (fuel render/chart/chips/controls + sub-tab wiring)

**Interfaces:**
- Consumes: `data.fuel` (Task 2 shape); existing helpers `makeChart(id)`, `COL`, `MON`, `MONL(m)`, `explFmt(v)`.
- Produces: `renderFuel()` (called from `renderAll`), `fuelState`, and DOM ids `#invtab-expl`, `#invtab-fuel`, `#fuel-summary`, `#fuel-from`, `#fuel-to`, `#fuel-cats`, `#fuel-cat-all`, `#fuel-cat-none`, `#fuel-chart`.

**Do NOT touch `public/TamakoshiTracker.html` in this task — that is Task 4.**

- [ ] **Step 1: Wrap `#inv` content in sub-tabs (index.html)**

In `public/index.html`, the `#inv` section currently starts:

```html
      <section class="view" id="inv">
        <div class="card" style="margin-bottom:16px">
          <h3>Explosive Consumption ...
```

Replace the opening `<section class="view" id="inv">` line with the section open **plus** the sub-tab bar and the opening of the Explosives pane:

```html
      <section class="view" id="inv">
        <div class="sched-tabs">
          <button class="sched-tab on" data-invtab="expl">Explosives</button>
          <button class="sched-tab" data-invtab="fuel">Fuel</button>
        </div>
        <div class="stab-pane" id="invtab-expl">
```

Then, immediately before the section's closing `</section>` tag, close the Explosives pane and add the Fuel pane:

```html
        </div>
        <div class="stab-pane" id="invtab-fuel" hidden>
          <div class="card" style="margin-bottom:16px">
            <h3>Fuel Consumption <span class="muted" style="font-weight:600">· litres · monthly by equipment category</span></h3>
            <div id="fuel-summary" class="expl-summary"></div>
            <div class="expl-controls">
              <div class="fe-field"><label>From month</label><select id="fuel-from" class="fe-input"></select></div>
              <div class="fe-field"><label>To month</label><select id="fuel-to" class="fe-input"></select></div>
            </div>
            <div class="expl-loc-wrap">
              <div class="expl-loc-head"><span>Categories <span class="muted">· click to include / exclude</span></span>
                <span><button id="fuel-cat-all" class="fe-btn" type="button">All</button> <button id="fuel-cat-none" class="fe-btn" type="button">None</button></span></div>
              <div id="fuel-cats" class="expl-locs"></div>
            </div>
            <div id="fuel-chart" class="chart" style="height:360px"></div>
          </div>
        </div>
      </section>
```

(Net effect: the four existing `#inv` cards are now inside `#invtab-expl`; the new Fuel pane follows.)

- [ ] **Step 2: Add the fuel JS block (app.js)**

In `public/js/app.js`, just after the explosives block (after `renderExplosives` and its helpers, before `renderAll`), add:

```js
  // ---- Fuel consumption (Inventory & Explosives → Fuel tab) ----------------
  let fuelState = null, fuelWired = false, invTabsWired = false;
  const FUELCOL = ['#2f6fd0', '#e0a52e', '#1d8a63', '#b9772a', '#c0414b', '#5b46c9', '#2aa7c0', '#c05b8f', '#7a8b3f', '#445876', '#9c6b2e', '#8a8f98', '#d0863a'];
  function renderFuelChips() {
    const fu = data.fuel, st = fuelState, host = document.getElementById('fuel-cats'); if (!host) return;
    host.innerHTML = fu.categories.map((c, i) => `<span class="expl-chip ${st.cats.has(c.name) ? 'on' : ''}" data-cat="${c.name.replace(/"/g, '&quot;')}"><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${FUELCOL[i % FUELCOL.length]};margin-right:5px;vertical-align:-1px"></i>${c.name} <span class="k">${explFmt(c.total)}</span></span>`).join('');
  }
  function drawFuelChart() {
    const fu = data.fuel, st = fuelState;
    const months = fu.months.filter((m) => m >= st.from && m <= st.to);
    const colorOf = {}; fu.categories.forEach((c, i) => { colorOf[c.name] = FUELCOL[i % FUELCOL.length]; });
    const cats = fu.categories.filter((c) => st.cats.has(c.name));
    const series = cats.map((c) => ({ name: c.name, type: 'bar', stack: 'f',
      data: months.map((m) => Math.round(((fu.byMonth[m] || {})[c.name]) || 0)),
      itemStyle: { color: colorOf[c.name] } }));
    makeChart('fuel-chart').setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true, enterable: true,
        extraCssText: 'max-height:330px;overflow-y:auto',
        formatter: (ps) => {
          const rows = ps.filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
          const tot = ps.reduce((s, p) => s + p.value, 0);
          return ps[0].axisValue + '<br/>' + rows.map((p) => `${p.marker}${p.seriesName}: <b>${explFmt(p.value)}</b> L`).join('<br/>')
            + '<hr style="border:0;border-top:1px solid #e3e9f2;margin:5px 0"/>' + `Total: <b>${explFmt(tot)}</b> L`;
        } },
      legend: { show: false },
      grid: { left: 56, right: 16, top: 12, bottom: 44 },
      xAxis: { type: 'category', data: months.map(MONL), axisLabel: { fontSize: 10, color: COL.muted, rotate: months.length > 14 ? 40 : 0, interval: 0 }, axisLine: { lineStyle: { color: '#cfd8e6' } } },
      yAxis: { type: 'value', name: 'L', nameTextStyle: { fontSize: 10, color: COL.muted }, splitLine: { lineStyle: { color: COL.grid } }, axisLabel: { fontSize: 10, color: COL.muted } },
      series,
    }, true);
  }
  function renderFuelSummary() {
    const fu = data.fuel, st = fuelState, host = document.getElementById('fuel-summary'); if (!host) return;
    const months = fu.months.filter((m) => m >= st.from && m <= st.to);
    let sel = 0;
    for (const m of months) { const bm = fu.byMonth[m] || {}; for (const c of fu.categories) if (st.cats.has(c.name)) sel += bm[c.name] || 0; }
    const top = fu.categories[0];
    const tile = (lab, val, sub) => `<div class="expl-tile"><div class="lab">${lab}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
    host.innerHTML =
      tile('Fuel · selection', explFmt(sel) + ' L', st.cats.size + ' of ' + fu.categories.length + ' categories · ' + MONL(st.from) + '–' + MONL(st.to)) +
      tile('Fuel · all', explFmt(fu.grandTotal) + ' L', months.length + ' months') +
      tile('Top category', top ? top.name : '—', top ? explFmt(top.total) + ' L' : '');
  }
  function wireFuelControls() {
    if (fuelWired) return; fuelWired = true;
    const upd = () => { drawFuelChart(); renderFuelSummary(); };
    const fr = document.getElementById('fuel-from'), to = document.getElementById('fuel-to');
    if (fr) fr.addEventListener('change', () => { fuelState.from = fr.value; if (fuelState.from > fuelState.to) { fuelState.to = fuelState.from; to.value = fuelState.to; } upd(); });
    if (to) to.addEventListener('change', () => { fuelState.to = to.value; if (fuelState.to < fuelState.from) { fuelState.from = fuelState.to; fr.value = fuelState.from; } upd(); });
    const catHost = document.getElementById('fuel-cats');
    if (catHost) catHost.addEventListener('click', (e) => {
      const chip = e.target.closest('.expl-chip'); if (!chip) return;
      const c = chip.dataset.cat;
      if (fuelState.cats.has(c)) fuelState.cats.delete(c); else fuelState.cats.add(c);
      chip.classList.toggle('on'); upd();
    });
    const all = document.getElementById('fuel-cat-all'), none = document.getElementById('fuel-cat-none');
    if (all) all.addEventListener('click', () => { fuelState.cats = new Set(data.fuel.categories.map((c) => c.name)); renderFuelChips(); upd(); });
    if (none) none.addEventListener('click', () => { fuelState.cats = new Set(); renderFuelChips(); upd(); });
  }
  function renderFuel() {
    const host = document.getElementById('fuel-chart'); if (!host) return;
    const fu = data && data.fuel;
    const sumHost = document.getElementById('fuel-summary');
    if (!fu || !fu.months || !fu.months.length) {
      if (sumHost) sumHost.innerHTML = '<div class="muted" style="font-size:12px">No fuel consumption data available yet.</div>';
      return;
    }
    const sig = fu.months.join('|') + '##' + fu.categories.map((c) => c.name).join('|');
    if (!fuelState || fuelState._sig !== sig) {
      fuelState = { _sig: sig, from: fu.months[0], to: fu.months[fu.months.length - 1], cats: new Set(fu.categories.map((c) => c.name)) };
      const opts = fu.months.map((m) => `<option value="${m}">${MONL(m)}</option>`).join('');
      const fr = document.getElementById('fuel-from'), to = document.getElementById('fuel-to');
      if (fr) { fr.innerHTML = opts; fr.value = fuelState.from; }
      if (to) { to.innerHTML = opts; to.value = fuelState.to; }
      renderFuelChips(); wireFuelControls();
    }
    renderFuelSummary(); drawFuelChart();
  }
```

- [ ] **Step 3: Call `renderFuel()` + wire the sub-tabs in `renderAll` (app.js)**

Find `renderExplosives();` inside `renderAll()` and add `renderFuel();` right after it. Then, near the existing `if (!schedTabsWired) { … }` block in `renderAll`, add a sibling block:

```js
    if (!invTabsWired) {
      invTabsWired = true;
      document.querySelectorAll('#inv .sched-tab[data-invtab]').forEach((btn) => btn.addEventListener('click', () => {
        const which = btn.dataset.invtab;
        document.querySelectorAll('#inv .sched-tab[data-invtab]').forEach((b) => b.classList.toggle('on', b === btn));
        const ep = document.getElementById('invtab-expl'), fp = document.getElementById('invtab-fuel');
        if (ep) ep.hidden = which !== 'expl';
        if (fp) fp.hidden = which !== 'fuel';
        if (which === 'fuel') renderFuel(); // (re)draw now that the pane is visible so ECharts sizes correctly
      }));
    }
```

- [ ] **Step 4: Syntax check**

Run: `node --check public/js/app.js`
Expected: exit 0, no output.

- [ ] **Step 5: Commit (controller runs the browser verification separately)**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(fuel): Fuel sub-tab with stacked monthly-by-category chart"
```

> Browser verification (Fuel tab renders stacked bars, chips/month-range filter live, tooltip breaks down by category, Explosives tab unchanged, no console errors) is performed by the controller in cloud-dev after this task. Do not attempt it here.

---

## Task 4: Mirror to TamakoshiTracker + refresh Desktop copy

**Files:**
- Modify: `public/TamakoshiTracker.html` (markup + inline JS)
- Modify: `TamakoshiTracker.html` (repo root — byte-copy)

**Interfaces:** Consumes the exact Task 3 changes (source of truth: the Task 3 diff).

- [ ] **Step 1: Mirror the markup + JS into `public/TamakoshiTracker.html`**

Read the Task 3 diff (the controller provides its path) to see the exact `#inv` markup change and the fuel JS block + `renderAll` edits from `public/index.html` / `public/js/app.js`. Apply the **equivalent** changes to `public/TamakoshiTracker.html`, whose `#inv` section and `renderExplosives`/`renderAll` code are structurally identical (locate with `grep -n "id=\"inv\"\|Explosive Consumption\|renderExplosives\|schedTabsWired\|renderExplosives();" public/TamakoshiTracker.html`). Do NOT change `API_BASE`.

- [ ] **Step 2: Syntax check the inline scripts**

Run:
```bash
node -e 'const fs=require("fs"),vm=require("vm");const h=fs.readFileSync("public/TamakoshiTracker.html","utf8");const re=/<script\b[^>]*>([\s\S]*?)<\/script>/gi;let m,bad=0,i=0;while((m=re.exec(h))){i++;if(!m[1].trim())continue;try{new vm.Script(m[1]);}catch(e){bad++;console.log("script#"+i,e.message);}}console.log("scripts",i,"errors",bad);'
```
Expected: `scripts 2 errors 0`.

- [ ] **Step 3: Confirm no stray issues**

Run: `grep -nE "fuel-chart|fuel-cats|data-invtab|renderFuel" public/TamakoshiTracker.html`
Expected: the new ids/handlers present. And confirm `API_BASE` unchanged:
`grep -n "const API_BASE" public/TamakoshiTracker.html` → still `'https://tkv-tracker.vercel.app'`.

- [ ] **Step 4: Refresh the Desktop copy and commit**

```bash
cp public/TamakoshiTracker.html ./TamakoshiTracker.html
git add public/TamakoshiTracker.html TamakoshiTracker.html
git commit -m "feat(fuel): mirror Fuel tab to TamakoshiTracker"
```

> Browser verification of both frontends (Fuel tab works end-to-end; TamakoshiTracker checked via a local-`API_BASE` temp copy) is performed by the controller after this task.

---

## Self-Review

**Spec coverage:** Data source & isolated parse → Task 2. `parseFuel` shape → Task 1. Sub-tab bar + Fuel pane + stacked chart + chips + month range + summary → Task 3. Mirror + Desktop copy → Task 4. Litres-only / combined-sites / no-new-CSS / reuse classes → Global Constraints + Task 3 markup. Live-update via ETag in sig → Task 2 Steps 4-5. ✓ All covered.

**Placeholder scan:** none — every code step contains complete code; verification scripts are complete.

**Type consistency:** `parseFuel` return (`months`, `categories:[{name,total}]`, `byMonth`, `grandTotal`) is produced in Task 1 and consumed identically in Task 2 (`payload.fuel`) and Task 3 (`data.fuel`). DOM ids (`fuel-chart`, `fuel-cats`, `fuel-from`, `fuel-to`, `fuel-cat-all/none`, `fuel-summary`, `invtab-expl/fuel`) match between Task 3 markup and JS. Helpers reused (`MONL`, `explFmt`, `makeChart`, `COL`, `MON`) exist in app.js. ✓
