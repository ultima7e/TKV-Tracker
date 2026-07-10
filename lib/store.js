// Key-value store over Upstash Redis / Vercel KV (plain fetch, no npm dep).
// Local dev falls back to gitignored JSON files under data/, so every feature
// that persists (users, an uploaded schedule) is testable without a database.
const fs = require('fs');
const path = require('path');

const restUrl = () => (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
const restTok = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const localPath = (key) => path.join(__dirname, '..', 'data', '.' + key.replace(/[^a-z0-9]+/gi, '_') + '.json');

// Generic string get/set/del. Returns null when a key is absent.
async function kvGet(key) {
  const url = restUrl();
  if (url) {
    const r = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${restTok()}` } });
    if (!r.ok) throw new Error(`KV get failed ${r.status}`);
    const { result } = await r.json();
    return result; // string or null
  }
  try { return fs.readFileSync(localPath(key), 'utf8'); } catch { return null; }
}

async function kvSet(key, value) {
  const url = restUrl();
  if (url) {
    const r = await fetch(`${url}/set/${key}`, { method: 'POST', headers: { Authorization: `Bearer ${restTok()}` }, body: value });
    if (!r.ok) throw new Error(`KV set failed ${r.status}`);
    return;
  }
  fs.mkdirSync(path.dirname(localPath(key)), { recursive: true });
  fs.writeFileSync(localPath(key), value);
}

async function kvDel(key) {
  const url = restUrl();
  if (url) {
    const r = await fetch(`${url}/del/${key}`, { method: 'POST', headers: { Authorization: `Bearer ${restTok()}` } });
    if (!r.ok && r.status !== 404) throw new Error(`KV del failed ${r.status}`);
    return;
  }
  try { fs.unlinkSync(localPath(key)); } catch { /* already absent */ }
}

const USERS_KEY = 'tkv:users';
async function getUsers() { const v = await kvGet(USERS_KEY); return v ? JSON.parse(v) : {}; }
async function saveUsers(users) { await kvSet(USERS_KEY, JSON.stringify(users)); }

module.exports = { getUsers, saveUsers, kvGet, kvSet, kvDel };
