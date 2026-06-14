/**
 * MIP-at-name-prompt guard test (server-side).
 * See: elminster 2026-06-14 — a resume racing a fresh login fired the client's MIP
 * registration ('3klient <id>~~PortalWMT...') into the MUD's name prompt as junk
 * ("Invalid character in position N"), breaking the login.
 *
 * THE RULE: while the MUD socket is at a name prompt (session._atNamePrompt true),
 * the server DROPS '3klient ...' MIP-registration commands. The normal post-login
 * enableMip re-sends them once in-game. Non-MIP input still flows through.
 *
 * Harness mirrors test_tierb_relink: bridge + server, log into the mock, SIGKILL
 * restart (so the resumed session has _nameCaptured=false), browser silent-resume,
 * then drive a REAL name prompt via the mock's __nameprompt so _atNamePrompt=true.
 * The mock treats ANY input at its login prompt as the name and replies 'Password:',
 * so a DROPPED 3klient produces no 'Password:' while a normal name does.
 *
 *   T1  at the name prompt, a '3klient ...' command is DROPPED (server logs the drop;
 *       mock never receives it → no 'Password:' echoed back)
 *   T2  at the name prompt, a NON-MIP command still flows (mock replies 'Password:')
 *
 * Negative control: on the pre-fix server T1 fails (3klient reaches the mock → 'Password:').
 * Run: sudo -n node test_mip_nameprompt_guard.js
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVER_JS = process.env.SERVER_JS || '/opt/wmt/server.js';
const BRIDGE_JS = '/opt/wmt/bridge.js';
const ADMIN_KEY = 'test-admin-key-12345';
const MUD_HOST = 'localhost', MUD_PORT = '4000';
const BRIDGE_PORT = 4187, PORT = 3993;
const DB_PATH = '/tmp/wmt_mipguard_test.db';

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
function connect() { return new Promise((res, rej) => { const ws = new WebSocket(`ws://localhost:${PORT}`); const msgs = [], raw = []; ws.on('message', r => { const s = r.toString(); raw.push(s); try { msgs.push(JSON.parse(s)); } catch (e) {} }); ws.on('open', () => res({ ws, msgs, raw, send: (type, d = {}) => ws.send(JSON.stringify({ type, ...d })) })); ws.on('error', rej); setTimeout(() => rej(new Error('connect timeout')), 5000); }); }

const USER = 'mipg-user', CHAR = 'mipg-char';
async function authMud(c, token, extra = {}) {
  c.send('auth', { token, userId: USER, characterId: CHAR, characterName: 'MipRunner', packetPatch: 0, ...extra });
  await sleep(600); c.send('set_server', { host: 'localhost', port: 4000 });
  await sleep(400); c.send('set_aliases', { aliases: [] }); c.send('set_triggers', { triggers: [] }); c.send('set_variables', { variables: {} }); c.send('set_functions', { functions: {} });
  await sleep(1200);
}

async function main() {
  console.log('=== MipNamePromptGuard ===');
  require('fs').copyFileSync('/opt/wmt/wmt.db', DB_PATH);
  const mock = await startMock();
  const bl = []; const blob = () => bl.join('');
  const sl = []; const slob = () => sl.join('');
  const A = crypto.randomBytes(32).toString('hex'), Ashort = A.slice(0, 8);
  let bridge, srvA, srvB, cA, cC;
  try {
    bridge = spawnBridge(bl); await sleep(700);
    srvA = spawnServer(mock.port, sl, 'A'); await waitListening();

    // Live bridge socket; log into the mock so the held socket is logged-in.
    cA = await connect(); await authMud(cA, A);
    if (!await waitFor(() => new RegExp(`MUD connected:.*\\(${Ashort}\\)`).test(blob()), 9000)) return bad('setup: MUD connected'), done();
    cA.send('command', { command: 'MipRunner' }); await sleep(600);
    cA.send('command', { command: 'password' }); await sleep(1500);
    try { cA.ws.close(); } catch (e) {}

    // HARD restart so the resumed session starts with _nameCaptured=false.
    const exited = new Promise(r => srvA.on('exit', r));
    srvA.kill('SIGKILL');
    await Promise.race([exited, sleep(4000)]);
    srvB = spawnServer(mock.port, sl, 'B'); await waitListening();

    // Browser auto-reconnects → bridge-resumed, silent resume.
    cC = await connect(); await authMud(cC, A, { autoReconnect: true });
    await sleep(2500);

    // Drive a REAL name prompt; AUTOLOGIN_RELINK confirms _atNamePrompt was set.
    // (The raw test client does not answer session_new, so no name is typed and
    //  _atNamePrompt stays true for the guard checks below.)
    const slMark = slob().length;
    cC.send('command', { command: '__nameprompt' });
    const atPrompt = await waitFor(() => /AUTOLOGIN_RELINK/.test(slob().slice(slMark)), 6000);
    if (!atPrompt) { bad('setup: reach name prompt (AUTOLOGIN_RELINK)', slob().slice(slMark).slice(-300)); return done(); }
    await sleep(400);

    // T1: a 3klient MIP registration at the name prompt must be DROPPED.
    const dropMark = slob().length, rawMark = cC.raw.length;
    cC.send('command', { command: '3klient 99999~~PortalWMT1.0.0' });
    const dropped = await waitFor(() => /Dropped MIP cmd at name prompt/.test(slob().slice(dropMark)), 4000);
    await sleep(800);
    const sawPwAfterMip = cC.raw.slice(rawMark).join('').includes('Password:');
    if (dropped && !sawPwAfterMip) ok('T1: 3klient at name prompt DROPPED (not forwarded to MUD)');
    else bad('T1: 3klient dropped', `dropLog=${dropped} mockEchoedPassword=${sawPwAfterMip}`);

    // T2: a non-MIP command at the name prompt still flows (mock replies 'Password:').
    const rawMark2 = cC.raw.length;
    cC.send('command', { command: 'someguy' });
    const flowed = await waitFor(() => cC.raw.slice(rawMark2).join('').includes('Password:'), 4000);
    if (flowed) ok('T2: non-MIP command still flows to the MUD at the name prompt');
    else bad('T2: non-MIP flows', 'mock did not reply Password: to a normal name');

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
