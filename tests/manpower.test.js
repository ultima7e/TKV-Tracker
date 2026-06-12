const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseManpower } = require('../lib/parsers');

function daySheet(engineerSum) {
  // Mirrors the daily sheet: summary tables near the bottom, mobilized at
  // col 0, idle at col 14 with its value columns offset to 20-23.
  const pad = (row, upto) => { while (row.length < upto) row.push(null); return row; };
  const idle = (r, cells) => { pad(r, 14); r.push(...cells); return r; };
  return [
    ['TAMAKOSHI V ...'],
    idle(['Mobilized Manpower'], ['IDLE Manpower']),
    idle(['S.N', 'Manpower Category', 'Foreigner', 'Other Nepali', 'Local Nepali', 'Sum'],
      ['S.N', 'Manpower Category', null, null, null, null, 'Foreigner', 'Other Nepali', 'Local Nepali', 'Sum']),
    idle([1, 'Site Manager', 1, 1, 1, 3], [1, 'Site Manager', null, null, null, null, null, null, null, 0]),
    idle([2, 'Engineer', 14, 32, 11, engineerSum], [2, 'Engineer', null, null, null, null, null, null, null, 0]),
    idle([3, 'Operator/Driver', 0, 10, 67, 77], [3, 'Operator/Driver', null, null, null, null, null, null, 3, 3]),
    idle(['Total', null, 15, 43, 79, 137], ['Total', null, null, null, null, null, 0, 0, 3, 3]),
  ];
}

test('parseManpower reads the latest date-named sheet', () => {
  const mp = parseManpower({
    '2026-06-01': daySheet(999),
    '2026-06-10': daySheet(57),
    'M-S-C-DATA': [['unrelated']],
  });
  assert.deepEqual(mp.warnings, []);
  assert.equal(mp.date, '2026-06-10');
  assert.equal(mp.mobilized.length, 3);
  assert.deepEqual(mp.mobilized[1],
    { category: 'Engineer', foreigner: 14, otherNepali: 32, localNepali: 11, total: 57 });
  assert.deepEqual(mp.mobilizedTotal,
    { foreigner: 15, otherNepali: 43, localNepali: 79, total: 137 });
  // idle keeps only categories with people
  assert.deepEqual(mp.idle,
    [{ category: 'Operator/Driver', foreigner: 0, otherNepali: 0, localNepali: 3, total: 3 }]);
  assert.deepEqual(mp.idleTotal, { foreigner: 0, otherNepali: 0, localNepali: 3, total: 3 });
});

test('parseManpower warns when no date-named sheets exist', () => {
  const mp = parseManpower({ 'Sheet1': [['x']] });
  assert.equal(mp.date, null);
  assert.equal(mp.mobilized.length, 0);
  assert.equal(mp.warnings.length >= 1, true);
});
