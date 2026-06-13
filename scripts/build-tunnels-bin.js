// Build a compact binary of tunnel geometry for the web 3D viewer.
// Centers coordinates on the model centroid (so float32 keeps full precision)
// and writes per-layer positions (float32) + indices (uint32) concatenated,
// with a small JSON header describing byte offsets.
//
// Layout:  [4 bytes headerLen LE][header JSON][positions blob][indices blob]
// header = { origin:[x,y,z], scale, layers:[{name, pOff,pLen, iOff,iLen, vCount}] }
//
// Usage: node scripts/build-tunnels-bin.js <in.dxf> <out.bin>
const fs = require('fs');
const { parse } = require('./dxf-tunnels');

(async () => {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) { console.error('usage: build-tunnels-bin.js <in.dxf> <out.bin>'); process.exit(1); }

  const layers = await parse(inPath);
  const names = Object.keys(layers).filter((n) => layers[n].faces.length > 0);

  // global centroid via bounding-box center
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const n of names) for (const v of layers[n].vertices)
    for (let k = 0; k < 3; k++) { if (v[k] < mn[k]) mn[k] = v[k]; if (v[k] > mx[k]) mx[k] = v[k]; }
  const origin = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const span = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  const scale = 100 / span; // normalize largest dimension to ~100 units

  const posParts = [], idxParts = [];
  let pOff = 0, iOff = 0;
  const meta = [];
  for (const n of names) {
    const g = layers[n];
    const pos = new Float32Array(g.vertices.length * 3);
    for (let i = 0; i < g.vertices.length; i++) {
      const v = g.vertices[i];
      pos[i * 3] = (v[0] - origin[0]) * scale;
      pos[i * 3 + 1] = (v[2] - origin[2]) * scale; // Z up -> Y up for three.js
      pos[i * 3 + 2] = -(v[1] - origin[1]) * scale;
    }
    const idx = new Uint32Array(g.faces.length * 3);
    for (let i = 0; i < g.faces.length; i++) {
      idx[i * 3] = g.faces[i][0]; idx[i * 3 + 1] = g.faces[i][1]; idx[i * 3 + 2] = g.faces[i][2];
    }
    const pBuf = Buffer.from(pos.buffer), iBuf = Buffer.from(idx.buffer);
    meta.push({ name: n, pOff, pLen: pBuf.length, iOff, iLen: iBuf.length, vCount: g.vertices.length });
    posParts.push(pBuf); idxParts.push(iBuf);
    pOff += pBuf.length; iOff += iBuf.length;
  }
  const positions = Buffer.concat(posParts);
  const indices = Buffer.concat(idxParts);
  // shift index offsets to be absolute within the indices blob region
  const header = { origin, scale, posBytes: positions.length, idxBytes: indices.length, layers: meta };
  const hJson = Buffer.from(JSON.stringify(header), 'utf8');
  const hLen = Buffer.alloc(4); hLen.writeUInt32LE(hJson.length, 0);

  fs.writeFileSync(outPath, Buffer.concat([hLen, hJson, positions, indices]));
  const mb = (n) => (n / 1048576).toFixed(1);
  console.log(`Wrote ${outPath}: ${mb(hLen.length + hJson.length + positions.length + indices.length)} MB`);
  console.log(`  layers=${meta.length} positions=${mb(positions.length)}MB indices=${mb(indices.length)}MB`);
})();
