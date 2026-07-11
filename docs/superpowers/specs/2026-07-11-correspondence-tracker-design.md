# Correspondence Tracker — Nutstore-backed web integration

## Problem

The Correspondence Tracker (`Correspondence Tracker.html` in the Nutstore Shared
Folder) is a fully client-side single-page app. It reads/writes its data file
(`Shared Folder/Letter Recording/LetterTracker_Data.json`, ~2.3MB) via the
browser's File System Access API, which requires the user to manually
"Connect & Load" the file and reconnect on every new device/session. There is
no remote access, no multi-user support, and no access control — anyone with
the file can see and edit everything.

The user wants a hosted version, in the same Vercel dashboard project as the
rest of the TKV site, that reads and writes the same Nutstore JSON file
automatically (no manual connect/upload), and lets department-specific staff
log in and see only the letters relevant to their department.

## Goals

- Load/save `LetterTracker_Data.json` directly against Nutstore over WebDAV
  from Vercel serverless functions — no manual file connect step.
- New "Correspondence" section in the existing dashboard, gated by the
  existing login system.
- Department-scoped roles: a user assigned e.g. `Contract` only sees letters
  whose `department` field includes `Contract` (letters can be
  multi-department, e.g. `"QA/Design"`, matching either).
- Only admin can add/edit/delete letters; department-scoped users are
  view/search/filter/export only.
- Remove the File System Access / local-file fallback entirely — Nutstore is
  the sole source of truth.

## Non-goals

- No optimistic locking / conflict resolution for concurrent writes — the
  admin is the sole editor, so last-write-wins is acceptable.
- No change to the tracker's existing UI/UX for filtering, calendar view,
  letter chains, attachments, or export — only the load/save plumbing and
  section/role gating change.
- No separate "can edit" permission independent of `isAdmin` (considered,
  explicitly declined by user — admin-only writes for now).

## Architecture

Follows the existing pattern in [api/data.js](../../../api/data.js) (WebDAV
reads from Nutstore using `NUTSTORE_USER`/`NUTSTORE_PASSWORD` Basic Auth
against `https://dav.jianguoyun.com/dav/`) and
[api/schedule.js](../../../api/schedule.js) (admin-gated write endpoint).

**New endpoint: `api/letters.js`**

- `GET /api/letters` — requires a valid session (`currentUser(req)` from
  [lib/auth.js](../../../lib/auth.js)). WebDAV `GET`s
  `Shared Folder/Letter Recording/LetterTracker_Data.json`, parses it, and
  filters `letters[]` server-side by the caller's `departments` (see below),
  then returns the filtered payload.
- `POST /api/letters` — requires `me.isAdmin`. Body is the full updated
  tracker JSON blob (same shape the client's `getData()` already produces).
  WebDAV `PUT`s the file back to Nutstore, overwriting it. Returns 403 for
  non-admin callers.
- No caching layer beyond what a single request needs — unlike `api/data.js`
  (which serves many read-heavy panels), letters are read/written directly
  each time; a short in-memory ETag/mtime check (mirroring `api/data.js`'s
  `fileCache`) is a reasonable internal optimization but not required for v1.

**Access control model (extends [lib/store.js](../../../lib/store.js)
`tkv:users`)**

Each user record gains one new optional field:

```
departments: string[]   // only meaningful when sections includes "correspondence"
                         // empty/absent = unrestricted (sees all letters)
```

- Filtering logic mirrors the tracker's existing client-side dept-filter pills
  (`letter.department.split("/").map(s=>s.trim())`, intersected against the
  user's `departments` list). A letter tagged `"QA/Design"` is visible to a
  user with `departments:["QA"]` or `departments:["Design"]` or both.
  Admins (or any user with empty `departments`) see everything.
- This enforcement happens in `api/letters.js`, not just hidden in the UI —
  consistent with the non-negotiable server-side enforcement established in
  [2026-07-10-access-control-design.md](2026-07-10-access-control-design.md).
- `api/users.js` (admin-only user CRUD) is extended to accept/return
  `departments[]` alongside the existing `sections[]`/`isAdmin` fields.

**Frontend**

- New "Correspondence" nav entry/section in the dashboard shell, gated by
  `sections.includes("correspondence")`, same as Financial/Claims/Schedule.
- The tracker's ~3000 lines of UI (filters, table, calendar, letter
  form, attachments, PDF export, letter chains) are preserved as-is and
  brought into the dashboard project. Only the load/save plumbing changes:
  - `autoConnect()` → on mount, `authFetch('/api/letters')` populates `ST`
    directly. No connect gesture.
  - `_writeFile()` → `authFetch('/api/letters', {method:'POST', body:
    JSON.stringify(getData())})`, still debounced 800ms after the last edit.
  - Removed entirely: `connectFile`, `reconnectFile`,
    `showSaveFilePicker`/`showOpenFilePicker` calls, the "Not connected" /
    "Reconnect & Load Data" banner, the `hp_lt_cache` localStorage mirror.
  - Save status pill keeps its existing states (✅ Connected / ✅ Auto-saved /
    ✗ Save error); "Connected" now means "session loaded from the server".
- Department-scoped users: Add/Edit/Delete/"+ New Letter" controls are
  hidden. Filters, search, calendar, and export remain fully available.
- Admin's existing User Management panel gets a department multi-select,
  shown only when the "correspondence" section checkbox is checked. Options
  are populated from the tracker's live `allDepts` list (fetched from
  `/api/letters`'s payload, same list the tracker itself uses for its own
  department dropdown/custom-add) so newly added custom departments become
  assignable without a code change.

## Error handling

- `GET /api/letters` failure (Nutstore unreachable/auth error/WebDAV error) →
  inline error state in place of the table, with a manual Retry button. No
  stale local cache to fall back to (File System Access removed by design).
- `POST /api/letters` failure → existing "✗ Save error — check Nutstore sync"
  pill; in-memory edits are not lost. No automatic retry loop — the existing
  "💾 Save Now" button lets the user retry manually so a flaky save isn't
  silently dropped.
- No optimistic concurrency control; last write wins.

## Known limitation

The JSON file is ~2.3MB. Every `GET /api/letters` — including for a
department-scoped viewer who only ends up seeing a handful of letters — still
requires the server to fetch and parse the *entire* file from Nutstore before
filtering rows out. Filtering saves bandwidth to the browser, not Nutstore
fetch/parse time. Acceptable at current size; worth revisiting (e.g. per-file
mtime caching like `api/data.js` already does for XER files) if the file grows
substantially.

## Testing

- Unit-level: department-filter logic (letter `department` string → matches
  a user's `departments[]`), exercised with single-department and
  multi-department (`"QA/Design"`) letters, plus the unrestricted
  (empty `departments`) admin case.
- Manual: log in as a department-scoped test user, confirm only matching
  letters appear, confirm Add/Edit/Delete controls are absent, confirm
  `POST /api/letters` is rejected (403) if called directly.
- Manual: log in as admin, add/edit/delete a letter, confirm the change
  round-trips through Nutstore (reload picks up the saved state, and the
  underlying `LetterTracker_Data.json` in the Nutstore folder reflects it).
- Manual: simulate a Nutstore/WebDAV failure (bad credentials) and confirm
  the inline error + retry UX.
