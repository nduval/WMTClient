/**
 * ShowmeServerTriggers — server-side #show/#showme is trigger-checked, TinTin++ style.
 *
 * Root being fixed (2026-10-13): a `#show`/`#showme` fired by a server-side trigger
 * (or ticker / #delay / alias chain) was forwarded to ONE browser as a client_command;
 * the browser's cmdShowme bounced the text back as `test_line`, and only THEN did the
 * server match triggers on it. With no browser attached (phone app backgrounded, PC
 * tab gone) the client_command sat in the 150-line replay buffer and the chain died.
 * elminster's celbot stalled 2026-10-13 19:25Z exactly here: `You cannot take that.`
 * -> `#show coins here.` -> the `coins here.` trigger (which schedules the next
 * `k celestial`) never saw the text. tt++ (src/show.c do_showme) runs the text through
 * check_one_line BEFORE displaying it — the server now does the same.
 *
 * T1 (red/green pivot): browser DETACHED. Trigger A `You cannot take that.` -> `#show
 *     coins here.`; trigger B `coins here.` -> `#math bfired ...` + a MUD command. The
 *     MUD line is scheduled with `__emit_in` before the ws closes. Reconnect (resume)
 *     and assert session_resumed.variables.bfired == 1. Pre-fix: never fires.
 * T2: browser ATTACHED. Same chain via `__emit` -> B fires exactly ONCE (bfired 1,
 *     not 2), the showme text arrives as a `mud` test line, and NO `#show`
 *     client_command is forwarded (no browser hop = no double-fire).
 * T3: split-row form `#show {rowtext} {1}` is display-only -> still forwarded to the
 *     browser as a client_command, never trigger-checked.
 * T4: typed `#showme` path (`test_line`) still fires B exactly once — covers the
 *     executeTriggerResults refactor of the test_line handler.
 * T5: a `#show` whose own text re-matches the trigger that fired it must not hang
 *     the server (depth cap + loopTracker) — the server still answers afterwards.
 *
 * Run: node test_showme_server_triggers.js [ws://host:port]
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const Database = require('/opt/wmt/node_modules/better-sqlite3');

const WS_URL = process.argv[2] || 'ws://localhost:3000';
const DB_PATH = '/opt/wmt/wmt.db';
const CHAR_ID = 'showme-test-char';
const USER_ID = 'showme-test';
const token = crypto.randomBytes(32).toString('hex');
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS: ' + n); };
const bad = (n, m) => { fail++; console.log('  FAIL: ' + n + (m ? ' — ' + m : '')); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS_URL);
    const msgs = [];
    ws.on('message', r => { try { msgs.push(JSON.parse(r.toString())); } catch (e) {} });
    ws.on('open', () => res({ ws, msgs, send: (type, d = {}) => ws.send(JSON.stringify({ type, ...d })) }));
    ws.on('error', rej);
    setTimeout(() => rej(new Error('connect timeout')), 5000);
  });
}

const lastVar = (msgs, name) => {
  let v;
  for (const m of msgs) if (m.type === 'var_update' && m.variables && name in m.variables) v = m.variables[name];
  return v === undefined ? undefined : String(v);
};
const showCmds = (msgs) => msgs.filter(m => m.type === 'client_command' && /^#show/i.test(m.command || '')).map(m => m.command);
const mudLines = (msgs, text) => msgs.filter(m => m.type === 'mud' && (m.line || '').includes(text));

const TRIGGERS = [
  { id: 'sm-cannot', pattern: 'You cannot take that.', matchType: 'tintin', priority: 5, enabled: true,
    actions: [{ type: 'command', command: '#show coins here.' }] },
  { id: 'sm-coins', pattern: 'coins here.', matchType: 'tintin', priority: 5, enabled: true,
    actions: [{ type: 'command', command: '#math bfired {$bfired + 1}' }, { type: 'command', command: 'bfired_cmd' }] },
  { id: 'sm-row', pattern: 'rowtest line', matchType: 'tintin', priority: 5, enabled: true,
    actions: [{ type: 'command', command: '#show {rowtext} {1}' }] },
  { id: 'sm-loop', pattern: 'loop me', matchType: 'tintin', priority: 5, enabled: true,
    actions: [{ type: 'command', command: '#show loop me' }] },
];

async function login(c) {
  c.send('auth', { token, userId: USER_ID, characterId: CHAR_ID, characterName: 'ShowmeRunner', packetPatch: 0 });
  await sleep(500);
}

async function main() {
  console.log('=== ShowmeServerTriggers ===');
  let c1 = null, c2 = null;
  try {
    // --- Fresh session: connect to the mock MUD, load triggers, log in. ---
    c1 = await connect();
    await login(c1);
    c1.send('set_server', { host: 'localhost', port: 4000 });
    await sleep(500);
    c1.send('set_aliases', { aliases: [] });
    c1.send('set_variables', { variables: {} });
    c1.send('set_functions', { functions: {} });
    c1.send('set_triggers', { triggers: TRIGGERS });
    await sleep(1500);
    c1.send('command', { command: 'ShowmeRunner' });
    await sleep(500);
    c1.send('command', { command: 'password' });
    await sleep(1500);
    c1.send('command', { command: '#var bfired 0' });
    await sleep(400);
    if (lastVar(c1.msgs, 'bfired') !== '0') throw new Error('seed failed: bfired not 0 (' + lastVar(c1.msgs, 'bfired') + ')');

    // --- T1: browser detached while the MUD line arrives. ---
    c1.send('command', { command: '__emit_in 1500 You cannot take that.' });
    await sleep(200);
    c1.ws.close();
    c1 = null;
    await sleep(3500);
    c2 = await connect();
    await login(c2);
    let resumed = null;
    for (let i = 0; i < 50 && !resumed; i++) { await sleep(100); resumed = c2.msgs.find(m => m.type === 'session_resumed'); }
    if (!resumed) {
      bad('T1: session did not resume after the browser detached', JSON.stringify(c2.msgs.map(m => m.type)));
    } else {
      const v = resumed.variables ? String(resumed.variables.bfired) : 'undefined';
      const echoed = mudLines(c2.msgs, 'bfired_cmd').length;
      if (v === '1') ok(`T1: #show from a trigger fired its chain with NO browser attached (bfired=1, MUD echo replayed=${echoed})`);
      else bad('T1: detached #show chain did not fire', `bfired=${v} (pre-fix: #show buffered for an absent browser)`);
    }

    // --- T2: browser attached — exactly once, no client_command hop. ---
    c2.send('command', { command: '#var bfired 0' });
    await sleep(400);
    c2.msgs.length = 0;
    c2.send('command', { command: '__emit You cannot take that.' });
    await sleep(1200);
    const v2 = lastVar(c2.msgs, 'bfired');
    const hops = showCmds(c2.msgs);
    const shown = mudLines(c2.msgs, 'coins here.');
    if (v2 === '1' && hops.length === 0 && shown.length === 1 && shown[0].test === true) {
      ok('T2: attached browser — chain fired exactly once, text shown as a test line, no #show client_command');
    } else {
      bad('T2: attached-browser semantics', `bfired=${v2} showHops=${JSON.stringify(hops)} shownLines=${shown.length} test=${shown[0] && shown[0].test}`);
    }

    // --- T3: split-row form stays a browser-side display command. ---
    c2.msgs.length = 0;
    c2.send('command', { command: '__emit rowtest line' });
    await sleep(800);
    const rowHops = showCmds(c2.msgs);
    const rowShown = mudLines(c2.msgs, 'rowtext');
    if (rowHops.length === 1 && /^#show \{rowtext\} \{1\}$/.test(rowHops[0]) && rowShown.length === 0) {
      ok('T3: #show {msg} {row} still forwarded to the browser, not trigger-checked');
    } else {
      bad('T3: row form', `hops=${JSON.stringify(rowHops)} shown=${rowShown.length}`);
    }

    // --- T4: typed #showme (test_line) still fires once. ---
    c2.send('command', { command: '#var bfired 0' });
    await sleep(400);
    c2.msgs.length = 0;
    c2.send('test_line', { line: 'You cannot take that.' });
    await sleep(1200);
    const v4 = lastVar(c2.msgs, 'bfired');
    const shown4 = mudLines(c2.msgs, 'coins here.');
    if (v4 === '1' && shown4.length === 1) ok('T4: typed #showme (test_line) path fires the chain exactly once');
    else bad('T4: test_line path', `bfired=${v4} shown=${shown4.length}`);

    // --- T5: self-recursive #show must not wedge the server. ---
    c2.msgs.length = 0;
    c2.send('command', { command: '__emit loop me' });
    await sleep(2000);
    c2.send('command', { command: '#var alive 1' });
    let alive = null;
    for (let i = 0; i < 30 && alive !== '1'; i++) { await sleep(100); alive = lastVar(c2.msgs, 'alive'); }
    const loopNotes = c2.msgs.filter(m => m.type === 'disable_trigger' || (m.type === 'system' && /loop/i.test(m.message || ''))).length;
    const loopShown = mudLines(c2.msgs, 'loop me').length;
    if (alive === '1') ok(`T5: self-recursive #show bounded (shown ${loopShown}x, guard notices ${loopNotes}), server still answers`);
    else bad('T5: server unresponsive after recursive #show', `alive=${alive}`);

  } catch (e) {
    bad('harness', e.message);
  } finally {
    try {
      const db = new Database(DB_PATH);
      for (const tbl of ['triggers', 'aliases', 'tickers', 'entity_guard']) {
        try { db.prepare(`DELETE FROM ${tbl} WHERE character_id = ?`).run(CHAR_ID); } catch (e) {}
      }
      db.close();
    } catch (e) {}
    try { if (c1) c1.ws.close(); } catch (e) {}
    try { if (c2) c2.ws.close(); } catch (e) {}
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}
main();
