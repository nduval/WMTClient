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
let delayLists = [];
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
        if (m.type === 'delay_list') delayLists.push(m);
      } catch (e) {}
    });

    // Seed MIP conditions in the prefs DB BEFORE auth — loadMipConditions reads
    // them at session create (T18-T20). Cleaned up in the finally block.
    try {
      const db = new Database(DB_PATH);
      // preferences.character_id has an FK to characters(id) (accounts migration);
      // the synthetic test char has no characters row — disable FKs for the seed.
      db.pragma('foreign_keys = OFF');
      db.prepare('INSERT OR REPLACE INTO preferences (character_id, data) VALUES (?, ?)').run(
        'sve-test-char',
        JSON.stringify({
          // mipConditions (camelCase) = the REAL key preferences.php writes.
          // The suite originally seeded a snake_case key that matched the
          // server bug and masked it — always seed the production shape.
          mipConditions: [
            { id: 'mc1', enabled: true, variable: 'hp_pct', operator: '<', value: '50', command: '#var mipfired yes', combatOnly: false },
            { id: 'mc2', enabled: true, variable: 'sp_pct', operator: '<', value: '30', command: '#math mipcount $mipcount+1', combatOnly: false }
          ]
        })
      );
      db.close();
    } catch (e) { console.log('  (prefs seed failed: ' + e.message + ')'); }

    // mipCond: 1 — this suite acts as a NEW client that delegates MIP-condition
    // evaluation to the server (Phase 3 Step 5b). T20 negative-controls the flag.
    send('auth', { token, userId: 'sve-test', characterId: 'sve-test-char', characterName: 'SveRunner', packetPatch: 0, mipCond: 1 });
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

    // ── Phase 3 Step 5a: delay_query — the authoritative pending-delay listing ──
    // Server delays were previously invisible (no listing existed at all).
    // T11: schedule two named delays via the command path (the same route typed
    //      lines take), then delay_query lists both with remaining>0 + command text.
    send('command', { command: '#delay {dqa} {say never-a} {600};#delay {dqb} {say never-b} {600}' });
    await sleep(400);
    delayLists = [];
    send('delay_query', { pattern: '*' });
    await sleep(400);
    let dl = delayLists[delayLists.length - 1];
    const dqa = dl && dl.delays.find(d => d.name === 'dqa');
    const dqb = dl && dl.delays.find(d => d.name === 'dqb');
    if (dqa && dqb && dqa.remaining > 500 && dqa.remaining <= 600 && dqa.command === 'say never-a' && dl.removed === null)
      ok('T11: delay_query lists scheduled delays with remaining seconds + command');
    else bad('T11: delay_query listing', JSON.stringify(dl));

    // T12: delay_query {remove:true} = typed #undelay — removes by wildcard,
    //      reports the count, and the follow-up listing is empty.
    delayLists = [];
    send('delay_query', { pattern: 'dq?', remove: true });
    await sleep(400);
    send('delay_query', { pattern: 'dq*' });
    await sleep(400);
    const rem = delayLists[0];
    const after = delayLists[1];
    if (rem && rem.removed === 2 && after && after.removed === null && after.delays.length === 0)
      ok('T12: delay_query remove:true removes by wildcard and reports count=2');
    else bad('T12: typed #undelay via delay_query', JSON.stringify(delayLists));

    // T13: inline #undelay (trigger/chain path) is now WILDCARD-capable — was
    //      exact-name-only, so `#undelay {heal*}` silently no-opped (F4-class).
    send('command', { command: '#delay {healx} {say never-c} {600};#delay {healy} {say never-d} {600};#undelay {heal*}' });
    await sleep(400);
    delayLists = [];
    send('delay_query', { pattern: 'heal*' });
    await sleep(400);
    dl = delayLists[delayLists.length - 1];
    if (dl && dl.delays.length === 0)
      ok('T13: inline #undelay wildcard removed both delays in the same chain');
    else bad('T13: inline #undelay wildcard', JSON.stringify(dl));

    // ── Phase 3 Step 5c: #loop / #foreach execute SERVER-side ──
    // Previously the last state-mutating verbs that fell through as client_command.
    const q = async (name) => {   // var_query helper: authoritative value or undefined
      varQueryResults = [];
      send('var_query', { name });
      await sleep(300);
      const r = varQueryResults.find(x => x.name === name);
      return r && r.defined ? r.value : undefined;
    };

    // T14: #loop sequential body — inner #math sees each iteration value.
    send('command', { command: '#var lsum 0;#loop {1} {3} {i} {#math lsum $lsum+$i}' });
    await sleep(500);
    const lsum = await q('lsum');
    if (String(lsum) === '6')
      ok('T14: #loop runs server-side with sequential iteration values (1+2+3=6)');
    else bad('T14: #loop server-side', `lsum=${JSON.stringify(lsum)}`);

    // T15: #foreach over a braced list.
    send('command', { command: '#var fesum 0;#foreach {{5}{7}{9}} {fe} {#math fesum $fesum+$fe}' });
    await sleep(500);
    const fesum = await q('fesum');
    if (String(fesum) === '21')
      ok('T15: #foreach braced list server-side (5+7+9=21)');
    else bad('T15: #foreach braced', `fesum=${JSON.stringify(fesum)}`);

    // T16: #foreach table form $name[%*] iterates values.
    send('command', { command: '#var {ftbl[1]} {10};#var {ftbl[2]} {20};#var tsum 0;#foreach {$ftbl[%*]} {fv} {#math tsum $tsum+$fv}' });
    await sleep(500);
    const tsum = await q('tsum');
    if (String(tsum) === '30')
      ok('T16: #foreach table form iterates values (10+20=30)');
    else bad('T16: #foreach table', `tsum=${JSON.stringify(tsum)}`);

    // T17: #break stops the loop after the current body (parity with client).
    send('command', { command: '#var bsum 0;#loop {1} {10} {i} {#math bsum $bsum+1;#if {$bsum >= 3} {#break}}' });
    await sleep(500);
    const bsum = await q('bsum');
    if (String(bsum) === '3')
      ok('T17: #break stops the loop (bsum capped at 3, not 10)');
    else bad('T17: #break', `bsum=${JSON.stringify(bsum)}`);

    // ── Phase 3 Step 5b: MIP conditions evaluated SERVER-side ──
    // Conditions were seeded in the prefs DB pre-auth; this session declared
    // mipCond:1. Prime MIP and emit an FFF stats line (the same percent-format
    // marker path SelfAlerts uses) with hp 25% → mc1 must fire server-side.
    send('set_mip', { enabled: true, mipId: '99999' });
    await sleep(300);
    const emitFFF = (data) => {
      const len = String(Buffer.byteLength(data, 'utf8')).padStart(3, '0');
      send('command', { command: `__emit %99999${len}FFF${data}` });
    };
    // T18: hp 250/1000 = 25% < 50 → mc1 fires → #var mipfired yes (server-handled).
    emitFFF('A~250~B~1000~C~500~D~500~N~0');
    await sleep(600);
    const mipfired = await q('mipfired');
    if (String(mipfired) === 'yes')
      ok('T18: MIP condition fired SERVER-side on low hp (mipfired=yes)');
    else bad('T18: server MIP condition', `mipfired=${JSON.stringify(mipfired)}`);

    // T19: 5s cooldown — mc2 (#math mipcount+1) fires once for two rapid updates.
    send('command', { command: '#var mipcount 0' });
    await sleep(300);
    emitFFF('A~250~B~1000~C~50~D~500~N~0');   // sp 10% < 30 → mc2 fires
    await sleep(300);
    emitFFF('A~250~B~1000~C~50~D~500~N~0');   // within cooldown → must NOT fire again
    await sleep(500);
    const mipcount = await q('mipcount');
    if (String(mipcount) === '1')
      ok('T19: condition cooldown — two rapid stat updates fire once (mipcount=1)');
    else bad('T19: cooldown', `mipcount=${JSON.stringify(mipcount)}`);

    // T20: THE DOUBLE-FIRE GUARD — a session whose client did NOT declare
    // mipCond at auth (old cached tab, which evaluates locally) must get NO
    // server evaluation. Same seeded conditions, same low-sp stats → mipcount 0.
    const token2 = crypto.randomBytes(32).toString('hex');
    const ws2 = new WebSocket(WS_URL);
    await new Promise((res, rej) => { ws2.on('open', res); ws2.on('error', rej); setTimeout(() => rej(new Error('ws2 timeout')), 5000); });
    let vq2 = [];
    ws2.on('message', raw => { try { const m = JSON.parse(raw.toString()); if (m.type === 'var_query_result') vq2.push(m); } catch (e) {} });
    const send2 = (type, data = {}) => ws2.send(JSON.stringify({ type, ...data }));
    send2('auth', { token: token2, userId: 'sve-test2', characterId: 'sve-test-char', characterName: 'SveRunner2', packetPatch: 0 });  // NO mipCond
    await sleep(500);
    send2('set_server', { host: 'localhost', port: 4000 });
    await sleep(800);
    send2('command', { command: 'sverunner2' });
    await sleep(500);
    send2('command', { command: 'password' });
    await sleep(500);
    send2('set_mip', { enabled: true, mipId: '99999' });
    await sleep(300);
    // Readiness handshake: the mock login sequence can race (reconnect banners
    // skip the password prompt). Retry the #var init until var_query confirms
    // the session's command path is live — THEN the emit result is meaningful.
    let s2ready = false;
    for (let attempt = 0; attempt < 5 && !s2ready; attempt++) {
      send2('command', { command: '#var mipcount 0' });
      await sleep(400);
      vq2 = [];
      send2('var_query', { name: 'mipcount' });
      await sleep(400);
      const chk = vq2.find(x => x.name === 'mipcount');
      s2ready = !!(chk && chk.defined && String(chk.value) === '0');
    }
    if (!s2ready) throw new Error('T20 session-2 never became command-ready');
    const d20 = 'A~250~B~1000~C~50~D~500~N~0';
    send2('command', { command: `__emit %99999${String(Buffer.byteLength(d20, 'utf8')).padStart(3, '0')}FFF${d20}` });
    await sleep(500);
    vq2 = [];
    send2('var_query', { name: 'mipcount' });
    await sleep(400);
    const mc20 = vq2.find(x => x.name === 'mipcount');
    if (mc20 && mc20.defined && String(mc20.value) === '0')
      ok('T20: capability gate — no mipCond at auth ⇒ server does NOT evaluate (old clients keep one brain)');
    else bad('T20: capability gate', JSON.stringify(mc20));
    try { ws2.close(); } catch (e) {}

  } catch (e) {
    bad('harness', e.message);
  } finally {
    try { const db = new Database(DB_PATH); for (const tbl of ['triggers', 'aliases', 'tickers', 'entity_guard', 'preferences']) { try { db.prepare(`DELETE FROM ${tbl} WHERE character_id = ?`).run('sve-test-char'); } catch (e) {} } db.close(); } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}
main();
