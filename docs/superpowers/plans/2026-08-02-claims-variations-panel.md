# Claims & Variations Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Claims & Variations panel as a five-tab contract-management module (Overview · Claims · Variations · Potential Claims · EOT) live from one Nutstore workbook.

**Architecture:** New `parseClaimsRegister()` reads six sheets (Claims/Variations/PotentialClaims/EOT/Chronology/Letters) and joins chronology+letters onto each item by Ref No; `api/data.js` fetches the workbook from Nutstore (mirroring the insurance pattern), parses it in isolation, and exposes `payload.claimsRegister`. Both frontends render a config-driven module: one generic register renderer + one generic detail-panel renderer drive all four register tabs, and an Overview tab computes KPIs + three ECharts (commercial-exposure bar, status donut, probability-vs-value scatter).

**Tech Stack:** Node serverless (`api/data.js`), `lib/parsers.js`, `lib/workbook.js` (`workbookSheets`), vanilla JS + ECharts frontends, `openpyxl`/`xlsx` for verification.

## Global Constraints

- No unit-test framework — "testing" is Node scripts against a schema-conformant mock workbook + cloud-dev browser checks. Do not add a test runner.
- **Public GitHub repo:** never commit secrets, real claims data, or any `.xlsx`. Scratch/mock/verification files must not be committed.
- **Two synced frontends must stay identical:** `public/index.html` (+ `css/styles.css` + `js/app.js`) AND self-contained `public/TamakoshiTracker.html` (inline CSS+JS, `API_BASE='https://tkv-tracker.vercel.app'` — never change it). Repo-root `TamakoshiTracker.html` is a byte-copy.
- Reuse existing classes where possible — `.sched-tabs`/`.sched-tab`/`.stab-pane` (sub-tabs), `.expl-*` (chips/tiles), `.fe-input`/`.fe-btn`, `.tbl`, `.badge` — and add only the `cv-*` classes this module needs.
- **Excluded (do not build):** Overview Management-Attention panel; Overview Quick-Links/Correspondence/Document footer; Variation Instruction/Event block; Potential-Claims Notice-Deadline/Days-Remaining/Owner.
- Data source: Nutstore workbook, default path `Shared Folder/Claims & Variation/Claims & Variations Register.xlsx`. Columns located by header text; money is NPR millions; Probability %/Priority optional.
- Money display: values are NPR millions in the sheet; show as `NPR <n> M`.

---

## File Structure

- `lib/parsers.js` — add `parseClaimsRegister(matrices)` + export.
- `api/data.js` — Nutstore fetch + isolated parse + `payload.claimsRegister`.
- `public/css/styles.css` — `cv-*` classes (module layout, detail panel, timeline, scatter legend).
- `public/index.html` — rebuild `#claims` section markup.
- `public/js/app.js` — the claims module (config + renderers + charts + wiring); retire old `renderClaims`.
- `public/TamakoshiTracker.html` + repo-root `TamakoshiTracker.html` — mirror.

---

## Task 1: `parseClaimsRegister()` parser

**Files:** Modify `lib/parsers.js` (add function + export).

**Interfaces — Produces:**
`parseClaimsRegister(matrices) -> { claims[], variations[], potential[], eot[], kpis, warnings }` where each register item carries `chronology:[{date,event}]` and `letters:[{ref,title,date}]`, and:
- `claims[i]`: `{ ref,title,basis,socRef,workArea,value,eotDays,prob,priority,status,submittedOn,submittedBy,nextAction,actionDue,summary,chronology,letters }`
- `variations[i]`: `{ ref,title,instrType,estValue,submittedValue,approvedValue,prob,priority,status,nextAction,actionDue,description,chronology,letters }`
- `potential[i]`: `{ ref,matter,type,estValue,prob,priority,status,basis,summary,recommendedAction,chronology,letters }`
- `eot[i]`: `{ ref,cause,periodFrom,periodTo,daysClaimed,erAssessment,employerGranted,status,nextAction,summary,recommendedAction,chronology,letters }`
- `kpis`: `{ claimsCount,claimsValue,variationsCount,variationsValue,potentialCount,potentialValue,eotClaimedDays,eotGrantedDays,approvedValue,underReviewValue,byStatusValue:{}, scatter:[{ref,value,prob,kind}] }`

- [ ] **Step 1: Add `parseClaimsRegister` to `lib/parsers.js`** (before `module.exports`):

```js
// Claims & Variations register — six sheets from one workbook. Chronology and
// Letters rows are joined onto each register item by Ref No. Columns are located
// by header text (row 0), tolerant of ordering; money is NPR millions.
function parseClaimsRegister(matrices) {
  const warnings = [];
  const txt = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
  const num = (v) => (typeof v === 'number' ? v : (v == null || v === '' ? null : (parseFloat(String(v).replace(/[^0-9.\-]/g, '')) || null)));
  const iso = (v) => {
    if (v == null || v === '') return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
    const t = Date.parse(String(v)); return isNaN(t) ? txt(v) : new Date(t).toISOString().slice(0, 10);
  };
  // Build a header-index lookup for a sheet: name (lowercased, spaces/punct-stripped) -> column index.
  const cols = (grid) => {
    const h = (grid && grid[0]) || [];
    const m = {};
    h.forEach((c, i) => { if (typeof c === 'string') m[c.toLowerCase().replace(/[^a-z0-9]/g, '')] = i; });
    return m;
  };
  const pick = (row, idx) => (idx == null ? '' : row[idx]);
  const rowsOf = (name) => { const g = matrices[name]; return Array.isArray(g) ? g : null; };

  // --- Chronology + Letters, grouped by Ref No (lowercased) ---
  const chronByRef = {}, lettersByRef = {};
  const chg = rowsOf('Chronology');
  if (chg) { const c = cols(chg);
    for (let i = 1; i < chg.length; i++) { const r = chg[i]; if (!r) continue;
      const ref = txt(pick(r, c.refno)).toLowerCase(); if (!ref) continue;
      (chronByRef[ref] = chronByRef[ref] || []).push({ date: iso(pick(r, c.date)), event: txt(pick(r, c.event)) }); } }
  const leg = rowsOf('Letters');
  if (leg) { const c = cols(leg);
    for (let i = 1; i < leg.length; i++) { const r = leg[i]; if (!r) continue;
      const ref = txt(pick(r, c.refno)).toLowerCase(); if (!ref) continue;
      (lettersByRef[ref] = lettersByRef[ref] || []).push({ ref: txt(pick(r, c.letterref)), title: txt(pick(r, c.title)), date: iso(pick(r, c.date)) }); } }
  const joins = (ref) => ({ chronology: chronByRef[String(ref).toLowerCase()] || [], letters: lettersByRef[String(ref).toLowerCase()] || [] });

  // --- Generic register-sheet reader: fieldMap = { outKey: headerKey } ---
  const readSheet = (name, refKey, fieldMap, kinds) => {
    const g = rowsOf(name); if (!g) return [];
    const c = cols(g); const out = [];
    for (let i = 1; i < g.length; i++) {
      const r = g[i]; if (!r) continue;
      const ref = txt(pick(r, c[refKey])); if (!ref) continue;
      const item = { ref };
      for (const [outK, hdrK] of Object.entries(fieldMap)) {
        const idx = c[hdrK]; const raw = pick(r, idx);
        item[outK] = kinds[outK] === 'num' ? num(raw) : kinds[outK] === 'date' ? iso(raw) : txt(raw);
      }
      Object.assign(item, joins(ref));
      out.push(item);
    }
    return out;
  };

  const claims = readSheet('Claims', 'refno', {
    title: 'claimtitle', basis: 'contractualbasis', socRef: 'socref', workArea: 'workarea',
    value: 'claimedvaluenprm', eotDays: 'eotdays', prob: 'probability', priority: 'priority',
    status: 'status', submittedOn: 'submittedon', submittedBy: 'submittedby',
    nextAction: 'nextaction', actionDue: 'actiondue', summary: 'summary',
  }, { value: 'num', eotDays: 'num', prob: 'num', submittedOn: 'date', actionDue: 'date' });

  const variations = readSheet('Variations', 'varref', {
    title: 'title', instrType: 'instructiontype', estValue: 'estimatedvaluenprm',
    submittedValue: 'submittedvaluenprm', approvedValue: 'approvedvaluenprm', prob: 'probability',
    priority: 'priority', status: 'status', nextAction: 'nextaction', actionDue: 'actiondue', description: 'description',
  }, { estValue: 'num', submittedValue: 'num', approvedValue: 'num', prob: 'num', actionDue: 'date' });

  const potential = readSheet('PotentialClaims', 'eventref', {
    matter: 'potentialmatter', type: 'type', estValue: 'estimatedvaluenprm', prob: 'probability',
    priority: 'priority', status: 'status', basis: 'contractbasis', summary: 'eventsummary',
    recommendedAction: 'recommendedaction',
  }, { estValue: 'num', prob: 'num' });

  const eot = readSheet('EOT', 'eotref', {
    cause: 'delayeventcause', periodFrom: 'periodfrom', periodTo: 'periodto', daysClaimed: 'daysclaimed',
    erAssessment: 'erassessment', employerGranted: 'employergranted', status: 'status',
    nextAction: 'nextaction', summary: 'executivesummary', recommendedAction: 'recommendedaction',
  }, { periodFrom: 'date', periodTo: 'date', daysClaimed: 'num', erAssessment: 'num', employerGranted: 'num' });

  // --- KPIs (computed) ---
  const isUnderReview = (s) => /review|assessment|pending|submitted|notice/i.test(s || '');
  const isApproved = (s) => /approv|grant|determin|settl/i.test(s || '');
  const byStatusValue = {};
  const scatter = [];
  const addStatus = (s, v) => { const k = txt(s) || 'Unknown'; byStatusValue[k] = (byStatusValue[k] || 0) + (v || 0); };
  const addScatter = (ref, v, p, kind) => { if (v != null && p != null) scatter.push({ ref, value: v, prob: p, kind }); };
  for (const x of claims) { addStatus(x.status, x.value); addScatter(x.ref, x.value, x.prob, 'claim'); }
  for (const x of variations) { const v = x.approvedValue != null ? x.approvedValue : (x.submittedValue != null ? x.submittedValue : x.estValue); addStatus(x.status, v); addScatter(x.ref, v, x.prob, 'variation'); }
  for (const x of potential) { addStatus(x.status, x.estValue); addScatter(x.ref, x.estValue, x.prob, 'potential'); }
  const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
  const kpis = {
    claimsCount: claims.length, claimsValue: sum(claims, (x) => x.value),
    variationsCount: variations.length, variationsValue: sum(variations, (x) => x.estValue),
    potentialCount: potential.length, potentialValue: sum(potential, (x) => x.estValue),
    eotClaimedDays: sum(eot, (x) => x.daysClaimed), eotGrantedDays: sum(eot, (x) => x.employerGranted),
    approvedValue: sum(claims.filter((x) => isApproved(x.status)), (x) => x.value)
      + sum(variations.filter((x) => isApproved(x.status)), (x) => x.approvedValue),
    underReviewValue: sum(claims.filter((x) => isUnderReview(x.status)), (x) => x.value),
    byStatusValue, scatter,
  };

  if (!claims.length && !variations.length && !potential.length && !eot.length) {
    warnings.push('Claims register: no rows found in any sheet');
    return { warnings, missing: true };
  }
  return { warnings, claims, variations, potential, eot, kpis };
}
```

Add `parseClaimsRegister` to the `module.exports = { … }` list in `lib/parsers.js`.

- [ ] **Step 2: Verify with a synthetic matrix** — create `scratch-verify-cv1.js` in repo root:

```js
const { parseClaimsRegister } = require('./lib/parsers');
const H = (a) => a; // header row helper
const m = {
  Claims: [ H(['Ref No','Claim Title','Contractual Basis','SoC Ref','Work Area','Claimed Value (NPR M)','EOT Days','Probability %','Priority','Status','Submitted On','Submitted By','Next Action','Action Due','Summary']),
    ['SOC-10','Price Escalation','Subclause 13.8','SoC-06','Powerhouse',95.44,'',70,'High','Under Review','2026-04-10','Contractor','Rebuttal','2026-07-22','Escalation claim.'] ],
  Variations: [ H(['Var Ref','Title','Instruction Type','Estimated Value (NPR M)','Submitted Value (NPR M)','Approved Value (NPR M)','Probability %','Priority','Status','Next Action','Action Due','Description']),
    ['VAR-07','Cavern Redesign','Variation',168.35,168.35,'',75,'High','Notice Issued','Quote','2026-07-07','Redesign.'] ],
  PotentialClaims: [ H(['Event Ref','Potential Matter','Type','Estimated Value (NPR M)','Probability %','Priority','Status','Contract Basis','Event Summary','Recommended Action']),
    ['PC-14','Support Change','Variation',59.40,70,'High','Under Assessment','GCC 13.3','Directed change.','Issue notice.'] ],
  EOT: [ H(['EOT Ref','Delay Event/Cause','Period From','Period To','Days Claimed','ER Assessment','Employer Granted','Status','Next Action','Executive Summary','Recommended Action']),
    ['EOT-01','Site Possession','2026-05-01','2026-05-31',98,'','','Under Review','ER Pending','Access suspended.','Await ER.'] ],
  Chronology: [ H(['Ref No','Date','Event']), ['SOC-10','2026-04-10','Notice submitted.'], ['SOC-10','2026-04-25','Acknowledged.'] ],
  Letters: [ H(['Ref No','Letter Ref','Title','Date']), ['SOC-10','L-0154','Acknowledgement','2026-04-25'] ],
};
const r = parseClaimsRegister(m);
const assert = require('assert');
assert.strictEqual(r.claims.length, 1);
assert.strictEqual(r.claims[0].value, 95.44);
assert.strictEqual(r.claims[0].chronology.length, 2);
assert.strictEqual(r.claims[0].letters.length, 1);
assert.strictEqual(r.variations[0].ref, 'VAR-07');
assert.strictEqual(r.eot[0].daysClaimed, 98);
assert.strictEqual(r.kpis.claimsCount, 1);
assert.strictEqual(r.kpis.scatter.length, 3); // claim+variation+potential with prob+value
console.log('OK', JSON.stringify(r.kpis.byStatusValue));
```

- [ ] **Step 3: Run** `node scratch-verify-cv1.js` → prints `OK {…}`, exit 0. (Before Step 1, it throws `parseClaimsRegister is not a function`.)

- [ ] **Step 4: Delete scratch file, commit**
```bash
rm scratch-verify-cv1.js
git add lib/parsers.js
git commit -m "feat(claims): parseClaimsRegister — six-sheet register with chronology/letters join + KPIs"
```

---

## Task 2: Backend — fetch register + expose `payload.claimsRegister`

**Files:** Modify `api/data.js`.

**Interfaces — Consumes** `parseClaimsRegister` (Task 1), existing `workbookSheets`, Nutstore helpers (`propfind`, `getBuffer`, `encPath`, `DAV_BASE`). **Produces** `payload.claimsRegister` (Task 1 shape or `{missing:true}`).

- [ ] **Step 1: Import + constant + isolated reader.** Add `parseClaimsRegister` to the `require('../lib/parsers')` destructure. Near `INSURANCE_XLSX_PATH` add:
```js
// Claims & Variations register — its own Nutstore workbook, parsed in isolation.
const CLAIMS_REGISTER_XLSX_PATH = 'Shared Folder/Claims & Variation/Claims & Variations Register.xlsx';
```
Next to `insuranceFromBuffer` add:
```js
function claimsRegisterFromBuffer(buffer) {
  if (!buffer) return { missing: true, warnings: ['Claims register workbook not available'] };
  try {
    const { matrices } = workbookSheets(buffer, ['Claims', 'Variations', 'PotentialClaims', 'EOT', 'Chronology', 'Letters']);
    return parseClaimsRegister(matrices);
  } catch (e) {
    return { missing: true, warnings: ['Claims register parse failed: ' + String(e.message || e)] };
  }
}
```

- [ ] **Step 2: Thread through `assemble`.** Add a trailing `claimsRegBuffer` param to `assemble(...)`, and in the returned payload (next to `insurance:`), add:
```js
    claimsRegister: claimsRegisterFromBuffer(claimsRegBuffer),
```

- [ ] **Step 3: Nutstore path.** In the PROPFIND `Promise.all`, add (mirroring the insurance propfind):
```js
      propfind(DAV_BASE + encPath(CLAIMS_REGISTER_XLSX_PATH), headers, 0).catch(() => []),
```
and add `, cvInfo` to its destructure. After the `insMtime` line add:
```js
    const cvMtime = (cvInfo[0] && cvInfo[0].mtime) || '';
```
Add to the `sig` object: `cvreg: CLAIMS_REGISTER_XLSX_PATH + '|' + cvMtime,`. In the buffers `Promise.all`, add:
```js
      cvMtime ? getBuffer(CLAIMS_REGISTER_XLSX_PATH, cvMtime, headers).catch(() => null) : Promise.resolve(null),
```
with `, claimsRegBuffer` in its destructure, and pass `claimsRegBuffer` as the new trailing arg to this path's `assemble(...)`.

- [ ] **Step 4: Local-dev path.** Add:
```js
  const cvFile = files.find((f) => /claims.*variations.*register\.xlsx$/i.test(f));
  const claimsRegBuffer = cvFile ? fs.readFileSync(path.join(dir, cvFile)) : null;
```
and pass `claimsRegBuffer` as the trailing arg to the local-path `assemble(...)`. (Add a `cvreg` entry to the local `sig` if present: `cvreg: cvFile || '',`.)

- [ ] **Step 5: Verify.** Put a schema-conformant mock `Claims & Variations Register.xlsx` in `data/` (build it with the Task-1 synthetic data via openpyxl, or copy the user's template and keep the example rows). Create `scratch-verify-cv2.js`:
```js
const data = require('./api/data.js');
(async () => { const p = await data.buildPayload(); const cv = p.claimsRegister || {};
  console.log('has:', !!p.claimsRegister, 'missing:', !!cv.missing, 'claims:', (cv.claims||[]).length, 'kpis:', cv.kpis && cv.kpis.claimsCount);
  if (cv.missing) throw new Error('claimsRegister missing'); console.log('OK'); })().catch((e) => { console.error(e); process.exit(1); });
```
Run `node scratch-verify-cv2.js` (local-dev path, no `.env` needed) → `has: true missing: false …`, `OK`. Delete the mock from `data/` and the scratch file.

- [ ] **Step 6: Commit** (`api/data.js` only): `git commit -m "feat(claims): fetch Claims & Variations Register from Nutstore, expose payload.claimsRegister"`.

---

## Task 3: Frontend shell — `#claims` rebuild, CSS, module wiring

**Files:** Modify `public/index.html`, `public/css/styles.css`, `public/js/app.js`.

**Interfaces — Produces:** DOM ids `#cvtab-{overview,claims,variations,potential,eot}`, `renderClaimsModule()` (called from `renderAll`), the `CV` config object, and helpers `cvMoney`, `cvBadge`, `cvDate`.

- [ ] **Step 1: Replace `#claims` markup in `public/index.html`.** Replace `<section class="view" id="claims"><div id="claims-body"></div></section>` with:
```html
      <section class="view" id="claims">
        <div class="sched-tabs">
          <button class="sched-tab on" data-cvtab="overview">Overview</button>
          <button class="sched-tab" data-cvtab="claims">Claims</button>
          <button class="sched-tab" data-cvtab="variations">Variations</button>
          <button class="sched-tab" data-cvtab="potential">Potential Claims</button>
          <button class="sched-tab" data-cvtab="eot">EOT</button>
        </div>
        <div class="stab-pane" id="cvtab-overview"></div>
        <div class="stab-pane" id="cvtab-claims" hidden></div>
        <div class="stab-pane" id="cvtab-variations" hidden></div>
        <div class="stab-pane" id="cvtab-potential" hidden></div>
        <div class="stab-pane" id="cvtab-eot" hidden></div>
      </section>
```

- [ ] **Step 2: Add `cv-*` CSS to `public/css/styles.css`** (append):
```css
.cv-kpis{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}
.cv-kpi{flex:1;min-width:150px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.cv-kpi .lab{font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);font-weight:700}
.cv-kpi .val{font-size:20px;font-weight:800;color:var(--navy);margin-top:2px}
.cv-kpi .sub{font-size:11px;color:var(--muted);margin-top:1px}
.cv-controls{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px;align-items:center}
.cv-controls .fe-input{max-width:220px}
.cv-split{display:grid;grid-template-columns:1.55fr 1fr;gap:16px;align-items:start}
@media(max-width:1100px){.cv-split{grid-template-columns:1fr}}
.cv-tbl-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:#fff}
.cv-tbl{width:100%;border-collapse:collapse;font-size:12px}
.cv-tbl th{background:#f4f7fb;color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.3px;padding:8px 10px;text-align:left;position:sticky;top:0}
.cv-tbl td{padding:8px 10px;border-top:1px solid #eef2f7;vertical-align:top}
.cv-tbl tr{cursor:pointer}
.cv-tbl tr.on td{background:#eef4fc}
.cv-detail{border:1px solid var(--line);border-radius:12px;background:#fff;padding:16px;min-height:200px;position:sticky;top:12px}
.cv-detail .hint{color:var(--muted);font-size:12px;text-align:center;padding:40px 0}
.cv-detail h4{font-size:15px;font-weight:800;color:var(--navy);margin:0 0 2px}
.cv-detail .dref{font-size:11px;color:var(--muted);font-weight:700}
.cv-badges{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.cv-sec{font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);font-weight:800;margin:14px 0 6px}
.cv-desc{font-size:12.5px;color:var(--ink);line-height:1.5}
.cv-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:12px}
.cv-kv .k{color:var(--muted)}
.cv-time{list-style:none;margin:0;padding:0}
.cv-time li{position:relative;padding:0 0 10px 16px;border-left:2px solid #dbe4f0;font-size:12px}
.cv-time li:before{content:'';position:absolute;left:-5px;top:3px;width:8px;height:8px;border-radius:50%;background:var(--accent)}
.cv-time .d{font-weight:700;color:var(--navy);margin-right:6px}
.cv-letters{font-size:12px}
.cv-letters a,.cv-letters span.lt{display:block;padding:2px 0;color:var(--navy)}
.cv-b-hi{background:#fde8e8;color:#b3261e}.cv-b-md{background:#fdf0d8;color:#9a6a12}.cv-b-lo{background:#e7f0fb;color:#2f6fd0}
.cv-b-ok{background:#e3f5ec;color:#1c7a52}.cv-b-warn{background:#fdf0d8;color:#9a6a12}.cv-b-bad{background:#fde8e8;color:#b3261e}.cv-b-neut{background:#eef2f7;color:#51637e}
.cv-scatter-leg{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-top:6px}
.cv-scatter-leg i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:4px;vertical-align:-1px}
```

- [ ] **Step 3: Add the module skeleton to `public/js/app.js`** (place after `renderClaims`/`CLAIMS` — those get removed in Task 6; for now add alongside). This step adds config + helpers + `renderClaimsModule` + tab wiring; the register/overview renderers are Tasks 4–5 (define them as empty stubs here so wiring runs):
```js
  // ================= Claims & Variations module =================
  const CV_KIND = { claims: 'claims', variations: 'variations', potential: 'potential', eot: 'eot' };
  let cvWired = false, cvSel = {}; // cvSel[kind] = selected ref
  const cvMoney = (v) => (v == null ? '–' : 'NPR ' + (Math.round(v * 100) / 100).toLocaleString('en-US') + ' M');
  const cvDate = (d) => (d ? d : '–');
  const cvPriorityClass = (p) => (/high/i.test(p || '') ? 'cv-b-hi' : /med/i.test(p || '') ? 'cv-b-md' : /low/i.test(p || '') ? 'cv-b-lo' : 'cv-b-neut');
  const cvStatusClass = (s) => (/approv|grant|settl|determin/i.test(s || '') ? 'cv-b-ok'
    : /reject|disput/i.test(s || '') ? 'cv-b-bad'
    : /review|assess|pending|notice|submit|draft/i.test(s || '') ? 'cv-b-warn' : 'cv-b-neut');
  const cvBadge = (text, cls) => (text ? `<span class="badge ${cls}" style="font-size:10.5px">${text}</span>` : '');

  // Column config per register kind (label, field, formatter).
  const CV = {
    claims: { title: 'Claims', dataKey: 'claims', valueField: 'value',
      cols: [['Ref', 'ref'], ['Claim Title', 'title'], ['Basis', 'basis'], ['SoC', 'socRef'],
        ['Value', 'value', cvMoney], ['EOT', 'eotDays'], ['Status', 'status', 'status'], ['Next Action', 'nextAction']] },
    variations: { title: 'Variations', dataKey: 'variations', valueField: 'estValue',
      cols: [['Ref', 'ref'], ['Title', 'title'], ['Type', 'instrType'], ['Estimated', 'estValue', cvMoney],
        ['Submitted', 'submittedValue', cvMoney], ['Approved', 'approvedValue', cvMoney], ['Status', 'status', 'status'], ['Next Action', 'nextAction']] },
    potential: { title: 'Potential Claims', dataKey: 'potential', valueField: 'estValue',
      cols: [['Ref', 'ref'], ['Potential Matter', 'matter'], ['Type', 'type'], ['Estimated', 'estValue', cvMoney],
        ['Probability', 'prob', (v) => (v == null ? '–' : v + '%')], ['Status', 'status', 'status']] },
    eot: { title: 'EOT', dataKey: 'eot', valueField: 'daysClaimed',
      cols: [['Ref', 'ref'], ['Delay Event / Cause', 'cause'], ['Period', null, (v, x) => (x.periodFrom ? x.periodFrom + ' → ' + (x.periodTo || '') : '–')],
        ['Days Claimed', 'daysClaimed'], ['ER Assess.', 'erAssessment'], ['Granted', 'employerGranted'], ['Status', 'status', 'status'], ['Next Action', 'nextAction']] },
  };

  function renderClaimsModule() {
    const cv = data && data.claimsRegister;
    const ov = document.getElementById('cvtab-overview'); if (!ov) return;
    if (!cv || cv.missing) {
      ov.innerHTML = '<div class="card"><div class="muted" style="font-size:12px">No Claims & Variations data available yet. Populate the register workbook to see this panel.</div></div>';
      ['claims', 'variations', 'potential', 'eot'].forEach((k) => { const el = document.getElementById('cvtab-' + k); if (el) el.innerHTML = ''; });
    } else {
      renderClaimsOverview();               // Task 5
      ['claims', 'variations', 'potential', 'eot'].forEach(renderRegisterTab); // Task 4
    }
    if (!cvWired) {
      cvWired = true;
      document.querySelectorAll('#claims .sched-tab[data-cvtab]').forEach((btn) => btn.addEventListener('click', () => {
        const which = btn.dataset.cvtab;
        document.querySelectorAll('#claims .sched-tab[data-cvtab]').forEach((b) => b.classList.toggle('on', b === btn));
        ['overview', 'claims', 'variations', 'potential', 'eot'].forEach((k) => { const el = document.getElementById('cvtab-' + k); if (el) el.hidden = k !== which; });
        setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 80); // charts size when their pane is revealed
      }));
    }
  }
  function renderRegisterTab() {}   // replaced in Task 4
  function renderClaimsOverview() {} // replaced in Task 5
```
Then in `renderAll()`, replace the `renderClaims();` call with `renderClaimsModule();`.

- [ ] **Step 4: Syntax check** `node --check public/js/app.js` → exit 0. Commit `public/index.html public/css/styles.css public/js/app.js` → `feat(claims): module shell — 5 sub-tabs, cv CSS, wiring, no-data state`.

> Browser verification is done by the controller after Task 5 (when the tabs have content). This task's deliverable is a syntactically valid shell.

---

## Task 4: Register tabs + detail panel (generic renderers)

**Files:** Modify `public/js/app.js` (replace the `renderRegisterTab` stub; add `cvRenderDetail`).

**Interfaces — Consumes** `CV`, `data.claimsRegister`, `cvMoney/cvDate/cvBadge/cvStatusClass/cvPriorityClass`, `cvSel`. **Produces** `renderRegisterTab(kind)` + `cvRenderDetail(kind, item)`.

- [ ] **Step 1: Replace the `renderRegisterTab` stub** in `public/js/app.js` with:
```js
  function cvKpiCard(lab, val, sub) { return `<div class="cv-kpi"><div class="lab">${lab}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`; }
  function renderRegisterTab(kind) {
    const cfg = CV[kind], cv = data.claimsRegister; const el = document.getElementById('cvtab-' + kind); if (!el) return;
    const rows = cv[cfg.dataKey] || [];
    const statuses = [...new Set(rows.map((r) => r.status).filter(Boolean))].sort();
    const totalVal = rows.reduce((s, r) => s + (r[cfg.valueField] || 0), 0);
    const kpi = kind === 'eot'
      ? cvKpiCard('EOT Cases', rows.length) + cvKpiCard('Days Claimed', cv.kpis.eotClaimedDays.toLocaleString('en-US')) + cvKpiCard('Days Granted', (cv.kpis.eotGrantedDays || 0).toLocaleString('en-US'))
      : cvKpiCard(cfg.title + ' Raised', rows.length) + cvKpiCard('Total Value', cvMoney(totalVal)) + cvKpiCard('Under Review', rows.filter((r) => /review|assess|pending|notice|submit/i.test(r.status || '')).length + ' items');
    el.innerHTML =
      `<div class="cv-kpis">${kpi}</div>
       <div class="cv-controls">
         <input class="fe-input" id="cv-${kind}-search" placeholder="Search ${cfg.title.toLowerCase()}…">
         <select class="fe-input" id="cv-${kind}-status"><option value="">All statuses</option>${statuses.map((s) => `<option>${s}</option>`).join('')}</select>
       </div>
       <div class="cv-split">
         <div class="cv-tbl-wrap"><table class="cv-tbl"><thead><tr>${cfg.cols.map((c) => `<th>${c[0]}</th>`).join('')}</tr></thead><tbody id="cv-${kind}-body"></tbody></table></div>
         <div class="cv-detail" id="cv-${kind}-detail"><div class="hint">Select a row to see its details.</div></div>
       </div>`;
    const body = document.getElementById('cv-' + kind + '-body');
    const draw = () => {
      const q = (document.getElementById('cv-' + kind + '-search').value || '').toLowerCase();
      const st = document.getElementById('cv-' + kind + '-status').value;
      const shown = rows.filter((r) => (!st || r.status === st) && (!q || JSON.stringify(r).toLowerCase().includes(q)));
      body.innerHTML = shown.map((r) => `<tr data-ref="${String(r.ref).replace(/"/g, '&quot;')}" class="${cvSel[kind] === r.ref ? 'on' : ''}">` +
        cfg.cols.map((c) => {
          if (c[2] === 'status') return `<td>${cvBadge(r.status, cvStatusClass(r.status))}</td>`;
          const raw = c[1] ? r[c[1]] : null;
          const val = typeof c[2] === 'function' ? c[2](raw, r) : (raw == null || raw === '' ? '–' : raw);
          return `<td>${val}</td>`;
        }).join('') + '</tr>').join('') || `<tr><td colspan="${cfg.cols.length}" class="muted" style="text-align:center;padding:16px">No matching ${cfg.title.toLowerCase()}.</td></tr>`;
      if (cvSel[kind]) { const it = rows.find((r) => r.ref === cvSel[kind]); if (it) cvRenderDetail(kind, it); }
    };
    draw();
    document.getElementById('cv-' + kind + '-search').oninput = draw;
    document.getElementById('cv-' + kind + '-status').onchange = draw;
    body.onclick = (e) => { const tr = e.target.closest('tr[data-ref]'); if (!tr) return; cvSel[kind] = tr.dataset.ref;
      body.querySelectorAll('tr').forEach((x) => x.classList.toggle('on', x === tr));
      const it = rows.find((r) => String(r.ref) === tr.dataset.ref); if (it) cvRenderDetail(kind, it); };
  }
```

- [ ] **Step 2: Add `cvRenderDetail`** (generic detail panel):
```js
  function cvRenderDetail(kind, x) {
    const host = document.getElementById('cv-' + kind + '-detail'); if (!host) return;
    const headVal = kind === 'eot' ? (x.daysClaimed != null ? x.daysClaimed + ' days' : '') : cvMoney(x[CV[kind].valueField]);
    const title = x.title || x.matter || x.cause || x.ref;
    const summary = x.summary || x.description || '';
    const kv = [];
    if (kind === 'claims') kv.push(['Contractual Basis', x.basis], ['SoC Ref', x.socRef], ['Work Area', x.workArea], ['Submitted', [x.submittedOn, x.submittedBy].filter(Boolean).join(' · ')]);
    if (kind === 'variations') kv.push(['Instruction Type', x.instrType], ['Estimated', cvMoney(x.estValue)], ['Submitted', cvMoney(x.submittedValue)], ['Approved', cvMoney(x.approvedValue)]);
    if (kind === 'potential') kv.push(['Type', x.type], ['Estimated', cvMoney(x.estValue)], ['Contract Basis', x.basis], ['Probability', x.prob != null ? x.prob + '%' : '']);
    if (kind === 'eot') kv.push(['Period', [x.periodFrom, x.periodTo].filter(Boolean).join(' → ')], ['Days Claimed', x.daysClaimed], ['ER Assessment', x.erAssessment], ['Employer Granted', x.employerGranted]);
    const kvHtml = kv.filter(([, v]) => v != null && v !== '' && v !== '–').map(([k, v]) => `<div class="k">${k}</div><div>${v}</div>`).join('');
    const chron = (x.chronology || []).length ? `<div class="cv-sec">Chronology</div><ul class="cv-time">${x.chronology.map((c) => `<li><span class="d">${cvDate(c.date)}</span>${c.event}</li>`).join('')}</ul>` : '';
    const letters = (x.letters || []).length ? `<div class="cv-sec">Linked Letters</div><div class="cv-letters">${x.letters.map((l) => `<span class="lt">📄 <b>${l.ref}</b> — ${l.title} <span class="muted">${cvDate(l.date)}</span></span>`).join('')}</div>` : '';
    const action = (x.nextAction || x.recommendedAction) ? `<div class="cv-sec">${x.recommendedAction ? 'Recommended Action' : 'Next Action'}</div><div class="cv-desc">${x.recommendedAction || x.nextAction}${x.actionDue ? ` <span class="muted">· due ${x.actionDue}</span>` : ''}</div>` : '';
    host.innerHTML =
      `<div class="dref">${x.ref}${headVal ? ' · ' + headVal : ''}</div>
       <h4>${title}</h4>
       <div class="cv-badges">${cvBadge(x.status, cvStatusClass(x.status))}${cvBadge(x.priority, cvPriorityClass(x.priority))}</div>
       ${summary ? `<div class="cv-sec">Summary</div><div class="cv-desc">${summary}</div>` : ''}
       ${kvHtml ? `<div class="cv-sec">Details</div><div class="cv-kv">${kvHtml}</div>` : ''}
       ${chron}${letters}${action}`;
  }
```

- [ ] **Step 3:** `node --check public/js/app.js` → exit 0. Commit → `feat(claims): register tabs + shared detail panel (generic renderers)`.

---

## Task 5: Overview tab — KPIs + three charts

**Files:** Modify `public/js/app.js` (replace `renderClaimsOverview` stub).

**Interfaces — Consumes** `data.claimsRegister.kpis`, `makeChart`, `COL`, `cvMoney`, `cvKpiCard`, `cvStatusClass`.

- [ ] **Step 1: Replace the `renderClaimsOverview` stub** with:
```js
  const CV_KINDCOL = { claim: '#2f6fd0', variation: '#e0a52e', potential: '#1d8a63', eot: '#c0414b' };
  function renderClaimsOverview() {
    const cv = data.claimsRegister, k = cv.kpis, el = document.getElementById('cvtab-overview'); if (!el) return;
    el.innerHTML =
      `<div class="cv-kpis">
        ${cvKpiCard('Total Claims', k.claimsCount, cvMoney(k.claimsValue))}
        ${cvKpiCard('Variations Raised', k.variationsCount, cvMoney(k.variationsValue))}
        ${cvKpiCard('Potential Claims', k.potentialCount, cvMoney(k.potentialValue))}
        ${cvKpiCard('Approved / Determined', cvMoney(k.approvedValue))}
        ${cvKpiCard('EOT Claimed', (k.eotClaimedDays || 0).toLocaleString('en-US') + ' d', (k.eotGrantedDays || 0) + ' d granted')}
       </div>
       <div class="grid" style="grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
         <div class="card"><h3>Value by Status</h3><div id="cv-donut" class="chart" style="height:260px"></div></div>
         <div class="card"><h3>Probability vs Value <span class="muted" style="font-weight:600">· each claim/variation/potential</span></h3><div id="cv-scatter" class="chart" style="height:260px"></div>
           <div class="cv-scatter-leg"><span><i style="background:#2f6fd0"></i>Claim</span><span><i style="background:#e0a52e"></i>Variation</span><span><i style="background:#1d8a63"></i>Potential</span></div></div>
       </div>
       <div class="card"><h3>Commercial Exposure <span class="muted" style="font-weight:600">· NPR M by status</span></h3><div id="cv-expo" class="chart" style="height:${Math.max(160, Object.keys(k.byStatusValue).length * 34 + 40)}px"></div></div>`;

    // Donut — value by status
    const stEntries = Object.entries(k.byStatusValue).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    makeChart('cv-donut').setOption({
      tooltip: { trigger: 'item', formatter: (p) => `${p.name}<br/><b>${cvMoney(p.value)}</b> (${p.percent}%)` },
      legend: { type: 'scroll', bottom: 0, textStyle: { fontSize: 10, color: COL.muted } },
      series: [{ type: 'pie', radius: ['46%', '70%'], center: ['50%', '44%'], avoidLabelOverlap: true,
        label: { show: false }, data: stEntries.map(([n, v]) => ({ name: n, value: Math.round(v * 100) / 100 })) }],
    }, true);

    // Scatter — probability vs value
    const byKind = {};
    (k.scatter || []).forEach((s) => { (byKind[s.kind] = byKind[s.kind] || []).push([s.value, s.prob, s.ref]); });
    makeChart('cv-scatter').setOption({
      tooltip: { trigger: 'item', formatter: (p) => `<b>${p.data[2]}</b><br/>${cvMoney(p.data[0])} · ${p.data[1]}%` },
      grid: { left: 44, right: 16, top: 12, bottom: 34 },
      xAxis: { type: 'value', name: 'Value (NPR M)', nameLocation: 'middle', nameGap: 22, nameTextStyle: { fontSize: 10, color: COL.muted }, axisLabel: { fontSize: 10, color: COL.muted }, splitLine: { lineStyle: { color: COL.grid } } },
      yAxis: { type: 'value', name: 'Prob %', min: 0, max: 100, nameTextStyle: { fontSize: 10, color: COL.muted }, axisLabel: { fontSize: 10, color: COL.muted }, splitLine: { lineStyle: { color: COL.grid } } },
      series: Object.entries(byKind).map(([kind, pts]) => ({ type: 'scatter', symbolSize: 13, data: pts, itemStyle: { color: CV_KINDCOL[kind] || '#889', opacity: 0.85 } })),
    }, true);

    // Commercial exposure — horizontal bar by status
    makeChart('cv-expo').setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps) => `${ps[0].name}<br/><b>${cvMoney(ps[0].value)}</b>` },
      grid: { left: 130, right: 40, top: 8, bottom: 24 },
      xAxis: { type: 'value', axisLabel: { fontSize: 10, color: COL.muted }, splitLine: { lineStyle: { color: COL.grid } } },
      yAxis: { type: 'category', data: stEntries.map(([n]) => n).reverse(), axisLabel: { fontSize: 11, color: COL.muted } },
      series: [{ type: 'bar', barMaxWidth: 20, data: stEntries.map(([, v]) => Math.round(v * 100) / 100).reverse(),
        itemStyle: { color: COL.accent, borderRadius: [0, 3, 3, 0] }, label: { show: true, position: 'right', fontSize: 10, color: COL.muted, formatter: (p) => cvMoney(p.value) } }],
    }, true);
  }
```

- [ ] **Step 2:** `node --check public/js/app.js` → exit 0. Commit → `feat(claims): Overview tab — status donut, probability-vs-value scatter, exposure bar`.

> The controller now runs cloud-dev browser verification against a mock register workbook (all tabs, filters, detail panel, charts, tab-reveal resize, no console errors) before Task 6.

---

## Task 6: Mirror to TamakoshiTracker + retire old claims path

**Files:** Modify `public/TamakoshiTracker.html`, repo-root `TamakoshiTracker.html`; clean up `public/js/app.js` + `public/index.html`.

- [ ] **Step 1: Remove the retired old-claims code.** In `public/js/app.js` delete the now-unused `renderClaims` function, the `CLAIMS`/`normClaims` helpers, and any remaining `renderClaims()` reference (all replaced by `renderClaimsModule`). In `public/index.html` there is nothing else to remove (Task 3 replaced the `#claims` markup). `node --check public/js/app.js` → exit 0.

- [ ] **Step 2: Mirror into `public/TamakoshiTracker.html`.** Read the combined diff of Tasks 3–6 on `public/index.html`/`css/styles.css`/`js/app.js` (controller supplies the path). Apply the equivalent to TamakoshiTracker.html: the `#claims` markup, the `cv-*` CSS (into its inline `<style>`), and the whole claims module JS (config, `renderClaimsModule`, `renderRegisterTab`, `cvRenderDetail`, `renderClaimsOverview`, helpers), plus the `renderAll` `renderClaims()`→`renderClaimsModule()` swap and the old-claims removal. Do NOT change `API_BASE`. Locate sites with `grep -n 'id="claims"\|renderClaims\|CLAIMS\b\|renderClaims()' public/TamakoshiTracker.html`.

- [ ] **Step 3: Verify + refresh copy.**
```bash
node -e 'const fs=require("fs"),vm=require("vm");const h=fs.readFileSync("public/TamakoshiTracker.html","utf8");const re=/<script\b[^>]*>([\s\S]*?)<\/script>/gi;let m,bad=0,i=0;while((m=re.exec(h))){i++;if(!m[1].trim())continue;try{new vm.Script(m[1]);}catch(e){bad++;console.log(e.message);}}console.log("scripts",i,"errors",bad);'
```
→ `errors 0`. `grep -n "const API_BASE" public/TamakoshiTracker.html` → unchanged. `cp public/TamakoshiTracker.html ./TamakoshiTracker.html` then `diff -q public/TamakoshiTracker.html TamakoshiTracker.html` → identical.

- [ ] **Step 4: Commit** `public/js/app.js public/index.html public/TamakoshiTracker.html TamakoshiTracker.html` → `feat(claims): mirror Claims module to TamakoshiTracker; retire old claims path`.

---

## Self-Review

**Spec coverage:** 6 sheets/join → Task 1; Nutstore live isolated fetch + `payload.claimsRegister` → Task 2; sub-tab shell + CSS + no-data state → Task 3; four register tabs + KPIs + filters + shared detail panel (summary/chronology/details/letters/action) → Task 4; Overview KPIs + commercial-exposure bar + status donut + probability-vs-value scatter → Task 5; mirror + retire old path → Task 6; exclusions honoured (no management-attention, footer, instruction/event, notice-deadline anywhere). ✓

**Placeholder scan:** none — full code in every code step; verification scripts complete.

**Type consistency:** parser output keys (`claims/variations/potential/eot`, item fields, `kpis.{byStatusValue,scatter,…}`) are produced in Task 1 and consumed verbatim in Tasks 4–5; `CV` config field names match parser item fields; DOM ids (`cvtab-*`, `cv-<kind>-{search,status,body,detail}`, `cv-donut/scatter/expo`) consistent between Task 3 markup/wiring and Tasks 4–5 renderers; helpers (`cvMoney/cvDate/cvBadge/cvStatusClass/cvPriorityClass/cvKpiCard`) defined in Task 3/4 and reused. ✓
