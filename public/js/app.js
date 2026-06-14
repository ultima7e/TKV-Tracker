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

  function renderIpc() {
    const ipc = data.ipc || {};
    const rows = ipc.rows || [];
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

    // donut: certified vs outstanding work value (USD-equivalent)
    makeChart('f-donut').setOption({
      tooltip: { trigger: 'item',
        formatter: (p) => `${p.name}<br/><b>$ ${usdM(p.value)} M</b> (${p.percent}%)` },
      legend: { bottom: 0, textStyle: { fontSize: 11, color: COL.muted } },
      series: [{
        type: 'pie', radius: ['48%', '72%'], center: ['50%', '45%'], avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { show: true, formatter: '{d}%', fontSize: 11, fontWeight: 700, color: COL.muted },
        data: [
          { name: 'Certified', value: Math.round(b.completeUSDEq), itemStyle: { color: COL.accent2 } },
          { name: 'Outstanding', value: Math.round(b.outUSDEq), itemStyle: { color: '#dde5ef' } },
        ],
      }],
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
      series: [{ type: 'bar', data: ipcs.map((i) => Math.round(i.receivedNPR / 1e6)), barWidth: '58%',
        itemStyle: { borderRadius: [4, 4, 0, 0],
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1,
            [{ offset: 0, color: COL.accent }, { offset: 1, color: COL.accent2 }]) } }],
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

  function renderAll() {
    renderKpis();
    renderFinancial();
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
  load();
})();
