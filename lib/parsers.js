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
  // Received against IPCs only (i.e. excluding the mobilisation advance).
  const receivedIpcRow = findRow('Actual Received-IPCs');

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
    receivedExclAdvUSD: receivedIpcRow ? num(receivedIpcRow[1]) : null,
    receivedExclAdvNPR: receivedIpcRow ? num(receivedIpcRow[2]) : null,
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

// IPC register from the 'IPCs and Details' sheet of the Milestone Payment
// Summary. Only the summary rows (Description like 'IPC-01') are kept — the
// component sub-rows (B.1, F.3, partial/remaining splits) are skipped.
// Columns: 0 Description, 4 Certified Date (serial), 21 Net USD, 22 Net NPR,
// 31 Status.
function parseIpc(matrices) {
  const warnings = [];
  const grid = matrices['IPCs and Details'];
  if (!grid) {
    warnings.push("Sheet 'IPCs and Details' not found (Milestone Payment Summary)");
    return { rows: [], total: { netUSD: 0, netNPR: 0, count: 0 }, warnings };
  }

  const num = (v) => (typeof v === 'number' ? v : 0);
  const serialToIso = (s) => {
    if (typeof s !== 'number') return null;
    return new Date(Math.round((s - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  };

  const rows = [];
  for (const r of grid) {
    if (!r || typeof r[0] !== 'string') continue;
    if (!/^IPC-\d+/i.test(r[0].trim())) continue;
    rows.push({
      ipc: r[0].trim(),
      certifiedDate: serialToIso(r[4]),
      netUSD: num(r[21]),
      netNPR: num(r[22]),
      status: typeof r[31] === 'string' && r[31].trim() ? r[31].trim() : '—',
    });
  }

  const total = rows.reduce(
    (acc, r) => ({ netUSD: acc.netUSD + r.netUSD, netNPR: acc.netNPR + r.netNPR, count: acc.count + 1 }),
    { netUSD: 0, netNPR: 0, count: 0 }
  );

  return { rows, total, warnings };
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

// Full financial breakdown for the dedicated Financial panel: budget (Sheet2),
// received totals, and every IPC with its work items (grouped by BoQ category)
// and received installments. Items carry their certified Net amount (USD/NPR);
// cash received is tracked at IPC level (and as dated installment tranches).
function parseFinanceDetail(matrices) {
  const warnings = [];
  const num = (v) => (typeof v === 'number' ? v : 0);
  const findRow = (label) => {
    for (const n of Object.keys(matrices)) {
      for (const r of matrices[n]) if (r && typeof r[0] === 'string' && r[0].trim() === label) return r;
    }
    return null;
  };
  const serialToIso = (s) =>
    (typeof s === 'number' && s > 30000 && s < 80000
      ? new Date(Math.round((s - 25569) * 86400 * 1000)).toISOString().slice(0, 10) : null);

  const totalRow = findRow('Total Work Value');
  const completeRow = findRow('Complete Work Value');
  const outRow = findRow('Outstanding/Unfinished Work Value');
  const budget = {
    workUSD: num(totalRow && totalRow[1]), workNPR: num(totalRow && totalRow[2]), workUSDEq: num(totalRow && totalRow[3]),
    completeUSD: num(completeRow && completeRow[1]), completeNPR: num(completeRow && completeRow[2]), completeUSDEq: num(completeRow && completeRow[3]),
    outUSD: num(outRow && outRow[1]), outNPR: num(outRow && outRow[2]), outUSDEq: num(outRow && outRow[3]),
  };
  const recvRow = findRow('Total Actual Received-AP & IPCs');
  const recvEqRow = findRow('Total Received in NPR-IPCs & AP');
  const received = { usd: num(recvRow && recvRow[1]), npr: num(recvRow && recvRow[2]), nprEq: num(recvEqRow && recvEqRow[2]) };

  const grid = matrices['IPCs and Details'];
  if (!grid) {
    warnings.push("'IPCs and Details' sheet not found (Milestone Payment Summary)");
    return { budget, received, ipcs: [], warnings };
  }

  const CAT = {
    A: 'Hydro-mechanical Equipment', B: 'Mobilisation & Site', C: 'Headwork Structures',
    D: 'Headrace Tunnel (HRT)', E: 'Surge / Valve / Pressure Shaft', F: 'Powerhouse & Caverns',
  };
  // Payment % cells hold a fraction (0.33 = 33%). Footer/total rows put an
  // amount there instead — guard so an amount never becomes a bogus percent.
  const pct = (v) => (typeof v === 'number' && v >= 0 && v <= 1.5 ? Math.round(v * 100) : null);
  const ipcs = [];
  let cur = null, advance = null;
  for (const r of grid) {
    if (!r || typeof r[0] !== 'string') continue;
    const d = r[0].replace(/\s+/g, ' ').trim();
    if (!d) continue;

    // The summary/total block ("Advance Payment(AP)", "Total ... IPCs",
    // "Actual Received-...", "Certified-IPCs", "Net Amount-IPCs") is one
    // contiguous group at the very end of the sheet — stop once we reach it.
    if (/ipcs|^total\b|^actual received|^certified|^net amount|^grand|^advance payment\(/i.test(d)) break;

    if (/^IPC-\d+/i.test(d)) {
      cur = { ipc: d, certifiedDate: serialToIso(r[4]), netUSD: num(r[21]), netNPR: num(r[22]),
        receivedUSD: num(r[25]), receivedNPR: num(r[26]),
        status: (typeof r[31] === 'string' && r[31].trim()) || '—', items: [], installments: [] };
      ipcs.push(cur);
    } else if (/^Advance Payment/i.test(d)) {
      if (/monsoon/i.test(d)) continue; // monsoon material advance is tracked separately
      if (!advance) {
        advance = { ipc: 'Advance Payment', isAdvance: true, certifiedDate: serialToIso(r[4]),
          netUSD: 0, netNPR: 0, receivedUSD: 0, receivedNPR: 0, status: 'Completed', items: [], installments: [] };
        ipcs.unshift(advance);
      }
      advance.netUSD += num(r[21]); advance.netNPR += num(r[22]);
      advance.receivedUSD += num(r[25]); advance.receivedNPR += num(r[26]);
      advance.items.push({ code: d, category: 'Advance Payment',
        paymentPct: pct(r[1]), netUSD: num(r[21]), netNPR: num(r[22]) });
    } else if (/partial|remaining/i.test(d)) {
      const t = cur || advance;
      if (t) t.installments.push({ label: d, date: serialToIso(r[28]) || serialToIso(r[27]),
        amountUSD: num(r[25]), amountNPR: num(r[26]) });
    } else {
      const t = cur || advance;
      if (t && (num(r[21]) || num(r[22]) || typeof r[1] === 'number')) {
        const grp = d[0].toUpperCase();
        t.items.push({ code: d, category: CAT[grp] || 'Other',
          activityName: acsName(d), activityGroup: grp,
          activityGroupName: ACS_NAMES[grp] || CAT[grp] || ('Activity ' + grp),
          paymentPct: pct(r[1]), netUSD: num(r[21]), netNPR: num(r[22]) });
      }
    }
  }
  // Earned/certified value broken down by BoQ category (work items only —
  // the advance is not "work done"). usdEquiv blends both currencies using the
  // contract's implied NPR→USD rate so slices are comparable.
  const rate = (budget.workUSDEq > budget.workUSD && budget.workNPR)
    ? budget.workNPR / (budget.workUSDEq - budget.workUSD) : 133;
  const catMap = {};
  for (const i of ipcs) {
    if (i.isAdvance) continue;
    for (const it of i.items) {
      if (it.category === 'Advance Payment') continue;
      const c = it.category || 'Other';
      (catMap[c] = catMap[c] || { category: c, usd: 0, npr: 0 });
      catMap[c].usd += it.netUSD || 0; catMap[c].npr += it.netNPR || 0;
    }
  }
  const earnedByCategory = Object.values(catMap)
    .map((c) => ({ ...c, usdEquiv: c.usd + c.npr / rate }))
    .filter((c) => c.usdEquiv > 0)
    .sort((a, b) => b.usdEquiv - a.usdEquiv);

  // Per-IPC deductions: 15% advance recovery (cols 15/16) and 5% retention (cols 17/18).
  let recoveredUSD = 0, recoveredNPR = 0, retentionUSD = 0, retentionNPR = 0;
  for (const r of grid) {
    if (r && typeof r[0] === 'string' && /^IPC-\d+/i.test(r[0].trim())) {
      recoveredUSD += typeof r[15] === 'number' ? Math.abs(r[15]) : 0;
      recoveredNPR += typeof r[16] === 'number' ? Math.abs(r[16]) : 0;
      retentionUSD += typeof r[17] === 'number' ? Math.abs(r[17]) : 0;
      retentionNPR += typeof r[18] === 'number' ? Math.abs(r[18]) : 0;
    }
  }
  // Monsoon material advance (NPR only) — separate from the mobilisation advance.
  const monsoonRow = grid.find((r) => r && typeof r[0] === 'string' && /actual advance.*monsoon/i.test(r[0]));
  const monsoonDisbursedNPR = monsoonRow ? num(monsoonRow[2]) : 0;
  const adv = ipcs.find((i) => i.isAdvance);
  const advanceSummary = adv ? {
    disbursedUSD: adv.netUSD, disbursedNPR: adv.netNPR,
    recoveredUSD, recoveredNPR,
    outstandingUSD: adv.netUSD - recoveredUSD, outstandingNPR: adv.netNPR - recoveredNPR,
    amortisedPct: adv.netNPR ? Math.round((recoveredNPR / adv.netNPR) * 1000) / 10 : 0,
    monsoonDisbursedNPR, monsoonRecoveredNPR: 0, // no monsoon recovery column yet
  } : null;
  const retention = { usd: retentionUSD, npr: retentionNPR };

  if (!ipcs.length) warnings.push('No IPC rows found in IPCs and Details');
  return { budget, received, ipcs, earnedByCategory, advance: advanceSummary, retention, warnings };
}

module.exports = { parseTunnel, parseKpis, parseSCurve, parseFinance, parseManpower, parseIpc, parseFinanceDetail };
