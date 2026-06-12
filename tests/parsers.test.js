const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTunnel, parseKpis } = require('../lib/parsers');

test('parseTunnel computes progress and passes advance through', () => {
  const sheets = {
    'Tunnel Progress': [
      { 'Tunnel': 'Headrace Tunnel', 'Length (m)': 7519, 'Completed (m)': 6300 },
      { 'Tunnel': null, 'Length (m)': null, 'Completed (m)': null }, // blank row ignored
    ],
    'Monthly Advance': [
      { 'Month': 'Apr-26', 'Advance (m)': 215 },
      { 'Month': 'May-26', 'Advance (m)': 235 },
    ],
  };
  const result = parseTunnel(sheets);
  assert.equal(result.tunnels.length, 1);
  assert.equal(result.tunnels[0].name, 'Headrace Tunnel');
  assert.equal(result.tunnels[0].progressPct, 84); // round(6300/7519*100)
  assert.deepEqual(result.monthlyAdvance, [
    { month: 'Apr-26', advanceM: 215 },
    { month: 'May-26', advanceM: 235 },
  ]);
  assert.deepEqual(result.warnings, []);
});

test('parseTunnel warns when sheet is missing instead of throwing', () => {
  const result = parseTunnel({});
  assert.deepEqual(result.tunnels, []);
  assert.equal(result.warnings.length >= 1, true);
});

test('parseKpis maps Indicator/Value rows to a keyed object', () => {
  const sheets = {
    'KPI': [
      { 'Indicator': 'Physical Progress', 'Value': 72.3 },
      { 'Indicator': 'SPI', 'Value': 1.05 },
    ],
  };
  const result = parseKpis(sheets);
  assert.equal(result.kpis['Physical Progress'], 72.3);
  assert.equal(result.kpis['SPI'], 1.05);
  assert.deepEqual(result.warnings, []);
});
