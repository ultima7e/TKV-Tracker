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
  const activities = (t.TASK || []).map((r) => {
    const start = isoDate(r.act_start_date) || isoDate(r.early_start_date) || isoDate(r.target_start_date) || isoDate(r.restart_date);
    const finish = isoDate(r.act_end_date) || isoDate(r.early_end_date) || isoDate(r.target_end_date) || isoDate(r.reend_date);
    const totalFloatDays = Math.round((num(r.total_float_hr_cnt) / 8) * 10) / 10;
    return {
      taskId: r.task_id,
      id: r.task_code,
      name: r.task_name,
      wbsId: r.wbs_id,
      status: STATUS[r.status_code] || r.status_code,
      pct: Math.round(num(r.phys_complete_pct)),
      isMilestone: MILESTONE_TYPES.has(r.task_type),
      start, finish,
      baselineStart: isoDate(r.target_start_date),
      baselineFinish: isoDate(r.target_end_date),
      totalFloatDays,
      critical: num(r.total_float_hr_cnt) <= 0,
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
