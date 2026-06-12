const XLSX = require('xlsx');

// Parse an .xlsx buffer into { [sheetName]: arrayOfRowObjects }.
// defval:null keeps blank cells present so parsers can detect missing data.
function workbookToRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out = {};
  for (const name of wb.SheetNames) {
    out[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null });
  }
  return out;
}

module.exports = { workbookToRows };
