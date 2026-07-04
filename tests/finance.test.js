const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseFinance } = require('../lib/parsers');

// Minimal stand-in for the Earned Value Calculation workbook. Sparse rows mirror
// the real column layout the parser is anchored to (readEV in lib/parsers.js).
const mk = (pairs) => { const r = []; for (const [i, v] of pairs) r[i] = v; return r; };
function makeMatrices() {
  return {
    'EV Front': [
      mk([[1, 'Particulars'], [2, 'Total Earned Value']]),
      mk([[1, 'Earned Value (A+C+D)'], [2, 10], [3, 1000]]),      // EV E: USD 10 / NPR 1000
      mk([[6, 'Mobilization Advance Paid:'], [7, 5], [8, 500]]),
      mk([[6, 'Mobilization Advance Balance:'], [7, 5], [8, 500]]),
      mk([[12, 0.1], [13, 'Financial Progress']]),               // file's own 10%
    ],
    'Summary': [
      mk([[1, 'Total Bid Price including Provisional Sum & VAT'], [2, 100], [3, 10000]]),
      mk([[0, 'B'], [1, 'Mobilisation'], [8, 6], [9, 600]]),
      mk([[0, 'F'], [1, 'Powerhouse'], [8, 4], [9, 400]]),
      mk([[0, 'K'], [1, 'Sub-Total'], [8, 10], [9, 1000]]),      // total row — must be ignored
    ],
    'IPC-Sum': [
      mk([[0, 'Description'], [2, 'Certified Date'], [13, 'Net USD'], [14, 'Net NPR'], [18, 'Status']]),
      mk([[0, '1st AP'], [2, 45500], [13, 3], [14, 300]]),
      mk([[0, 'IPC-01'], [2, 45728], [7, -1], [8, -100], [13, 2], [14, 200], [18, 'Completed']]),
      mk([[0, 'IPC-02'], [2, 45734], [7, -0.5], [8, -50], [13, 1], [14, 0], [18, 'Remaining']]),
    ],
  };
}

test('parseFinance extracts budget, received and the file-computed progress', () => {
  const f = parseFinance(makeMatrices());
  assert.deepEqual(f.warnings, []);
  assert.equal(f.budgetUSD, 100);
  assert.equal(f.budgetNPR, 10000);
  assert.ok(Math.abs(f.budgetUSDEquiv - (100 + 10000 / 133.02)) < 1e-6);
  // Received = advance (3) + IPC-01 (2) + IPC-02 (1) = 6 USD; 300 + 200 + 0 = 500 NPR.
  assert.equal(f.receivedUSD, 6);
  assert.equal(f.receivedNPR, 500);
  // Financial Progress is read straight from the workbook cell (0.1 -> 10%).
  assert.equal(f.financialProgressPct, 10);
});

test('parseFinance degrades with a warning when the EV sheets are missing', () => {
  const f = parseFinance({});
  assert.equal(f.budgetUSD, null);
  assert.equal(f.financialProgressPct, null);
  assert.equal(f.warnings.length >= 1, true);
});
