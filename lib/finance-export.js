// Build the "Milestone Payment Summary" workbook from app-entered finance data,
// filling a data-free template that carries the source file's exact title,
// column headers, widths and styles. One header row per IPC followed by its
// activity rows, mirroring the original "IPCs and Details" layout.
const path = require('path');
const ExcelJS = require('exceljs');
const { computeRow, dueDatePlus60, sumRows } = require('./finance-formulas');

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

  // Writes the full 32-column row. The taxable→net breakdown (VAT, Total, TDS,
  // Retention, VAT-30% deduction) is written only when taxable is present and is
  // computed via the source formulas; Net is always written (computed when
  // taxable is present, otherwise the entered/aggregate net).
  const writeRow = (o, bold) => {
    const row = ws.getRow(r++);
    put(row, 1, o.desc || '', null, { bold });
    if (o.paymentPct != null && o.paymentPct !== '') put(row, 2, num(o.paymentPct) / 100);
    if (o.ipsDate) put(row, 3, toDate(o.ipsDate), DATE);
    if (o.certLetter) put(row, 4, o.certLetter);
    if (o.certDate) put(row, 5, toDate(o.certDate), DATE);
    const c = o.agg || computeRow(o);
    const hasTax = !!(c.taxableUSD || c.taxableNPR);
    if (hasTax) {
      put(row, 6, c.taxableUSD, USD); put(row, 7, c.taxableNPR, NPR);
      put(row, 8, c.vatUSD, USD); put(row, 9, c.vatNPR, NPR);
      put(row, 10, c.totalUSD, USD); put(row, 11, c.totalNPR, NPR);
      put(row, 12, c.tdsUSD, USD); put(row, 13, c.tdsNPR, NPR);
      if (c.advanceUSD) put(row, 14, c.advanceUSD, USD); if (c.advanceNPR) put(row, 15, c.advanceNPR, NPR);
      if (c.ded15USD) put(row, 16, c.ded15USD, USD); if (c.ded15NPR) put(row, 17, c.ded15NPR, NPR);
      put(row, 18, c.retUSD, USD); put(row, 19, c.retNPR, NPR);
      put(row, 20, c.vat30USD, USD); put(row, 21, c.vat30NPR, NPR);
    }
    const netU = hasTax ? c.netUSD : num(o.netUSD), netN = hasTax ? c.netNPR : num(o.netNPR);
    if (netU) put(row, 22, netU, USD);
    if (netN) put(row, 23, netN, NPR);
    if (o.dueDate) put(row, 24, toDate(o.dueDate), DATE);
    if (o.exchangeRate) put(row, 25, num(o.exchangeRate));
    if (o.recUSD) put(row, 26, num(o.recUSD), USD);
    if (o.recNPR) put(row, 27, num(o.recNPR), NPR);
    if (o.recDate) { put(row, 28, toDate(o.recDate), DATE); put(row, 29, toDate(o.recDate), DATE); }
    if (o.status) put(row, 32, o.status);
    row.commit && row.commit();
  };

  for (const ipc of (data.ipcs || [])) {
    if (ipc.isAdvance) continue; // advance is tracked separately in the source layout
    const computed = (ipc.items || []).map((it) => computeRow(it));
    const agg = sumRows(computed);
    // If items carried no taxable, their computed net is 0 — fall back to the
    // entered per-item nets, else the IPC's own net.
    if (!agg.netUSD && !agg.netNPR) {
      agg.netUSD = (ipc.items || []).reduce((s, it) => s + num(it.netUSD), 0) || num(ipc.netUSD);
      agg.netNPR = (ipc.items || []).reduce((s, it) => s + num(it.netNPR), 0) || num(ipc.netNPR);
    }
    writeRow({
      desc: ipc.ipc, certLetter: ipc.certifiedLetter, certDate: ipc.certifiedDate,
      dueDate: ipc.dueDate || dueDatePlus60(ipc.certifiedDate), exchangeRate: ipc.exchangeRate,
      agg, recUSD: ipc.receivedUSD, recNPR: ipc.receivedNPR, status: ipc.status,
    }, true);
    for (const it of (ipc.items || [])) {
      writeRow({ desc: it.code || it.activityName, paymentPct: it.paymentPct,
        taxableUSD: it.taxableUSD, taxableNPR: it.taxableNPR, netUSD: it.netUSD, netNPR: it.netNPR,
        advanceUSD: it.advanceUSD, advanceNPR: it.advanceNPR, ded15USD: it.ded15USD, ded15NPR: it.ded15NPR }, false);
    }
  }

  return wb.xlsx.writeBuffer();
}

module.exports = { buildFinanceWorkbook };
