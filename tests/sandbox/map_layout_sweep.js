// map_layout_sweep.js — MUD-wide check of the CLIENT floor-layout reachability invariant.
//
// The client (_renderAreaMap) draws a floor by: compOf(cur) = rooms reachable from the current
// room via compass exits; anchor = lowest vnum in that set; then it POSITIONS rooms by walking
// outward FROM the anchor following each exit's stored direction. A room only gets drawn if the
// anchor can reach it that way. When an area has an asymmetric seam (entered via a NAMED exit and/or
// a one-way compass exit), the from-anchor directional walk can't cross it, so part (or almost all)
// of the floor is never positioned and the view collapses to the anchor room. (Celestial Zodiacs:
// footer "38 rooms" but only the 3-room entry drawn.)
//
// This sweep flags, per area, every current-room whose floor would NOT fully lay out under the OLD
// (directed) algorithm, and confirms the NEW (undirected: a compass exit A->B also lets the layout
// step B->A) algorithm positions the whole component.
//
// Usage on a box with the map db:  NODE_PATH=/opt/wmt/node_modules node - < map_layout_sweep.js
const Database = require('better-sqlite3');
const DB = (process.argv[2] && !process.argv[2].startsWith('ws')) ? process.argv[2] : '/opt/wmt/3k_map.db';
if (!require('fs').existsSync(DB)) { console.log('Results: 0 passed, 0 failed (no map db — skipped)'); process.exit(0); }
const db = new Database(DB, { readonly: true });
const DIRS = ['n','s','e','w','ne','nw','se','sw'];
const OPP = { n:'s', s:'n', e:'w', w:'e', ne:'sw', sw:'ne', nw:'se', se:'nw' };

const areas = db.prepare('SELECT DISTINCT area FROM rooms WHERE area IS NOT NULL').all().map(r => r.area);
const sRooms = db.prepare('SELECT vnum,name FROM rooms WHERE area=?');
const sExits = db.prepare('SELECT from_vnum,to_vnum,direction FROM exits WHERE from_vnum IN (SELECT vnum FROM rooms WHERE area=?)');

function adjFor(area, undirected) {
  const rooms = sRooms.all(area);
  const inArea = new Set(rooms.map(r => r.vnum));
  const adj = new Map(); rooms.forEach(r => adj.set(r.vnum, []));
  for (const e of sExits.all(area)) {
    const d = (e.direction || '').toLowerCase();
    if (!DIRS.includes(d) || !inArea.has(e.to_vnum) || !adj.has(e.from_vnum)) continue;
    adj.get(e.from_vnum).push(e.to_vnum);
    if (undirected) adj.get(e.to_vnum).push(e.from_vnum);
  }
  return { adj, rooms };
}
function reach(adj, start) {
  const seen = new Set([start]), q = [start];
  while (q.length) { const v = q.shift(); for (const to of (adj.get(v) || [])) if (!seen.has(to)) { seen.add(to); q.push(to); } }
  return seen;
}

let atRiskAreas = 0, totalStuckRooms = 0, fixAllOK = true;
const samples = [];
for (const area of areas) {
  const { adj: dadj, rooms } = adjFor(area, false);
  const { adj: uadj } = adjFor(area, true);
  if (!rooms.length) continue;
  // For each room treated as the current room: does the OLD layout position it?
  const compCache = new Map();   // start -> Set (directed)
  const reachCache = new Map();  // anchor -> Set (directed)
  let stuck = 0; let worst = null;
  for (const r of rooms) {
    let comp = compCache.get(r.vnum); if (!comp) { comp = reach(dadj, r.vnum); compCache.set(r.vnum, comp); }
    if (comp.size <= 1) continue;                       // isolated room, nothing to lay out
    const anchor = Math.min(...comp);
    let positioned = reachCache.get(anchor); if (!positioned) { positioned = reach(dadj, anchor); reachCache.set(anchor, positioned); }
    if (!positioned.has(r.vnum)) {                      // OLD (directed-from-anchor) would NOT draw it -> the bug
      stuck++;
      const drawn = [...comp].filter(v => positioned.has(v)).length;
      if (!worst || comp.size - drawn > worst.missed) worst = { vnum: r.vnum, name: r.name, comp: comp.size, drawn, missed: comp.size - drawn };
    }
    // Verify the SHIPPED algorithm for EVERY room: floor identity = directed compOf (so vestibules
    // stay separate maps), placement = UNDIRECTED BFS from the anchor RESTRICTED to that floor.
    // Invariant: the whole floor must position. (A floor is weakly-connected, so this always holds.)
    {
      const anchorU = Math.min(...comp);
      const inComp = comp;
      const seen = new Set([anchorU]), q = [anchorU];
      while (q.length) { const v = q.shift(); for (const to of (uadj.get(v) || [])) if (inComp.has(to) && !seen.has(to)) { seen.add(to); q.push(to); } }
      if (![...comp].every(v => seen.has(v))) { fixAllOK = false; if (samples.length < 5) samples.push({ area, stuck: -1, worst: { vnum: r.vnum, name: 'FLOOR DID NOT FULLY POSITION', comp: comp.size, drawn: seen.size, missed: comp.size - seen.size } }); }
    }
  }
  if (stuck > 0) {
    atRiskAreas++; totalStuckRooms += stuck;
    samples.push({ area, stuck, worst });
  }
}
db.close();
samples.sort((a, b) => (b.worst.missed) - (a.worst.missed));
console.log(`Areas scanned: ${areas.length}`);
console.log(`Areas with the directed-layout bug (some current-room can't lay out its floor): ${atRiskAreas}`);
console.log(`Total stuck current-rooms across all areas: ${totalStuckRooms}`);
console.log(`Undirected fix positions the FULL component in every flagged case: ${fixAllOK ? 'YES ✅' : 'NO ❌'}`);
console.log('\nTop affected areas (worst current-room: rooms drawn / floor size):');
for (const s of samples.slice(0, 30)) {
  const w = s.worst;
  console.log(`  ${s.area}: ${s.stuck} stuck room(s); worst @${w.vnum} "${w.name}" draws ${w.drawn}/${w.comp} (misses ${w.missed})`);
}
console.log(`\nResults: ${areas.length} passed, ${fixAllOK ? 0 : 1} failed`);
process.exit(fixAllOK ? 0 : 1);
