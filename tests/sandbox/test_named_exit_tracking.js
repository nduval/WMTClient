// Prove the map TRACKS through Celestial's Aeonos floor via named/one-way/vertical exits, using
// the real reckon brain + real 3k_map.db + the map_overrides swim 53915->53587. Transition model:
// each move should land the reckoner in the right room (the view then re-centers on it).
//   chain A (Nathan's "up brings you back"): 53912 -enter-> 53914 -swim-> 53915 -up-> 53914 -out-> 53912
//   chain B (override swim out):             53912 -enter-> 53914 -swim-> 53915 -swim-> 53587
// Gate suite (NamedExitTracking). Run: NODE_PATH=/opt/wmt/node_modules node test_named_exit_tracking.js
const { normDir, sigOf, reckonNext } = require(process.env.MAPLIB || '/opt/wmt/maplib.js');
if (!require('fs').existsSync('/opt/wmt/3k_map.db')) { console.log('Results: 0 passed, 0 failed (no map db — skipped)'); process.exit(0); }
const Database = require('better-sqlite3');
const db = new Database('/opt/wmt/3k_map.db', { readonly: true });
const sRoom = db.prepare('SELECT vnum,name,area FROM rooms WHERE vnum=?');
const sExits = db.prepare('SELECT direction,to_vnum,command FROM exits WHERE from_vnum=?');
const sByName = db.prepare('SELECT vnum,name,area FROM rooms WHERE name=?');
// Mirror the server's map_overrides addExits: 53915 --swim--> 53587 (one-way).
const OVERRIDE = { 53915: [{ direction: 'swim', command: 'swim', to_vnum: 53587 }] };
const map = {
  getRoom: v => sRoom.get(v),
  getExits: v => sExits.all(v).concat(OVERRIDE[v] || []),
  getRoomsByName: n => sByName.all(n),
};
const sigv = v => sigOf(map.getExits(v).map(e => e.direction));
const nm = v => { const r = map.getRoom(v); return r ? r.name : '(MISSING ' + v + ')'; };

function run(label, start, steps) {
  console.log(`\n=== ${label} ===`);
  let truth = start, clock = 1000;
  let st = { reckonVnum: null, candidates: null, moveQueue: [] };
  // cold anchor on the start room
  st = reckonNext(map, st, { name: nm(truth), mipSig: sigv(truth), roomVnum: null, now: clock });
  console.log(`start @${truth} "${nm(truth)}"  reckon=${st.vnum} ${st.vnum === truth ? 'OK' : 'MISPLACED'}`);
  let pass = st.vnum === truth;
  for (const cmd of steps) {
    clock += 5;
    st.moveQueue = (st.moveQueue || []).concat([{ token: normDir(cmd) || cmd.toLowerCase(), at: clock }]);
    const ex = map.getExits(truth).find(e =>
      (normDir(e.direction) && normDir(e.direction) === normDir(cmd)) ||
      (e.command || '').toLowerCase() === cmd.toLowerCase() || (e.direction || '').toLowerCase() === cmd.toLowerCase());
    if (!ex) { console.log(`  ${cmd}: NO SUCH EXIT from ${truth} — test path wrong`); pass = false; break; }
    truth = ex.to_vnum;
    clock += 5;
    st = reckonNext(map, st, { name: nm(truth), mipSig: sigv(truth), roomVnum: null, now: clock });
    const ok = st.vnum === truth;
    pass = pass && ok;
    console.log(`  ${cmd.padEnd(6)} -> truth=${truth} "${nm(truth)}"  reckon=${st.vnum}  ${ok ? 'OK' : (st.vnum == null ? 'UNPLACED ❌' : 'DRIFT ❌')}`);
  }
  console.log(`  ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  return pass;
}

const a = run('Chain A: enter/swim/up/out (up brings you back)', 53912, ['enter', 'swim', 'up', 'out']);
const b = run('Chain B: enter/swim/swim-out via override', 53912, ['enter', 'swim', 'swim']);
console.log(`\nResults: ${(a ? 1 : 0) + (b ? 1 : 0)} passed, ${(a ? 0 : 1) + (b ? 0 : 1)} failed`);
process.exit((a && b) ? 0 : 1);
