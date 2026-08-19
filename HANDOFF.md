# Session Handoff — TKV Tracker

_Last updated: 2026-08-19_

This file lets you resume work on another device. The **code** is all in this
git repo (already pushed). This doc carries the **context** a fresh Claude Code
session needs. On the new device, after cloning, tell Claude: **"Read HANDOFF.md"**.

## What this project is
Interactive multi-panel web dashboard for the **Tamakoshi-V Hydroelectric
Project (99.8 MW)**. Deployed at **https://tkv-tracker.vercel.app** (Vercel,
auto-deploys from `main`). Static HTML/JS frontend + a Vercel serverless
backend (`api/data.js`) that reads Excel/XER files live from Nutstore (WebDAV)
and Dropbox.

## Two synced frontends — keep them identical
- `public/index.html` — uses external `public/css/styles.css` + `public/js/app.js`.
- `public/TamakoshiTracker.html` — self-contained (inline CSS + JS), hardcodes
  `API_BASE='https://tkv-tracker.vercel.app'`.
- Repo-root `TamakoshiTracker.html` — a byte-for-byte copy of the public one.

**Any UI change must be mirrored into all three** (edit app.js/styles.css, then
mirror into public/TamakoshiTracker.html, then `cp public/TamakoshiTracker.html
TamakoshiTracker.html`).

## How to run / verify locally
- `npm run dev` → dev server on http://localhost:3000 (serves the local sample
  workbook under `data/`, which is gitignored).
- `npm run dev:cloud` → same but loads `.env` (Nutstore creds) to fetch live data.
- `node -c public/js/app.js` to syntax-check after edits.
- There is no full unit-test suite; verification is done via a dev server +
  browser DOM checks.

## Recent work (Claims & Variations module)
The `#claims` panel is a 4-tab live module — **Overview · Claims · Variations ·
Potential Claims & Variations** — reading a Nutstore workbook
(`claim and variation (details for presentation)(1).xlsx`, sheets Claim /
Variation / Potential Claim / Potential Variation). Recently added:
- Per-item **folder link** (workbook column M "URL").
- **Potential** sheets merged into one tab; row keys prefixed (SoC-/VAR-/PC-/PV-).
- **Overview charts are click-to-detail**: donut slice → matters in that basis;
  scatter dot → matter details; exposure bar → claim summary. (Shared
  `expandDetail`/`collapseDetail`/`DETAIL_HINTS` machinery, same as the EV charts.)
- **Probability vs Value** rebuilt as a 4-quadrant risk matrix with
  collision-free point labels (deterministic `labelLayout`).
- Detail panel **Chronology**: 3-column timeline (date · sender-coloured dot rail
  · subject), newest-first, collapsed to 4 with a "View all" toggle.

## Pending / next up
- **Switch claim amounts from USD → NPR.** The workbook has both an
  `Amount (USD)` column and an `NPR` column. Decision still open: apply to the
  whole Claims module (KPIs, tables, donut, scatter axis, exposure bar, detail
  panels) or only specific spots. (Paused at user's request.)

## Constraints (important)
- The GitHub repo is **public** — never commit secrets or sensitive financial
  Excel files (only data-free templates). Live data files stay gitignored.
- Do not re-add `NUTSTORE_XER_PATH` to Vercel.
- If a push doesn't trigger a Vercel deploy within ~2 min, an empty commit
  (`git commit --allow-empty -m redeploy && git push`) re-triggers it.
