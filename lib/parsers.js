// Each parser takes { [sheetName]: rows } and returns data plus a warnings
// array — a missing/renamed sheet degrades that panel, never the whole API.

function parseTunnel(sheets) {
  const warnings = [];

  const progressRows = sheets['Tunnel Progress'];
  let tunnels = [];
  if (!progressRows) {
    warnings.push("Sheet 'Tunnel Progress' not found");
  } else {
    tunnels = progressRows
      .filter((r) => r['Tunnel'] && typeof r['Length (m)'] === 'number')
      .map((r) => {
        const lengthM = r['Length (m)'];
        const completedM = typeof r['Completed (m)'] === 'number' ? r['Completed (m)'] : 0;
        return {
          name: String(r['Tunnel']).trim(),
          lengthM,
          completedM,
          progressPct: lengthM > 0 ? Math.round((completedM / lengthM) * 100) : 0,
        };
      });
  }

  const advanceRows = sheets['Monthly Advance'];
  let monthlyAdvance = [];
  if (!advanceRows) {
    warnings.push("Sheet 'Monthly Advance' not found");
  } else {
    monthlyAdvance = advanceRows
      .filter((r) => r['Month'] && typeof r['Advance (m)'] === 'number')
      .map((r) => ({ month: String(r['Month']).trim(), advanceM: r['Advance (m)'] }));
  }

  return { tunnels, monthlyAdvance, warnings };
}

function parseKpis(sheets) {
  const warnings = [];
  const rows = sheets['KPI'];
  const kpis = {};
  if (!rows) {
    warnings.push("Sheet 'KPI' not found");
  } else {
    for (const r of rows) {
      if (r['Indicator'] != null && r['Value'] != null) {
        kpis[String(r['Indicator']).trim()] = r['Value'];
      }
    }
  }
  return { kpis, warnings };
}

// S-curve from the 'M-S-C-DATA' sheet (Primavera-style matrix layout):
// month date-serials run across columns; the row labelled 'Budgeted Total
// Cost' holds planned monthly cost, 'Earned Value Cost' holds actual.
// Output: cumulative % of total baseline for each month.
function parseSCurve(matrices) {
  const warnings = [];
  const empty = { months: [], plannedPct: [], actualPct: [], warnings };

  const grid = matrices['M-S-C-DATA'];
  if (!grid) {
    warnings.push("Sheet 'M-S-C-DATA' not found");
    return empty;
  }

  // A data row's label cell is followed by monthly values whose HEADER row
  // (directly above) holds Excel date serials (~36k-80k, i.e. 1998-2118).
  // This distinguishes the real data row from rows that merely contain the
  // label as a column header (row 0 of Primavera exports).
  const isSerial = (v) => typeof v === 'number' && v > 36000 && v < 80000;
  const findLabelRow = (label) =>
    grid.findIndex((r, i) => {
      if (!r) return false;
      const col = r.reduce(
        (acc, c, j) => (typeof c === 'string' && c.trim() === label ? j : acc), -1);
      if (col < 0) return false;
      const above = grid[i - 1] || [];
      return isSerial(above[col + 1]) && isSerial(above[col + 2]);
    });
  const planRowIdx = findLabelRow('Budgeted Total Cost');
  const earnRowIdx = findLabelRow('Earned Value Cost');
  if (planRowIdx < 0 || earnRowIdx < 0) {
    warnings.push("'Budgeted Total Cost' / 'Earned Value Cost' rows not found in M-S-C-DATA");
    return empty;
  }

  // Month serials sit in the header row directly above the planned row,
  // starting after the last label cell ('Spreadsheet Field' column).
  const headerRow = grid[planRowIdx - 1] || [];
  const planRow = grid[planRowIdx];
  const earnRow = grid[earnRowIdx];
  const labelCol = planRow.findIndex(
    (c) => typeof c === 'string' && c.trim() === 'Budgeted Total Cost'
  );
  // The label appears twice in some exports; the month data follows the LAST one.
  const lastLabelCol = planRow.reduce(
    (acc, c, i) => (typeof c === 'string' && c.trim() === 'Budgeted Total Cost' ? i : acc),
    labelCol
  );

  const serialToLabel = (s) => {
    const d = new Date(Math.round((s - 25569) * 86400 * 1000));
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    return `${m}-${String(d.getUTCFullYear()).slice(2)}`;
  };

  const months = [];
  const planned = [];
  const actual = [];
  for (let c = lastLabelCol + 1; c < headerRow.length; c++) {
    if (typeof headerRow[c] !== 'number') break;
    months.push(serialToLabel(headerRow[c]));
    planned.push(typeof planRow[c] === 'number' ? planRow[c] : 0);
    actual.push(typeof earnRow[c] === 'number' ? earnRow[c] : null);
  }

  const total = planned.reduce((a, v) => a + v, 0);
  if (!months.length || total <= 0) {
    warnings.push('No monthly baseline data found in M-S-C-DATA');
    return empty;
  }

  const round1 = (v) => Math.round(v * 10) / 10;
  let cum = 0;
  const plannedPct = planned.map((v) => { cum += v; return round1((cum / total) * 100); });

  // Actual stops at the last month that has earned-value data.
  const lastActualIdx = actual.reduce((acc, v, i) => (v != null ? i : acc), -1);
  let cumA = 0;
  const actualPct = actual.map((v, i) => {
    if (i > lastActualIdx) return null;
    cumA += v || 0;
    return round1((cumA / total) * 100);
  });

  return { months, plannedPct, actualPct, warnings };
}

// Finance figures from the Milestone Payment Summary workbook.
// Label-anchored (sheet names are generic like 'Sheet2'): finds rows by
// their first-cell label anywhere in any sheet. Columns after the label:
// USD, NPR, combined USD-equivalent (budget rows) — per the workbook layout.
function parseFinance(matrices) {
  const warnings = [];

  const findRow = (label) => {
    for (const name of Object.keys(matrices)) {
      for (const r of matrices[name]) {
        if (r && typeof r[0] === 'string' && r[0].trim() === label) return r;
      }
    }
    return null;
  };
  const num = (v) => (typeof v === 'number' ? v : null);

  const totalRow = findRow('Total Work Value');
  const completeRow = findRow('Complete Work Value');
  const receivedRow = findRow('Total Actual Received-AP & IPCs');
  const receivedEquivRow = findRow('Total Received in NPR-IPCs & AP');

  if (!totalRow) warnings.push("'Total Work Value' row not found (Milestone Payment Summary)");
  if (!receivedRow) warnings.push("'Total Actual Received-AP & IPCs' row not found (Milestone Payment Summary)");

  const budgetUSD = totalRow ? num(totalRow[1]) : null;
  const budgetNPR = totalRow ? num(totalRow[2]) : null;
  const budgetUSDEquiv = totalRow ? num(totalRow[3]) : null;
  const completeUSDEquiv = completeRow ? num(completeRow[3]) : null;

  const financialProgressPct =
    budgetUSDEquiv && completeUSDEquiv != null
      ? Math.round((completeUSDEquiv / budgetUSDEquiv) * 1000) / 10
      : null;

  return {
    budgetUSD,
    budgetNPR,
    budgetUSDEquiv,
    financialProgressPct,
    receivedUSD: receivedRow ? num(receivedRow[1]) : null,
    receivedNPR: receivedRow ? num(receivedRow[2]) : null,
    receivedNPREquiv: receivedEquivRow ? num(receivedEquivRow[2]) : null,
    warnings,
  };
}

// Daily manpower workbook: one sheet per day named YYYY-M-D (zero padding
// varies). Always reads the latest date. Each sheet ends with two summary
// tables side by side — 'Mobilized Manpower' and 'IDLE Manpower' — whose
// value columns (Foreigner / Other Nepali / Local Nepali / Sum) are located
// from the header row, since the idle table's columns are offset by merges.
function parseManpower(matrices) {
  const warnings = [];
  const empty = {
    date: null, mobilized: [], mobilizedTotal: null,
    idle: [], idleTotal: null, warnings,
  };

  const datePat = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
  let latest = null;
  for (const name of Object.keys(matrices)) {
    const m = datePat.exec(name.trim());
    if (!m) continue;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (!latest || t > latest.t) latest = { name, t };
  }
  if (!latest) {
    warnings.push('No date-named manpower sheet (YYYY-MM-DD) found');
    return empty;
  }
  const grid = matrices[latest.name];

  const labelRowIdx = grid.findIndex((r) =>
    r && r.some((c) => typeof c === 'string' && c.trim() === 'Mobilized Manpower'));
  if (labelRowIdx < 0) {
    warnings.push(`'Mobilized Manpower' table not found in sheet ${latest.name}`);
    return empty;
  }
  const labelRow = grid[labelRowIdx];
  const header = grid[labelRowIdx + 1] || [];
  const findCol = (label, from, to) => {
    for (let j = from; j < Math.min(to, header.length); j++) {
      if (typeof header[j] === 'string' && header[j].trim() === label) return j;
    }
    return -1;
  };
  const num = (v) => (typeof v === 'number' ? v : 0);

  const colOf = (txt) => labelRow.findIndex(
    (c) => typeof c === 'string' && c.trim() === txt);
  const startM = colOf('Mobilized Manpower');
  const startI = colOf('IDLE Manpower');

  const readTable = (start, end) => {
    const cat = findCol('Manpower Category', start, end);
    const cols = ['Foreigner', 'Other Nepali', 'Local Nepali', 'Sum']
      .map((h) => findCol(h, start, end));
    if (cat < 0 || cols.some((c) => c < 0)) return null;
    const rows = [];
    let total = null;
    for (let i = labelRowIdx + 2; i < grid.length; i++) {
      const r = grid[i] || [];
      const sn = r[start];
      if (typeof sn === 'string' && sn.trim() === 'Total') {
        total = { foreigner: num(r[cols[0]]), otherNepali: num(r[cols[1]]),
          localNepali: num(r[cols[2]]), total: num(r[cols[3]]) };
        break;
      }
      const category = r[cat];
      if (typeof category !== 'string' || !category.trim()) continue;
      rows.push({ category: category.trim(),
        foreigner: num(r[cols[0]]), otherNepali: num(r[cols[1]]),
        localNepali: num(r[cols[2]]), total: num(r[cols[3]]) });
    }
    return { rows, total };
  };

  const mob = readTable(startM, startI > startM ? startI : Infinity);
  const idl = startI >= 0 ? readTable(startI, Infinity) : null;
  if (!mob) {
    warnings.push(`Could not read Mobilized Manpower columns in sheet ${latest.name}`);
    return empty;
  }

  return {
    date: latest.name,
    mobilized: mob.rows,
    mobilizedTotal: mob.total,
    idle: idl ? idl.rows.filter((r) => r.total > 0) : [],
    idleTotal: idl ? idl.total : null,
    warnings,
  };
}

module.exports = { parseTunnel, parseKpis, parseSCurve, parseFinance, parseManpower };
