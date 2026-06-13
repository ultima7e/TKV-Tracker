// Interactive 3D tunnel model. Loads the compact geometry binary built from
// the Civil 3D DWG, renders it with three.js, colors each tunnel by progress,
// and lets you orbit / click a tunnel to see its status.
(() => {
  if (!window.THREE) return;

  // Layer code (DWG layer) -> friendly name + progress %. pct null = data
  // pending (rendered grey). 'context' layers are faint, non-clickable backdrop.
  const MAP = {
    'ADIT-1': { name: 'Adit #1', pct: 100 },
    'SPT': { name: 'Spillway Tunnel', pct: 57.65 },
    'HRT-F-7': { name: 'Headrace Tunnel (HRT)', pct: null },
    'MAT': { name: 'Main Access Tunnel', pct: 100 },
    'TRT': { name: 'Tailrace Tunnel', pct: null },
    'ATVC': { name: 'Access to Valve Chamber', pct: 0 },
    'DMF': { name: 'D/S Manifold', pct: null },
    'SGC': { name: 'Surge Chamber', pct: null },
    'EST': { name: 'Escape / Stairs Tunnel', pct: null },
    'PHC': { name: 'Powerhouse Cavern', pct: 60.24 },
    'TRC': { name: 'Transformer / Tailrace Cavern', pct: 100 },
    'AHPT': { name: 'Access to HPT', pct: 100 },
    'LBS': { name: 'Lower Bend Shaft', pct: 20.72 },
    'BDG-1~3': { name: 'Bus Duct Gallery 1~3', pct: 100 },
    'UMF': { name: 'U/S Manifold', pct: 100 },
    'UVC': { name: 'Valve Chamber', pct: null },
    'UBS': { name: 'Upper Bend Shaft', pct: null },
    'ATRC': { name: 'Access to TRC', pct: 100 },
    'VPS': { name: 'Vertical Pressure Shaft', pct: null },
    'CVT': { name: 'Cable Ventilation Tunnel', pct: 100 },
    'ACT': { name: 'Construction Tunnel', pct: 100 },
    'A-GENM': { name: 'General / Context', pct: null, context: true },
  };
  const colHex = (p) =>
    (p == null ? 0x9aa7b8 : p >= 99.5 ? 0x36b37e : p >= 50 ? 0x2f7de1 : p >= 25 ? 0xf5a623 : 0xe5554e);
  const colCss = (p) =>
    (p == null ? '#9aa7b8' : p >= 99.5 ? '#36b37e' : p >= 50 ? '#2f7de1' : p >= 25 ? '#f5a623' : '#e5554e');
  const pctTxt = (p) => (p == null ? '—' : p + '%');
  const BIN_URL = window.T3D_BIN_URL || 'assets/tunnels.bin';

  const host = document.getElementById('t3d-canvas');
  const legend = document.getElementById('t3d-legend');
  const detail = document.getElementById('t3d-detail');
  if (!host) return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  host.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.05));
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(60, 120, 80); scene.add(dir);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render); // on-demand rendering (no idle RAF loop)

  const group = new THREE.Group();
  scene.add(group);
  const pickable = [];
  let selected = null;

  function sizeToHost() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    render();
  }

  function fitCamera() {
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    group.position.sub(center); // recenter model at origin
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360)) * 1.4;
    camera.position.set(dist * 0.7, dist * 0.6, dist * 0.9);
    camera.near = dist / 100; camera.far = dist * 10; camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0); controls.update();
    render();
  }

  function applyColors() {
    pickable.forEach((m) => {
      const isSel = m === selected;
      m.material.emissive.setHex(isSel ? m.userData.color : 0x000000);
      m.material.emissiveIntensity = isSel ? 0.55 : 0;
      m.material.opacity = selected && !isSel ? 0.45 : 1;
      m.material.transparent = m.material.opacity < 1;
    });
  }

  function select(mesh) {
    selected = mesh; applyColors(); render();
    legend.querySelectorAll('li').forEach((li) => li.classList.toggle('active', li.dataset.layer === mesh.userData.layer));
    const u = mesh.userData;
    detail.innerHTML =
      '<div class="dn">' + u.name + ' <span class="muted">(' + u.layer + ')</span></div>' +
      '<div class="dbig" style="color:' + colCss(u.pct) + '">' + pctTxt(u.pct) + '</div>' +
      '<div class="pbar"><div class="track"><i style="width:' + (u.pct || 0) + '%;background:' + colCss(u.pct) + '"></i></div></div>' +
      (u.pct == null ? '<div class="drow"><span>Status</span><span>Progress data pending</span></div>' : '') +
      '<div class="drow"><span>Excavation progress</span><span>' + pctTxt(u.pct) + '</span></div>';
  }

  function buildModel(buf) {
    const dv = new DataView(buf);
    const hLen = dv.getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hLen)));
    const posBase = 4 + hLen;
    const idxBase = posBase + header.posBytes;

    const legendItems = [];
    header.layers.forEach((L) => {
      const info = MAP[L.name] || { name: L.name, pct: null };
      const positions = new Float32Array(buf, posBase + L.pOff, L.pLen / 4);
      const indices = new Uint32Array(buf, idxBase + L.iOff, L.iLen / 4);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setIndex(new THREE.BufferAttribute(indices, 1));
      geo.computeVertexNormals();
      const color = colHex(info.pct);
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.85, metalness: 0.05,
        emissive: 0x000000, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData = { layer: L.name, name: info.name, pct: info.pct, color };
      if (info.context) { mat.color.setHex(0x6b7a8d); mat.opacity = 0.18; mat.transparent = true; }
      else { pickable.push(mesh); legendItems.push({ layer: L.name, info }); }
      group.add(mesh);
    });

    // legend (sorted: in-progress/started first, complete, then pending)
    legendItems.sort((a, b) => (b.info.pct ?? -1) - (a.info.pct ?? -1));
    legend.innerHTML = legendItems.map(({ layer, info }) =>
      '<li data-layer="' + layer + '"><span class="ld" style="background:' + colCss(info.pct) + '"></span>' +
      '<span class="nm">' + info.name + '</span>' +
      '<span class="pc" style="color:' + colCss(info.pct) + '">' + pctTxt(info.pct) + '</span></li>').join('');
    legend.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
      const m = pickable.find((p) => p.userData.layer === li.dataset.layer);
      if (m) select(m);
    }));

    const loading = host.querySelector('.t3d-loading');
    if (loading) loading.remove();
    sizeToHost(); fitCamera();
  }

  // click-to-pick
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let downXY = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downXY = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downXY || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5) return; // ignore drags
    const r = renderer.domElement.getBoundingClientRect();
    mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects(pickable, false);
    if (hits.length) select(hits[0].object);
  });

  function start() {
    sizeToHost();
    fetch(BIN_URL).then((r) => r.arrayBuffer()).then(buildModel).catch((err) => {
      const l = host.querySelector('.t3d-loading');
      if (l) l.textContent = 'Could not load 3D model: ' + err.message;
    });
  }

  // The Tunnel panel is hidden until navigated to; size once it's visible.
  window.addEventListener('resize', sizeToHost);
  document.getElementById('nav').addEventListener('click', () => setTimeout(sizeToHost, 80));
  start();
})();
