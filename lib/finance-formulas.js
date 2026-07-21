// Replicates the "IPCs and Details" column formulas from the Milestone Payment
// Summary workbook, so the app can derive every calculated column from the base
// taxable inputs (making data entry a matter of typing only the taxable amounts,
// payment %, dates and letter) and keep the Excel export internally consistent.
//
// Per-row formulas (letters are the source columns):
//   H 13% VAT USD  = F*13%          I 13% VAT NPR  = ROUND(G*13%,2)
//   J Total USD    = F+H            K Total NPR    = G+I
//   L TDS 1.5% USD = -F*1.5%        M TDS 1.5% NPR = -G*1.5%
//   R Retn 5% USD  = -F*5%          S Retn 5% NPR  = -G*5%
//   T VAT30 USD    = -H*30%         U VAT30 NPR    = -I*30%
//   V Net USD      = J+L+R+T        W Net NPR      = K+M+O+Q+S+U
// (N/O advance and P/Q 15%-AP deduction are inputs, default 0.)
const round2 = (v) => Math.round(v * 100) / 100;
const n = (v) => (typeof v === 'number' ? v : (parseFloat(v) || 0));

function computeRow(inp) {
  inp = inp || {};
  const F = n(inp.taxableUSD), G = n(inp.taxableNPR);
  const advanceUSD = n(inp.advanceUSD), advanceNPR = n(inp.advanceNPR);
  const ded15USD = n(inp.ded15USD), ded15NPR = n(inp.ded15NPR);
  const vatUSD = F * 0.13, vatNPR = round2(G * 0.13);
  const totalUSD = F + vatUSD, totalNPR = G + vatNPR;
  const tdsUSD = -F * 0.015, tdsNPR = -G * 0.015;
  const retUSD = -F * 0.05, retNPR = -G * 0.05;
  const vat30USD = -vatUSD * 0.30, vat30NPR = -vatNPR * 0.30;
  const netUSD = totalUSD + tdsUSD + retUSD + vat30USD;
  const netNPR = totalNPR + tdsNPR + advanceNPR + ded15NPR + retNPR + vat30NPR;
  return { taxableUSD: F, taxableNPR: G, vatUSD, vatNPR, totalUSD, totalNPR,
    tdsUSD, tdsNPR, advanceUSD, advanceNPR, ded15USD, ded15NPR,
    retUSD, retNPR, vat30USD, vat30NPR, netUSD, netNPR };
}

// Due date = certified date + 60 days (source: X = E+60).
function dueDatePlus60(certIso) {
  if (!certIso) return null;
  const d = new Date(certIso);
  if (isNaN(d)) return null;
  d.setDate(d.getDate() + 60);
  return d.toISOString().slice(0, 10);
}

// Sum an IPC's rows into a header aggregate (source: header cells = SUM of items).
function sumRows(rows) {
  const keys = ['taxableUSD', 'taxableNPR', 'vatUSD', 'vatNPR', 'totalUSD', 'totalNPR',
    'tdsUSD', 'tdsNPR', 'advanceUSD', 'advanceNPR', 'ded15USD', 'ded15NPR',
    'retUSD', 'retNPR', 'vat30USD', 'vat30NPR', 'netUSD', 'netNPR'];
  const out = {};
  for (const k of keys) out[k] = (rows || []).reduce((s, r) => s + n(r[k]), 0);
  return out;
}

module.exports = { computeRow, dueDatePlus60, sumRows };
