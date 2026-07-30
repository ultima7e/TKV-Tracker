# Schedule Baseline + Monthly Progress — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins upload a *fixed* baseline XER and *monthly* progress XERs separately, so Gantt progress is always measured against a locked baseline (re-baselineable after EoT).

**Architecture:** A new KV slot `tkv:baseline` holds the fixed baseline's planned dates per Activity ID; the existing `tkv:schedule` slot holds the monthly progress schedule. `api/data.js` builds the working schedule (progress upload or Nutstore XER) then overlays baseline bars by Activity ID and appends baseline-only rows. The frontend gains "Upload Baseline" / "Upload Progress" buttons, a "Clear baseline" control, and a baseline badge; the "Reset" button is removed.

**Tech Stack:** Vanilla JS static frontend (dual: `public/index.html`+`js/app.js` and self-contained `public/TamakoshiTracker.html`), Node serverless (`api/*.js`), Upstash/Vercel KV (local JSON fallback in dev), P6 XER parsing (`lib/xer.js`).

## Global Constraints

- **Dual frontend, always mirrored:** every UI/JS change is made in BOTH `public/index.html`+`public/js/app.js` AND `public/TamakoshiTracker.html` (inline CSS+JS), then the Desktop copy is refreshed with `cp public/TamakoshiTracker.html ./TamakoshiTracker.html`.
- **Public GitHub repo:** never commit secrets or source Excel/XER data files; only code. (The sample XERs already in `data/` are pre-existing — do not add new ones.)
- **No unit-test framework:** verification is Node scripts (backend) and cloud-dev browser checks (frontend), matching this repo's established practice. Cloud-dev = `npm run dev:cloud` (loads `.env`), a temporary `.claude/launch.json` with `env.ADMIN_USER = "devverify"`, a token minted via `require('./lib/auth').signToken('devverify')` set into `localStorage.tkv_token`, then the Browser pane. Restore `launch.json` and stop the server when done.
- **KV keys:** `tkv:baseline` + `tkv:baseline_ver` (new), alongside existing `tkv:schedule` + `tkv:schedule_ver`.
- **Commits:** end each commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do not push mid-plan unless asked; the executor pushes at the end.

---

### Task 1: Backend — `api/schedule.js` gains a baseline slot

**Files:**
- Modify: `api/schedule.js`

**Interfaces:**
- Produces: `POST /api/schedule` accepts body `{ activities, relationships?, wbs?, name?, kind? }` where `kind` is `'progress'` (default) or `'baseline'`. `progress` → writes `tkv:schedule`/`tkv:schedule_ver` (unchanged shape `{activities,relationships,wbs}`). `baseline` → writes `tkv:baseline`/`tkv:baseline_ver` with blob `{ activities, wbs, name, uploadedAt }`. `DELETE /api/schedule?kind=baseline` clears `tkv:baseline`; `DELETE /api/schedule` (no kind / `kind=progress`) clears `tkv:schedule` as today.

- [ ] **Step 1: Replace the POST + DELETE branches with kind-aware logic**

In `api/schedule.js`, replace the current `if (req.method === 'POST') {...}` and `if (req.method === 'DELETE') {...}` blocks with:

```js
    if (req.method === 'POST') {
      const s = req.body || {};
      const kind = s.kind === 'baseline' ? 'baseline' : 'progress';
      if (!Array.isArray(s.activities) || !s.activities.length) {
        return res.status(400).json({ error: 'No activities in the uploaded schedule.' });
      }
      if (kind === 'baseline') {
        const blob = JSON.stringify({
          activities: s.activities, wbs: s.wbs || {},
          name: typeof s.name === 'string' ? s.name : '', uploadedAt: Date.now(),
        });
        await kvSet('tkv:baseline', blob);
        await kvSet('tkv:baseline_ver', String(Date.now()));
        return res.status(200).json({ ok: true, kind, activities: s.activities.length });
      }
      const blob = JSON.stringify({ activities: s.activities, relationships: s.relationships || [], wbs: s.wbs || {} });
      await kvSet('tkv:schedule', blob);
      await kvSet('tkv:schedule_ver', String(Date.now()));
      return res.status(200).json({ ok: true, kind, activities: s.activities.length });
    }

    if (req.method === 'DELETE') {
      const kind = (req.query && req.query.kind) === 'baseline' ? 'baseline' : 'progress';
      if (kind === 'baseline') {
        await kvDel('tkv:baseline');
        await kvDel('tkv:baseline_ver');
        return res.status(200).json({ ok: true, cleared: 'baseline' });
      }
      await kvDel('tkv:schedule');
      await kvDel('tkv:schedule_ver');
      return res.status(200).json({ ok: true, reverted: true });
    }
```

Also update the file's top comment to mention the two slots.

- [ ] **Step 2: Verify the handler writes/clears the baseline slot (Node)**

Create `scratch-verify-t1.js` in the scratchpad dir with:

```js
process.env.ADMIN_USER = 'devverify';
const auth = require('./lib/auth');
const store = require('./lib/store');
const handler = require('./api/schedule.js');
const token = auth.signToken('devverify');
const mkRes = () => { const r = { code: 0, body: null }; r.status = (c) => (r.code = c, r); r.json = (b) => (r.body = b, r); r.setHeader = () => {}; r.end = () => r; return r; };
(async () => {
  const acts = [{ id: 'A1', name: 'Act 1', wbsId: 'W1', isMilestone: false, start: '2025-01-01', finish: '2025-02-01' }];
  let res = mkRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer ' + token }, body: { activities: acts, wbs: { W1: { name: 'WBS 1' } }, name: 'base.xer', kind: 'baseline' } }, res);
  console.log('POST baseline ->', res.code, res.body);
  console.log('tkv:baseline stored ->', !!(await store.kvGet('tkv:baseline')));
  res = mkRes();
  await handler({ method: 'DELETE', headers: { authorization: 'Bearer ' + token }, query: { kind: 'baseline' } }, res);
  console.log('DELETE baseline ->', res.code, res.body);
  console.log('tkv:baseline after delete ->', await store.kvGet('tkv:baseline'));
})();
```

Run: `node scratch-verify-t1.js` (from repo root, pathing the requires to the repo — adjust the `require` roots to absolute repo paths).
Expected: `POST baseline -> 200 { ok:true, kind:'baseline', activities:1 }`, `tkv:baseline stored -> true`, `DELETE baseline -> 200 {...cleared:'baseline'}`, `tkv:baseline after delete -> null`.

- [ ] **Step 3: Confirm progress path is unaffected**

In the same script, POST with `kind` omitted and assert `res.body.kind === 'progress'` and `tkv:schedule` is written. Expected: `kind:'progress'`, stored true.

- [ ] **Step 4: Delete the scratch file and commit**

```bash
git add api/schedule.js
git commit -m "feat(schedule): baseline slot in schedule upload endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Backend — `api/data.js` overlays the fixed baseline

**Files:**
- Modify: `api/data.js` (add `applyBaselineOverlay`, read `tkv:baseline`/`tkv:baseline_ver`, add to signature, call after schedule is built in both buildPayload paths)

**Interfaces:**
- Consumes: `tkv:baseline` blob from Task 1 (`{ activities:[{id,name,wbsId,isMilestone,start,finish}], wbs, name, uploadedAt }`).
- Produces: `payload.schedule.activities[*].baselineStart/baselineFinish` overridden from the fixed baseline; baseline-only activities appended with `start:null,finish:null,pct:0`; `payload.schedule.baseline = { set, uploadedAt, name, count }`.

- [ ] **Step 1: Add the overlay function**

In `api/data.js`, directly after `applyScheduleOverride` (ends ~line 88, look for its closing `}` before the `applyScheduleOverride` schedule comment) add:

```js
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
        taskId: null, id: a.id, name: a.name, wbsId: a.wbsId,
        status: 'Not started', pct: 0, isMilestone: !!a.isMilestone,
        start: null, finish: null, actualStart: null, actualFinish: null,
        baselineStart: a.start || null, baselineFinish: a.finish || null,
        totalFloatDays: 0, critical: false,
      });
    }
    if (b.wbs) sched.wbs = { ...b.wbs, ...sched.wbs };
    sched.baseline = { set: true, uploadedAt: b.uploadedAt || null, name: b.name || '', count: acts.length };
  } catch (e) { if (payload.schedule) payload.schedule.baseline = { set: false }; }
  return payload;
}
```

- [ ] **Step 2: Read the baseline version marker (Nutstore path)**

In `buildPayload`, the Nutstore-path `Promise.all` currently destructures `[listing, xerInfo, delayXerInfo, claimsInfo, explInfo, insInfo, dbx, schedVer]` and ends with `kvGet('tkv:schedule_ver').catch(() => null),`. Add `baseVer` to the destructure and a matching read:

```js
    const [listing, xerInfo, delayXerInfo, claimsInfo, explInfo, insInfo, dbx, schedVer, baseVer] = await Promise.all([
      // …existing entries unchanged…
      kvGet('tkv:schedule_ver').catch(() => null),
      kvGet('tkv:baseline_ver').catch(() => null),
    ]);
```

Then add `base: baseVer || '',` to the `sig` object (next to `sched: schedVer || '',`).

- [ ] **Step 3: Call the overlay (Nutstore path)**

After `if (schedVer) await applyScheduleOverride(payload);` in the Nutstore path, add:

```js
    await applyBaselineOverlay(payload);
```

(No `if` guard — the function no-ops and sets `baseline.set=false` when the slot is empty.)

- [ ] **Step 4: Mirror the reads + call in the local-dev path**

In the local-dev path, after `const schedVer = await kvGet('tkv:schedule_ver').catch(() => null);` add:

```js
  const baseVer = await kvGet('tkv:baseline_ver').catch(() => null);
```

Add `base: baseVer || '',` to that path's `sig` object. After `if (schedVer) await applyScheduleOverride(payload);` add `await applyBaselineOverlay(payload);`.

- [ ] **Step 5: Verify the overlay (Node, local-dev path)**

Create `scratch-verify-t2.js` (requires from absolute repo paths):

```js
const store = require('./lib/store');
const data = require('./api/data.js');
(async () => {
  // Seed a baseline: override one existing activity's bars + one baseline-only row.
  const pre = await data.buildPayload();                 // local data/ XERs
  const sample = (pre.schedule.activities[0] || {}).id;  // an id present in the schedule
  await store.kvSet('tkv:baseline', JSON.stringify({
    activities: [
      { id: sample, name: 'X', wbsId: 'W', isMilestone: false, start: '2099-01-01', finish: '2099-02-01' },
      { id: '__BASE_ONLY__', name: 'Baseline only', wbsId: 'W', isMilestone: false, start: '2099-03-01', finish: '2099-04-01' },
    ], wbs: {}, name: 'b.xer', uploadedAt: 123,
  }));
  await store.kvSet('tkv:baseline_ver', 'v1');
  const p = await data.buildPayload();
  const hit = p.schedule.activities.find((a) => a.id === sample);
  const only = p.schedule.activities.find((a) => a.id === '__BASE_ONLY__');
  console.log('overridden baselineStart ->', hit && hit.baselineStart, '(expect 2099-01-01)');
  console.log('baseline-only row ->', only && only.baselineStart, only && only.start, '(expect 2099-03-01 null)');
  console.log('badge ->', p.schedule.baseline);
  await store.kvDel('tkv:baseline'); await store.kvDel('tkv:baseline_ver');
})();
```

Run: `node scratch-verify-t2.js`
Expected: overridden `baselineStart -> 2099-01-01`; baseline-only row `-> 2099-03-01 null`; badge `-> { set:true, uploadedAt:123, name:'b.xer', count:2 }`.

- [ ] **Step 6: Confirm no-baseline no-ops**

Re-run `node -e` calling `buildPayload()` with no baseline seeded; assert `payload.schedule.baseline.set === false` and activity count equals the plain schedule. Expected: `set:false`.

- [ ] **Step 7: Delete scratch files and commit**

```bash
git add api/data.js
git commit -m "feat(schedule): overlay fixed baseline onto the working schedule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — toolbar, upload/clear handlers, badge, baseline-only rendering (`public/index.html` + `public/js/app.js`)

**Files:**
- Modify: `public/index.html:182-184` (toolbar)
- Modify: `public/js/app.js` (`handleXerUpload`, new `clearBaseline`, badge render in `renderSchedule`, relax the activity filter/span/sort, wiring block ~1927-1934, remove `resetSchedule`)

**Interfaces:**
- Consumes: `data.schedule.baseline` (`{set,uploadedAt,name,count}`) from Task 2; `POST /api/schedule` with `kind` and `DELETE /api/schedule?kind=baseline` from Task 1.
- Produces: two file inputs (`#sch-upload-base`, `#sch-upload-prog`), a `#sch-clear-base` button, and a `#sch-baseline-badge` span.

- [ ] **Step 1: Replace the toolbar admin tools markup**

In `public/index.html`, replace lines 182-184 (`<span id="sch-admin-tools" …>` … `</span>` including the Upload XER label and Reset button) with:

```html
            <span id="sch-admin-tools" style="display:none">
              <label class="sch-toggle" style="cursor:pointer" title="Upload the FIXED baseline (re-upload to re-baseline after EoT)">⬆ Upload Baseline<input type="file" id="sch-upload-base" accept=".xer" style="display:none"></label>
              <label class="sch-toggle" style="cursor:pointer" title="Upload the latest monthly progressed XER">⬆ Upload Progress<input type="file" id="sch-upload-prog" accept=".xer" style="display:none"></label>
              <button id="sch-clear-base" class="sch-toggle" title="Remove the fixed baseline (confirm)">Clear baseline</button>
              <span id="sch-baseline-badge" class="muted" style="font-weight:600;font-size:11.5px"></span>
            </span>
```

- [ ] **Step 2: Generalise `handleXerUpload` to take a `kind`**

Replace `function handleXerUpload(file) {` (line 978) signature and its POST body. The new version:

```js
  function handleXerUpload(file, kind) {
    const reader = new FileReader();
    reader.onload = async () => {
      let parsed;
      try {
        parsed = parseXerClient(reader.result);
        if (!parsed.activities.length) { alert('No activities (TASK table) found in this XER file.'); return; }
      } catch (err) { alert('Could not read this XER file: ' + err.message); return; }
      const src = $('#sch-src');
      if (kind === 'progress') {           // show immediately, then persist
        data = data || {}; data.schedule = parsed; schedBuiltFor = null; renderSchedule();
      }
      if (src) src.textContent = '· uploaded: ' + file.name + ' (saving…)';
      try {
        const body = kind === 'baseline'
          ? { kind: 'baseline', name: file.name, wbs: parsed.wbs,
              activities: parsed.activities.map((a) => ({ id: a.id, name: a.name, wbsId: a.wbsId, isMilestone: a.isMilestone, start: a.start, finish: a.finish })) }
          : { kind: 'progress', activities: parsed.activities, relationships: parsed.relationships, wbs: parsed.wbs };
        const r = await authFetch('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        if (src) src.textContent = '· uploaded: ' + file.name + ' (saved)';
        await load();                      // re-fetch so the baseline overlay applies
      } catch (err) {
        if (src) src.textContent = '· uploaded: ' + file.name + ' — NOT saved';
        alert('The schedule was not saved: ' + err.message);
      }
    };
    reader.readAsText(file);
  }
```

- [ ] **Step 3: Replace `resetSchedule` with `clearBaseline`**

Replace the whole `async function resetSchedule() { … }` (lines 1008-~1018) with:

```js
  async function clearBaseline() {
    if (!confirm('Remove the fixed baseline? Monthly progress uploads are not affected. You can upload a new baseline afterwards.')) return;
    try {
      const r = await authFetch('/api/schedule?kind=baseline', { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      await load();
    } catch (err) { alert('Could not clear the baseline: ' + err.message); }
  }
```

- [ ] **Step 4: Relax the activity filter, span, and sort for baseline-only rows**

In `renderSchedule`, replace line 1024 `const acts = all.filter((a) => a.start && a.finish);` with:

```js
    const hasBar = (a) => (a.start && a.finish) || (a.baselineStart && a.baselineFinish);
    const acts = all.filter(hasBar);
```

Replace the sort (line 1045) `arr.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (a.id < b.id ? -1 : 1)))` with a null-safe key:

```js
    Object.values(actsByWbs).forEach((arr) => arr.sort((a, b) => {
      const ka = a.start || a.baselineStart || '', kb = b.start || b.baselineStart || '';
      return ka < kb ? -1 : ka > kb ? 1 : (a.id < b.id ? -1 : 1);
    }));
```

Replace the span computation (lines 1048-1049) so baseline dates count:

```js
    const dayOf = (a) => [a.start, a.finish, a.baselineStart, a.baselineFinish].filter(Boolean).map(schDay);
    const allDays = acts.flatMap(dayOf);
    const minDay = Math.min(...allDays);
    const maxDay = Math.max(...allDays);
```

Also guard the current-bar drawing so baseline-only rows (null `start`/`finish`) render **only** the baseline bar. In the `rows.map(...)` bar builder, immediately after the `const base = (a.baselineStart && a.baselineFinish) ? … : '';` assignment (~line 1129) and BEFORE the `if (a.isMilestone) …` line, insert:

```js
        if (!a.start || !a.finish) return base; // baseline-only row: baseline bar only, no current bar
```

This returns before the milestone/`g-bar` templates call `schDay(a.start)` (which would be `NaN` for a null start). The baseline-bar template itself is already guarded by `a.baselineStart && a.baselineFinish`.

- [ ] **Step 5: Render the baseline badge**

In `renderSchedule`, right after `$('#sch-count').textContent = acts.length;` (line 1027) add:

```js
    const bl = (data.schedule && data.schedule.baseline) || { set: false };
    const badge = document.getElementById('sch-baseline-badge');
    if (badge) badge.textContent = bl.set
      ? '· baseline set' + (bl.uploadedAt ? ' ' + new Date(bl.uploadedAt).toLocaleDateString() : '') + ' (' + bl.count + ' acts)'
      : '· no baseline set';
    const clr = document.getElementById('sch-clear-base');
    if (clr) clr.style.display = bl.set ? '' : 'none';
```

- [ ] **Step 6: Rewire the toolbar events**

Replace the wiring block (lines 1927-1934: the `sch-upload` change listener + `sch-reset` listener) with:

```js
  const baseInput = document.getElementById('sch-upload-base');
  if (baseInput) baseInput.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) handleXerUpload(f, 'baseline'); e.target.value = ''; });
  const progInput = document.getElementById('sch-upload-prog');
  if (progInput) progInput.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) handleXerUpload(f, 'progress'); e.target.value = ''; });
  const clearBaseBtn = document.getElementById('sch-clear-base');
  if (clearBaseBtn) clearBaseBtn.addEventListener('click', clearBaseline);
```

- [ ] **Step 7: Syntax check**

Run: `node --check public/js/app.js`
Expected: no output (exit 0). Also `grep -n "resetSchedule\|sch-reset\|sch-upload\b" public/js/app.js public/index.html` → no matches (old refs gone).

- [ ] **Step 8: Cloud-dev browser verification**

Set up cloud-dev (temporary `launch.json` with `ADMIN_USER=devverify`, mint token, `preview_start`, set `localStorage.tkv_token`, reload). Then on the Schedule tab:
1. Click **Upload Baseline**, choose `data/TKV-BL-A.xer` → badge shows "baseline set … (N acts)"; Gantt BL Start/Finish columns populate; no console errors.
2. Click **Upload Progress**, choose `data/TKV-BL-A-2 (TIA-Bishan).xer` → % and Act bars update; baseline bars unchanged.
3. Click **Clear baseline**, confirm → badge shows "no baseline set"; Clear button hides.
Use `read_console_messages onlyErrors:true` (expect none) and a `read_page`/screenshot to confirm. Restore `launch.json`, stop the server.

- [ ] **Step 9: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(schedule): baseline/progress uploads, clear-baseline, badge, baseline-only rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Mirror to `public/TamakoshiTracker.html` + refresh Desktop copy + end-to-end verify

**Files:**
- Modify: `public/TamakoshiTracker.html` (toolbar markup + inline JS: same changes as Task 3)
- Modify: `TamakoshiTracker.html` (repo-root Desktop mirror — via `cp`)

**Interfaces:**
- Consumes: identical to Task 3; TamakoshiTracker hardcodes `API_BASE='https://tkv-tracker.vercel.app'` — leave that untouched.

- [ ] **Step 1: Mirror the toolbar markup**

Apply the Step-1 markup change from Task 3 to the corresponding `#sch-admin-tools` block in `public/TamakoshiTracker.html` (find with `grep -n "sch-admin-tools\|Upload XER\|sch-reset" public/TamakoshiTracker.html`).

- [ ] **Step 2: Mirror the JS changes**

Apply Task 3 Steps 2-6 (the `handleXerUpload(file, kind)` rewrite, `clearBaseline` replacing `resetSchedule`, the filter/sort/span relaxation, the badge render, and the toolbar wiring) to the inline `<script>` in `public/TamakoshiTracker.html`. The function/variable names and code are identical; locate each with `grep -n "handleXerUpload\|resetSchedule\|const acts = all.filter\|sch-upload\|sch-reset\|sch-count').textContent" public/TamakoshiTracker.html`.

- [ ] **Step 3: Syntax check the inline scripts**

Run:
```bash
node -e 'const fs=require("fs"),vm=require("vm");const h=fs.readFileSync("public/TamakoshiTracker.html","utf8");const re=/<script\b[^>]*>([\s\S]*?)<\/script>/gi;let m,bad=0,i=0;while((m=re.exec(h))){i++;if(!m[1].trim())continue;try{new vm.Script(m[1]);}catch(e){bad++;console.log("script#"+i,e.message);}}console.log("scripts",i,"errors",bad);'
```
Expected: `errors 0`. Also `grep -n "resetSchedule\|sch-reset\|sch-upload\b" public/TamakoshiTracker.html` → no matches.

- [ ] **Step 4: Refresh the Desktop mirror**

Run: `cp public/TamakoshiTracker.html ./TamakoshiTracker.html`

- [ ] **Step 5: End-to-end cloud-dev verification (both frontends)**

Repeat Task 3 Step 8 against `http://localhost:3000/` (index.html) AND `http://localhost:3000/TamakoshiTracker.html`, confirming: baseline upload → badge + BL bars; progress upload → %/Act bars, baseline unchanged; clear baseline → reverts. `read_console_messages onlyErrors:true` → none on both. Restore `launch.json`, stop the server.

- [ ] **Step 6: Commit**

```bash
git add public/TamakoshiTracker.html TamakoshiTracker.html
git commit -m "feat(schedule): mirror baseline/progress upload UI to TamakoshiTracker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the executor

- The two sample XERs in `data/` are convenient upload fixtures for browser verification; they are P6 exports with the fields the parser expects.
- If `authFetch`/`load` names differ at execution time, grep for the existing definitions in `app.js` and use whatever the current progress upload already calls — do not invent new fetch helpers.
- Keep `API_BASE` in `TamakoshiTracker.html` exactly as-is.
