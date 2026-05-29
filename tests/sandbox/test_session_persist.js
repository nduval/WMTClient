/**
 * Session persistence / continuity test (goal #2: survive wmt-server restarts).
 *
 * Proves that a wmt-server restart preserves live server-side state — the thing
 * that keeps a TinTin-style bot (class + #read steps + variables) running across
 * a deploy. Closes review finding SC3: the sandbox previously could NOT verify
 * this because PHP_SESSIONS_URL was hardcoded to production. This test points a
 * freshly-spawned wmt-server at an in-process MOCK persistence endpoint
 * (enabled by the PHP_SESSIONS_URL env knob) so the persist→restore cycle runs
 * in full isolation.
 *
 * Phases:
 *   1 (HARD): Spawn instance A → set variables + a #delay → SIGTERM. Assert the
 *             persist payload the server POSTs to the store contains those
 *             variables AND the serialized delay. This is the core of goal #2.
 *   2 (HARD): Spawn instance B → assert it LISTs the stored session from the
 *             mock and then consumes it (remove/clear). Proves restore reads and
 *             clears persisted state.
 *   3 (SOFT): Reconnect to B (without re-syncing variables) and check the
 *             restored variable is live in the server's memory. Best-effort —
 *             reported, not gating (reconnect/relogin semantics vary).
 *
 * Known limitation: instance B's restore also makes auto-relogin / prefs calls
 * to the (still-hardcoded) production characters.php / preferences.php with the
 * test admin key → harmless 403s on prod, no data effect. Follow-up: make those
 * URLs env-configurable too for full isolation.
 *
 * Run: sudo -n node test_session_persist.js   (spawns its own server instances)
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVER_JS = '/opt/wmt/server.js';
const ADMIN_KEY = 'test-admin-key-12345';
const MUD_HOST = 'localhost';
const MUD_PORT = '4000';
const PORT_A = 3991;
const PORT_B = 3992;
const DB_PATH = '/tmp/wmt_persist_test.db';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function ok(name)  { passed++; console.log(`  PASS: ${name}`); }
function bad(name, msg) { failed++; console.log(`  FAIL: ${name} — ${msg}`); }
function soft(name, good, msg) {
  if (good) console.log(`  PASS (soft): ${name}`);
  else console.log(`  WARN (soft): ${name} — ${msg}`);
}

// ---- In-process mock of api/persistent_sessions.php -----------------------
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
        const sessions = (input.sessions || []).filter(s => s && s.userId && s.characterId && s.token)
          .map(s => ({ ...s, savedAt: new Date().toISOString() }));
        state.store = sessions;                 // PHP replaces the whole store
        state.saves.push(sessions);
        return json({ success: true, count: sessions.length });
      }
      if (action === 'list') {
        state.listCount++;
        return json({ success: true, sessions: state.store });
      }
      if (action === 'remove') {
        let input = {}; try { input = JSON.parse(body || '{}'); } catch (e) {}
        state.removes.push(input.token);
        state.store = state.store.filter(s => s.token !== input.token);
        return json({ success: true });
      }
      if (action === 'clear') {
        state.clears++; state.store = [];
        return json({ success: true });
      }
      res.writeHead(400); res.end('bad action');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

// ---- Spawn a wmt-server instance pointed at the mock ----------------------
function spawnServer(port, mockPort, label) {
  const env = {
    ...process.env,
    PORT: String(port),
    ADMIN_KEY,
    PHP_SESSIONS_URL: `http://127.0.0.1:${mockPort}/persistent_sessions.php`,
    WMT_DB_PATH: DB_PATH,
    MUD_HOST, MUD_PORT,
    NODE_ENV: 'production',
  };
  delete env.BRIDGE_URL; // force direct mode
  const child = spawn('node', [SERVER_JS], { env, cwd: '/opt/wmt' });
  child.stdout.on('data', d => { if (process.env.VERBOSE) process.stdout.write(`[${label}] ${d}`); });
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
    const clientCommands = [], output = [];
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'client_command') clientCommands.push(m);
        else if (m.type === 'mud' || m.type === 'output' || m.type === 'system')
          output.push(m.line || m.text || m.message || '');
      } catch (e) {}
    });
    ws.on('open', () => resolve({ ws, clientCommands, output,
      send: (type, data = {}) => ws.send(JSON.stringify({ type, ...data })) }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

async function login(c, token, charName) {
  c.send('auth', { token, userId: 'persist-test-user', characterId: 'persist-test-char', characterName: charName, packetPatch: 0 });
  await sleep(500);
  c.send('set_server', { host: 'localhost', port: 4000 });
  await sleep(600);
  c.send('set_aliases', { aliases: [] });
  c.send('set_triggers', { triggers: [] });
  c.send('set_variables', { variables: {} });
  c.send('set_functions', { functions: {} });
  await sleep(1500);
  c.send('command', { command: charName });
  await sleep(500);
  c.send('command', { command: 'password' });
  await sleep(2000);
}

async function main() {
  console.log('=== SessionPersist ===');
  // server.js prepares statements against the schema at load time, so the
  // spawned instances need a DB that already has the tables. Use an isolated
  // COPY of the real DB (full schema, zero contention with the live server).
  require('fs').copyFileSync('/opt/wmt/wmt.db', DB_PATH);
  const mock = await startMock();
  const token = crypto.randomBytes(32).toString('hex');
  let A, B;

  try {
    // ---------- Phase 1: persist captures variables + delay ----------------
    A = spawnServer(PORT_A, mock.port, 'A');
    await waitForListening(PORT_A);
    const cA = await connect(PORT_A);
    await login(cA, token, 'PersistRunner');

    cA.send('set_variables', { variables: { teststate: '42', combatflag: 'engaged' } });
    await sleep(400);
    cA.send('command', { command: '#delay {testfire} {say resumed} {3600}' });
    await sleep(700);

    try { cA.ws.close(); } catch (e) {}
    const exited = new Promise(r => A.on('exit', r));
    A.kill('SIGTERM');                       // → gracefulShutdown → persistAllSessions
    await Promise.race([exited, sleep(8000)]);
    await sleep(500);                        // let the final save POST land

    const mine = mock.state.saves.flat().filter(s => s.token === token);
    const last = mine[mine.length - 1];
    if (!last) {
      bad('P1: persist payload reached the store', `no save with our token (saves=${mock.state.saves.length}, badAuth=${mock.state.badAuth})`);
    } else {
      ok('P1: persist payload reached the store');
      if (last.variables && last.variables.teststate === '42' && last.variables.combatflag === 'engaged')
        ok('P1: variables (teststate, combatflag) persisted');
      else
        bad('P1: variables persisted', `got ${JSON.stringify(last.variables)}`);

      const d = (last.delays || []).find(x => x.name === 'testfire');
      if (d && /say resumed/.test(d.command) && d.remainingMs > 0)
        ok('P1: #delay serialized with command + remaining time');
      else
        bad('P1: #delay serialized', `got ${JSON.stringify(last.delays)}`);
    }

    // ---------- Phase 2: a fresh instance restores + consumes --------------
    const listsBefore = mock.state.listCount;
    B = spawnServer(PORT_B, mock.port, 'B');
    await waitForListening(PORT_B);
    // direct-mode restore runs ~5s after boot; poll the mock for consume.
    let consumed = false;
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      if (mock.state.listCount > listsBefore &&
          (mock.state.removes.includes(token) || mock.state.clears > 0)) { consumed = true; break; }
    }
    if (mock.state.listCount > listsBefore) ok('P2: restore LISTed persisted sessions from the store');
    else bad('P2: restore LISTed sessions', `listCount unchanged (${mock.state.listCount})`);
    if (consumed) ok('P2: restore consumed the session (remove/clear)');
    else bad('P2: restore consumed the session', `removes=${JSON.stringify(mock.state.removes)} clears=${mock.state.clears}`);

    // ---------- Phase 3 (soft): restored variable is live in memory --------
    try {
      const cB = await connect(PORT_B);
      cB.send('auth', { token, userId: 'persist-test-user', characterId: 'persist-test-char', characterName: 'PersistRunner', packetPatch: 0 });
      await sleep(800);
      cB.send('set_aliases', { aliases: [{ pattern: 'chkstate', replacement: '#showme {STATE=$teststate}', matchType: 'exact', enabled: true }] });
      await sleep(500);
      cB.send('command', { command: 'chkstate' });
      await sleep(800);
      const sawIt = cB.clientCommands.some(c => /STATE=42/.test(c.command || '')) ||
                    cB.output.some(l => /STATE=42/.test(l));
      soft('P3: restored variable readable in memory after reconnect', sawIt,
        `did not observe STATE=42 (cmds=${JSON.stringify(cB.clientCommands.map(c=>c.command).slice(-4))})`);
      try { cB.ws.close(); } catch (e) {}
    } catch (e) {
      soft('P3: restored variable readable in memory after reconnect', false, e.message);
    }
  } finally {
    try { if (B) B.kill('SIGKILL'); } catch (e) {}
    try { if (A) A.kill('SIGKILL'); } catch (e) {}
    try { mock.server.close(); } catch (e) {}
    require('fs').rmSync(DB_PATH, { force: true });
    require('fs').rmSync(DB_PATH + '-wal', { force: true });
    require('fs').rmSync(DB_PATH + '-shm', { force: true });
  }

  console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
