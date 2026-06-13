const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseIpc } = require('../lib/parsers');

function makeMatrices() {
  // Mirrors 'IPCs and Details': header row 1, then IPC summary rows mixed
  // with component sub-rows (B.1, F.3 …) that must be ignored. Columns:
  // 0 Description, 4 Certified Date (serial), 21 Net USD, 22 Net NPR, 31 Status.
  const row = (desc, certSerial, netUSD, netNPR, status) => {
    const r = new Array(32).fill(null);
    r[0] = desc; r[4] = certSerial; r[21] = netUSD; r[22] = netNPR; r[31] = status;
    return r;
  };
  return {
    'IPCs and Details': [
      ['Payment Details Summary'],
      ['Description', 'Payment %', null, null, 'Certfied Date'],
      row('IPC-01', 45728, 220778, 13454142, 'Completed'),
      row('B.12.1', 45728, 220778, 13172310, null),       // component — ignore
      row('IPC-02', 45734, 135186, 0, 'Completed'),
      row('IPC-03', 45836, 227983, 14520353, 'Remaining'),
    ],
  };
}

test('parseIpc extracts only IPC summary rows', () => {
  const out = parseIpc(makeMatrices());
  assert.deepEqual(out.warnings, []);
  assert.equal(out.rows.length, 3);
  assert.deepEqual(out.rows[0], {
    ipc: 'IPC-01', certifiedDate: '2025-03-12',
    netUSD: 220778, netNPR: 13454142, status: 'Completed',
  });
  assert.equal(out.rows[2].status, 'Remaining');
  // totals across the three IPCs
  assert.equal(out.total.netUSD, 220778 + 135186 + 227983);
  assert.equal(out.total.netNPR, 13454142 + 0 + 14520353);
  assert.equal(out.total.count, 3);
});

test('parseIpc warns when the sheet is missing', () => {
  const out = parseIpc({});
  assert.equal(out.rows.length, 0);
  assert.equal(out.warnings.length >= 1, true);
});
