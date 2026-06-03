/**
 * Bridge orphan-reaper test (#3, G4 — see docs/connection-issues/005).
 *
 * Spawns the real bridge.js with a short reap grace and speaks the bridge protocol
 * directly (acting as server.js) to prove:
 *   T1  a socket no server re-claims within the grace IS reaped (resume → error)
 *   T2  a socket still claimed by a live server is NOT reaped (resume → connected)
 *   T3  during a FULL server outage (no server connected) nothing is reaped — the
 *       bridge preserves the socket and the server re-claims it on reconnect
 *   T4  the reap is logged
 *
 * The MUD endpoint is the sandbox mock-mud on :4000 (already running).
 *
 * Run: sudo -n node test_bridge_orphan_reaper.js   (spawns its own bridge.js)
 */
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const BRIDGE_JS = '/opt/wmt/bridge.js';
const BRIDGE_PORT = 4160;
const GRACE_MS = 1500;
const CHECK_MS = 400;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS: ' + n); };
const bad = (n, m) => { fail++; console.log('  FAIL: ' + n + (m ? ' — ' + m : '')); };

function spawnBridge(log) {
  const env = { ...process.env, BRIDGE_PORT: String(BRIDGE_PORT), BRIDGE_REAP_MS: String(GRACE_MS), BRIDGE_REAP_CHECK_MS: String(CHECK_MS) };
  const child = spawn('node', [BRIDGE_JS], { env, cwd: '/opt/wmt' });
  child.stdout.on('data', d => { const s = d.toString(); log.push(s); if (process.env.VERBOSE) process.stdout.write('[bridge] ' + s); });
  child.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write('[bridge ERR] ' + d); });
  return child;
}

// A fake server.js connection to the bridge.
function mkServer() {
  const msgs = [];
  const ws = new WebSocket(`ws://localhost:${BRIDGE_PORT}`);
  ws.on('message', raw => { try { msgs.push(JSON.parse(raw.toString())); } catch (e) {} });
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('bridge connect timeout')), 4000); });
  return {
    ws, msgs, ready,
    send: (o) => ws.send(JSON.stringify(o)),
    close: () => { try { ws.close(); } catch (e) {} },
  };
}

// Send resume {token} and report whether the socket is alive ('connected') or gone ('error').
async function probeResume(sv, token) {
  const before = sv.msgs.length;
  sv.send({ type: 'resume', token });
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const m = sv.msgs.slice(before).find(x => x.token === token && (x.type === 'connected' || x.type === 'error'));
    if (m) return m.type === 'connected' ? 'alive' : 'reaped';
    await sleep(100);
  }
  return 'timeout';
}

async function waitConnected(sv, token) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (sv.msgs.find(m => m.type === 'connected' && m.token === token)) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  console.log('=== BridgeOrphanReaper ===');
  const T1 = crypto.randomBytes(16).toString('hex');
  const T2 = crypto.randomBytes(16).toString('hex');
  const T3 = crypto.randomBytes(16).toString('hex');
  const bridgeLog = [];
  const blob = () => bridgeLog.join('');
  let bridge, sw1, sw2, sw3, sw4;

  try {
    bridge = spawnBridge(bridgeLog);
    await sleep(700);

    // --- T1: orphaned socket (no server re-claims it) gets reaped ------------
    sw1 = mkServer(); await sw1.ready;
    sw1.send({ type: 'init', token: T1, host: 'localhost', port: 4000 });
    if (!await waitConnected(sw1, T1)) return bad('setup: T1 connected'), finish();
    sw2 = mkServer(); await sw2.ready;          // a server stays connected (so reaper is allowed to run)
    sw1.close();                                 // T1 now detached; wss.clients still has sw2
    await sleep(GRACE_MS + CHECK_MS * 3 + 600);  // wait past the grace
    const r1 = await probeResume(sw2, T1);
    if (r1 === 'reaped') ok('T1: orphan socket (no server re-claim) was reaped');
    else bad('T1: orphan reaped', `resume said "${r1}"`);

    // --- T2: a socket still claimed by a live server is NOT reaped -----------
    sw2.send({ type: 'init', token: T2, host: 'localhost', port: 4000 });
    if (!await waitConnected(sw2, T2)) bad('setup: T2 connected');
    await sleep(GRACE_MS + CHECK_MS * 3 + 600);  // wait past the grace; sw2 stays open
    const r2 = await probeResume(sw2, T2);
    if (r2 === 'alive') ok('T2: socket claimed by a live server is NOT reaped');
    else bad('T2: claimed socket preserved', `resume said "${r2}"`);

    // --- T3: during a FULL server outage nothing is reaped ------------------
    sw3 = mkServer(); await sw3.ready;
    sw3.send({ type: 'init', token: T3, host: 'localhost', port: 4000 });
    if (!await waitConnected(sw3, T3)) bad('setup: T3 connected');
    sw2.close(); sw3.close();                    // ALL servers gone → wss.clients.size === 0
    await sleep(GRACE_MS + CHECK_MS * 3 + 600);  // longer than grace, but server is DOWN → must NOT reap
    sw4 = mkServer(); await sw4.ready;           // server returns
    const r3 = await probeResume(sw4, T3);       // re-claim immediately, as the real server does
    if (r3 === 'alive') ok('T3: socket preserved across a full server outage (not reaped)');
    else bad('T3: outage preserves socket', `resume said "${r3}"`);

    // --- T4: the reap was logged -------------------------------------------
    if (new RegExp(`Reaping orphan \\(${T1.slice(0, 8)}\\)`).test(blob())) ok('T4: reap logged for the orphan');
    else bad('T4: reap logged', `no "Reaping orphan (${T1.slice(0,8)})" in bridge log`);
    // and NOT for the claimed/preserved ones
    if (!new RegExp(`Reaping orphan \\(${T2.slice(0,8)}\\)`).test(blob()) &&
        !new RegExp(`Reaping orphan \\(${T3.slice(0,8)}\\)`).test(blob()))
      ok('T4: claimed/outage sockets were NOT reaped');
    else bad('T4: no false reaps', 'a claimed/preserved socket was reaped');

  } finally {
    finish();
  }

  function finish() {
    for (const s of [sw1, sw2, sw3, sw4]) { try { if (s) s.close(); } catch (e) {} }
    try { if (bridge) bridge.kill('SIGKILL'); } catch (e) {}
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
