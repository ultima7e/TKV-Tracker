const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseIpc } = require('../lib/parsers');

// Mirrors the Earned Value workbook's 'IPC-Sum' sheet: an advance-payment row
// (excluded from the IPC register) plus IPC rows. Columns: 0 label, 2 certified
// date serial, 13/14 net payable USD/NPR, 18 status.
const mk = (pairs) => { const r = []; for (const [i, v] of pairs) r[i] = v; return r; };
function makeMatrices() {
  return {
    'EV Front': [mk([[1, 'Earned Value (A+C+D)'], [2, 10], [3, 1000]])],
    'Summary': [mk([[1, 'Total Bid Price including Provisional Sum & VAT'], [2, 100], [3, 10000]])],
    'IPC-Sum': [
      mk([[0, 'Description'], [2, 'Certified Date'], [13, 'Net USD'], [14, 'Net NPR'], [18, 'Status']]),
      mk([[0, '1st AP'], [2, 45500], [13, 3], [14, 300]]),                                  // advance — ignored
      mk([[0, 'IPC-01'], [2, 45728], [13, 220778], [14, 13454142], [18, 'Completed']]),
      mk([[0, 'IPC-02'], [2, 45734], [13, 135186], [14, 0], [18, 'Completed']]),
      mk([[0, 'IPC-03'], [2, 45836], [13, 227983], [14, 14520353], [18, 'Remaining']]),
    ],
  };
}

test('parseIpc extracts only the IPC rows (advance excluded)', () => {
  const out = parseIpc(makeMatrices());
  assert.deepEqual(out.warnings, []);
  assert.equal(out.rows.length, 3);
  assert.deepEqual(out.rows[0], {
    ipc: 'IPC-01', certifiedDate: '2025-03-12',
    netUSD: 220778, netNPR: 13454142, status: 'Completed',
  });
  assert.equal(out.rows[2].status, 'Remaining');
  assert.equal(out.total.netUSD, 220778 + 135186 + 227983);
  assert.equal(out.total.netNPR, 13454142 + 0 + 14520353);
  assert.equal(out.total.count, 3);
});

test('parseIpc warns when the EV sheets are missing', () => {
  const out = parseIpc({});
  assert.equal(out.rows.length, 0);
  assert.equal(out.warnings.length >= 1, true);
});
