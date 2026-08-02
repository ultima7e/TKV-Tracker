# Claims & Variations Panel — full contract-management module

**Date:** 2026-08-02
**Scope:** Rebuild the Claims & Variations panel (`#claims` section) as a five-tab
module (Overview · Claims · Variations · Potential Claims · EOT), live from a
single Nutstore/Dropbox workbook.

## Context

Today the Claims & Variations panel is a curated snapshot: `parseClaims()` in
`lib/parsers.js` reads a `Claim Summary` + `Variation` sheet from the "Claim &
Variation Log" workbook and produces basic claim/EOT/variation rows;
`renderClaims()` in the two frontends draws a simple table with a built-in
`CLAIMS` fallback. This module replaces that panel with a far richer,
data-driven contract-management view modelled on the user's mockups.

Established patterns to follow: isolated-workbook parse (`workbookSheets(buffer,
[sheetNames])`) + live fetch in `api/data.js` (as with `insurance`,
`explosives`, `fuel`); dual synced frontends (`public/index.html` + external
`css/styles.css` + `js/app.js`, and the self-contained
`public/TamakoshiTracker.html` with inline CSS+JS and
`API_BASE='https://tkv-tracker.vercel.app'`); the repo-root `TamakoshiTracker.html`
is a byte-copy. Sub-tab bars reuse `.sched-tabs`/`.sched-tab`/`.stab-pane`.

## Excluded (per the user's marked-up mockups)

- Overview "Management Attention" alert panel.
- Overview footer: Quick Links / Correspondence Summary / Document Repository.
- Variation detail "Instruction / Event" metadata block.
- Potential-Claims "Notice Deadline / Days Remaining / Owner" columns and the
  notice-countdown detail block.

These are live-workflow features (deadlines, owners, document-system hooks) that
a static workbook won't maintain. Not built, not designed further.

## Data model — workbook `Claims & Variations Register.xlsx` (6 sheets)

Hosted on Nutstore (default path
`Shared Folder/Claims & Variation/Claims & Variations Register.xlsx`; a Dropbox
dl=1 link works too). Fetched live and parsed in ISOLATION (only these sheet
names) so it never merges into the finance matrices. Columns are located by
header text (row 0), tolerant of ordering. Dates may be Excel serials or ISO
strings. Money is NPR (millions or absolute — parser normalises). Probability %
and Priority are OPTIONAL (charts degrade gracefully when blank).

1. **`Claims`** — `Ref No · Claim Title · Contractual Basis · SoC Ref · Work Area ·
   Claimed Value (NPR) · EOT Days · Probability % · Priority · Status ·
   Submitted On · Submitted By · Next Action · Action Due · Summary`
2. **`Variations`** — `Var Ref · Title · Instruction Type · Estimated Value (NPR) ·
   Submitted Value (NPR) · Approved Value (NPR) · Probability % · Priority ·
   Status · Next Action · Action Due · Description`
3. **`PotentialClaims`** — `Event Ref · Potential Matter · Type · Estimated Value (NPR) ·
   Probability % · Priority · Status · Contract Basis · Event Summary ·
   Recommended Action`
4. **`EOT`** — `EOT Ref · Delay Event/Cause · Period From · Period To · Days Claimed ·
   ER Assessment · Employer Granted · Status · Next Action · Executive Summary ·
   Recommended Action`
5. **`Chronology`** — `Ref No · Date · Event` (many rows per item; `Ref No` links
   to any register item's ref).
6. **`Letters`** — `Ref No · Letter Ref · Title · Date` (linked letters per item).

A register item's detail panel = its own row + every `Chronology`/`Letters` row
whose `Ref No` equals the item's ref (case-insensitive, trimmed).

## Parser — `parseClaimsRegister(matrices)` in `lib/parsers.js`

Returns:
```
{
  claims:    [ { ref, title, basis, socRef, workArea, value, eotDays, prob, priority,
                 status, submittedOn, submittedBy, nextAction, actionDue, summary,
                 chronology:[{date,event}], letters:[{ref,title,date}] }, … ],
  variations:[ { ref, title, instrType, estValue, submittedValue, approvedValue, prob,
                 priority, status, nextAction, actionDue, description, chronology, letters }, … ],
  potential: [ { ref, matter, type, estValue, prob, priority, status, basis,
                 summary, recommendedAction, chronology, letters }, … ],
  eot:       [ { ref, cause, periodFrom, periodTo, daysClaimed, erAssessment,
                 employerGranted, status, nextAction, summary, recommendedAction,
                 chronology, letters }, … ],
  kpis: {            // computed for the Overview + tab headers
    claimsCount, claimsValue, variationsCount, variationsValue,
    potentialCount, potentialValue, eotClaimedDays, eotGrantedDays,
    approvedValue, underReviewValue, byStatusValue: {status: value},
    scatter: [ {ref, value, prob, kind} ]   // kind ∈ claim|variation|potential|eot
  },
  warnings: []
}
```
Status strings are passed through verbatim (the sheet is authoritative); a small
`statusClass(status)` helper in the frontend maps them to badge colours.
`chronology`/`letters` are joined by `Ref No`. Absent optional sheets → empty
arrays, never a throw.

## Backend — `api/data.js`

- `CLAIMS_REGISTER_XLSX_PATH` constant (Nutstore) OR a Dropbox URL constant.
- `claimsRegisterFromBuffer(buffer)`: `workbookSheets(buffer, ['Claims',
  'Variations','PotentialClaims','EOT','Chronology','Letters'])` →
  `parseClaimsRegister(matrices)`; degrade to `{missing:true, warnings}` on error.
- Fetch it (Nutstore PROPFIND+GET like insurance, or `dbxFetch` like fuel) in
  BOTH buildPayload paths, add its mtime/etag to the `sig`, and set
  `payload.claimsRegister = claimsRegisterFromBuffer(buffer)`.
- The existing `payload.claims` (old parser) stays until the frontend is switched
  over, then is removed in the same change.

## Frontend (both frontends + `js/app.js`)

Rebuild the `#claims` section:
- **Sub-tab bar** (`.sched-tabs`): Overview · Claims · Variations · Potential
  Claims · EOT, each a `.stab-pane`. Wire once (scoped `#claims .sched-tab`).
- **Overview pane:** KPI cards (Total Claims, Variations Raised, Potential
  Claims, Approved/Determined value, EOT Claimed days, plus totals); a
  **Commercial-Exposure horizontal bar** (value by status bucket); a **status
  donut** (value by status); a **Probability-vs-Value scatter** (each item at
  x=value, y=prob, colour by kind) — all from `kpis`. A compact "top items"
  table linking into the register tabs.
- **Register panes (Claims/Variations/Potential/EOT):** KPI cards for that
  register; a search box + Status filter (+ a type/work-area filter where
  relevant); a table of rows; clicking a row opens the **detail side-panel**.
- **Detail side-panel** (shared component): header (ref, title, status badge,
  priority badge, headline value); a single scrollable body with sections —
  Summary/Executive Summary, Chronology timeline (from `chronology`), key
  details (SoC/commercial/time-impact per tab), Linked Letters (from `letters`),
  and Next/Recommended Action. No Correspondence/Documents sub-tabs (excluded).
- Charts use ECharts (`makeChart`); the scatter degrades to points with prob=0
  hidden if probability is blank. Reuse `.expl-*`/`.stab-pane` styling; add only
  the minimal new CSS the detail panel/scatter need.
- `renderClaims()` is replaced by `renderClaimsModule()` driven by
  `data.claimsRegister`; falls back to a "no data yet" message when missing.
- Chart resize on tab reveal (like the Fuel fix): resize the active pane's
  charts after it becomes visible.
- Mirror all markup + JS to `TamakoshiTracker.html`; refresh the Desktop copy.

## Deliverables produced during design (prep)

- A ready-to-fill **`Claims & Variations Register.xlsx` template** (6 sheets,
  headers, one example row each, a legend) sent to the user — NOT committed
  (public repo; data files stay out).

## Out of scope

- The excluded sections above.
- Editing/upload of claims data (read-only live source).
- The old `parseClaims`/`Claim & Variation Log` path is retired once this lands.

## Verification (cloud-dev)

- Build a schema-conformant mock workbook; confirm each register tab lists its
  rows, KPIs total correctly, filters/search work, and a row opens the detail
  panel with the right chronology + letters.
- Overview charts render (bar/donut/scatter) and reconcile with the register
  totals.
- Chart resizes correctly when a tab is first revealed.
- Excluded sections absent.
- No console errors; both frontends (TamakoshiTracker via a local-`API_BASE`
  temp copy).
