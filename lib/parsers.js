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

// ── Finance: Earned Value Calculation workbook (Tamakoshi-V) ──
// Replaces the former Milestone Payment Summary source. Three sheets:
//   'EV Front' – headline earned value (E = A+C+D), contract advance, and the
//                workbook's own Financial-Progress cell (certified vs contract,
//                both incl. Provisional Sum & VAT).
//   'Summary'  – earned value by Activity Schedule (A.1 … J).
//   'IPC-Sum'  – per-IPC certified/received register + advance payments.
// Money always splits USD / NPR; the workbook's implied bridge rate is 133.02
// (contract USD-eq ÷ NPR). All figures come from ONE readEV() pass.
const EV_RATE = 133.02;
const CAT = {
  A: 'Hydro-mechanical Equipment', B: 'Mobilisation & Site', C: 'Headwork Structures',
  D: 'Headrace Tunnel (HRT)', E: 'Surge / Valve / Pressure Shaft', F: 'Powerhouse & Caverns',
  G: 'Outlet & Downstream Waterways', H: 'Outdoor Buildings', I: 'Remaining Civil Works',
  J: 'Design & Engineering',
};

// Single pass over the Earned Value workbook -> the shared finance object all
// three public finance parsers derive from. Label-anchored so it tolerates the
// leading title/spacer rows of each sheet.
function readEV(matrices) {
  const warnings = [];
  const num = (v) => (typeof v === 'number' ? v : 0);
  const serialToIso = (s) =>
    (typeof s === 'number' && s > 30000 && s < 80000
      ? new Date(Math.round((s - 25569) * 86400 * 1000)).toISOString().slice(0, 10) : null);

  const evFront = matrices['EV Front'];
  const summary = matrices['Summary'];
  const ipcSum = matrices['IPC-Sum'];
  if (!evFront || !summary || !ipcSum) {
    warnings.push("Earned Value workbook sheets ('EV Front' / 'Summary' / 'IPC-Sum') not found");
    return { warnings, missing: true };
  }
  const findByCol = (grid, col, re) =>
    grid.find((r) => r && typeof r[col] === 'string' && re.test(r[col]));

  // EV Front — earned value (E = A+C+D, cols 2/3 = USD/NPR), mobilization advance
  // (cols 7/8) and the file's own Financial-Progress fraction.
  const evE = findByCol(evFront, 1, /Earned Value \(A\+C\+D\)/i);
  const advPaid = findByCol(evFront, 6, /Mobilization Advance Paid/i);
  const advBal = findByCol(evFront, 6, /Mobilization Advance Balan/i);
  let progressFrac = null;
  for (const r of evFront) {
    if (!r) continue;
    const j = r.findIndex((c) => typeof c === 'string' && /Financial Progress/i.test(c));
    if (j > 0) { for (let k = j - 1; k >= 0; k--) if (typeof r[k] === 'number') { progressFrac = r[k]; break; } break; }
  }

  // Summary — contract amount (Total Bid Price incl. PS & VAT, cols 2/3) and
  // cumulative earned value per activity (cols 8/9).
  const bid = findByCol(summary, 1, /Total Bid Price/i);
  const workUSD = num(bid && bid[2]);
  const workNPR = num(bid && bid[3]);
  const workUSDEq = workUSD + workNPR / EV_RATE;
  const groups = {};
  for (const r of summary) {
    if (!r || typeof r[0] !== 'string') continue;
    const code = r[0].trim();
    if (!/^[A-J](\.\d+)?$/.test(code)) continue; // activity rows only (skip K–O sub-totals)
    const g = code[0];
    (groups[g] = groups[g] || { usd: 0, npr: 0 });
    groups[g].usd += num(r[8]); groups[g].npr += num(r[9]);
  }
  const earnedByCategory = Object.entries(groups)
    .map(([g, v]) => ({ category: CAT[g] || ('Activity ' + g), usd: v.usd, npr: v.npr, usdEquiv: v.usd + v.npr / EV_RATE }))
    .filter((c) => c.usdEquiv > 0)
    .sort((a, b) => b.usdEquiv - a.usdEquiv);

  // IPC-Sum — per-IPC register. Cols: 0 label, 2 certified-date serial,
  // 7/8 retention withheld, 13/14 net payable (= cash received), 18 status.
  const ipcs = [];
  let advance = null, recUSD = 0, recNPR = 0, retUSD = 0, retNPR = 0;
  for (const r of ipcSum) {
    if (!r || typeof r[0] !== 'string') continue;
    const d = r[0].replace(/\s+/g, ' ').trim();
    if (/^IPC-\d+/i.test(d)) {
      const nU = num(r[13]), nN = num(r[14]);
      ipcs.push({ ipc: d, certifiedDate: serialToIso(r[2]), netUSD: nU, netNPR: nN,
        receivedUSD: nU, receivedNPR: nN,
        status: (typeof r[18] === 'string' && r[18].trim()) || '—', items: [], installments: [] });
      recUSD += nU; recNPR += nN;
      retUSD += Math.abs(num(r[7])); retNPR += Math.abs(num(r[8]));
    } else if (/\bAP$/i.test(d)) { // '1st AP', '2nd AP' -> the mobilization advance
      if (!advance) advance = { ipc: 'Advance Payment', isAdvance: true, certifiedDate: serialToIso(r[2]),
        netUSD: 0, netNPR: 0, receivedUSD: 0, receivedNPR: 0, status: 'Completed', items: [], installments: [] };
      advance.netUSD += num(r[13]); advance.netNPR += num(r[14]);
      advance.receivedUSD += num(r[13]); advance.receivedNPR += num(r[14]);
    }
  }
  if (advance) { ipcs.unshift(advance); recUSD += advance.receivedUSD; recNPR += advance.receivedNPR; }
  if (!ipcs.length) warnings.push('No IPC rows found in IPC-Sum');

  const budget = {
    workUSD, workNPR, workUSDEq,
    completeUSD: num(evE && evE[2]), completeNPR: num(evE && evE[3]),
    completeUSDEq: num(evE && evE[2]) + num(evE && evE[3]) / EV_RATE,
    // The file's own Financial Progress % + the matching certified/outstanding
    // split (USD-equivalent) so the KPI, donut and Outstanding line all agree.
    progressPct: progressFrac != null ? Math.round(progressFrac * 1000) / 10 : null,
    certifiedUsdEq: progressFrac != null ? progressFrac * workUSDEq : null,
    outstandingUsdEq: progressFrac != null ? (1 - progressFrac) * workUSDEq : null,
  };
  const received = { usd: recUSD, npr: recNPR, nprEq: recNPR + recUSD * EV_RATE };
  const advanceSummary = advPaid ? {
    disbursedUSD: num(advPaid[7]), disbursedNPR: num(advPaid[8]),
    recoveredUSD: 0, recoveredNPR: 0,
    outstandingUSD: num(advBal && advBal[7]), outstandingNPR: num(advBal && advBal[8]),
    amortisedPct: 0, monsoonDisbursedNPR: 0, monsoonRecoveredNPR: 0,
  } : null;
  const retention = { usd: retUSD, npr: retNPR };
  return { warnings, budget, received, ipcs, earnedByCategory, advance: advanceSummary, retention };
}

// Top-level finance figures (Executive Summary KPIs).
function parseFinance(matrices) {
  const ev = readEV(matrices);
  if (ev.missing) {
    return { budgetUSD: null, budgetNPR: null, budgetUSDEquiv: null, financialProgressPct: null,
      receivedUSD: null, receivedNPR: null, receivedNPREquiv: null,
      receivedExclAdvUSD: null, receivedExclAdvNPR: null, warnings: ev.warnings };
  }
  const b = ev.budget, rc = ev.received;
  return {
    budgetUSD: b.workUSD, budgetNPR: b.workNPR, budgetUSDEquiv: b.workUSDEq,
    financialProgressPct: b.progressPct,
    receivedUSD: rc.usd, receivedNPR: rc.npr, receivedNPREquiv: rc.nprEq,
    receivedExclAdvUSD: null, receivedExclAdvNPR: null,
    warnings: ev.warnings,
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

// IPC register (Interim Payment Certificates only — the mobilization advance is
// a separate instrument) from the Earned Value workbook's 'IPC-Sum' sheet.
function parseIpc(matrices) {
  const ev = readEV(matrices);
  if (ev.missing) return { rows: [], total: { netUSD: 0, netNPR: 0, count: 0 }, warnings: ev.warnings };
  const rows = ev.ipcs.filter((i) => !i.isAdvance).map((i) => ({
    ipc: i.ipc, certifiedDate: i.certifiedDate, netUSD: i.netUSD, netNPR: i.netNPR, status: i.status,
  }));
  const total = rows.reduce(
    (acc, r) => ({ netUSD: acc.netUSD + r.netUSD, netNPR: acc.netNPR + r.netNPR, count: acc.count + 1 }),
    { netUSD: 0, netNPR: 0, count: 0 }
  );
  return { rows, total, warnings: ev.warnings };
}

// Full financial breakdown for the dedicated Financial panel — budget,
// received totals, earned value by activity, the mobilization advance and the
// per-IPC register. All sourced from the Earned Value workbook via readEV().
function parseFinanceDetail(matrices) {
  const ev = readEV(matrices);
  if (ev.missing) {
    return { budget: {}, received: {}, ipcs: [], earnedByCategory: [],
      advance: null, retention: { usd: 0, npr: 0 }, warnings: ev.warnings };
  }
  return {
    budget: ev.budget, received: ev.received, ipcs: ev.ipcs,
    earnedByCategory: ev.earnedByCategory, advance: ev.advance, retention: ev.retention,
    warnings: ev.warnings,
  };
}

module.exports = { parseTunnel, parseKpis, parseSCurve, parseFinance, parseManpower, parseIpc, parseFinanceDetail };
