(() => {
  const charts = {};
  let data = null;
  let advDocWired = false; // click-away handler for the advance-amortisation popover

  // ---------- auth / access control ----------
  const API_BASE = ''; // same-origin on the hosted site (standalone overrides this)
  let me = null; // { username, isAdmin, sections }
  const TOKEN_KEY = 'tkv_token';
  const SECTION_LABELS = { exec: 'Executive Summary', fin: 'Financial', sched: 'Schedule & Progress',
    tunnel: 'Tunnel', claims: 'Claims & Variations', inv: 'Inventory & Explosives', man: 'Manpower',
    equip: 'Equipment', safety: 'Safety' };
  const ALL_SECTIONS = Object.keys(SECTION_LABELS);
  // Same-origin (hosted) uses the session cookie; the standalone file adds a Bearer token.
  function authFetch(url, opts = {}) {
    const t = localStorage.getItem(TOKEN_KEY);
    const headers = Object.assign({}, opts.headers);
    if (t) headers.Authorization = 'Bearer ' + t;
    return fetch(API_BASE + url, Object.assign({}, opts, { headers }));
  }
  const canSee = (v) => !!me && (me.isAdmin || (me.sections || []).includes(v));

  async function checkAuth() {
    try { const r = await authFetch('/api/me'); if (r.ok) { me = await r.json(); return true; } } catch (e) { /* offline */ }
    me = null; return false;
  }
  function showLogin(msg) {
    const ls = document.getElementById('login-screen');
    if (ls) ls.style.display = 'flex';
    const app = document.querySelector('.app'); if (app) app.style.display = 'none';
    if (msg) { const e = document.getElementById('login-err'); if (e) e.textContent = msg; }
  }
  function wireAuthUI() {
    const form = document.getElementById('login-form');
    if (form) form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = document.getElementById('login-btn'), err = document.getElementById('login-err');
      err.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const r = await authFetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: document.getElementById('login-user').value.trim(), password: document.getElementById('login-pass').value }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Login failed');
        if (j.token) localStorage.setItem(TOKEN_KEY, j.token);
        me = { username: j.username, isAdmin: j.isAdmin, sections: j.sections };
        startApp();
      } catch (ex) { err.textContent = ex.message; }
      finally { btn.disabled = false; btn.textContent = 'Sign in'; }
    });
    const lo = document.getElementById('logout');
    if (lo) lo.addEventListener('click', async () => {
      try { await authFetch('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
      localStorage.removeItem(TOKEN_KEY); location.reload();
    });
  }
  function startApp() {
    const ls = document.getElementById('login-screen'); if (ls) ls.style.display = 'none';
    const app = document.querySelector('.app'); if (app) app.style.display = '';
    const who = document.getElementById('who'); if (who) who.textContent = me.username + (me.isAdmin ? ' · admin' : '');
    const na = document.getElementById('nav-admin'); if (na) na.style.display = me.isAdmin ? '' : 'none';
    const schTools = document.getElementById('sch-admin-tools'); if (schTools) schTools.style.display = me.isAdmin ? '' : 'none';
    const calBtn = document.getElementById('t3d-cal-btn'); if (calBtn) calBtn.style.display = me.isAdmin ? '' : 'none';
    const finTabs = document.getElementById('fin-subtabs'); if (finTabs) finTabs.hidden = !me.isAdmin;
    wireFinanceEntry();
    // Land on the first section this account may see.
    const first = me.isAdmin ? 'exec' : (me.sections || [])[0];
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    document.querySelectorAll('.view').forEach((s) => s.classList.remove('active'));
    if (first) {
      const nEl = document.querySelector('.nav-item[data-v="' + first + '"]'); if (nEl) nEl.classList.add('active');
      const vEl = document.getElementById(first); if (vEl) vEl.classList.add('active');
    } else {
      document.getElementById('denied').classList.add('active');
    }
    renderTunnel3D();
    load();
  }
  async function renderAdmin() {
    const secBox = document.getElementById('adm-secs');
    const msg = document.getElementById('adm-msg');
    const listEl = document.getElementById('adm-list');
    if (secBox && !secBox.children.length) {
      secBox.innerHTML = ALL_SECTIONS.map((s) => '<label><input type="checkbox" value="' + s + '"> ' + SECTION_LABELS[s] + '</label>').join('');
    }
    const clearForm = () => {
      document.getElementById('adm-user').value = ''; document.getElementById('adm-pass').value = '';
      document.getElementById('adm-isadmin').checked = false;
      secBox.querySelectorAll('input').forEach((c) => { c.checked = false; });
      if (msg) msg.textContent = '';
    };
    const refresh = async () => {
      const r = await authFetch('/api/users');
      if (!r.ok) { listEl.innerHTML = '<p class="muted">Could not load users.</p>'; return; }
      const { users } = await r.json();
      listEl.innerHTML = '<table class="tbl adm-users"><thead><tr><th style="text-align:left">Username</th><th style="text-align:left">Access</th><th></th></tr></thead><tbody>' +
        users.map((u) => '<tr><td style="text-align:left"><b>' + u.username + '</b></td><td style="text-align:left">' +
          (u.isAdmin ? '<span class="chip" style="background:#e4f5ee;color:#1c7a52">All · admin</span>'
            : (u.sections.length ? u.sections.map((s) => '<span class="chip">' + (SECTION_LABELS[s] || s) + '</span>').join(' ') : '<span class="muted">none</span>')) +
          '</td><td style="white-space:nowrap;text-align:right"><button class="adm-btn ghost adm-edit" data-u="' + u.username + '" style="padding:5px 10px">Edit</button> ' +
          '<button class="adm-btn danger adm-del" data-u="' + u.username + '" style="padding:5px 10px">Delete</button></td></tr>').join('') +
        '</tbody></table>';
      listEl.querySelectorAll('.adm-edit').forEach((b) => { b.onclick = () => {
        const u = users.find((x) => x.username === b.dataset.u);
        document.getElementById('adm-user').value = u.username; document.getElementById('adm-pass').value = '';
        document.getElementById('adm-isadmin').checked = u.isAdmin;
        secBox.querySelectorAll('input').forEach((c) => { c.checked = u.sections.includes(c.value); });
        if (msg) { msg.textContent = 'Editing ' + u.username + ' — leave password blank to keep it.'; msg.style.color = 'var(--muted)'; }
      }; });
      listEl.querySelectorAll('.adm-del').forEach((b) => { b.onclick = async () => {
        if (!confirm('Delete user "' + b.dataset.u + '"?')) return;
        const rr = await authFetch('/api/users?u=' + encodeURIComponent(b.dataset.u), { method: 'DELETE' });
        const jj = await rr.json().catch(() => ({}));
        if (!rr.ok) { msg.textContent = jj.error || 'Delete failed'; msg.style.color = 'var(--accent-2)'; return; }
        refresh();
      }; });
    };
    const saveBtn = document.getElementById('adm-save');
    if (saveBtn && !saveBtn.dataset.wired) {
      saveBtn.dataset.wired = '1';
      saveBtn.onclick = async () => {
        const username = document.getElementById('adm-user').value.trim();
        const password = document.getElementById('adm-pass').value;
        const isAdmin = document.getElementById('adm-isadmin').checked;
        const sections = [...secBox.querySelectorAll('input:checked')].map((c) => c.value);
        if (msg) msg.textContent = '';
        const r = await authFetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, sections, isAdmin }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { msg.textContent = j.error || 'Save failed'; msg.style.color = 'var(--accent-2)'; return; }
        msg.textContent = 'Saved ✓'; msg.style.color = 'var(--green)';
        clearForm(); refresh();
      };
      document.getElementById('adm-clear').onclick = clearForm;
    }
    refresh();
  }

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const COL = { accent: '#2f7de1', accent2: '#e23744', muted: '#7b8aa0', grid: '#eef2f7' };

  // Single NPR-equivalent of the combined USD+NPR totals, using the contract's
  // own implied rate (from the payment summary's USD-equivalent column). Received
  // uses the summary's "Total Received in NPR" figure directly.
  // Financial progress on a consistent incl-VAT basis: add 13% VAT to the NPR
  // portion of completed work (USD/foreign portion carries no VAT), then divide
  // by the full contract value (which already includes VAT + Provisional Sum).
  // Single source of truth for the certified/outstanding split on the consistent
  // incl-VAT basis. The KPI %, the Outstanding figure and the Certified-vs-
  // Outstanding donut all read from this, so they always move together.
  function finBasis(b) {
    if (!b) return { certifiedEq: 0, outstandingEq: 0, pct: null };
    // Earned Value workbook supplies its own Financial-Progress % and the
    // matching certified/outstanding split (USD-equivalent) — use them directly
    // so the KPI, donut and Outstanding line always agree with the source file.
    if (b.progressPct != null && b.certifiedUsdEq != null)
      return { certifiedEq: b.certifiedUsdEq, outstandingEq: b.outstandingUsdEq, pct: b.progressPct };
    if (!b.workUSDEq || b.completeUSD == null) return { certifiedEq: 0, outstandingEq: 0, pct: null };
    const rate = (b.workUSDEq > b.workUSD && b.workNPR) ? b.workNPR / (b.workUSDEq - b.workUSD) : 133;
    const certifiedEq = b.completeUSD + (b.completeNPR * 1.13) / rate;
    const outstandingEq = b.workUSDEq - certifiedEq;
    return { certifiedEq, outstandingEq, pct: Math.round((certifiedEq / b.workUSDEq) * 1000) / 10 };
  }
  function finProgPct(b) { return finBasis(b).pct; }

  function nprEquivalents(b, rc) {
    const rate = (b && b.workUSDEq > b.workUSD && b.workNPR) ? b.workNPR / (b.workUSDEq - b.workUSD) : 133;
    const bn = (v) => (v / 1e9).toFixed(2);
    return {
      contract: (b && b.workUSDEq) ? `≈ NPR ${bn(b.workUSDEq * rate)} B total (USD + NPR)` : '—',
      received: (rc && rc.nprEq) ? `≈ NPR ${bn(rc.nprEq)} B total received` : '—',
    };
  }

  function countUp(el, to, dec) {
    const fmt = (n) => Number(n.toFixed(dec)).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    if (document.hidden) { el.textContent = fmt(to); return; } // RAF is paused in hidden tabs — set value directly
    let start = null;
    const dur = 1100;
    function step(t) {
      if (!start) start = t;
      const p = Math.min((t - start) / dur, 1);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(to * e);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function showBanner(msg, isWarning) {
    const b = $('#banner');
    b.textContent = msg;
    b.className = 'banner show' + (isWarning ? ' warn' : '');
  }
  function hideBanner() { $('#banner').className = 'banner'; }

  function makeChart(id) {
    const el = document.getElementById(id);
    if (!charts[id]) charts[id] = echarts.init(el);
    return charts[id];
  }

  // ---------- renderers ----------
  function setKpi(id, value, dec) {
    const el = document.getElementById(id);
    if (typeof value === 'number') countUp(el, value, dec);
    else el.textContent = '—';
  }

  // "Jun-24" -> Date(2024-06-01)
  function parseMonthLabel(s) {
    const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const m = /^([A-Za-z]{3})-(\d{2})$/.exec(String(s).trim());
    if (!m) return null;
    return new Date(2000 + +m[2], MON[m[1]], 1);
  }

  function renderTimeline() {
    // Contract dates: commencement 09 Jun 2024 → completion 11 Apr 2028.
    const start = new Date(Date.UTC(2024, 5, 9));
    const end = new Date(Date.UTC(2028, 3, 11));
    const day = 86400000;
    const total = Math.round((end - start) / day) + 1; // inclusive of both endpoints → 1,403 days
    const elapsed = Math.max(0, Math.min(total, Math.round((new Date() - start) / day)));
    const remain = total - elapsed;
    const ePct = Math.round((elapsed / total) * 1000) / 10;
    const fmt = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
    $('#tl-range').innerHTML = `${fmt(start)} → ${fmt(end)} · <b style="color:var(--navy)">${total.toLocaleString()} days</b>`;
    $('#tl-elapsed-lab').textContent = `Elapsed ${elapsed.toLocaleString()} d · ${ePct}%`;
    $('#tl-remain-lab').textContent = `Remaining ${remain.toLocaleString()} d · ${Math.round((100 - ePct) * 10) / 10}%`;
    requestAnimationFrame(() => { $('#tl-elapsed').style.width = ePct + '%'; });
  }

  function renderKpis() {
    // Source the financial KPIs from the SAME object the Financial panel uses
    // (financeDetail) so the Executive Summary can never drift out of sync.
    const b = (data.financeDetail && data.financeDetail.budget) || {};
    const rc = (data.financeDetail && data.financeDetail.received) || {};
    setKpi('v-budget-usd', b.workUSD != null ? b.workUSD / 1e6 : null, 2);
    setKpi('v-budget-npr', b.workNPR != null ? b.workNPR / 1e6 : null, 0);
    setKpi('v-received-usd', rc.usd != null ? rc.usd / 1e6 : null, 2);
    setKpi('v-received-npr', rc.npr != null ? rc.npr / 1e6 : null, 0);
    const ret = (data.financeDetail && data.financeDetail.retention) || { usd: 0, npr: 0 };
    setKpi('v-ret-usd', ret.usd / 1e6, 2);
    setKpi('v-ret-npr', ret.npr / 1e6, 1);
    // Combined retention held as a single USD-equivalent (NPR converted at 133.03).
    const retEq = document.getElementById('v-ret-eq');
    if (retEq) retEq.textContent = (ret.usd || ret.npr) ? `≈ $ ${((ret.usd + ret.npr / 133.03) / 1e6).toFixed(2)} M total` : '—';
    setKpi('v-finprog', finProgPct(b), 1);
    // Physical progress = latest Actual cumulative % from the S-curve.
    const phys = ((data.scurve && data.scurve.actualPct) || []).filter((x) => x != null).pop();
    setKpi('v-physprog', phys != null ? phys : null, 1);
    // Total amount expressed as a single NPR-equivalent (from the payment summary).
    const eq = nprEquivalents(b, rc);
    $('#v-budget-eq').textContent = eq.contract;
    $('#v-received-eq').textContent = eq.received;
    // Earned Value = work done to date (USD-equivalent), from the EV workbook.
    const evEl = document.getElementById('v-ev');
    const evSub = document.getElementById('v-ev-sub');
    if (evEl) evEl.textContent = b.completeUSDEq ? '$ ' + (b.completeUSDEq / 1e6).toFixed(2) + 'M' : '—';
    if (evSub) evSub.textContent = b.completeUSD != null
      ? `$${(b.completeUSD / 1e6).toFixed(2)}M + NPR ${(b.completeNPR / 1e6).toFixed(0)}M work done`
      : 'awaiting EV data sheet';
    renderTimeline();
  }

  function renderAdvanceChart(id) {
    const rows = (data.tunnel && data.tunnel.monthlyAdvance) || [];
    makeChart(id).setOption({
      grid: { left: 38, right: 12, top: 18, bottom: 24 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: rows.map((r) => r.month),
        axisLabel: { fontSize: 10, color: COL.muted }, axisLine: { lineStyle: { color: '#cfd8e6' } } },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: COL.grid } },
        axisLabel: { fontSize: 10, color: COL.muted } },
      series: [{ type: 'bar', data: rows.map((r) => r.advanceM), barWidth: '52%',
        itemStyle: { borderRadius: [4, 4, 0, 0],
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1,
            [{ offset: 0, color: COL.accent }, { offset: 1, color: COL.accent2 }]) } }],
    });
  }

  function renderSCurve(id) {
    const sc = data.scurve || { months: [], plannedPct: [], actualPct: [] };
    // Overlay the EOT-final planned curve (SCURVE2) on the same axis. Use the
    // longer month range as the x-axis and align every series by month label.
    const months = sc.months.length > SCURVE2.months.length ? sc.months : SCURVE2.months;
    const align = (labels, vals) => months.map((m) => { const i = labels.indexOf(m); return i >= 0 ? vals[i] : null; });
    const planned = align(sc.months, sc.plannedPct);
    const actual = align(sc.months, sc.actualPct);
    const eot = align(SCURVE2.months, SCURVE2.cumulative);
    const EOT = '#f5a623';
    makeChart(id).setOption({
      grid: { left: 40, right: 16, top: 30, bottom: 26 },
      legend: { right: 0, top: 0, textStyle: { fontSize: 11, color: COL.muted } },
      tooltip: { trigger: 'axis', formatter: (ps) => {
        let bl = null, ac = null, pr = null;
        ps.forEach((p) => { if (p.seriesName === 'Baseline') bl = p.value; if (p.seriesName === 'Actual') ac = p.value; if (p.seriesName === 'Projected') pr = p.value; });
        const dot = (c) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:6px"></span>`;
        let s = `<b>${ps[0].axisValue}</b><br/>${dot(COL.accent)}Baseline: ${bl == null ? '—' : bl + '%'}<br/>${dot(COL.accent2)}Actual: ${ac == null ? '—' : ac + '%'}<br/>${dot(EOT)}Projected: ${pr == null ? '—' : pr + '%'}`;
        if (ac != null && pr != null) {
          const v = Math.round((ac - pr) * 10) / 10;
          const behind = v < 0;
          s += `<br/><b style="color:${behind ? '#e5554e' : '#36b37e'}">Variance: ${v > 0 ? '+' : ''}${v}% ${behind ? '(behind)' : '(ahead)'}</b>`;
        }
        return s;
      } },
      xAxis: { type: 'category', data: months,
        axisLabel: { fontSize: 10, color: COL.muted },
        axisLine: { lineStyle: { color: '#cfd8e6' } } },
      yAxis: { type: 'value', max: 100,
        axisLabel: { fontSize: 10, color: COL.muted, formatter: '{value}%' },
        splitLine: { lineStyle: { color: COL.grid } } },
      series: [
        // Original baseline — no longer relevant, shown dotted & de-emphasised.
        { name: 'Baseline', type: 'line', smooth: true, symbol: 'none',
          data: planned,
          lineStyle: { width: 1.6, color: COL.accent, type: 'dotted' } },
        { name: 'Actual', type: 'line', smooth: true, symbol: 'circle', symbolSize: 4,
          data: actual, connectNulls: false,
          lineStyle: { width: 3, color: COL.accent2 },
          itemStyle: { color: COL.accent2 } },
        // Projected (revised EOT curve) — the relevant plan; will become
        // Planned/Baseline-2 once the EoT is granted.
        { name: 'Projected', type: 'line', smooth: true, symbol: 'none',
          data: eot, connectNulls: true,
          lineStyle: { width: 3, color: EOT } },
      ],
    });
  }

  // EOT-final planned cumulative curve (cost-based), revised baseline from
  // TKV_Planned_SCurve_EOT_Final.xlsx (Jun-2024 → Nov-2029). Embedded as a fixed
  // planned baseline (not part of the live Nutstore feed) and overlaid on the
  // S-Curve as the "Projected" line.
  const SCURVE2 = {
    months: ["Jun-24","Jul-24","Aug-24","Sep-24","Oct-24","Nov-24","Dec-24","Jan-25","Feb-25","Mar-25","Apr-25","May-25","Jun-25","Jul-25","Aug-25","Sep-25","Oct-25","Nov-25","Dec-25","Jan-26","Feb-26","Mar-26","Apr-26","May-26","Jun-26","Jul-26","Aug-26","Sep-26","Oct-26","Nov-26","Dec-26","Jan-27","Feb-27","Mar-27","Apr-27","May-27","Jun-27","Jul-27","Aug-27","Sep-27","Oct-27","Nov-27","Dec-27","Jan-28","Feb-28","Mar-28","Apr-28","May-28","Jun-28","Jul-28","Aug-28","Sep-28","Oct-28","Nov-28","Dec-28","Jan-29","Feb-29","Mar-29","Apr-29","May-29","Jun-29","Jul-29","Aug-29","Sep-29","Oct-29","Nov-29"],
    cumulative: [2.41,4.06,4.92,5.56,7.06,8.77,10.64,10.98,11.18,11.23,11.68,12.23,13.16,14.07,14.99,15.88,16.3,16.84,17.28,17.95,18.23,18.65,20.53,23.06,26.63,29.87,31.79,34.21,37.1,39.92,42.55,45.9,48.72,51.39,53.63,56.37,59.96,63.47,66.3,69.42,73.58,76.35,79.36,82.05,84.41,86.92,89.56,92.61,94.24,95.58,96.78,97.46,98.22,98.7,99.16,99.24,99.31,99.36,99.46,99.55,99.62,99.73,99.84,99.93,99.97,100],
  };

  function renderTunnelBars() {
    const wrap = $('#tunnel-bars');
    const tunnels = (data.tunnel && data.tunnel.tunnels) || [];
    wrap.innerHTML = tunnels.map((t) => `
      <div class="pbar">
        <div class="lab"><span>${t.name} <span class="muted">(${t.completedM.toLocaleString()} / ${t.lengthM.toLocaleString()} m)</span></span><span>${t.progressPct}%</span></div>
        <div class="track"><i data-w="${t.progressPct}"></i></div>
      </div>`).join('');
    requestAnimationFrame(() => {
      wrap.querySelectorAll('.track > i').forEach((b) => { b.style.width = b.dataset.w + '%'; });
    });
  }

  function renderManpower() {
    const mp = data.manpower || {};
    const cell = (v) => (v > 0 ? v : '–');
    // Expatriate = foreigner; Native = Other Nepali + Local Nepali (merged).
    const rowHtml = (r, cls) => `
      <tr${cls ? ' class="' + cls + '"' : ''}>
        <td>${r.category || 'Total'}</td>
        <td>${cell(r.foreigner)}</td><td>${cell((r.otherNepali || 0) + (r.localNepali || 0))}</td>
        <td>${r.total}</td>
      </tr>`;
    const table = (rows, total, rowCls) => `
      <table class="tbl">
        <thead><tr><th>Manpower Category</th><th>Expatriate</th>
          <th>Native</th><th>Total</th></tr></thead>
        <tbody>${rows.map((r) => rowHtml(r, rowCls)).join('')}
          ${total ? rowHtml(total, 'total') : ''}</tbody>
      </table>`;
    $('#mp-date').textContent = mp.date || '—';
    if (mp.mobilized && mp.mobilized.length) {
      $('#mp-mobilized').innerHTML = table(mp.mobilized, mp.mobilizedTotal);
    }
    if (mp.idle) {
      $('#mp-idle').innerHTML = mp.idle.length
        ? table(mp.idle, mp.idleTotal, 'warn')
        : '<p class="muted">No idle manpower reported.</p>';
    }

    // Compact status table on the Executive Summary.
    $('#mp-exec-date').textContent = mp.date || '—';
    if (mp.mobilizedTotal) {
      const status = (label, t, cls) => rowHtml({ category: label, ...t }, cls);
      $('#mp-exec').innerHTML = `
        <table class="tbl">
          <thead><tr><th></th><th>Expatriate</th><th>Native</th><th>Total</th></tr></thead>
          <tbody>
            ${status('Mobilized', mp.mobilizedTotal, 'ok')}
            ${mp.idleTotal ? status('Idle', mp.idleTotal, 'warn') : ''}
          </tbody>
        </table>`;
    }
  }

  // Expandable chart-detail panels. Each collapses back to its hint via the ✕.
  const DETAIL_HINTS = {
    'f-evdetail': 'Click a slice to see its contribution.',
    'f-donut-detail': 'Click “Certified” to see the breakdown.',
    'f-bardetail': 'NPR millions received per certificate.',
  };
  function expandDetail(id, html) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.position = 'relative'; // anchors the ✕ to the panel's top-right
    el.innerHTML = `<button class="detail-x" data-close="${id}" title="Collapse details"`
      + ` aria-label="Collapse details">✕</button>` + html;
  }
  function collapseDetail(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.position = '';
    el.innerHTML = DETAIL_HINTS[id] || '';
  }
  // One delegated listener — panels are re-rendered on every refresh.
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-close]');
    if (b) collapseDetail(b.getAttribute('data-close'));
  });

  // Map the sheet's casual status text to professional payment-cycle terms.
  // Binary IPC status: a completed/paid certificate is "Settled"; anything else
  // (submitted, remaining, certified-but-unpaid, blank) is "Under Review".
  function ipcStatusLabel(s) {
    const t = (s || '').toLowerCase();
    if (/reject/.test(t)) return 'Rejected';
    if (/settl|complete|paid/.test(t)) return 'Settled';
    return 'Under Review';
  }

  function renderIpc() {
    // Interim Payment Certificates only — the Advance Payment is a separate
    // instrument, never listed under IPCs. The Exec Summary shows just the
    // latest few; the full register lives in the Financial panel.
    const all = ((data.financeDetail && data.financeDetail.ipcs) || [])
      .filter((i) => !i.isAdvance)
      .slice()
      .sort((a, b) => (b.certifiedDate || '').localeCompare(a.certifiedDate || ''));
    const rows = all.slice(0, 4);
    $('#ipc-count').textContent = all.length ? `latest ${rows.length} of ${all.length}` : '—';
    if (!rows.length) return;
    const fmtDate = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso + 'T00:00:00Z');
      const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
      return d.getUTCDate() + ' ' + m + ' ' + d.getUTCFullYear();
    };
    const usdM = (v) => (v ? (v / 1e6).toFixed(2) : '–');
    const nprM = (v) => (v ? (v / 1e6).toFixed(1) : '–');
    const ipcRow = (r) => {
      const lab = ipcStatusLabel(r.status);
      const cls = lab === 'Settled' ? 'ok' : lab === 'Rejected' ? 'warn' : 'warn';
      return `<tr class="${cls}">
        <td>${r.ipc}</td><td>${fmtDate(r.certifiedDate)}</td>
        <td>${usdM(r.netUSD)}</td><td>${nprM(r.netNPR)}</td>
        <td>${lab}</td></tr>`;
    };
    $('#ipc-table').innerHTML = `
      <table class="tbl">
        <thead><tr><th>IPC</th><th>Certified</th><th>Net (USD M)</th>
          <th>Net (NPR M)</th><th>Status</th></tr></thead>
        <tbody>${rows.map(ipcRow).join('')}</tbody>
      </table>`;
  }

  // Interactive 3D tunnel areas — section progress + on-image hotspot coords
  // (% of render). Progress synced to the Weekly Technical Progress Review
  // (Meeting No. 29 / PPT 45, data date 03-Jul-2026).
  const T3D_ASSET_BASE = 'assets/'; // standalone file overrides with the Vercel URL
  const TUNNEL_AREAS = [
    { id: 'headwork', label: 'Headwork & HRT', image: 'tunnel-headwork.png', dataDate: '03 Jul 2026', sections: [
      { name: 'Adit #1', design: '167.77 m', excavated: '167.77 m', pct: 100, x: 58.4, y: 32.6 },
      { name: 'Connecting Tunnel', design: '93.85 m', excavated: '59.75 m', pct: 63.67, x: 45.8, y: 34.4 },
      { name: 'Construction Adit Tunnel', design: '21.60 m', excavated: '21.60 m', pct: 100, x: 43.3, y: 51.7 },
      { name: 'Headpond Layer 1~4', design: '11,959.47 m³', excavated: '11,959.47 m³', pct: 100, x: 25.1, y: 54.7 },
      { name: 'Spillway Tunnel', design: '291.00 m', excavated: '291.00 m', pct: 100, x: 60.3, y: 67.1 },
      { name: 'HRT-F1', design: '1,535.57 m', excavated: '534.97 m', pct: 34.84, x: 14.8, y: 66.8 },
    ] },
    { id: 'headrace', label: 'Headrace', image: 'tunnel-headrace.jpg', dataDate: '03 Jul 2026', sections: [
      { name: 'Adit #4', design: '407.34 m', excavated: '390.00 m', pct: 95.74, x: 45.4, y: 41.7 },
      { name: 'Access to Valve Chamber', design: '183.21 m', excavated: '84.90 m', pct: 46.34, x: 42.8, y: 51.2 },
      { name: 'Surge Chamber', design: '14,392.35 m³', pct: null, x: 26.6, y: 22.8 },
      { name: 'Valve Chamber', design: '14,518.80 m³', pct: null, x: 16.7, y: 36.4 },
      { name: 'Vertical Pressure Shaft', design: '114.44 m', pct: null, x: 11.1, y: 53.5 },
      { name: 'Lower Bend Shaft', design: '28.72 m', excavated: '7.20 m', pct: 25.07, x: 11, y: 76.6 },
      { name: 'Upper Bend Shaft', design: '28.72 m', pct: null, x: 11.9, y: 38.7 },
      { name: 'Headrace Tunnel (F1~F7)', design: '8,110.28 m', excavated: '564.66 m', pct: 6.96, x: 57, y: 21.2 },
    ] },
    { id: 'powerhouse', label: 'Powerhouse', image: 'tunnel-powerhouse.jpg', dataDate: '03 Jul 2026', sections: [
      { name: 'Cable Ventilation Tunnel', design: '95.89 m', excavated: '95.89 m', pct: 100, x: 33.1, y: 80.1 },
      { name: 'Construction Tunnel', design: '57.92 m', excavated: '57.92 m', pct: 100, x: 49.2, y: 75 },
      { name: 'Main Access Tunnel', design: '285.63 m', excavated: '285.63 m', pct: 100, x: 67, y: 81.9 },
      { name: 'BusDuct Gallery 1~3', design: '100.5 m', excavated: '100.5 m', pct: 100, x: 34, y: 50.9 },
      { name: 'Access to HPT', design: '117.35 m', excavated: '117.35 m', pct: 100, x: 68.7, y: 49.6 },
      { name: 'HPT & U/S Manifold (1~4)', design: '19.60 m & 91.75 m', excavated: '19.60 m & 91.75 m', pct: 100, x: 46.2, y: 52.5 },
      { name: 'Access to TRC', design: '65.77 m', excavated: '65.77 m', pct: 100, x: 30.5, y: 72 },
      { name: 'TRC Layer-1~2', design: '12,360.00 m³', excavated: '12,360.00 m³', pct: 100, x: 24.7, y: 49.9 },
      { name: 'PHC Layer-1~6', design: '29,184.41 m³', excavated: '17,581.17 m³', pct: 60.24, x: 41.8, y: 42.9 },
      { name: 'Tailrace Tunnel', design: '602.50 m', excavated: '18.10 m', pct: 3.22, x: 10.7, y: 60 },
    ] },
  ];
  const t3dColor = (p) =>
    (p == null ? '#9aa7b8' : p >= 99.5 ? '#36b37e' : p >= 50 ? '#2f7de1' : p >= 25 ? '#f5a623' : '#e5554e');
  let t3dArea = TUNNEL_AREAS[0];

  function renderTunnel3D() {
    const tabs = document.getElementById('t3d-tabs');
    const img = document.getElementById('t3d-img');
    const wrap = document.querySelector('.t3d-wrap');
    const legend = document.getElementById('t3d-legend');
    const detail = document.getElementById('t3d-detail');
    if (!tabs || !img || !wrap || !legend || !detail) return;
    const pctTxt = (p) => (p == null ? '—' : p + '%');
    // Calibration mode (admin "Calibrate dots" button, or ?cal=1): drag the
    // hotspot dots onto their tunnels, then "Copy coords" to get the x/y JSON.
    let calMode = new URLSearchParams(location.search).get('cal') === '1' || location.hash.includes('cal');
    const enableCal = (area) => {
      const readout = () => {
        detail.innerHTML =
          '<div class="dn">Calibration — drag each dot onto its tunnel</div>' +
          '<pre style="white-space:pre-wrap;font-size:10.5px;max-height:200px;overflow:auto;background:#eef2f7;padding:8px;border-radius:6px;margin:8px 0">' +
          area.sections.map((s) => s.name + ' → x:' + s.x + ' y:' + s.y).join('\n') + '</pre>' +
          '<button id="cal-copy" class="t3d-tab active" style="cursor:pointer">Copy coords JSON</button>';
        const btn = document.getElementById('cal-copy');
        if (btn) btn.onclick = () => {
          navigator.clipboard.writeText(JSON.stringify(area.sections.map((s) => ({ name: s.name, x: s.x, y: s.y }))));
          btn.textContent = 'Copied ✓';
        };
      };
      wrap.querySelectorAll('.t3d-dot').forEach((d, i) => {
        d.classList.remove('pulse');
        d.style.cursor = 'grab';
        d.addEventListener('mousedown', (e) => {
          e.preventDefault(); e.stopPropagation();
          const r = wrap.getBoundingClientRect();
          const move = (ev) => {
            const x = Math.min(100, Math.max(0, Math.round((ev.clientX - r.left) / r.width * 1000) / 10));
            const y = Math.min(100, Math.max(0, Math.round((ev.clientY - r.top) / r.height * 1000) / 10));
            area.sections[i].x = x; area.sections[i].y = y;
            d.style.left = x + '%'; d.style.top = y + '%'; readout();
          };
          const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
          document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
        });
      });
      readout();
    };

    const selectSection = (i) => {
      const s = t3dArea.sections[i];
      const col = t3dColor(s.pct);
      wrap.querySelectorAll('.t3d-dot').forEach((d, j) => d.classList.toggle('active', j === i));
      legend.querySelectorAll('li').forEach((li, j) => li.classList.toggle('active', j === i));
      detail.innerHTML =
        '<div class="dn">' + s.name + '</div>' +
        '<div class="dbig" style="color:' + col + '">' + pctTxt(s.pct) + '</div>' +
        '<div class="pbar"><div class="track"><i style="width:' + (s.pct || 0) + '%;background:' + col + '"></i></div></div>' +
        '<div class="drow"><span>Design</span><span>' + s.design + '</span></div>' +
        (s.excavated ? '<div class="drow"><span>Excavated</span><span>' + s.excavated + '</span></div>' : '') +
        (s.pct == null ? '<div class="drow"><span>Status</span><span>Not started / in design</span></div>' : '') +
        '<div class="drow"><span>Data date</span><span>' + t3dArea.dataDate + '</span></div>';
    };

    const selectArea = (area) => {
      t3dArea = area;
      img.src = T3D_ASSET_BASE + area.image;
      tabs.querySelectorAll('.t3d-tab').forEach((t) => t.classList.toggle('active', t.dataset.id === area.id));
      wrap.querySelectorAll('.t3d-dot').forEach((d) => d.remove());
      area.sections.forEach((s, i) => {
        const d = document.createElement('div');
        d.className = 't3d-dot pulse';
        d.style.left = s.x + '%';
        d.style.top = s.y + '%';
        d.style.background = t3dColor(s.pct);
        d.title = s.name + ' — ' + pctTxt(s.pct);
        if (!calMode) d.addEventListener('click', () => selectSection(i));
        wrap.appendChild(d);
      });
      if (calMode) enableCal(area);
      legend.innerHTML = area.sections.map((s, i) =>
        '<li data-i="' + i + '"><span class="ld" style="background:' + t3dColor(s.pct) + '"></span>' +
        '<span class="nm">' + s.name + '</span>' +
        '<span class="pc" style="color:' + t3dColor(s.pct) + '">' + pctTxt(s.pct) + '</span></li>').join('');
      legend.querySelectorAll('li').forEach((li) =>
        li.addEventListener('click', () => selectSection(+li.dataset.i)));
      detail.innerHTML = '<p class="muted">Select a tunnel section to see its progress.</p>';
    };

    if (!tabs.children.length) {
      TUNNEL_AREAS.forEach((area) => {
        const b = document.createElement('button');
        b.className = 't3d-tab';
        b.dataset.id = area.id;
        b.textContent = area.label;
        b.addEventListener('click', () => selectArea(area));
        tabs.appendChild(b);
      });
      const calBtn = document.getElementById('t3d-cal-btn');
      if (calBtn) calBtn.addEventListener('click', () => {
        calMode = !calMode;
        calBtn.textContent = calMode ? '✓ Done — Copy coords from the panel' : '⊹ Calibrate dots';
        calBtn.classList.toggle('active', calMode);
        selectArea(t3dArea); // re-render with dragging on/off
      });
    }
    selectArea(t3dArea);
  }

  function renderFinancial() {
    const fd = data.financeDetail;
    if (!fd) return;
    const b = fd.budget, rc = fd.received;
    const usdM = (v) => (v / 1e6).toFixed(2);
    const nprB = (v) => (v / 1e9).toFixed(2);
    const nprM = (v) => (v / 1e6).toFixed(1);
    setKpi('f-cusd', b.workUSD / 1e6, 2);
    setKpi('f-cnpr', b.workNPR / 1e6, 0); // NPR in millions — matches Executive Summary
    setKpi('f-rusd', rc.usd / 1e6, 2);
    setKpi('f-rnpr', rc.npr / 1e6, 0); // NPR in millions — matches Executive Summary
    const fb = finBasis(b);
    setKpi('f-prog', finProgPct(b), 1);
    const eq = nprEquivalents(b, rc);
    $('#f-c-eq').textContent = eq.contract;
    $('#f-r-eq').textContent = eq.received;
    const ret = fd.retention || { usd: 0, npr: 0 };
    setKpi('f-ret-usd', ret.usd / 1e6, 2);
    setKpi('f-ret-npr', ret.npr / 1e6, 1);
    // Combined retention held as a single USD-equivalent (NPR converted at 133.03).
    const fRetEq = document.getElementById('f-ret-eq');
    if (fRetEq) fRetEq.textContent = (ret.usd || ret.npr) ? `≈ $ ${((ret.usd + ret.npr / 133.03) / 1e6).toFixed(2)} M total` : '—';

    // Advance Payment amortisation — compact popover, one progress bar per
    // advance × currency. There are two amortisable advances:
    //  1) Mobilization Advance (USD + NPR) — live from the finance sheet.
    //  2) Monsoon Material Advance (NPR only) — disbursed amount from the IPS;
    //     deductions aren't in the live feed yet, so recovery shows 0 until then.
    const adv = fd.advance;
    const advances = [];
    if (adv) advances.push({ name: 'Mobilization Advance', lines: [
      { cur: 'USD', disbursed: adv.disbursedUSD, recovered: adv.recoveredUSD },
      { cur: 'NPR', disbursed: adv.disbursedNPR, recovered: adv.recoveredNPR },
    ] });
    advances.push({ name: 'Monsoon Material Advance', lines: [
      { cur: 'NPR', disbursed: (adv && adv.monsoonDisbursedNPR) || 0, recovered: (adv && adv.monsoonRecoveredNPR) || 0 },
    ] });
    // Headline amortised % for the KPI card (combined, NPR-equivalent).
    const arate = (b.workUSDEq > b.workUSD && b.workNPR) ? b.workNPR / (b.workUSDEq - b.workUSD) : 133;
    const advNpr = (a) => a.lines.reduce((s, l) => s + (l.cur === 'USD' ? l.disbursed * arate : l.disbursed), 0);
    const recNpr = (a) => a.lines.reduce((s, l) => s + (l.cur === 'USD' ? l.recovered * arate : l.recovered), 0);
    const totDisb = advances.reduce((s, a) => s + advNpr(a), 0);
    const totRec = advances.reduce((s, a) => s + recNpr(a), 0);
    setKpi('adv-pct', totDisb ? Math.round((totRec / totDisb) * 1000) / 10 : 0, 1);
    const fmtAmt = (cur, v) => (cur === 'USD' ? `$ ${usdM(v)} M` : `NPR ${nprM(v)} M`);
    const advPop = document.getElementById('f-advance');
    advPop.innerHTML = `<div class="adv-pop-head">Advance Payment — Amortisation</div>` +
      advances.map((a) => `<div class="adv-grp"><div class="adv-name">${a.name}</div>` +
        a.lines.filter((l) => l.disbursed > 0).map((l) => {
          const pct = l.disbursed > 0 ? Math.round((l.recovered / l.disbursed) * 1000) / 10 : 0;
          return `<div class="adv-row">
            <div class="adv-lab"><span>${l.cur}</span><b>${pct}%</b></div>
            <div class="adv-track"><i data-w="${pct}" class="${pct >= 100 ? 'full' : ''}"></i></div>
            <div class="adv-sub">Deducted ${fmtAmt(l.cur, l.recovered)} of ${fmtAmt(l.cur, l.disbursed)} · Balance ${fmtAmt(l.cur, l.disbursed - l.recovered)}</div>
          </div>`;
        }).join('') + `</div>`).join('') +
      `<p class="adv-note">Recovered as advance deductions on each IPC${adv && adv.recoveredNPR === 0 ? ' — not started yet' : ''}.</p>`;
    requestAnimationFrame(() => advPop.querySelectorAll('.adv-track > i').forEach((b) => { b.style.width = b.dataset.w + '%'; }));

    // Wire the toggle once: icon opens/closes the popover; click-away closes it.
    const advToggle = document.getElementById('adv-toggle');
    if (advToggle) {
      advToggle.onclick = (e) => {
        // The popover now lives inside the card, so ignore clicks that came
        // from within it — only the card itself toggles.
        if (advPop.contains(e.target)) return;
        e.stopPropagation();
        advPop.hidden = !advPop.hidden;
      };
      if (!advDocWired) {
        advDocWired = true;
        document.addEventListener('click', (e) => {
          if (!advPop.hidden && !advPop.contains(e.target) && !advToggle.contains(e.target)) advPop.hidden = true;
        });
      }
    }

    // Earned Value by category pie (work done, weighted by USD-equivalent)
    const cats = fd.earnedByCategory || [];
    const CHIPCOL = { A: '#5b46c9', B: '#2f6fd0', C: '#1d8a63', D: '#b9772a', E: '#c0414b', F: '#445876' };
    const catColor = (name) => {
      const hit = Object.entries({ 'Hydro-mechanical': 'A', 'Mobilisation': 'B', 'Headwork': 'C', 'Headrace': 'D', 'Surge': 'E', 'Powerhouse': 'F' })
        .find(([k]) => name.indexOf(k) === 0 || name.indexOf(k) >= 0);
      return hit ? CHIPCOL[hit[1]] : '#9aa7b8';
    };
    const evChart = makeChart('f-evpie');
    evChart.setOption({
      // 1 dp, matching the share shown in the slice's detail table below.
      tooltip: { trigger: 'item', formatter: (p) => `${p.name}<br/><b>$ ${usdM(p.value)} M</b> (${Number(p.percent).toFixed(1)}%)` },
      series: [{
        type: 'pie', radius: ['40%', '70%'], center: ['50%', '50%'],
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { show: false }, labelLine: { show: false },
        data: cats.map((c) => ({ name: c.category, value: Math.round(c.usdEquiv), itemStyle: { color: catColor(c.category) } })),
      }],
    });
    const evTotal = cats.reduce((s, c) => s + c.usdEquiv, 0) || 1;
    // Clicking a slice breaks the category open into its Activity Schedule
    // lines (ACS_D -> D.1…D.8), so you can see which activity earned what.
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    const pct1 = (a, b) => Math.round((a / (b || 1)) * 1000) / 10;
    evChart.off('click');
    evChart.on('click', (p) => {
      const c = cats[p.dataIndex];
      const head = `<b style="color:${catColor(c.category)}">${c.category}</b> — $ ${usdM(c.usdEquiv)} M earned ` +
        `· <b>${pct1(c.usdEquiv, evTotal)}%</b> of total ` +
        `<span class="muted">($ ${usdM(c.usd)} M + NPR ${nprM(c.npr)} M)</span>`;
      const items = c.items || [];
      const active = items.filter((it) => it.usdEquiv > 0);
      const idle = items.length - active.length;
      if (!active.length) {
        expandDetail('f-evdetail', head + `<div class="muted" style="font-size:11px;margin-top:8px">`
          + `No activity in this category has earned value yet.</div>`);
        return;
      }
      const rows = active.map((it) => `<tr>
          <td><b>${esc(it.code)}</b><div class="muted" style="font-size:11px" title="${esc(it.name)}">${esc(trunc(it.name, 52))}</div></td>
          <td style="white-space:nowrap">$ ${usdM(it.usdEquiv)} M</td>
          <td>${pct1(it.usdEquiv, c.usdEquiv)}%</td>
          <td>${pct1(it.usdEquiv, it.contractUsdEq)}%</td>
        </tr>`).join('');
      expandDetail('f-evdetail', head
        + `<div class="ipc-sub" style="text-align:left;margin-top:10px">Activity-wise earned value</div>`
        + `<table class="tbl"><thead><tr><th>Activity</th><th>Earned (USD-eq)</th>`
        + `<th title="Share of this category's earned value">Share</th>`
        + `<th title="Earned against this activity's own contract amount">Done</th></tr></thead>`
        + `<tbody>${rows}</tbody></table>`
        + (idle ? `<div class="muted" style="font-size:11px;margin-top:6px">`
          + `+ ${idle} further ${idle === 1 ? 'activity' : 'activities'} not started (nil earned value).</div>` : ''));
    });

    // donut: certified vs outstanding work value (USD-equivalent)
    // Label off the workbook's own Financial-Progress % (fb.pct) — the exact
    // value the KPI shows — rather than letting ECharts recompute and round its
    // own percentage, so the donut and the KPI can never disagree.
    const donutPct = (name) => (name === 'Certified' ? fb.pct : Math.round((100 - fb.pct) * 10) / 10);
    const donut = makeChart('f-donut');
    donut.setOption({
      tooltip: { trigger: 'item',
        formatter: (p) => `${p.name}<br/><b>$ ${usdM(p.value)} M</b> (${donutPct(p.name)}%)` },
      legend: { bottom: 0, textStyle: { fontSize: 11, color: COL.muted } },
      series: [{
        type: 'pie', radius: ['48%', '72%'], center: ['50%', '45%'], avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { show: true, formatter: (p) => donutPct(p.name) + '%', fontSize: 11, fontWeight: 700, color: COL.muted },
        data: [
          { name: 'Certified', value: Math.round(fb.certifiedEq), itemStyle: { color: '#2fae7a' } },
          { name: 'Outstanding', value: Math.round(fb.outstandingEq), itemStyle: { color: '#f2a65a' } },
        ],
      }],
    });
    // Click "Certified" -> show the earned-value breakdown by work category.
    donut.off('click');
    donut.on('click', (p) => {
      if (p.name === 'Certified') {
        const body = cats.map((c) =>
          `<tr><td>${c.category}</td><td>$ ${usdM(c.usdEquiv)} M</td>
            <td>${Math.round((c.usdEquiv / evTotal) * 1000) / 10}%</td></tr>`).join('');
        expandDetail('f-donut-detail', `<div class="ipc-sub" style="text-align:left">Earned value — work done by category</div>
          <table class="tbl"><thead><tr><th>Category</th><th>Earned (USD-eq)</th><th>Weightage</th></tr></thead>
          <tbody>${body}</tbody></table>`);
      } else {
        expandDetail('f-donut-detail', `<span>Outstanding work value: <b>$ ${usdM(fb.outstandingEq)} M</b> ` +
          `(${donutPct('Outstanding')}% of contract still to certify)</span>`);
      }
    });

    // bar: cash received per IPC (NPR, millions)
    const ipcs = fd.ipcs || [];
    const bar = makeChart('f-bar');
    bar.setOption({
      grid: { left: 44, right: 12, top: 16, bottom: 56 },
      tooltip: { trigger: 'axis',
        formatter: (ps) => {
          const i = ipcs[ps[0].dataIndex];
          return `<b>${i.ipc}</b>${i.certifiedDate ? ' · ' + i.certifiedDate : ''}<br/>` +
            `Received: NPR ${nprM(i.receivedNPR)} M` + (i.receivedUSD ? ` + $ ${usdM(i.receivedUSD)} M` : '') +
            `<br/>Status: ${i.status}`;
        } },
      xAxis: { type: 'category', data: ipcs.map((i) => i.ipc.replace('Advance Payment', 'Adv')),
        axisLabel: { fontSize: 9, color: COL.muted, rotate: 38 }, axisLine: { lineStyle: { color: '#cfd8e6' } } },
      yAxis: { type: 'value', name: 'NPR M', nameTextStyle: { fontSize: 10, color: COL.muted },
        splitLine: { lineStyle: { color: COL.grid } }, axisLabel: { fontSize: 10, color: COL.muted } },
      series: [{ type: 'bar', barWidth: '58%',
        data: ipcs.map((i) => ({
          value: Math.round(i.receivedNPR / 1e6),
          // Advance Payment bar shown in amber to set it apart from the IPCs.
          itemStyle: { borderRadius: [4, 4, 0, 0], color: i.isAdvance
            ? new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#f5a623' }, { offset: 1, color: '#f2c879' }])
            : new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: COL.accent }, { offset: 1, color: COL.accent2 }]) },
        })) }],
    });
    // Clicking a bar breaks that certificate open into the activities it paid for.
    bar.off('click');
    bar.on('click', (p) => {
      const i = ipcs[p.dataIndex];
      if (!i) return;
      const lbl = ipcStatusLabel(i.status);
      const badge = `<span class="badge ${lbl === 'Settled' ? 'ok' : lbl === 'Rejected' ? 'bad' : 'warn'}">${lbl}</span>`;
      const head = `<div style="text-align:left"><b>${i.ipc}</b>`
        + (i.certifiedDate ? ` <span class="muted">· certified ${i.certifiedDate}</span>` : '') + ` ${badge}`
        + `<br/><span class="muted">Received</span> <b>NPR ${nprM(i.receivedNPR)} M</b>`
        + (i.receivedUSD ? ` + <b>$ ${usdM(i.receivedUSD)} M</b>` : '') + `</div>`;
      const paid = (i.items || []).filter((it) => it.netUSD || it.netNPR);
      expandDetail('f-bardetail', head + (paid.length
        ? `<div class="ipc-sub" style="text-align:left;margin-top:10px">Activity-wise payment</div>` + itemsTable(i.items)
        : `<div class="muted" style="font-size:11px;margin-top:8px">`
          + `No sub-activity breakdown recorded for this certificate.</div>`));
    });

    // IPC register accordion
    document.getElementById('f-ipccount').textContent = ipcs.length;
    // Natural sort of activity codes (A.3.3 < B.1 < B.2 < B.10 < B.11 < C.2 …).
    const codeKey = (c) => String(c).split(/[.\s]+/).map((s) => (/^\d+$/.test(s) ? s.padStart(4, '0') : s)).join('.');
    const itemsTable = (items) => {
      // Only items with a certified amount, sorted & grouped by ACS activity.
      const rows = (items || []).filter((it) => it.netUSD || it.netNPR)
        .sort((a, b) => (codeKey(a.code) < codeKey(b.code) ? -1 : 1));
      let body = '', grp = null;
      for (const it of rows) {
        if (it.activityGroup !== grp) {
          grp = it.activityGroup;
          const label = grp ? `Activity ${grp} — ${it.activityGroupName || ''}` : (it.category || 'Other');
          body += `<tr class="ipc-grp"><td colspan="5">${label}</td></tr>`;
        }
        body += `<tr><td>${it.code}</td><td style="text-align:left">${it.activityName || it.category || ''}</td>
          <td>${it.paymentPct != null ? it.paymentPct + '%' : '–'}</td>
          <td>${it.netUSD ? '$ ' + usdM(it.netUSD) + ' M' : '–'}</td>
          <td>${it.netNPR ? nprM(it.netNPR) + ' M' : '–'}</td></tr>`;
      }
      return `<table class="tbl">
        <thead><tr><th>Item</th><th></th><th>Payment&nbsp;%</th><th>Net (USD)</th><th>Net (NPR)</th></tr></thead>
        <tbody>${body}</tbody></table>`;
    };
    const instalTable = (ins) => `
      <table class="tbl">
        <thead><tr><th>Tranche</th><th>Date</th><th>USD</th><th>NPR</th></tr></thead>
        <tbody>${ins.map((x) => `
          <tr><td>${x.label}</td><td>${x.date || '–'}</td>
            <td>${x.amountUSD ? '$ ' + usdM(x.amountUSD) + ' M' : '–'}</td>
            <td>${x.amountNPR ? nprM(x.amountNPR) + ' M' : '–'}</td></tr>`).join('')}
        </tbody>
      </table>`;
    const statusBadge = (s) => { const l = ipcStatusLabel(s); return `<span class="badge ${l === 'Settled' ? 'ok' : l === 'Rejected' ? 'bad' : 'warn'}">${l}</span>`; };
    // Full accounting breakdown (taxable → net) shown when "Details" is toggled.
    const fUSD = (v) => (v ? '$ ' + (+v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–');
    const fNPR = (v) => (v ? (+v).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '–');
    const detailPanel = (i) => {
      const rows = (i.items || []).map((it) => { const x = it.detail || {}; return `<tr>
        <td style="white-space:nowrap"><b>${it.code || ''}</b></td>
        <td>${it.paymentPct != null ? it.paymentPct + '%' : '–'}</td>
        <td>${fUSD(x.taxableUSD)}</td><td>${fNPR(x.taxableNPR)}</td>
        <td>${fUSD(x.vatUSD)}</td><td>${fNPR(x.vatNPR)}</td>
        <td>${fUSD(x.totalUSD)}</td><td>${fNPR(x.totalNPR)}</td>
        <td>${fUSD(x.tdsUSD)}</td>
        <td>${fUSD(x.advanceUSD)}</td><td>${fNPR(x.advanceNPR)}</td>
        <td>${fUSD(x.ded15USD)}</td><td>${fNPR(x.ded15NPR)}</td>
        <td>${fUSD(x.retUSD)}</td><td>${fUSD(x.vat30USD)}</td>
        <td><b>${fUSD(x.netUSD || it.netUSD)}</b></td><td><b>${fNPR(x.netNPR || it.netNPR)}</b></td></tr>`; }).join('');
      const dt = i.detail || {};
      const info = [
        ['Certified letter', i.certifiedLetter || dt.certLetter],
        ['IPS submission', dt.ipsDate], ['Certified date', i.certifiedDate || dt.certDate],
        ['Due date', i.dueDate || dt.dueDate], ['Exchange rate', i.exchangeRate || dt.exchangeRate],
        ['Received (NPR)', dt.receivedNPR ? fNPR(dt.receivedNPR) : (i.receivedNPR ? fNPR(i.receivedNPR) : null)],
        ['Remaining (NPR)', dt.remainingNPR ? fNPR(dt.remainingNPR) : null],
      ].filter(([, v]) => v != null && v !== '').map(([k, v]) => `<div class="ipc-di"><span>${k}</span><b>${v}</b></div>`).join('');
      return `<div class="ipc-details" hidden>
        <div class="ipc-diwrap">${info}</div>
        ${rows ? `<div class="ipc-dscroll"><table class="tbl ipc-dtable"><thead><tr>
          <th>Item</th><th>Pay&nbsp;%</th><th>Taxable USD</th><th>Taxable NPR</th><th>VAT USD</th><th>VAT NPR</th>
          <th>Total USD</th><th>Total NPR</th><th>TDS USD</th><th>Adv USD</th><th>Adv NPR</th><th>15%-AP USD</th><th>15%-AP NPR</th>
          <th>Retn USD</th><th>VAT30 USD</th><th>Net USD</th><th>Net NPR</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="muted" style="font-size:11px">No per-activity breakdown recorded for this certificate.</div>'}
      </div>`;
    };
    // Reverse chronological — newest IPC first (Advance Payment, the oldest, last).
    const ipcsDesc = ipcs.slice().sort((a, b) => (b.certifiedDate || '').localeCompare(a.certifiedDate || ''));
    document.getElementById('f-ipclist').innerHTML = ipcsDesc.map((i, idx) => `
      <div class="ipc" data-i="${idx}">
        <div class="ipc-head">
          <span class="ipc-name">${i.ipc}</span>
          <span class="ipc-date">${i.certifiedDate || ''}</span>
          <span class="ipc-amt">Net <b>$${usdM(i.netUSD)}M</b> / <b>NPR ${nprM(i.netNPR)}M</b></span>
          <span class="ipc-amt">Recv <b>NPR ${nprM(i.receivedNPR)}M</b></span>
          ${statusBadge(i.status)}
          <span class="ipc-caret">▸</span>
        </div>
        <div class="ipc-body">
          <button class="ipc-details-btn" type="button">⊞ Details</button>
          ${i.items.length ? '<div class="ipc-sub">Work Items (' + i.items.length + ')</div>' + itemsTable(i.items) : ''}
          ${detailPanel(i)}
        </div>
      </div>`).join('');
    document.querySelectorAll('#f-ipclist .ipc-head').forEach((h) =>
      h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
    document.querySelectorAll('#f-ipclist .ipc-details-btn').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const panel = b.parentElement.querySelector('.ipc-details');
        if (panel) { panel.hidden = !panel.hidden; b.classList.toggle('on', !panel.hidden); }
      }));
  }

  let schedBuiltFor = null;
  let schedTabsWired = false; // one-time wiring for the Schedule/Delay sub-tabs
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const schDay = (iso) => Math.floor(new Date(iso + 'T00:00:00Z').getTime() / 86400000);
  const schFmt = (iso) => { if (!iso) return ''; const p = iso.split('-'); return p[2] + '-' + MON[+p[1] - 1] + '-' + p[0].slice(2); };

  // Browser-side XER parser (mirrors lib/xer.js) so an uploaded P6 export can be
  // processed entirely in the page, replacing the current schedule.
  function parseXerClient(text) {
    const tables = {};
    let cur = null, fields = null;
    for (const raw of text.split(/\r?\n/)) {
      if (raw.startsWith('%T')) { cur = raw.split('\t')[1]; tables[cur] = []; fields = null; }
      else if (raw.startsWith('%F')) { fields = raw.split('\t').slice(1); }
      else if (raw.startsWith('%R') && cur && fields) {
        const v = raw.split('\t').slice(1); const row = {};
        fields.forEach((f, i) => { row[f] = v[i]; }); tables[cur].push(row);
      }
    }
    const MILE = new Set(['TT_Mile', 'TT_FinMile', 'TT_StartMile']);
    const ST = { TK_NotStart: 'Not Started', TK_Active: 'In Progress', TK_Complete: 'Complete' };
    const PR = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF' };
    const iso = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
    const num = (v) => (v == null || v === '' ? 0 : parseFloat(v));
    const wbs = {};
    (tables.PROJWBS || []).forEach((w) => { wbs[w.wbs_id] = { name: w.wbs_name, parentId: w.parent_wbs_id, seq: parseInt(w.seq_num, 10) || 0 }; });
    const activities = (tables.TASK || []).map((r) => ({
      taskId: r.task_id, id: r.task_code, name: r.task_name, wbsId: r.wbs_id,
      status: ST[r.status_code] || r.status_code, pct: Math.round(num(r.phys_complete_pct)),
      isMilestone: MILE.has(r.task_type),
      start: iso(r.act_start_date) || iso(r.early_start_date) || iso(r.target_start_date) || iso(r.restart_date),
      finish: iso(r.act_end_date) || iso(r.early_end_date) || iso(r.target_end_date) || iso(r.reend_date),
      baselineStart: iso(r.target_start_date), baselineFinish: iso(r.target_end_date),
      totalFloatDays: Math.round((num(r.total_float_hr_cnt) / 8) * 10) / 10,
      critical: num(r.total_float_hr_cnt) <= 0,
    }));
    const relationships = (tables.TASKPRED || []).map((r) => ({
      taskId: r.task_id, predTaskId: r.pred_task_id, type: PR[r.pred_type] || r.pred_type,
      lagDays: Math.round((num(r.lag_hr_cnt) / 8) * 10) / 10,
    }));
    return { activities, relationships, wbs };
  }

  function handleXerUpload(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      let parsed;
      try {
        parsed = parseXerClient(reader.result);
        if (!parsed.activities.length) { alert('No activities (TASK table) found in this XER file.'); return; }
      } catch (err) { alert('Could not read this XER file: ' + err.message); return; }
      // Show it immediately…
      data = data || {};
      data.schedule = parsed;
      schedBuiltFor = null;
      renderSchedule();
      const src = $('#sch-src');
      if (src) src.textContent = '· uploaded: ' + file.name + ' (saving…)';
      // …then persist so it permanently replaces the baseline (survives refresh).
      try {
        const r = await authFetch('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activities: parsed.activities, relationships: parsed.relationships, wbs: parsed.wbs }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        if (src) src.textContent = '· uploaded: ' + file.name + ' (saved)';
      } catch (err) {
        if (src) src.textContent = '· uploaded: ' + file.name + ' — NOT saved';
        alert('The schedule is shown but could not be saved permanently: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  async function resetSchedule() {
    if (!confirm('Reset the Schedule tab back to the baseline from the project files?')) return;
    try {
      const r = await authFetch('/api/schedule', { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      const src = $('#sch-src'); if (src) src.textContent = '';
      schedBuiltFor = null;
      load(); // refetch the baseline
    } catch (err) { alert('Could not reset the schedule: ' + err.message); }
  }

  function renderSchedule() {
    const sch = data.schedule || {};
    const all = sch.activities || [];
    const wbs = sch.wbs || {};
    const acts = all.filter((a) => a.start && a.finish);
    if (!acts.length || schedBuiltFor === data) return;
    schedBuiltFor = data;
    $('#sch-count').textContent = acts.length;

    const byTask = {};
    all.forEach((a) => { byTask[a.taskId] = a; });
    const predMap = {}, succMap = {};
    (sch.relationships || []).forEach((r) => {
      (predMap[r.taskId] = predMap[r.taskId] || []).push(r);
      (succMap[r.predTaskId] = succMap[r.predTaskId] || []).push(r);
    });

    // WBS tree (children sorted by seq, activities per node). The WBS grouping is
    // KEPT in the left activity list; only the WBS summary bars are dropped from
    // the Gantt timeline.
    const kids = {};
    Object.keys(wbs).forEach((id) => { const p = wbs[id].parentId; (kids[p] = kids[p] || []).push(id); });
    Object.values(kids).forEach((a) => a.sort((x, y) => (wbs[x].seq || 0) - (wbs[y].seq || 0)));
    const actsByWbs = {};
    acts.forEach((a) => { (actsByWbs[a.wbsId] = actsByWbs[a.wbsId] || []).push(a); });
    Object.values(actsByWbs).forEach((arr) => arr.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (a.id < b.id ? -1 : 1))));
    const roots = Object.keys(wbs).filter((id) => !wbs[wbs[id].parentId]);

    const minDay = Math.min(...acts.map((a) => schDay(a.start)));
    const maxDay = Math.max(...acts.map((a) => schDay(a.finish)));
    let pxd = 0.7;                 // px per day — mutable: timescale drag zooms it
    const ROW = 22, HEAD = 28, PAD = 16;
    const xOf = (d) => PAD + (d - minDay) * pxd;
    const widthOf = () => (maxDay - minDay) * pxd + PAD * 2;
    const todayD = Math.floor(Date.now() / 86400000);

    // Two-tier P6 timescale: years across the top, months below — plus faint
    // full-height month/year gridlines. Rebuilt each paint so zoom rescales it.
    const buildAxis = () => {
      let years = '', months = '', grid = '';
      const lo = new Date(minDay * 86400000), hi = new Date(maxDay * 86400000);
      let dt = new Date(Date.UTC(lo.getUTCFullYear(), lo.getUTCMonth(), 1));
      while (Math.floor(dt.getTime() / 86400000) <= maxDay) {
        const mStart = Math.floor(dt.getTime() / 86400000);
        const next = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1));
        const w = (Math.floor(next.getTime() / 86400000) - mStart) * pxd, x = xOf(mStart);
        months += `<div class="g-mo" style="left:${x}px;width:${w}px">${w < 22 ? MON[dt.getUTCMonth()][0] : MON[dt.getUTCMonth()]}</div>`;
        grid += `<div class="g-grid ${dt.getUTCMonth() === 0 ? 'yr' : ''}" style="left:${x}px"></div>`;
        dt = next;
      }
      for (let y = lo.getUTCFullYear(); y <= hi.getUTCFullYear(); y++) {
        const s = Math.max(minDay, Math.floor(Date.UTC(y, 0, 1) / 86400000));
        const e = Math.min(maxDay, Math.floor(Date.UTC(y + 1, 0, 1) / 86400000));
        years += `<div class="g-yr" style="left:${xOf(s)}px;width:${(e - s) * pxd}px">${y}</div>`;
      }
      return { header: `<div class="g-axis-yr">${years}</div><div class="g-axis-mo">${months}</div>`, grid };
    };

    const list = document.getElementById('g-list');
    const time = document.getElementById('g-time');
    const collapsed = new Set();
    let rows = [], selTask = null, relOn = false, critOnly = false;

    // Critical Path toggle filters the visible activities (and prunes empty WBS).
    const visActs = (id) => (actsByWbs[id] || []).filter((a) => !critOnly || a.critical);
    const subHas = (id) => visActs(id).length > 0 || (kids[id] || []).some(subHas);

    const buildRows = () => {
      const out = [];
      const walk = (id, depth) => {
        if (!subHas(id)) return;
        out.push({ kind: 'wbs', id, depth });
        if (collapsed.has(id)) return;
        (kids[id] || []).forEach((c) => walk(c, depth + 1));
        visActs(id).forEach((a) => out.push({ kind: 'act', act: a, depth: depth + 1 }));
      };
      roots.forEach((r) => walk(r, 0));
      return out;
    };

    const HEADER = '<div class="g-head"><span class="g-cid">Act ID<span class="g-col-resize" title="Drag to resize the Activity ID column"></span></span><span class="g-cnm">Activity Name</span>' +
      '<span class="g-cas">Act Start</span><span class="g-cas">Act Finish</span>' +
      '<span class="g-cbs">BL Start</span><span class="g-cbs">BL Finish</span><span class="g-cpc">%</span></div>';

    const paint = () => {
      rows = buildRows();
      const nAct = rows.reduce((n, r) => n + (r.kind === 'act' ? 1 : 0), 0);
      $('#sch-count').textContent = critOnly ? nAct + ' critical' : acts.length;
      list.innerHTML = HEADER + rows.map((r, i) => {
        if (r.kind === 'wbs') {
          return `<div class="g-row g-wbs ${collapsed.has(r.id) ? 'collapsed' : ''}" data-i="${i}" data-wbs="${r.id}">
            <span class="g-cid"></span><span class="g-cnm" style="padding-left:${r.depth * 12}px"><span class="g-caret">▾</span>${wbs[r.id].name || ''}</span>
            <span class="g-cas"></span><span class="g-cas"></span><span class="g-cbs"></span><span class="g-cbs"></span><span class="g-cpc"></span></div>`;
        }
        const a = r.act;
        return `<div class="g-row" data-i="${i}" data-tid="${a.taskId}">
          <span class="g-cid" title="${a.id}">${a.id}</span><span class="g-cnm" style="padding-left:${r.depth * 12}px" title="${a.name || ''}">${a.name || ''}</span>
          <span class="g-cas">${schFmt(a.actualStart) || '—'}</span><span class="g-cas">${schFmt(a.actualFinish) || '—'}</span>
          <span class="g-cbs">${schFmt(a.baselineStart)}</span><span class="g-cbs">${schFmt(a.baselineFinish)}</span><span class="g-cpc">${a.pct}%</span></div>`;
      }).join('');
      if (selTask) list.querySelector(`.g-row[data-tid="${selTask}"]`)?.classList.add('sel');

      const width = widthOf();
      const bars = rows.map((r, i) => {
        if (r.kind === 'wbs') return ''; // no WBS summary bar in the Gantt
        const a = r.act, top = HEAD + i * ROW, x = xOf(schDay(a.start));
        // Thin grey baseline (planned/target) bar beneath the activity — shows
        // actual-vs-plan slippage at a glance (P6 style).
        const base = (a.baselineStart && a.baselineFinish)
          ? `<div class="g-base" style="left:${xOf(schDay(a.baselineStart))}px;width:${Math.max(2, (schDay(a.baselineFinish) - schDay(a.baselineStart)) * pxd)}px;top:${top + 17}px" title="Baseline: ${schFmt(a.baselineStart)} → ${schFmt(a.baselineFinish)}"></div>` : '';
        if (a.isMilestone) return `${base}<div class="g-ms ${a.critical ? 'crit' : ''}" data-i="${i}" data-tid="${a.taskId}" style="left:${x - 5}px;top:${top + (ROW - 11) / 2}px"></div>`;
        const w = Math.max(3, (schDay(a.finish) - schDay(a.start)) * pxd);
        // Two-tone progress: solid "done" segment (left, = pct%) over a light
        // "remaining" track — clear even on the red critical bars.
        return `${base}<div class="g-bar ${a.critical ? 'crit' : 'norm'}" data-i="${i}" data-tid="${a.taskId}" style="left:${x}px;width:${w}px;top:${top + (ROW - 11) / 2}px" title="${a.id} · ${a.name || ''} · ${a.pct}%"><div class="g-done" style="width:${a.pct}%"></div></div>`;
      }).join('');
      const H = HEAD + rows.length * ROW;
      const todayLine = (todayD >= minDay && todayD <= maxDay)
        ? `<div class="g-today" style="left:${xOf(todayD)}px;top:${HEAD}px;height:${rows.length * ROW}px"></div>` : '';
      const ax = buildAxis();
      time.innerHTML = `<div class="g-canvas" style="width:${width}px;height:${H}px">
        ${ax.grid}<div class="g-axis" id="g-axis" style="width:${width}px" title="Drag left/right to zoom the timescale">${ax.header}</div>${todayLine}
        <svg class="g-rellines" id="g-rellines" width="${width}" height="${H}"></svg>${bars}</div>`;
      if (selTask) time.querySelector(`[data-tid="${selTask}"]`)?.classList.add('hl');
      drawRel();
    };

    // P6-style relationship lines across the whole Gantt (orthogonal elbows),
    // type-aware endpoints. Only between currently-visible activities; the
    // selected activity's links are emphasised in amber.
    const drawRel = () => {
      const svg = document.getElementById('g-rellines');
      if (!svg) return;
      if (!relOn) { svg.innerHTML = ''; return; }
      const idxOf = {}; rows.forEach((r, i) => { if (r.kind === 'act') idxOf[r.act.taskId] = i; });
      const yOf = (i) => HEAD + i * ROW + ROW / 2;
      const xS = (a) => xOf(schDay(a.start)), xF = (a) => xOf(schDay(a.finish));
      let paths = '';
      (sch.relationships || []).forEach((r) => {
        const pi = idxOf[r.predTaskId], xi = idxOf[r.taskId];
        if (pi == null || xi == null) return;
        const p = byTask[r.predTaskId], s = byTask[r.taskId];
        let x1, x2;
        if (r.type === 'SS') { x1 = xS(p); x2 = xS(s); }
        else if (r.type === 'FF') { x1 = xF(p); x2 = xF(s); }
        else if (r.type === 'SF') { x1 = xS(p); x2 = xF(s); }
        else { x1 = xF(p); x2 = xS(s); } // FS
        const y1 = yOf(pi), y2 = yOf(xi), mx = x1 + 7;
        const sel = (selTask === r.predTaskId || selTask === r.taskId);
        paths += `<path class="${sel ? 'sel' : ''}" d="M${x1},${y1} L${mx},${y1} L${mx},${y2} L${x2},${y2}"/>`;
      });
      svg.innerHTML = paths;
    };

    // Non-blocking bottom detail pane (P6-style): predecessor & successor tables.
    const detail = document.getElementById('g-detail');
    const tbl = (arr) => `<table class="tbl"><thead><tr><th>Activity ID</th><th>Activity Name</th><th>Type</th><th>Lag</th></tr></thead>
      <tbody>${arr.map((x) => `<tr data-tid="${x.act.taskId}"><td>${x.act.id}</td><td style="text-align:left">${x.act.name || ''}</td><td>${x.type}</td><td>${x.lag ? x.lag + 'd' : '0'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">None</td></tr>'}</tbody></table>`;
    const stRow = (label, val) => `<div class="g-st-row"><span>${label}</span><b>${val}</b></div>`;
    const renderDetail = (a) => {
      const preds = (predMap[a.taskId] || []).map((r) => ({ act: byTask[r.predTaskId], type: r.type, lag: r.lagDays })).filter((x) => x.act);
      const succs = (succMap[a.taskId] || []).map((r) => ({ act: byTask[r.taskId], type: r.type, lag: r.lagDays })).filter((x) => x.act);
      const od = (a.baselineStart && a.baselineFinish) ? (schDay(a.baselineFinish) - schDay(a.baselineStart)) : null;
      // P6 "Status" panel: started/finished/% plus the key schedule dates.
      const status =
        `<div class="g-detail-status">
          <h4>Status</h4>
          ${stRow('Started', a.actualStart ? '☑ ' + schFmt(a.actualStart) : '☐ not started')}
          ${stRow('Finished', a.actualFinish ? '☑ ' + schFmt(a.actualFinish) : '☐ —')}
          ${stRow('% Complete', a.pct + '%')}
          ${stRow('Activity Status', a.status)}
          <h4 style="margin-top:9px">Schedule</h4>
          ${stRow('Start', schFmt(a.start) || '—')}
          ${stRow('Finish', schFmt(a.finish) || '—')}
          ${stRow('Baseline Start', schFmt(a.baselineStart) || '—')}
          ${stRow('Baseline Finish', schFmt(a.baselineFinish) || '—')}
          ${stRow('Original Duration', od != null ? od + ' d' : '—')}
          ${stRow('Total Float', (a.totalFloatDays != null ? a.totalFloatDays : '—') + ' d')}
        </div>`;
      detail.innerHTML =
        `<div class="g-detail-title">${a.id} — ${a.name || ''} <span>· ${a.status} · ${a.pct}% complete</span></div>
        <div class="g-detail-grid">
          <div class="g-detail-rels">
            <div><h4>Predecessors (${preds.length})</h4>${tbl(preds)}</div>
            <div><h4>Successors (${succs.length})</h4>${tbl(succs)}</div>
          </div>
          ${status}
        </div>`;
      detail.querySelectorAll('tr[data-tid]').forEach((tr) => tr.addEventListener('click', () => {
        select(tr.dataset.tid);
        list.querySelector(`.g-row[data-tid="${tr.dataset.tid}"]`)?.scrollIntoView({ block: 'center' });
      }));
    };

    const select = (tid) => {
      selTask = tid;
      list.querySelectorAll('.g-row').forEach((r) => r.classList.remove('sel'));
      time.querySelectorAll('.hl').forEach((b) => b.classList.remove('hl'));
      list.querySelector(`.g-row[data-tid="${tid}"]`)?.classList.add('sel');
      time.querySelector(`[data-tid="${tid}"]`)?.classList.add('hl');
      drawRel();
      renderDetail(byTask[tid]);
    };

    list.onclick = (e) => {
      const w = e.target.closest('.g-wbs');
      if (w) { const id = w.dataset.wbs; collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); paint(); return; }
      const r = e.target.closest('.g-row[data-tid]'); if (r) select(r.dataset.tid);
    };
    // Resizable Activity ID column — drag the handle on the header's right edge.
    // Width is held in a CSS variable so every row's cell follows live.
    list.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.g-col-resize')) return;
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX, startW = parseInt(getComputedStyle(list).getPropertyValue('--cid-w')) || 80;
      const mv = (ev) => { list.style.setProperty('--cid-w', Math.max(54, Math.min(360, startW + ev.clientX - startX)) + 'px'); };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });
    time.onclick = (e) => { const b = e.target.closest('[data-tid]'); if (b) select(b.dataset.tid); };

    let lock = false;
    time.onscroll = () => { if (lock) return; lock = true; list.scrollTop = time.scrollTop; lock = false; };
    list.onscroll = () => { if (lock) return; lock = true; time.scrollTop = list.scrollTop; lock = false; };

    // draggable splitter
    const split = document.getElementById('g-split');
    split.onmousedown = (e) => {
      e.preventDefault();
      const sx = e.clientX, sw = list.offsetWidth;
      const mv = (ev) => { list.style.width = Math.max(200, Math.min(760, sw + ev.clientX - sx)) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    };

    // vertical splitter: resize the bottom detail pane (drag up = taller)
    const vsplit = document.getElementById('g-vsplit');
    vsplit.onmousedown = (e) => {
      e.preventDefault();
      const sy = e.clientY, sh = detail.offsetHeight;
      const mv = (ev) => { detail.style.height = Math.max(60, Math.min(420, sh - (ev.clientY - sy))) + 'px'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    };

    document.getElementById('sch-rellines').onclick = (e) => {
      relOn = !relOn; e.currentTarget.classList.toggle('on', relOn); drawRel();
    };
    document.getElementById('sch-critical').onclick = (e) => {
      critOnly = !critOnly; e.currentTarget.classList.toggle('on', critOnly);
      paint();
      if (selTask) select(selTask); // keep selection highlighted after re-paint
    };
    document.getElementById('sch-search').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      if (!q) return;
      const hit = acts.find((a) => (a.id || '').toLowerCase().includes(q) || (a.name || '').toLowerCase().includes(q));
      if (!hit) return;
      let p = hit.wbsId; while (p && wbs[p]) { collapsed.delete(p); p = wbs[p].parentId; } // expand ancestors
      paint(); select(hit.taskId);
      list.querySelector(`.g-row[data-tid="${hit.taskId}"]`)?.scrollIntoView({ block: 'center' });
    };

    // P6-style timescale zoom: press on the date header and drag — right zooms
    // in (months & bars grow), left zooms out — keeping the day under the cursor
    // anchored in place. Repaints are coalesced so a fast drag stays smooth.
    let zooming = false, zoomPending = false;
    time.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#g-axis')) return;
      e.preventDefault();
      const startX = e.clientX, startPxd = pxd, rect = time.getBoundingClientRect();
      const frac = (time.scrollLeft + (e.clientX - rect.left)) / widthOf();
      const applyZoom = (clientX) => {
        pxd = Math.max(0.12, Math.min(8, startPxd * (1 + (clientX - startX) / 250)));
        paint();
        time.scrollLeft = frac * widthOf() - (clientX - rect.left);
      };
      const mv = (ev) => {
        if (zooming) { zoomPending = ev.clientX; return; } // drop intermediate frames
        zooming = true; applyZoom(ev.clientX);
        // flush the most recent position queued while we were painting
        while (zoomPending !== false) { const x = zoomPending; zoomPending = false; applyZoom(x); }
        zooming = false;
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    });

    paint();
  }

  // ---- Delay & Disruption sub-tab (derived from the XER delay-event windows) ----
  // Each DE activity under a "Delay Event Window N" WBS is an event; its cause is
  // inferred from the description and colour-coded.
  const DD_CATS = [
    { test: /land acquisition|tree cutting/i, name: 'Land Acquisition', color: '#b9772a' },
    { test: /force majeure/i, name: 'Force Majeure', color: '#e5554e' },
    { test: /employer instruction|suspension|gcap/i, name: 'Employer Instruction', color: '#5b46c9' },
    { test: /disruption|supply chain|glof/i, name: 'Supply Chain / GLOF', color: '#2f7de1' },
  ];
  const ddCat = (name) => DD_CATS.find((c) => c.test.test(name || '')) || { name: 'Other', color: '#7b8aa0' };

  function renderDelays() {
    // Delay & Disruption reads the TIA schedule (separate from the baseline).
    const sch = data.delaySchedule || data.schedule || {};
    const wbs = sch.wbs || {};
    const winOf = (wbsId) => {
      let p = wbsId, g = 0;
      while (p && wbs[p] && g++ < 20) {
        const m = (wbs[p].name || '').match(/delay\s*event[s]?\s*window\s*(\d+)/i);
        if (m) return +m[1];
        p = wbs[p].parentId;
      }
      return null;
    };
    const events = (sch.activities || [])
      .map((a) => ({ a, win: winOf(a.wbsId) }))
      .filter((x) => x.win != null || /^DE\d+/i.test(x.a.id || ''))
      .map(({ a, win }) => ({
        id: a.id, name: a.name || '', win: win || 0, start: a.start, finish: a.finish,
        dur: (a.start && a.finish) ? (schDay(a.finish) - schDay(a.start)) : null,
        float: a.totalFloatDays, critical: a.critical, status: a.status, cat: ddCat(a.name),
      }))
      .filter((e) => e.start && e.finish)
      .sort((a, b) => (a.win - b.win) || (a.start < b.start ? -1 : 1));

    const tableEl = document.getElementById('dd-table');
    if (!events.length) { tableEl.innerHTML = '<p class="muted">No delay events found in the schedule.</p>'; return; }

    const wins = new Set(events.map((e) => e.win)).size;
    const crit = events.filter((e) => e.critical).length;
    const minD = events.reduce((m, e) => (e.start < m ? e.start : m), events[0].start);
    const maxD = events.reduce((m, e) => (e.finish > m ? e.finish : m), events[0].finish);
    $('#dd-summary').textContent = `· ${events.length} events · ${wins} windows · ${crit} critical · ${schFmt(minD)} → ${schFmt(maxD)}`;

    const cats = [];
    events.forEach((e) => { if (!cats.find((c) => c.name === e.cat.name)) cats.push(e.cat); });
    $('#dd-legend').innerHTML = cats.map((c) => `<span class="leg"><i style="background:${c.color}"></i>${c.name}</span>`).join('');

    tableEl.innerHTML = `
      <table class="tbl"><thead><tr>
        <th>Event</th><th>Win</th><th>Cause</th><th>Description</th>
        <th>Start</th><th>Finish</th><th>Days</th><th>Float</th><th>Status</th></tr></thead>
      <tbody>${events.map((e, i) => `<tr data-i="${i}">
        <td><b>${e.id}</b></td><td>${e.win || '–'}</td>
        <td><span class="dd-cat" style="background:${e.cat.color}">${e.cat.name}</span></td>
        <td class="dd-desc">${e.name}</td>
        <td>${schFmt(e.start)}</td><td>${schFmt(e.finish)}</td>
        <td>${e.dur != null ? e.dur : '–'}</td>
        <td class="${e.critical ? 'dd-crit' : ''}">${e.float != null ? e.float : '–'}</td>
        <td>${e.status}</td></tr>`).join('')}</tbody></table>`;
    tableEl.querySelectorAll('tr[data-i]').forEach((tr) => tr.addEventListener('click', () => {
      tableEl.querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel'));
      tr.classList.add('sel');
    }));

    // Delay timeline — ECharts custom Gantt (one bar per event, coloured by cause).
    const ms = (iso) => new Date(iso + 'T00:00:00Z').getTime();
    const rows = events.map((e) => `W${e.win} · ${e.id}`);
    const chart = makeChart('dd-timeline');
    chart.setOption({
      grid: { left: 118, right: 24, top: 10, bottom: 38 },
      tooltip: { trigger: 'item', formatter: (p) => {
        const e = events[p.dataIndex];
        return `<b>${e.id}</b> · ${e.cat.name}<br/>${e.name}<br/>${schFmt(e.start)} → ${schFmt(e.finish)} · ${e.dur} d<br/>Float: ${e.float} d${e.critical ? ' · <b style="color:#e5554e">critical</b>' : ''}`;
      } },
      xAxis: { type: 'time', axisLabel: { fontSize: 10, color: COL.muted }, splitLine: { lineStyle: { color: COL.grid } } },
      yAxis: { type: 'category', data: rows, inverse: true,
        axisLabel: { fontSize: 9.5, color: COL.muted }, axisTick: { show: false }, axisLine: { lineStyle: { color: '#cfd8e6' } } },
      series: [{
        type: 'custom',
        renderItem: (params, api) => {
          const yi = api.value(0);
          const s = api.coord([api.value(1), yi]);
          const e = api.coord([api.value(2), yi]);
          const h = Math.max(6, api.size([0, 1])[1] * 0.5);
          const shape = echarts.graphic.clipRectByRect(
            { x: s[0], y: s[1] - h / 2, width: Math.max(2, e[0] - s[0]), height: h },
            { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height });
          return shape && { type: 'rect', shape, style: { fill: api.visual('color') } };
        },
        encode: { x: [1, 2], y: 0 },
        data: events.map((e, i) => ({ value: [i, ms(e.start), ms(e.finish)], itemStyle: { color: e.cat.color } })),
      }],
    });
    chart.resize();
  }

  // Placeholder Inventory & Explosives tables — structure for seniors now; the
  // cells auto-fill once the inventory sheet is linked.
  const INV_MATERIALS = ['Cement (bags)', 'Reinforcement Steel (MT)', 'Aggregate (m³)', 'Sand (m³)', 'Shotcrete (m³)', 'Structural Steel / Liner (MT)', 'Diesel (L)', 'Cement Grout (bags)'];
  const INV_EXPLOSIVES = ['Emulsion Explosive (kg)', 'Detonators — Electric (pcs)', 'Detonators — Non-electric (pcs)', 'Detonating Cord (m)', 'Safety Fuse (m)', 'ANFO (kg)'];
  function renderInventory() {
    const d = '—';
    const matBody = INV_MATERIALS.map((m) => `<tr><td style="text-align:left">${m}</td><td>${d}</td><td>${d}</td><td>${d}</td><td>${d}</td></tr>`).join('');
    const mat = document.getElementById('inv-mat');
    if (mat) mat.innerHTML = `<table class="tbl"><thead><tr><th style="text-align:left">Material</th><th>Opening</th><th>Received</th><th>Consumed</th><th>Closing Balance</th></tr></thead><tbody>${matBody}</tbody></table>`;
    const expBody = INV_EXPLOSIVES.map((m) => `<tr><td style="text-align:left">${m}</td><td>${d}</td><td>${d}</td><td>${d}</td></tr>`).join('');
    const exp = document.getElementById('inv-exp');
    if (exp) exp.innerHTML = `<table class="tbl"><thead><tr><th style="text-align:left">Explosive Item</th><th>Received</th><th>Consumed</th><th>Magazine Balance</th></tr></thead><tbody>${expBody}</tbody></table>`;
    // Compact snapshot for the Executive Summary (key items · balance only).
    const exec = document.getElementById('inv-exec');
    if (exec) {
      const items = ['Cement (bags)', 'Reinforcement Steel (MT)', 'Aggregate (m³)', 'Diesel (L)', 'Emulsion Explosive (kg)', 'Detonators (pcs)'];
      const body = items.map((m) => `<tr><td style="text-align:left">${m}</td><td>${d}</td><td>${d}</td></tr>`).join('');
      exec.innerHTML = `<table class="tbl"><thead><tr><th style="text-align:left">Item</th><th>Consumed</th><th>Balance</th></tr></thead><tbody>${body}</tbody></table>`;
    }
  }

  // Weekly Progress snapshot — summarised from the Weekly Technical Progress
  // Review PPT shown to the OE (Meeting No. 28, data date 26-Jun-2026). Embedded
  // as a fixed weekly snapshot (not part of the live feed).
  const WEEKLY = {
    meeting: 'No. 29', dataDate: '03 Jul 2026',
    overall: { plan: 72.13, actual: 21.01, varc: -51.12, wk: 0.30 },
    tunnels: [
      { name: 'HRT F-1', pct: 34.84, week: 20.90, plan: 30 },
      { name: 'HRT F-2', pct: 7.20, week: 25.42, plan: 30 },
      { name: 'HRT F-3', pct: 3.05, week: 3.19, plan: 18 },
      { name: 'Adit #3', pct: 97.72, week: 26.59, plan: 21.84 },
      { name: 'Adit #4', pct: 95.74, week: 19.65, plan: 15 },
      { name: 'Access to Valve Chamber', pct: 46.34, week: 9.68, plan: 15 },
    ],
    hse: { safeHrs: 2266209, safeHrsWk: 43428, recordable: 15, recordableWk: 0, lti: 1, nearMiss: 1, firstAid: 92, ch: 42, on: 100, ln: 376, mpWk: 50 },
    explosives: [
      { name: 'Explosives #32mm (kg)', week: 7239.7, stock: 103364.5 },
      { name: 'Detonating Cord (m)', week: 2424.49, stock: 78724 },
      { name: 'Electric Detonator (pcs)', week: 74, stock: 3634 },
      { name: 'Non-Electric Detonator (pcs)', week: 6939, stock: 310702 },
    ],
    qc: { ncrTotal: 29, ncrOpen: 11, ncrClosed: 16, ncrWk: 2, rfiTotal: 1749, rfiApproved: 1511, rfiRejected: 238, rfiWk: 40 },
  };
  function renderWeekly() {
    const el = document.getElementById('weekly');
    if (!el) return;
    const w = WEEKLY;
    const n = (v) => Number(v).toLocaleString('en-US');
    const sub = (t) => `<div class="ipc-sub" style="margin:0 0 6px">${t}</div>`;
    const tun = w.tunnels.map((t) => `<tr><td style="text-align:left">${t.name}</td><td>${t.pct}%</td><td>${t.week.toFixed(2)}</td><td class="muted">${t.plan}</td></tr>`).join('');
    const exp = w.explosives.map((e) => `<tr><td style="text-align:left">${e.name}</td><td>${n(e.week)}</td><td>${n(e.stock)}</td></tr>`).join('');
    // HSE & safety — stat tiles (nicer than a table for these headline metrics).
    const h = w.hse;
    const mpTot = h.ch + h.on + h.ln;
    const evTile = (val, label, color) => `<div style="background:#f4f7fb;border-radius:9px;padding:8px 4px;text-align:center">
      <div style="font-size:16px;font-weight:800;color:${color};line-height:1">${val}</div>
      <div style="font-size:8.5px;text-transform:uppercase;letter-spacing:.3px;color:#8595aa;font-weight:700;margin-top:3px">${label}</div></div>`;
    const hseCard = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div style="background:linear-gradient(135deg,#edf7f1,#e2f1e9);border-radius:11px;padding:10px 12px">
          <div style="font-size:19px;font-weight:800;color:#15764e;letter-spacing:-.5px;line-height:1">${n(h.safeHrs)}</div>
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:#5b7c6c;font-weight:700;margin-top:4px">Safe man-hours</div>
          <div style="font-size:10.5px;color:#1c9c66;font-weight:700;margin-top:3px">▲ ${n(h.safeHrsWk)} this week</div>
        </div>
        <div style="background:linear-gradient(135deg,#fbf3ee,#f7e9e0);border-radius:11px;padding:10px 12px">
          <div style="font-size:19px;font-weight:800;color:#b5502a;letter-spacing:-.5px;line-height:1">${h.recordable}</div>
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:#9a6f5c;font-weight:700;margin-top:4px">Recordable incidents</div>
          <div style="font-size:10.5px;color:#9a6f5c;font-weight:700;margin-top:3px">${h.recordableWk > 0 ? '+' + h.recordableWk + ' this week' : 'no change this week'}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px">
        ${evTile(h.lti, 'LTI', h.lti > 0 ? '#c0392b' : '#1f3b66')}
        ${evTile(h.nearMiss, 'Near miss', h.nearMiss > 0 ? '#b5802a' : '#1f3b66')}
        ${evTile(h.firstAid, 'First aid', '#1f3b66')}
      </div>
      <div style="background:#eef2fb;border-radius:11px;padding:9px 13px;margin-top:8px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:#7b8aa0;font-weight:700">Manpower on site</div>
          <div style="font-size:11px;color:#51637e;font-weight:600;margin-top:3px">CH ${h.ch} · ON ${h.on} · LN ${h.ln}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:20px;font-weight:800;color:#1f3b66;letter-spacing:-.5px;line-height:1">${mpTot}</div>
          <div style="font-size:10px;color:#1c9c66;font-weight:700;margin-top:2px">▲ +${h.mpWk} this week</div>
        </div>
      </div>`;
    el.innerHTML = `<div class="card" style="margin-bottom:16px">
      <h3>Weekly Progress <span class="muted" style="font-weight:600">· Meeting ${w.meeting} · data date ${w.dataDate}</span></h3>
      <div style="font-size:12.5px;color:#41506a;margin:2px 0 14px">Overall progress (cost-based): Plan <b>${w.overall.plan}%</b> · Actual <b>${w.overall.actual}%</b> · <b style="color:var(--red)">Variance ${w.overall.varc}%</b> · this week <b>+${w.overall.wk}%</b></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:14px 24px">
        <div>${sub('Tunnel excavation — active faces')}<table class="tbl"><thead><tr><th style="text-align:left">Workface</th><th>Excav&nbsp;%</th><th>This&nbsp;wk&nbsp;(m)</th><th>Plan</th></tr></thead><tbody>${tun}</tbody></table></div>
        <div>${sub('HSE &amp; safety')}${hseCard}</div>
        <div>${sub('Explosives consumption')}<table class="tbl"><thead><tr><th style="text-align:left">Item</th><th>This&nbsp;wk</th><th>In&nbsp;stock</th></tr></thead><tbody>${exp}</tbody></table></div>
        <div>${sub('QC — NCR &amp; RFI')}<table class="tbl"><tbody>
          <tr><td style="text-align:left">NCR (total / open / closed)</td><td colspan="2">${w.qc.ncrTotal} / ${w.qc.ncrOpen} / ${w.qc.ncrClosed} <span class="muted">(+${w.qc.ncrWk} wk)</span></td></tr>
          <tr><td style="text-align:left">RFI (total / approved / rejected)</td><td colspan="2">${n(w.qc.rfiTotal)} / ${n(w.qc.rfiApproved)} / ${w.qc.rfiRejected} <span class="muted">(+${w.qc.rfiWk} wk)</span></td></tr>
        </tbody></table></div>
      </div>
    </div>`;
  }

  // Claims & Variations — curated snapshot of the Claim & Variation Log
  // (contractor's Statements of Claim, variations and EoT). Editorial summary
  // for clarity, refreshed from the log; not a live parse.
  const CLAIMS = {
    totalUSD: 6.775, totalNPR: 483.334, socCount: 8, approvedNPR: 0.275, eotDays: 350,
    claims: [
      { no: 'SoC #1', desc: 'Force Majeure — initial notice & request', basis: 'Force Majeure', usd: 0.028, npr: null, status: 'Rejected' },
      { no: 'SoC #2', desc: 'Road blockage due to landslide', basis: 'Force Majeure', usd: 0.020, npr: null, status: 'Not Approved' },
      { no: 'SoC #3', desc: 'Work stopped by Bigu Rural Municipality', basis: 'Force Majeure', usd: 0.155, npr: null, status: 'Not Approved' },
      { no: 'SoC #4', desc: 'Relocation of Adit-3 tunnel portal', basis: 'Site / design change', usd: 0.098, npr: null, status: 'Not Approved' },
      { no: 'SoC #5', desc: 'Work stoppage at Crusher Plant & Adit', basis: 'Force Majeure', usd: 0.111, npr: null, status: 'Not Approved' },
      { no: 'SoC #6', desc: 'Employer-instructed suspension of works', basis: 'Delays ordered by Employer', usd: 0.894, npr: 50.945, status: 'Not Approved' },
      { no: 'SoC #7', desc: 'Increase in excise duty of cement', basis: 'Change in legislation', usd: null, npr: 1.490, status: 'Not Approved' },
      { no: 'SoC #8', desc: 'Political insurrection, curfew & unrest', basis: 'Force Majeure', usd: 0.021, npr: 1.208, status: 'Not Approved' },
      { no: 'Prolongation', desc: 'Prolongation cost claim (EoT-related)', basis: 'Employer risk event', usd: 5.476, npr: null, status: 'Under review' },
    ],
    variations: [
      { desc: 'Additional Tailrace Surge Tunnel', basis: 'Value engineering', npr: 429.691, status: 'Estimating' },
      { desc: 'Head Race Tunnel variation', basis: "Errors in Employer's Requirements", npr: null, status: 'Rejected' },
      { desc: 'MAT / CVT relocation', basis: 'Cost & time', npr: null, status: 'Under review' },
      { desc: 'Crushing plant relocation (BP1 → Gongar)', basis: 'Compensation event', npr: null, status: 'Under review' },
    ],
    eot: [
      { desc: 'EoT-01 — Extension of Time application', period: '9 Jun 2024 – 30 Jun 2025', days: 350, status: 'Submitted' },
      { desc: 'Extension of Intended Completion Date', period: 'Baseline (TIA) pending', days: null, status: 'Under review' },
    ],
  };
  const claimBadge = (s) => {
    // Order matters: 'Not Approved' contains 'approv', so test the negative first.
    const cls = /reject|not\s*approv/i.test(s) ? 'bad' : /approv|submit|receiv|settl/i.test(s) ? 'ok' : 'neu';
    return `<span class="badge ${cls}">${s}</span>`;
  };
  // Map the live parsed claims payload onto the render shape (falls back to the
  // built-in CLAIMS snapshot when the workbook isn't available).
  function normClaims(src) {
    return {
      totalUSD: src.totalUSD, totalNPR: src.totalNPR, socCount: src.socCount,
      approvedNPR: src.approvedNPR, eotDays: src.eotDays, eotGranted: src.eotGranted, surgeNPR: src.surgeNPR,
      claims: (src.claims || []).map((x) => ({ no: x.no, desc: x.subject, basis: x.basis, usd: x.usd, npr: x.npr, status: x.status })),
      variations: (src.variations || []).map((x) => ({ desc: x.desc, basis: x.basis, npr: x.npr, status: x.status })),
      eot: (src.eot || []).map((x) => ({
        desc: x.no + ((x.usd || x.npr) ? ' — cost ' + (x.usd ? '$ ' + x.usd.toFixed(2) + 'M' : 'NPR ' + x.npr.toFixed(1) + 'M') : ''),
        period: x.remarks || '', days: x.eotDays, status: x.status,
      })),
    };
  }
  function renderClaims() {
    const el = document.getElementById('claims-body');
    if (!el) return;
    const c = (data && data.claims && !data.claims.missing) ? normClaims(data.claims) : CLAIMS;
    const amt = (u, n) => {
      const p = [];
      if (u) p.push('$ ' + u.toFixed(u < 0.1 ? 3 : 2) + 'M');
      if (n) p.push('NPR ' + n.toFixed(1) + 'M');
      return p.length ? p.join(' + ') : '—';
    };
    const claimRows = c.claims.map((x) => `<tr>
      <td style="white-space:nowrap"><b>${x.no}</b></td>
      <td style="text-align:left">${x.desc}</td>
      <td style="text-align:left" class="muted">${x.basis}</td>
      <td style="white-space:nowrap">${amt(x.usd, x.npr)}</td>
      <td>${claimBadge(x.status)}</td></tr>`).join('');
    const varRows = c.variations.map((x) => `<tr>
      <td style="text-align:left">${x.desc}</td>
      <td style="text-align:left" class="muted">${x.basis}</td>
      <td style="white-space:nowrap">${x.npr ? 'NPR ' + x.npr.toFixed(1) + 'M' : '—'}</td>
      <td>${claimBadge(x.status)}</td></tr>`).join('');
    const eotRows = c.eot.map((x) => `<tr>
      <td style="text-align:left">${x.desc}</td>
      <td class="muted">${x.period}</td>
      <td style="white-space:nowrap">${x.days ? '<b>' + x.days + ' d</b>' : '—'}</td>
      <td>${claimBadge(x.status)}</td></tr>`).join('');
    el.innerHTML = `
      <div class="grid kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
        <div class="card kpi"><h3>Total Value Claimed</h3>
          <div class="valm">$ <span>${c.totalUSD.toFixed(2)}</span> M</div>
          <div class="valm">NPR <span>${c.totalNPR.toFixed(1)}</span> M</div>
          <div class="sub">incl. surge-tunnel variation</div></div>
        <div class="card kpi"><h3>Statements of Claim</h3><div class="val">${c.socCount}</div><div class="sub">SoC #1–#${c.socCount} submitted</div></div>
        <div class="card kpi"><h3>Approved &amp; Received</h3><div class="valm">NPR ${c.approvedNPR.toFixed(2)} M</div><div class="sub">Provisional Sum — landslide cost</div></div>
        <div class="card kpi"><h3>EoT Sought</h3><div class="val">${c.eotDays} <span style="font-size:15px">days</span></div><div class="sub">${c.eotGranted ? c.eotGranted + ' days granted so far' : 'baseline (TIA) pending'}</div></div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <h3>Statements of Claim <span class="muted" style="font-weight:600">· amount claimed &amp; engineer's position</span></h3>
        <table class="tbl"><thead><tr><th>Claim</th><th style="text-align:left">Description</th><th style="text-align:left">Contractual basis</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${claimRows}</tbody></table>
        <div class="muted" style="font-size:11.5px;margin-top:8px">Total contractor's claim <b>$ ${c.totalUSD.toFixed(2)}M + NPR ${c.totalNPR.toFixed(1)}M</b>${(c.surgeNPR || (c.variations[0] && c.variations[0].npr)) ? ` — of which NPR ${(c.surgeNPR || c.variations[0].npr).toFixed(1)}M is the Additional Surge Tunnel variation` : ''}. Most claims remain pending or rejected by the Engineer.</div>
      </div>
      <div class="grid row-2">
        <div class="card"><h3>Variations &amp; Value Engineering</h3>
          <table class="tbl"><thead><tr><th style="text-align:left">Item</th><th style="text-align:left">Basis</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>${varRows}</tbody></table></div>
        <div class="card"><h3>Extensions of Time (EoT)</h3>
          <table class="tbl"><thead><tr><th style="text-align:left">Item</th><th>Period</th><th>EoT</th><th>Status</th></tr></thead>
          <tbody>${eotRows}</tbody></table></div>
      </div>`;
  }

  // ---- Financial Data Entry (admin) ----------------------------------------
  // An editable working copy of the financials that, once saved, drives the whole
  // dashboard (via /api/finance -> tkv:finance override) and can be exported to
  // the Milestone Payment Summary Excel format.
  let feModel = null, feWired = false;
  const feN = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
  function feSeed() {
    const fd = (data && data.financeDetail) || {};
    const b = fd.budget || {}, rc = fd.received || {}, ret = fd.retention || {}, adv = fd.advance || null;
    feModel = {
      budget: { workUSD: b.workUSD ?? null, workNPR: b.workNPR ?? null, progressPct: b.progressPct ?? null },
      received: { usd: rc.usd ?? null, npr: rc.npr ?? null },
      retention: { usd: ret.usd ?? null, npr: ret.npr ?? null },
      advance: adv ? { amortisedPct: adv.amortisedPct ?? 0, disbursedUSD: adv.disbursedUSD ?? null, disbursedNPR: adv.disbursedNPR ?? null,
        outstandingUSD: adv.outstandingUSD ?? null, outstandingNPR: adv.outstandingNPR ?? null } : null,
      earnedByCategory: (fd.earnedByCategory || []).map((c) => ({ group: c.group || '', category: c.category, usd: c.usd ?? null, npr: c.npr ?? null })),
      ipcs: (fd.ipcs || []).map((i) => ({
        ipc: i.ipc, certifiedDate: i.certifiedDate || '', certifiedLetter: i.certifiedLetter || '',
        dueDate: i.dueDate || '', exchangeRate: i.exchangeRate ?? null,
        netUSD: i.netUSD ?? null, netNPR: i.netNPR ?? null, receivedUSD: i.receivedUSD ?? null, receivedNPR: i.receivedNPR ?? null,
        status: i.status || '', isAdvance: !!i.isAdvance,
        items: (i.items || []).map((it) => { const d = it.detail || {}; return { code: it.code || '', activityName: it.activityName || '', paymentPct: it.paymentPct ?? null,
          netUSD: it.netUSD ?? null, netNPR: it.netNPR ?? null,
          taxableUSD: d.taxableUSD ?? it.taxableUSD ?? null, taxableNPR: d.taxableNPR ?? it.taxableNPR ?? null,
          advanceUSD: d.advanceUSD ?? it.advanceUSD ?? null, advanceNPR: d.advanceNPR ?? it.advanceNPR ?? null,
          ded15USD: d.ded15USD ?? it.ded15USD ?? null, ded15NPR: d.ded15NPR ?? it.ded15NPR ?? null }; }),
      })),
    };
  }
  const feEsc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const feInp = (path, val, numeric, ph) => `<input class="fe-input" data-fe="${path}"${numeric ? ' data-fe-num="1" type="number" step="any"' : ''} value="${feEsc(val)}"${ph ? ` placeholder="${ph}"` : ''}>`;
  const feFld = (label, path, val, numeric) => `<div class="fe-field"><label>${label}</label>${feInp(path, val, numeric)}</div>`;
  function renderFinanceEntry() {
    const host = document.getElementById('fin-entry');
    if (!host) return;
    if (!feModel) feSeed();
    const m = feModel;
    const kpi = `<div class="fe-sec">Headline figures</div><div class="fe-grid">
      ${feFld('Contract USD', 'budget.workUSD', m.budget.workUSD, true)}
      ${feFld('Contract NPR', 'budget.workNPR', m.budget.workNPR, true)}
      ${feFld('Financial progress %', 'budget.progressPct', m.budget.progressPct, true)}
      ${feFld('Total received USD', 'received.usd', m.received.usd, true)}
      ${feFld('Total received NPR', 'received.npr', m.received.npr, true)}
      ${feFld('Retention USD', 'retention.usd', m.retention.usd, true)}
      ${feFld('Retention NPR', 'retention.npr', m.retention.npr, true)}
      ${m.advance ? feFld('Advance amortised %', 'advance.amortisedPct', m.advance.amortisedPct, true) : ''}
    </div>`;
    const cats = `<div class="fe-sec">Earned value by category</div>
      <table class="fe-table"><thead><tr><th style="width:44%">Category</th><th>USD</th><th>NPR</th><th></th></tr></thead><tbody>
      ${m.earnedByCategory.map((c, i) => `<tr>
        <td>${feInp('earnedByCategory.' + i + '.category', c.category)}</td>
        <td>${feInp('earnedByCategory.' + i + '.usd', c.usd, true)}</td>
        <td>${feInp('earnedByCategory.' + i + '.npr', c.npr, true)}</td>
        <td><button class="fe-x" data-fe-del="cat.${i}" title="Remove">✕</button></td></tr>`).join('')}
      </tbody></table><button class="fe-btn" data-fe-add="cat" style="margin-top:8px">+ Add category</button>`;
    const ipcs = `<div class="fe-sec">IPC register &amp; per-activity payments</div>
      ${m.ipcs.map((ip, i) => `<div class="fe-ipc">
        <div class="fe-ipc-head">
          ${feFld('IPC', 'ipcs.' + i + '.ipc', ip.ipc)}
          ${feFld('Certified date', 'ipcs.' + i + '.certifiedDate', ip.certifiedDate)}
          ${feFld('Certified letter', 'ipcs.' + i + '.certifiedLetter', ip.certifiedLetter)}
          ${feFld('Net USD', 'ipcs.' + i + '.netUSD', ip.netUSD, true)}
          ${feFld('Net NPR', 'ipcs.' + i + '.netNPR', ip.netNPR, true)}
          ${feFld('Recv USD', 'ipcs.' + i + '.receivedUSD', ip.receivedUSD, true)}
          ${feFld('Recv NPR', 'ipcs.' + i + '.receivedNPR', ip.receivedNPR, true)}
          ${feFld('Status', 'ipcs.' + i + '.status', ip.status)}
          <button class="fe-x" data-fe-del="ipc.${i}" title="Remove IPC" style="margin-bottom:2px">✕</button>
        </div>
        <div style="overflow-x:auto"><table class="fe-table" style="margin-top:10px;min-width:820px"><thead><tr><th>Activity</th><th>Pay %</th><th>Taxable USD</th><th>Taxable NPR</th><th>Adv NPR</th><th>Less 15%-AP NPR</th><th>Net USD</th><th>Net NPR</th><th></th></tr></thead><tbody>
        ${ip.items.map((it, j) => `<tr>
          <td>${feInp('ipcs.' + i + '.items.' + j + '.code', it.code)}</td>
          <td style="width:64px">${feInp('ipcs.' + i + '.items.' + j + '.paymentPct', it.paymentPct, true)}</td>
          <td>${feInp('ipcs.' + i + '.items.' + j + '.taxableUSD', it.taxableUSD, true)}</td>
          <td>${feInp('ipcs.' + i + '.items.' + j + '.taxableNPR', it.taxableNPR, true)}</td>
          <td>${feInp('ipcs.' + i + '.items.' + j + '.advanceNPR', it.advanceNPR, true)}</td>
          <td>${feInp('ipcs.' + i + '.items.' + j + '.ded15NPR', it.ded15NPR, true)}</td>
          <td>${feInp('ipcs.' + i + '.items.' + j + '.netUSD', it.netUSD, true)}</td>
          <td>${feInp('ipcs.' + i + '.items.' + j + '.netNPR', it.netNPR, true)}</td>
          <td><button class="fe-x" data-fe-del="item.${i}.${j}" title="Remove">✕</button></td></tr>`).join('')}
        </tbody></table></div><button class="fe-btn" data-fe-add="item.${i}" style="margin-top:8px">+ Add activity</button>
      </div>`).join('')}
      <button class="fe-btn" data-fe-add="ipc">+ Add IPC</button>`;
    host.innerHTML = `<div class="fe-actions">
        <button class="fe-btn primary" data-fe-act="save">Save &amp; apply</button>
        <button class="fe-btn" data-fe-act="export">⬇ Export Excel</button>
        <button class="fe-btn" data-fe-act="undo">Undo edits</button>
        <button class="fe-btn danger" data-fe-act="reset">Reset to Excel source</button>
        <span class="fe-msg" id="fe-msg"></span>
      </div>${kpi}${cats}${ipcs}`;
  }
  function feMsg(text, cls) { const el = document.getElementById('fe-msg'); if (el) { el.textContent = text; el.className = 'fe-msg ' + (cls || ''); } }
  function feSet(path, val) { const t = path.split('.'); let o = feModel; for (let k = 0; k < t.length - 1; k++) { o = o[t[k]]; if (o == null) return; } o[t[t.length - 1]] = val; }
  // Live-derive Net from Taxable using the source formula (Net = Taxable × 1.026
  // for USD; NPR applies the same VAT/TDS/retention/VAT-30% chain), so typing the
  // taxable amount fills the net columns. The server recomputes exactly on save.
  function feComputeItemNet(i, j) {
    const it = feModel.ipcs[i] && feModel.ipcs[i].items[j]; if (!it) return;
    const F = +it.taxableUSD || 0, G = +it.taxableNPR || 0;
    const advN = +it.advanceNPR || 0, dedN = +it.ded15NPR || 0;
    const vatN = Math.round(G * 0.13 * 100) / 100;
    if (F) it.netUSD = Math.round(F * 1.026 * 100) / 100;
    // Net NPR = Total + TDS + Advance + 15%-AP deduction + Retention + VAT-30% (source formula W).
    if (G) it.netNPR = Math.round(((G + vatN) - G * 0.015 + advN + dedN - G * 0.05 - vatN * 0.30) * 100) / 100;
    const host = document.getElementById('fin-entry');
    const nu = host.querySelector('[data-fe="ipcs.' + i + '.items.' + j + '.netUSD"]'); if (nu && F) nu.value = it.netUSD;
    const nn = host.querySelector('[data-fe="ipcs.' + i + '.items.' + j + '.netNPR"]'); if (nn && G) nn.value = it.netNPR;
  }
  function feDel(spec) {
    const [kind, i, j] = spec.split('.');
    if (kind === 'cat') feModel.earnedByCategory.splice(+i, 1);
    else if (kind === 'ipc') feModel.ipcs.splice(+i, 1);
    else if (kind === 'item') feModel.ipcs[+i].items.splice(+j, 1);
    renderFinanceEntry();
  }
  function feAdd(spec) {
    const [kind, i] = spec.split('.');
    if (kind === 'cat') feModel.earnedByCategory.push({ group: '', category: 'New category', usd: null, npr: null });
    else if (kind === 'ipc') feModel.ipcs.push({ ipc: 'IPC-', certifiedDate: '', certifiedLetter: '', netUSD: null, netNPR: null, receivedUSD: null, receivedNPR: null, status: 'Under review', isAdvance: false, items: [] });
    else if (kind === 'item') feModel.ipcs[+i].items.push({ code: '', activityName: '', paymentPct: null, netUSD: null, netNPR: null, taxableUSD: null, taxableNPR: null, advanceUSD: null, advanceNPR: null, ded15USD: null, ded15NPR: null });
    renderFinanceEntry();
  }
  async function feSave() {
    feMsg('Saving…', '');
    try {
      const r = await authFetch('/api/finance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: feModel }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { feMsg(j.error || ('Save failed (' + r.status + ')'), 'err'); return; }
      feMsg('Saved — refreshing dashboard…', 'ok');
      await load();          // pull the now-overridden payload
      feSeed(); renderFinanceEntry();
      feMsg('Saved & applied ✓', 'ok');
    } catch (e) { feMsg('Save failed: ' + e.message, 'err'); }
  }
  async function feReset() {
    if (!confirm('Discard the app data and revert the dashboard to the live Excel source?')) return;
    feMsg('Reverting…', '');
    try {
      const r = await authFetch('/api/finance', { method: 'DELETE' });
      if (!r.ok) { const j = await r.json().catch(() => ({})); feMsg(j.error || 'Reset failed', 'err'); return; }
      await load(); feSeed(); renderFinanceEntry();
      feMsg('Reverted to Excel source ✓', 'ok');
    } catch (e) { feMsg('Reset failed: ' + e.message, 'err'); }
  }
  async function feExport() {
    feMsg('Building Excel…', '');
    try {
      const r = await authFetch('/api/finance?export=1');
      if (!r.ok) { const j = await r.json().catch(() => ({})); feMsg(j.error || 'Export failed — save first', 'err'); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'Milestone Payment Summary.xlsx';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      feMsg('Exported ✓', 'ok');
    } catch (e) { feMsg('Export failed: ' + e.message, 'err'); }
  }
  function wireFinanceEntry() {
    if (feWired) return; feWired = true;
    document.querySelectorAll('#fin-subtabs .fin-subtab').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#fin-subtabs .fin-subtab').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const entry = b.dataset.fintab === 'entry';
      document.getElementById('fin').classList.toggle('entry-mode', entry);
      const host = document.getElementById('fin-entry'); if (host) host.hidden = !entry;
      if (entry) { feSeed(); renderFinanceEntry(); }
    }));
    const host = document.getElementById('fin-entry');
    if (host) {
      host.addEventListener('input', (e) => {
        const p = e.target.dataset.fe; if (!p) return;
        feSet(p, e.target.dataset.feNum ? feN(e.target.value) : e.target.value);
        const m = p.match(/^ipcs\.(\d+)\.items\.(\d+)\.(?:taxable(?:USD|NPR)|advanceNPR|ded15NPR)$/);
        if (m) feComputeItemNet(+m[1], +m[2]);
      });
      host.addEventListener('click', (e) => {
        const t = e.target.closest('[data-fe-act],[data-fe-add],[data-fe-del]'); if (!t) return;
        if (t.dataset.feAct === 'save') feSave();
        else if (t.dataset.feAct === 'reset') feReset();
        else if (t.dataset.feAct === 'export') feExport();
        else if (t.dataset.feAct === 'undo') { feSeed(); renderFinanceEntry(); feMsg('Edits discarded', ''); }
        else if (t.dataset.feAdd) feAdd(t.dataset.feAdd);
        else if (t.dataset.feDel) feDel(t.dataset.feDel);
      });
    }
  }

  function renderAll() {
    renderKpis();
    renderFinancial();
    renderInventory();
    renderWeekly();
    renderClaims();
    renderSchedule();
    // Wire the Schedule/Delay sub-tabs once; render the delay view lazily on show.
    if (!schedTabsWired) {
      schedTabsWired = true;
      document.querySelectorAll('.sched-tab').forEach((btn) => btn.addEventListener('click', () => {
        const which = btn.dataset.stab;
        document.querySelectorAll('.sched-tab').forEach((b) => b.classList.toggle('on', b === btn));
        document.getElementById('stab-schedule').hidden = which !== 'schedule';
        document.getElementById('stab-delay').hidden = which !== 'delay';
        if (which === 'delay') renderDelays();
      }));
    }
    renderSCurve('ch-scurve');
    renderAdvanceChart('ch-tunnel-advance');
    renderTunnelBars();
    renderManpower();
    renderIpc();
    $('#data-source').textContent = data.source === 'nutstore' ? 'Nutstore' : 'Local sample';
    $('#last-refresh').textContent = 'Last refresh: ' + new Date(data.generatedAt).toLocaleTimeString();
    if (data.warnings && data.warnings.length) {
      showBanner('Data warnings: ' + data.warnings.join(' · '), true);
    }
  }

  // ---------- data ----------
  async function load() {
    const btn = $('#refresh');
    btn.classList.add('spin');
    try {
      const res = await authFetch('/api/data');
      if (res.status === 401) { showLogin('Your session has expired — please sign in again.'); return; }
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
      data = json;
      hideBanner();
      renderAll();
    } catch (err) {
      showBanner(
        data
          ? "Couldn't refresh from data source — showing last loaded data. (" + err.message + ')'
          : "Couldn't load data: " + err.message,
        false
      );
    } finally {
      btn.classList.remove('spin');
    }
  }

  // ---------- nav ----------
  document.getElementById('nav').addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (!item) return;
    const v = item.dataset.v;
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.view').forEach((s) => s.classList.remove('active'));
    // Admin section is admin-only; other sections need an explicit grant.
    if (v === 'admin') {
      if (!me || !me.isAdmin) { document.getElementById('denied').classList.add('active'); return; }
      document.getElementById('admin').classList.add('active');
      renderAdmin();
      return;
    }
    if (!canSee(v)) { document.getElementById('denied').classList.add('active'); return; }
    document.getElementById(v).classList.add('active');
    if (data) renderAll(); // re-trigger animations on the newly visible view
    setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 60);
  });

  $('#refresh').addEventListener('click', load);
  // Collapsible sidebar — toggle an icon-only rail to widen the content area.
  const sideToggle = document.getElementById('side-toggle');
  if (sideToggle) sideToggle.addEventListener('click', () => {
    document.querySelector('.app').classList.toggle('collapsed');
    setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 230);
  });
  window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()));
  $('#today').textContent = new Date().toLocaleDateString('en-GB',
    { day: '2-digit', month: 'short', year: 'numeric' });

  const xerInput = document.getElementById('sch-upload');
  if (xerInput) xerInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleXerUpload(f);
    e.target.value = ''; // allow re-uploading the same file
  });
  const schResetBtn = document.getElementById('sch-reset');
  if (schResetBtn) schResetBtn.addEventListener('click', resetSchedule);

  // ---------- boot: gate the whole app behind login ----------
  wireAuthUI();
  (async () => {
    if (await checkAuth()) startApp(); // renderTunnel3D + load() run inside startApp
    else showLogin();
  })();
})();
