/**
 * Server-side variable/command engine parity — Phase 2 of the single-owner model.
 *
 * As execution moves server-side (so trigger/heal bodies run against ONE authoritative
 * variable store), the server must handle the TinTin++ constructs his scripts use that
 * were previously client-only. This suite grows one case per closed gap.
 *
 *   T1: indexed variable SET `#var {name[key]} {v}` — was client-only; the server's scalar
 *       #var only matched a bare \w+ name, so `$sptracker[...]` writes silently no-op'd
 *       server-side. Now stored as nested objects matching the read path.
 *   T2: nested (multi-key) indexed set `#var {name[a][b]} {v}`.
 *   T3: runtime #ticker authoring — a TRIGGER body's `#ticker {t}{#var ...;#unticker t}{1}`
 *       is authored + fired server-side and self-terminates (the 2026-07-06 death mechanism:
 *       heal reset tickers were forwarded to a racing/absent browser and never fired).
 *   T4: a client set_tickers full-replace does NOT wipe a live server-authored runtime ticker.
 *   T5: #list create + size server-side (his findtv/findhat usage).
 *   T6: #list get + find server-side.
 *
 * #unticker semantics (review F3/F4/F5, 2026-07-08 — the WORLDDROP bell):
 *   T7: `#unticker {wildcard*}` sent as a typed command kills a RUNTIME ticker by
 *       name wildcard (was: exact-only compare consumed it silently; the trigger's
 *       own "type #unticker WORLDDROP" instruction killed nothing).
 *   T8: a trigger-body `#unticker {name}` kills a CLIENT-SYNCED ticker (random id,
 *       name in .name — was: compared against the id, interval kept running) AND
 *       forwards a client_command so the browser drops its copy (no resurrection
 *       on the next set_tickers full-replace).
 *   T9: runtime #ticker authoring REPLACES a same-name client-synced ticker (was:
 *       both intervals ran — F5 double-fire), and a later client set_tickers
 *       re-sync does not resurrect the synced copy while the runtime one lives.
 *
 * Run: node test_server_var_engine.js   (ignores any ws:// arg the gate passes)
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const Database = require('/opt/wmt/node_modules/better-sqlite3');

const WS_URL = process.argv[2] || 'ws://localhost:3000';
const DB_PATH = '/opt/wmt/wmt.db';
let ws;
const token = crypto.randomBytes(32).toString('hex');
let varUpdates = [];
let clientCmds = [];
let varQueryResults = [];
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS: ' + n); };
const bad = (n, m) => { fail++; console.log('  FAIL: ' + n + (m ? ' — ' + m : '')); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const send = (type, data = {}) => ws.send(JSON.stringify({ type, ...data }));
// Latest server-pushed value of a variable across all var_updates seen.
function latest(name) {
  let v;
  for (const u of varUpdates) { if (u && Object.prototype.hasOwnProperty.call(u, name)) v = u[name]; }
  return v;
}

async function main() {
  console.log('=== ServerVarEngine ===');
  try {
    ws = new WebSocket(WS_URL);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('connect timeout')), 5000); });
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'var_update' && m.variables) varUpdates.push(m.variables);
        if (m.type === 'client_command' && m.command) clientCmds.push(m.command);
        if (m.type === 'var_query_result') varQueryResults.push(m);
      } catch (e) {}
    });

    send('auth', { token, userId: 'sve-test', characterId: 'sve-test-char', characterName: 'SveRunner', packetPatch: 0 });
    await sleep(500);
    send('set_server', { host: 'localhost', port: 4000 });
    await sleep(500);
    send('set_aliases', { aliases: [] });
    send('set_variables', { variables: {} });
    send('set_functions', { functions: {} });
    await sleep(1500);
    send('command', { command: 'SveRunner' });   // clear name prompt
    await sleep(500);
    send('command', { command: 'password' });
    await sleep(1500);

    // T1: indexed set — `#var {track[cur]} {42}` → session.variables.track = { cur: '42' }
    varUpdates = [];
    send('command', { command: '#var {track[cur]} {42}' });
    await sleep(600);
    const track = latest('track');
    if (track && String(track.cur) === '42') ok('T1: indexed #var set stored server-side (track[cur]=42)');
    else bad('T1: indexed var set', `expected track.cur=42, got ${JSON.stringify(track)}; updates=${JSON.stringify(varUpdates)}`);

    // T2: nested multi-key set — `#var {bag[a][b]} {9}` → bag = { a: { b: '9' } }
    varUpdates = [];
    send('command', { command: '#var {bag[a][b]} {9}' });
    await sleep(600);
    const bag = latest('bag');
    if (bag && bag.a && String(bag.a.b) === '9') ok('T2: nested indexed #var set (bag[a][b]=9)');
    else bad('T2: nested indexed var set', `expected bag.a.b=9, got ${JSON.stringify(bag)}`);

    // T3: trigger-authored #ticker fires server-side once and self-terminates.
    send('set_triggers', { triggers: [{ id: 'ta', pattern: '~GOTICK', matchType: 'tintin', enabled: true,
      actions: [{ type: 'command', command: '#ticker {t1} {#var tickfired 1;#unticker t1} {1}' }] }] });
    await sleep(400);
    varUpdates = [];
    send('command', { command: '__emit GOTICK' });     // fires the trigger → authors ticker t1
    await sleep(1700);                                  // interval 1s → should fire once
    const firedOnce = latest('tickfired');
    const fireCount1 = varUpdates.filter(u => 'tickfired' in u).length;
    await sleep(1600);                                  // self-untickered → must NOT fire again
    const fireCount2 = varUpdates.filter(u => 'tickfired' in u).length;
    if (String(firedOnce) === '1' && fireCount1 >= 1 && fireCount2 === fireCount1)
      ok('T3: trigger-authored #ticker fired server-side once and self-terminated');
    else bad('T3: runtime ticker authoring', `firedOnce=${JSON.stringify(firedOnce)} count1=${fireCount1} count2=${fireCount2}; updates=${JSON.stringify(varUpdates)}`);

    // T4: client set_tickers full-replace must NOT wipe a live server-authored runtime ticker.
    send('set_triggers', { triggers: [{ id: 'tb', pattern: '~GOCOUNT', matchType: 'tintin', enabled: true,
      actions: [{ type: 'command', command: '#ticker {t2} {#math counter $counter+1} {1}' }] }] });
    send('set_variables', { variables: { counter: 0 } });
    await sleep(400);
    send('command', { command: '__emit GOCOUNT' });    // authors a PERSISTENT runtime ticker t2
    await sleep(1700);
    const beforeReplace = Number(latest('counter'));
    send('set_tickers', { tickers: [] });               // browser replaces its ticker set (empty)
    await sleep(2300);
    const afterReplace = Number(latest('counter'));
    if (beforeReplace >= 1 && afterReplace > beforeReplace)
      ok(`T4: runtime ticker survived client set_tickers replace (counter ${beforeReplace}→${afterReplace})`);
    else bad('T4: runtime ticker preserved across set_tickers', `before=${beforeReplace} after=${afterReplace}`);

    // T5: #list create + size server-side.
    varUpdates = [];
    send('command', { command: '#list {mylist} {create} {alpha;beta;gamma}' });
    await sleep(400);
    send('command', { command: '#list {mylist} {size} {sz}' });
    await sleep(400);
    const ml = latest('mylist');
    if (ml && String(ml[1]) === 'alpha' && String(ml[3]) === 'gamma' && String(latest('sz')) === '3')
      ok('T5: #list create + size server-side (3 items)');
    else bad('T5: #list create/size', `mylist=${JSON.stringify(ml)} sz=${JSON.stringify(latest('sz'))}`);

    // T6: #list get + find server-side.
    varUpdates = [];
    send('command', { command: '#list {mylist} {get} {2} {got}' });
    send('command', { command: '#list {mylist} {find} {gamma} {fi}' });
    await sleep(500);
    if (String(latest('got')) === 'beta' && String(latest('fi')) === '3')
      ok('T6: #list get + find server-side');
    else bad('T6: #list get/find', `got=${JSON.stringify(latest('got'))} fi=${JSON.stringify(latest('fi'))}`);

    // T7: typed `#unticker {cnt*}` (wildcard) kills a RUNTIME ticker by name.
    send('set_variables', { variables: { c1: 0 } });
    send('set_triggers', { triggers: [{ id: 'tc', pattern: '~GOCNT', matchType: 'tintin', enabled: true,
      actions: [{ type: 'command', command: '#ticker {cntx} {#math c1 $c1+1} {1}' }] }] });
    await sleep(400);
    send('command', { command: '__emit GOCNT' });      // authors runtime ticker cntx
    await sleep(2300);                                  // let it fire ≥1×
    const c1Before = Number(latest('c1'));
    send('command', { command: '#unticker {cnt*}' });   // what the fixed client sends
    await sleep(400);
    const c1AtKill = Number(latest('c1'));
    await sleep(2300);                                  // must NOT fire again
    const c1After = Number(latest('c1'));
    if (c1Before >= 1 && c1After === c1AtKill)
      ok(`T7: wildcard #unticker killed the runtime ticker (c1 ${c1Before}→frozen at ${c1After})`);
    else bad('T7: wildcard #unticker on runtime ticker', `before=${c1Before} atKill=${c1AtKill} after=${c1After}`);

    // T8: trigger-body `#unticker {healme}` kills a CLIENT-SYNCED ticker (random id,
    // name in .name) and forwards a client_command so the browser drops its copy.
    send('set_variables', { variables: { c2: 0 } });
    send('set_tickers', { tickers: [{ id: 'ticker_zzz_123', name: 'healme', command: '#math c2 $c2+1', interval: 1, enabled: true }] });
    send('set_triggers', { triggers: [{ id: 'tk', pattern: '~GOKILL', matchType: 'tintin', enabled: true,
      actions: [{ type: 'command', command: '#unticker {healme}' }] }] });
    await sleep(2400);                                  // synced ticker climbs
    const c2Before = Number(latest('c2'));
    clientCmds = [];
    send('command', { command: '__emit GOKILL' });      // trigger body untickers it
    await sleep(700);
    const c2AtKill = Number(latest('c2'));
    await sleep(2300);
    const c2After = Number(latest('c2'));
    const forwarded = clientCmds.some(c => /#unticker\s*\{?healme\}?/i.test(c));
    if (c2Before >= 1 && c2After === c2AtKill && forwarded)
      ok(`T8: trigger-body #unticker killed the synced ticker by NAME + forwarded removal (c2 frozen at ${c2After})`);
    else bad('T8: #unticker on client-synced ticker', `before=${c2Before} atKill=${c2AtKill} after=${c2After} forwarded=${forwarded} cmds=${JSON.stringify(clientCmds)}`);

    // T9: runtime authoring replaces a same-NAME synced ticker (no double-fire),
    // and a client re-sync doesn't resurrect the synced copy while runtime lives.
    send('set_variables', { variables: { c3: 0, c4: 0 } });
    const dupTicker = { id: 'ticker_yyy_456', name: 'dup', command: '#math c3 $c3+1', interval: 1, enabled: true };
    send('set_tickers', { tickers: [dupTicker] });
    send('set_triggers', { triggers: [{ id: 'td', pattern: '~GODUP', matchType: 'tintin', enabled: true,
      actions: [{ type: 'command', command: '#ticker {dup} {#math c4 $c4+1} {1}' }] }] });
    await sleep(2400);                                  // synced dup climbs c3
    const c3Climbed = Number(latest('c3'));
    send('command', { command: '__emit GODUP' });       // runtime dup replaces it
    await sleep(700);
    const c3AtReplace = Number(latest('c3'));
    await sleep(2300);
    const c3After = Number(latest('c3'));
    const c4Mid = Number(latest('c4'));
    send('set_tickers', { tickers: [dupTicker] });      // client re-sync tries to resurrect
    await sleep(2400);
    const c3Final = Number(latest('c3'));
    const c4Final = Number(latest('c4'));
    if (c3Climbed >= 1 && c3After === c3AtReplace && c3Final === c3After && c4Mid >= 1 && c4Final > c4Mid)
      ok(`T9: runtime #ticker replaced same-name synced ticker + shadowed re-sync (c3 frozen at ${c3Final}, c4 ${c4Mid}→${c4Final})`);
    else bad('T9: author-replace + shadow', `c3 climbed=${c3Climbed} atReplace=${c3AtReplace} after=${c3After} final=${c3Final}; c4 mid=${c4Mid} final=${c4Final}`);

    // T10: var_query cross-check (Phase 3 step-3 precursor) — the client's #var
    // display asks the server for the authoritative value. Set one server-side,
    // then query a present and an absent name; assert the response shape.
    send('command', { command: '#var {qtest} {live}' });
    await sleep(400);
    varQueryResults = [];
    send('var_query', { name: 'qtest' });
    await sleep(400);
    send('var_query', { name: 'noSuchVar' });
    await sleep(400);
    const present = varQueryResults.find(r => r.name === 'qtest');
    const absent = varQueryResults.find(r => r.name === 'noSuchVar');
    if (present && present.defined === true && String(present.value) === 'live'
        && absent && absent.defined === false)
      ok('T10: var_query returns defined+value for a live var and defined=false for an absent one');
    else bad('T10: var_query cross-check', `present=${JSON.stringify(present)} absent=${JSON.stringify(absent)}`);

  } catch (e) {
    bad('harness', e.message);
  } finally {
    try { const db = new Database(DB_PATH); for (const tbl of ['triggers', 'aliases', 'tickers', 'entity_guard']) { try { db.prepare(`DELETE FROM ${tbl} WHERE character_id = ?`).run('sve-test-char'); } catch (e) {} } db.close(); } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}
main();
