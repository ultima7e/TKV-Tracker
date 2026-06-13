// Stream-parse a DXF and extract POLYLINE polyface meshes grouped by layer.
// AutoCAD polyface mesh in DXF = a POLYLINE entity with flag 70 bit 64 set,
// followed by VERTEX entities of two kinds:
//   - coordinate vertices: flags (70) bit 64+128, with 10/20/30 = X/Y/Z
//   - face vertices:        flags (70) bit 128, with 71..74 = 1-based vertex
//     indices into this mesh's coordinate list (negative = hidden edge).
// Ends at SEQEND. We collect per-layer {vertices:[[x,y,z]], faces:[[i,j,k]]}.
//
// Usage: node scripts/dxf-tunnels.js <input.dxf> <output.json>
const fs = require('fs');
const readline = require('readline');

async function parse(dxfPath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(dxfPath, { encoding: 'latin1' }),
    crlfDelay: Infinity,
  });

  const layers = {}; // name -> { vertices:[], faces:[] }
  let pending = null; // current group code awaiting its value (DXF is code\nvalue pairs)

  // state machine over entities
  let inEntities = false;
  let cur = null; // 'POLYLINE' | 'VERTEX' | other
  let mesh = null; // active polyface mesh accumulator
  let vtx = null; // active vertex being read
  let ent = {}; // group codes for the current entity

  const startMeshIfPolyface = () => {
    const flag = ent[70] | 0;
    const layer = ent[8] || '0';
    if (flag & 64) {
      mesh = { layer, baseIndex: 0, vertices: [], faces: [] };
    } else {
      mesh = null; // a non-mesh polyline; ignore
    }
  };

  const finishVertex = () => {
    if (!vtx || !mesh) { vtx = null; return; }
    const flag = vtx[70] | 0;
    if (flag & 128 && (vtx[71] != null || vtx[72] != null)) {
      // face-definition vertex: indices in 71..74 (1-based, may be negative)
      const idx = [vtx[71], vtx[72], vtx[73], vtx[74]]
        .map((v) => Math.abs(v | 0)).filter((v) => v > 0);
      if (idx.length >= 3) {
        // triangulate quad fan
        for (let k = 1; k < idx.length - 1; k++) {
          mesh.faces.push([idx[0] - 1, idx[k] - 1, idx[k + 1] - 1]);
        }
      }
    } else if (vtx[10] != null) {
      // coordinate vertex
      mesh.vertices.push([+vtx[10] || 0, +vtx[20] || 0, +vtx[30] || 0]);
    }
    vtx = null;
  };

  const finishMesh = () => {
    if (mesh && mesh.vertices.length && mesh.faces.length) {
      const L = (layers[mesh.layer] = layers[mesh.layer] || { vertices: [], faces: [] });
      const off = L.vertices.length;
      for (const v of mesh.vertices) L.vertices.push(v);
      for (const f of mesh.faces) L.faces.push([f[0] + off, f[1] + off, f[2] + off]);
    }
    mesh = null;
  };

  for await (const raw of rl) {
    const line = raw.trim();
    if (pending === null) { pending = line; continue; }
    const code = parseInt(pending, 10);
    const value = line;
    pending = null;

    if (code === 0) {
      // entity boundary — close out previous
      if (cur === 'VERTEX') finishVertex();
      if (value === 'SEQEND') { /* mesh closed by finishMesh on next 0 */ }
      if (cur === 'POLYLINE' || (cur === 'SEQEND' && mesh)) { /* handled below */ }

      if (value === 'SECTION') { /* wait for code 2 */ }
      if (value === 'ENDSEC') { inEntities = false; finishMesh(); }

      // transitions
      if (value === 'POLYLINE') { finishMesh(); cur = 'POLYLINE'; ent = {}; mesh = null; }
      else if (value === 'VERTEX') { cur = 'VERTEX'; vtx = {}; }
      else if (value === 'SEQEND') { cur = 'SEQEND'; finishMesh(); }
      else { if (cur === 'POLYLINE') { /* polyline had no verts */ } cur = value; ent = {}; }
      continue;
    }

    if (code === 2 && value === 'ENTITIES') inEntities = true;
    if (!inEntities) continue;

    if (cur === 'POLYLINE') {
      ent[code] = value;
      if (code === 70 || code === 8) {
        // once we have flag+layer we can decide; recompute lazily
        if (ent[70] != null) startMeshIfPolyface();
      }
    } else if (cur === 'VERTEX') {
      vtx[code] = isNaN(+value) ? value : +value;
    }
  }
  if (cur === 'VERTEX') finishVertex();
  finishMesh();
  return layers;
}

module.exports = { parse };

if (require.main === module) {
  (async () => {
    const [, , inPath, outPath] = process.argv;
    if (!inPath) { console.error('usage: node dxf-tunnels.js <in.dxf> [out.json]'); process.exit(1); }
    const layers = await parse(inPath);
    const summary = Object.entries(layers)
      .map(([name, g]) => ({ layer: name, verts: g.vertices.length, faces: g.faces.length }))
      .filter((s) => s.faces > 0)
      .sort((a, b) => b.faces - a.faces);
    console.log('Layers with mesh geometry:', summary.length);
    for (const s of summary) console.log(`  ${s.layer.padEnd(20)} verts=${s.verts} faces=${s.faces}`);
    if (outPath) { fs.writeFileSync(outPath, JSON.stringify(layers)); console.log('Wrote', outPath); }
  })();
}
