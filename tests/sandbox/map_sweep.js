// map_sweep.js — broad correctness sweep of the reckon brain across EVERY area in 3k_map.db.
// For each area: (A) a cold-start walk (no anchor) and (B) a fast BURST from a known anchor (the
// goaegis case). The hard invariant everywhere: the reckoner is NEVER confidently in the wrong room.
// Reports drift incidents (must be 0), cold-start convergence, and burst-exact tracking rates.
// Run on a box with the map db:  NODE_PATH=/opt/wmt/node_modules node map_sweep.js [/path/3k_map.db]
const { normDir, sigOf, reckonNext } = require(process.env.MAPLIB || '/opt/wmt/maplib.js');
const Database = require('better-sqlite3');
const DB = (process.argv[2] && !process.argv[2].startsWith('ws')) ? process.argv[2] : '/opt/wmt/3k_map.db';
if (!require('fs').existsSync(DB)) { console.log('Results: 0 passed, 0 failed (no map db — skipped)'); process.exit(0); }
const db = new Database(DB, { readonly: true });
const sRoom = db.prepare('SELECT vnum,name,area FROM rooms WHERE vnum=?');
const sExits = db.prepare('SELECT direction,to_vnum,command FROM exits WHERE from_vnum=?');
const sByName = db.prepare('SELECT vnum,name,area FROM rooms WHERE name=?');
const map = { getRoom: v => sRoom.get(v), getExits: v => sExits.all(v), getRoomsByName: n => sByName.all(n) };
const sigv = v => sigOf(map.getExits(v).map(e => e.direction));
const CARD = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const BACK = { n: 's', s: 'n', e: 'w', w: 'e', ne: 'sw', sw: 'ne', nw: 'se', se: 'nw' };

function makeSim(startV) {
  let truth = startV, clock = 1000, st = { reckonVnum: null, candidates: null, moveQueue: [] };
  const obs = () => ({ name: map.getRoom(truth).name, mipSig: sigv(truth), roomVnum: null, now: clock });
  const cap = d => { clock += 5; st.moveQueue.push({ token: normDir(d) || String(d).toLowerCase(), at: clock }); };
  return {
    truth: () => truth,
    placed: () => (st.candidates && st.candidates.length > 1) ? null : st.reckonVnum,
    move(dir) { const d = normDir(dir); cap(dir); const ex = map.getExits(truth).find(e => normDir(e.direction) === d); if (ex && map.getRoom(ex.to_vnum)) { truth = ex.to_vnum; clock += 5; st = reckonNext(map, st, obs()); return true; } return false; },
    burst(dirs) { const seq = []; for (const dir of dirs) { const d = normDir(dir); cap(dir); const ex = map.getExits(truth).find(e => normDir(e.direction) === d); if (ex && map.getRoom(ex.to_vnum)) { truth = ex.to_vnum; seq.push({ name: map.getRoom(truth).name, mipSig: sigv(truth), roomVnum: null }); } } for (const o of seq) { clock += 5; st = reckonNext(map, st, { ...o, now: clock }); } },
    look() { clock += 100; st = reckonNext(map, st, obs()); },
    clickPlace(v) { st = { reckonVnum: v, candidates: null, moveQueue: [] }; },
    dump: () => ({ rv: st.reckonVnum, q: st.moveQueue.map(m => m.token).join(','), c: st.candidates ? st.candidates.length : 0 }),
  };
}
const pickDir = (v, last) => { const e = map.getExits(v).filter(x => CARD.includes(normDir(x.direction)) && map.getRoom(x.to_vnum)); if (!e.length) return null; return (e.find(x => normDir(x.direction) !== BACK[last]) || e[0]).direction; };
const buildPath = (start, n) => { let cur = start, last = null; const dirs = []; for (let i = 0; i < n; i++) { const d = pickDir(cur, last); if (!d) break; const ex = map.getExits(cur).find(x => normDir(x.direction) === normDir(d)); cur = ex.to_vnum; last = normDir(d); dirs.push(d); } return dirs; };

// TRACE=<area> → print per-step cold-walk detail for that area, then exit.
if (process.env.TRACE) {
  const area = process.env.TRACE;
  const start = db.prepare("SELECT vnum FROM rooms WHERE area=? AND vnum IN (SELECT from_vnum FROM exits WHERE direction IN ('n','s','e','w','ne','nw','se','sw')) ORDER BY vnum LIMIT 1").get(area);
  if (!start) { console.log('no start'); process.exit(0); }
  const sim = makeSim(start.vnum); sim.look();
  console.log(`start truth=${start.vnum} (${map.getRoom(start.vnum).name}) sig=${sigv(start.vnum)} placed=${sim.placed()}`);
  let lastDir = null;
  for (let i = 0; i < COLD; i++) {
    const d = pickDir(sim.truth(), lastDir); if (!d) break;
    if (!sim.move(d)) break; lastDir = normDir(d);
    const p = sim.placed(), t = sim.truth(), dd = sim.dump();
    console.log(`${i} ${d} -> truth=${t} sig=${sigv(t)} | placed=${p} rv=${dd.rv} q=[${dd.q}] c=${dd.c}${p != null && p !== t ? ' DRIFT' : ''}`);
  }
  process.exit(0);
}

const areas = db.prepare('SELECT name FROM areas').all().map(r => r.name).filter(Boolean);
// Gate mode (run with a ws:// arg) samples areas + shorter walks to stay well under the 60s
// suite timeout; run manually (no ws arg) for the full every-area sweep.
const GATE = !!(process.argv[2] && process.argv[2].startsWith('ws'));
const STRIDE = GATE ? 4 : 1, COLD = GATE ? 16 : 30, BURSTN = GATE ? 16 : 25;
let tested = 0, skipped = 0, drift = 0, coldOK = 0, coldNo = 0, burstExact = 0, burstNo = 0, totalSteps = 0;
const driftAreas = [], burstFailAreas = [];

for (let ai = 0; ai < areas.length; ai++) {
  if (ai % STRIDE !== 0) continue;
  const area = areas[ai];
  // a start room in this area with at least one cardinal exit
  const start = db.prepare("SELECT vnum FROM rooms WHERE area=? AND vnum IN (SELECT from_vnum FROM exits WHERE direction IN ('n','s','e','w','ne','nw','se','sw')) ORDER BY vnum LIMIT 1").get(area);
  if (!start) { skipped++; continue; }
  tested++;
  // (A) cold-start walk
  const simA = makeSim(start.vnum); simA.look();
  let conv = -1, lastDir = null;
  for (let i = 0; i < COLD; i++) {
    const d = pickDir(simA.truth(), lastDir); if (!d) break;
    if (!simA.move(d)) break; lastDir = normDir(d); totalSteps++;
    const p = simA.placed();
    if (p != null && p !== simA.truth()) { drift++; if (driftAreas.length < 20) driftAreas.push(`${area}@${simA.truth()} cold`); }
    if (p === simA.truth() && conv < 0) conv = i;
  }
  if (conv >= 0) coldOK++; else coldNo++;
  // (B) burst from a known anchor (goaegis case)
  const dirs = buildPath(start.vnum, BURSTN);
  if (dirs.length >= 6) {
    const simB = makeSim(start.vnum); simB.clickPlace(start.vnum); simB.burst(dirs);
    if (simB.placed() === simB.truth()) burstExact++;
    else { burstNo++; if (burstFailAreas.length < 20) burstFailAreas.push(`${area} (placed ${simB.placed()} vs ${simB.truth()})`); }
  }
}
db.close();
console.log(`Areas: ${areas.length} total, ${tested} tested, ${skipped} skipped (no cardinal start)`);
console.log(`Steps walked: ${totalSteps}`);
console.log(`DRIFT incidents (confidently-WRONG room): ${drift}   ${drift === 0 ? '✅ never lied' : '❌'}`);
console.log(`Cold-start convergence: ${coldOK} converged, ${coldNo} stayed unplaced (uniform/odd areas — guess-fallback, not wrong)`);
console.log(`Burst-from-anchor EXACT: ${burstExact} exact, ${burstNo} not-exact`);
if (driftAreas.length) console.log('Drift samples: ' + driftAreas.join('; '));
if (burstFailAreas.length) console.log('Burst-not-exact samples: ' + burstFailAreas.join('; '));
// Gate line: the hard invariant is NEVER confidently-wrong (drift==0). Burst-not-exact also fails
// (a known-anchor walk must end exact). Cold-start "unplaced" is allowed (honest guessing fallback).
console.log(`\nResults: ${tested} passed, ${drift + burstNo} failed`);
process.exit((drift + burstNo) > 0 ? 1 : 0);
