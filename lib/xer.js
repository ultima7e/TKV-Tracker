// Parse a Primavera P6 XER export (tab-delimited tables) into the pieces the
// Schedule panel needs: activities (with Activity ID, dates, % complete, float,
// critical flag), relationships (predecessor/successor + type + lag) and WBS.
//
// XER line types:  %T <TableName>  /  %F <field>\t<field>…  /  %R <val>\t<val>…
function parseTables(text) {
  const tables = {};
  let cur = null, fields = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('%T')) { cur = raw.split('\t')[1]; tables[cur] = []; fields = null; }
    else if (raw.startsWith('%F')) { fields = raw.split('\t').slice(1); }
    else if (raw.startsWith('%R') && cur && fields) {
      const vals = raw.split('\t').slice(1);
      const row = {};
      fields.forEach((f, i) => { row[f] = vals[i]; });
      tables[cur].push(row);
    }
  }
  return tables;
}

// P6 "Longest Path" = the driving chain that determines the project finish. Traced
// backward from the latest-finishing activity through driving relationships (using
// early dates). This is what P6 shows as the critical path in Longest-Path mode —
// far tighter than "total float ≤ 0", which in a delayed schedule flags every
// behind-schedule activity. `cal` maps clndr_id → hours/day (for lag conversion).
function longestPath(taskRows, predRows, cal) {
  const day = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? Math.floor(new Date(s.slice(0, 10) + 'T00:00:00Z').getTime() / 86400000) : null);
  const A = {};
  for (const r of taskRows) {
    const es = day(r.early_start_date) ?? day(r.act_start_date) ?? day(r.target_start_date) ?? day(r.restart_date);
    const ef = day(r.early_end_date) ?? day(r.act_end_date) ?? day(r.target_end_date) ?? day(r.reend_date);
    A[r.task_id] = { es, ef, clndr: r.clndr_id };
  }
  const preds = {};
  for (const p of predRows) {
    const a = A[p.task_id];
    const hpd = (a && cal[a.clndr]) || 8;
    const lag = Math.round((parseFloat(p.lag_hr_cnt) || 0) / hpd);
    (preds[p.task_id] = preds[p.task_id] || []).push({ pred: p.pred_task_id, type: p.pred_type, lag });
  }
  let projEF = -Infinity;
  for (const id in A) if (A[id].ef != null && A[id].ef > projEF) projEF = A[id].ef;
  const onLP = new Set();
  if (projEF === -Infinity) return onLP;
  // Date a predecessor imposes on its successor (start-side for SS/SF, else finish).
  const imposed = (P, type, lag) => ((type === 'PR_SS' || type === 'PR_SF') ? (P.es != null ? P.es + lag : null) : (P.ef != null ? P.ef + lag : null));
  const q = [];
  for (const id in A) if (A[id].ef != null && A[id].ef >= projEF - 1) { onLP.add(id); q.push(id); }
  const tol = 2; // day tolerance for the driving test (calendar/rounding slack)
  while (q.length) {
    const list = preds[q.pop()] || [];
    let maxImp = -Infinity;
    for (const rel of list) { const P = A[rel.pred]; if (!P) continue; const im = imposed(P, rel.type, rel.lag); if (im != null && im > maxImp) maxImp = im; }
    if (maxImp === -Infinity) continue;
    for (const rel of list) {
      const P = A[rel.pred]; if (!P) continue;
      const im = imposed(P, rel.type, rel.lag);
      if (im != null && im >= maxImp - tol && !onLP.has(rel.pred)) { onLP.add(rel.pred); q.push(rel.pred); }
    }
  }
  return onLP;
}

const MILESTONE_TYPES = new Set(['TT_Mile', 'TT_FinMile', 'TT_StartMile']);
const STATUS = { TK_NotStart: 'Not Started', TK_Active: 'In Progress', TK_Complete: 'Complete' };
const PRED = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF' };

// "2027-01-24 18:49" -> "2027-01-24" (date only; null if absent)
const isoDate = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

function parseXer(text) {
  const warnings = [];
  const t = parseTables(text);
  if (!t.TASK) { warnings.push('No TASK table in XER'); return { activities: [], relationships: [], wbs: {}, warnings }; }

  // WBS id -> { name, parentId, seq }
  const wbs = {};
  for (const w of t.PROJWBS || []) {
    wbs[w.wbs_id] = { name: w.wbs_name, parentId: w.parent_wbs_id, seq: parseInt(w.seq_num, 10) || 0 };
  }

  const num = (v) => (v == null || v === '' ? 0 : parseFloat(v));
  // Calendar hours/day so float converts to days the way P6 shows it (these
  // schedules use 11h/day calendars, not the generic 8).
  const cal = {};
  for (const c of t.CALENDAR || []) { const h = num(c.day_hr_cnt); cal[c.clndr_id] = h > 0 ? h : 8; }
  // Critical = on the Longest Path (P6 driving path); fall back to total float ≤ 0
  // only when the network can't be traced (missing dates/relationships).
  const onLP = longestPath(t.TASK || [], t.TASKPRED || [], cal);
  const activities = (t.TASK || []).map((r) => {
    const start = isoDate(r.act_start_date) || isoDate(r.early_start_date) || isoDate(r.target_start_date) || isoDate(r.restart_date);
    const finish = isoDate(r.act_end_date) || isoDate(r.early_end_date) || isoDate(r.target_end_date) || isoDate(r.reend_date);
    const totalFloatDays = Math.round((num(r.total_float_hr_cnt) / (cal[r.clndr_id] || 8)) * 10) / 10;
    return {
      taskId: r.task_id,
      id: r.task_code,
      name: r.task_name,
      wbsId: r.wbs_id,
      status: STATUS[r.status_code] || r.status_code,
      pct: Math.round(num(r.phys_complete_pct)),
      isMilestone: MILESTONE_TYPES.has(r.task_type),
      start, finish,
      actualStart: isoDate(r.act_start_date),
      actualFinish: isoDate(r.act_end_date),
      baselineStart: isoDate(r.target_start_date),
      baselineFinish: isoDate(r.target_end_date),
      totalFloatDays,
      critical: onLP.size ? onLP.has(r.task_id) : (num(r.total_float_hr_cnt) <= 0),
    };
  });

  const relationships = (t.TASKPRED || []).map((r) => ({
    taskId: r.task_id,         // the successor (this activity depends on pred)
    predTaskId: r.pred_task_id, // the predecessor
    type: PRED[r.pred_type] || r.pred_type,
    lagDays: Math.round((num(r.lag_hr_cnt) / 8) * 10) / 10,
  }));

  return { activities, relationships, wbs, warnings };
}

module.exports = { parseXer, parseTables };
