(() => {
  const charts = {};
  let data = null;

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const COL = { accent: '#2f7de1', accent2: '#36c5a8', muted: '#7b8aa0', grid: '#eef2f7' };

  function countUp(el, to, dec) {
    let start = null;
    const dur = 1100;
    function step(t) {
      if (!start) start = t;
      const p = Math.min((t - start) / dur, 1);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = (to * e).toFixed(dec);
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

  function renderKpis() {
    const f = data.finance || {};
    setKpi('v-budget-usd', f.budgetUSD != null ? f.budgetUSD / 1e6 : null, 2);
    setKpi('v-budget-npr', f.budgetNPR != null ? f.budgetNPR / 1e9 : null, 2);
    setKpi('v-received-usd', f.receivedUSD != null ? f.receivedUSD / 1e6 : null, 2);
    setKpi('v-received-npr', f.receivedNPR != null ? f.receivedNPR / 1e9 : null, 2);
    setKpi('v-finprog', f.financialProgressPct, 1);
    // Earned Value card stays '—' until the EV data sheet is provided.
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
    makeChart(id).setOption({
      grid: { left: 40, right: 16, top: 30, bottom: 26 },
      legend: { right: 0, top: 0, textStyle: { fontSize: 11, color: COL.muted } },
      tooltip: { trigger: 'axis', valueFormatter: (v) => (v == null ? '—' : v + '%') },
      xAxis: { type: 'category', data: sc.months,
        axisLabel: { fontSize: 10, color: COL.muted },
        axisLine: { lineStyle: { color: '#cfd8e6' } } },
      yAxis: { type: 'value', max: 100,
        axisLabel: { fontSize: 10, color: COL.muted, formatter: '{value}%' },
        splitLine: { lineStyle: { color: COL.grid } } },
      series: [
        { name: 'Planned', type: 'line', smooth: true, symbol: 'none',
          data: sc.plannedPct,
          lineStyle: { width: 3, color: COL.accent },
          areaStyle: { color: 'rgba(47,125,225,.08)' } },
        { name: 'Actual', type: 'line', smooth: true, symbol: 'circle', symbolSize: 4,
          data: sc.actualPct, connectNulls: false,
          lineStyle: { width: 3, color: COL.accent2 },
          itemStyle: { color: COL.accent2 } },
      ],
    });
  }

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
    const rowHtml = (r, cls) => `
      <tr${cls ? ' class="' + cls + '"' : ''}>
        <td>${r.category || 'Total'}</td>
        <td>${cell(r.foreigner)}</td><td>${cell(r.otherNepali)}</td>
        <td>${cell(r.localNepali)}</td><td>${r.total}</td>
      </tr>`;
    const table = (rows, total, rowCls) => `
      <table class="tbl">
        <thead><tr><th>Manpower Category</th><th>Foreigner</th>
          <th>Other Nepali</th><th>Local Nepali</th><th>Total</th></tr></thead>
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
          <thead><tr><th></th><th>Foreigner</th><th>Other Nepali</th>
            <th>Local Nepali</th><th>Total</th></tr></thead>
          <tbody>
            ${status('Mobilized', mp.mobilizedTotal, 'ok')}
            ${mp.idleTotal ? status('Idle', mp.idleTotal, 'warn') : ''}
          </tbody>
        </table>`;
    }
  }

  function renderAll() {
    renderKpis();
    renderSCurve('ch-scurve');
    renderAdvanceChart('ch-tunnel-advance');
    renderTunnelBars();
    renderManpower();
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
  window.addEventListener('resize', () => Object.values(charts).forEach((c) => c.resize()));
  $('#today').textContent = new Date().toLocaleDateString('en-GB',
    { day: '2-digit', month: 'short', year: 'numeric' });

  load();
})();
