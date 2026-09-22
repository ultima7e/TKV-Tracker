const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMaterials } = require('../lib/parsers');

// Synthetic fixtures shaped like the "Summary of Material Approval List" workbook.
// (The repo is public — never put real project rows in a test.)
const REGISTER = [
  ['Material Approval Status'],
  ['S.no', 'Material Types', 'Name of Material', 'Source of Material', 'Types of Test', 'Status', 'Approved Letter Ref. No', 'Remarks'],
  ['1', 'Steel', 'Brand A', 'Mill A', 'Chemical & physical', 'Approved', 'REF/1'],
  [null, null, 'Brand B', 'Mill B', 'Chemixal and physical', 'Approved as noted', 'REF/2'],
  [],                                                     // separator row
  ['2', 'Admixture', 'Brand C', 'Plant C', 'Physical Test', 'Send for Approval'],
  [null, null, 'Brand D', 'Plant D', '-', 'Submitted for appproval', 'Under Review', 'test done'],
  [null, null, 'Brand E', 'Plant E', null, 'RFC', 'REF/3'],
  [],
  ['3', 'Cement', 'Cemco', 'Cemco Works', null, 'RFC', null, 'factory visit pending'],
];

const STATUS = [
  [null, 'Construction Materials Approval'],
  ['S.N', 'Name of Brand/ Supplier', 'Source of Materials', 'Grade/Types', null, 'Description of Tests', null, 'MTC', 'Details of Manufacturer', 'Present Status', 'Revision', 'Document Transmittal', null, 'Reply Review Note from OE', null, 'Review Duration', 'Review Status', 'Remarks'],
  [null, null, null, null, null, 'Physical Requirements', 'Chemical Requirements', null, null, null, null, 'Letter/DT No.', 'Submission Date', 'Letter/RN No.', 'Received Date'],
  ['Cement'],
  ['2.1', 'Cemco Cement', 'Cemco Works', 'OPC', null, '√', '√', '√', '√', 'A', null, 'DT/1', 45000, 'RN/1', null, null, 'A'],
  ['2.2', 'Other Cement', 'Other Works', 'OPC', null, '√', '√', null, null, 'AN', null, null, null, 'site visit pending before approval', null, null, 'A'],
  ['2.3'],                                              // placeholder: numbered, empty
  [null, null, '* Physical Properties', null, null, null, null, null, null, null, null, 'DT/2', '10/11/2024', 'RN/2'],
  ['Aggregates'],
  // Aggregates' own header moves the test ticks two columns right.
  ['S.N', 'Source of Aggregates', null, 'Types of Aggregates', null, null, 'Description of Tests', null, null, 'Present Status', 'Revision', 'Document Transmittal', null, 'Reply Review Note from OE', null, 'Review Duration', 'Review Status', 'Remarks'],
  [null, null, null, null, null, null, 'Physical Requirements', 'Chemical and Petrography Requirements', null, null, null, 'Letter/DT No.', 'Submission Date', 'Letter/RN No.', 'Received Date'],
  ['7.1', 'Quarry Q', null, 'Coarse and fine', null, null, '√', '√', null, 'A', null, null, null, 'RN/7', null, null, 'A'],
  ['8', null, null, null, null, '√', '√', '√', '√', 'A', null, null, null, 'RN/8', null, null, 'A'], // unnamed row
];

const CALIB = [
  ['Summary of Calibration schedule'],
  ['S.no', 'Name of Instrument/Machine', 'Model Number', 'Serial Number', 'Current calibration date', 'Next calibration date', 'Remarks'],
  ['1', 'Batching Plant', 'M-1', 20240924, '18/4/2026', '18/4/2027'],
  ['2', 'Pullout Machine', '-', 10114, 46240, 46573],
  ['3', null, '-', 'X230511', 46240, 46573],              // name merged down
  ['4', 'Cube Tester', 'Y-3', 'Z1', 'N/A', 'N/A'],
];

const MIX = (label) => [
  [label + ' Mixdesign Approval Summary'],
  ['S.N', 'Grade', 'Mix Design Code', 'Cement Brand', 'Source of Materials', 'Approved Ref. No', 'Status'],
  ['1', 'C25/30', 'C25-1', 'Brand X OPC', 'Quarry Q', 'REF/9', 'Approved'],
];
const GROUT = [
  ['Grout Mixdesign Approval Summary'],
  ['S.N', 'Ratio', 'mixing material', 'Approved Letter Ref. No', 'Status'],
  ['1', 0.4, 'Water/Cement', 'REF/10', 'Approved'],
];

const WORKBOOK = {
  'Status of Material': STATUS, concrete: MIX('Concrete'), Shotcrete: MIX('Shotcrete'),
  Material: REGISTER, Grout: GROUT, 'Calibration record': CALIB,
};

test('parseMaterials carries merged groups and keeps Send vs Submitted apart', () => {
  const r = parseMaterials(WORKBOOK);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.groups.map((g) => [g.type, g.items.length]), [['Steel', 2], ['Admixture', 3], ['Cement', 1]]);
  const byName = Object.fromEntries(r.groups.flatMap((g) => g.items).map((it) => [it.name, it]));
  // Opposite states: not yet sent (Contractor holds it) vs with the Engineer.
  assert.equal(byName['Brand C'].state, 'Not submitted');
  assert.equal(byName['Brand D'].state, 'With Engineer');
  // "Under Review" typed into the reference column is a note, never a reference.
  assert.equal(byName['Brand D'].ref, '');
  assert.match(byName['Brand D'].remarks, /Under Review/);
  // Test scope spellings collapse to one label.
  assert.equal(byName['Brand A'].test, 'Chemical & Physical');
  assert.equal(byName['Brand B'].test, 'Chemical & Physical');
  assert.deepEqual(
    { approved: r.counts.approved, asNoted: r.counts.asNoted, withEngineer: r.counts.withEngineer, rfc: r.counts.rfc, notSubmitted: r.counts.notSubmitted, actionContractor: r.counts.actionContractor },
    { approved: 2, asNoted: 1, withEngineer: 1, rfc: 2, notSubmitted: 1, actionContractor: 3 },
  );
});

test('parseMaterials reads mixed-format calibration dates and merged names', () => {
  const r = parseMaterials(WORKBOOK);
  const c = r.calibration;
  assert.equal(c.length, 4);
  assert.equal(c[0].next, '2027-04-18');          // day-first text
  assert.equal(c[1].next, '2027-07-05');          // Excel serial
  assert.equal(c[2].name, 'Pullout Machine');     // carried down a merged cell
  assert.equal(c[3].next, null);                  // "N/A"
  assert.equal(r.counts.calibrationUndated, 1);
});

test('parseMaterials resolves the workflow sheet per category', () => {
  const r = parseMaterials(WORKBOOK);
  const s = Object.fromEntries(r.submissions.map((x) => [x.category + ' ' + x.sn, x]));
  assert.equal(r.submissions.some((x) => x.sn === '2.3'), false, 'an empty numbered placeholder is not an entry');
  assert.deepEqual(r.submissions.map((x) => x.category), ['Cement', 'Cement', 'Aggregates', 'Aggregates']);
  // Present status keeps its own code (AN) rather than being overwritten by review status.
  assert.equal(s['Cement 2.2'].presentState, 'Approved as noted');
  assert.equal(s['Cement 2.2'].reviewState, 'Approved');
  // Prose in the RN column is a note, not a letter reference.
  assert.equal(s['Cement 2.2'].rnNo, '');
  assert.match(s['Cement 2.2'].remarks, /site visit/);
  // A continuation row attaches its transmittal to the entry above it.
  assert.deepEqual(s['Cement 2.2'].refs.map((x) => [x.label, x.dtNo, x.submitted, x.rnNo]), [['Physical Properties', 'DT/2', '2024-11-10', 'RN/2']]);
  // Aggregates' ticks are two columns further right than everyone else's.
  assert.deepEqual(s['Aggregates 7.1'].tests, { physical: true, chemical: true, mtc: false, manufacturer: false });
  assert.deepEqual(s['Cement 2.1'].tests, { physical: true, chemical: true, mtc: true, manufacturer: true });
});

test('parseMaterials flags a real register/workflow disagreement exactly once', () => {
  const r = parseMaterials(WORKBOOK);
  // Cemco is RFC in the register but "A" on the workflow sheet. The unnamed workflow
  // row must NOT match every register item (every string starts with '').
  assert.deepEqual(r.conflicts.map((c) => [c.name, c.register, c.workflow]), [['Cemco', 'RFC', 'A']]);
});

test('parseMaterials names grout columns for what they are', () => {
  const r = parseMaterials(WORKBOOK);
  assert.deepEqual(
    { ratio: r.grout[0].ratio, material: r.grout[0].material, state: r.grout[0].state },
    { ratio: '0.4', material: 'Water/Cement', state: 'Approved' },
  );
  assert.deepEqual(r.cementBrands, ['Brand X OPC']);
  assert.equal(r.counts.mixes, 3);
});

test('parseMaterials warns instead of throwing when sheets are missing', () => {
  const r = parseMaterials({});
  assert.equal(r.groups.length, 0);
  assert.ok(r.warnings.length >= 1);
});
