/**
 * REPRO (2026-09-12): resume-echo poisons a device's merge baseline → later
 * bare push wipes the other device's bot entities. This is the recurrence of
 * bug_mobile_bot_multidevice_trigger_clobber that mergeDevicePush (199daaf)
 * did NOT cover — and the reason elminster's 986 aliases dropped to 125 with
 * ZERO ENTITY_MERGE log lines.
 *
 * Mechanism under test:
 *   1. Device A (bot device) pushes base+bot alias → session/DB = base+bot,
 *      bot alias authored by A.
 *   2. Device B (bare home PC) resumes. Server sends authoritative_state
 *      (base+bot) BEFORE session_resumed (server.js ~7798). The real client's
 *      onSessionResumed → sendFilteredTriggersAndAliases echoes that state back.
 *      We simulate that echo: B sends set_aliases {base+bot}. mergeDevicePush's
 *      FIRST push for B's ws deletes nothing but sets baseline_B = base+bot.
 *   3. B then pushes its REAL bare state {base}. mergeDevicePush sees the bot
 *      alias in baseline_B → classifies it a genuine delete → wipes it, no
 *      ENTITY_MERGE (B is credited as the author of an entity it only echoed).
 *
 * EXPECTED on the current server: T_repro FAILS (bot alias gone) — the red.
 * After the ownership fix: a device may only delete-by-omission entities it
 * genuinely authored; echoing authoritative_state does not claim authorship.
 *
 * Run: sudo -n node test_resume_echo_clobber.js
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVER_JS = process.env.SERVER_JS || '/opt/wmt/server.js';
const BRIDGE_JS = '/opt/wmt/bridge.js';
const ADMIN_KEY = 'test-admin-key-12345';
const MUD_HOST = 'localhost', MUD_PORT = '4000';
const BRIDGE_PORT = 4187, PORT = 3992;
const DB_PATH = '/tmp/wmt_resumeecho_test.db';

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

const USER = 'resumeecho-user', CHAR = 'resumeecho-char';
const BASE_ALIASES = [{ id: 'baseA1', pattern: 'basecheck', matchType: 'exact', replacement: '__emit ACK_BASEALIAS', enabled: true }];
const BOT_ALIAS = { id: 'botAlias1', pattern: 'botcheck', matchType: 'exact', replacement: '__emit ACK_ALIAS', enabled: true };

function authBase(c, token) { c.send('auth', { token, userId: USER, characterId: CHAR, characterName: 'EchoRunner', packetPatch: 0 }); }
async function authMud(c, token, aliases = BASE_ALIASES) {
  authBase(c, token); await sleep(600);
  c.send('set_server', { host: 'localhost', port: 4000 }); await sleep(400);
  c.send('set_aliases', { aliases });
  c.send('set_triggers', { triggers: [] });
  c.send('set_tickers', { tickers: [] });
  c.send('set_variables', { variables: {} });
  c.send('set_functions', { functions: {} });
  await sleep(1500);
}
const countAck = (msgs, from, tag) => msgs.slice(from).reduce((n, m) => n + (JSON.stringify(m).includes(tag) ? 1 : 0), 0);

async function main() {
  console.log('=== ResumeEchoClobber (repro) ===');
  require('fs').copyFileSync('/opt/wmt/wmt.db', DB_PATH);
  // The server persists aliases to this DB; without a matching characters row
  // the FK fails, DB stays empty, and authoritative_state is never sent — which
  // silently bypasses the very path under test. Seed the row (mirrors the
  // MultiDeviceEntitySync harness).
  {
    const Database = require('/opt/wmt/node_modules/better-sqlite3');
    const seed = new Database(DB_PATH);
    seed.pragma('foreign_keys = OFF');
    seed.prepare(`INSERT OR IGNORE INTO characters (id, user_id, name, server, sort_order, created_at)
                  VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(CHAR, USER, 'EchoRunner', '3k', 0);
    for (const t of ['aliases', 'triggers', 'tickers']) { try { seed.prepare(`DELETE FROM ${t} WHERE character_id=?`).run(CHAR); } catch (e) {} }
    seed.close();
  }
  const mock = await startMock();
  const bl = []; const blob = () => bl.join('');
  const A = crypto.randomBytes(32).toString('hex'), Ashort = A.slice(0, 8);
  const B = crypto.randomBytes(32).toString('hex');
  let bridge, srv, cA, cB;
  try {
    bridge = spawnBridge(bl); await sleep(700);
    srv = spawnServer(mock.port); await waitListening();

    cA = await connect(); await authMud(cA, A);
    if (!await waitFor(() => new RegExp(`MUD connected:.*\\(${Ashort}\\)`).test(blob()), 9000)) return bad('setup: device A MUD up'), done();
    cA.send('command', { command: 'EchoRunner' }); await sleep(700);
    cA.send('command', { command: 'password' }); await sleep(1800);

    // A loads the bot alias → session/DB = base+bot, authored by A.
    cA.send('set_aliases', { aliases: [...BASE_ALIASES, BOT_ALIAS] }); await sleep(600);
    let mark = cA.msgs.length;
    cA.send('command', { command: 'botcheck' });
    if (!await waitFor(() => countAck(cA.msgs, mark, 'ACK_ALIAS') >= 1, 5000)) return bad('setup: bot alias live on A'), done();
    ok('setup: bot alias authored by A and firing');

    // Device B resumes into the same session; capture authoritative_state.
    cB = await connect();
    authBase(cB, B); await sleep(700);
    cB.send('set_server', { host: 'localhost', port: 4000 }); await sleep(600);
    // Did the server hand B the authoritative (base+bot) alias set on resume?
    // Assert loudly — a fallback here previously masked that the path never ran.
    const authState = cB.msgs.filter(m => m.type === 'authoritative_state' && Array.isArray(m.aliases)).pop();
    if (!authState || !JSON.stringify(authState.aliases).includes('botAlias1')) {
      return bad('setup: B received authoritative_state incl. bot alias', 'no authoritative_state with bot — DB/resume path not exercised'), done();
    }
    ok('setup: B received authoritative_state carrying the bot alias (resume path live)');
    const echoed = authState.aliases;

    // B echoes authoritative_state back (what the real onSessionResumed does),
    // then pushes its REAL bare state. The echo poisons B's baseline.
    cB.send('set_aliases', { aliases: echoed }); await sleep(500);          // echo
    cB.send('set_aliases', { aliases: BASE_ALIASES }); await sleep(600);    // real bare push

    mark = cA.msgs.length;
    cA.send('command', { command: 'botcheck' });
    await sleep(2500);
    if (countAck(cA.msgs, mark, 'ACK_ALIAS') >= 1)
      ok('T_repro: bot alias SURVIVED B\'s resume-echo + bare push');
    else
      bad('T_repro: bot alias wiped by resume-echo baseline poisoning', 'no ACK_ALIAS — the clobber reproduced');

  } catch (e) {
    bad('SUITE ERROR (harness exception)', e && e.message);
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
