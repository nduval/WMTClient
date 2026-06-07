/**
 * Disconnect detach-only + server-side #end test (2026-06-07 redesign).
 * See memory: project_disconnect_detach_redesign.
 *
 * Bridge-mode topology (same harness as test_bridge_rekey_resume): fake session
 * store + bridge.js + wmt-server(BRIDGE_URL) + mock-mud:4000.
 *
 *   T1  two browsers on ONE session; a BARE disconnect from one DETACHES only it —
 *       the MUD connection (and bot) stays alive (no bridge "MUD closed").
 *   T2  an INTENTIONAL disconnect (intentional:true) DOES tear the MUD down.
 *   T3  a server-side #end (e.g. a timer's #if {$idle>N} {#end}, here driven by
 *       sending the command) closes the session SERVER-SIDE — works even if no
 *       client would execute cmdEnd (the mobile-suspend fix).
 *
 * Run: sudo -n node test_disconnect_detach.js
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVER_JS = process.env.SERVER_JS || '/opt/wmt/server.js';
const BRIDGE_JS = '/opt/wmt/bridge.js';
const ADMIN_KEY = 'test-admin-key-12345';
const MUD_HOST = 'localhost', MUD_PORT = '4000';
const BRIDGE_PORT = 4170, PORT = 3994;
const DB_PATH = '/tmp/wmt_detach_test.db';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS: ' + n); };
const bad = (n, m) => { fail++; console.log('  FAIL: ' + n + (m ? ' — ' + m : '')); };
async function waitFor(pred, ms = 6000, step = 200) { const s = Date.now(); while (Date.now() - s < ms) { if (pred()) return true; await sleep(step); } return false; }

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
function spawnBridge(log) {
  const c = spawn('node', [BRIDGE_JS], { env: { ...process.env, BRIDGE_PORT: String(BRIDGE_PORT) }, cwd: '/opt/wmt' });
  c.stdout.on('data', d => { log.push(d.toString()); if (process.env.VERBOSE) process.stdout.write('[bridge] ' + d); });
  return c;
}
function spawnServer(mockPort, log) {
  const env = { ...process.env, PORT: String(PORT), ADMIN_KEY, PHP_SESSIONS_URL: `http://127.0.0.1:${mockPort}/persistent_sessions.php`, WMT_DB_PATH: DB_PATH, MUD_HOST, MUD_PORT, BRIDGE_URL: `ws://localhost:${BRIDGE_PORT}`, NODE_ENV: 'production' };
  const c = spawn('node', [SERVER_JS], { env, cwd: '/opt/wmt' });
  c.stdout.on('data', d => { log.push(d.toString()); if (process.env.VERBOSE) process.stdout.write('[srv] ' + d); });
  c.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write('[srv ERR] ' + d); });
  return c;
}
function waitListening(timeout = 12000) {
  const s = Date.now();
  return new Promise((res, rej) => { (function probe() { const ws = new WebSocket(`ws://localhost:${PORT}`); ws.on('open', () => { ws.close(); res(); }); ws.on('error', () => { if (Date.now() - s > timeout) return rej(new Error('no listen')); setTimeout(probe, 300); }); })(); });
}
function connect() {
  return new Promise((res, rej) => { const ws = new WebSocket(`ws://localhost:${PORT}`); const msgs = []; ws.on('message', r => { try { const m = JSON.parse(r.toString()); msgs.push(m); if (process.env.VERBOSE) console.log('[client recv]', m.type, m.type === 'error' ? JSON.stringify(m) : ''); } catch (e) {} }); ws.on('open', () => res({ ws, msgs, send: (type, d = {}) => { if (process.env.VERBOSE) console.log('[client send]', type); ws.send(JSON.stringify({ type, ...d })); } })); ws.on('error', e => { if (process.env.VERBOSE) console.log('[client err]', e.message); rej(e); }); ws.on('close', (c) => { if (process.env.VERBOSE) console.log('[client close] code=' + c); }); setTimeout(() => rej(new Error('connect timeout')), 5000); });
}
const USER = 'detach-user', CHAR = 'detach-char';
async function authMud(c, token) {
  c.send('auth', { token, userId: USER, characterId: CHAR, characterName: 'DetachRunner', packetPatch: 0 });
  await sleep(600); c.send('set_server', { host: 'localhost', port: 4000 });
  await sleep(400); c.send('set_aliases', { aliases: [] }); c.send('set_triggers', { triggers: [] }); c.send('set_variables', { variables: {} }); c.send('set_functions', { functions: {} });
  await sleep(1500);
}

async function main() {
  console.log('=== DisconnectDetach ===');
  require('fs').copyFileSync('/opt/wmt/wmt.db', DB_PATH);
  const mock = await startMock();
  const bl = [], sl = [];   // bridge log, server log
  const blob = () => bl.join(''), slob = () => sl.join('');
  const A = crypto.randomBytes(32).toString('hex'), Ashort = A.slice(0, 8);  // 64-hex = valid 256-bit token
  const B = crypto.randomBytes(32).toString('hex'), Bshort = B.slice(0, 8);
  let bridge, srv, cA, cB, cC;
  try {
    bridge = spawnBridge(bl); await sleep(700);
    srv = spawnServer(mock.port, sl); await waitListening();

    // --- T1: two clients on ONE session; bare disconnect from B detaches only B ---
    cA = await connect(); await authMud(cA, A);
    if (!await waitFor(() => new RegExp(`MUD connected:.*\\(${Ashort}\\)`).test(blob()), 9000)) return bad('setup: A MUD connected'), done();
    cB = await connect();                         // second device, SAME token A → same session
    cB.send('auth', { token: A, userId: USER, characterId: CHAR, characterName: 'DetachRunner', packetPatch: 0 });
    await sleep(900);
    const lenBefore = blob().length;
    cB.send('disconnect');                         // BARE disconnect (no intentional flag)
    await sleep(2500);
    const tail = blob().slice(lenBefore);
    if (!new RegExp(`MUD (end|closed) \\(${Ashort}\\)`).test(tail)) ok('T1: bare disconnect from 2nd device did NOT close the MUD (detach-only)');
    else bad('T1: detach kept MUD alive', `bridge showed MUD end/closed:\n${tail}`);
    if (/SESSION_DETACH_ONLY/.test(slob())) ok('T1: server logged SESSION_DETACH_ONLY');
    else bad('T1: detach logged', 'no SESSION_DETACH_ONLY in server log');

    // --- T2: intentional disconnect from A DOES close the MUD ---
    const len2 = blob().length;
    cA.send('disconnect', { intentional: true });
    const closed2 = await waitFor(() => new RegExp(`MUD (end|closed) \\(${Ashort}\\)`).test(blob().slice(len2)), 6000);
    if (closed2) ok('T2: intentional disconnect closed the MUD connection');
    else bad('T2: intentional closes MUD', `no MUD end/closed after intentional:\n${blob().slice(len2)}`);

    // --- T3: server-side #end closes the session (mobile-suspend fix) ---
    cC = await connect(); await authMud(cC, B);
    if (!await waitFor(() => new RegExp(`MUD connected:.*\\(${Bshort}\\)`).test(blob()), 9000)) bad('setup: C MUD connected');
    const len3 = blob().length, slen3 = slob().length;
    cC.send('command', { command: '#end' });      // exercise the SERVER-side #end path
    const ended = await waitFor(() => new RegExp(`MUD (end|closed) \\(${Bshort}\\)`).test(blob().slice(len3)), 6000);
    if (ended) ok('T3: server-side #end closed the MUD connection');
    else bad('T3: server-side #end works', `no MUD end/closed after #end:\n${blob().slice(len3)}`);
    if (/SESSION_SERVERSIDE_END/.test(slob().slice(slen3))) ok('T3: server logged SESSION_SERVERSIDE_END');
    else bad('T3: serverside #end logged', 'no SESSION_SERVERSIDE_END');

  } finally { done(); }

  function done() {
    for (const c of [cA, cB, cC]) { try { if (c) c.ws.close(); } catch (e) {} }
    try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
    try { if (bridge) bridge.kill('SIGKILL'); } catch (e) {}
    try { mock.server.close(); } catch (e) {}
    for (const e of ['', '-wal', '-shm']) require('fs').rmSync(DB_PATH + e, { force: true });
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
