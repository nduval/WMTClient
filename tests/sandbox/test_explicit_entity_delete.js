/**
 * ExplicitEntityDelete (2026-10-14)
 *
 * mergeDevicePush only lets a browser delete-by-omission entities it pushed
 * ITSELF on this connection, and the resume echo guard (2026-09-12) credits a
 * resumed/reloaded browser with authoring NOTHING. Net effect for an ordinary
 * single-device user: a UI delete (or typed #un*) right after a reload was
 * silently restored by the server on the next push — "I deleted it and it came
 * back" (locrian's four undeletable duplicate triggers, 2026-10-14).
 *
 * Fix: set_triggers / set_aliases / set_tickers may carry `removed: [ids]` — the
 * ids the user deliberately deleted. The server drops those regardless of
 * authorship. The client never sends `removed` for script-driven removals
 * (inside #read), so the multi-device bot protection is unchanged.
 *
 *   T1 control: resumed device, omission-only push → bot alias SURVIVES
 *               (protection intact; passes on both servers).
 *   T2 safety:  second bare device, omission-only trigger push → bot trigger
 *               SURVIVES (passes on both servers).
 *   T3 alias:   resumed device pushes with removed → alias gone (live + DB).  RED pre-fix
 *   T4 trigger: same for a trigger.                                           RED pre-fix
 *   T5 ticker:  same for a ticker.                                            RED pre-fix
 *
 * Run: sudo -n node test_explicit_entity_delete.js   (SERVER_JS=... to point at a build)
 */
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const SERVER_JS = process.env.SERVER_JS || '/opt/wmt/server.js';
const BRIDGE_JS = '/opt/wmt/bridge.js';
const ADMIN_KEY = 'test-admin-key-12345';
const MUD_HOST = 'localhost', MUD_PORT = '4000';
const BRIDGE_PORT = 4190, PORT = 3997;
const DB_PATH = '/tmp/wmt_explicitdel_test.db';

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
function spawnServer(mockPort, log) { const env = { ...process.env, PORT: String(PORT), ADMIN_KEY, PHP_SESSIONS_URL: `http://127.0.0.1:${mockPort}/persistent_sessions.php`, WMT_DB_PATH: DB_PATH, MUD_HOST, MUD_PORT, BRIDGE_URL: `ws://localhost:${BRIDGE_PORT}`, NODE_ENV: 'production' }; const c = spawn('node', [SERVER_JS], { env, cwd: '/opt/wmt' }); c.stdout.on('data', d => { log.push(d.toString()); if (process.env.VERBOSE) process.stdout.write('[srv] ' + d); }); c.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write('[srv ERR] ' + d); }); return c; }
function waitListening(t = 12000) { const s = Date.now(); return new Promise((res, rej) => { (function p() { const ws = new WebSocket(`ws://localhost:${PORT}`); ws.on('open', () => { ws.close(); res(); }); ws.on('error', () => { if (Date.now() - s > t) return rej(new Error('no listen')); setTimeout(p, 300); }); })(); }); }
function connect() { return new Promise((res, rej) => { const ws = new WebSocket(`ws://localhost:${PORT}`); const msgs = []; ws.on('message', r => { try { msgs.push(JSON.parse(r.toString())); } catch (e) {} }); ws.on('open', () => res({ ws, msgs, send: (type, d = {}) => ws.send(JSON.stringify({ type, ...d })) })); ws.on('error', rej); setTimeout(() => rej(new Error('connect timeout')), 5000); }); }

const USER = 'explicitdel-user', CHAR = 'explicitdel-char';
const BASE_TRIGGERS = [{ id: 'baseT1', name: 'base1', pattern: 'EXDEL_BASE_LINE', actions: [{ type: 'command', command: '__emit ACK_BASE' }], enabled: true }];
const BOT_TRIGGER   =  { id: 'botTrig1', name: 'bot-nocoins', pattern: 'EXDEL_BOTLINE', actions: [{ type: 'command', command: '__emit ACK_BOT' }], enabled: true };
const BASE_ALIASES  = [{ id: 'baseA1', pattern: 'basecheck', matchType: 'exact', replacement: '__emit ACK_BASEALIAS', enabled: true }];
const BOT_ALIAS     =  { id: 'botAlias1', pattern: 'botcheck', matchType: 'exact', replacement: '__emit ACK_ALIAS', enabled: true };
const BOT_TICKER    =  { id: 'botTick1', name: 'botTick1', command: '__emit ACK_TICK', interval: 2, enabled: true };

function authBase(c, token) { c.send('auth', { token, userId: USER, characterId: CHAR, characterName: 'DelRunner', packetPatch: 0 }); }
async function authMud(c, token) {
  authBase(c, token); await sleep(600);
  c.send('set_server', { host: 'localhost', port: 4000 }); await sleep(400);
  c.send('set_aliases', { aliases: BASE_ALIASES });
  c.send('set_triggers', { triggers: BASE_TRIGGERS });
  c.send('set_tickers', { tickers: [] });
  c.send('set_variables', { variables: {} });
  c.send('set_functions', { functions: {} });
  await sleep(1500);
}
const countAck = (msgs, from, tag) => msgs.slice(from).reduce((n, m) => n + (JSON.stringify(m).includes(tag) ? 1 : 0), 0);

function dbCount(table, id) {
  const Database = require('/opt/wmt/node_modules/better-sqlite3');
  const db = new Database(DB_PATH, { readonly: true });
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE character_id=? AND id=?`).get(CHAR, id).n; }
  finally { db.close(); }
}

// Resume into the live session on a NEW ws (what a reload / phone hop does),
// wait for authoritative_state, and echo it back like the real onSessionResumed.
async function resumeAndEcho(token) {
  const c = await connect();
  authBase(c, token); await sleep(700);
  c.send('set_server', { host: 'localhost', port: 4000 }); await sleep(600);
  const st = c.msgs.filter(m => m.type === 'authoritative_state').pop();
  if (!st) return { c, st: null };
  if (st.aliases)  c.send('set_aliases',  { aliases: st.aliases });
  if (st.triggers) c.send('set_triggers', { triggers: st.triggers });
  if (st.tickers)  c.send('set_tickers',  { tickers: st.tickers });
  await sleep(600);
  return { c, st };
}

async function main() {
  console.log('=== ExplicitEntityDelete ===');
  require('fs').copyFileSync('/opt/wmt/wmt.db', DB_PATH);
  {
    const Database = require('/opt/wmt/node_modules/better-sqlite3');
    const seed = new Database(DB_PATH);
    seed.pragma('foreign_keys = OFF');
    seed.prepare(`INSERT OR IGNORE INTO characters (id, user_id, name, server, sort_order, created_at)
                  VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(CHAR, USER, 'DelRunner', '3k', 0);
    for (const t of ['aliases', 'triggers', 'tickers']) { try { seed.prepare(`DELETE FROM ${t} WHERE character_id=?`).run(CHAR); } catch (e) {} }
    seed.close();
  }
  const mock = await startMock();
  const bl = [], sl = []; const blob = () => bl.join('');
  const A = crypto.randomBytes(32).toString('hex'), Ashort = A.slice(0, 8);
  const A2 = crypto.randomBytes(32).toString('hex');
  const B = crypto.randomBytes(32).toString('hex');
  let bridge, srv, cA, cA2, cB;
  try {
    bridge = spawnBridge(bl); await sleep(700);
    srv = spawnServer(mock.port, sl); await waitListening();

    // ── setup: device A logs in and authors the bot alias/trigger/ticker ──
    cA = await connect(); await authMud(cA, A);
    if (!await waitFor(() => new RegExp(`MUD connected:.*\\(${Ashort}\\)`).test(blob()), 9000)) return bad('setup: device A MUD up'), done();
    cA.send('command', { command: 'DelRunner' }); await sleep(700);
    cA.send('command', { command: 'password' }); await sleep(1800);
    cA.send('set_aliases',  { aliases: [...BASE_ALIASES, BOT_ALIAS] });
    cA.send('set_triggers', { triggers: [...BASE_TRIGGERS, BOT_TRIGGER] });
    cA.send('set_tickers',  { tickers: [BOT_TICKER] });
    await sleep(800);
    let mark = cA.msgs.length;
    cA.send('command', { command: 'botcheck' });
    if (!await waitFor(() => countAck(cA.msgs, mark, 'ACK_ALIAS') >= 1, 5000)) return bad('setup: bot alias live on A'), done();
    mark = cA.msgs.length;
    cA.send('command', { command: '__emit EXDEL_BOTLINE' });
    if (!await waitFor(() => countAck(cA.msgs, mark, 'ACK_BOT') >= 1, 5000)) return bad('setup: bot trigger live on A'), done();
    if (dbCount('aliases', 'botAlias1') !== 1 || dbCount('triggers', 'botTrig1') !== 1) return bad('setup: bot alias+trigger persisted to DB'), done();
    ok('setup: bot alias, trigger and ticker authored by A, live, persisted');

    // ── the same user reloads: A goes away, A2 resumes and echoes ──
    cA.ws.close(); await sleep(800);
    const r = await resumeAndEcho(A2); cA2 = r.c;
    if (!r.st || !JSON.stringify(r.st.aliases || []).includes('botAlias1') || !JSON.stringify(r.st.triggers || []).includes('botTrig1'))
      return bad('setup: A2 received authoritative_state with the bot alias + trigger', 'resume path not exercised'), done();
    ok('setup: A2 resumed and echoed authoritative_state (echo guard engaged)');

    // T1 control — omission-only push after resume must NOT delete (protection intact)
    cA2.send('set_aliases', { aliases: BASE_ALIASES }); await sleep(700);
    mark = cA2.msgs.length;
    cA2.send('command', { command: 'botcheck' });
    if (await waitFor(() => countAck(cA2.msgs, mark, 'ACK_ALIAS') >= 1, 4000)) ok('T1 control: omission-only push after resume did not delete the bot alias (merge protection intact)');
    else bad('T1 control: omission-only push deleted the bot alias', 'merge protection missing — this suite assumes it');

    // T2 safety — a second BARE device's omission-only trigger push must not delete
    const rb = await resumeAndEcho(B); cB = rb.c;
    cB.send('set_triggers', { triggers: BASE_TRIGGERS }); await sleep(700);
    mark = cA2.msgs.length;
    cA2.send('command', { command: '__emit EXDEL_BOTLINE' });
    if (await waitFor(() => countAck(cA2.msgs, mark, 'ACK_BOT') >= 1, 4000)) ok('T2 safety: second bare device omission-only push did not delete the bot trigger');
    else bad('T2 safety: second bare device omission-only push DELETED the bot trigger');
    cB.ws.close(); await sleep(400);

    // T3 — explicit removed on the alias push
    cA2.send('set_aliases', { aliases: BASE_ALIASES, removed: ['botAlias1'] }); await sleep(900);
    mark = cA2.msgs.length;
    cA2.send('command', { command: 'botcheck' });
    await sleep(2500);
    const aliasFired = countAck(cA2.msgs, mark, 'ACK_ALIAS');
    const aliasDb = dbCount('aliases', 'botAlias1');
    if (aliasFired === 0 && aliasDb === 0) ok('T3 alias: explicit removed → alias gone live and from the DB');
    else bad('T3 alias: explicit removed ignored', `fired=${aliasFired} dbRows=${aliasDb}`);
    if (/ENTITY_REMOVED aliases/.test(sl.join(''))) ok('T3 alias: ENTITY_REMOVED logged'); else bad('T3 alias: no ENTITY_REMOVED log line');

    // T4 — explicit removed on the trigger push
    cA2.send('set_triggers', { triggers: BASE_TRIGGERS, removed: ['botTrig1'] }); await sleep(900);
    mark = cA2.msgs.length;
    cA2.send('command', { command: '__emit EXDEL_BOTLINE' });
    await sleep(2500);
    const trigFired = countAck(cA2.msgs, mark, 'ACK_BOT');
    const trigDb = dbCount('triggers', 'botTrig1');
    if (trigFired === 0 && trigDb === 0) ok('T4 trigger: explicit removed → trigger gone live and from the DB');
    else bad('T4 trigger: explicit removed ignored', `fired=${trigFired} dbRows=${trigDb}`);
    // base trigger must still work (we didn't nuke the table)
    mark = cA2.msgs.length;
    cA2.send('command', { command: '__emit EXDEL_BASE_LINE' });
    if (await waitFor(() => countAck(cA2.msgs, mark, 'ACK_BASE') >= 1, 4000)) ok('T4 trigger: base trigger still fires'); else bad('T4 trigger: base trigger stopped firing');

    // T5 — explicit removed on the ticker push (ticker is server-run, 2s)
    mark = cA2.msgs.length;
    if (!await waitFor(() => countAck(cA2.msgs, mark, 'ACK_TICK') >= 1, 5000)) bad('T5 ticker: setup — bot ticker not ticking before removal');
    cA2.send('set_tickers', { tickers: [], removed: ['botTick1'] }); await sleep(2500); // let an in-flight tick land
    mark = cA2.msgs.length;
    await sleep(5000);
    const ticks = countAck(cA2.msgs, mark, 'ACK_TICK');
    const tickDb = dbCount('tickers', 'botTick1');
    if (ticks === 0 && tickDb === 0) ok('T5 ticker: explicit removed → ticker stopped and gone from the DB');
    else bad('T5 ticker: explicit removed ignored', `ticks=${ticks} dbRows=${tickDb}`);

  } catch (e) {
    bad('SUITE ERROR (harness exception)', e && e.message);
  } finally { done(); }

  function done() {
    for (const c of [cA, cA2, cB]) { try { if (c) c.ws.close(); } catch (e) {} }
    try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
    try { if (bridge) bridge.kill('SIGKILL'); } catch (e) {}
    try { mock.server.close(); } catch (e) {}
    for (const e of ['', '-wal', '-shm']) require('fs').rmSync(DB_PATH + e, { force: true });
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
