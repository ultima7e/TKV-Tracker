(() => {
  const charts = {};
  let data = null;
  let advDocWired = false; // click-away handler for the advance-amortisation popover

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

  // Map the sheet's casual status text to professional payment-cycle terms.
  function ipcStatusLabel(s) {
    const t = (s || '').toLowerCase();
    if (/partial/.test(t)) return 'Partially Paid';
    if (/reject/.test(t)) return 'Rejected';
    if (/settl|complete|paid/.test(t)) return 'Settled';
    if (/certif/.test(t)) return 'Certified';
    if (/remain|pending|review|outstand|process|progress/.test(t)) return 'Under Review';
    return s || '—';
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
  // (% of render), extracted from the 3D deck (Data Date 31-Oct-2025).
  // Progress is embedded for now; it will later come from Excel.
  const T3D_ASSET_BASE = 'assets/'; // standalone file overrides with the Vercel URL
  const TUNNEL_AREAS = [
    { id: 'headwork', label: 'Headwork & HRT', image: 'tunnel-headwork.png', dataDate: '31 Oct 2025', sections: [
      { name: 'Adit #1', design: '167.77 m', excavated: '167.77 m', pct: 100, x: 58.4, y: 32.6 },
      { name: 'Connecting Tunnel', design: '93.85 m', excavated: '59.75 m', pct: 63.67, x: 45.8, y: 34.4 },
      { name: 'Construction Adit Tunnel', design: '21.60 m', excavated: '21.60 m', pct: 100, x: 43.3, y: 51.7 },
      { name: 'Headpond Layer 1~4', design: '11,959.47 m³', excavated: '11,959.47 m³', pct: 100, x: 25.1, y: 54.7 },
      { name: 'Spillway Tunnel', design: '277.75 m', excavated: '160.13 m', pct: 57.65, x: 60.3, y: 67.1 },
      { name: 'HRT-F1', design: '1,568.00 m', excavated: '150.85 m', pct: 9.62, x: 14.8, y: 66.8 },
    ] },
    { id: 'headrace', label: 'Headrace', image: 'tunnel-headrace.jpg', dataDate: '31 Oct 2025', sections: [
      { name: 'Adit #4', design: '407.34 m', excavated: '234.98 m', pct: 57.69, x: 69.0, y: 60.8 },
      { name: 'Access to Valve Chamber', design: '183.21 m', excavated: '0.00 m', pct: 0, x: 52.4, y: 46.5 },
      { name: 'Surge Chamber', design: '14,392.35 m³', pct: null, x: 35.6, y: 17.6 },
      { name: 'Valve Chamber', design: '14,518.80 m³', pct: null, x: 28.4, y: 21.8 },
      { name: 'Vertical Pressure Shaft', design: '114.44 m', pct: null, x: 22.0, y: 56.3 },
      { name: 'Lower Bend Shaft', design: '28.72 m', excavated: '5.95 m', pct: 20.72, x: 21.9, y: 65.8 },
      { name: 'Upper Bend Shaft', design: '28.72 m', pct: null, x: 28.8, y: 36.5 },
      { name: 'Headrace Tunnel', design: '8,110.28 m', pct: null, x: 61.5, y: 22.3 },
    ] },
    { id: 'powerhouse', label: 'Powerhouse', image: 'tunnel-powerhouse.jpg', dataDate: '31 Oct 2025', sections: [
      { name: 'Cable Ventilation Tunnel', design: '95.89 m', excavated: '95.89 m', pct: 100, x: 33.3, y: 74.7 },
      { name: 'Construction Tunnel', design: '57.92 m', excavated: '57.92 m', pct: 100, x: 53.0, y: 70.6 },
      { name: 'Main Access Tunnel', design: '285.63 m', excavated: '285.63 m', pct: 100, x: 66.7, y: 79.5 },
      { name: 'BusDuct Gallery 1~3', design: '100.5 m', excavated: '100.5 m', pct: 100, x: 37.8, y: 48.3 },
      { name: 'Access to HPT', design: '117.35 m', excavated: '117.35 m', pct: 100, x: 60.8, y: 45.4 },
      { name: 'HPT & U/S Manifold (1~4)', design: '19.60 m & 91.75 m', excavated: '19.60 m & 91.75 m', pct: 100, x: 44.1, y: 22.7 },
      { name: 'Access to TRC', design: '65.77 m', excavated: '65.77 m', pct: 100, x: 32.4, y: 66.4 },
      { name: 'TRC Layer-1~2', design: '12,360.00 m³', excavated: '12,360.00 m³', pct: 100, x: 28.8, y: 44.7 },
      { name: 'PHC Layer-1~6', design: '29,184.41 m³', excavated: '17,581.17 m³', pct: 60.24, x: 44.7, y: 33.1 },
      { name: 'Tailrace Surge Tunnel', design: '383.77 m', pct: null, x: 17.6, y: 54.8 },
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
        d.addEventListener('click', () => selectSection(i));
        wrap.appendChild(d);
      });
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
      advToggle.onclick = (e) => { e.stopPropagation(); advPop.hidden = !advPop.hidden; };
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
      tooltip: { trigger: 'item', formatter: (p) => `${p.name}<br/><b>$ ${usdM(p.value)} M</b> (${p.percent}%)` },
      series: [{
        type: 'pie', radius: ['40%', '70%'], center: ['50%', '50%'],
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { show: false }, labelLine: { show: false },
        data: cats.map((c) => ({ name: c.category, value: Math.round(c.usdEquiv), itemStyle: { color: catColor(c.category) } })),
      }],
    });
    const evTotal = cats.reduce((s, c) => s + c.usdEquiv, 0) || 1;
    evChart.off('click');
    evChart.on('click', (p) => {
      const c = cats[p.dataIndex];
      document.getElementById('f-evdetail').innerHTML =
        `<b style="color:${catColor(c.category)}">${c.category}</b> — $ ${usdM(c.usdEquiv)} M earned ` +
        `· <b>${Math.round((c.usdEquiv / evTotal) * 1000) / 10}%</b> of total ` +
        `<span class="muted">($ ${usdM(c.usd)} M + NPR ${nprM(c.npr)} M)</span>`;
    });

    // donut: certified vs outstanding work value (USD-equivalent)
    const donut = makeChart('f-donut');
    donut.setOption({
      tooltip: { trigger: 'item',
        formatter: (p) => `${p.name}<br/><b>$ ${usdM(p.value)} M</b> (${p.percent}%)` },
      legend: { bottom: 0, textStyle: { fontSize: 11, color: COL.muted } },
      series: [{
        type: 'pie', radius: ['48%', '72%'], center: ['50%', '45%'], avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { show: true, formatter: '{d}%', fontSize: 11, fontWeight: 700, color: COL.muted },
        data: [
          { name: 'Certified', value: Math.round(fb.certifiedEq), itemStyle: { color: '#2fae7a' } },
          { name: 'Outstanding', value: Math.round(fb.outstandingEq), itemStyle: { color: '#f2a65a' } },
        ],
      }],
    });
    // Click "Certified" -> show the earned-value breakdown by work category.
    donut.off('click');
    donut.on('click', (p) => {
      const el = document.getElementById('f-donut-detail');
      if (p.name === 'Certified') {
        const body = cats.map((c) =>
          `<tr><td>${c.category}</td><td>$ ${usdM(c.usdEquiv)} M</td>
            <td>${Math.round((c.usdEquiv / evTotal) * 1000) / 10}%</td></tr>`).join('');
        el.innerHTML = `<div class="ipc-sub" style="text-align:left">Earned value — work done by category</div>
          <table class="tbl"><thead><tr><th>Category</th><th>Earned (USD-eq)</th><th>Weightage</th></tr></thead>
          <tbody>${body}</tbody></table>`;
      } else {
        el.innerHTML = `<span>Outstanding work value: <b>$ ${usdM(fb.outstandingEq)} M</b> ` +
          `(${Math.round((fb.outstandingEq / b.workUSDEq) * 1000) / 10}% of contract still to certify)</span>`;
      }
    });

    // bar: cash received per IPC (NPR, millions)
    const ipcs = fd.ipcs || [];
    makeChart('f-bar').setOption({
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
    const done = (s) => /complete/i.test(s);
    // Reverse chronological — newest IPC first (Advance Payment, the oldest, last).
    const ipcsDesc = ipcs.slice().sort((a, b) => (b.certifiedDate || '').localeCompare(a.certifiedDate || ''));
    document.getElementById('f-ipclist').innerHTML = ipcsDesc.map((i, idx) => `
      <div class="ipc" data-i="${idx}">
        <div class="ipc-head">
          <span class="ipc-name">${i.ipc}</span>
          <span class="ipc-date">${i.certifiedDate || ''}</span>
          <span class="ipc-amt">Net <b>$${usdM(i.netUSD)}M</b> / <b>NPR ${nprM(i.netNPR)}M</b></span>
          <span class="ipc-amt">Recv <b>NPR ${nprM(i.receivedNPR)}M</b></span>
          <span class="badge ${done(i.status) ? 'ok' : 'warn'}">${i.status}</span>
          <span class="ipc-caret">▸</span>
        </div>
        <div class="ipc-body">
          ${i.items.length ? '<div class="ipc-sub">Work Items (' + i.items.length + ')</div>' + itemsTable(i.items) : ''}
        </div>
      </div>`).join('');
    document.querySelectorAll('#f-ipclist .ipc-head').forEach((h) =>
      h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
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
    reader.onload = () => {
      try {
        const parsed = parseXerClient(reader.result);
        if (!parsed.activities.length) { alert('No activities (TASK table) found in this XER file.'); return; }
        data = data || {};
        data.schedule = parsed;
        schedBuiltFor = null;
        renderSchedule();
        const src = $('#sch-src');
        if (src) src.textContent = '· uploaded: ' + file.name;
      } catch (err) { alert('Could not read this XER file: ' + err.message); }
    };
    reader.readAsText(file);
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
    const sch = data.schedule || {};
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
    meeting: 'No. 28', dataDate: '26 Jun 2026',
    overall: { plan: 71.14, actual: 20.71, varc: -50.43, wk: 0.26 },
    tunnels: [
      { name: 'HRT F-1', pct: 33.48, week: 20.76, plan: 30 },
      { name: 'HRT F-2', pct: 4.79, week: 14.76, plan: 25 },
      { name: 'HRT F-3', pct: 2.79, week: 0.00, plan: 25 },
      { name: 'Adit #3', pct: 93.27, week: 30.35, plan: 21.84 },
      { name: 'Adit #4', pct: 90.92, week: 15.45, plan: 17.50 },
      { name: 'Access to Valve Chamber', pct: 41.06, week: 11.62, plan: 15 },
    ],
    hse: { safeHrs: 2222781, safeHrsWk: 35805, recordable: 15, recordableWk: 1, lti: 1, nearMiss: 1, firstAid: 92, ch: 42, on: 85, ln: 341 },
    explosives: [
      { name: 'Explosives #32mm (kg)', week: 5316.1, stock: 111463.3 },
      { name: 'Detonating Cord (m)', week: 1177, stock: 81401 },
      { name: 'Electric Detonator (pcs)', week: 62, stock: 3717 },
      { name: 'Non-Electric Detonator (pcs)', week: 6118, stock: 318560 },
    ],
    qc: { ncrTotal: 27, ncrOpen: 9, ncrClosed: 16, ncrWk: 1, rfiTotal: 1709, rfiApproved: 1485, rfiRejected: 224, rfiWk: 36 },
  };
  function renderWeekly() {
    const el = document.getElementById('weekly');
    if (!el) return;
    const w = WEEKLY;
    const n = (v) => Number(v).toLocaleString('en-US');
    const sub = (t) => `<div class="ipc-sub" style="margin:0 0 6px">${t}</div>`;
    const tun = w.tunnels.map((t) => `<tr><td style="text-align:left">${t.name}</td><td>${t.pct}%</td><td>${t.week.toFixed(2)}</td><td class="muted">${t.plan}</td></tr>`).join('');
    const exp = w.explosives.map((e) => `<tr><td style="text-align:left">${e.name}</td><td>${n(e.week)}</td><td>${n(e.stock)}</td></tr>`).join('');
    el.innerHTML = `<div class="card" style="margin-bottom:16px">
      <h3>Weekly Progress <span class="muted" style="font-weight:600">· Meeting ${w.meeting} · data date ${w.dataDate}</span></h3>
      <div style="font-size:12.5px;color:#41506a;margin:2px 0 14px">Overall progress (cost-based): Plan <b>${w.overall.plan}%</b> · Actual <b>${w.overall.actual}%</b> · <b style="color:var(--red)">Variance ${w.overall.varc}%</b> · this week <b>+${w.overall.wk}%</b></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:14px 24px">
        <div>${sub('Tunnel excavation — active faces')}<table class="tbl"><thead><tr><th style="text-align:left">Workface</th><th>Excav&nbsp;%</th><th>This&nbsp;wk&nbsp;(m)</th><th>Plan</th></tr></thead><tbody>${tun}</tbody></table></div>
        <div>${sub('HSE &amp; safety')}<table class="tbl"><tbody>
          <tr><td style="text-align:left">Safe man-hours</td><td>${n(w.hse.safeHrs)}</td><td class="muted">+${n(w.hse.safeHrsWk)}</td></tr>
          <tr><td style="text-align:left">Recordable incidents</td><td>${w.hse.recordable}</td><td class="muted">+${w.hse.recordableWk}</td></tr>
          <tr><td style="text-align:left">LTI · Near&nbsp;miss · First&nbsp;aid</td><td colspan="2">${w.hse.lti} · ${w.hse.nearMiss} · ${w.hse.firstAid}</td></tr>
          <tr><td style="text-align:left">Manpower (CH/ON/LN)</td><td colspan="2">${w.hse.ch} / ${w.hse.on} / ${w.hse.ln} = <b>${w.hse.ch + w.hse.on + w.hse.ln}</b></td></tr>
        </tbody></table></div>
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
  function renderClaims() {
    const el = document.getElementById('claims-body');
    if (!el) return;
    const c = CLAIMS;
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
        <div class="card kpi"><h3>Statements of Claim</h3><div class="val">${c.socCount}</div><div class="sub">SoC #1–#8 submitted</div></div>
        <div class="card kpi"><h3>Approved &amp; Received</h3><div class="valm">NPR ${c.approvedNPR.toFixed(2)} M</div><div class="sub">Provisional Sum — landslide cost</div></div>
        <div class="card kpi"><h3>EoT Sought</h3><div class="val">${c.eotDays} <span style="font-size:15px">days</span></div><div class="sub">baseline (TIA) pending</div></div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <h3>Statements of Claim <span class="muted" style="font-weight:600">· amount claimed &amp; engineer's position</span></h3>
        <table class="tbl"><thead><tr><th>Claim</th><th style="text-align:left">Description</th><th style="text-align:left">Contractual basis</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>${claimRows}</tbody></table>
        <div class="muted" style="font-size:11.5px;margin-top:8px">Total contractor's claim <b>$ ${c.totalUSD.toFixed(2)}M + NPR ${c.totalNPR.toFixed(1)}M</b> — of which NPR ${c.variations[0].npr.toFixed(1)}M is the Additional Surge Tunnel variation. Most claims remain pending or rejected by the Engineer.</div>
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
      const res = await fetch('/api/data');
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
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.view').forEach((s) => s.classList.remove('active'));
    document.getElementById(item.dataset.v).classList.add('active');
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

  renderTunnel3D(); // embedded data — independent of the API fetch

  const xerInput = document.getElementById('sch-upload');
  if (xerInput) xerInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleXerUpload(f);
    e.target.value = ''; // allow re-uploading the same file
  });

  load();
})();
