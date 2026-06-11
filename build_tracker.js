const XLSX = require('xlsx');
const { Workbook } = require('exceljs');
const path = require('path');

const INPUT = 'C:\\Users\\bhsag\\Documents\\xwechat_files\\wxid_r5ku4rolm4cf12_dc32\\msg\\file\\2026-06\\Letters Summary.xlsx';
const OUTPUT = 'C:\\Users\\bhsag\\Desktop\\sp\\Design_Department_Tracker.xlsx';

// ── helpers ──────────────────────────────────────────────────────────────────
function excelDateToStr(v) {
  if (!v && v !== 0) return 'N/A';
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    return `${dd}-${mm}-${yyyy}`;
  }
  if (v instanceof Date) {
    const dd = String(v.getDate()).padStart(2, '0');
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const yyyy = v.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  }
  return String(v).trim() || 'N/A';
}

function normalizeStatus(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t || t === 'n/a') return 'Other';
  if (t === 'a') return 'A';
  if (t.startsWith('approved')) return 'Approved';
  if (t === 'accept' || t === 'accepted' || t === 'conditionally accepted') return 'Accept';
  if (t === 'aan' || t === 'aan ') return 'AAN';
  if (t === 'rfc' || t === 'frc' || t === 'rcf') return 'RFC';
  if (t.includes('resubmission') || t.includes('resubmit')) return 'Resubmission Required';
  if (t.includes('revise') || t.includes('revision') || t.includes('revision required')) return 'Revision Required';
  return 'Other';
}

function isDesignDept(dept) {
  return (dept || '').replace(/\s+/g, ' ').toLowerCase().includes('design');
}

function cleanStr(v) {
  return String(v || '').replace(/\r\n/g, ' ').replace(/\n/g, ' ').trim() || 'N/A';
}

// ── read source ───────────────────────────────────────────────────────────────
const wb = XLSX.readFile(INPUT);
const ws = wb.Sheets['1. Incoming Letters'];
const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

const allRows = [];
for (let i = 2; i < raw.length; i++) {
  const r = raw[i];
  const letterNo = String(r[2] || '').trim();
  if (!letterNo) continue;
  // Some rows have status in column 11 (Remarks) and column 12 empty – detect that
  const STATUS_KEYWORDS = /^(rfc|frc|rcf|accept|accepted|approved|a\b|aan|resubmission|revision|revise|instruct to resubmit|conditionally accepted)/i;
  const remarksRaw = cleanStr(r[11]);
  const statusRaw  = cleanStr(r[12]);
  const effectiveStatus = (statusRaw && statusRaw !== 'N/A') ? statusRaw
    : (remarksRaw && STATUS_KEYWORDS.test(remarksRaw)) ? remarksRaw
    : statusRaw;
  const effectiveRemarks = (statusRaw && statusRaw !== 'N/A') ? remarksRaw
    : (remarksRaw && STATUS_KEYWORDS.test(remarksRaw)) ? 'N/A'
    : remarksRaw;

  allRows.push({
    rowNum: i,
    sendDate: r[0],
    hardCopyDate: r[1],
    letterNo,
    empRef: cleanStr(r[3]),
    engRef: cleanStr(r[4]),
    sinoRef: cleanStr(r[5]),
    subject: cleanStr(r[6]),
    attachment: cleanStr(r[7]),
    replyRefNo: cleanStr(r[8]),
    cc: cleanStr(r[9]),
    dept: cleanStr(r[10]),
    remarks: effectiveRemarks,
    rawStatus: effectiveStatus,
    location: cleanStr(r[13]),
  });
}

// ── filter design rows ────────────────────────────────────────────────────────
const designRows = allRows.filter(r => isDesignDept(r.dept));

// Normalise status on each row
designRows.forEach(r => {
  r.status = normalizeStatus(r.rawStatus);
});

// ── RFC closure rule ──────────────────────────────────────────────────────────
// If a letter has RFC/Revision/Resubmission AND replyRefNo is set → "Replied RFC" (closed)
const OPEN_NEGATIVE = new Set(['RFC', 'Revision Required', 'Resubmission Required']);

const excludedRecords = [];  // { ...row, excludeReason }
const candidateRows = [];

for (const r of designRows) {
  const hasReply = r.replyRefNo && r.replyRefNo !== 'N/A';
  if (OPEN_NEGATIVE.has(r.status) && hasReply) {
    excludedRecords.push({ ...r, excludeReason: 'Replied RFC' });
  } else {
    candidateRows.push(r);
  }
}

// ── deduplication by subject chain (same location + similar subject) ───────────
// Group by location (non-N/A) + subject keywords
// For each group keep only the latest (highest row index / latest send date)

function subjectKey(row) {
  // Build a normalised key to detect duplicate chains
  const loc = (row.location && row.location !== 'N/A') ? row.location.toLowerCase().trim() : '';
  // Reduce subject to ~first 50 chars, lowercased, strip submission/revision numbering
  let subj = row.subject.toLowerCase()
    .replace(/\b(rev(ision)?|resubmission|submission|response to|review of|approval of|review and approval of|engineer.s review of|comments on|review comments|review of contractor.s submission)\b/gi, '')
    .replace(/\s+/g, ' ').trim().substring(0, 60);
  // Use sinoRef as discriminator if available
  const sinoRef = (row.sinoRef && row.sinoRef !== 'N/A') ? row.sinoRef.split('\n')[0].trim() : '';
  if (loc && sinoRef) return `LOC:${loc}|REF:${sinoRef}`;
  if (loc && subj) return `LOC:${loc}|SUBJ:${subj}`;
  if (sinoRef) return `REF:${sinoRef}`;
  return `SUBJ:${subj}`;
}

const grouped = new Map();
for (const r of candidateRows) {
  const key = subjectKey(r);
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(r);
}

const activeRows = [];
for (const [, group] of grouped) {
  if (group.length === 1) {
    activeRows.push(group[0]);
    continue;
  }
  // Sort by sendDate (number = excel serial, higher = later) then rowNum
  group.sort((a, b) => {
    const da = typeof a.sendDate === 'number' ? a.sendDate : 0;
    const db = typeof b.sendDate === 'number' ? b.sendDate : 0;
    if (db !== da) return db - da;
    return b.rowNum - a.rowNum;
  });
  const latest = group[0];
  const superseded = group.slice(1);
  activeRows.push(latest);
  for (const s of superseded) {
    excludedRecords.push({ ...s, excludeReason: 'Superseded Revision' });
  }
}

// Sort active rows by sendDate ascending
activeRows.sort((a, b) => {
  const da = typeof a.sendDate === 'number' ? a.sendDate : 0;
  const db = typeof b.sendDate === 'number' ? b.sendDate : 0;
  return da - db;
});

// ── status counts for summary ─────────────────────────────────────────────────
const STATUS_CATS = ['Approved', 'Accept', 'A', 'AAN', 'RFC', 'Revision Required', 'Resubmission Required', 'Other'];
const counts = {};
STATUS_CATS.forEach(c => counts[c] = 0);
for (const r of activeRows) counts[r.status] = (counts[r.status] || 0) + 1;

// ── build Excel workbook ──────────────────────────────────────────────────────
const owb = new Workbook();
owb.creator = 'Design Tracker';

// Colour palette
const HEADER_BG = 'FF1F3864';  // dark navy
const HEADER_FG = 'FFFFFFFF';
const ALT_ROW    = 'FFE8EFF8';
const BORDER_COL = 'FFB0BEC5';

const STATUS_COLORS = {
  'Approved':              { bg: 'FF00897B', fg: 'FFFFFFFF' },
  'Accept':                { bg: 'FF43A047', fg: 'FFFFFFFF' },
  'A':                     { bg: 'FF66BB6A', fg: 'FFFFFFFF' },
  'AAN':                   { bg: 'FF26A69A', fg: 'FFFFFFFF' },
  'RFC':                   { bg: 'FFEF5350', fg: 'FFFFFFFF' },
  'Revision Required':     { bg: 'FFFB8C00', fg: 'FFFFFFFF' },
  'Resubmission Required': { bg: 'FFFF7043', fg: 'FFFFFFFF' },
  'Other':                 { bg: 'FF9E9E9E', fg: 'FFFFFFFF' },
};

function hdrStyle(col) {
  return {
    font: { name: 'Arial', size: 10, bold: true, color: { argb: HEADER_FG } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } },
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    border: {
      top:    { style: 'thin', color: { argb: BORDER_COL } },
      bottom: { style: 'thin', color: { argb: BORDER_COL } },
      left:   { style: 'thin', color: { argb: BORDER_COL } },
      right:  { style: 'thin', color: { argb: BORDER_COL } },
    },
  };
}

function cellStyle(rowIdx, wrap) {
  const bg = rowIdx % 2 === 0 ? ALT_ROW : 'FFFFFFFF';
  return {
    font: { name: 'Arial', size: 9 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } },
    alignment: { horizontal: 'left', vertical: 'middle', wrapText: !!wrap },
    border: {
      top:    { style: 'hair', color: { argb: BORDER_COL } },
      bottom: { style: 'hair', color: { argb: BORDER_COL } },
      left:   { style: 'hair', color: { argb: BORDER_COL } },
      right:  { style: 'hair', color: { argb: BORDER_COL } },
    },
  };
}

function statusCellStyle(status, rowIdx) {
  const base = cellStyle(rowIdx, false);
  const sc = STATUS_COLORS[status] || STATUS_COLORS['Other'];
  return {
    ...base,
    font: { name: 'Arial', size: 9, bold: true, color: { argb: sc.fg } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: sc.bg } },
    alignment: { horizontal: 'center', vertical: 'middle' },
  };
}

// ── SHEET 1: Design Department Tracker ───────────────────────────────────────
const s1 = owb.addWorksheet('Design Department Tracker');

s1.mergeCells('A1:N1');
const titleCell = s1.getCell('A1');
titleCell.value = 'DESIGN DEPARTMENT TRACKER – TAMAKOSHI V HYDROELECTRIC PROJECT (LOT-1)';
titleCell.style = {
  font: { name: 'Arial', size: 13, bold: true, color: { argb: HEADER_FG } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } },
  alignment: { horizontal: 'center', vertical: 'middle' },
};
s1.getRow(1).height = 28;

const s1Headers = [
  'S.No.', 'Send Date', 'Letter No.', "Employer's Ref.", "Engineer's Ref.",
  'Sinohydro Ref.', 'Subject', 'Attachment', "Sinohydro's Reply Ref.",
  'Department', 'Location', 'Remarks', 'Status', 'Notes'
];

const s1ColWidths = [6, 12, 30, 22, 22, 32, 55, 35, 28, 22, 22, 30, 20, 25];

const hdrRow = s1.getRow(2);
s1Headers.forEach((h, ci) => {
  const cell = hdrRow.getCell(ci + 1);
  cell.value = h;
  cell.style = hdrStyle();
});
hdrRow.height = 32;

s1ColWidths.forEach((w, ci) => { s1.getColumn(ci + 1).width = w; });

activeRows.forEach((r, idx) => {
  const ri = idx + 3;
  const row = s1.getRow(ri);
  const cs = cellStyle(idx);
  const vals = [
    idx + 1,
    excelDateToStr(r.sendDate),
    r.letterNo,
    r.empRef,
    r.engRef,
    r.sinoRef,
    r.subject,
    r.attachment,
    r.replyRefNo,
    r.dept,
    r.location,
    r.remarks,
    r.status,
    '',
  ];
  vals.forEach((v, ci) => {
    const cell = row.getCell(ci + 1);
    cell.value = v;
    if (ci === 12) {
      cell.style = statusCellStyle(r.status, idx);
    } else if (ci === 6 || ci === 7 || ci === 8) {
      cell.style = { ...cs, alignment: { ...cs.alignment, wrapText: true } };
    } else {
      cell.style = cs;
    }
  });
  row.height = 20;
});

// Freeze header rows
s1.views = [{ state: 'frozen', xSplit: 0, ySplit: 2, activeCell: 'A3' }];

// Auto-filter on header row
s1.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: 14 } };

// ── SHEET 2: Approval Summary ─────────────────────────────────────────────────
const s2 = owb.addWorksheet('Approval Summary');

s2.mergeCells('A1:D1');
const s2Title = s2.getCell('A1');
s2Title.value = 'DESIGN DEPARTMENT – APPROVAL STATUS SUMMARY';
s2Title.style = {
  font: { name: 'Arial', size: 12, bold: true, color: { argb: HEADER_FG } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } },
  alignment: { horizontal: 'center', vertical: 'middle' },
};
s2.getRow(1).height = 26;

const s2Hdrs = ['S.No.', 'Status Category', 'Count', '% of Total'];
const s2HdrRow = s2.getRow(2);
s2Hdrs.forEach((h, ci) => {
  const cell = s2HdrRow.getCell(ci + 1);
  cell.value = h;
  cell.style = hdrStyle();
});
s2.getRow(2).height = 24;
s2.getColumn(1).width = 8;
s2.getColumn(2).width = 28;
s2.getColumn(3).width = 12;
s2.getColumn(4).width = 14;

const total = activeRows.length;
STATUS_CATS.forEach((cat, idx) => {
  const ri = idx + 3;
  const cnt = counts[cat] || 0;
  const pct = total > 0 ? (cnt / total * 100).toFixed(1) + '%' : '0.0%';
  const row = s2.getRow(ri);
  const cs = cellStyle(idx);
  [idx + 1, cat, cnt, pct].forEach((v, ci) => {
    const cell = row.getCell(ci + 1);
    cell.value = v;
    if (ci === 1) {
      cell.style = statusCellStyle(cat, idx);
    } else if (ci === 2) {
      cell.style = { ...cs, font: { ...cs.font, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } };
    } else {
      cell.style = { ...cs, alignment: { horizontal: 'center', vertical: 'middle' } };
    }
  });
  row.height = 20;
});

// Total row
const totRow = s2.getRow(STATUS_CATS.length + 3);
const totStyle = {
  font: { name: 'Arial', size: 10, bold: true },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } },
  alignment: { horizontal: 'center', vertical: 'middle' },
  border: { top: { style: 'medium' }, bottom: { style: 'medium' } },
};
['', 'TOTAL', total, '100.0%'].forEach((v, ci) => {
  const cell = totRow.getCell(ci + 1);
  cell.value = v;
  cell.style = totStyle;
});
totRow.height = 22;

// ── SHEET 3: Excluded Records Log ────────────────────────────────────────────
const s3 = owb.addWorksheet('Excluded Records Log');

s3.mergeCells('A1:G1');
const s3Title = s3.getCell('A1');
s3Title.value = 'EXCLUDED RECORDS LOG';
s3Title.style = {
  font: { name: 'Arial', size: 12, bold: true, color: { argb: HEADER_FG } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } },
  alignment: { horizontal: 'center', vertical: 'middle' },
};
s3.getRow(1).height = 26;

const s3Hdrs = ['S.No.', 'Send Date', 'Letter No.', 'Subject', 'Department', 'Status', 'Exclusion Reason'];
const s3HdrRow = s3.getRow(2);
s3Hdrs.forEach((h, ci) => {
  const cell = s3HdrRow.getCell(ci + 1);
  cell.value = h;
  cell.style = hdrStyle();
});
s3.getRow(2).height = 24;
[6, 12, 30, 60, 22, 20, 28].forEach((w, ci) => { s3.getColumn(ci + 1).width = w; });

const EXCL_COLORS = {
  'Replied RFC':         'FFEF9A9A',
  'Superseded Revision': 'FFFFE082',
  'Not Design Related':  'FFB0BEC5',
};

excludedRecords.sort((a, b) => {
  const da = typeof a.sendDate === 'number' ? a.sendDate : 0;
  const db = typeof b.sendDate === 'number' ? b.sendDate : 0;
  return da - db;
});

excludedRecords.forEach((r, idx) => {
  const ri = idx + 3;
  const row = s3.getRow(ri);
  const cs = cellStyle(idx);
  const eBg = EXCL_COLORS[r.excludeReason] || 'FFFCE4EC';
  const reasonStyle = {
    ...cs,
    font: { name: 'Arial', size: 9, bold: true },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: eBg } },
    alignment: { horizontal: 'center', vertical: 'middle' },
  };
  [idx + 1, excelDateToStr(r.sendDate), r.letterNo, r.subject, r.dept, r.status, r.excludeReason].forEach((v, ci) => {
    const cell = row.getCell(ci + 1);
    cell.value = v;
    cell.style = ci === 6 ? reasonStyle : ci === 3 ? { ...cs, alignment: { ...cs.alignment, wrapText: true } } : cs;
  });
  row.height = 18;
});

s3.views = [{ state: 'frozen', xSplit: 0, ySplit: 2, activeCell: 'A3' }];
s3.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: 7 } };

// ── save ──────────────────────────────────────────────────────────────────────
owb.xlsx.writeFile(OUTPUT).then(() => {
  console.log('Output saved to:', OUTPUT);
  console.log('Active design records:', activeRows.length);
  console.log('Excluded records:', excludedRecords.length);
  console.log('Status summary:');
  STATUS_CATS.forEach(c => { if (counts[c]) console.log(' ', c + ':', counts[c]); });
}).catch(e => { console.error(e); process.exit(1); });
