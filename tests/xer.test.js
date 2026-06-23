const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseXer } = require('../lib/xer');

const SAMPLE = [
  '%T\tTASK',
  '%F\ttask_id\ttask_code\ttask_name\twbs_id\tstatus_code\tphys_complete_pct\ttask_type\ttotal_float_hr_cnt\tearly_start_date\tearly_end_date\tact_start_date\tact_end_date',
  '%R\t100\tA1000\tNotice to Proceed\t9\tTK_Complete\t100\tTT_StartMile\t0\t2024-06-09 08:00\t2024-06-09 08:00\t2024-06-09 08:00\t2024-06-09 08:00',
  '%R\t101\tA1010\tExcavation\t9\tTK_Active\t40\tTT_Task\t-80\t2024-06-10 08:00\t2024-09-10 17:00\t2024-06-10 08:00\t',
  '%R\t102\tA1020\tConcreting\t9\tTK_NotStart\t0\tTT_Task\t120\t2024-09-11 08:00\t2024-12-01 17:00\t\t',
  '%T\tTASKPRED',
  '%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt',
  '%R\t1\t101\t100\tPR_FS\t0',
  '%R\t2\t102\t101\tPR_FS\t16',
  '%T\tPROJWBS',
  '%F\twbs_id\tparent_wbs_id\twbs_name',
  '%R\t9\t\tHeadworks',
  '%E',
].join('\r\n');

test('parseXer extracts activities with ids, dates, status and float', () => {
  const out = parseXer(SAMPLE);
  assert.equal(out.activities.length, 3);
  const a = out.activities[1];
  assert.equal(a.id, 'A1010');
  assert.equal(a.name, 'Excavation');
  assert.equal(a.status, 'In Progress');
  assert.equal(a.pct, 40);
  assert.equal(a.start, '2024-06-10');
  assert.equal(a.finish, '2024-09-10');
  assert.equal(a.critical, true);          // negative float
  assert.equal(out.activities[2].critical, false); // positive float
  assert.equal(out.activities[0].isMilestone, true);
});

test('parseXer extracts predecessor relationships with type and lag', () => {
  const out = parseXer(SAMPLE);
  assert.equal(out.relationships.length, 2);
  const r = out.relationships[1];
  assert.equal(r.taskId, '102');       // successor
  assert.equal(r.predTaskId, '101');   // predecessor
  assert.equal(r.type, 'FS');
  assert.equal(r.lagDays, 2);          // 16h / 8 = 2 days
  assert.equal(out.wbs['9'].name, 'Headworks');
});
