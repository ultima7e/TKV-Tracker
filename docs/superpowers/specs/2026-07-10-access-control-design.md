# Access Control + Admin Panel — Design Spec

**Date:** 2026-07-10 · **Status:** approved, building

## Goal
Put the Tamakoshi-V dashboard behind a login so the public can't see it, and let an
admin create user accounts and grant each account access to specific sections.

## Decisions (from brainstorming)
- **Per-user section lists** — each account has its own set of allowed sections.
- **Self-service admin panel** — admin creates users + controls access in-app.
- **UI-level enforcement** — a logged-in user who opens a non-granted section sees
  "Permission not granted". Data is NOT withheld server-side (accepted trade-off).
  The whole-site login is the real protection (stops the public).

## Sections (the 9 nav items)
`exec` Executive Summary · `fin` Financial · `sched` Schedule & Progress · `tunnel`
Tunnel · `claims` Claims & Variations · `inv` Inventory & Explosives · `man` Manpower
· `equip` Equipment · `safety` Safety. (`admin` is an extra admin-only section.)

## Storage
- Runtime-writable store required (Vercel functions are stateless). Use **Upstash
  Redis / Vercel KV REST API** via plain `fetch` (no npm dep). One key `tkv:users`
  holds `{ [username]: { salt, hash, sections:[], isAdmin } }` as JSON (get-modify-set).
- Reads URL/token from `UPSTASH_REDIS_REST_URL`/`_TOKEN` or `KV_REST_API_URL`/`_TOKEN`.
- **Local dev fallback:** gitignored `data/.users.json` when no KV env present, so
  the feature is fully testable locally.

## Auth
- **Passwords:** salted `crypto.scrypt`, stored as `salt:hash` hex; verify with
  `timingSafeEqual`.
- **Session token:** `base64url(payload).base64url(HMAC-SHA256(payload, AUTH_SECRET))`,
  payload `{ u, exp }` (12 h). No JWT lib. Sections/isAdmin are looked up fresh from
  the store per request, so access changes take effect immediately.
- **Delivery:** httpOnly Secure SameSite=Lax cookie for the hosted site; the login
  response also returns the raw token for the standalone file (localStorage + Bearer).
- **Bootstrap admin:** env `ADMIN_USER`/`ADMIN_PASSWORD`. If login matches these it
  authenticates as admin (all sections) even with an empty store, so the first login
  works. Admin then creates real accounts in the panel.

## Endpoints (`api/*`)
- `POST /api/login` `{username,password}` → verify (store or bootstrap) → Set-Cookie +
  `{ ok, username, isAdmin, sections, token }`.
- `POST /api/logout` → clear cookie.
- `GET /api/me` → `{ username, isAdmin, sections }` or 401.
- `GET|POST|DELETE /api/users` (admin only) → list / create-update / delete users.
- `GET /api/data` → now requires a valid session (401 otherwise); payload unchanged.
- Shared helpers in `lib/auth.js` (sign/verify, hash/verify, read token from req,
  requireAuth/requireAdmin) and `lib/store.js` (getUsers/saveUsers).
- `scripts/dev-server.js` generalized to route every `/api/<name>`.

## Frontend (both `public/index.html`+`app.js` and standalone `TamakoshiTracker.html`)
- On load call `/api/me`; 401 → full-screen **login overlay** (username/password), app
  hidden. Success → render app, apply permissions, reveal Admin nav only if `isAdmin`.
- `authFetch` wrapper: same-origin uses the cookie; standalone adds
  `Authorization: Bearer <localStorage token>`.
- Nav gating: clicking a non-granted section shows a **"Permission not granted"** panel.
  Each user lands on their first allowed section. Logout button in the sidebar.
- **Admin panel** (`#admin` section): users table + create form (username, password,
  section checkboxes, isAdmin), edit access, reset password, delete. Calls `/api/users`.

## Out of scope (v1)
Password self-reset / email flows; true server-side per-section data withholding
(can be added later per section); rate-limiting/lockout.

## Prerequisite for the user (at deploy time)
Create a free Vercel KV/Upstash store, connect to the project, and set `ADMIN_USER`,
`ADMIN_PASSWORD`, `AUTH_SECRET` env vars. Build/local-test needs none of this.
