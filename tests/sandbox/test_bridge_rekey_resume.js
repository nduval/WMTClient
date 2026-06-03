/**
 * Bridge-mode rekey -> reconnect -> resume test (the 2026-06-02 deploy-lockout fix).
 *
 * This is the FIRST sandbox test that runs wmt-server in BRIDGE MODE (the prod
 * topology). The normal sandbox suite runs direct-mode, so it never exercised the
 * BridgeSocket keying that caused elminster's lockout. See
 * docs/connection-issues/005-resilience-identity-model-and-lockout.md.
 *
 * Topology spun up in-isolation on the sandbox:
 *   fake persistent-sessions store (in-process http)  <- PHP_SESSIONS_URL
 *   bridge.js on BRIDGE_PORT                           <- holds the MUD TCP
 *   wmt-server (BRIDGE_URL set) on PORT_A              <- the code under test
 *   mock-mud on :4000                                  <- already running on sandbox
 *
 * THE INVARIANT UNDER TEST: the bridge MUD socket is keyed by a STABLE
 * bridgeToken, never the mutable session token. So:
 *   T1  initial connect keys the bridge socket by token A
 *   T2  after a rekey to token B, a forced reconnect does NOT create a bridge
 *       connection under B  (the bug: connectToMud used session.token)
 *   T3  ...it reattaches/replaces under A instead (one identity, no orphan)
 *   T4  the persisted payload carries token=B (current) but bridgeToken=A (stable)
 *   T5  a server RESTART restores by bridgeToken A and resumes the live socket
 *       (no fresh login, no connection under B)
 *
 * With the OLD code, T2 finds a "(Bshort)" MUD connect and T4/T5 carry/resume B
 * -> exactly the duplicate-login eviction/lockout.
 *
 * Run: sudo -n node test_bridge_rekey_resume.js   (spawns its own bridge+server)
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVER_JS = process.env.SERVER_JS || '/opt/wmt/server.js';  // override for negative-control runs
const BRIDGE_JS = '/opt/wmt/bridge.js';
const ADMIN_KEY = 'test-admin-key-12345';
const MUD_HOST = 'localhost';
const MUD_PORT = '4000';
const BRIDGE_PORT = 4150;
const PORT_A = 3993;
const DB_PATH = '/tmp/wmt_bridge_test.db';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function ok(name) { passed++; console.log(`  PASS: ${name}`); }
function bad(name, msg) { failed++; console.log(`  FAIL: ${name} — ${msg}`); }

// Poll a predicate against the captured log until true or timeout.
async function waitFor(pred, timeoutMs = 8000, step = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(step);
  }
  return false;
}

// ---- In-process mock of api/persistent_sessions.php (same contract as prod) --
function startMock() {
  const state = { store: [], saves: [], listCount: 0, removes: [], clears: 0, badAuth: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const action = u.searchParams.get('action');
    if ((req.headers['x-admin-key'] || '') !== ADMIN_KEY) {
      state.badAuth++;
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (action === 'save') {
        let input = {}; try { input = JSON.parse(body || '{}'); } catch (e) {}
        const sessions = (input.sessions || []).filter(s => s && s.userId && s.characterId && s.token);
        state.store = sessions;            // PHP replaces the whole store
        state.saves.push(sessions);
        return json({ success: true, count: sessions.length });
      }
      if (action === 'list') { state.listCount++; return json({ success: true, sessions: state.store }); }
      if (action === 'remove') {
        let input = {}; try { input = JSON.parse(body || '{}'); } catch (e) {}
        state.removes.push(input.token);
        state.store = state.store.filter(s => s.token !== input.token);
        return json({ success: true });
      }
      if (action === 'clear') { state.clears++; state.store = []; return json({ success: true }); }
      res.writeHead(400); res.end('bad action');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

function spawnBridge(log) {
  const env = { ...process.env, BRIDGE_PORT: String(BRIDGE_PORT) };
  const child = spawn('node', [BRIDGE_JS], { env, cwd: '/opt/wmt' });
  child.stdout.on('data', d => { const s = d.toString(); log.push(s); if (process.env.VERBOSE) process.stdout.write(`[bridge] ${s}`); });
  child.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(`[bridge ERR] ${d}`); });
  return child;
}

function spawnServer(port, mockPort, label, log) {
  const env = {
    ...process.env,
    PORT: String(port),
    ADMIN_KEY,
    PHP_SESSIONS_URL: `http://127.0.0.1:${mockPort}/persistent_sessions.php`,
    WMT_DB_PATH: DB_PATH,
    MUD_HOST, MUD_PORT,
    BRIDGE_URL: `ws://localhost:${BRIDGE_PORT}`,   // <- bridge mode (prod topology)
    NODE_ENV: 'production',
  };
  const child = spawn('node', [SERVER_JS], { env, cwd: '/opt/wmt' });
  child.stdout.on('data', d => { const s = d.toString(); log.push(s); if (process.env.VERBOSE) process.stdout.write(`[${label}] ${s}`); });
  child.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(`[${label} ERR] ${d}`); });
  return child;
}

function waitForListening(port, timeoutMs = 12000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function probe() {
      const ws = new WebSocket(`ws://localhost:${port}`);
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error(`port ${port} never came up`));
        setTimeout(probe, 300);
      });
    })();
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    const msgs = [];
    ws.on('message', raw => { try { msgs.push(JSON.parse(raw.toString())); } catch (e) {} });
    ws.on('open', () => resolve({ ws, msgs, send: (type, data = {}) => ws.send(JSON.stringify({ type, ...data })) }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

const USER = 'bridge-test-user';
const CHAR = 'bridge-test-char';
async function authAndConnectMud(c, token) {
  c.send('auth', { token, userId: USER, characterId: CHAR, characterName: 'BridgeRunner', packetPatch: 0 });
  await sleep(600);
  c.send('set_server', { host: 'localhost', port: 4000 });
  await sleep(400);
  c.send('set_aliases', { aliases: [] });
  c.send('set_triggers', { triggers: [] });   // triggers connectToMud in bridge mode
  c.send('set_variables', { variables: {} });
  c.send('set_functions', { functions: {} });
  await sleep(1500);
}

async function main() {
  console.log('=== BridgeRekeyResume ===');
  require('fs').copyFileSync('/opt/wmt/wmt.db', DB_PATH);   // full schema, isolated

  const A = crypto.randomBytes(32).toString('hex'), Ashort = A.slice(0, 8);
  const B = crypto.randomBytes(32).toString('hex'), Bshort = B.slice(0, 8);
  const bridgeLog = [];
  const blob = () => bridgeLog.join('');

  const mock = await startMock();
  let bridge, srvA, srvB;
  const srvLog = [];

  try {
    bridge = spawnBridge(bridgeLog);
    await sleep(700);
    srvA = spawnServer(PORT_A, mock.port, 'A', srvLog);
    await waitForListening(PORT_A);

    // --- T1: initial connect keys the bridge socket by token A ---------------
    const cA = await connect(PORT_A);
    await authAndConnectMud(cA, A);
    const gotA = await waitFor(() => new RegExp(`MUD connected:.*\\(${Ashort}\\)`).test(blob()), 9000);
    if (gotA) ok('T1: initial connect keys bridge MUD socket by token A');
    else bad('T1: bridge connected under token A', `bridge log:\n${blob()}`);

    // --- Clean rekey to token B (NO forced reconnect): session.token -> B,
    //     bridgeToken stays A, and the original live A socket is untouched. -----
    const cB = await connect(PORT_A);
    cB.send('auth', { token: B, userId: USER, characterId: CHAR, characterName: 'BridgeRunner', packetPatch: 0 });
    await sleep(1000);

    // --- T4: persist carries token=B (current) but bridgeToken=A (stable) ----
    try { cA.ws.close(); } catch (e) {}
    try { cB.ws.close(); } catch (e) {}
    const exited = new Promise(r => srvA.on('exit', r));
    srvA.kill('SIGTERM');                   // -> gracefulShutdown -> persistAllSessions (socket A still live)
    await Promise.race([exited, sleep(8000)]);
    await sleep(800);

    const saved = mock.state.saves.flat().filter(s => s.userId === USER);
    const last = saved[saved.length - 1];
    if (!last) {
      bad('T4: persist payload reached the store', `no save (saves=${mock.state.saves.length}, badAuth=${mock.state.badAuth})`);
    } else {
      if (last.token === B) ok('T4a: persisted session token is the current (rekeyed) token B');
      else bad('T4a: persisted token is B', `got ${String(last.token).slice(0,8)}`);
      if (last.bridgeToken === A) ok('T4b: persisted bridgeToken is the STABLE original token A');
      else bad('T4b: persisted bridgeToken is A', `got ${String(last.bridgeToken).slice(0,8)} (poisoned to session token = the bug)`);
    }

    // --- T5: restart restores by bridgeToken A and RESUMES (no fresh B) ------
    const bridgeLenBeforeRestart = blob().length;
    srvB = spawnServer(PORT_A, mock.port, 'B', srvLog);
    await waitForListening(PORT_A);
    const resumedA = await waitFor(
      () => new RegExp(`Resume \\(${Ashort}\\)`).test(blob().slice(bridgeLenBeforeRestart)), 12000);
    const tailAfterRestart = blob().slice(bridgeLenBeforeRestart);
    if (resumedA) ok('T5a: after restart, bridge RESUMED the live socket by bridgeToken A');
    else bad('T5a: restart resumed by bridgeToken A', `no "Resume (${Ashort})" after restart. tail:\n${tailAfterRestart}`);
    if (!new RegExp(`\\(${Bshort}\\)`).test(tailAfterRestart))
      ok('T5b: restart did NOT open a fresh MUD login under token B');
    else
      bad('T5b: no fresh login under B on restart', `found (${Bshort}) after restart:\n${tailAfterRestart}`);

    // --- T3: a FORCED reconnect on the restored (rekeyed) session still uses
    //     the stable bridgeToken A, never the session token B. This is the exact
    //     connectToMud() path that caused the lockout. ------------------------
    const cC = await connect(PORT_A);
    cC.send('auth', { token: B, userId: USER, characterId: CHAR, characterName: 'BridgeRunner', packetPatch: 0 });
    await sleep(800);
    const lenBeforeForced = blob().length;
    cC.send('reconnect');                   // -> connectToMud(session): MUST key by bridgeToken A
    await sleep(2500);
    const forcedTail = blob().slice(lenBeforeForced);
    try { cC.ws.close(); } catch (e) {}
    if (new RegExp(`\\(${Ashort}\\)`).test(forcedTail))
      ok('T3: forced connectToMud after rekey operated on the stable token A');
    else
      bad('T3: forced reconnect used token A', `no (${Ashort}) after forced reconnect. tail:\n${forcedTail}`);

    // --- T2 (global invariant): the drifted session token B must NEVER appear
    //     as a bridge MUD connection anywhere across the whole run. -----------
    if (!new RegExp(`\\(${Bshort}\\)`).test(blob()))
      ok('T2: drifted session token B NEVER became a bridge MUD connection (whole run)');
    else
      bad('T2: B never used as a bridge key', `found (${Bshort}) somewhere in bridge log:\n${blob()}`);

  } finally {
    try { if (srvB) srvB.kill('SIGKILL'); } catch (e) {}
    try { if (srvA) srvA.kill('SIGKILL'); } catch (e) {}
    try { if (bridge) bridge.kill('SIGKILL'); } catch (e) {}
    try { mock.server.close(); } catch (e) {}
    for (const ext of ['', '-wal', '-shm']) require('fs').rmSync(DB_PATH + ext, { force: true });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
