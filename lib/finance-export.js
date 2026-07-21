// Build the "Milestone Payment Summary" workbook from app-entered finance data,
// filling a data-free template that carries the source file's exact title,
// column headers, widths and styles. One header row per IPC followed by its
// activity rows, mirroring the original "IPCs and Details" layout.
const path = require('path');
const ExcelJS = require('exceljs');

const TEMPLATE = path.join(__dirname, '..', 'assets', 'templates', 'milestone-payment-summary.template.xlsx');

// Number formats copied from the source sheet.
const USD = '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)';
const NPR = '#,##0';
const DATE = 'd-mmm-yy';

const num = (v) => (typeof v === 'number' ? v : (parseFloat(v) || 0));
const toDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };

async function buildFinanceWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const ws = wb.getWorksheet('IPCs and Details') || wb.worksheets[0];

  let r = 3; // data starts below the title (1) + header (2)
  const put = (row, col, val, fmt, opts) => {
    const cell = row.getCell(col);
    cell.value = val;
    if (fmt) cell.numFmt = fmt;
    if (opts && opts.bold) cell.font = { bold: true, size: 11, name: 'Calibri' };
  };

  // A row on the sheet: description + the money/date columns we track. VAT (13%)
  // and Total are derived from taxable; TDS (1.5%) likewise, matching the source.
  const writeRow = (o, bold) => {
    const row = ws.getRow(r++);
    const taxU = num(o.taxableUSD), taxN = num(o.taxableNPR);
    const vatU = taxU * 0.13, vatN = taxN * 0.13;
    put(row, 1, o.desc || '', null, { bold });
    if (o.paymentPct != null && o.paymentPct !== '') put(row, 2, num(o.paymentPct) / 100);
    if (o.ipsDate) put(row, 3, toDate(o.ipsDate), DATE);
    if (o.certLetter) put(row, 4, o.certLetter);
    if (o.certDate) put(row, 5, toDate(o.certDate), DATE);
    if (taxU || taxN) {
      put(row, 6, taxU, USD); put(row, 7, taxN, NPR);
      put(row, 8, vatU, USD); put(row, 9, vatN, NPR);
      put(row, 10, taxU + vatU, USD); put(row, 11, taxN + vatN, NPR);
      put(row, 12, -taxU * 0.015, USD); put(row, 13, -taxN * 0.015, NPR);
    }
    if (o.netUSD != null) put(row, 22, num(o.netUSD), USD);
    if (o.netNPR != null) put(row, 23, num(o.netNPR), NPR);
    if (o.recUSD != null) put(row, 26, num(o.recUSD), USD);
    if (o.recNPR != null) put(row, 27, num(o.recNPR), NPR);
    if (o.recDate) { put(row, 28, toDate(o.recDate), DATE); put(row, 29, toDate(o.recDate), DATE); }
    if (o.status) put(row, 32, o.status);
    row.commit && row.commit();
  };

  for (const ipc of (data.ipcs || [])) {
    // IPC header row — aggregate net/received for the certificate.
    writeRow({
      desc: ipc.ipc, certDate: ipc.certifiedDate, certLetter: ipc.certifiedLetter,
      netUSD: ipc.netUSD, netNPR: ipc.netNPR, recUSD: ipc.receivedUSD, recNPR: ipc.receivedNPR,
      recDate: ipc.receivedDate, status: ipc.status,
    }, true);
    for (const it of (ipc.items || [])) {
      writeRow({
        desc: it.code || it.activityName, paymentPct: it.paymentPct,
        taxableUSD: it.taxableUSD, taxableNPR: it.taxableNPR,
        netUSD: it.netUSD, netNPR: it.netNPR,
      }, false);
    }
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { buildFinanceWorkbook };
