// test_map_reckon.js — deterministic tests for map dead-reckoning (glitch/maplib.js).
//
// Why this exists: the ID-less, duplicate-name, uniform-grid areas (Mahjongg, Aegis)
// can't be validated by eyeballing the live client. This simulates walking such grids
// and asserts the reckoned room == the truth — so the algorithm is proven in the gate,
// not by Nathan reporting "wrong room" and us guessing. Covers the real bugs we hit:
//   - `look` (no movement) must HOLD position, never bounce to a same-fingerprint neighbor
//   - a real move must track via the direction taken (the reliable disambiguator)
//   - blocked move / no-anchor cold-start / ambiguous-without-direction behave sanely
//
// Run: node test_map_reckon.js [ws://...]   (ws arg ignored; no server needed)

const { normDir, sigOf, reckonRoom, initCandidates, narrowCandidates, reckonNext } = require('../maplib');

let passed = 0, failed = 0;
function check(cond, msg) { if (cond) { passed++; } else { failed++; console.log('  FAIL: ' + msg); } }
function eq(a, b, msg) { check(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// ── Synthetic uniform grid: WxH rooms, ALL the same name, cardinal exits to neighbors.
//    This is the worst case (Mahjongg/Aegis interiors): name+exits can't tell rooms apart.
function buildGrid(W, H, name) {
  const rooms = new Map(), exits = new Map();
  const id = (x, y) => y * W + x + 1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = id(x, y); rooms.set(v, { vnum: v, name });
    const ex = [];
    if (y > 0) ex.push({ direction: 'n', to_vnum: id(x, y - 1) });
    if (y < H - 1) ex.push({ direction: 's', to_vnum: id(x, y + 1) });
    if (x < W - 1) ex.push({ direction: 'e', to_vnum: id(x + 1, y) });
    if (x > 0) ex.push({ direction: 'w', to_vnum: id(x - 1, y) });
    exits.set(v, ex);
  }
  const byName = new Map();
  for (const r of rooms.values()) { if (!byName.has(r.name)) byName.set(r.name, []); byName.get(r.name).push(r); }
  return {
    getRoom: v => rooms.get(v),
    getExits: v => exits.get(v) || [],
    getRoomsByName: n => byName.get(n) || [],
    id, W, H,
  };
}

const sigOfRoom = (map, v) => sigOf(map.getExits(v).map(e => e.direction));
const observe = (map, v) => ({ name: map.getRoom(v).name, mipSig: sigOfRoom(map, v) });

// Stateful tracker mirroring the server wrapper: a move sets+consumes the one-shot
// direction signal; a look has no movement signal.
function makeTracker(map, start) {
  let prev = start;
  return {
    step(dir, observed) {
      // mirror the server: compass dirs set lastMoveDir; named exits (portal/enter) set lastMoveCmd
      const res = reckonRoom(map, { prevVnum: prev, lastMoveDir: normDir(dir), lastMoveCmd: String(dir).toLowerCase(), movedRecently: true }, observed);
      if (res) prev = res.vnum;      // wrapper consumes move signal after use
      return res;
    },
    look(observed) {
      const res = reckonRoom(map, { prevVnum: prev, lastMoveDir: null, lastMoveCmd: null, movedRecently: false }, observed);
      if (res) prev = res.vnum;
      return res;
    },
    pos() { return prev; },
  };
}

// ── T1: look NEVER bounces (the headline bug — orange↔green on every look).
(function () {
  const g = buildGrid(5, 5, '## Mahjongg ##');
  const center = g.id(2, 2);
  const t = makeTracker(g, center);
  let stable = true;
  for (let i = 0; i < 12; i++) { t.look(observe(g, center)); if (t.pos() !== center) stable = false; }
  check(stable, 'T1: 12 consecutive looks hold position (no bounce)');
})();

// ── T2: a real walk tracks exactly via the direction taken.
(function () {
  const g = buildGrid(5, 5, '## Mahjongg ##');
  let cur = g.id(0, 0);
  const t = makeTracker(g, cur);
  const path = ['e', 'e', 's', 's', 'w', 'n', 'e', 's']; // stays in bounds
  let ok = true, detail = '';
  for (const d of path) {
    const ex = g.getExits(cur).find(e => e.direction === d);
    if (!ex) continue;            // skip if at a wall for this synthetic path
    cur = ex.to_vnum;
    t.step(d, observe(g, cur));
    if (t.pos() !== cur) { ok = false; detail = `expected ${cur} got ${t.pos()} after ${d}`; }
  }
  check(ok, 'T2: walk tracks exactly via direction ' + detail);
})();

// ── T3: looks interleaved in a walk hold between moves.
(function () {
  const g = buildGrid(5, 5, '## Mahjongg ##');
  let cur = g.id(1, 1);
  const t = makeTracker(g, cur);
  cur = g.getExits(cur).find(e => e.direction === 'e').to_vnum; t.step('e', observe(g, cur));
  const afterMove = t.pos();
  for (let i = 0; i < 4; i++) t.look(observe(g, cur));
  eq(t.pos(), afterMove, 'T3: looks after a move hold the moved-to room');
  cur = g.getExits(cur).find(e => e.direction === 's').to_vnum; t.step('s', observe(g, cur));
  eq(t.pos(), cur, 'T3: next move after looks still tracks');
})();

// ── T4: blocked move (we "moved" but the destination room doesn't match a neighbor)
//        HOLDS position rather than jumping. Corner room has a unique-ish signature so
//        no same-sig neighbor exists.
(function () {
  const g = buildGrid(5, 5, '## Mahjongg ##');
  const corner = g.id(0, 0); // exits s,e only
  const res = reckonRoom(g, { prevVnum: corner, lastMoveDir: 'n', movedRecently: true }, observe(g, corner));
  check(res && res.vnum === corner, 'T4: blocked move holds position (no jump)');
})();

// ── T5: moved but direction UNKNOWN in a uniform interior → ambiguous → uncertain flag
//        (documents the inherent limit: without the direction, identical neighbors can't
//        be told apart). The marker is flagged uncertain, not presented as confident.
(function () {
  const g = buildGrid(5, 5, '## Mahjongg ##');
  const interior = g.id(2, 2); // exits n,s,e,w; all 4 neighbors also n,s,e,w
  const res = reckonRoom(g, { prevVnum: interior, lastMoveDir: null, movedRecently: true }, observe(g, interior));
  check(res === null, 'T5: ambiguous interior without direction returns null (no confident guess — candidates handle it)');
})();

// ── T6: cold start (no anchor) resolves a room with a UNIQUE exit-signature (a corner)
//        even though the name is shared, but stays unresolved (null → click-to-place) for
//        an ambiguous interior.
(function () {
  const g = buildGrid(5, 5, '## Mahjongg ##');
  const corner = g.id(4, 0); // unique sig "s,w" among same-named rooms
  const rc = reckonRoom(g, { prevVnum: null, lastMoveDir: null, movedRecently: false }, observe(g, corner));
  check(rc && rc.vnum === corner, 'T6: cold-start resolves a unique-signature room');
  const interior = g.id(2, 2);
  const ri = reckonRoom(g, { prevVnum: null, lastMoveDir: null, movedRecently: false }, observe(g, interior));
  check(ri === null, 'T6: cold-start on an ambiguous interior stays unresolved (click-to-place)');
})();

// ── T7: cross-area boundary anchor — the id'd room you came FROM carries the exit into
//        the un-id'd area, so the first un-id'd room resolves from that neighbor.
(function () {
  // room 1000 = "Gate Room" (id'd), exits e->2001 into the grid area.
  const grid = buildGrid(3, 3, '## Mahjongg ##');
  const rooms = new Map(), exits = new Map(), byName = new Map();
  // remap grid vnums into 2001.. and add the gate room
  const remap = v => 2000 + v;
  for (const r of grid.getRoomsByName('## Mahjongg ##')) rooms.set(remap(r.vnum), { vnum: remap(r.vnum), name: r.name });
  for (const r of [...rooms.values()]) {
    const orig = r.vnum - 2000;
    exits.set(r.vnum, grid.getExits(orig).map(e => ({ direction: e.direction, to_vnum: remap(e.to_vnum) })));
  }
  rooms.set(1000, { vnum: 1000, name: 'Gate Room' });
  const entry = remap(grid.id(0, 0));
  exits.set(1000, [{ direction: 'e', to_vnum: entry }]);
  for (const r of rooms.values()) { if (!byName.has(r.name)) byName.set(r.name, []); byName.get(r.name).push(r); }
  const map = { getRoom: v => rooms.get(v), getExits: v => exits.get(v) || [], getRoomsByName: n => byName.get(n) || [] };
  const res = reckonRoom(map, { prevVnum: 1000, lastMoveDir: 'e', movedRecently: true },
    { name: '## Mahjongg ##', mipSig: sigOf(map.getExits(entry).map(e => e.direction)) });
  check(res && res.vnum === entry, 'T7: cross-area boundary resolves the entry room via the exit taken');
})();

// ── T8: phantom command-exits (Section Z's "pause game") must be ignored so the DB
//        signature aligns with MIP's real exits — then a room with a unique real-exit
//        set resolves cold AND corrects drift (landmark snap). This is the Section Z bug.
(function () {
  // 3 rooms, same name, each with a "pause game" pseudo-exit the MUD has but MIP omits.
  const rooms = new Map([
    [1, { vnum: 1, name: 'Section 00' }],
    [2, { vnum: 2, name: 'Section 00' }],
    [3, { vnum: 3, name: 'Section 00' }],
  ]);
  const exits = new Map([
    [1, [{ direction: 'pause game', to_vnum: 0 }, { direction: 'e', to_vnum: 2 }]],            // real sig: e
    [2, [{ direction: 'pause game', to_vnum: 0 }, { direction: 'w', to_vnum: 1 }, { direction: 'e', to_vnum: 3 }]], // e,w
    [3, [{ direction: 'pause game', to_vnum: 0 }, { direction: 'd', to_vnum: 0 }, { direction: 'n', to_vnum: 0 }, { direction: 'w', to_vnum: 2 }]], // d,n,w
  ]);
  const map = {
    getRoom: v => rooms.get(v),
    getExits: v => exits.get(v) || [],
    getRoomsByName: n => [...rooms.values()].filter(r => r.name === n),
  };
  // MIP reports only real exits "d,n,w" for room 3 — unique → resolve cold (no anchor).
  const cold = reckonRoom(map, { prevVnum: null, lastMoveDir: null, movedRecently: false },
    { name: 'Section 00', mipSig: sigOf(['d', 'n', 'w']) });
  check(cold && cold.vnum === 3, 'T8: phantom-exit room resolves cold by real-exit signature');
  // Drift correction: we wrongly think we're in room 1, but land in unique room 3 → snap to 3.
  const corrected = reckonRoom(map, { prevVnum: 1, lastMoveDir: null, movedRecently: false },
    { name: 'Section 00', mipSig: sigOf(['d', 'n', 'w']) });
  check(corrected && corrected.vnum === 3, 'T8: landmark snap corrects dead-reckoning drift');
})();

// ── T9: NAMED (non-compass) exits — portal/enter/out/leave/in — must track. The exit
//        you took identifies the destination even though it isn't a compass direction.
(function () {
  const rooms = new Map([
    [1, { vnum: 1, name: 'Hall A' }],
    [2, { vnum: 2, name: 'Hall B' }],   // reached via the named "portal" exit
    [3, { vnum: 3, name: 'Outside' }],  // reached via "out"
  ]);
  const exits = new Map([
    [1, [{ direction: 'portal', command: 'portal', to_vnum: 2 }, { direction: 'out', command: 'out', to_vnum: 3 }, { direction: 'n', command: 'n', to_vnum: 0 }]],
    [2, [{ direction: 'portal', command: 'portal', to_vnum: 1 }]],
    [3, []],
  ]);
  const map = {
    getRoom: v => rooms.get(v),
    getExits: v => exits.get(v) || [],
    getRoomsByName: n => [...rooms.values()].filter(r => r.name === n),
  };
  // took "portal" from room 1 → must land in room 2 (named, non-compass exit)
  const r1 = reckonRoom(map, { prevVnum: 1, lastMoveDir: null, lastMoveCmd: 'portal', movedRecently: true },
    { name: 'Hall B', mipSig: '' });
  check(r1 && r1.vnum === 2, 'T9: named "portal" exit tracks to its destination');
  // took "out" from room 1 → room 3
  const r2 = reckonRoom(map, { prevVnum: 1, lastMoveDir: null, lastMoveCmd: 'out', movedRecently: true },
    { name: 'Outside', mipSig: '' });
  check(r2 && r2.vnum === 3, 'T9: named "out" exit tracks to its destination');
})();

// ── T10: AUTO-ANCHOR BY WALKING — start unplaced in a uniform grid, no anchor, and let
//        candidate-narrowing converge to the true room as we move (no click-to-place).
(function () {
  const g = buildGrid(5, 5, '## Maze ##');
  const obs = (v) => observe(g, v);
  let cur = g.id(2, 2);                                   // true start (interior, ambiguous)
  let cands = initCandidates(g, obs(cur).name, obs(cur).mipSig);
  check(cands.length > 1, `T10: starts ambiguous (${cands.length} candidates)`);
  const path = ['e', 'e', 's', 's'];                     // walk into the SE corner — collapses
  for (const d of path) {
    cur = g.getExits(cur).find(e => e.direction === d).to_vnum;
    cands = narrowCandidates(g, cands, d, obs(cur).name, obs(cur).mipSig);
  }
  check(cands.length === 1 && cands[0] === cur, `T10: converges to the true room (len ${cands.length}, want vnum ${cur})`);
})();

// ── T11: narrowing reseeds (doesn't go permanently empty) if the trail is lost.
(function () {
  const g = buildGrid(4, 4, '## Maze ##');
  let cands = initCandidates(g, '## Maze ##', sigOf(['n', 's', 'e', 'w']));
  // a move whose destination signature matches NOTHING reachable → empties (caller reseeds)
  const emp0 = narrowCandidates(g, cands, 'e', '## Maze ##', sigOf(['n', 's', 'e', 'w', 'u']));
  check(emp0.length === 0, 'T11: an impossible move empties candidates (caller reseeds)');
})();

// ── Part B (optional): walk the REAL map DB if it's on this box. Skips cleanly if not.
(function () {
  const fs = require('fs');
  const candidates = ['/opt/wmt/3k_map.db', __dirname + '/../3k_map.db'];
  const dbPath = candidates.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
  if (!dbPath) { console.log('  (Part B skipped: no 3k_map.db on this box)'); return; }
  let Database;
  try { Database = require('better-sqlite3'); } catch (e) { console.log('  (Part B skipped: better-sqlite3 unavailable)'); return; }
  let db;
  try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); } catch (e) { console.log('  (Part B skipped: cannot open map db)'); return; }

  const sRoom = db.prepare('SELECT vnum,name,area FROM rooms WHERE vnum=?');
  const sExits = db.prepare('SELECT direction,to_vnum FROM exits WHERE from_vnum=?');
  const sByName = db.prepare('SELECT vnum,name,area FROM rooms WHERE name=?');
  const map = { getRoom: v => sRoom.get(v), getExits: v => sExits.all(v), getRoomsByName: n => sByName.all(n) };
  const CARD = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

  for (const area of ['Mahjongg', 'Aegis Global']) {
    const start = db.prepare('SELECT vnum,name FROM rooms WHERE area=? ORDER BY vnum LIMIT 1').get(area);
    if (!start) { console.log(`  (Part B: area "${area}" not in db, skipped)`); continue; }
    const t = makeTracker(map, start.vnum);
    let cur = start.vnum, steps = 0, tracked = 0, lastDir = null;
    for (let i = 0; i < 60 && steps < 30; i++) {
      const exs = map.getExits(cur).filter(e => CARD.has((e.direction || '').toLowerCase()) && map.getRoom(e.to_vnum) && map.getRoom(e.to_vnum).name);
      if (!exs.length) break;
      // prefer not to immediately backtrack
      const back = { n: 's', s: 'n', e: 'w', w: 'e', ne: 'sw', sw: 'ne', nw: 'se', se: 'nw' }[lastDir];
      const choice = exs.find(e => e.direction !== back) || exs[0];
      const dest = choice.to_vnum;
      lastDir = choice.direction;
      cur = dest; steps++;
      const r = t.step(choice.direction, observe(map, dest));
      if (r && r.vnum === dest) tracked++;
      // a look in between must hold
      const lk = t.look(observe(map, dest));
      if (!lk || lk.vnum !== dest) tracked = -999;
    }
    check(steps > 0 && tracked === steps, `Part B: ${area} — tracked ${tracked}/${steps} real steps (incl. look-holds)`);
  }
  db.close();
})();

// ── Part C: FULL-PIPELINE simulation through the real reckon brain (reckonNext) on the REAL
//    Aegis data — a virtual MUD walker (fast moves, blocked "can't go that way", teleport entry,
//    wrong click-to-place). The invariant: the reckoner is NEVER confidently in the wrong room
//    (it may be null/narrowing, but a non-null position must equal the true room). This is the
//    test that actually mirrors live play — the thing the unit tests weren't catching.
(function () {
  const fs = require('fs');
  const dbPath = ['/opt/wmt/3k_map.db', __dirname + '/../3k_map.db'].find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
  if (!dbPath) { console.log('  (Part C skipped: no 3k_map.db on this box)'); return; }
  let Database; try { Database = require('better-sqlite3'); } catch (e) { console.log('  (Part C skipped: better-sqlite3 unavailable)'); return; }
  let db; try { db = new Database(dbPath, { readonly: true, fileMustExist: true }); } catch (e) { console.log('  (Part C skipped: cannot open db)'); return; }
  const sRoom = db.prepare('SELECT vnum,name,area FROM rooms WHERE vnum=?');
  const sExits = db.prepare('SELECT direction,to_vnum,command FROM exits WHERE from_vnum=?');
  const sByName = db.prepare('SELECT vnum,name,area FROM rooms WHERE name=?');
  const map = { getRoom: v => sRoom.get(v), getExits: v => sExits.all(v), getRoomsByName: n => sByName.all(n) };
  const sigv = v => sigOf(map.getExits(v).map(e => e.direction));
  const CARD = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  const BACK = { n: 's', s: 'n', e: 'w', w: 'e', ne: 'sw', sw: 'ne', nw: 'se', se: 'nw' };

  const levelName = 'Aegis Global - Level 1';
  const levelRooms = db.prepare("SELECT vnum FROM rooms WHERE area='Aegis Global' AND name=? ORDER BY vnum").all(levelName).map(r => r.vnum);
  if (!levelRooms.length) { console.log('  (Part C skipped: Aegis Level 1 not in db)'); db.close(); return; }
  // an entry room with cardinal exits (the kind you'd teleport/walk into)
  const entry = levelRooms.find(v => map.getExits(v).some(e => CARD.includes(normDir(e.direction)))) || levelRooms[0];

  // Virtual MUD + reckoner, mirroring the server flow exactly (move QUEUE).
  function makeSim(startV) {
    let truth = startV, clock = 1000;
    let st = { reckonVnum: null, candidates: null, moveQueue: [] };
    const obs = () => ({ name: map.getRoom(truth).name, mipSig: sigv(truth), roomVnum: null, now: clock });
    const run = () => { st = reckonNext(map, st, obs()); };
    const capture = (dir) => { clock += 5; st.moveQueue.push({ token: normDir(dir) || dir.toLowerCase(), at: clock }); };  // server queues outgoing
    return {
      truth: () => truth,
      placed: () => (st.candidates && st.candidates.length > 1) ? null : st.reckonVnum,   // confident position or null
      move(dir) {                       // a real movement command: queue it, MUD moves, one BAD fires
        const d = normDir(dir); capture(dir);
        const ex = map.getExits(truth).find(e => normDir(e.direction) === d);
        if (ex) { truth = ex.to_vnum; clock += 5; run(); return true; }                  // moved → BAD
        return false;                                                                    // blocked → no BAD
      },
      // FAST BURST: queue ALL the directions first (as a fast alias would), THEN the BADs arrive in order.
      burst(dirs) {
        const obsSeq = [];
        for (const dir of dirs) {
          const d = normDir(dir); capture(dir);
          const ex = map.getExits(truth).find(e => normDir(e.direction) === d);
          if (ex) { truth = ex.to_vnum; obsSeq.push({ name: map.getRoom(truth).name, mipSig: sigv(truth), roomVnum: null }); }
        }
        for (const o of obsSeq) { clock += 5; st = reckonNext(map, st, { ...o, now: clock }); }
      },
      look() { clock += 100; run(); },
      blockedThenLook() {               // type a false exit, then look (the drift trap)
        const have = new Set(map.getExits(truth).map(e => normDir(e.direction)));
        const none = CARD.find(d => !have.has(d)); if (!none) return false;
        capture(none);                   // outgoing (will be blocked → no BAD)
        clock += 100; run();             // a look right after
        return true;
      },
      clickPlace(v) { st = { reckonVnum: v, candidates: null, moveQueue: [] }; },
    };
  }
  const pickDir = (v, lastDir) => {
    const exs = map.getExits(v).filter(e => CARD.includes(normDir(e.direction)));
    if (!exs.length) return null;
    return (exs.find(e => normDir(e.direction) !== BACK[lastDir]) || exs[0]).direction;
  };
  // The core invariant checker: walk N steps; a non-null placement must ALWAYS equal truth.
  const walkChecked = (sim, n, label) => {
    let lastDir = null, drift = 0, convergedAt = -1;
    for (let i = 0; i < n; i++) {
      const d = pickDir(sim.truth(), lastDir); if (!d) break;
      sim.move(d); lastDir = normDir(d);
      const p = sim.placed();
      if (p != null && p !== sim.truth()) drift++;
      if (p === sim.truth() && convergedAt < 0) convergedAt = i;
      if (i % 3 === 2) { sim.look(); const pl = sim.placed(); if (pl != null && pl !== sim.truth()) drift++; }
    }
    return { drift, convergedAt };
  };

  // C1: cold teleport entry → converges, and NEVER drifts to a wrong room.
  { const sim = makeSim(entry); sim.look();
    const r = walkChecked(sim, 40, 'cold');
    check(r.drift === 0, `Part C1: cold-entry walk never tracks a wrong room (drifts=${r.drift})`);
    check(r.convergedAt >= 0 && r.convergedAt <= 12, `Part C1: auto-anchors within a few moves (converged step ${r.convergedAt})`);
  }
  // C2: blocked move ("you can't go that way") + look must NOT drift.
  { const sim = makeSim(entry); sim.clickPlace(entry);   // start placed (as if clicked)
    let ok = true;
    for (let i = 0; i < 12; i++) { if (sim.blockedThenLook()) { if (sim.placed() !== sim.truth()) ok = false; } const d = pickDir(sim.truth(), null); if (d) sim.move(d); if (sim.placed() != null && sim.placed() !== sim.truth()) ok = false; }
    check(ok, 'Part C2: blocked moves + looks never drift off the true room');
  }
  // C3: click-to-place then walk fast — stays locked, exact.
  { const sim = makeSim(entry); sim.clickPlace(entry);
    const r = walkChecked(sim, 40, 'placed');
    check(r.drift === 0 && sim.placed() === sim.truth(), `Part C3: placed + fast walk stays exact (drifts=${r.drift})`);
  }
  // C4: WRONG click-to-place must self-correct (sig mismatch → re-acquire), never stay wrong.
  { const sim = makeSim(entry);
    const wrong = levelRooms.find(v => v !== entry && sigv(v) !== sigv(entry)) || levelRooms[levelRooms.length - 1];
    sim.clickPlace(wrong);
    const r = walkChecked(sim, 40, 'wrongclick');
    check(r.drift === 0, `Part C4: a wrong placement never reports a confidently-wrong room while re-acquiring (drifts=${r.drift})`);
    check(r.convergedAt >= 0, 'Part C4: recovers to the true room after a wrong placement');
  }
  // C5: THE LITMUS TEST — a fast alias BURST from an anchored start (the goaegis case). All the
  //     directions are queued before the room updates arrive; the map must follow the WHOLE path
  //     exactly (this is what the single-slot code failed — it kept only the last direction).
  { const sim = makeSim(entry); sim.clickPlace(entry);
    let cur = entry, lastDir = null; const dirs = [];
    for (let i = 0; i < 25; i++) {
      const d = pickDir(cur, lastDir); if (!d) break;
      const ex = map.getExits(cur).find(e => normDir(e.direction) === normDir(d));
      cur = ex.to_vnum; lastDir = normDir(d); dirs.push(d);
    }
    sim.burst(dirs);
    check(dirs.length >= 8 && sim.placed() === sim.truth(),
      `Part C5: fast alias BURST followed the whole path exactly (steps=${dirs.length}, placed=${sim.placed()}, truth=${sim.truth()})`);
  }
  db.close();
})();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
