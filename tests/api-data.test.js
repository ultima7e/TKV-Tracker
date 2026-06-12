const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPayload } = require('../api/data');

test('buildPayload assembles panels and metadata from local sample file', async () => {
  delete process.env.NUTSTORE_USER; // force local-file fallback
  const payload = await buildPayload();
  assert.equal(typeof payload.generatedAt, 'string');
  assert.equal(payload.source, 'local-file');
  assert.equal(payload.tunnel.tunnels.length, 5);
  assert.equal(payload.executive.kpis['SPI'], 1.05);
  assert.deepEqual(payload.warnings, []);
});
