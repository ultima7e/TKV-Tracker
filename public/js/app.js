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

  // "Jun-24" -> Date(2024-06-01)
  function parseMonthLabel(s) {
    const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const m = /^([A-Za-z]{3})-(\d{2})$/.exec(String(s).trim());
    if (!m) return null;
    return new Date(2000 + +m[2], MON[m[1]], 1);
  }

  function renderTimeMeter() {
    const months = (data.scurve && data.scurve.months) || [];
    if (months.length < 2) return;
    const start = parseMonthLabel(months[0]);
    const end = parseMonthLabel(months[months.length - 1]);
    if (!start || !end) return;
    const now = new Date();
    const pct = Math.max(0, Math.min(100, Math.round(((now - start) / (end - start)) * 1000) / 10));
    const monthsTotal = Math.round((end - start) / (30.44 * 86400000));
    const monthsDone = Math.max(0, Math.min(monthsTotal, Math.round((now - start) / (30.44 * 86400000))));
    setKpi('v-timepct', pct, 1);
    const fmt = (d) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
    $('#v-timesub').textContent = `${monthsDone} / ${monthsTotal} months · ${fmt(start)} → ${fmt(end)}`;
    requestAnimationFrame(() => { $('#v-timebar').style.width = pct + '%'; });
  }

  function renderKpis() {
    const f = data.finance || {};
    setKpi('v-budget-usd', f.budgetUSD != null ? f.budgetUSD / 1e6 : null, 2);
    setKpi('v-budget-npr', f.budgetNPR != null ? f.budgetNPR / 1e9 : null, 2);
    // Received EXCLUDING the mobilisation advance (IPC receipts only).
    setKpi('v-received-usd', f.receivedExclAdvUSD != null ? f.receivedExclAdvUSD / 1e6 : null, 2);
    setKpi('v-received-npr', f.receivedExclAdvNPR != null ? f.receivedExclAdvNPR / 1e9 : null, 2);
    setKpi('v-finprog', f.financialProgressPct, 1);
    renderTimeMeter();
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

  function renderIpc() {
    const ipc = data.ipc || {};
    // Default: reverse-chronological (latest certified first).
    const rows = (ipc.rows || []).slice()
      .sort((a, b) => (b.certifiedDate || '').localeCompare(a.certifiedDate || ''));
    $('#ipc-count').textContent = ipc.total ? ipc.total.count : '—';
    if (!rows.length) return;
    const fmtDate = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso + 'T00:00:00Z');
      const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
      return d.getUTCDate() + ' ' + m + ' ' + d.getUTCFullYear();
    };
    const usdM = (v) => (v ? (v / 1e6).toFixed(2) : '–');
    const nprM = (v) => (v ? (v / 1e6).toFixed(1) : '–');
    const done = (s) => /complete/i.test(s);
    const ipcRow = (r) => `
      <tr class="${done(r.status) ? 'ok' : 'warn'}">
        <td>${r.ipc}</td><td>${fmtDate(r.certifiedDate)}</td>
        <td>${usdM(r.netUSD)}</td><td>${nprM(r.netNPR)}</td>
        <td>${r.status}</td>
      </tr>`;
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
    setKpi('f-cnpr', b.workNPR / 1e9, 2);
    setKpi('f-rusd', rc.usd / 1e6, 2);
    setKpi('f-rnpr', rc.npr / 1e9, 2);
    setKpi('f-out', b.outUSDEq / 1e6, 2);
    setKpi('f-prog', b.workUSDEq ? Math.round((b.completeUSDEq / b.workUSDEq) * 1000) / 10 : null, 1);

    // Advance Payment amortisation summary
    const adv = fd.advance;
    if (adv) {
      const stat = (cls, lab, usd, npr) =>
        `<div class="a-stat ${cls}"><div class="lab">${lab}</div>
          <div class="num">$ ${usdM(usd)} M <small>/ NPR ${nprM(npr)} M</small></div></div>`;
      document.getElementById('f-advance').innerHTML = `
        <div class="amort">
          ${stat('', 'Disbursed', adv.disbursedUSD, adv.disbursedNPR)}
          ${stat('recovered', 'Recovered', adv.recoveredUSD, adv.recoveredNPR)}
          ${stat('out', 'Outstanding', adv.outstandingUSD, adv.outstandingNPR)}
          <div class="a-stat"><div class="lab">Amortised</div><div class="num">${adv.amortisedPct}%</div></div>
          <div class="a-bar"><i data-w="${adv.amortisedPct}"></i></div>
        </div>
        <p class="muted" style="margin-top:10px">Recovery is deducted as 15% of each IPC${adv.recoveredNPR === 0 ? ' — not started yet' : ''}.</p>`;
      requestAnimationFrame(() => {
        const bar = document.querySelector('#f-advance .a-bar > i');
        if (bar) bar.style.width = adv.amortisedPct + '%';
      });
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
          { name: 'Certified', value: Math.round(b.completeUSDEq), itemStyle: { color: '#2fae7a' } },
          { name: 'Outstanding', value: Math.round(b.outUSDEq), itemStyle: { color: '#f2a65a' } },
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
        el.innerHTML = `<span>Outstanding work value: <b>$ ${usdM(b.outUSDEq)} M</b> ` +
          `(${Math.round((b.outUSDEq / b.workUSDEq) * 1000) / 10}% of contract still to certify)</span>`;
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
    const chip = (it) => {
      const L = /^[A-F]/.test(it.code) ? it.code[0].toUpperCase() : '';
      return `<span class="chip ${L}">${it.category}</span>`;
    };
    const itemsTable = (items) => `
      <table class="tbl">
        <thead><tr><th>Item</th><th>Category</th><th>Payment&nbsp;%</th><th>Net (USD)</th><th>Net (NPR)</th></tr></thead>
        <tbody>${items.map((it) => `
          <tr><td>${it.code}</td><td style="text-align:left">${chip(it)}</td>
            <td>${it.paymentPct != null ? it.paymentPct + '%' : '–'}</td>
            <td>${it.netUSD ? '$ ' + usdM(it.netUSD) + ' M' : '–'}</td>
            <td>${it.netNPR ? nprM(it.netNPR) + ' M' : '–'}</td></tr>`).join('')}
        </tbody>
      </table>`;
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
    document.getElementById('f-ipclist').innerHTML = ipcs.map((i, idx) => `
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
          ${i.installments.length ? '<div class="ipc-sub">Payment Tranches</div>' + instalTable(i.installments) : ''}
        </div>
      </div>`).join('');
    document.querySelectorAll('#f-ipclist .ipc-head').forEach((h) =>
      h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
  }

  let schedBuiltFor = null;
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

    // WBS tree: children (sorted by seq), activities per node, subtree span
    const kids = {};
    Object.keys(wbs).forEach((id) => { const p = wbs[id].parentId; (kids[p] = kids[p] || []).push(id); });
    Object.values(kids).forEach((a) => a.sort((x, y) => (wbs[x].seq || 0) - (wbs[y].seq || 0)));
    const actsByWbs = {};
    acts.forEach((a) => { (actsByWbs[a.wbsId] = actsByWbs[a.wbsId] || []).push(a); });
    Object.values(actsByWbs).forEach((arr) => arr.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (a.id < b.id ? -1 : 1))));
    const roots = Object.keys(wbs).filter((id) => !wbs[wbs[id].parentId]);
    const hasA = {};
    const subHas = (id) => {
      if (id in hasA) return hasA[id];
      let h = (actsByWbs[id] || []).length > 0;
      (kids[id] || []).forEach((c) => { if (subHas(c)) h = true; });
      return (hasA[id] = h);
    };
    roots.forEach(subHas);
    const span = {};
    const calcSpan = (id) => {
      let s = null, f = null;
      (actsByWbs[id] || []).forEach((a) => { if (!s || a.start < s) s = a.start; if (!f || a.finish > f) f = a.finish; });
      (kids[id] || []).forEach((c) => { const cs = calcSpan(c); if (cs.s && (!s || cs.s < s)) s = cs.s; if (cs.f && (!f || cs.f > f)) f = cs.f; });
      return (span[id] = { s, f });
    };
    roots.forEach(calcSpan);

    const minDay = Math.min(...acts.map((a) => schDay(a.start)));
    const maxDay = Math.max(...acts.map((a) => schDay(a.finish)));
    const PXD = 0.7, ROW = 22, HEAD = 28, PAD = 16;
    const width = (maxDay - minDay) * PXD + PAD * 2;
    const xOf = (d) => PAD + (d - minDay) * PXD;

    let ticks = '';
    let dt = new Date(minDay * 86400000);
    dt = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1));
    const end = new Date(maxDay * 86400000);
    while (dt <= end) {
      const x = xOf(Math.floor(dt.getTime() / 86400000));
      const yr = dt.getUTCMonth() === 0;
      ticks += `<div class="g-tick ${yr ? 'yr' : ''}" style="left:${x}px">${yr ? dt.getUTCFullYear() : MON[dt.getUTCMonth()]}</div>`;
      dt = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1));
    }
    const todayD = Math.floor(Date.now() / 86400000);

    const list = document.getElementById('g-list');
    const time = document.getElementById('g-time');
    const collapsed = new Set();
    let rows = [], selTask = null, relOn = false;

    const buildRows = () => {
      const out = [];
      const walk = (id, depth) => {
        if (!subHas(id)) return;
        out.push({ kind: 'wbs', id, depth });
        if (collapsed.has(id)) return;
        (kids[id] || []).forEach((c) => walk(c, depth + 1));
        (actsByWbs[id] || []).forEach((a) => out.push({ kind: 'act', act: a, depth: depth + 1 }));
      };
      roots.forEach((r) => walk(r, 0));
      return out;
    };

    const HEADER = '<div class="g-head"><span class="g-cid">Act ID</span><span class="g-cnm">Activity Name</span>' +
      '<span class="g-cbs">BL Start</span><span class="g-cbs">BL Finish</span><span class="g-cpc">%</span></div>';

    const paint = () => {
      rows = buildRows();
      list.innerHTML = HEADER + rows.map((r, i) => {
        if (r.kind === 'wbs') {
          return `<div class="g-row g-wbs ${collapsed.has(r.id) ? 'collapsed' : ''}" data-i="${i}" data-wbs="${r.id}">
            <span class="g-cid"></span><span class="g-cnm" style="padding-left:${r.depth * 12}px"><span class="g-caret">▾</span>${wbs[r.id].name || ''}</span>
            <span class="g-cbs"></span><span class="g-cbs"></span><span class="g-cpc"></span></div>`;
        }
        const a = r.act;
        return `<div class="g-row" data-i="${i}" data-tid="${a.taskId}">
          <span class="g-cid">${a.id}</span><span class="g-cnm" style="padding-left:${r.depth * 12}px" title="${a.name || ''}">${a.name || ''}</span>
          <span class="g-cbs">${schFmt(a.baselineStart)}</span><span class="g-cbs">${schFmt(a.baselineFinish)}</span><span class="g-cpc">${a.pct}%</span></div>`;
      }).join('');

      const bars = rows.map((r, i) => {
        const top = HEAD + i * ROW;
        if (r.kind === 'wbs') return ''; // no summary bar in the Gantt
        const a = r.act, x = xOf(schDay(a.start));
        if (a.isMilestone) return `<div class="g-ms ${a.critical ? 'crit' : ''}" data-i="${i}" data-tid="${a.taskId}" style="left:${x - 5}px;top:${top + (ROW - 11) / 2}px"></div>`;
        const w = Math.max(3, (schDay(a.finish) - schDay(a.start)) * PXD);
        const fill = a.pct > 0 && a.pct < 100 ? `<div class="g-fill" style="right:0;width:${100 - a.pct}%"></div>` : '';
        return `<div class="g-bar ${a.pct >= 100 ? 'done' : a.critical ? 'crit' : 'norm'}" data-i="${i}" data-tid="${a.taskId}" style="left:${x}px;width:${w}px;top:${top + (ROW - 11) / 2}px" title="${a.id} · ${a.name || ''}">${fill}</div>`;
      }).join('');
      const todayLine = (todayD >= minDay && todayD <= maxDay)
        ? `<div class="g-today" style="left:${xOf(todayD)}px;top:${HEAD}px;height:${rows.length * ROW}px"></div>` : '';
      const H = HEAD + rows.length * ROW;
      time.innerHTML = `<div class="g-canvas" style="width:${width}px;height:${H}px">
        <div class="g-axis" style="width:${width}px">${ticks}</div>${todayLine}
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
    const renderDetail = (a) => {
      const preds = (predMap[a.taskId] || []).map((r) => ({ act: byTask[r.predTaskId], type: r.type, lag: r.lagDays })).filter((x) => x.act);
      const succs = (succMap[a.taskId] || []).map((r) => ({ act: byTask[r.taskId], type: r.type, lag: r.lagDays })).filter((x) => x.act);
      detail.innerHTML =
        `<div class="g-detail-title">${a.id} — ${a.name || ''} <span>· ${a.status} · ${a.pct}% complete</span></div>
        <div class="g-detail-grid"><div><h4>Predecessors (${preds.length})</h4>${tbl(preds)}</div>
          <div><h4>Successors (${succs.length})</h4>${tbl(succs)}</div></div>`;
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
    document.getElementById('sch-search').oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      if (!q) return;
      const hit = acts.find((a) => (a.id || '').toLowerCase().includes(q) || (a.name || '').toLowerCase().includes(q));
      if (!hit) return;
      // expand ancestors so the row is visible
      let p = hit.wbsId;
      while (p && wbs[p]) { collapsed.delete(p); p = wbs[p].parentId; }
      paint(); select(hit.taskId);
      list.querySelector(`.g-row[data-tid="${hit.taskId}"]`)?.scrollIntoView({ block: 'center' });
    };

    paint();
  }

  function renderAll() {
    renderKpis();
    renderFinancial();
    renderSchedule();
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
