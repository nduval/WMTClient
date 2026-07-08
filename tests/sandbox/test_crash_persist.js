/**
 * Crash-resilience persist test (review C2 + local-store project, 2026-06-12).
 *
 * Proves a server CRASH (uncaughtException) — not a clean SIGTERM deploy — no
 * longer loses session state or disconnects players. Before this work an
 * unhandled throw killed the process with no persist at all; recovery fell back
 * to a snapshot up to 30s old, or nothing. The fix: a crash handler that does a
 * SYNCHRONOUS local-SQLite persist (better-sqlite3 works in a dying process
 * where an async HTTPS POST to IONOS cannot be trusted) then exits; systemd
 * restarts; bridge.js still holds every MUD socket; restore resumes them.
 *
 * The test makes the proof unambiguous:
 *   - SNAPSHOT_INTERVAL_MS is set absurdly high so NO periodic snapshot runs —
 *     the only thing that can persist state is the crash handler itself.
 *   - The crash handler writes ONLY locally (no HTTP), so the mock PHP store
 *     stays empty across the crash — recovery is driven entirely by the local
 *     SQLite store, exactly the new primary path.
 *
 *   T1  the induced fault actually crashes the process (exit code 1, not a hang
 *       or clean exit)
 *   T2  the crash did NOT reach the remote store (mock saw no save for our token)
 *   T3  the LOCAL persisted_sessions row exists with our variable + serialized
 *       #delay — i.e. the synchronous crash-time write captured live state
 *   T4  a fresh instance restores FROM THE LOCAL STORE and RESUMES the live
 *       bridge MUD socket (no fresh login) — the crash was a blip, not a boot
 *
 * Runtime-state survival (review F1, 2026-07-07 — the death class via the
 * restart path): server-authored runtime #tickers and #event handlers exist
 * ONLY in wmt-server memory (never in the client set or the DB), so a restart
 * used to silently kill live heal-reset timers ($healing/$eheal stuck → heals
 * gated off, the 2026-07-06 death mechanism reintroduced by every deploy).
 *   T5  a trigger-authored runtime #ticker rides the crash persist
 *       (runtimeTickers + remainingMs in the payload) and FIRES on the
 *       restored instance (variable set server-side, phase preserved)
 *   T6  #event handlers ride the persist: RECEIVED INPUT fires on the restored
 *       instance for a post-restore command (cumulative #math proves it ran
 *       again, not a stale pre-crash value)
 *
 * Run: sudo -n node test_crash_persist.js   (spawns its own bridge+server)
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const SERVER_JS = process.env.SERVER_JS || '/opt/wmt/server.js';
const BRIDGE_JS = '/opt/wmt/bridge.js';
const ADMIN_KEY = 'test-admin-key-12345';
const MUD_HOST = 'localhost';
const MUD_PORT = '4000';
const BRIDGE_PORT = 4170;
const PORT_A = 3995;
const DB_PATH = '/tmp/wmt_crash_persist.db';

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
    // No periodic snapshot may run — the crash handler must be the ONLY writer.
    SNAPSHOT_INTERVAL_MS: '3600000',
    ...extraEnv,
  };
  const child = spawn('node', [SERVER_JS], { env, cwd: '/opt/wmt' });
  child.stdout.on('data', d => { const s = d.toString(); log.push(s); if (process.env.VERBOSE) process.stdout.write(`[${label}] ${s}`); });
  child.stderr.on('data', d => { const s = d.toString(); log.push(s); if (process.env.VERBOSE) process.stderr.write(`[${label} ERR] ${s}`); });
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

const USER = 'crash-test-user';
const CHAR = 'crash-test-char';
async function authAndConnectMud(c, token, autoReconnect = false) {
  c.send('auth', { token, userId: USER, characterId: CHAR, characterName: 'CrashRunner', packetPatch: 0, autoReconnect });
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
  console.log('=== CrashPersist ===');
  require('fs').copyFileSync('/opt/wmt/wmt.db', DB_PATH);

  const A = crypto.randomBytes(32).toString('hex'), Ashort = A.slice(0, 8);
  const bridgeLog = [];
  const blob = () => bridgeLog.join('');

  const mock = await startMock();
  let bridge, srvA, srvB;
  const srvLogA = [], srvLogB = [];

  try {
    bridge = spawnBridge(bridgeLog);
    await sleep(700);
    srvA = spawnServer(PORT_A, mock.port, 'A', srvLogA, { ALLOW_TEST_CRASH: '1' });
    await waitForListening(PORT_A);

    // Connect, log in via the bridge, set live state (a variable + a #delay).
    const cA = await connect(PORT_A);
    await authAndConnectMud(cA, A);
    const gotA = await waitFor(() => new RegExp(`MUD connected:.*\\(${Ashort}\\)`).test(blob()), 9000);
    if (!gotA) { bad('setup: bridge connected under token A', `bridge log:\n${blob()}`); throw new Error('no bridge connect'); }
    cA.send('set_variables', { variables: { teststate: '42', combatflag: 'engaged', evtproof: '0' } });
    await sleep(400);
    cA.send('command', { command: '#delay {testfire} {say resumed} {3600}' });
    await sleep(700);

    // Clear the mock MUD name prompt so server-side RECEIVED INPUT dispatch
    // isn't gated off by _atNamePrompt.
    cA.send('command', { command: 'CrashRunner' });
    await sleep(400);
    cA.send('command', { command: 'password' });
    await sleep(800);

    // Runtime state that must survive the crash (review F1): a trigger body
    // authors a server-memory-only runtime #ticker (8s — must NOT fire before
    // the crash, must fire on the restored instance), and #event handlers.
    cA.send('set_triggers', { triggers: [{ id: 'rt', pattern: '~GORT', matchType: 'tintin', enabled: true,
      actions: [{ type: 'command', command: '#ticker {crashtick} {#var crashtick fired;#unticker crashtick} {8}' }] }] });
    cA.send('set_events', { events: { 'RECEIVED INPUT': [{ body: '#math evtproof $evtproof+1' }] } });
    await sleep(500);
    cA.send('command', { command: '__emit GORT' });   // fires trigger → authors runtime ticker; also fires RECEIVED INPUT → evtproof=1
    await sleep(800);

    // --- T1: induce a REAL uncaughtException; process must crash (exit 1). ----
    const exitInfo = new Promise(r => srvA.on('exit', (code, signal) => r({ code, signal })));
    try { cA.ws.close(); } catch (e) {}
    srvA.kill('SIGUSR2');   // ALLOW_TEST_CRASH handler → throw → crash path
    const ended = await Promise.race([exitInfo, sleep(8000).then(() => null)]);
    if (ended && ended.code === 1) ok('T1: induced fault crashed the process (exit code 1)');
    else bad('T1: process crashed with exit 1', `got ${JSON.stringify(ended)} — server tail:\n${srvLogA.join('').slice(-600)}`);

    await sleep(300);

    // --- T2: the crash did NOT reach the remote store (local-only persist). ---
    const remoteSaves = mock.state.saves.flat().filter(s => s.userId === USER);
    if (remoteSaves.length === 0) ok('T2: crash persist did not touch the remote store (local-only)');
    else bad('T2: no remote save on crash', `mock saw ${remoteSaves.length} save(s) for our user`);

    // --- T3: the LOCAL row exists with our variable + serialized delay. -------
    let row = null;
    try {
      const db = new Database(DB_PATH, { readonly: true });
      row = db.prepare('SELECT payload FROM persisted_sessions WHERE token = ?').get(A);
      db.close();
    } catch (e) { bad('T3: read local persisted_sessions', e.message); }
    let payload = null;
    try { payload = row ? JSON.parse(row.payload) : null; } catch (e) {}
    if (payload && payload.variables && payload.variables.teststate === '42' && payload.variables.combatflag === 'engaged') {
      ok('T3: crash-time local persist captured live variables');
    } else {
      bad('T3: local persist captured variables', `payload=${row ? JSON.stringify(payload && payload.variables) : 'NO ROW'}`);
    }
    const d = payload && (payload.delays || []).find(x => x.name === 'testfire');
    if (d && /say resumed/.test(d.command) && d.remainingMs > 0) ok('T3: crash-time local persist serialized the #delay');
    else bad('T3: local persist serialized #delay', `got ${JSON.stringify(payload && payload.delays)}`);
    const rt = payload && (payload.runtimeTickers || []).find(t => (t.id || t.name) === 'crashtick');
    if (rt && /#var crashtick fired/.test(rt.command) && rt.remainingMs > 0 && rt.remainingMs <= 8000)
      ok('T5a: crash-time persist carried the runtime #ticker with remaining phase');
    else bad('T5a: runtime ticker in persist payload', `got ${JSON.stringify(payload && payload.runtimeTickers)}`);
    if (payload && payload.events && Array.isArray(payload.events['RECEIVED INPUT']))
      ok('T6a: crash-time persist carried #event handlers');
    else bad('T6a: events in persist payload', `got ${JSON.stringify(payload && payload.events)}`);

    // --- T4: a fresh instance restores FROM LOCAL and resumes the live socket.
    // Mock store is empty (T2), so a resume here can only have come from local.
    const beforeLen = blob().length;
    srvB = spawnServer(PORT_A, mock.port, 'B', srvLogB);
    await waitForListening(PORT_A);
    const resumedA = await waitFor(() => new RegExp(`Resume \\(${Ashort}\\)`).test(blob().slice(beforeLen)), 9000);
    const srvB_text = srvLogB.join('');
    const restoredFromStore = /RESTORE_BRIDGE_RESUME/.test(srvB_text) && /RESTORE_START/.test(srvB_text);
    if (resumedA && restoredFromStore) ok('T4: fresh instance restored from LOCAL store and resumed the live bridge socket');
    else bad('T4: restore-from-local + bridge resume', `bridgeResume=${resumedA} restoreLogs=${restoredFromStore}\nsrvB tail:\n${srvB_text.slice(-700)}`);

    // --- T5/T6: runtime tickers + events survived the restart and RUN. -------
    // The runtime ticker had ~6-7s of phase left at crash time; give the
    // restored instance time to fire it (it executes headless — no browser).
    await sleep(8500);
    const cB = await connect(PORT_A);
    cB.send('auth', { token: A, userId: USER, characterId: CHAR, characterName: 'CrashRunner', packetPatch: 0, autoReconnect: true });
    const gotResume = await waitFor(() => cB.msgs.some(m => m.type === 'session_resumed'), 6000);
    const sr = cB.msgs.find(m => m.type === 'session_resumed');
    const vars = (sr && sr.variables) || {};
    if (gotResume && String(vars.crashtick) === 'fired')
      ok('T5: runtime #ticker survived the crash-restart and fired server-side');
    else bad('T5: runtime ticker fired after restore', `resume=${gotResume} vars=${JSON.stringify({ crashtick: vars.crashtick, evtproof: vars.evtproof })}`);

    // Events: a post-restore command must fire RECEIVED INPUT on the restored
    // instance — cumulative #math (0→1 pre-crash, →2 now) proves a fresh run.
    cB.send('command', { command: 'look' });
    const gotEvt = await waitFor(() => cB.msgs.some(m =>
      m.type === 'var_update' && m.variables && String(m.variables.evtproof) === '2'), 5000);
    if (gotEvt) ok('T6: #event handlers survived the crash-restart (RECEIVED INPUT fired post-restore)');
    else bad('T6: RECEIVED INPUT after restore', `evtproof updates=${JSON.stringify(cB.msgs.filter(m => m.type === 'var_update' && m.variables && 'evtproof' in m.variables).map(m => m.variables.evtproof))} resumeVars=${JSON.stringify(vars.evtproof)}`);
    try { cB.ws.close(); } catch (e) {}

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
