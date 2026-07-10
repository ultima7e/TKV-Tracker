// User store. Production: Upstash Redis / Vercel KV over its REST API (plain
// fetch, no npm dependency). Local dev: a gitignored JSON file, so the whole
// auth feature is testable without provisioning a database.
//
// All users live under ONE key as a JSON blob { [username]: record } — the set
// is tiny and only the admin panel writes to it, so get-modify-set is fine.
const fs = require('fs');
const path = require('path');

const KEY = 'tkv:users';
const restUrl = () => (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
const restTok = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const localFile = path.join(__dirname, '..', 'data', '.users.json');

async function getUsers() {
  const url = restUrl();
  if (url) {
    const r = await fetch(`${url}/get/${KEY}`, { headers: { Authorization: `Bearer ${restTok()}` } });
    if (!r.ok) throw new Error(`KV get failed ${r.status}`);
    const { result } = await r.json();
    return result ? JSON.parse(result) : {};
  }
  try { return JSON.parse(fs.readFileSync(localFile, 'utf8')); } catch { return {}; }
}

async function saveUsers(users) {
  const body = JSON.stringify(users);
  const url = restUrl();
  if (url) {
    const r = await fetch(`${url}/set/${KEY}`, {
      method: 'POST', headers: { Authorization: `Bearer ${restTok()}` }, body,
    });
    if (!r.ok) throw new Error(`KV set failed ${r.status}`);
    return;
  }
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.writeFileSync(localFile, body);
}

module.exports = { getUsers, saveUsers };
