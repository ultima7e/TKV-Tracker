const { test } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { workbookToRows } = require('../lib/workbook');

function makeXlsxBuffer() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Tunnel', 'Length (m)', 'Completed (m)'],
    ['Headrace Tunnel', 7519, 6300],
    ['Surge Shaft', 566, 408],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Tunnel Progress');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('workbookToRows returns row objects keyed by sheet name', () => {
  const rows = workbookToRows(makeXlsxBuffer());
  assert.deepEqual(Object.keys(rows), ['Tunnel Progress']);
  assert.equal(rows['Tunnel Progress'].length, 2);
  assert.deepEqual(rows['Tunnel Progress'][0], {
    'Tunnel': 'Headrace Tunnel',
    'Length (m)': 7519,
    'Completed (m)': 6300,
  });
});
