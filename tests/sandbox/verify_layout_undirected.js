// One-off: prove the Celestial layout bug + the undirected-adjacency fix against real 3k_map.db.
// Replicates _renderAreaMap's component + BFS-placement reachability (compass exits only).
// DIRECTED = old behaviour (layout walks exits in stored direction). UNDIRECTED = the fix.
// Usage on sandbox:  NODE_PATH=/opt/wmt/node_modules node - < verify_layout_undirected.js
const Database = require('better-sqlite3');
const db = new Database('/opt/wmt/3k_map.db', { readonly: true });
const DIRS = ['n','s','e','w','ne','nw','se','sw'];
const OPP = { n:'s', s:'n', e:'w', w:'e', ne:'sw', sw:'ne', nw:'se', se:'nw' };
const AREA = 'Celestial Zodiacs';
const ATRIUM = 53587, THRESHOLD = 53582;

const rooms = db.prepare('SELECT vnum,name FROM rooms WHERE area=?').all(AREA);
const inArea = new Set(rooms.map(r => r.vnum));
const exits = db.prepare('SELECT from_vnum,to_vnum,direction FROM exits WHERE from_vnum IN (SELECT vnum FROM rooms WHERE area=?)').all(AREA);

function buildAdj(undirected) {
  const adj = new Map(); rooms.forEach(r => adj.set(r.vnum, []));
  for (const e of exits) {
    if (!inArea.has(e.to_vnum) || !adj.has(e.from_vnum)) continue;
    const d = (e.direction || '').toLowerCase();
    if (!DIRS.includes(d)) continue;          // compass-only, like the layout
    adj.get(e.from_vnum).push({ to: e.to_vnum, dir: d });
    if (undirected && adj.has(e.to_vnum)) adj.get(e.to_vnum).push({ to: e.from_vnum, dir: OPP[d] });
  }
  return adj;
}
// component reachable (this is what compOf does) AND what the layout BFS positions — same graph.
function reach(adj, start) {
  const seen = new Set([start]), q = [start];
  while (q.length) { const v = q.shift(); for (const ex of (adj.get(v) || [])) if (!seen.has(ex.to)) { seen.add(ex.to); q.push(ex.to); } }
  return seen;
}
function report(label, undirected) {
  const adj = buildAdj(undirected);
  const comp = reach(adj, ATRIUM);                       // compOf(Atrium)
  const anchor = Math.min(...comp);                      // layout anchor = lowest vnum in comp
  const positioned = reach(adj, anchor);                 // layout BFS walks from the anchor
  const atriumPlaced = positioned.has(ATRIUM);
  console.log(`\n[${label}]`);
  console.log(`  compOf(Atrium ${ATRIUM}) = ${comp.size} rooms (footer would say this)`);
  console.log(`  layout anchor (lowest vnum) = ${anchor} (${(rooms.find(r=>r.vnum===anchor)||{}).name})`);
  console.log(`  rooms the layout actually POSITIONS from anchor = ${positioned.size}`);
  console.log(`  Atrium ${ATRIUM} positioned? ${atriumPlaced ? 'YES ✅' : 'NO ❌  -> view falls back to anchor (Threshold) = THE BUG'}`);
  return atriumPlaced && positioned.size === comp.size;
}
const okDir = report('DIRECTED (old)', false);
const okUndir = report('UNDIRECTED (fix)', true);
console.log(`\nThreshold=${THRESHOLD}, Atrium=${ATRIUM}`);
console.log(`\nResult: old-broken=${!okDir}  fix-correct=${okUndir}  => ${(!okDir && okUndir) ? 'PROVEN: undirected fixes it' : 'unexpected'}`);
db.close();
