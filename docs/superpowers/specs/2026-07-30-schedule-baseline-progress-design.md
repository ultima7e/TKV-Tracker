# Schedule Panel — Fixed Baseline + Monthly Progress

**Date:** 2026-07-30
**Scope:** Schedule & Progress tab (Gantt) only.

## Context

The Schedule tab renders a Gantt from a single P6 XER. Today one uploaded XER
carries everything: baseline dates (`target_start/end_date` → `baselineStart`/
`baselineFinish`), current/actual dates (`start`/`finish`), and `pct`
(`phys_complete_pct`). The client (`handleXerUpload` → `parseXerClient`) parses
the XER and POSTs `{ activities, relationships, wbs }` to `api/schedule.js`,
which stores it in KV `tkv:schedule` (+ `tkv:schedule_ver`). `api/data.js`
(`applyScheduleOverride`) serves that override when present, otherwise the
Nutstore baseline XER.

The Executive S-curve (from the `M-S-C-DATA` Excel sheet) and the Delay &
Disruption tab (TIA XER) are independent and out of scope.

## Goal

Decouple a **fixed baseline** from **monthly progress** so progress is always
measured against a locked plan, and support re-baselining after an EoT. Monthly
progressed XER uploads must update progress **without** disturbing the baseline.

## Requirements

1. Admin can upload a **fixed baseline** XER ("Upload Baseline"). Stored
   separately; never altered by progress uploads.
2. Admin can upload a **monthly progress** XER ("Upload Progress" — the existing
   "Upload XER", renamed). Supplies actual dates + % complete.
3. The Gantt shows **baseline bars from the fixed baseline** and **current/actual
   bars + % from the latest monthly file**, joined by Activity ID.
4. Re-baselining (post-EoT) = uploading a new baseline, which overwrites the
   fixed slot.
5. Activities present in the baseline but not yet in the monthly file are listed
   as **baseline-only rows at 0%**.
6. `%` and actual dates come **straight from the monthly XER** (P6's own
   `phys_complete_pct` + actual dates); the dashboard does not recompute them.
   The baseline supplies the planned bars and drives the existing
   baseline-vs-actual display.
7. **No generic "Reset" button** — uploads overwrite their own slot, which
   covers correcting mistakes. A confirm-guarded **"Clear baseline"** removes the
   fixed baseline for a deliberate fresh start.

## Data model (KV)

- **`tkv:baseline`** (new, fixed) — JSON
  `{ activities: [{ id, name, wbsId, isMilestone, start, finish }], wbs: {…}, name, uploadedAt }`.
  Captures the baseline XER's planned dates + WBS. Merge key = `id`. Full
  activity records (not just a date map) are stored so baseline-only rows
  (req 5) can render name/WBS/milestone. `tkv:baseline_ver` = timestamp marker,
  included in the payload signature so a re-baseline busts the cache.
- **`tkv:schedule`** (unchanged) — the monthly progress schedule
  `{ activities, relationships, wbs }`.

## Backend

**`api/schedule.js`** — POST/DELETE gain a `kind` selector:
- `kind: 'progress'` (default) → `tkv:schedule`, current behaviour.
- `kind: 'baseline'` → `tkv:baseline`; body `{ activities, wbs, name }`.
- Bump the matching `_ver` marker on write; clear it on delete. Stays
  admin-gated with the same error handling.

**`api/data.js`** — read `tkv:baseline` + `tkv:baseline_ver` in parallel with
the schedule reads; add `baseline_ver` to the payload signature. New
`applyBaselineOverlay(payload)` runs *after* the working schedule is built
(whether from `tkv:schedule` or the Nutstore XER):
1. Index baseline activities by `id`.
2. For each schedule activity, set `baselineStart`/`baselineFinish` from the
   matching baseline activity's `start`/`finish` (overriding the file's own
   target dates).
3. Append baseline activities absent from the schedule as baseline-only rows:
   `{ id, name, wbsId, isMilestone, baselineStart, baselineFinish, start:null, finish:null, pct:0 }`;
   merge their WBS entries so grouping works.
4. Set `payload.schedule.baseline = { set:true, uploadedAt, name, count }` for
   the UI badge. If no baseline slot exists, leave the schedule as today with
   `baseline.set = false`.

## Frontend (both `public/index.html` and `public/TamakoshiTracker.html` + `js/app.js`)

- **Toolbar** (`#sch-admin-tools`): replace "Upload XER" with **"Upload
  Baseline"** and **"Upload Progress"** file buttons; **remove the "Reset"
  button**; add a discreet, confirm-guarded **"Clear baseline"** and a
  **baseline badge** ("Baseline set · <date>" / "No baseline").
- **`handleXerUpload(file, kind)`** — reuse `parseXerClient`. `progress` behaves
  as today (POST `{ activities, relationships, wbs, kind:'progress' }`).
  `baseline` POSTs `{ activities:[{id,name,wbsId,isMilestone,start,finish}], wbs, name:file.name, kind:'baseline' }`,
  then reloads so the overlay applies. Optimistic status shown in `#sch-src`.
- **`clearBaseline()`** — confirm → `DELETE /api/schedule?kind=baseline` → reload.
- **Rendering** — the Gantt already draws a "Baseline" bar from
  `baselineStart`/`baselineFinish`; it is now fed by the fixed baseline.
  Baseline-only rows render a baseline bar at 0% (null current dates already
  tolerated — verify). No new chart code expected.
- Mirror all markup + JS to `TamakoshiTracker.html`; refresh the Desktop copy.

## Out of scope

- Executive S-curve (separate Excel source).
- Delay & Disruption / TIA XER.
- Variance analytics beyond the existing baseline-vs-actual bar rendering.

## Verification (cloud-dev)

- Upload a baseline XER → badge shows "set"; Gantt baseline bars reflect it.
- Upload a monthly progress XER → % and actual bars update; baseline bars
  unchanged.
- Re-upload a different baseline → baseline bars change; progress untouched.
- Clear baseline → reverts to each file's own target dates; badge shows "none".
- A baseline activity missing from the monthly file appears at 0%.
- No console errors; verified on both frontends.
