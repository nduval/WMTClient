/**
 * Server-side #event dispatch (RECEIVED INPUT) — Phase 1 of the single-owner model.
 *
 * Root being fixed: $idle is incremented by a SERVER ticker but its reset
 * `#EVENT {RECEIVED INPUT}{#var idle 0}` fired ONLY in the browser, where it lost to the
 * server's own ticker value (2s merge-guard) — so server-$idle climbed to tens of minutes
 * even while the player stood idle. Fix: the server now dispatches RECEIVED INPUT on genuine
 * input and runs the handler body server-side, so the reset happens where the ticker lives.
 *
 * Scenarios:
 *   T1: RECEIVED INPUT fires server-side on a typed command — its `#var eventproof N` body
 *       executes on the server and pushes a var_update (proves the whole path).
 *   T2: faithful idle repro — a server ticker climbs $idle; a typed command resets it to 0
 *       via the RECEIVED INPUT handler (the actual bug, end-to-end).
 *   T3: no spurious dispatch — the event does NOT fire without input.
 *
 * Run: node test_input_event_dispatch.js   (ignores any ws:// arg the gate passes)
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const Database = require('/opt/wmt/node_modules/better-sqlite3');

const WS_URL = process.argv[2] || 'ws://localhost:3000';
const DB_PATH = '/opt/wmt/wmt.db';
let ws;
const token = crypto.randomBytes(32).toString('hex');
let varUpdates = [];   // each = the variables object from a var_update message
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS: ' + n); };
const bad = (n, m) => { fail++; console.log('  FAIL: ' + n + (m ? ' — ' + m : '')); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const send = (type, data = {}) => ws.send(JSON.stringify({ type, ...data }));
// Latest server-pushed value of a variable across all var_updates seen.
function latest(name) {
  let v;
  for (const u of varUpdates) { if (u && Object.prototype.hasOwnProperty.call(u, name)) v = u[name]; }
  return v;
}

async function main() {
  console.log('=== InputEventDispatch ===');
  try {
    ws = new WebSocket(WS_URL);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('connect timeout')), 5000); });
    ws.on('message', raw => {
      try { const m = JSON.parse(raw.toString()); if (m.type === 'var_update' && m.variables) varUpdates.push(m.variables); } catch (e) {}
    });

    send('auth', { token, userId: 'evt-test', characterId: 'evt-test-char', characterName: 'EvtRunner', packetPatch: 0 });
    await sleep(500);
    send('set_server', { host: 'localhost', port: 4000 });
    await sleep(500);
    send('set_aliases', { aliases: [] });
    send('set_variables', { variables: {} });
    send('set_functions', { functions: {} });
    await sleep(1500);
    // Log in past the name prompt so _atNamePrompt clears (dispatch is gated off it).
    send('command', { command: 'EvtRunner' });
    await sleep(500);
    send('command', { command: 'password' });
    await sleep(1500);

    // Register the event handler on the server.
    send('set_events', { events: { 'RECEIVED INPUT': [{ body: '#var eventproof 4242' }] } });
    await sleep(400);

    // T3 (checked first): no input yet since set_events → the event must NOT have fired.
    varUpdates = [];
    await sleep(300);
    if (latest('eventproof') === undefined) ok('T3: event does not fire without input');
    else bad('T3: no spurious dispatch', `eventproof=${latest('eventproof')} set with no input`);

    // T1: a typed command fires RECEIVED INPUT server-side.
    varUpdates = [];
    send('command', { command: 'look' });
    await sleep(700);
    const proof = latest('eventproof');
    if (String(proof) === '4242') ok('T1: RECEIVED INPUT dispatched server-side on input');
    else bad('T1: server-side event dispatch', `expected eventproof=4242, got ${JSON.stringify(proof)}; var_updates=${JSON.stringify(varUpdates)}`);

    // T2: faithful idle repro — ticker climbs $idle, a command resets it to 0.
    send('set_events', { events: { 'RECEIVED INPUT': [{ body: '#var idle 0' }] } });
    send('set_tickers', { tickers: [{ id: 'idletick', command: '#math idle $idle+1', interval: 1, enabled: true }] });
    send('set_variables', { variables: { idle: 0 } });
    await sleep(3200);                       // let the ticker climb idle to ~3
    const climbed = latest('idle');
    varUpdates = [];
    send('command', { command: 'look' });    // genuine input → RECEIVED INPUT → #var idle 0
    await sleep(700);
    const afterInput = latest('idle');
    if (Number(climbed) >= 1 && String(afterInput) === '0') ok(`T2: idle climbed to ${climbed} then reset to 0 on input`);
    else bad('T2: idle reset on input', `climbed=${JSON.stringify(climbed)} afterInput=${JSON.stringify(afterInput)}`);

  } catch (e) {
    bad('harness', e.message);
  } finally {
    try { const db = new Database(DB_PATH); for (const tbl of ['triggers', 'aliases', 'tickers', 'entity_guard']) { try { db.prepare(`DELETE FROM ${tbl} WHERE character_id = ?`).run('evt-test-char'); } catch (e) {} } db.close(); } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}
main();
