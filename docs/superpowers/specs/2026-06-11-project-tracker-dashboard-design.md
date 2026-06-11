# Tamakoshi-V Project Tracker Dashboard — Design Spec

**Date:** 2026-06-11
**Status:** Approved direction; data mapping pending receipt of real Excel workbook(s).

## 1. What we're building

An interactive web dashboard for the Tamakoshi-V Hydroelectric Project (Lot-1) that visualizes
project tracking data — progress, financial, tunnel, claims, inventory, manpower, equipment,
and safety — sourced from Excel files the user maintains in **Nutstore** cloud storage.

A **Refresh button** on the page pulls the latest Excel from Nutstore and re-renders every
chart and KPI without redeploying the site.

**Audience:** a small team viewing via a shared link.

## 2. Architecture (decided)

- **Static front end** — HTML/CSS/JS dashboard, no framework build step required.
- **One serverless function** (`/api/data`) hosted with the site on **Vercel (free tier)**.
  It authenticates to Nutstore over **WebDAV** (`https://dav.jianguoyun.com/dav/`) using an
  app password stored as a **Vercel environment variable** (never in the page, never in chat),
  downloads the `.xlsx`, and returns parsed JSON to the browser.
- **No dedicated/always-on server.** The function runs on demand only.
- Data file stays **private** in Nutstore (no public share links).

### Data flow

```
[Browser dashboard] --Refresh--> [Vercel function /api/data] --WebDAV + secret--> [Nutstore .xlsx]
        ^                                                                              |
        |________________________ parsed JSON returned ________________________________|
```

### Why this shape
- Browser cannot fetch Nutstore WebDAV directly (CORS + credentials would leak).
- Serverless keeps cost at zero and maintenance near zero for small-team usage.
- Parsing server-side (SheetJS in the function) sends the browser clean JSON.

## 3. UI design (decided — "Sample 1")

Reference mockup: `mockup/dashboard-preview.html` (keep as visual reference).

- **Theme:** light corporate; navy sidebar/header (`#0f2a4a` family), white cards,
  blue/teal/green/amber/red accent palette.
- **Layout:** fixed left sidebar with 9 nav items; topbar with project title, date,
  and Refresh button; content area swaps one panel (view) at a time with fade transition.
- **Panels (9):** Executive Summary, Financial, Schedule & Progress, Tunnel,
  Claims & Variations, Inventory & Explosives, Manpower, Equipment, Safety.
- **Widgets:** animated KPI count-up cards, status ring ("ON TRACK"), ECharts charts
  (S-curve line, donuts, bar charts, heat-map for safety risk matrix), progress bars,
  color-coded highlight/alert lists, data tables where appropriate.
- **Animations:** number count-ups, progress-bar fills, panel fade-in, Refresh spinner.
- **Refresh UX:** spinner state while fetching; success updates "last refresh" stamp;
  failure shows a non-blocking error banner ("couldn't reach Nutstore — showing last data").

## 4. Libraries

| Purpose | Library |
|---|---|
| Charts | ECharts 5 (CDN) |
| Excel parsing | SheetJS `xlsx` (in the serverless function) |
| WebDAV client | `webdav` npm package (function only) |
| Animations | hand-rolled rAF count-ups + CSS transitions (GSAP optional later) |
| Hosting | Vercel free tier (static + `/api` function) |

## 5. Data contract (pending — the open item)

The user will provide real workbooks (tunnel excavation progress sheet, NCR list,
purchase records, finance, manpower, etc.). For each sheet we will document:

- sheet name → panel it feeds
- column headers → exact widget/KPI each column drives
- expected types/formats (dates, numbers, status enums)

Rule: the dashboard reads **the user's existing sheet structure**; we only request
minimal tweaks if a sheet is unparseable. Editing values/rows in Nutstore requires
no code changes; adding a brand-new kind of chart/sheet is a small one-time mapping edit.

**Until real files arrive, panels are built against mock data shaped like the mockup,
then swapped to real mappings sheet by sheet.**

## 6. Build order

1. **Spike:** Vercel function fetches the `.xlsx` from Nutstore via WebDAV (de-risks the
   whole plan; user creates Nutstore app password + Vercel env var).
2. Data contract for the first real sheet (progress sheet).
3. Dashboard shell (Sample 1 look) + parsing layer.
4. First panel end-to-end with real data (Tunnel/Progress).
5. Remaining panels one at a time, as user supplies data sheets.
6. Refresh flow polish (loading/error states, last-refresh stamp).
7. Deploy to Vercel; share link with team.

## 7. Error handling

- Function: missing/renamed sheet or columns → return partial data + warnings array;
  browser shows which panel is stale and why.
- Network/auth failure → keep last rendered data, show banner.
- Excel quirks (merged cells, blank rows, date serials) handled in per-sheet parsers,
  following patterns already proven in `build_tracker.js`.

## 8. Out of scope (for now)

- Multiple simultaneous editors / real-time sync (single maintainer assumed).
- Access control on the dashboard link (can add Vercel password protection later).
- Editing data from the webpage (read-only dashboard).
- Mobile-first layout (desktop-first; basic responsiveness only).
