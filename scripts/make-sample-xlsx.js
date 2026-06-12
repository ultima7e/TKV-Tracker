// Generates data/sample.xlsx matching the Phase 1 data contract.
// This file stands in for the user's real workbook during development.
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const wb = XLSX.utils.book_new();

XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['Tunnel', 'Length (m)', 'Completed (m)'],
  ['Headrace Tunnel', 7519, 6300],
  ['Surge Shaft', 566, 408],
  ['Pressure Shaft', 385, 240],
  ['Access Tunnel', 1200, 860],
  ['Tailrace Tunnel', 1302, 1186],
]), 'Tunnel Progress');

XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['Month', 'Advance (m)'],
  ['Nov-25', 168], ['Dec-25', 185], ['Jan-26', 190],
  ['Feb-26', 220], ['Mar-26', 205], ['Apr-26', 215], ['May-26', 235],
]), 'Monthly Advance');

XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['Indicator', 'Value'],
  ['Contract Amount', 98.67],
  ['Financial Progress', 68.45],
  ['Physical Progress', 72.3],
  ['Earned Value', 67.46],
  ['SPI', 1.05],
  ['CPI', 1.02],
]), 'KPI');

const out = path.join(__dirname, '..', 'data', 'sample.xlsx');
fs.mkdirSync(path.dirname(out), { recursive: true });
XLSX.writeFile(wb, out);
console.log('Wrote', out);
