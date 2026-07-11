// maplib.js — pure map dead-reckoning logic, extracted from server.js so it can be
// unit-tested deterministically (tests/sandbox/test_map_reckon.js) without booting a
// server or a real MUD. NO side effects, NO require of server state. The server wraps
// reckonRoom() with a map accessor built from its SQLite statements + session state.
//
// The problem this solves: some 3K areas (Mahjongg, Aegis) send NO room id over MIP and
// reuse one room name across a whole uniform exit grid, so name+exits can't identify the
// room. tt++ tracks you by the EXIT YOU TOOK; we do the same — the direction of the
// movement command is the reliable disambiguator. A `look` (no movement) must hold
// position, NOT walk to a same-fingerprint neighbor.

/** Normalize a direction token (full word or abbreviation) to its short form, or null. */
function normDir(s) {
  if (!s) return null;
  s = String(s).trim().toLowerCase();
  const long = { north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw', up: 'u', down: 'd' };
  if (long[s]) return long[s];
  return ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'u', 'd'].includes(s) ? s : null;
}

/**
 * Exit-direction signature: ONLY real movement directions (n/s/e/w/diagonals/u/d),
 * normalized, de-duped, sorted, joined. Pseudo / command exits the MUD stores but does
 * NOT list in MIP — "pause game" (Section Z), "enter", "omp", "jump" (Pinnacle), etc. —
 * are dropped so the DB signature and the MIP-reported exits actually align. Without this
 * the signatures never match in those areas and reckoning can't use exits at all.
 */
function sigOf(dirs) {
  return [...new Set((dirs || []).map(d => normDir(d)).filter(Boolean))].sort().join(',');
}

/**
 * Dead-reckon the current room.
 *
 * @param map      accessor: { getRoom(vnum)->{vnum,name,...}|undefined,
 *                             getExits(vnum)->[{direction,to_vnum}],
 *                             getRoomsByName(name)->[room] }
 * @param state    { prevVnum, lastMoveDir, lastMoveCmd, movedRecently }
 *                   - prevVnum: our last confident position (or null)
 *                   - lastMoveDir: normalized compass direction of the last move (or null)
 *                   - lastMoveCmd: raw command of the last move, for NAMED exits (portal,
 *                                  enter, climb…) that aren't compass directions (or null)
 *                   - movedRecently: true iff a movement command was sent just before this update
 * @param obs      { name, mipSig }  the MUD-reported room name + its exit signature (sorted/joined)
 * @returns { vnum, uncertain } | null   (null = can't place — caller should prompt click-to-place)
 *
 * The caller consumes the one-shot move signal (clear lastMoveDir/At) whenever
 * movedRecently was true, so a subsequent `look` isn't mistaken for a move.
 */
function reckonRoom(map, state, obs) {
  const { prevVnum, lastMoveDir, lastMoveCmd, movedRecently } = state;
  const { name, mipSig } = obs;
  const sig = (v) => sigOf((map.getExits(v) || []).map(e => e.direction));

  // LANDMARK SNAP (first — the strongest signal): if this room is uniquely identifiable by
  // name, or by name + real-exit signature, trust that absolutely. It both cold-locates us
  // (no "click to place") AND corrects any dead-reckoning drift the moment we hit a room
  // with a distinctive exit set. Only falls through when the room is genuinely ambiguous
  // (shares name + signature with others — e.g. a Mahjongg interior).
  const byName = map.getRoomsByName(name) || [];
  if (byName.length === 1) return { vnum: byName[0].vnum, uncertain: false };
  if (byName.length > 1 && mipSig) {
    const uniq = byName.filter(r => sig(r.vnum) === mipSig);
    if (uniq.length === 1) return { vnum: uniq[0].vnum, uncertain: false };
  }

  // Ambiguous room (shared name + signature). Resolve by movement relative to where we were.
  // NOTE: we intentionally do NOT discard a cross-area anchor here — a legit walk across an
  // area boundary relies on the previous (id'd) room's cross-area exit to identify the first
  // room of the new area. A teleport through an UNMAPPED room (e.g. a personal vault) simply
  // leaves no usable anchor and resolves via landmark-snap or click-to-place instead.
  if (prevVnum != null) {
    const prevRoom = map.getRoom(prevVnum);

    if (!movedRecently) {
      // No movement preceded this update → SAME room re-displayed (`look`, combat, prompt).
      // Hold position. THIS is the anti-bounce guard.
      if (prevRoom && prevRoom.name === name) return { vnum: prevVnum, uncertain: false };
      // Name changed with no move we saw → teleport/forced; can't place → null.
    } else {
      // 0) Exit-primary (reliable): trust the exit we took — a compass direction OR a NAMED
      //    exit command (portal, enter, climb, grasp…). This is how non-cardinal exits track.
      if (lastMoveDir || lastMoveCmd) {
        const exits = map.getExits(prevVnum) || [];
        let de = lastMoveDir ? exits.find(e => normDir(e.direction) === lastMoveDir) : null;
        if (!de && lastMoveCmd) {
          const lc = String(lastMoveCmd).toLowerCase();
          de = exits.find(e => (e.command || '').toLowerCase() === lc || (e.direction || '').toLowerCase() === lc);
        }
        if (de) {
          const dest = map.getRoom(de.to_vnum);
          // VERIFY the exit-signature too, not just the name — otherwise a stale/wrong anchor
          // silently drifts (the exit "exists" on the map but the room we're actually in has
          // different exits). Sig mismatch → don't trust it; fall through to re-acquire.
          if (dest && dest.name === name && sig(dest.vnum) === mipSig) return { vnum: dest.vnum, uncertain: false };
        } else if (prevRoom && prevRoom.name === name && sig(prevVnum) === mipSig) {
          // The exit we "took" doesn't exist from here → BLOCKED ("you can't go that way") or
          // a re-displayed prompt. The observed room still matches where we are → STAY put
          // (don't let a phantom move drift us to a same-shaped neighbor).
          return { vnum: prevVnum, uncertain: false };
        }
      }
      // 1) Neighbor-constrained: the new room is a direct graph neighbor of where we were.
      const nbr = [...new Set((map.getExits(prevVnum) || []).map(e => e.to_vnum))]
        .map(v => map.getRoom(v)).filter(Boolean);
      const hit = nbr.filter(r => r.name === name && sig(r.vnum) === mipSig);
      if (hit.length === 1) return { vnum: hit[0].vnum, uncertain: false };
      // Ambiguous (several identical neighbors) or unresolved → return null so the caller's
      // candidate-narrowing takes over. We NEVER return a low-confidence guess that could drift.
    }
  }

  return null;
}

/**
 * Auto-anchor by walking (candidate narrowing). When reckonRoom can't place us (uniform
 * grid, teleported/secret-door entry, no anchor), we DON'T give up — we track every room
 * that could be our position and eliminate impossibilities as we move. After a few steps
 * the set collapses to one room and we lock on, with NO click-to-place needed. This is how
 * a real mapper re-acquires position. Both functions are pure (unit-tested).
 */

/** Seed candidates: every room matching the reported name (+ exit signature). */
function initCandidates(map, name, mipSig) {
  const byName = map.getRoomsByName(name) || [];
  const sig = (v) => sigOf((map.getExits(v) || []).map(e => e.direction));
  const m = mipSig ? byName.filter(r => sig(r.vnum) === mipSig) : byName;
  return m.map(r => r.vnum);
}

/**
 * Narrow candidates by one move: each candidate must have the exit we took, and that
 * exit's destination must match the NEW room (name + signature). The survivors' destinations
 * are the new candidate positions. Returns a de-duped vnum array (possibly empty → lost).
 */
function narrowCandidates(map, candidates, moveToken, newName, newSig) {
  const sig = (v) => sigOf((map.getExits(v) || []).map(e => e.direction));
  const tok = String(moveToken || '').toLowerCase();
  const nd = normDir(tok);
  const next = new Set();
  for (const c of candidates) {
    const exits = map.getExits(c) || [];
    const de = (nd && exits.find(e => normDir(e.direction) === nd))
      || exits.find(e => (e.command || '').toLowerCase() === tok || (e.direction || '').toLowerCase() === tok);
    if (!de) continue;
    const dest = map.getRoom(de.to_vnum);
    if (dest && dest.name === newName && (!newSig || sig(dest.vnum) === newSig)) next.add(dest.vnum);
  }
  return [...next];
}

/** Find the exit from `vnum` taken by a movement token (compass dir OR a named command). */
function findExit(map, vnum, token) {
  const exits = map.getExits(vnum) || [];
  const nd = normDir(token);
  return (nd && exits.find(e => normDir(e.direction) === nd))
    || exits.find(e => { const t = String(token || '').toLowerCase(); return (e.command || '').toLowerCase() === t || (e.direction || '').toLowerCase() === t; })
    || null;
}

/**
 * The COMPLETE reckon brain — pure and fully testable (no server/session deps). One call per
 * MIP room update. Tracks position by a MOVE QUEUE: every direction you send is remembered in
 * order (`moveQueue`), and each room update is paired with the OLDEST unconsumed move — so a
 * fast alias burst (`science;enter;u;e;e;e;…`, moves arriving faster than the MUD's room
 * updates) is followed step-by-step instead of losing all but the last direction. Anchored from
 * a unique room name (landmark), it then KNOWS each room from the submitted path — no guessing.
 * Guessing (candidate-narrowing) remains only as the no-anchor / lost fallback.
 *
 * @param map   accessor (getRoom/getExits/getRoomsByName)
 * @param state { reckonVnum, candidates, moveQueue:[{token,at}] }
 * @param obs   { name, mipSig, roomVnum, now }
 * @returns { reckonVnum, candidates, moveQueue, vnum, uncertain }
 *          vnum = confident position (or null → unplaced; candidates holds the possibilities)
 */
function reckonNext(map, state, obs) {
  const { reckonVnum, candidates } = state;
  const { name, mipSig, roomVnum, now } = obs;
  const sigv = (v) => sigOf((map.getExits(v) || []).map(e => e.direction));
  const matches = (v) => { const r = map.getRoom(v); return !!r && r.name === name && sigv(v) === mipSig; };
  // Drop stale queued moves (blocked moves that never produced a room, or aborted bursts).
  let queue = (state.moveQueue || []).filter(m => !now || (now - m.at) < 12000);

  // 1) Authoritative MIP vnum (areas that report it) — always wins; the path is resolved.
  if (roomVnum) return { reckonVnum: roomVnum, candidates: null, moveQueue: [], vnum: roomVnum, uncertain: false };

  // 2) Landmark snap: a uniquely-identifiable room (by name, or name+signature) — anchors us and
  //    corrects any drift. KEEP the move queue (it holds FUTURE moves not yet applied; clearing it
  //    mid-burst would lose them and strand the next non-unique room — the queue-follow drops any
  //    now-stale head itself). Drop one consumed head so the queue stays aligned with rooms.
  const byName = map.getRoomsByName(name) || [];
  const snap = (vnum) => {
    // One room update consumes ONE queued move (FIFO) whenever we actually moved (the room
    // changed, or we're placing from cold start with a move pending). This stops the queue
    // accumulating stale moves through a run of landmark rooms — stale moves later
    // coincidentally mis-match in a uniform corridor and cause drift. A `look` (same room,
    // no move) consumes nothing.
    const moved = (reckonVnum == null) ? queue.length > 0 : (vnum !== reckonVnum);
    const q = (moved && queue.length) ? queue.slice(1) : queue;
    return { reckonVnum: vnum, candidates: null, moveQueue: q, vnum, uncertain: false };
  };
  if (byName.length === 1) return snap(byName[0].vnum);
  if (byName.length > 1 && mipSig) {
    const uq = byName.filter(r => sigv(r.vnum) === mipSig);
    if (uq.length === 1) return snap(uq[0].vnum);
  }

  // 3) Anchored → FOLLOW THE QUEUE: pair this room update with the oldest move that explains it.
  if (reckonVnum != null) {
    let cur = reckonVnum, guard = 0;
    while (queue.length && guard++ < 64) {
      const de = findExit(map, cur, queue[0].token);
      if (!de) { queue = queue.slice(1); continue; }                     // head can't be taken from here → STALE move → drop it, try next
      const dest = map.getRoom(de.to_vnum);
      if (dest && dest.name === name && sigv(dest.vnum) === mipSig) {     // this move produced this room
        queue = queue.slice(1);
        return { reckonVnum: dest.vnum, candidates: null, moveQueue: queue, vnum: dest.vnum, uncertain: false };
      }
      if (matches(cur)) {                                                 // head has an exit but leads elsewhere → still here (look / pending)
        return { reckonVnum: cur, candidates: null, moveQueue: queue, vnum: cur, uncertain: false };
      }
      queue = queue.slice(1);                                            // moved, but not via this head → drop it, try the next
    }
    if (matches(cur)) return { reckonVnum: cur, candidates: null, moveQueue: queue, vnum: cur, uncertain: false };
    // anchor no longer matches and the queue couldn't explain it → fall through to re-acquire.
  }

  // 4) No anchor / lost → GUESS via candidate-narrowing (the fallback). Narrow by the oldest
  //    queued move when we have a candidate set; otherwise (re)seed from name + signature.
  let cands = candidates;
  if (cands && cands.length && queue.length) {
    const narrowed = narrowCandidates(map, cands, queue[0].token, name, mipSig);
    if (narrowed.length) { queue = queue.slice(1); cands = narrowed; }
    else cands = initCandidates(map, name, mipSig);
  } else if (!cands || !cands.length) {
    cands = initCandidates(map, name, mipSig);
  } else {
    cands = cands.filter(matches); if (!cands.length) cands = candidates;   // look while narrowing: keep consistent ones
  }
  cands = [...new Set(cands)];
  if (cands.length > 400) cands = cands.slice(0, 400);

  if (cands.length === 1) return { reckonVnum: cands[0], candidates: null, moveQueue: queue, vnum: cands[0], uncertain: false };
  return { reckonVnum, candidates: cands, moveQueue: queue, vnum: null, uncertain: false };
}

module.exports = { normDir, sigOf, reckonRoom, findExit, initCandidates, narrowCandidates, reckonNext };
