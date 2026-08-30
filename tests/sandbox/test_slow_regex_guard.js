/**
 * SLOW_REGEX 3-strike guard — a single slow regex sample must NOT disable a trigger.
 *
 * Root being fixed (2026-08-30): the ReDoS guard disabled a trigger on ONE match
 * exceeding 50ms wall-clock. A GC pause / CPU contention blip on the box tripped it
 * for elminster's in-combat `^Coff: ... Mon\(...\)` trigger (63ms, once, out of
 * thousands of clean 2s-interval evaluations) — silently killing combat detection
 * mid-bot. Same guard killed a trivially-linear stun pattern on Aug 24 (75ms).
 * Fix: disable only after 3 slow strikes within 60s (tracked on session.loopTracker);
 * single samples log SLOW_REGEX_WARN and the trigger keeps working.
 *
 * Scenarios (uses a genuinely catastrophic pattern `~^(a+)+$` against a near-miss
 * line, calibrated in-process to reliably exceed the 50ms threshold on this box):
 *   T1: ONE slow match → NO disable_trigger, NO "Slow regex" system message.
 *       (Pre-fix server disables on the first hit → T1 is the red/green pivot.)
 *   T2: THREE slow matches within the window → disable_trigger arrives (real ReDoS
 *       protection still works).
 *
 * Run: node test_slow_regex_guard.js
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const Database = require('/opt/wmt/node_modules/better-sqlite3');

const WS_URL = process.argv[2] || 'ws://localhost:3000';
const DB_PATH = '/opt/wmt/wmt.db';
const CHAR_ID = 'slowrx-test-char';
let ws;
const token = crypto.randomBytes(32).toString('hex');
let disables = [];      // disable_trigger messages
let systemMsgs = [];    // system messages
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS: ' + n); };
const bad = (n, m) => { fail++; console.log('  FAIL: ' + n + (m ? ' — ' + m : '')); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const send = (type, data = {}) => ws.send(JSON.stringify({ type, ...data }));

// Calibrate a near-miss line for ~^(a+)+$ that takes 80–500ms to fail on THIS box
// (the suite runs on the same host as the server, so timing transfers).
function calibrateEvilLine() {
  const rx = /^(a+)+$/;
  for (let n = 18; n <= 30; n++) {
    const line = 'a'.repeat(n) + 'b';
    const t0 = Date.now();
    rx.test(line);
    const el = Date.now() - t0;
    if (el >= 80 && el <= 2000) return { line, elapsed: el, n };
    if (el > 2000) return { line: 'a'.repeat(n - 1) + 'b', elapsed: el, n: n - 1 };
  }
  return null;
}

async function main() {
  console.log('=== SlowRegexGuard ===');
  try {
    const evil = calibrateEvilLine();
    if (!evil) { bad('calibration', 'could not produce a 80–2000ms catastrophic match on this box'); throw new Error('calibration failed'); }
    console.log(`  (calibrated: ${evil.n} a's → ${evil.elapsed}ms locally)`);

    ws = new WebSocket(WS_URL);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('connect timeout')), 5000); });
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'disable_trigger') disables.push(m);
        if (m.type === 'system' && /slow regex/i.test(m.message || '')) systemMsgs.push(m.message);
      } catch (e) {}
    });

    send('auth', { token, userId: 'slowrx-test', characterId: CHAR_ID, characterName: 'SlowRxRunner', packetPatch: 0 });
    await sleep(500);
    send('set_server', { host: 'localhost', port: 4000 });
    await sleep(500);
    send('set_aliases', { aliases: [] });
    send('set_variables', { variables: {} });
    send('set_functions', { functions: {} });
    // The catastrophic trigger, plus a healthy sibling to prove the pipeline is live.
    send('set_triggers', { triggers: [
      { id: 'evilrx1', pattern: '~^(a+)+$', matchType: 'tintin', actions: [{ type: 'command', command: '#var evilmatched 1' }], priority: 5, enabled: true },
    ] });
    await sleep(1500);
    send('command', { command: 'SlowRxRunner' });
    await sleep(500);
    send('command', { command: 'password' });
    await sleep(1500);

    // T1: a single slow sample must not disable the trigger.
    disables = []; systemMsgs = [];
    send('command', { command: '__emit ' + evil.line });
    await sleep(2000);
    if (disables.length === 0 && systemMsgs.length === 0) {
      ok('T1: one slow match → no disable, no user-facing message');
    } else {
      bad('T1: single slow sample disabled the trigger', `disables=${JSON.stringify(disables)} system=${JSON.stringify(systemMsgs)}`);
    }

    // T2: three strikes within the window → disable fires (ReDoS protection intact).
    send('command', { command: '__emit ' + evil.line });
    await sleep(1500);
    send('command', { command: '__emit ' + evil.line });
    await sleep(2500);
    const disabledEvil = disables.some(d => d.triggerId === 'evilrx1');
    if (disabledEvil && systemMsgs.length > 0) {
      ok('T2: third slow strike within 60s → trigger disabled with user notice');
    } else {
      bad('T2: sustained slowness should still disable', `disables=${JSON.stringify(disables)} system=${JSON.stringify(systemMsgs)}`);
    }

  } catch (e) {
    bad('harness', e.message);
  } finally {
    try {
      const db = new Database(DB_PATH);
      for (const tbl of ['triggers', 'aliases', 'tickers', 'entity_guard']) {
        try { db.prepare(`DELETE FROM ${tbl} WHERE character_id = ?`).run(CHAR_ID); } catch (e) {}
      }
      db.close();
    } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}
main();
