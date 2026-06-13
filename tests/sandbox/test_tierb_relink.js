/**
 * Resume name-send discipline test (2026-06-13 rewrite; was the Tier B relink test).
 * See memory: bug_resume_name_prompt_autologin_suppressed, docs/connection-issues/005.
 *
 * THE RULE: a bridge-resumed socket must NEVER make the browser type the char
 * name into the running game. We relink (send the name) ONLY when the MUD
 * actually shows its name prompt. This kills the "There is no reason to 'X'
 * here." echo (mimic 06-12, elminster 06-13) while keeping the genuinely-parked
 * relink (mimic 06-08) working — now driven by the REAL prompt, not a guess.
 *
 * Scenario: live bridge socket, char NOT logged in (mudLoggedIn=false), server
 * restarts, browser AUTO-reconnects → bridge-resumed, not logged in. The OLD
 * code immediately dispatched session_new → browser typed the name → the echo.
 *
 *   T1  resume is SILENT: RESUME_SILENT_ARMED logged, NO AUTOLOGIN_RELINK yet,
 *       browser got session_resumed and NOT a login-flow session_new (no name typed)
 *   T2  the bridge did NOT close the MUD socket (player not booted)
 *   --- then the MUD actually presents a name prompt (mock __nameprompt) ---
 *   T3  NOW the server relinks: AUTOLOGIN_RELINK logged + browser gets session_new
 *
 * On the pre-2026-06-13 server.js T1 fails (it relinks immediately → name typed).
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
    // Log into the mock MUD so its held socket is in the logged-in state — needed
    // so the post-resume __nameprompt is parsed as a TEST COMMAND, not as a name
    // typed at the mock's own login prompt. _actualMudChar is NOT persisted (the
    // SIGKILL below skips graceful persist), so the resumed session still has
    // mudLoggedIn=false — exactly the elminster "in-game but untracked" case.
    cA.send('command', { command: 'TierBRunner' }); await sleep(600);
    cA.send('command', { command: 'password' }); await sleep(1500);
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
    // logged in → the resume decision point. Only a session_new WITHOUT
    // bridgeMode types the name (the auth handshake sends a silent bridgeMode one).
    const loginNew = (m) => m.type === 'session_new' && !m.bridgeMode;
    cC = await connect(); await authMud(cC, A, { autoReconnect: true });
    await sleep(2800);

    const stail1 = slob().slice(slMark);
    const btail = blob().slice(blMark);

    // T1: SILENT resume — name NOT typed (no login-flow session_new), armed for a real prompt.
    if (/RESUME_SILENT_ARMED/.test(stail1) && !/AUTOLOGIN_RELINK/.test(stail1) &&
        cC.msgs.some(m => m.type === 'session_resumed') && !cC.msgs.some(loginNew)) {
      ok('T1: bridge-resumed socket resumed SILENTLY — name NOT typed into the game');
    } else {
      bad('T1: silent resume', `armed=${/RESUME_SILENT_ARMED/.test(stail1)} relink=${/AUTOLOGIN_RELINK/.test(stail1)} resumedMsg=${cC.msgs.some(m=>m.type==='session_resumed')} loginNew=${cC.msgs.some(loginNew)}`);
    }

    if (!new RegExp(`MUD (end|closed) \\(${Ashort}\\)`).test(btail)) ok('T2: bridge did NOT close the MUD socket — player not booted');
    else bad('T2: socket survives', `bridge closed the socket:\n${btail.slice(0, 400)}`);

    // Now the MUD ACTUALLY shows a name prompt (genuinely parked). NOW relink.
    const slMark2 = slob().length;
    cC.send('command', { command: '__nameprompt' });
    const relinked = await waitFor(() => /AUTOLOGIN_RELINK/.test(slob().slice(slMark2)) && cC.msgs.some(loginNew), 6000);
    if (relinked) ok('T3: a REAL name prompt drove the relink — AUTOLOGIN_RELINK + session_new');
    else bad('T3: prompt-driven relink', `relink=${/AUTOLOGIN_RELINK/.test(slob().slice(slMark2))} loginNew=${cC.msgs.some(loginNew)}`);

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
