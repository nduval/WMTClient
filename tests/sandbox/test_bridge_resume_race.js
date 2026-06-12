/**
 * Bridge-mode RESTORE-vs-RECONNECT race test (the 2026-06-11 elminster deploy-boot).
 *
 * Distinct from test_bridge_rekey_resume.js: that proved Tier A (stable bridgeToken
 * across a rekey). THIS proves the NEXT gap (G2/002 in docs/connection-issues/005,
 * left OPEN by Tier A): after a wmt-server restart, a browser can auth + connect to
 * the MUD BEFORE restorePersistentSessions() runs. With an empty in-memory identity
 * map it creates a FRESH session that fresh-logs-in (bridgeResumed=false), and restore
 * then defers (RESTORE_SKIP_BROWSER) — orphaning the live socket. 5/6 sessions resumed
 * fine on 2026-06-11; elminster (a heavily-rekeyed tab) lost the race and got booted.
 *
 * THE INVARIANT UNDER TEST: a browser reconnecting during the restore window must
 * ADOPT the persisted stable bridgeToken (from the persistent-session store) and
 * RESUME the live bridge socket — never fresh-login under its drifted session token.
 *
 * Setup mirrors the prod topology (mock store + bridge.js + bridge-mode wmt-server +
 * mock-mud:4000). The race is made DETERMINISTIC via BRIDGE_RESTORE_DELAY_MS on the
 * restarted server, so the browser reliably reconnects first.
 *
 *   T1  initial connect keys the bridge MUD socket by bridgeToken A
 *   (clean rekey to session token B; bridgeToken stays A — browser now holds B)
 *   T2  SIGTERM persists token=B (current) + bridgeToken=A (stable)
 *   T3  restart with restore DELAYED; browser reconnects with the drifted token B
 *       BEFORE restore runs -> must RESUME the live socket under bridgeToken A
 *   T4  ...and must NOT open a fresh MUD login under token B
 *   T5  the adopted session carries the persisted actualMudChar (mudLoggedIn), so
 *       the browser gets session_resumed — NOT session_new (which makes the client
 *       type the char name into the running game: "There is no reason to 'mimic'
 *       here.", 2026-06-12 04:33 prod)
 *   T6  ...and the server logs no AUTOLOGIN_RELINK for a live resumed socket
 *
 * OLD code: T3/T4 fail — connectToMud keys by B -> "(Bshort)" fresh login, no resume.
 * PRE-2026-06-12 code: T5/T6 fail — adopt carried only the bridgeToken, dropped
 * actualMudChar -> mudLoggedIn=false -> relink dispatched session_new.
 * Run: sudo -n node test_bridge_resume_race.js   (spawns its own bridge+server)
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
const BRIDGE_PORT = 4160;
const PORT_A = 3994;
const DB_PATH = '/tmp/wmt_resume_race.db';
const RESTORE_DELAY_MS = 5000;   // restart restore is held this long so the browser wins the race

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function ok(name) { passed++; console.log(`  PASS: ${name}`); }
function bad(name, msg) { failed++; console.log(`  FAIL: ${name} — ${msg}`); }

async function waitFor(pred, timeoutMs = 8000, step = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (pred()) return true; await sleep(step); }
  return false;
}

// In-process mock of api/persistent_sessions.php (same contract as prod).
function startMock() {
  const state = { store: [], saves: [], listCount: 0 };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const action = u.searchParams.get('action');
    if ((req.headers['x-admin-key'] || '') !== ADMIN_KEY) {
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
        state.store = sessions;
        state.saves.push(sessions);
        return json({ success: true, count: sessions.length });
      }
      if (action === 'list') { state.listCount++; return json({ success: true, sessions: state.store }); }
      if (action === 'remove') {
        let input = {}; try { input = JSON.parse(body || '{}'); } catch (e) {}
        state.store = state.store.filter(s => s.token !== input.token);
        return json({ success: true });
      }
      if (action === 'clear') { state.store = []; return json({ success: true }); }
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

function spawnServer(port, mockPort, label, log, extraEnv = {}) {
  const env = {
    ...process.env,
    PORT: String(port),
    ADMIN_KEY,
    PHP_SESSIONS_URL: `http://127.0.0.1:${mockPort}/persistent_sessions.php`,
    WMT_DB_PATH: DB_PATH,
    MUD_HOST, MUD_PORT,
    BRIDGE_URL: `ws://localhost:${BRIDGE_PORT}`,
    NODE_ENV: 'production',
    ...extraEnv,
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

const USER = 'race-test-user';
const CHAR = 'race-test-char';
async function authAndConnectMud(c, token, autoReconnect = false) {
  c.send('auth', { token, userId: USER, characterId: CHAR, characterName: 'RaceRunner', packetPatch: 0, autoReconnect });
  await sleep(700);
  c.send('set_server', { host: 'localhost', port: 4000 });
  await sleep(400);
  c.send('set_aliases', { aliases: [] });
  c.send('set_triggers', { triggers: [] });   // triggers connectToMud in bridge mode
  c.send('set_variables', { variables: {} });
  c.send('set_functions', { functions: {} });
  await sleep(1500);
}

async function main() {
  console.log('=== BridgeResumeRace ===');
  require('fs').copyFileSync('/opt/wmt/wmt.db', DB_PATH);

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

    // --- T1: initial connect keys the bridge MUD socket by bridgeToken A ------
    const cA = await connect(PORT_A);
    await authAndConnectMud(cA, A);
    const gotA = await waitFor(() => new RegExp(`MUD connected:.*\\(${Ashort}\\)`).test(blob()), 9000);
    if (gotA) ok('T1: initial connect keys bridge MUD socket by bridgeToken A');
    else bad('T1: bridge connected under token A', `bridge log:\n${blob()}`);

    // --- Clean rekey to session token B (bridgeToken stays A) -----------------
    const cB = await connect(PORT_A);
    cB.send('auth', { token: B, userId: USER, characterId: CHAR, characterName: 'RaceRunner', packetPatch: 0 });
    await sleep(1000);

    // --- T2: SIGTERM persists token=B (current) + bridgeToken=A (stable) ------
    try { cA.ws.close(); } catch (e) {}
    try { cB.ws.close(); } catch (e) {}
    const exited = new Promise(r => srvA.on('exit', r));
    srvA.kill('SIGTERM');
    await Promise.race([exited, sleep(8000)]);
    await sleep(800);
    const saved = mock.state.saves.flat().filter(s => s.userId === USER);
    const last = saved[saved.length - 1];
    if (last && last.token === B && last.bridgeToken === A) ok('T2: persisted token=B, bridgeToken=A (the drift the browser will reconnect with)');
    else bad('T2: persisted token=B + bridgeToken=A', `got ${JSON.stringify(last && { t: String(last.token).slice(0,8), b: String(last.bridgeToken).slice(0,8) })}`);

    // --- T3/T4: restart with restore DELAYED; browser reconnects with the
    //     drifted token B BEFORE restore runs -> must resume socket A, not B. ---
    // Pin the prod precondition for T5/T6 deterministically: the char was LOGGED
    // IN when persisted (in prod the name sniffer fills actualMudChar; the mock
    // MUD's login flow may not exercise it). The adopt path must carry this bit.
    for (const s of mock.state.store) { if (s.userId === USER) s.actualMudChar = 'racerunner'; }
    const srvLenBeforeRestart = srvLog.join('').length;
    const lenBeforeRestart = blob().length;
    srvB = spawnServer(PORT_A, mock.port, 'B', srvLog, { BRIDGE_RESTORE_DELAY_MS: String(RESTORE_DELAY_MS) });
    await waitForListening(PORT_A);
    // Reconnect immediately — well inside the restore-delay window (the race).
    // autoReconnect:true mirrors the real browser auto-reconnect after a deploy.
    const cC = await connect(PORT_A);
    await authAndConnectMud(cC, B, true);
    // Assert BEFORE restore would have run (within the delay window).
    const resumedA = await waitFor(
      () => new RegExp(`Resume \\(${Ashort}\\)`).test(blob().slice(lenBeforeRestart)), RESTORE_DELAY_MS - 1000);
    const tail = blob().slice(lenBeforeRestart);

    if (resumedA) ok('T3: reconnect during restore window RESUMED the live socket by bridgeToken A');
    else bad('T3: race reconnect resumed by bridgeToken A', `no "Resume (${Ashort})" before restore. tail:\n${tail}`);

    if (!new RegExp(`\\(${Bshort}\\)`).test(tail)) ok('T4: race reconnect did NOT fresh-login under the drifted token B');
    else bad('T4: no fresh login under B', `found (${Bshort}) after restart (fresh login = the boot):\n${tail}`);

    // --- T5/T6: the resumed-live session must be SILENT — session_resumed to the
    //     browser (no session_new => no client-typed char name), no RELINK event. ---
    // The auth-time `session_new {bridgeMode:true}` is the SILENT init (client
    // types nothing) — only a session_new WITHOUT bridgeMode runs the onConnect
    // auto-login flow that types the char name (server.js ~7310 contract).
    const gotResumedMsg = await waitFor(() => cC.msgs.some(m => m.type === 'session_resumed'), 4000);
    const gotLoginNewMsg = cC.msgs.some(m => m.type === 'session_new' && !m.bridgeMode);
    if (gotResumedMsg && !gotLoginNewMsg) ok('T5: browser got session_resumed, no login-flow session_new (no name typed into the game)');
    else bad('T5: session_resumed without login-flow session_new', `session_resumed=${gotResumedMsg} loginFlowSessionNew=${gotLoginNewMsg}`);

    const srvTail = srvLog.join('').slice(srvLenBeforeRestart);
    if (!srvTail.includes('AUTOLOGIN_RELINK')) ok('T6: no AUTOLOGIN_RELINK for a live resumed socket');
    else bad('T6: no AUTOLOGIN_RELINK', 'relink fired for a socket that was logged in at persist time');
    try { cC.ws.close(); } catch (e) {}

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
