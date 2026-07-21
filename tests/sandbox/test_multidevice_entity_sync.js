/**
 * Multi-device entity merge guard (2026-07-21).
 *
 * Proves the fix for the "bot dies ~105s after a mobile launch" clobber
 * (memory: bug_mobile_bot_multidevice_trigger_clobber): with two devices on
 * one session, set_triggers/set_aliases/set_tickers full-state pushes from a
 * device that never loaded the bot script must NOT delete the entities the
 * other device created. A device may only delete-by-omission entities it has
 * itself pushed on this connection (its baseline); a connection's first push
 * can never delete anything; content-duplicates (same script loaded on both
 * devices under different client ids) must not double-register.
 *
 *   T1  second device's smaller push does NOT wipe the bot trigger (THE bug)
 *   T2  the owning device CAN still delete its own trigger by omission
 *   T3  a fresh device's first push (empty set) deletes nothing
 *   T4a content-duplicate push: bot trigger still fires (ownership migrates)
 *   T4b ...and the new owner's delete removes it entirely (no hidden dupe)
 *   T5  aliases: second device's smaller push does not wipe the bot alias
 *   T6  tickers: second device's smaller push does not wipe the bot ticker
 *
 * Bridge-mode harness (bridge.js + wmt-server + fake store + mock-mud:4000),
 * same shape as test_multidevice.js. Negative control (verified 2026-07-21):
 * T1/T3/T5/T6 FAIL on a pre-change server (full-replace semantics); T2/T4
 * pass either way (they assert deletion still works, which replace gives free).
 * Run: sudo -n node test_multidevice_entity_sync.js
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVER_JS = process.env.SERVER_JS || '/opt/wmt/server.js';
const BRIDGE_JS = '/opt/wmt/bridge.js';
const ADMIN_KEY = 'test-admin-key-12345';
const MUD_HOST = 'localhost', MUD_PORT = '4000';
const BRIDGE_PORT = 4181, PORT = 3996;
const DB_PATH = '/tmp/wmt_entsync_test.db';

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

const USER = 'entsync-user', CHAR = 'entsync-char';

// "DB-loaded" base state — identical ids on every device, like a real page
// load pulling the same rows. Kept tiny; only identity semantics matter.
const BASE_TRIGGERS = [
  { id: 'baseT1', name: 'base1', pattern: 'ENTSYNC_BASE_LINE', actions: [{ type: 'command', command: '__emit ACK_BASE' }], enabled: true },
  { id: 'baseT2', name: 'base2', pattern: 'ENTSYNC_UNUSED', actions: [{ type: 'gag' }], enabled: true },
];
const BASE_ALIASES = [
  { id: 'baseA1', pattern: 'basecheck', matchType: 'exact', replacement: '__emit ACK_BASEALIAS', enabled: true },
];
const BASE_TICKERS = [];

const BOT_TRIGGER = (id) => ({ id, name: 'bot-nocoins', pattern: 'ENTSYNC_BOTLINE', actions: [{ type: 'command', command: '__emit ACK_BOT' }], enabled: true });
const BOT_ALIAS = { id: 'botAlias1', pattern: 'botcheck', matchType: 'exact', replacement: '__emit ACK_ALIAS', enabled: true };
const BOT_TICKER = { id: 'botTick1', name: 'botTick1', command: '__emit ACK_TICK', interval: 2, enabled: true };

function authBase(c, token) { c.send('auth', { token, userId: USER, characterId: CHAR, characterName: 'EntSyncRunner', packetPatch: 0 }); }
// Full device handshake, mirroring test_multidevice.js (set_server included —
// that's what makes a 2nd token JOIN the existing session rather than sit
// half-attached; MultiDevice T1 proves it never opens a 2nd MUD connection).
async function authMud(c, token, { triggers = BASE_TRIGGERS, aliases = BASE_ALIASES, tickers = BASE_TICKERS } = {}) {
  authBase(c, token); await sleep(600);
  c.send('set_server', { host: 'localhost', port: 4000 }); await sleep(400);
  c.send('set_aliases', { aliases });
  c.send('set_triggers', { triggers });
  c.send('set_tickers', { tickers });
  c.send('set_variables', { variables: {} });
  c.send('set_functions', { functions: {} });
  await sleep(1500);
}
const countAck = (msgs, from, tag) => msgs.slice(from).reduce((n, m) => n + (JSON.stringify(m).includes(tag) ? 1 : 0), 0);

async function main() {
  console.log('=== MultiDeviceEntitySync ===');
  require('fs').copyFileSync('/opt/wmt/wmt.db', DB_PATH);
  const mock = await startMock();
  const bl = []; const blob = () => bl.join('');
  const A = crypto.randomBytes(32).toString('hex'), Ashort = A.slice(0, 8);
  const B = crypto.randomBytes(32).toString('hex');
  const C = crypto.randomBytes(32).toString('hex');
  let bridge, srv, cA, cB, cC;
  try {
    bridge = spawnBridge(bl); await sleep(700);
    srv = spawnServer(mock.port); await waitListening();

    // Device A (the "bot device") connects, MUD up, logs in.
    cA = await connect(); await authMud(cA, A);
    if (!await waitFor(() => new RegExp(`MUD connected:.*\\(${Ashort}\\)`).test(blob()), 9000)) return bad('setup: device A MUD up'), done();
    cA.send('command', { command: 'EntSyncRunner' }); await sleep(700);
    cA.send('command', { command: 'password' }); await sleep(1800);

    // Device B (the "idle home PC") taps in with the same DB-loaded base state.
    cB = await connect(); await authMud(cB, B);

    // Fire a probe on the base trigger to prove the pipeline is live at all.
    let mark = cA.msgs.length;
    cA.send('command', { command: '__emit ENTSYNC_BASE_LINE' });
    if (await waitFor(() => countAck(cA.msgs, mark, 'ACK_BASE') >= 1, 5000)) ok('setup: base trigger pipeline live');
    else return bad('setup: base trigger pipeline live', 'no ACK_BASE'), done();

    // ── T1: THE bug. A loads the bot script; B re-pushes its smaller state. ──
    cA.send('set_triggers', { triggers: [...BASE_TRIGGERS, BOT_TRIGGER('botTrigA')] }); await sleep(500);
    cB.send('set_triggers', { triggers: BASE_TRIGGERS }); await sleep(500);   // the clobber push
    mark = cA.msgs.length;
    cA.send('command', { command: '__emit ENTSYNC_BOTLINE' });
    if (await waitFor(() => countAck(cA.msgs, mark, 'ACK_BOT') >= 1, 5000))
      ok('T1: second device\'s smaller push did NOT wipe the bot trigger');
    else bad('T1: bot trigger survives other device\'s push', 'no ACK_BOT after B\'s base-only push');

    // ── T2: the OWNING device deletes by omission — must still work. ──
    cA.send('set_triggers', { triggers: BASE_TRIGGERS }); await sleep(500);
    mark = cA.msgs.length;
    cA.send('command', { command: '__emit ENTSYNC_BOTLINE' });
    await sleep(2000);
    if (countAck(cA.msgs, mark, 'ACK_BOT') === 0)
      ok('T2: owning device\'s own delete-by-omission still removes the trigger');
    else bad('T2: owner delete works', 'ACK_BOT fired after owner removed the trigger');

    // ── T3: a fresh device's FIRST push (empty) deletes nothing. ──
    cA.send('set_triggers', { triggers: [...BASE_TRIGGERS, BOT_TRIGGER('botTrigA')] }); await sleep(500);
    cC = await connect(); await authMud(cC, C, { triggers: [], aliases: [], tickers: [] }); // worst-case first push
    mark = cA.msgs.length;
    cA.send('command', { command: '__emit ENTSYNC_BOTLINE' });
    if (await waitFor(() => countAck(cA.msgs, mark, 'ACK_BOT') >= 1, 5000))
      ok('T3: fresh device\'s first (empty) push deleted nothing');
    else bad('T3: first push cannot delete', 'no ACK_BOT after C\'s empty push');

    // ── T4: content-duplicate — same script on both devices, different ids. ──
    cB.send('set_triggers', { triggers: [...BASE_TRIGGERS, BOT_TRIGGER('botTrigB')] }); await sleep(500);
    mark = cA.msgs.length;
    cA.send('command', { command: '__emit ENTSYNC_BOTLINE' });
    if (await waitFor(() => countAck(cA.msgs, mark, 'ACK_BOT') >= 1, 5000))
      ok('T4a: bot trigger still fires after a duplicate-content push from device B');
    else bad('T4a: duplicate-content push keeps trigger live', 'no ACK_BOT');
    // If a hidden duplicate survived (A's copy preserved alongside B's), B's
    // delete would NOT silence the pattern — A's copy is outside B's baseline.
    cB.send('set_triggers', { triggers: BASE_TRIGGERS }); await sleep(500);
    mark = cA.msgs.length;
    cA.send('command', { command: '__emit ENTSYNC_BOTLINE' });
    await sleep(2000);
    if (countAck(cA.msgs, mark, 'ACK_BOT') === 0)
      ok('T4b: no hidden duplicate — new owner\'s delete fully removes the pattern');
    else bad('T4b: content dedupe', 'ACK_BOT still firing → duplicate trigger survived');

    // ── T5: aliases get the same protection. ──
    cA.send('set_aliases', { aliases: [...BASE_ALIASES, BOT_ALIAS] }); await sleep(500);
    cB.send('set_aliases', { aliases: BASE_ALIASES }); await sleep(500);      // the clobber push
    mark = cA.msgs.length;
    cA.send('command', { command: 'botcheck' });
    if (await waitFor(() => countAck(cA.msgs, mark, 'ACK_ALIAS') >= 1, 5000))
      ok('T5: second device\'s smaller push did NOT wipe the bot alias');
    else bad('T5: bot alias survives other device\'s push', 'no ACK_ALIAS');

    // ── T6: tickers get the same protection. ──
    cA.send('set_tickers', { tickers: [...BASE_TICKERS, BOT_TICKER] }); await sleep(500);
    cB.send('set_tickers', { tickers: BASE_TICKERS }); await sleep(500);      // the clobber push
    mark = cA.msgs.length;
    if (await waitFor(() => countAck(cA.msgs, mark, 'ACK_TICK') >= 1, 7000))
      ok('T6: second device\'s smaller push did NOT wipe the bot ticker');
    else bad('T6: bot ticker survives other device\'s push', 'no ACK_TICK within 7s (interval 2s)');

  } catch (e) {
    // Without this, a harness exception (connect timeout, spawn failure) would
    // print "0 passed, 0 failed" and exit 0 — a silent green. Fail loudly.
    bad('SUITE ERROR (harness exception)', e && e.message);
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
