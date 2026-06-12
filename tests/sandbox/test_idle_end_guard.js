/**
 * Idle auto-#end guard test (2026-06-07).
 * See memory: bug_serverside_end_idle_active_kick.
 *
 * Regression: a server-side ticker increments $idle, but its RECEIVED-INPUT reset
 * only runs in the browser (and loses to the 2s server-var staleness guard), so the
 * server's $idle never resets while the player types. With server-side #end shipped
 * (2026-06-07), an idle `#if {$idle>N} {#end}` then disconnected an ACTIVE player.
 *
 * Fix: gate the AUTO (ticker/trigger) server-side #end on real input time
 * (session.lastInputAt). This test drives #end via a real server-side TICKER (the
 * true auto path), with AUTO_END_IDLE_GRACE_MS=2500:
 *   T1 the ticker's #end is SUPPRESSED while the player is active (typed < grace ago)
 *      — the session stays alive (SESSION_SERVERSIDE_END_SUPPRESSED logged).
 *   T2 once no input for > grace, the SAME ticker #end FIRES and closes the session
 *      (SESSION_CLOSE reason=serverside #end) — the genuinely-idle / mobile case.
 *
 * Bridge-mode harness (same shape as test_disconnect_detach).
 * Run: sudo -n node test_idle_end_guard.js
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVER_JS = process.env.SERVER_JS || '/opt/wmt/server.js';
const BRIDGE_JS = '/opt/wmt/bridge.js';
const ADMIN_KEY = 'test-admin-key-12345';
const MUD_HOST = 'localhost', MUD_PORT = '4000';
const BRIDGE_PORT = 4175, PORT = 3993;
const DB_PATH = '/tmp/wmt_idleend_test.db';
const GRACE_MS = 2500;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS: ' + n); };
const bad = (n, m) => { fail++; console.log('  FAIL: ' + n + (m ? ' — ' + m : '')); };
async function waitFor(pred, ms = 6000, step = 150) { const s = Date.now(); while (Date.now() - s < ms) { if (pred()) return true; await sleep(step); } return false; }

function startMock() {
  const state = { store: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost'); const action = u.searchParams.get('action');
    if ((req.headers['x-admin-key'] || '') !== ADMIN_KEY) { res.writeHead(403); return res.end('{}'); }
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (action === 'save') { let i = {}; try { i = JSON.parse(body || '{}'); } catch (e) {} state.store = (i.sessions || []); return json({ success: true }); }
      if (action === 'list') return json({ success: true, sessions: state.store });
      if (action === 'remove' || action === 'clear') { state.store = []; return json({ success: true }); }
      res.writeHead(400); res.end('bad');
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, state, port: server.address().port })));
}
function spawnBridge(log) { const c = spawn('node', [BRIDGE_JS], { env: { ...process.env, BRIDGE_PORT: String(BRIDGE_PORT) }, cwd: '/opt/wmt' }); c.stdout.on('data', d => { log.push(d.toString()); if (process.env.VERBOSE) process.stdout.write('[bridge] ' + d); }); return c; }
function spawnServer(mockPort, log) {
  const env = { ...process.env, PORT: String(PORT), ADMIN_KEY, PHP_SESSIONS_URL: `http://127.0.0.1:${mockPort}/persistent_sessions.php`, WMT_DB_PATH: DB_PATH, MUD_HOST, MUD_PORT, BRIDGE_URL: `ws://localhost:${BRIDGE_PORT}`, AUTO_END_IDLE_GRACE_MS: String(GRACE_MS), NODE_ENV: 'production' };
  const c = spawn('node', [SERVER_JS], { env, cwd: '/opt/wmt' });
  c.stdout.on('data', d => { log.push(d.toString()); if (process.env.VERBOSE) process.stdout.write('[srv] ' + d); });
  c.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write('[srv ERR] ' + d); });
  return c;
}
function waitListening(timeout = 12000) { const s = Date.now(); return new Promise((res, rej) => { (function probe() { const ws = new WebSocket(`ws://localhost:${PORT}`); ws.on('open', () => { ws.close(); res(); }); ws.on('error', () => { if (Date.now() - s > timeout) return rej(new Error('no listen')); setTimeout(probe, 300); }); })(); }); }
function connect() { return new Promise((res, rej) => { const ws = new WebSocket(`ws://localhost:${PORT}`); const msgs = []; ws.on('message', r => { try { msgs.push(JSON.parse(r.toString())); } catch (e) {} }); ws.on('open', () => res({ ws, msgs, send: (type, d = {}) => ws.send(JSON.stringify({ type, ...d })) })); ws.on('error', rej); setTimeout(() => rej(new Error('connect timeout')), 5000); }); }

const USER = 'idleend-user', CHAR = 'idleend-char';
async function authMud(c, token) {
  c.send('auth', { token, userId: USER, characterId: CHAR, characterName: 'IdleRunner', packetPatch: 0 });
  await sleep(600); c.send('set_server', { host: 'localhost', port: 4000 });
  await sleep(400); c.send('set_aliases', { aliases: [] }); c.send('set_triggers', { triggers: [] }); c.send('set_variables', { variables: {} }); c.send('set_functions', { functions: {} });
  await sleep(1500);
}

async function main() {
  console.log('=== IdleEndGuard ===');
  require('fs').copyFileSync('/opt/wmt/wmt.db', DB_PATH);
  const mock = await startMock();
  const sl = []; const slob = () => sl.join('');
  const bl = [];
  const A = crypto.randomBytes(32).toString('hex'), Ashort = A.slice(0, 8);
  let bridge, srv, cA;
  try {
    bridge = spawnBridge(bl); await sleep(700);
    srv = spawnServer(mock.port, sl); await waitListening();

    cA = await connect(); await authMud(cA, A);
    if (!await waitFor(() => new RegExp(`MUD connected:.*\\(${Ashort}\\)`).test(bl.join('')), 9000)) return bad('setup: MUD connected'), done();
    // Log into the mock-MUD so __emit echoes cleanly (mirrors test_block_trigger).
    cA.send('command', { command: 'IdleRunner' }); await sleep(700);
    cA.send('command', { command: 'password' }); await sleep(1500);

    // A TRIGGER whose action is #end — the SAME auto path as Nathan's hp.tin idle
    // `#if {$idle>N} {#end}` (trigger commands run through serverProcessInlineCommand,
    // unlike ticker #-commands which forward to the client). A server-side TICKER
    // re-emits the trigger line every 1s WITHOUT stamping user input, so once the
    // grace elapses the trigger #end fires for real.
    cA.send('set_triggers', { triggers: [{ id: 'endtrig', name: 'endtrig', enabled: true, pattern: '~TRIGEND_LINE', actions: [{ type: 'command', command: '#end' }] }] });
    cA.send('set_tickers', { tickers: [{ id: 'emitter', name: 'emitter', enabled: true, command: '__emit TRIGEND_LINE', interval: 1 }] });
    await sleep(300);
    // Final user input → defines t0 (last input) for the grace window.
    cA.send('command', { command: 'look' });
    const slen = slob().length;

    // T1: while active (input < grace ago), the ticker's #end is SUPPRESSED.
    // First tick lands ~1s after registration, well inside the 2.5s grace.
    const suppressed = await waitFor(() => /SESSION_SERVERSIDE_END_SUPPRESSED/.test(slob().slice(slen)), GRACE_MS - 400);
    const closedEarly = /reason=serverside #end/.test(slob().slice(slen));
    if (suppressed && !closedEarly) ok('T1: ticker #end SUPPRESSED while player active (session alive)');
    else bad('T1: suppress while active', `suppressed=${suppressed}, closedEarly=${closedEarly}`);

    // T2: stop typing; once input age exceeds the grace, the SAME ticker #end fires
    // and closes the session (genuinely-idle / mobile-suspend case).
    const fired = await waitFor(() => /reason=serverside #end/.test(slob().slice(slen)), GRACE_MS + 4000);
    const mudEnded = await waitFor(() => new RegExp(`MUD (end|closed) \\(${Ashort}\\)`).test(bl.join('')), 3000);
    if (fired) ok('T2: after grace, ticker #end FIRED and closed the session');
    else bad('T2: fires when idle', 'no SESSION_CLOSE reason=serverside #end after grace');
    if (mudEnded) ok('T2: MUD connection torn down on the idle #end');
    else bad('T2: MUD torn down', 'no bridge MUD end/closed');

  } finally { done(); }

  function done() {
    try { if (cA) cA.ws.close(); } catch (e) {}
    try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
    try { if (bridge) bridge.kill('SIGKILL'); } catch (e) {}
    try { mock.server.close(); } catch (e) {}
    for (const e of ['', '-wal', '-shm']) require('fs').rmSync(DB_PATH + e, { force: true });
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
