# Fuel Consumption Tab (Inventory & Explosives panel)

**Date:** 2026-07-31
**Scope:** A new "Fuel" sub-tab in the Inventory & Explosives panel showing monthly fuel usage by equipment category.

## Context

The Inventory & Explosives panel (`#inv` section) is currently a single scroll of
cards: an **Explosive Consumption** chart (`#expl-chart`, litres by site/month with
filter chips) plus summary cards. That chart is driven by `parseExplosives()` in
`lib/parsers.js`, fetched as an isolated Nutstore workbook via
`explosivesFromBuffer()` in `api/data.js` (using `workbookSheets(buffer, [names])`
so its sheets never merge into the finance matrices), and rendered by
`renderExplosives()` / `drawExplChart()` in the frontends.

The dashboard has two synced frontends that must stay identical:
`public/index.html` (external `css/styles.css` + `js/app.js`) and the
self-contained `public/TamakoshiTracker.html` (inline CSS+JS,
`API_BASE='https://tkv-tracker.vercel.app'`). The repo-root `TamakoshiTracker.html`
is a byte-copy of the public one.

## Goal

Add a **Fuel** tab so head management can see, at a glance, how much fuel each
equipment category (Generator, Dump Truck, Loader, Excavator/Backhoe, …) consumed
per month — a stacked monthly bar chart, live from a Dropbox-hosted workbook that
updates when the file is replaced.

## Data source

- Workbook: `Fuel_Consumption_EN_Categorized.xlsx`, hosted on Dropbox:
  `https://www.dropbox.com/scl/fi/sd47gb80i8857yeq2n8j2/Fuel_Consumption_EN_Categorized.xlsx?rlkey=wx53urwmerfralt5dwhj4mz4f&dl=1`
- The relevant sheet is **`Appended_Table`** (10,230 data rows): columns located by
  header name — `Fueling Date` (datetime/serial), `Fuel Amount (L)` (number),
  `Category` (string). Other columns (equipment no., price, amount, issued-by,
  remarks) are ignored for v1.
- Fetched live from Dropbox (like the Earned Value workbook) but **parsed in
  isolation** — its sheets must NOT merge into the finance matrices. Its Dropbox
  ETag is folded into the payload cache signature so replacing the file updates
  the dashboard.

## Parser — `parseFuel(matrices)` in `lib/parsers.js`

- Read `matrices['Appended_Table']`. If absent, return `{ missing: true, warnings }`.
- Locate columns by header text on row 0 (case/space-insensitive contains):
  `Fueling Date` → dateCol, `Fuel Amount (L)` → liCol, `Category` → catCol.
- For each data row: convert the date (datetime or Excel serial) to `YYYY-MM`;
  read litres (number, skip if 0/blank); read category (trim; blank → `"Other"`).
- Aggregate litres by month × category.
- Return:
  ```
  {
    months: ['2024-03', …],                      // sorted asc
    categories: [{ name, total }, …],            // sorted by total desc
    byMonth: { '2024-03': { 'Generator': 1234.5, … }, … },
    grandTotal: <number>,
    warnings: []
  }
  ```
  Litres rounded to 1 dp. `categories` order drives stack order, colour, and legend.

## Backend — `api/data.js`

- Constant `FUEL_DBX_URL` (the dl=1 link above). Do NOT add it to `DROPBOX_SOURCES`
  (that list merges into the finance pool) — fetch it separately.
- `fuelFromBuffer(buffer)`: `workbookSheets(buffer, ['Appended_Table'])` →
  `parseFuel(matrices)`; return `{ missing: true }`/empty on any error so one bad
  fetch never blanks the dashboard.
- In `buildPayload()` (both the Nutstore and local-dev paths): fetch the fuel
  buffer in parallel via `dbxFetch(FUEL_DBX_URL)` (reuses the existing etag cache),
  add its etag to the `sig` object (`fuel: <etag>`), and pass the buffer into
  `assemble(...)`.
- `assemble(...)` gains a `fuelBuffer` parameter and sets
  `payload.fuel = fuelFromBuffer(fuelBuffer)`.

## Frontend (both `public/index.html` + `public/TamakoshiTracker.html` + `js/app.js`)

- **Sub-tab bar** at the top of `#inv`: two buttons — **Explosives** (active) and
  **Fuel** — plus two panes: the existing cards wrapped in an "Explosives" pane and
  a new hidden "Fuel" pane. Toggling shows/hides panes (same mechanism as the
  Schedule tab's sub-tabs). Wire once.
- **Fuel pane** (`#inv-fuel`):
  - a **summary line** (`#fuel-summary`) — total litres, month range, top category;
  - **category filter chips** (`#fuel-cats`, All/None) + **From/To month** selects
    — reusing the existing `.expl-controls` / `.expl-loc-wrap` / chip styling (no
    new CSS);
  - the **stacked bar chart** (`#fuel-chart`, height ~360px): ECharts stacked bar,
    x-axis = months in range, one stacked series per **selected** category (colour
    from a fixed palette keyed by category order), tooltip (trigger axis) listing
    each category's litres for that month + the month total.
- `fuelState = { cats: Set, from, to }`; `renderFuel()` (populate chips/month
  selects, summary), `drawFuelChart()` (build stacked series from `byMonth`),
  wired in `renderFuel` / the tab switch — mirroring `renderExplosives` /
  `drawExplChart` / `explState`.
- `renderFuel()` is called from `renderAll()`; the chart (re)draws when the Fuel
  tab is shown (ECharts needs a visible container to size correctly).
- Mirror all markup + JS to `TamakoshiTracker.html`; refresh the Desktop copy.

## Out of scope

- NPR cost view (litres only for v1).
- Powerhouse vs Headworks site split (`Appended_Table` has no site column; the two
  per-site sheets could feed a site filter later).
- Editing/upload of fuel data (it's a read-only live source).

## Verification (cloud-dev)

- Fuel tab shows stacked monthly bars, one colour per category; totals match the
  workbook's `Category Summary` grand total (~1,336,456 L across all months).
- Category chips toggle series live; From/To month narrows the x-axis.
- Tooltip lists per-category litres + month total.
- Switching Explosives ↔ Fuel works; Explosives tab unchanged.
- No console errors; verified on both frontends (TamakoshiTracker via a
  local-API_BASE temp copy, since it hardcodes the production API).
