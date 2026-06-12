const { test } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { workbookToMatrices } = require('../lib/workbook');
const { parseSCurve } = require('../lib/parsers');

// Serials: 45444 = 01-Jun-2024, 45474 = 01-Jul-2024, 45505 = 01-Aug-2024
function makeMscSheet() {
  const rows = [];
  // NB: 'Budgeted Total Cost' also appears as a column header in row 0,
  // exactly like the real Primavera export — the parser must not match it.
  rows[0] = ['Activity ID', 'Activity Name', 'OD', 'Start', 'Finish', 'TF', 'Budgeted Total Cost', 'Spreadsheet Field', 46235, 'Perf-%', 'Spreadsheet Field', 45444, 45474, 45505];
  rows[1] = ['  X', 'Something', 0, null, null, 0, 0, 'Budgeted Total Cost', null, 0, 'Budgeted Total Cost', 100, 200, 100];
  rows[2] = [null];
  rows[8] = ['Activity ID', 'Activity Name', 'Duration', 'Start', 'Finish', 'TF', 'PV', 'EV', 'Sch-%', 'Perf-%', 'Spreadsheet Field', 45444, 45474, 45505];
  rows[9] = ['SCHED', null, 100, 'x', 47353, -1, 400, 150, 0.75, 0.375, 'Earned Value Cost', 50, 100, null];
  return rows;
}

test('workbookToMatrices returns raw row arrays per sheet', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), 'S1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const m = workbookToMatrices(buf);
  assert.deepEqual(m['S1'][0], ['a', 'b']);
  assert.deepEqual(m['S1'][1], [1, 2]);
});

test('parseSCurve builds cumulative planned vs actual percentages', () => {
  const result = parseSCurve({ 'M-S-C-DATA': makeMscSheet() });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.months, ['Jun-24', 'Jul-24', 'Aug-24']);
  // planned: cum 100,300,400 of total 400 -> 25%, 75%, 100%
  assert.deepEqual(result.plannedPct, [25, 75, 100]);
  // actual: cum 50,150 of total 400 -> 12.5%, 37.5%, then null (no data yet)
  assert.deepEqual(result.actualPct, [12.5, 37.5, null]);
});

test('parseSCurve warns when sheet or label rows are missing', () => {
  const noSheet = parseSCurve({});
  assert.equal(noSheet.months.length, 0);
  assert.equal(noSheet.warnings.length >= 1, true);

  const noLabels = parseSCurve({ 'M-S-C-DATA': [['just'], ['junk']] });
  assert.equal(noLabels.months.length, 0);
  assert.equal(noLabels.warnings.length >= 1, true);
});
