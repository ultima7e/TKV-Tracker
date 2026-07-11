# Correspondence Tracker (Nutstore-backed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the standalone Correspondence Tracker into this dashboard as a login-gated "Correspondence" section that reads/writes `LetterTracker_Data.json` straight from Nutstore over WebDAV, with department-scoped view-only roles.

**Architecture:** A new `api/letters.js` endpoint (backed by a new `lib/letters.js`) mirrors the existing `api/data.js` WebDAV pattern: `GET` fetches and department-filters the JSON, admin-only `POST` overwrites it. The tracker's own ~3000-line UI is preserved verbatim in a new `public/correspondence.html`, embedded via a lazily-loaded iframe in a new "Correspondence" nav section; only its load/save plumbing is swapped from the File System Access API to `fetch('/api/letters')`. User roles gain an optional `departments[]` field alongside the existing `sections[]`/`isAdmin`.

**Tech Stack:** Node (Vercel serverless functions, no framework), vanilla JS/HTML frontend, `node --test` for unit tests, Upstash/Vercel KV via `lib/store.js` (local JSON-file fallback in dev).

## Global Constraints

- Server-side enforcement is non-negotiable: department filtering happens in `api/letters.js`, never only hidden in the UI (matches the existing rule in [2026-07-10-access-control-design.md](../specs/2026-07-10-access-control-design.md)).
- Only `isAdmin` accounts may write (`POST /api/letters`) — no separate edit-permission flag (per [2026-07-11-correspondence-tracker-design.md](../specs/2026-07-11-correspondence-tracker-design.md)).
- No File System Access API / local-file fallback / `localStorage` cache in the shipped tracker — Nutstore-over-WebDAV is the sole source of truth.
- Reuse `NUTSTORE_USER`/`NUTSTORE_PASSWORD` env vars already configured for `api/data.js` — no new required env vars.
- Follow existing repo conventions: pure logic in `lib/`, thin handlers in `api/`, `node --test` tests in `tests/`, local dev fallback under `data/` (gitignored for anything that isn't a checked-in sample).

---

### Task 1: Department-scoped user roles

**Files:**
- Modify: `lib/auth.js:9` (SECTIONS), `lib/auth.js:53-65` (currentUser)
- Modify: `api/users.js:17-22` (GET), `api/users.js:24-38` (POST)
- Test: `tests/auth-departments.test.js`

**Interfaces:**
- Produces: `SECTIONS` now includes `'corr'`. `currentUser(req)` resolves to `{ username, isAdmin, sections, departments }` where `departments` is `string[]` (empty = unrestricted). `api/users.js` GET returns `{ users: [{username, sections, isAdmin, departments}], sections }`; POST accepts `{ username, password, sections, isAdmin, departments }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/auth-departments.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;
const { saveUsers } = require('../lib/store');
const { signToken, currentUser, SECTIONS } = require('../lib/auth');

test('SECTIONS includes the correspondence section', () => {
  assert.equal(SECTIONS.includes('corr'), true);
});

test('currentUser resolves a department-scoped user with departments[]', async () => {
  await saveUsers({ 'qa.tester': { pass: 'x:y', sections: ['corr'], departments: ['QA', 'Design'], isAdmin: false } });
  const token = signToken('qa.tester');
  const me = await currentUser({ headers: { authorization: 'Bearer ' + token } });
  assert.deepEqual(me.sections, ['corr']);
  assert.deepEqual(me.departments, ['QA', 'Design']);
  assert.equal(me.isAdmin, false);
});

test('currentUser gives admins an unrestricted (empty) departments list', async () => {
  await saveUsers({ boss: { pass: 'x:y', sections: [], departments: ['QA'], isAdmin: true } });
  const token = signToken('boss');
  const me = await currentUser({ headers: { authorization: 'Bearer ' + token } });
  assert.deepEqual(me.departments, []);
  assert.equal(me.isAdmin, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `SECTIONS.includes('corr')` is `false`, and `me.departments` is `undefined` (property doesn't exist yet).

- [ ] **Step 3: Add the `corr` section and `departments` to `lib/auth.js`**

In `lib/auth.js`, change line 9:

```js
const SECTIONS = ['exec', 'fin', 'sched', 'tunnel', 'claims', 'inv', 'man', 'equip', 'safety'];
```

to:

```js
const SECTIONS = ['exec', 'fin', 'sched', 'tunnel', 'claims', 'inv', 'man', 'equip', 'safety', 'corr'];
```

Then replace the `currentUser` function (lines 53-65):

```js
async function currentUser(req) {
  const t = verifyToken(readToken(req));
  if (!t) return null;
  const users = await getUsers();
  const rec = users[t.u];
  if (rec) {
    return { username: t.u, isAdmin: !!rec.isAdmin, sections: rec.isAdmin ? SECTIONS.slice() : (rec.sections || []) };
  }
  if (process.env.ADMIN_USER && t.u === process.env.ADMIN_USER) {
    return { username: t.u, isAdmin: true, sections: SECTIONS.slice() };
  }
  return null;
}
```

with:

```js
async function currentUser(req) {
  const t = verifyToken(readToken(req));
  if (!t) return null;
  const users = await getUsers();
  const rec = users[t.u];
  if (rec) {
    return {
      username: t.u, isAdmin: !!rec.isAdmin,
      sections: rec.isAdmin ? SECTIONS.slice() : (rec.sections || []),
      departments: rec.isAdmin ? [] : (rec.departments || []),
    };
  }
  if (process.env.ADMIN_USER && t.u === process.env.ADMIN_USER) {
    return { username: t.u, isAdmin: true, sections: SECTIONS.slice(), departments: [] };
  }
  return null;
}
```

- [ ] **Step 4: Add `departments` to the user-management API**

In `api/users.js`, change the GET list mapping (lines 18-20):

```js
      const list = Object.entries(users).map(([username, r]) => ({
        username, sections: r.sections || [], isAdmin: !!r.isAdmin,
      })).sort((a, b) => a.username.localeCompare(b.username));
```

to:

```js
      const list = Object.entries(users).map(([username, r]) => ({
        username, sections: r.sections || [], isAdmin: !!r.isAdmin, departments: r.departments || [],
      })).sort((a, b) => a.username.localeCompare(b.username));
```

Then change the POST handler (lines 24-38):

```js
    if (req.method === 'POST') {
      const { username, password, sections, isAdmin } = req.body || {};
      const name = typeof username === 'string' ? username.trim() : '';
      if (!name) return res.status(400).json({ error: 'Username is required.' });
      const existing = users[name];
      if (!existing && !password) return res.status(400).json({ error: 'A password is required for a new user.' });
      const rec = existing || {};
      if (password) rec.pass = hashPassword(password);
      if (Array.isArray(sections)) rec.sections = sections.filter((s) => SECTIONS.includes(s));
      else if (!rec.sections) rec.sections = [];
      rec.isAdmin = !!isAdmin;
      users[name] = rec;
      await saveUsers(users);
      return res.status(200).json({ ok: true });
    }
```

to:

```js
    if (req.method === 'POST') {
      const { username, password, sections, isAdmin, departments } = req.body || {};
      const name = typeof username === 'string' ? username.trim() : '';
      if (!name) return res.status(400).json({ error: 'Username is required.' });
      const existing = users[name];
      if (!existing && !password) return res.status(400).json({ error: 'A password is required for a new user.' });
      const rec = existing || {};
      if (password) rec.pass = hashPassword(password);
      if (Array.isArray(sections)) rec.sections = sections.filter((s) => SECTIONS.includes(s));
      else if (!rec.sections) rec.sections = [];
      if (Array.isArray(departments)) rec.departments = [...new Set(departments.map((d) => String(d).trim()).filter(Boolean))];
      else if (!rec.departments) rec.departments = [];
      rec.isAdmin = !!isAdmin;
      users[name] = rec;
      await saveUsers(users);
      return res.status(200).json({ ok: true });
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all three new tests, plus the existing suite unaffected).

- [ ] **Step 6: Commit**

```bash
git add lib/auth.js api/users.js tests/auth-departments.test.js
git commit -m "feat(auth): add correspondence section and department-scoped roles"
```

---

### Task 2: `api/letters.js` — Nutstore-backed, department-filtered letters endpoint

**Files:**
- Create: `lib/letters.js`
- Create: `api/letters.js`
- Create: `data/sample-letters.json`
- Modify: `.gitignore`
- Test: `tests/letters.test.js`

**Interfaces:**
- Consumes: `currentUser(req)` from Task 1 → `{ isAdmin, departments }`.
- Produces: `lib/letters.js` exports `{ readLettersRaw, writeLettersRaw, deptsOf, filterLettersForUser, LETTERS_PATH }`. `GET /api/letters` → `{ letters, allTags, allDocTypes, allLocations, allDepts, savedAt, version, canEdit }`. `POST /api/letters` (admin only) accepts `{ letters, allTags, allDocTypes, allLocations, allDepts }` and returns `{ ok: true, count, savedAt }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/letters.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('deptsOf splits multi-department letters on "/"', () => {
  const { deptsOf } = require('../lib/letters');
  assert.deepEqual(deptsOf({ department: 'QA/Design' }), ['QA', 'Design']);
  assert.deepEqual(deptsOf({ department: 'Contract' }), ['Contract']);
  assert.deepEqual(deptsOf({}), []);
});

test('filterLettersForUser: admin sees everything', () => {
  const { filterLettersForUser } = require('../lib/letters');
  const letters = [{ id: 1, department: 'Contract' }, { id: 2, department: 'QA/Design' }];
  assert.equal(filterLettersForUser(letters, { isAdmin: true, departments: [] }).length, 2);
});

test('filterLettersForUser: department-scoped user sees matching single- and multi-department letters', () => {
  const { filterLettersForUser } = require('../lib/letters');
  const letters = [
    { id: 1, department: 'Contract' },
    { id: 2, department: 'QA/Design' },
    { id: 3, department: 'EHS' },
  ];
  const result = filterLettersForUser(letters, { isAdmin: false, departments: ['QA'] });
  assert.deepEqual(result.map((l) => l.id), [2]);
});

test('filterLettersForUser: unrestricted non-admin (no departments assigned) sees everything', () => {
  const { filterLettersForUser } = require('../lib/letters');
  const letters = [{ id: 1, department: 'Contract' }, { id: 2, department: 'EHS' }];
  assert.equal(filterLettersForUser(letters, { isAdmin: false, departments: [] }).length, 2);
});

test('readLettersRaw falls back to the tracked sample fixture when Nutstore is not configured', async () => {
  delete process.env.NUTSTORE_USER;
  delete process.env.NUTSTORE_PASSWORD;
  const localOverride = path.join(__dirname, '..', 'data', '.letters_local.json');
  try { fs.unlinkSync(localOverride); } catch { /* already absent */ }
  const { readLettersRaw } = require('../lib/letters');
  const raw = await readLettersRaw();
  const data = JSON.parse(raw);
  assert.equal(Array.isArray(data.letters), true);
  assert.equal(data.letters.length > 0, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../lib/letters'`.

- [ ] **Step 3: Create the sample fixture**

Create `data/sample-letters.json`:

```json
{
  "letters": [
    { "id": "L-001", "department": "Contract", "subject": "Sample contract letter", "date": "2026-01-10" },
    { "id": "L-002", "department": "QA/Design", "subject": "Sample QA/Design letter", "date": "2026-02-14" },
    { "id": "L-003", "department": "EHS", "subject": "Sample EHS letter", "date": "2026-03-02" }
  ],
  "allTags": [],
  "allDocTypes": [],
  "allLocations": [],
  "allDepts": ["Contract", "QA", "Design", "EHS"],
  "savedAt": "2026-01-01T00:00:00.000Z",
  "version": "2.1"
}
```

- [ ] **Step 4: Implement `lib/letters.js`**

```js
// Correspondence Tracker data: reads/writes LetterTracker_Data.json straight
// from Nutstore over WebDAV (same protocol as api/data.js's workbook/XER
// fetches), so the hosted tracker and the desktop file stay one source of
// truth. Local dev without NUTSTORE_USER/PASSWORD falls back to a JSON file
// under data/.
const fs = require('fs');
const path = require('path');

const DAV_BASE = 'https://dav.jianguoyun.com/dav/';
const LETTERS_PATH = process.env.NUTSTORE_LETTERS_PATH ||
  'Shared Folder/Letter Recording/LetterTracker_Data.json';
const encPath = (p) => p.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');

const SAMPLE_PATH = path.join(__dirname, '..', 'data', 'sample-letters.json');
const LOCAL_OVERRIDE_PATH = path.join(__dirname, '..', 'data', '.letters_local.json');

function davHeaders() {
  const { NUTSTORE_USER, NUTSTORE_PASSWORD } = process.env;
  if (!NUTSTORE_USER || !NUTSTORE_PASSWORD) return null;
  return { Authorization: 'Basic ' + Buffer.from(`${NUTSTORE_USER}:${NUTSTORE_PASSWORD}`).toString('base64') };
}

async function readLettersRaw() {
  const headers = davHeaders();
  if (headers) {
    const res = await fetch(DAV_BASE + encPath(LETTERS_PATH), { headers });
    if (!res.ok) throw new Error(`Nutstore responded ${res.status} ${res.statusText} for letters file`);
    return await res.text();
  }
  if (fs.existsSync(LOCAL_OVERRIDE_PATH)) return fs.readFileSync(LOCAL_OVERRIDE_PATH, 'utf8');
  return fs.readFileSync(SAMPLE_PATH, 'utf8');
}

async function writeLettersRaw(text) {
  const headers = davHeaders();
  if (headers) {
    const res = await fetch(DAV_BASE + encPath(LETTERS_PATH), { method: 'PUT', headers, body: text });
    if (!res.ok) throw new Error(`Nutstore PUT failed ${res.status} ${res.statusText} for letters file`);
    return;
  }
  fs.mkdirSync(path.dirname(LOCAL_OVERRIDE_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_OVERRIDE_PATH, text);
}

// A letter's department field is "/"-joined for multi-department letters,
// e.g. "QA/Design" — matches either role.
function deptsOf(letter) {
  return String(letter.department || '').split('/').map((s) => s.trim()).filter(Boolean);
}

function filterLettersForUser(letters, me) {
  if (me.isAdmin || !me.departments || !me.departments.length) return letters;
  const allowed = new Set(me.departments);
  return letters.filter((l) => deptsOf(l).some((d) => allowed.has(d)));
}

module.exports = { readLettersRaw, writeLettersRaw, deptsOf, filterLettersForUser, LETTERS_PATH };
```

- [ ] **Step 5: Implement `api/letters.js`**

```js
// GET: load Correspondence Tracker data, filtered server-side to the caller's
// department roles. POST (admin only): overwrite the tracker data.
const { currentUser } = require('../lib/auth');
const { readLettersRaw, writeLettersRaw, filterLettersForUser } = require('../lib/letters');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const me = await currentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });

    if (req.method === 'GET') {
      const raw = await readLettersRaw();
      const data = raw.trim() ? JSON.parse(raw) : { letters: [], allTags: [], allDocTypes: [], allLocations: [], allDepts: [] };
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        letters: filterLettersForUser(data.letters || [], me),
        allTags: data.allTags || [],
        allDocTypes: data.allDocTypes || [],
        allLocations: data.allLocations || [],
        allDepts: data.allDepts || [],
        savedAt: data.savedAt || null,
        version: data.version || '2.1',
        canEdit: !!me.isAdmin,
      });
    }

    if (req.method === 'POST') {
      if (!me.isAdmin) return res.status(403).json({ error: 'Admin only' });
      const body = req.body || {};
      if (!Array.isArray(body.letters)) return res.status(400).json({ error: 'letters[] is required' });
      const payload = {
        letters: body.letters,
        allTags: Array.isArray(body.allTags) ? body.allTags : [],
        allDocTypes: Array.isArray(body.allDocTypes) ? body.allDocTypes : [],
        allLocations: Array.isArray(body.allLocations) ? body.allLocations : [],
        allDepts: Array.isArray(body.allDepts) ? body.allDepts : [],
        savedAt: new Date().toISOString(),
        version: '2.1',
      };
      await writeLettersRaw(JSON.stringify(payload, null, 2));
      return res.status(200).json({ ok: true, count: payload.letters.length, savedAt: payload.savedAt });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
};
```

- [ ] **Step 6: Add the local override file to `.gitignore`**

In `.gitignore`, under the existing `# Local dev user store...` block, add:

```
data/.letters_local.json
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all new tests, plus the existing suite unaffected).

- [ ] **Step 8: Commit**

```bash
git add lib/letters.js api/letters.js data/sample-letters.json tests/letters.test.js .gitignore
git commit -m "feat(letters): add Nutstore-backed, department-filtered letters API"
```

---

### Task 3: Port the tracker to `public/correspondence.html` with server-backed storage

**Files:**
- Create: `public/correspondence.html` (copied from the Nutstore source, then patched)
- Reference (read-only, not modified): `C:\Users\bhsag\Nutstore\1\Shared Folder\Correspondence Tracker.html`

**Interfaces:**
- Consumes: `GET /api/letters` → `{ letters, allTags, allDocTypes, allLocations, allDepts, savedAt, version, canEdit }` and `POST /api/letters` from Task 2. Same-origin, so the existing `tkv_session` cookie authenticates automatically — no bearer-token plumbing needed inside this file.
- Produces: a self-contained page at `/correspondence.html` that dashboard Task 4 will iframe in.

- [ ] **Step 1: Copy the source file**

```bash
cp "C:/Users/bhsag/Nutstore/1/Shared Folder/Correspondence Tracker.html" "public/correspondence.html"
```

- [ ] **Step 2: Replace the storage panel UI**

In `public/correspondence.html`, find this block (originally around line 358):

```html
    <div class="storage-panel">
      <div class="sp-status">
        <div class="sp-dot" id="sp-dot" style="background:#f59e0b"></div>
        <span class="sp-label" id="sp-label" style="color:#f59e0b">Not connected</span>
      </div>
      <div id="sp-filename" class="sp-filename" style="display:none"></div>
      <div id="sp-reconnect" style="display:none" class="reconnect-banner">
        📂 Data file found — click to reconnect.
        <button onclick="reconnectFile()">🔓 Reconnect &amp; Load Data</button>
      </div>
      <button class="sp-btn sp-btn-primary"   id="sp-open-btn" onclick="openDataFile()">📂 Open Data File…</button>
      <button class="sp-btn sp-btn-secondary" id="sp-new-btn"  onclick="createDataFile()">📄 Create New Data File</button>
      <button class="sp-btn sp-btn-green"     id="sp-save-btn" onclick="saveNow()" style="display:none">💾 Save Now</button>
      <button class="sp-btn sp-btn-amber" id="sp-export-csv-btn" onclick="exportCSV()" style="margin-top:6px">⬆ Export CSV</button>
    </div>
    <div class="save-flash" id="save-flash">✓ Saved to Nutstore</div>
```

Replace it with:

```html
    <div class="storage-panel">
      <div class="sp-status">
        <div class="sp-dot" id="sp-dot" style="background:#f59e0b"></div>
        <span class="sp-label" id="sp-label" style="color:#f59e0b">Loading…</span>
      </div>
      <button class="sp-btn sp-btn-green"     id="sp-save-btn" onclick="saveNow()" style="display:none">💾 Save Now</button>
      <button class="sp-btn sp-btn-secondary" id="sp-retry-btn" onclick="loadFromServer()" style="display:none">↻ Retry Load</button>
      <button class="sp-btn sp-btn-amber" id="sp-export-csv-btn" onclick="exportCSV()" style="margin-top:6px">⬆ Export CSV</button>
    </div>
    <div class="save-flash" id="save-flash">✓ Saved to Nutstore</div>
```

- [ ] **Step 3: Add an id to the Import CSV button and locate the Add Letter button**

Find:

```html
        <button class="btn-out" style="font-size:12px;padding:5px 12px" onclick="openImportModal()">⬇ Import CSV</button>
```

Replace with:

```html
        <button class="btn-out" id="importbtn" style="font-size:12px;padding:5px 12px" onclick="openImportModal()">⬇ Import CSV</button>
```

(The neighboring `<button class="btn-primary" id="addbtn" onclick="openAdd()" ...>+ Add Letter</button>` already has an id — no change needed there.)

- [ ] **Step 4: Replace the whole storage script section**

Find the block that starts with the `// ══ STORAGE ══...` banner comment and ends with the `beforeunload` listener (originally lines 830-1058 — everything from `let _fileHandle` through the final `window.addEventListener("beforeunload", ...)`). Replace that entire block with:

```js
// ══ STORAGE ══════════════════════════════════════════════════════════════════
// ═══ SERVER-BACKED STORAGE (Vercel → Nutstore over WebDAV) ═══════════════════
// GET /api/letters loads (server-filtered by the caller's department roles);
// POST /api/letters (admin only) saves. No local file, no localStorage cache —
// the server is the single source of truth.
// ════════════════════════════════════════════════════════════════════════════

let CAN_EDIT   = false;  // set from the GET response; gates all mutation UI
let _loaded    = false;  // becomes true after the first successful load
let _saveTimer = null;   // debounce timer
let _unsaved   = false;  // track unsaved changes

// ── Data helpers ────────────────────────────────────────────────────────────
function getData(){
  return{letters:ST.letters,allTags:ST.allTags,allDocTypes:ST.allDocTypes,
    allLocations:ST.allLocations,allDepts:ST.allDepts,savedAt:new Date().toISOString(),version:"2.1"};
}
function applyData(d){
  if(!d)return;
  ST.letters=d.letters||[];
  if(d.allTags?.length)     ST.allTags=d.allTags;
  if(d.allDocTypes?.length) ST.allDocTypes=d.allDocTypes;
  if(d.allLocations?.length)ST.allLocations=d.allLocations;
  if(d.allDepts?.length)    ST.allDepts=d.allDepts;
  initPendingForLatest(ST.letters, 20);
  _invalidateCache();
}

// ── Status panel ────────────────────────────────────────────────────────────
function setSP(state){
  const dot=document.getElementById("sp-dot");
  const lbl=document.getElementById("sp-label");
  const saveBtn=document.getElementById("sp-save-btn");
  const retryBtn=document.getElementById("sp-retry-btn");
  if(state==="connected"){
    dot.style.background="#10b981"; lbl.style.color="#10b981";
    lbl.textContent=CAN_EDIT?"✅ Connected":"✅ Connected (view only)";
    if(saveBtn)saveBtn.style.display=CAN_EDIT?"block":"none";
    if(retryBtn)retryBtn.style.display="none";
  }else if(state==="saving"){
    dot.style.background="#f59e0b"; lbl.style.color="#f59e0b";
    lbl.textContent="💾 Saving…";
  }else if(state==="saved"){
    dot.style.background="#10b981"; lbl.style.color="#10b981";
    lbl.textContent="✅ Auto-saved";
    flashSave(); setTimeout(()=>setSP("connected"),2000);
  }else if(state==="error"){
    dot.style.background="#ef4444"; lbl.style.color="#ef4444";
    lbl.textContent="✗ Save error — check connection, then Save Now";
  }else{ // load-error
    dot.style.background="#ef4444"; lbl.style.color="#ef4444";
    lbl.textContent="✗ Couldn't load data";
    if(saveBtn)saveBtn.style.display="none";
    if(retryBtn)retryBtn.style.display="block";
  }
}
function flashSave(){
  const el=document.getElementById("save-flash");
  if(!el)return;
  el.style.opacity="1";
  setTimeout(()=>{ el.style.opacity="0"; },2000);
}

// ── Save to server (admin only; debounced 800ms after the last edit) ─────────
async function _writeFile(){
  if(!CAN_EDIT||!_loaded)return false;
  try{
    setSP("saving");
    const res=await fetch("/api/letters",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(getData())});
    if(!res.ok)throw new Error("HTTP "+res.status);
    setSP("saved");
    _unsaved=false;
    return true;
  }catch(e){
    setSP("error"); console.error("Save failed:",e);
    return false;
  }
}
function persist(){
  if(!CAN_EDIT||!_loaded)return; // view-only users never write; server also 403s this
  _unsaved=true;
  clearTimeout(_saveTimer);
  _saveTimer=setTimeout(()=>_writeFile(),800);
}
async function saveNow(){
  clearTimeout(_saveTimer);
  await _writeFile();
}

// ── Load from the server ──────────────────────────────────────────────────────
async function loadFromServer(){
  setSP("loading");
  try{
    const res=await fetch("/api/letters");
    if(res.status===401){ location.reload(); return; } // session expired — reload into login
    if(!res.ok)throw new Error("HTTP "+res.status);
    const json=await res.json();
    CAN_EDIT=!!json.canEdit;
    document.getElementById("addbtn").style.display=CAN_EDIT?"":"none";
    document.getElementById("importbtn").style.display=CAN_EDIT?"":"none";
    applyData(json);
    _loaded=true;
    setSP("connected");
    render();
  }catch(e){
    console.error("Load failed:",e);
    setSP("load-error");
  }
}

// ── Startup ────────────────────────────────────────────────────────────────
async function autoConnect(){
  await loadFromServer();
}

// Warn before closing if unsaved changes
window.addEventListener("beforeunload",e=>{
  if(_unsaved){ e.preventDefault(); e.returnValue=""; }
});
```

- [ ] **Step 5: Gate the pending-status inline edit controls**

Find `pendingDisplayHTML`'s pending/cleared/untracked branches (originally lines 711-723):

```js
  if(ps==='pending'){
    return `<span class="pending-badge is-pending">⏳ Pending</span> `+
      `<button onclick="openPendingEdit('${l.id}');event.stopPropagation()" title="Change status" `+
      `style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:12px;padding:0 2px">✏</button>`;
  }
  if(ps==='cleared'){
    return `<span class="pending-badge is-cleared">— Not Required</span> `+
      `<button onclick="setPendingStatus('${l.id}','pending');event.stopPropagation()" title="Restore pending" `+
      `style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:11px;padding:0 2px">↩</button>`;
  }
  // Not tracked (old letter, no pendingStatus set)
  return `<button onclick="setPendingStatus('${l.id}','pending');event.stopPropagation()" `+
    `style="background:#f8fafc;border:1px dashed #cbd5e1;color:#94a3b8;border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer">+ Track</button>`;
```

Replace with:

```js
  if(ps==='pending'){
    return `<span class="pending-badge is-pending">⏳ Pending</span>`+
      (CAN_EDIT?` <button onclick="openPendingEdit('${l.id}');event.stopPropagation()" title="Change status" `+
      `style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:12px;padding:0 2px">✏</button>`:"");
  }
  if(ps==='cleared'){
    return `<span class="pending-badge is-cleared">— Not Required</span>`+
      (CAN_EDIT?` <button onclick="setPendingStatus('${l.id}','pending');event.stopPropagation()" title="Restore pending" `+
      `style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:11px;padding:0 2px">↩</button>`:"");
  }
  // Not tracked (old letter, no pendingStatus set)
  if(!CAN_EDIT)return "";
  return `<button onclick="setPendingStatus('${l.id}','pending');event.stopPropagation()" `+
    `style="background:#f8fafc;border:1px dashed #cbd5e1;color:#94a3b8;border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer">+ Track</button>`;
```

- [ ] **Step 6: Gate the letter-detail modal's Edit/Delete buttons**

Find (originally lines 1524 and 1530):

```js
      ${_editMode?`<button class="btn-danger" onclick="confirmDel('${l.id}')">🗑 Delete</button>`:`<div></div>`}
```

Replace with:

```js
      ${(_editMode&&CAN_EDIT)?`<button class="btn-danger" onclick="confirmDel('${l.id}')">🗑 Delete</button>`:`<div></div>`}
```

Find:

```js
        ${_editMode?`<button class="btn-primary" onclick="closeM();openEdit('${l.id}')">✏ Edit</button>`:""}
```

Replace with:

```js
        ${(_editMode&&CAN_EDIT)?`<button class="btn-primary" onclick="closeM();openEdit('${l.id}')">✏ Edit</button>`:""}
```

- [ ] **Step 7: Verify no dead references remain**

Run:

```bash
grep -n "openDataFile\|createDataFile\|reconnectFile\|_fileHandle\|showOpenFilePicker\|showSaveFilePicker\|hp_lt_cache\|_getStoredHandle\|_storeHandle\|_openIDB\|sp-filename\|sp-reconnect\|sp-open-btn\|sp-new-btn" public/correspondence.html
```

Expected: no output (everything referencing the old File System Access / localStorage storage layer, and the HTML elements it drove, was inside the blocks replaced in Steps 2 and 4). If anything matches, remove or update it before moving on.

- [ ] **Step 8: Commit**

```bash
git add public/correspondence.html
git commit -m "feat(letters): port Correspondence Tracker to server-backed storage"
```

---

### Task 4: Dashboard integration — nav item, section, lazy iframe

**Files:**
- Modify: `public/index.html:36-37` (nav item), `public/index.html:225-227` (section)
- Modify: `public/js/app.js:10-13` (SECTION_LABELS), `public/js/app.js:1506-1525` (nav click handler)

**Interfaces:**
- Consumes: `public/correspondence.html` from Task 3, `canSee(v)` (existing helper in `app.js`).
- Produces: clicking the "Correspondence" nav item shows the `#corr` section and lazily points `#corr-frame`'s `src` at `correspondence.html`.

- [ ] **Step 1: Add the nav item**

In `public/index.html`, after the "Safety" nav item (line 36) and before the admin nav item (line 37):

```html
      <div class="nav-item" data-v="corr"><span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M4 6l8 7 8-7"/></svg></span>Correspondence</div>
```

- [ ] **Step 2: Add the section with a lazily-loaded iframe**

In `public/index.html`, after the "Safety" section (line 225) and before the "denied" section (line 226):

```html
      <section class="view" id="corr"><div class="card" style="padding:0;overflow:hidden">
        <iframe id="corr-frame" data-src="correspondence.html" style="width:100%;height:calc(100vh - 150px);border:0;display:block" title="Correspondence Tracker"></iframe>
      </div></section>
```

- [ ] **Step 3: Add the section label**

In `public/js/app.js`, change (lines 10-12):

```js
  const SECTION_LABELS = { exec: 'Executive Summary', fin: 'Financial', sched: 'Schedule & Progress',
    tunnel: 'Tunnel', claims: 'Claims & Variations', inv: 'Inventory & Explosives', man: 'Manpower',
    equip: 'Equipment', safety: 'Safety' };
```

to:

```js
  const SECTION_LABELS = { exec: 'Executive Summary', fin: 'Financial', sched: 'Schedule & Progress',
    tunnel: 'Tunnel', claims: 'Claims & Variations', inv: 'Inventory & Explosives', man: 'Manpower',
    equip: 'Equipment', safety: 'Safety', corr: 'Correspondence' };
```

- [ ] **Step 4: Wire lazy iframe loading into the nav click handler**

In `public/js/app.js`, inside the nav click handler, find:

```js
    // Admin section is admin-only; other sections need an explicit grant.
    if (v === 'admin') {
      if (!me || !me.isAdmin) { document.getElementById('denied').classList.add('active'); return; }
      document.getElementById('admin').classList.add('active');
      renderAdmin();
      return;
    }
    if (!canSee(v)) { document.getElementById('denied').classList.add('active'); return; }
```

Replace with:

```js
    // Admin section is admin-only; other sections need an explicit grant.
    if (v === 'admin') {
      if (!me || !me.isAdmin) { document.getElementById('denied').classList.add('active'); return; }
      document.getElementById('admin').classList.add('active');
      renderAdmin();
      return;
    }
    if (v === 'corr') {
      if (!canSee(v)) { document.getElementById('denied').classList.add('active'); return; }
      document.getElementById('corr').classList.add('active');
      const frame = document.getElementById('corr-frame');
      if (frame && !frame.src) frame.src = frame.dataset.src;
      return;
    }
    if (!canSee(v)) { document.getElementById('denied').classList.add('active'); return; }
```

- [ ] **Step 5: Manual verification**

Run: `npm run dev`, open `http://localhost:3000`, log in with an account whose `sections` includes `corr` (see Task 6 for creating one), click "Correspondence" in the nav.
Expected: the section becomes active and the iframe loads `correspondence.html`, which in turn loads data from `/api/letters`.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(letters): add Correspondence nav section with lazy iframe"
```

---

### Task 5: Admin UI — department multi-select for user management

**Files:**
- Modify: `public/index.html:239` (admin form)
- Modify: `public/js/app.js:76-134` (`renderAdmin`)

**Interfaces:**
- Consumes: `GET /api/letters` (for `allDepts`), `GET/POST /api/users` (now accepting `departments`) from Task 1/2.
- Produces: when editing a user, checking "Correspondence" under Sections reveals a Departments checklist; saving posts `departments: string[]` to `/api/users`.

- [ ] **Step 1: Add the departments field to the admin form**

In `public/index.html`, after the sections field (line 239):

```html
            <div class="adm-field"><label>Sections this user can view</label><div class="adm-secs" id="adm-secs"></div></div>
```

add, immediately below it:

```html
            <div class="adm-field" id="adm-depts-wrap" style="display:none"><label>Correspondence departments <span style="text-transform:none;font-weight:600">(leave all unchecked for full access to every letter)</span></label><div class="adm-secs" id="adm-depts"></div></div>
```

- [ ] **Step 2: Rewrite `renderAdmin` to populate and wire the departments field**

In `public/js/app.js`, replace the entire `renderAdmin` function (lines 76-134) with:

```js
  let _deptOptions = null;
  async function getDeptOptions() {
    if (_deptOptions) return _deptOptions;
    try {
      const r = await authFetch('/api/letters');
      const j = await r.json().catch(() => ({}));
      _deptOptions = Array.isArray(j.allDepts) ? j.allDepts : [];
    } catch (e) { _deptOptions = []; }
    return _deptOptions;
  }
  async function renderAdmin() {
    const secBox = document.getElementById('adm-secs');
    const deptBox = document.getElementById('adm-depts');
    const deptWrap = document.getElementById('adm-depts-wrap');
    const msg = document.getElementById('adm-msg');
    const listEl = document.getElementById('adm-list');
    if (secBox && !secBox.children.length) {
      secBox.innerHTML = ALL_SECTIONS.map((s) => '<label><input type="checkbox" value="' + s + '"> ' + SECTION_LABELS[s] + '</label>').join('');
      secBox.addEventListener('change', () => {
        if (deptWrap) deptWrap.style.display = secBox.querySelector('input[value="corr"]:checked') ? '' : 'none';
      });
    }
    if (deptBox && !deptBox.children.length) {
      const opts = await getDeptOptions();
      deptBox.innerHTML = opts.map((d) => '<label><input type="checkbox" value="' + d + '"> ' + d + '</label>').join('');
    }
    const clearForm = () => {
      document.getElementById('adm-user').value = ''; document.getElementById('adm-pass').value = '';
      document.getElementById('adm-isadmin').checked = false;
      secBox.querySelectorAll('input').forEach((c) => { c.checked = false; });
      deptBox.querySelectorAll('input').forEach((c) => { c.checked = false; });
      if (deptWrap) deptWrap.style.display = 'none';
      if (msg) msg.textContent = '';
    };
    const refresh = async () => {
      const r = await authFetch('/api/users');
      if (!r.ok) { listEl.innerHTML = '<p class="muted">Could not load users.</p>'; return; }
      const { users } = await r.json();
      listEl.innerHTML = '<table class="tbl adm-users"><thead><tr><th style="text-align:left">Username</th><th style="text-align:left">Access</th><th></th></tr></thead><tbody>' +
        users.map((u) => '<tr><td style="text-align:left"><b>' + u.username + '</b></td><td style="text-align:left">' +
          (u.isAdmin ? '<span class="chip" style="background:#e4f5ee;color:#1c7a52">All · admin</span>'
            : (u.sections.length ? u.sections.map((s) => '<span class="chip">' + (SECTION_LABELS[s] || s) + '</span>').join(' ') : '<span class="muted">none</span>')) +
          (!u.isAdmin && u.departments && u.departments.length ? ' <span class="muted">[' + u.departments.join(', ') + ']</span>' : '') +
          '</td><td style="white-space:nowrap;text-align:right"><button class="adm-btn ghost adm-edit" data-u="' + u.username + '" style="padding:5px 10px">Edit</button> ' +
          '<button class="adm-btn danger adm-del" data-u="' + u.username + '" style="padding:5px 10px">Delete</button></td></tr>').join('') +
        '</tbody></table>';
      listEl.querySelectorAll('.adm-edit').forEach((b) => { b.onclick = () => {
        const u = users.find((x) => x.username === b.dataset.u);
        document.getElementById('adm-user').value = u.username; document.getElementById('adm-pass').value = '';
        document.getElementById('adm-isadmin').checked = u.isAdmin;
        secBox.querySelectorAll('input').forEach((c) => { c.checked = u.sections.includes(c.value); });
        deptBox.querySelectorAll('input').forEach((c) => { c.checked = (u.departments || []).includes(c.value); });
        if (deptWrap) deptWrap.style.display = u.sections.includes('corr') ? '' : 'none';
        if (msg) { msg.textContent = 'Editing ' + u.username + ' — leave password blank to keep it.'; msg.style.color = 'var(--muted)'; }
      }; });
      listEl.querySelectorAll('.adm-del').forEach((b) => { b.onclick = async () => {
        if (!confirm('Delete user "' + b.dataset.u + '"?')) return;
        const rr = await authFetch('/api/users?u=' + encodeURIComponent(b.dataset.u), { method: 'DELETE' });
        const jj = await rr.json().catch(() => ({}));
        if (!rr.ok) { msg.textContent = jj.error || 'Delete failed'; msg.style.color = 'var(--accent-2)'; return; }
        refresh();
      }; });
    };
    const saveBtn = document.getElementById('adm-save');
    if (saveBtn && !saveBtn.dataset.wired) {
      saveBtn.dataset.wired = '1';
      saveBtn.onclick = async () => {
        const username = document.getElementById('adm-user').value.trim();
        const password = document.getElementById('adm-pass').value;
        const isAdmin = document.getElementById('adm-isadmin').checked;
        const sections = [...secBox.querySelectorAll('input:checked')].map((c) => c.value);
        const departments = [...deptBox.querySelectorAll('input:checked')].map((c) => c.value);
        if (msg) msg.textContent = '';
        const r = await authFetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, sections, isAdmin, departments }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { msg.textContent = j.error || 'Save failed'; msg.style.color = 'var(--accent-2)'; return; }
        msg.textContent = 'Saved ✓'; msg.style.color = 'var(--green)';
        clearForm(); refresh();
      };
      document.getElementById('adm-clear').onclick = clearForm;
    }
    refresh();
  }
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html public/js/app.js
git commit -m "feat(letters): admin department picker for correspondence roles"
```

---

### Task 6: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all tests from Tasks 1-2 plus the pre-existing suite.

- [ ] **Step 2: Start the dev server**

Run: `npm run dev` (ensure `ADMIN_USER`, `ADMIN_PASSWORD`, `AUTH_SECRET` are set in your shell or `.env` first, per the existing bootstrap-admin flow)
Expected: `Dev server: http://localhost:3000`

- [ ] **Step 3: Create a department-scoped test user**

Open `http://localhost:3000`, log in as the bootstrap admin, go to the Admin section, create a user `qa.tester` with Sections = Correspondence only, Departments = QA, save.
Expected: user appears in the list with `[QA]` shown next to its Correspondence chip.

- [ ] **Step 4: Verify department filtering as a scoped viewer**

Log out, log in as `qa.tester`, click Correspondence.
Expected: only the letter with `department: "QA/Design"` (`L-002` from the sample fixture) is visible; "+ Add Letter" and "⬇ Import CSV" buttons are not shown; the letter-detail modal shows no Edit/Delete buttons.

- [ ] **Step 5: Verify admin writes round-trip**

Log out, log back in as admin, open Correspondence, add a new letter via "+ Add Letter", wait ~1 second for the "✅ Auto-saved" flash.
Expected: `data/.letters_local.json` now contains the new letter; reloading the page shows it.

- [ ] **Step 6: Verify a write attempt is rejected server-side for a non-admin**

With `qa.tester` still logged in (or using their session token), run:

```bash
curl -s -X POST http://localhost:3000/api/letters -H "Content-Type: application/json" -H "Authorization: Bearer <qa.tester's token>" -d "{\"letters\":[]}"
```

Expected: `{"error":"Admin only"}` with a 403 status.

- [ ] **Step 7: Verify the load-error path**

Temporarily rename `data/sample-letters.json` and `data/.letters_local.json` (if present) out of the way, reload the Correspondence section.
Expected: "✗ Couldn't load data" with a "↻ Retry Load" button. Restore the file(s) afterward.
