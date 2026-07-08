/**
 * Incremental variable sync — server side (review F2 / Phase 3 step 1).
 *
 * The legacy protocol pushed the client's ENTIRE variable store (set_variables
 * full replace): any server-authored variable older than the 2s merge window
 * was overwritten, and keys absent from the client store were DELETED — the
 * divergence class behind the 2026-07-06 death. New clients send `var_ops
 * {set, del}` for exactly the keys they wrote.
 *
 *   T1: var_ops set reaches the server store (a server-side #math substitutes it)
 *   T2: a server-authored variable >2s old SURVIVES a var_ops touching another
 *       key (the F2 fix) — and the same state is CLOBBERED by a legacy
 *       set_variables full push (documents the old behavior both run: the
 *       contrast IS the fix)
 *   T3: var_ops del removes a key
 *
 * Run: node test_var_ops.js   (ignores any ws:// arg the gate passes)
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const Database = require('/opt/wmt/node_modules/better-sqlite3');

const WS_URL = process.argv[2] || 'ws://localhost:3000';
const DB_PATH = '/opt/wmt/wmt.db';
let ws;
const token = crypto.randomBytes(32).toString('hex');
let varUpdates = [];
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS: ' + n); };
const bad = (n, m) => { fail++; console.log('  FAIL: ' + n + (m ? ' — ' + m : '')); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const send = (type, data = {}) => ws.send(JSON.stringify({ type, ...data }));
function latest(name) {
  let v;
  for (const u of varUpdates) { if (u && Object.prototype.hasOwnProperty.call(u, name)) v = u[name]; }
  return v;
}

async function main() {
  console.log('=== VarOps ===');
  try {
    ws = new WebSocket(WS_URL);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('connect timeout')), 5000); });
    ws.on('message', raw => {
      try { const m = JSON.parse(raw.toString()); if (m.type === 'var_update' && m.variables) varUpdates.push(m.variables); } catch (e) {}
    });

    send('auth', { token, userId: 'vop-test', characterId: 'vop-test-char', characterName: 'VopRunner', packetPatch: 0 });
    await sleep(500);
    send('set_server', { host: 'localhost', port: 4000 });
    await sleep(500);
    send('set_aliases', { aliases: [] });
    send('set_variables', { variables: {} });
    send('set_functions', { functions: {} });
    await sleep(1500);
    send('command', { command: 'VopRunner' });
    await sleep(400);
    send('command', { command: 'password' });
    await sleep(1200);

    // T1: var_ops set reaches the server store.
    varUpdates = [];
    send('var_ops', { set: { vx: '5' }, del: [] });
    await sleep(300);
    send('command', { command: '#math vy $vx+1' });
    await sleep(600);
    if (String(latest('vy')) === '6') ok('T1: var_ops set applied server-side ($vx=5 → vy=6)');
    else bad('T1: var_ops set', `vy=${JSON.stringify(latest('vy'))}`);

    // T2: server-authored var >2s old survives var_ops (and is clobbered by legacy).
    // Author sv=7 server-side via a trigger body, then age it past the 2s window.
    send('set_triggers', { triggers: [{ id: 'sv', pattern: '~GOSV', matchType: 'tintin', enabled: true,
      actions: [{ type: 'command', command: '#var sv 7' }] }] });
    await sleep(400);
    send('command', { command: '__emit GOSV' });
    await sleep(2600);                                   // age past the legacy 2s window
    send('var_ops', { set: { unrelated: '1' }, del: [] });
    await sleep(300);
    varUpdates = [];
    send('command', { command: '#var {probe1} {$sv}' });
    await sleep(600);
    const survived = String(latest('probe1')) === '7';
    // Legacy full push (what a stale cached client sends): sv absent → deleted.
    send('set_variables', { variables: { unrelated: '1' } });
    await sleep(300);
    varUpdates = [];
    send('command', { command: '#var {probe2} {$sv}' });
    await sleep(600);
    const clobbered = String(latest('probe2')) !== '7';
    if (survived && clobbered)
      ok('T2: server var survived var_ops (probe1=7) and was clobbered by a legacy full push — the F2 contrast');
    else bad('T2: var_ops does not clobber', `survived=${survived} (probe1=${JSON.stringify(latest('probe1'))}) legacyClobbered=${clobbered} (probe2=${JSON.stringify(latest('probe2'))})`);

    // T3: var_ops del removes a key — asserting the SET landed first, so this
    // can't false-pass on a server that ignores var_ops entirely.
    send('var_ops', { set: { dying: 'yes' }, del: [] });
    await sleep(300);
    varUpdates = [];
    send('command', { command: '#var {probe3a} {$dying}' });
    await sleep(600);
    const setLanded = String(latest('probe3a')) === 'yes';
    send('var_ops', { del: ['dying'] });
    await sleep(300);
    varUpdates = [];
    send('command', { command: '#var {probe3b} {$dying}' });
    await sleep(600);
    if (setLanded && String(latest('probe3b')) !== 'yes') ok('T3: var_ops set landed then del removed the key');
    else bad('T3: var_ops del', `setLanded=${setLanded} probe3b=${JSON.stringify(latest('probe3b'))}`);

  } catch (e) {
    bad('harness', e.message);
  } finally {
    try { const db = new Database(DB_PATH); for (const tbl of ['triggers', 'aliases', 'tickers', 'entity_guard']) { try { db.prepare(`DELETE FROM ${tbl} WHERE character_id = ?`).run('vop-test-char'); } catch (e) {} } db.close(); } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}
main();
