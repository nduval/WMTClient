/**
 * Tier B relink test (2026-06-08) — the mimic deploy-boot fix.
 * See memory: bug_resume_name_prompt_autologin_suppressed, docs/connection-issues/005.
 *
 * Faithful deploy scenario: a session has a live bridge socket; wmt-server restarts;
 * the browser AUTO-reconnects (autoReconnect:true) and the bridge-resumed socket is
 * NOT logged in (the char dropped to a name prompt / never re-resolved). The old SC4
 * code destroyed the socket here → booted the player (mimic). The fix RELINKS because
 * the bridge was holding the socket (bridgeResumed=true).
 *
 * The char is deliberately NOT logged into the mock MUD, so _actualMudChar stays null
 * regardless of the restore-vs-browser race → mudLoggedIn=false deterministically; and
 * the bridge holds the socket across the restart → bridgeResumed=true. That's exactly
 * the SC4 decision point.
 *
 *   T1  server logs AUTOLOGIN_RELINK (not AUTOLOGIN_SUPPRESSED)
 *   T2  the bridge does NOT close the MUD socket (player NOT booted)
 *   T3  the browser receives session_new (the relink prompt)
 *
 * On the OLD server.js all three fail (SUPPRESSED + socket destroyed + no session_new).
 * Run: sudo -n node test_tierb_relink.js
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVER_JS = process.env.SERVER_JS || '/opt/wmt/server.js';
const BRIDGE_JS = '/opt/wmt/bridge.js';
const ADMIN_KEY = 'test-admin-key-12345';
const MUD_HOST = 'localhost', MUD_PORT = '4000';
const BRIDGE_PORT = 4185, PORT = 3991;
const DB_PATH = '/tmp/wmt_tierb_test.db';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS: ' + n); };
const bad = (n, m) => { fail++; console.log('  FAIL: ' + n + (m ? ' — ' + m : '')); };
async function waitFor(pred, ms = 9000, step = 150) { const s = Date.now(); while (Date.now() - s < ms) { if (pred()) return true; await sleep(step); } return false; }

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
function spawnServer(mockPort, log, label) {
  const env = { ...process.env, PORT: String(PORT), ADMIN_KEY, PHP_SESSIONS_URL: `http://127.0.0.1:${mockPort}/persistent_sessions.php`, WMT_DB_PATH: DB_PATH, MUD_HOST, MUD_PORT, BRIDGE_URL: `ws://localhost:${BRIDGE_PORT}`, NODE_ENV: 'production' };
  const c = spawn('node', [SERVER_JS], { env, cwd: '/opt/wmt' });
  c.stdout.on('data', d => { log.push(d.toString()); if (process.env.VERBOSE) process.stdout.write(`[${label}] ` + d); });
  c.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(`[${label} ERR] ` + d); });
  return c;
}
function waitListening(t = 12000) { const s = Date.now(); return new Promise((res, rej) => { (function p() { const ws = new WebSocket(`ws://localhost:${PORT}`); ws.on('open', () => { ws.close(); res(); }); ws.on('error', () => { if (Date.now() - s > t) return rej(new Error('no listen')); setTimeout(p, 250); }); })(); }); }
function connect() { return new Promise((res, rej) => { const ws = new WebSocket(`ws://localhost:${PORT}`); const msgs = []; ws.on('message', r => { try { msgs.push(JSON.parse(r.toString())); } catch (e) {} }); ws.on('open', () => res({ ws, msgs, send: (type, d = {}) => ws.send(JSON.stringify({ type, ...d })) })); ws.on('error', rej); setTimeout(() => rej(new Error('connect timeout')), 5000); }); }

const USER = 'tierb-user', CHAR = 'tierb-char';
async function authMud(c, token, extra = {}) {
  c.send('auth', { token, userId: USER, characterId: CHAR, characterName: 'TierBRunner', packetPatch: 0, ...extra });
  await sleep(600); c.send('set_server', { host: 'localhost', port: 4000 });
  await sleep(400); c.send('set_aliases', { aliases: [] }); c.send('set_triggers', { triggers: [] }); c.send('set_variables', { variables: {} }); c.send('set_functions', { functions: {} });
  await sleep(1200);
}

async function main() {
  console.log('=== TierBRelink ===');
  require('fs').copyFileSync('/opt/wmt/wmt.db', DB_PATH);
  const mock = await startMock();
  const bl = []; const blob = () => bl.join('');
  const sl = []; const slob = () => sl.join('');
  const A = crypto.randomBytes(32).toString('hex'), Ashort = A.slice(0, 8);
  let bridge, srvA, srvB, cA, cC;
  try {
    bridge = spawnBridge(bl); await sleep(700);
    srvA = spawnServer(mock.port, sl, 'A'); await waitListening();

    // Live bridge socket, NOT logged in (so _actualMudChar stays null deterministically).
    cA = await connect(); await authMud(cA, A);
    if (!await waitFor(() => new RegExp(`MUD connected:.*\\(${Ashort}\\)`).test(blob()), 9000)) return bad('setup: MUD connected'), done();
    try { cA.ws.close(); } catch (e) {}

    // Restart wmt-server. Kill it HARD (no graceful persist) so restore can't
    // recreate the session and win the race — the browser reconnect creates a
    // fresh session that goes through connectToMud → the SC4 decision point, with
    // the bridge still holding the socket (bridgeResumed=true). This is exactly the
    // path that booted mimic.
    const exited = new Promise(r => srvA.on('exit', r));
    srvA.kill('SIGKILL');
    await Promise.race([exited, sleep(4000)]);
    srvB = spawnServer(mock.port, sl, 'B'); await waitListening();
    const slMark = slob().length, blMark = blob().length;

    // Browser AUTO-reconnects (autoReconnect:true) → bridge-resumed socket, not
    // logged in → the SC4 decision point.
    cC = await connect(); await authMud(cC, A, { autoReconnect: true });
    await sleep(2500);

    const stail = slob().slice(slMark);
    const btail = blob().slice(blMark);

    if (/AUTOLOGIN_RELINK/.test(stail) && !/AUTOLOGIN_SUPPRESSED/.test(stail)) ok('T1: server RELINKED the bridge-held socket (no SUPPRESSED)');
    else bad('T1: relink not suppress', `RELINK=${/AUTOLOGIN_RELINK/.test(stail)} SUPPRESSED=${/AUTOLOGIN_SUPPRESSED/.test(stail)}\n${stail.slice(0, 500)}`);

    if (!new RegExp(`MUD (end|closed) \\(${Ashort}\\)`).test(btail)) ok('T2: bridge did NOT close the MUD socket — player not booted');
    else bad('T2: socket survives', `bridge closed the socket:\n${btail.slice(0, 400)}`);

    if (cC.msgs.some(m => m.type === 'session_new')) ok('T3: browser received session_new (relink prompt)');
    else bad('T3: session_new sent', `client msgs: ${JSON.stringify(cC.msgs.map(m => m.type))}`);

  } finally { done(); }

  function done() {
    for (const c of [cA, cC]) { try { if (c) c.ws.close(); } catch (e) {} }
    try { if (srvB) srvB.kill('SIGKILL'); } catch (e) {}
    try { if (srvA) srvA.kill('SIGKILL'); } catch (e) {}
    try { if (bridge) bridge.kill('SIGKILL'); } catch (e) {}
    try { mock.server.close(); } catch (e) {}
    for (const e of ['', '-wal', '-shm']) require('fs').rmSync(DB_PATH + e, { force: true });
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
