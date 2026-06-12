const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseFinance } = require('../lib/parsers');

function makeMatrices() {
  return {
    // Sheet name is irrelevant — parser must find the labels anywhere.
    'Sheet2': [
      [null, null, null, null],
      ['Description', 'USD', 'NPR', 'Total (In USD)'],
      ['Total Work Value', 100, 10000, 175],
      ['Complete Work Value', 10, 1000, 17.5],
      ['Outstanding/Unfinished Work Value', 90, 9000, 157.5],
    ],
    'IPCs and Details': [
      ['Payment Details Summary'],
      ['Actual Received-IPCs', 3, 300],
      ['Total Actual Received-AP & IPCs', 5, 500],
      ['Total Received in NPR-IPCs', null, 700],
      ['Total Received in NPR-IPCs & AP', null, 1250],
    ],
  };
}

test('parseFinance extracts budget, received and progress', () => {
  const f = parseFinance(makeMatrices());
  assert.deepEqual(f.warnings, []);
  assert.equal(f.budgetUSD, 100);
  assert.equal(f.budgetNPR, 10000);
  assert.equal(f.budgetUSDEquiv, 175);
  assert.equal(f.receivedUSD, 5);
  assert.equal(f.receivedNPR, 500);
  assert.equal(f.receivedNPREquiv, 1250);
  // 17.5 / 175 = 10%
  assert.equal(f.financialProgressPct, 10);
});

test('parseFinance degrades with warnings when labels are missing', () => {
  const f = parseFinance({});
  assert.equal(f.budgetUSD, null);
  assert.equal(f.warnings.length >= 1, true);
});
