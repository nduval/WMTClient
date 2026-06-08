/**
 * Multi-device "tap in" coexistence test (2026-06-07).
 * Two devices (DIFFERENT tokens, same user+character) must COEXIST on one session:
 *   T1  the 2nd device joining does NOT open a 2nd MUD connection (one socket)
 *   T2  BOTH devices receive MUD output simultaneously (broadcast to all clients)
 *   T3  the 2nd device joining does NOT kick the 1st (no session_taken)
 *   T4  BOTH devices can send commands (both reach the MUD)
 *   T5  a bare disconnect from device 2 leaves device 1 still receiving output
 *
 * Bridge-mode harness (bridge.js + wmt-server + fake store + mock-mud:4000).
 * Run: sudo -n node test_multidevice.js
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVER_JS = process.env.SERVER_JS || '/opt/wmt/server.js';
const BRIDGE_JS = '/opt/wmt/bridge.js';
const ADMIN_KEY = 'test-admin-key-12345';
const MUD_HOST = 'localhost', MUD_PORT = '4000';
const BRIDGE_PORT = 4180, PORT = 3995;
const DB_PATH = '/tmp/wmt_multidev_test.db';

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
      return json({ success: true });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}
function spawnBridge(log) { const c = spawn('node', [BRIDGE_JS], { env: { ...process.env, BRIDGE_PORT: String(BRIDGE_PORT) }, cwd: '/opt/wmt' }); c.stdout.on('data', d => { log.push(d.toString()); if (process.env.VERBOSE) process.stdout.write('[bridge] ' + d); }); return c; }
function spawnServer(mockPort) { const env = { ...process.env, PORT: String(PORT), ADMIN_KEY, PHP_SESSIONS_URL: `http://127.0.0.1:${mockPort}/persistent_sessions.php`, WMT_DB_PATH: DB_PATH, MUD_HOST, MUD_PORT, BRIDGE_URL: `ws://localhost:${BRIDGE_PORT}`, NODE_ENV: 'production' }; const c = spawn('node', [SERVER_JS], { env, cwd: '/opt/wmt' }); if (process.env.VERBOSE) { c.stdout.on('data', d => process.stdout.write('[srv] ' + d)); c.stderr.on('data', d => process.stderr.write('[srv ERR] ' + d)); } return c; }
function waitListening(t = 12000) { const s = Date.now(); return new Promise((res, rej) => { (function p() { const ws = new WebSocket(`ws://localhost:${PORT}`); ws.on('open', () => { ws.close(); res(); }); ws.on('error', () => { if (Date.now() - s > t) return rej(new Error('no listen')); setTimeout(p, 300); }); })(); }); }
function connect() { return new Promise((res, rej) => { const ws = new WebSocket(`ws://localhost:${PORT}`); const msgs = []; ws.on('message', r => { try { msgs.push(JSON.parse(r.toString())); } catch (e) {} }); ws.on('open', () => res({ ws, msgs, send: (type, d = {}) => ws.send(JSON.stringify({ type, ...d })) })); ws.on('error', rej); setTimeout(() => rej(new Error('connect timeout')), 5000); }); }

const USER = 'multidev-user', CHAR = 'multidev-char';
function authBase(c, token) { c.send('auth', { token, userId: USER, characterId: CHAR, characterName: 'MultiRunner', packetPatch: 0 }); }
async function authMud(c, token) { authBase(c, token); await sleep(600); c.send('set_server', { host: 'localhost', port: 4000 }); await sleep(400); c.send('set_aliases', { aliases: [] }); c.send('set_triggers', { triggers: [] }); c.send('set_variables', { variables: {} }); c.send('set_functions', { functions: {} }); await sleep(1500); }
const gotText = (c, s) => c.msgs.some(m => JSON.stringify(m).includes(s));

async function main() {
  console.log('=== MultiDevice ===');
  require('fs').copyFileSync('/opt/wmt/wmt.db', DB_PATH);
  const mock = await startMock();
  const bl = []; const blob = () => bl.join('');
  const A = crypto.randomBytes(32).toString('hex'), Ashort = A.slice(0, 8);
  const B = crypto.randomBytes(32).toString('hex'), Bshort = B.slice(0, 8);
  let bridge, srv, cA, cB;
  try {
    bridge = spawnBridge(bl); await sleep(700);
    srv = spawnServer(mock.port); await waitListening();

    // Device 1 (token A) connects + MUD up
    cA = await connect(); await authMud(cA, A);
    if (!await waitFor(() => new RegExp(`MUD connected:.*\\(${Ashort}\\)`).test(blob()), 9000)) return bad('setup: device1 MUD up'), done();
    // Log device1 into the mock-MUD so it's in a stable in-game state (otherwise it
    // sits at the login prompt and __emit output is confounded by login noise).
    cA.send('command', { command: 'MultiRunner' }); await sleep(700);
    cA.send('command', { command: 'password' }); await sleep(1800);
    const mudConnectsBefore = (blob().match(/MUD connected:/g) || []).length;

    // Device 2 (DIFFERENT token B, same user+char) "taps in" — FULL handshake
    // like a real 2nd device (auth + set_server + set_triggers/etc).
    cB = await connect(); await authMud(cB, B);

    // T1: no 2nd MUD connection opened
    const mudConnectsAfter = (blob().match(/MUD connected:/g) || []).length;
    if (mudConnectsAfter === mudConnectsBefore && !new RegExp(`\\(${Bshort}\\)`).test(blob()))
      ok('T1: 2nd device joined WITHOUT opening a 2nd MUD connection');
    else bad('T1: one MUD connection', `connects ${mudConnectsBefore}->${mudConnectsAfter}, B-token in bridge=${new RegExp(`\\(${Bshort}\\)`).test(blob())}`);

    // T3: device 1 was NOT kicked
    if (!cA.msgs.some(m => m.type === 'session_taken')) ok('T3: 1st device was NOT kicked (no session_taken)');
    else bad('T3: no kick', 'device1 got session_taken');

    // T2: MUD output broadcasts to BOTH devices
    const tag1 = 'MDTEST_' + crypto.randomBytes(3).toString('hex');
    const lenA = cA.msgs.length, lenB = cB.msgs.length;
    cA.send('command', { command: `__emit ${tag1}` });
    await waitFor(() => gotText({ msgs: cA.msgs.slice(lenA) }, tag1) && gotText({ msgs: cB.msgs.slice(lenB) }, tag1), 5000);
    const aGot = gotText({ msgs: cA.msgs.slice(lenA) }, tag1), bGot = gotText({ msgs: cB.msgs.slice(lenB) }, tag1);
    if (process.env.VERBOSE) {
      console.log('  [dbg] cA recv after emit:', JSON.stringify(cA.msgs.slice(lenA).map(m => m.type)));
      console.log('  [dbg] cB recv after emit:', JSON.stringify(cB.msgs.slice(lenB).map(m => m.type)));
      console.log('  [dbg] any cA mud/output contains tag?', cA.msgs.slice(lenA).filter(m => /mud|output/.test(m.type)).map(m => JSON.stringify(m).slice(0, 120)));
    }
    if (aGot && bGot) ok('T2: BOTH devices received the MUD output');
    else bad('T2: both receive output', `device1 got=${aGot}, device2 got=${bGot}`);

    // T4: device 2 can also send (its command reaches the MUD → echoed to both)
    const tag2 = 'MDTEST_' + crypto.randomBytes(3).toString('hex');
    const lenA2 = cA.msgs.length, lenB2 = cB.msgs.length;
    cB.send('command', { command: `__emit ${tag2}` });
    await waitFor(() => gotText({ msgs: cA.msgs.slice(lenA2) }, tag2), 5000);
    if (gotText({ msgs: cA.msgs.slice(lenA2) }, tag2) && gotText({ msgs: cB.msgs.slice(lenB2) }, tag2))
      ok('T4: 2nd device can send commands (reached MUD, seen by both)');
    else bad('T4: 2nd device can send', `device1 saw tag2=${gotText({ msgs: cA.msgs.slice(lenA2) }, tag2)}`);

    // T5: bare disconnect from device 2 → device 1 still receives output
    cB.send('disconnect');                // bare → detach device 2 only
    await sleep(1500);
    const tag3 = 'MDTEST_' + crypto.randomBytes(3).toString('hex');
    const lenA3 = cA.msgs.length;
    cA.send('command', { command: `__emit ${tag3}` });
    const stillA = await waitFor(() => gotText({ msgs: cA.msgs.slice(lenA3) }, tag3), 5000);
    if (stillA) ok('T5: after device 2 detaches, device 1 still live (MUD + output intact)');
    else bad('T5: device1 survives device2 detach', 'device1 stopped receiving output');

  } finally { done(); }

  function done() {
    for (const c of [cA, cB]) { try { if (c) c.ws.close(); } catch (e) {} }
    try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
    try { if (bridge) bridge.kill('SIGKILL'); } catch (e) {}
    try { mock.server.close(); } catch (e) {}
    for (const e of ['', '-wal', '-shm']) require('fs').rmSync(DB_PATH + e, { force: true });
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
