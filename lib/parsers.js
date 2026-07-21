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

// Per-activity detail: the EV workbook carries one 'ACS_<code>' sheet per
// Activity Schedule (ACS_D = Headrace Tunnel -> rows D.1…D.8). Cols: 0 code,
// 1 description, 7/8 contract USD/NPR, 13/14 cumulative earned USD/NPR.
// The parent header row (e.g. 'D') and the Grand Total row carry no contract
// amount, so requiring one filters both out. Keyed by activity-group letter so
// it merges straight onto earnedByCategory.
function parseAcsItems(matrices) {
  const num = (v) => (typeof v === 'number' ? v : 0);
  const byGroup = {};
  for (const name of Object.keys(matrices)) {
    if (!/^ACS_[A-J]\d?$/i.test(name)) continue;
    const grid = matrices[name];
    if (!Array.isArray(grid)) continue;
    for (const r of grid) {
      if (!r || typeof r[0] !== 'string') continue;
      const code = r[0].trim();
      // Codes nest to three levels (D.1, A1.1, B.12.1). A row that carries no
      // contract amount is a parent header (B.12) or the Grand Total — its
      // value lives on the children, so skipping it also avoids double-counting.
      if (!/^[A-J]\d*(\.\d+)+$/.test(code)) continue;
      if (typeof r[7] !== 'number' && typeof r[8] !== 'number') continue;
      const usd = num(r[13]), npr = num(r[14]);
      const g = code[0].toUpperCase();
      (byGroup[g] = byGroup[g] || []).push({
        code, name: String(r[1] || '').replace(/\s+/g, ' ').trim(),
        contractUSD: num(r[7]), contractNPR: num(r[8]),
        contractUsdEq: num(r[7]) + num(r[8]) / EV_RATE,
        usd, npr, usdEquiv: usd + npr / EV_RATE,
      });
    }
  }
  // Biggest contributor first — the panel answers "what drove this category?".
  for (const g of Object.keys(byGroup)) {
    byGroup[g].sort((a, b) => b.usdEquiv - a.usdEquiv || a.code.localeCompare(b.code));
  }
  return byGroup;
}

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
  const acsItems = parseAcsItems(matrices);
  const earnedByCategory = Object.entries(groups)
    .map(([g, v]) => ({ group: g, category: CAT[g] || ('Activity ' + g), usd: v.usd, npr: v.npr,
      usdEquiv: v.usd + v.npr / EV_RATE, items: acsItems[g] || [] }))
    .filter((c) => c.usdEquiv > 0)
    .sort((a, b) => b.usdEquiv - a.usdEquiv);

  // IPC-Sum — per-IPC register. Cols: 0 label, 2 certified-date serial,
  // 7/8 retention withheld, 13/14 net payable (= cash received), 18 status.
  // Manual status overrides for IPCs certified after the source file's last
  // export (removed once the workbook itself reflects them).
  const STATUS_OVERRIDE = { 'IPC-11': 'Completed' };
  const ipcs = [];
  let advance = null, recUSD = 0, recNPR = 0, retUSD = 0, retNPR = 0;
  for (const r of ipcSum) {
    if (!r || typeof r[0] !== 'string') continue;
    const d = r[0].replace(/\s+/g, ' ').trim();
    if (/^IPC-\d+/i.test(d)) {
      const nU = num(r[13]), nN = num(r[14]);
      ipcs.push({ ipc: d, certifiedDate: serialToIso(r[2]), netUSD: nU, netNPR: nN,
        receivedUSD: nU, receivedNPR: nN,
        status: STATUS_OVERRIDE[d] || (typeof r[18] === 'string' && r[18].trim()) || '—', items: [], installments: [] });
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

// Activity Schedule (ACS) — code -> activity name, from the contract BoQ. Used
// to label each IPC work item with its real activity and group it by activity.
  const ACS_NAMES = {
    "A.1": "All Hydro-mechanical equipment, including HRT & High-Pressure Shaft Steel Liner, and…",
    "A1.1": "One Flap Gate in the Spillway Terminal Structure, Related auxiliary plant to provide…",
    "A1.2": "One Headrace Adit Gate, Related auxiliary plant to provide complete, ready for service…",
    "A1.3": "One Butterfly Valve in the Valve Chamber, Related auxiliary plant to provide complete…",
    "A1.4": "One Overhead Bridge Crane in the Valve Chamber, Related auxiliary plant to provide…",
    "A1.5": "One Mobile Crane (Powerhouse Main Machine Hall Crane) Related auxiliary plant to…",
    "A1.6": "One Fixed-Wheel Gate in the (tailrace) Outlet Structure, Related auxiliary plant to…",
    "A1.7": "One Tailrace Rack in the Outlet Structure, Related auxiliary plant to provide complete…",
    "A1.8": "All necessary Water Level Measuring Devices.",
    "A1.9": "Pressure Shaft steel lining, including lining from downstream of Surge Tank and…",
    "A1.10": "Pressure Tunnel steel lining, Related auxiliary plant to provide complete, ready for…",
    "A1.11": "High Pressure steel lining, Related auxiliary plant to provide complete, ready for…",
    "A1.12": "Upstream Manifolds steellining, Related auxiliary plant to provide complete, ready for…",
    "A1.13": "All remaining steel lining, fittings and embedded parts, Related auxiliary plant to…",
    "A1.14": "All other Hydromechanical equipment in the project, Related auxiliary plant to provide…",
    "A1.15": "All Electrical Equipment's controls for Hydromechanical works.",
    "A1.16": "All Hydromechanical equipment required for Interconnection with Upper Tamakoshi…",
    "A.2": "Transportation of all locally manufactured or Importation of all Hydro-mechanical…",
    "A2.1": "Transportation of all Hydromechanical equipment including, HRT & High-Pressure Shaft…",
    "A2.2": "Transportation of all Hydromechanical equipment for Inter-connection with Upper…",
    "A.3": "Commissioning of all Hydromechanical equipment& Power Waterways filled & tested, ready…",
    "A.3.1": "Fabrication, Transportation of fabricated to the site, Erection, Testing and…",
    "A.3.2": "Fabrication, Transportation of fabricated to the site, Erection, Testing and…",
    "A.3.3": "Training of Employer's persons.",
    "A.3.4": "Design liaison meeting and Factory acceptance tests",
    "A.3.5": "Power Waterways filled & tested, ready for Wet Testing of Turbines",
    "B": "Mobilisation, Site Installation and Facilities, Site Facilities and Services for the…",
    "B.1": "Mobilization of key personnel and Construction Equipment at Site.",
    "B.2": "Establishment of Site Installation and Facilities including Aggregate plant and…",
    "B.3": "Establishment of Site Facilities and Services for the Employer and Contractor's use.…",
    "B.4": "Establishment of the facilities covered by the Material Testing Laboratory, site…",
    "B.5": "Regular services and maintenance of the facilities as per the Employer's Requirements.",
    "B.6": "Construction of Access Roads to i) Initial access to construction site for bridge…",
    "B.7": "Excavation and support of the branch-off for Adit 1 from the access tunnel to the valve…",
    "B.8": "Completion of access road for Adit 2, and excavation and support of the portal for Adit 2",
    "B.9": "Completion of access road for Adit 3, and excavation and support of the portal for Adit 3",
    "B.10": "Completion of access road for Adit 4, and excavation and support ofthe portal for Adit 4.",
    "B.11": "Excavation and installation, testing and maintenance of all necessary rock support…",
    "B.12": "Insurance for the loss of damage to works, plants, Materials, Equipment's Property and…",
    "B.12.1": "Submission of Insurance Policy and Proof of Premium Payment for events under…",
    "B.12.2": "Submission of Property Insurance Policies and Proof of Premium Payment for the…",
    "C": "Headwork Structures including Connecting Tunnel, Access to Spillway Tunnel, Spillway…",
    "C.1": "Headworks Tunnels: Concreting of existing UTKHEP's Connecting Tunnel, from Gate Chamber…",
    "C.2": "Headworks Tunnels: Excavation and support of Connecting Tunnel from start of Tamakoshi…",
    "C.3": "Headworks Tunnels: Concreting of Connecting Tunnel from start of Tamakoshi V to start…",
    "C.4": "Headworks Tunnels: Excavation and support of Headpond, including Spillway, Spillway…",
    "C.5": "Нeadworks Structures: Concreting and completion of Headpond, including Spillway…",
    "C.6": "Headworks Structures: Excavation and support of Spillway Tunnel, from Headpond to…",
    "C.7": "Headworks Structures: Concreting and completion of Spillway Tunnel, from Headpond to…",
    "C.8": "Headworks Structures: Excavation and rock support for Spillway Terminal Structure…",
    "C.9": "Headworks Structures: Concreting and completion of Spillway Terminal Structure…",
    "D": "Completion of Headrace Tunnel (HRT).",
    "D.1": "Excavation and installation. testing and maintenance of all necessary rock support…",
    "D.2": "Excavation and installation, testing and maintenance of all necessary rock support…",
    "D.3": "Excavation and installation, testing and maintenance of all necessary rock support…",
    "D.4": "Excavation and installation, testing and maintenance of all necessary rock support…",
    "D.5": "Concreting and completion of Headrace Tunnel (HRT), between fix point HRT-00 and…",
    "D.6": "Concreting and completion of Headrace Tunnel (HRT), between fix point HRT-A2 and…",
    "D.7": "Concreting and completion of Headrace Tunnel (HRT), between fix point HRT-A3 and…",
    "D.8": "Concreting and completion of Headrace Tunnel (HRT), from fix point HRT-A4 to start of…",
    "E": "Completion of Surge Tank, Valve Chamber, Pressure Shaft, High Pressure Shaft & Upstream…",
    "E.1": "Excavation and installation, testing and maintenance of all necessary Rock Support of…",
    "E.2": "Concreting and completion of Surge Tank, including Connecting Shaft to HRT and Surge…",
    "E.3": "Excavation and installation. testing and maintenance of all necessary rock support…",
    "E.4": "Concreting and completion of Valve Chamber, including backfill concreting of tunnel…",
    "E.5": "Excavation and installation, testing and maintenance of all necessary rock support…",
    "E.6": "Steel liner embedding by backfill concreting of the Pressure Shaft (dia. 4.2 m) from…",
    "E.7": "Grouting behind steel lining for this section of the Pressure Shaft (dia. 4.2 m) from…",
    "E.8": "Excavation and installation, testing and maintenance of all necessary rock support…",
    "E.9": "Steel liner embedding by backfill concreting of the HighPressure Tunnel (dia. 4.2 m)…",
    "E.10": "Grouting behind steel lining for this section of the HighPressure Tunnel (dia. 4.2 m)…",
    "E.11": "Excavation and installation. testing and maintenance of all necessary rock support…",
    "E.12": "Steel liner embedding by backfill concreting of Upstream Manifolds from first upstream…",
    "E.13": "Grouting behind steel lining for the Upstream Manifolds from first upstream bifurcation…",
    "F": "Construction of Powerhouse, Transformer Cavern including Galleries & Erection Service…",
    "F.1": "Excavation and installation, testing and maintenance of all necessary rock support…",
    "F.2": "Concreting/lining of the Main Access Tunnel (MAT), TC-Tunnel and the Cable and…",
    "F.3": "Excavation and Rock Support for the Powerhouse Cavern. Included are all dewatering…",
    "F.4": "Excavation and Rock Support for the Transformer cavern (TrafoCavern). Included are all…",
    "F.5": "Excavation and support of all tunnels servicing the Powerhouse Cavern and Trafo-Cavern…",
    "F.6": "Stage one, Stage 2 and All concreting of the Erection (Service) Bay in the Powerhouse…",
    "F.7": "Stage one concreting, Runway free for the Construction Crane over all of Unit 1 Block…",
    "F.8": "Stage one concreting, Runway free for the Construction Crane over all of Unit 2 Block…",
    "F.9": "Stage one concreting, Runway free for the Construction Crane over all of Unit 3 Block…",
    "F.10": "Stage one concreting, Runway free for the Construction Crane over all of Unit 4 Block…",
    "F.11": "Stage one concreting of Transformer Floor, Stage one concreting of GIS Floor and All…",
    "F.12": "The Permanent Service Tunnels will be fully completed, including the construction of a…",
    "F.13": "Finishing works including Architectural works of Powerhouse Station complete.",
    "G": "Construction of Outlet Structures and Downstream Power Waterways consisting of…",
    "G.1": "Excavation and installation, testing and maintenance of all necessary rock support…",
    "G.2": "Excavation and installation. testing and maintenance of all necessary Rock Support for…",
    "G.3": "Excavation and installation, testing and maintenance of all necessary Rock Support for…",
    "G.4": "Concreting and completion of the Tailrace Tunnel, including concreting of the…",
    "G.5": "Excavation and Rock support, concreting of Outlet (Tailrace) Structure, Included are…",
    "H": "Outdoor Buildings, including Operation Building, Terminal and Ventilation Building…",
    "H.1": "Excavation, support, concreting and completion of the Terminal and Ventilation…",
    "H.2": "Excavation, concreting, finishing and completion of Take Off Yard including all…",
    "H.3": "Excavation, concreting, finishing and completion of Bypass Switching Station including…",
    "H.4": "Excavation, concreting, finishing and completion of Operation Building including all…",
    "H.5": "Excavation, concreting, finishing and completion of Workshop Building, including all…",
    "H.6": "Excavation, concreting, finishing and completion of Sewage Treatment Plant including…",
    "I": "Remaining Civil Works including invert Concreting and Concrete Plug of Access Tunnel…",
    "I.1": "Remaining civil works, including architectural works, landscaping, permanent drainage…",
    "I.2": "Invert Concreting and Concrete Plugs in the Access Tunnel and Adits",
    "I.3": "Civil works related to the Interconnection with Upper Tamakoshi Hydroelectric Project.",
    "I.4": "Completion of demobilisation, removal of surplus materials and construction equipment…",
    "J": "Scope of services under Planning, Design & Engineering and Survey Works and Geological…",
    "J.1": "Project Assessment Report and Updated Construction Schedule",
    "J.2": "Concept Design including, Project Layout, Hydraulic Design, Structural Design…",
    "J.3": "Detailed Design consisting of, not limited to, Headworks, HRT, Surge Shaft, Valve…",
    "J.4": "Construction Design consisting of, not limited to, Headworks, HRT, Surge Shaft, Valve…",
    "J.5": "As-Built Documentation.",
    "J.6": "Survey works and Geological not limited to, Topographical test, Geomechanical test in…",
  };
// Resolve an IPC item code to its ACS name, tolerating missing dots (E11 -> E.11).
function acsName(code) {
  return ACS_NAMES[code] || ACS_NAMES[String(code).replace(/^([A-Z])(\d)/, '$1.$2')] || '';
}

// Per-IPC work-item breakdown (grouped Activity -> sub-activity) from the
// Milestone Summary Details workbook's 'IPCs and Details' sheet. This is the
// ONLY place the IPC -> sub-activity mapping lives (the Earned Value workbook
// carries no per-IPC item detail). Live: adding item rows for a new IPC there
// makes them appear in the tracker. Returns { [ipcKey]: {items, installments} }.
function parseIpcItems(matrices) {
  const grid = matrices['IPCs and Details'];
  if (!grid) return {};
  const num = (v) => (typeof v === 'number' ? v : 0);
  const serialToIso = (s) =>
    (typeof s === 'number' && s > 30000 && s < 80000
      ? new Date(Math.round((s - 25569) * 86400 * 1000)).toISOString().slice(0, 10) : null);
  // Payment % cells hold a fraction (0.33 = 33%). Negative fractions are real
  // (a clawback/adjustment, e.g. B.1 at -0.1 = -10% in IPC-07); the |v|<=1.5
  // bound still rejects footer rows that dump a large amount in this column.
  const pct = (v) => (typeof v === 'number' && v >= -1.5 && v <= 1.5 ? Math.round(v * 100) : null);
  const key = (s) => { const m = String(s).match(/IPC[- ]?0*(\d+)/i); return m ? 'IPC-' + m[1] : null; };
  const byIpc = {};
  let cur = null;
  for (const r of grid) {
    if (!r || typeof r[0] !== 'string') continue;
    const d = r[0].replace(/\s+/g, ' ').trim();
    if (!d) continue;
    // Stop at the trailing summary/total block.
    if (/ipcs|^total\b|^actual received|^certified|^net amount|^grand/i.test(d)) break;
    if (/^IPC-\d+/i.test(d)) { cur = { items: [], installments: [] }; byIpc[key(d)] = cur; }
    else if (/^Advance Payment/i.test(d)) { cur = null; } // advance comes from the EV workbook
    else if (/partial|remaining/i.test(d)) {
      if (cur) cur.installments.push({ label: d, date: serialToIso(r[28]) || serialToIso(r[27]),
        amountUSD: num(r[25]), amountNPR: num(r[26]) });
    } else if (cur && (num(r[21]) || num(r[22]) || typeof r[1] === 'number')) {
      const grp = d[0].toUpperCase();
      cur.items.push({ code: d, category: CAT[grp] || 'Other', activityName: acsName(d), activityGroup: grp,
        activityGroupName: ACS_NAMES[grp] || CAT[grp] || ('Activity ' + grp),
        paymentPct: pct(r[1]), netUSD: num(r[21]), netNPR: num(r[22]) });
    }
  }
  return byIpc;
}

// Full financial breakdown for the dedicated Financial panel. Headline figures
// (budget, received, earned value by activity, advance, retention) and the IPC
// register come from the Earned Value workbook (readEV); each IPC's sub-activity
// work items are merged in from the Milestone Summary Details workbook.
function parseFinanceDetail(matrices) {
  const ev = readEV(matrices);
  if (ev.missing) {
    return { budget: {}, received: {}, ipcs: [], earnedByCategory: [],
      advance: null, retention: { usd: 0, npr: 0 }, warnings: ev.warnings };
  }
  const itemsByIpc = parseIpcItems(matrices);
  const norm = (s) => { const m = String(s).match(/IPC[- ]?0*(\d+)/i); return m ? 'IPC-' + m[1] : null; };
  // The current Milestone workbook's per-sub-activity breakdown stops before
  // IPC-11 (its IPC-11 tab carries only the net total). Fill IPC-11's work items
  // from its known sub-activity split, which sums to the certified total
  // (0.647M USD / 37.715M NPR). Remove this once the source workbook lists them.
  const mkItem = (code, netUSD, netNPR, paymentPct) => {
    const grp = code[0].toUpperCase();
    return { code, category: CAT[grp] || 'Other', activityName: acsName(code), activityGroup: grp,
      activityGroupName: ACS_NAMES[grp] || CAT[grp] || ('Activity ' + grp),
      paymentPct, netUSD, netNPR };
  };
  const MANUAL_ITEMS = {
    'IPC-11': [
      mkItem('A.3.3', 16000, 0, 15),
      mkItem('B.11', 387000, 24716000, 20),
      mkItem('D.1', 204000, 13000000, 5),
      mkItem('J.3', 40000, 0, 5),
    ],
  };
  for (const i of ev.ipcs) {
    const nk = norm(i.ipc);
    const hit = itemsByIpc[nk];
    if (hit) { i.items = hit.items; i.installments = hit.installments; }
    if ((!i.items || !i.items.length) && MANUAL_ITEMS[nk]) i.items = MANUAL_ITEMS[nk];
  }
  return {
    budget: ev.budget, received: ev.received, ipcs: ev.ipcs,
    earnedByCategory: ev.earnedByCategory, advance: ev.advance, retention: ev.retention,
    warnings: ev.warnings,
  };
}

// Claims & Variations register — parsed from the Claim & Variation Log workbook
// (a separate Nutstore file from the finance sources). Drives the Claims panel
// live: the 'Claim Summary' sheet is the complete claim register, 'Variation'
// lists variation notices, and 'T. Claim Amount' carries the headline totals.
function parseClaims(matrices) {
  const warnings = [];
  const summary = matrices['Claim Summary'];
  if (!summary) { warnings.push("Claims workbook: 'Claim Summary' sheet not found"); return { warnings, missing: true }; }
  const num = (v) => (typeof v === 'number' ? v : 0);
  const txt = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

  // Status: the Status column is authoritative; only fall back to Remarks when
  // it is blank (e.g. SoC #1, whose verdict lives in a "Rejected by Engineer"
  // remark). Keep "Not Approved" and "Rejected" distinct — the sheet uses both.
  const map = (s) => {
    if (/not\s*approv/i.test(s)) return 'Not Approved';
    if (/reject/i.test(s)) return 'Rejected';
    if (/approv|receiv|grant|settl/i.test(s)) return 'Approved';
    if (/ongoing|estimat|prepar|review|pending|await/i.test(s)) return 'Under review';
    if (/submit/i.test(s)) return 'Submitted';
    return null;
  };
  const statusOf = (statusCell, remarks) => map(txt(statusCell)) || (txt(statusCell) ? txt(statusCell) : map(txt(remarks))) || 'Under review';

  // The Claim Summary has no contractual-basis column, so infer a short basis
  // from the subject/description keywords.
  const basisOf = (subject, desc) => {
    const s = (subject + ' ' + desc).toLowerCase();
    if (/legislation|excise|duty|tax/.test(s)) return 'Change in legislation';
    if (/interest/.test(s)) return 'Interest on delayed payment';
    if (/suspension|employer.?instruct|instructed|ordered by/.test(s)) return "Employer's instruction";
    if (/relocation|different subsurface|design|invert|enhancement|variation/.test(s)) return 'Site / design change';
    if (/force majeure|landslide|blockage|curfew|insurrection|political|geopolitic|monsoon|flood/.test(s)) return 'Force Majeure';
    if (/prolongation|extension of time|\beot\b/.test(s)) return 'Employer risk event';
    return '';
  };
  const labelOf = (no) => (/^\d+$/.test(no) ? 'SoC #' + no : /provision/i.test(no) ? 'Provisional Sum' : no);

  // Walk the rows, grouping each main claim with the interim sub-rows that
  // follow it (blank Claim No.), summing their amounts into the parent. Cols:
  // 0 Claim No, 2 Letter, 3 Subject, 4 Description, 5/6 USD/NPR, 7 Approved,
  // 10 EoT days, 11 Status, 12 Remarks.
  const grantedOf = (remarks) => { const m = String(remarks).match(/granted\D*(\d+)\s*days?/i); return m ? +m[1] : 0; };
  const claims = [], eot = [];
  let cur = null, socCount = 0, approvedNPR = 0, maxEot = 0, eotGranted = 0;
  for (let i = 1; i < summary.length; i++) {
    const r = summary[i]; if (!r) continue;
    const no = txt(r[0]);
    const subject = txt(r[3]) || txt(r[4]);
    if (/^total/i.test(no)) { cur = null; continue; }
    // An EoT submission — matched by Claim No OR subject, because re-submissions
    // (Supplementary EoT-1, Re-Submission of EoT-01) leave the Claim No blank yet
    // are their own entries, not interim sub-rows of the first EoT.
    const isEot = /\beot\b|extension of time/i.test(no) || /\beot\b|extension of time/i.test(subject);
    if (no || isEot) {
      const rec = {
        no: labelOf(no) || subject.replace(/^(re-)?submission of (application for\s*)?/i, (m, re) => (re ? 'Re-Submission of ' : '')).trim(),
        subject, basis: basisOf(subject, txt(r[4])),
        usd: num(r[5]), npr: num(r[6]), eotDays: num(r[10]) || null,
        status: statusOf(r[11], r[12]), remarks: txt(r[12]), letter: txt(r[2]),
      };
      if (num(r[7]) && /approv|receiv/i.test(txt(r[11]) + ' ' + txt(r[12]))) approvedNPR += num(r[7]);
      if (isEot) {
        if (rec.eotDays) maxEot = Math.max(maxEot, rec.eotDays);
        const gr = grantedOf(rec.remarks); if (gr) eotGranted = Math.max(eotGranted, gr);
        eot.push(rec); cur = rec;
      } else { if (/^\d+$/.test(no)) socCount++; claims.push(rec); cur = rec; }
    } else if (cur) {
      cur.usd += num(r[5]); cur.npr += num(r[6]); // interim breakdown of the current claim
    }
  }

  // Variation notices from the dedicated sheet. Cols: 2 Subject, 3 Reason, 4 Remarks.
  const variations = [];
  const vg = matrices['Variation'];
  if (vg) {
    for (let i = 1; i < vg.length; i++) {
      const r = vg[i]; if (!r) continue;
      const subject = txt(r[2]); if (!subject) continue;
      // col3 (Reason) is a full paragraph — derive a short basis instead.
      variations.push({ desc: subject, basis: basisOf(subject, txt(r[3])), npr: null, status: statusOf('', r[4]) });
    }
  }

  // Headline totals + the big Additional Surge Tunnel value from T. Claim Amount.
  let totalUSD = null, totalNPR = null, surgeNPR = null;
  const tca = matrices['T. Claim Amount'];
  if (tca) {
    for (const r of tca) {
      if (!r) continue;
      const label = txt(r[1]);
      if (/g\.?\s*total/i.test(label)) { totalUSD = num(r[3]) || null; totalNPR = num(r[4]) || null; }
      if (/surge tunnel/i.test(label)) surgeNPR = num(r[4]) || null;
    }
  }
  if (surgeNPR) { const hit = variations.find((v) => /surge|tailrace/i.test(v.desc)); if (hit) hit.npr = surgeNPR / 1e6; }
  if (totalUSD == null && totalNPR == null) {
    totalUSD = [...claims, ...eot].reduce((s, c) => s + c.usd, 0);
    totalNPR = [...claims, ...eot].reduce((s, c) => s + c.npr, 0);
  }

  const toM = (list) => list.map((c) => ({ ...c, usd: c.usd ? c.usd / 1e6 : null, npr: c.npr ? c.npr / 1e6 : null }));
  return {
    warnings,
    totalUSD: totalUSD ? totalUSD / 1e6 : 0, totalNPR: totalNPR ? totalNPR / 1e6 : 0,
    socCount, approvedNPR: approvedNPR / 1e6, eotDays: maxEot || null, eotGranted: eotGranted || null,
    surgeNPR: surgeNPR ? surgeNPR / 1e6 : null,
    claims: toM(claims), eot: toM(eot), variations,
  };
}

module.exports = { parseTunnel, parseKpis, parseSCurve, parseFinance, parseManpower, parseIpc, parseFinanceDetail, parseClaims };
