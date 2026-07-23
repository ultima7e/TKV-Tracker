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

// Same parse but as raw row arrays ({ [sheetName]: cellMatrix }) — for
// matrix-layout sheets (e.g. Primavera exports with months across columns)
// where the first row is not a usable header.
function workbookToMatrices(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out = {};
  for (const name of wb.SheetNames) {
    out[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
  }
  return out;
}

// Parse the buffer ONCE and return both shapes — avoids reading the same
// workbook twice (XLSX.read is the expensive step).
function workbookToBoth(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const rows = {}, matrices = {};
  for (const name of wb.SheetNames) {
    rows[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null });
    matrices[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
  }
  return { rows, matrices };
}

// Convert only the named sheets to matrices — skips converting large unused
// sheets (e.g. a 13k-row equipment list) when a workbook has just one summary
// sheet we care about.
function workbookSheets(buffer, names) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const matrices = {};
  for (const name of names) {
    if (wb.Sheets[name]) matrices[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
  }
  return { matrices };
}

module.exports = { workbookToRows, workbookToMatrices, workbookToBoth, workbookSheets };
