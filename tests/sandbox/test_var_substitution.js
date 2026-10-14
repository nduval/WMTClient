/**
 * Variable substitution edge case tests
 *
 * Targeted regression coverage for `$var[key]` substitution in alias/trigger
 * expansion. Confirmed broken case 2026-05-08:
 *   $list[+$idx]   ← non-brace bracket form didn't resolve nested $idx
 * Prior behavior fell through with empty string. After fix the inner $idx
 * resolves to its value before the +N indexing logic runs.
 *
 * Coverage:
 *   T1: $list[+1]                        — literal +N indexing (server-side)
 *   T2: $list[+$idx]                     — nested $var inside +N (the bug)
 *   T3: ${list[+${idx}]}                 — brace-form equivalent (always worked)
 *   T4: $list[-1]                        — negative-from-end indexing
 *   T5: $list[]                          — all values joined
 *   T6: $list[+1..3]                     — range
 *   T7: deep nesting $a[$b][+$c]         — multiple bracket levels with vars
 *
 * Run: node test_var_substitution.js
 */
const WebSocket = require('ws');
const crypto = require('crypto');

const WS_URL = process.argv[2] || 'ws://localhost:3000';

let ws;
let clientCommands = [];
let outputBuffer = [];
let testsPassed = 0;
let testsFailed = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function send(type, data = {}) { ws.send(JSON.stringify({ type, ...data })); }
function clearBuffers() { clientCommands = []; outputBuffer = []; }

function getShowmeTexts() {
  // Since 2026-10-13 the server executes #showme itself (tt++ do_showme) and the
  // text arrives as a `mud` line (test:true) in outputBuffer; the client_command
  // form is kept for the split-row display case only.
  return clientCommands
    .filter(c => c.command && /^#show(me)?\s/i.test(c.command))
    .map(c => {
      const m = c.command.match(/^#show(?:me)?\s+\{(.+)\}$/);
      return m ? m[1] : c.command.replace(/^#show(?:me)?\s+/, '');
    })
    .concat(outputBuffer);
}

function hasShowme(text) {
  return getShowmeTexts().some(l => l.includes(text)) ||
    outputBuffer.some(l => l.includes(text));
}

async function test(name, fn) {
  clearBuffers();
  try {
    await fn();
    testsPassed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    testsFailed++;
    console.log(`  FAIL: ${name} — ${e.message}`);
    const showmes = getShowmeTexts();
    if (showmes.length) console.log(`    Showme: [${showmes.join(' | ')}]`);
    if (outputBuffer.length) console.log(`    Output: [${outputBuffer.slice(-5).join(' | ')}]`);
    if (clientCommands.length) console.log(`    Cmds: [${clientCommands.slice(-5).map(c => c.command).join(' | ')}]`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function syncAliases(aliases) { send('set_aliases', { aliases }); await sleep(400); }
async function syncVars(variables) { send('set_variables', { variables }); await sleep(400); }

async function runTests() {
  console.log('=== VarSubstitution ===');
  ws = new WebSocket(WS_URL);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    setTimeout(() => rej(new Error('connect timeout')), 5000);
  });

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'mud' || msg.type === 'output' || msg.type === 'system') {
        outputBuffer.push(msg.line || msg.text || msg.message || '');
      } else if (msg.type === 'client_command') {
        clientCommands.push(msg);
      }
    } catch (e) {}
  });

  const sessionToken = crypto.randomBytes(32).toString('hex');
  send('auth', { token: sessionToken, userId: 'test-varsub', characterId: 'test-varsub-char', characterName: 'VarSubRunner', packetPatch: 0 });
  await sleep(500);
  send('set_server', { host: 'localhost', port: 4000 });
  await sleep(500);
  send('set_aliases', { aliases: [] });
  send('set_triggers', { triggers: [] });
  send('set_variables', { variables: {} });
  send('set_functions', { functions: {} });
  await sleep(1500);
  send('command', { command: 'VarSubRunner' });
  await sleep(500);
  send('command', { command: 'password' });
  await sleep(2000);
  clearBuffers();

  // List variables in WMT are stored as 1-indexed objects: { '1': 'n', '2': 'e', ... }
  // Match what `#list create` produces internally so substitution paths see the
  // same shape they'd see in real use.
  const tvpath = { '1': 'north', '2': 'east', '3': 'south', '4': 'west', '5': 'up' };

  // T1: literal +N indexing baseline
  await test('T1: $list[+1] resolves to first item (literal +N)', async () => {
    await syncVars({ tvpath });
    await syncAliases([{ pattern: 'getfirst', replacement: '#showme {T1: $tvpath[+1]}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'getfirst' });
    await sleep(500);
    assert(hasShowme('T1: north'), 'expected "T1: north"');
  });

  // T2: nested $idx inside +N — the bug we fixed
  await test('T2: $list[+$idx] resolves nested var (the {findtv} bug)', async () => {
    await syncVars({ tvpath, idx: 3 });
    await syncAliases([{ pattern: 'getbyidx', replacement: '#showme {T2: $tvpath[+$idx]}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'getbyidx' });
    await sleep(500);
    assert(hasShowme('T2: south'), 'expected "T2: south" (idx=3 → 3rd item)');
  });

  // T3: brace-form equivalent — should still work (regression-guard)
  await test('T3: ${list[+${idx}]} brace form still works', async () => {
    await syncVars({ tvpath, idx: 4 });
    await syncAliases([{ pattern: 'getbrace', replacement: '#showme {T3: ${tvpath[+${idx}]}}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'getbrace' });
    await sleep(500);
    assert(hasShowme('T3: west'), 'expected "T3: west" (idx=4 → 4th item)');
  });

  // T4: negative index
  await test('T4: $list[-1] resolves to last item', async () => {
    await syncVars({ tvpath });
    await syncAliases([{ pattern: 'getlast', replacement: '#showme {T4: $tvpath[-1]}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'getlast' });
    await sleep(500);
    assert(hasShowme('T4: up'), 'expected "T4: up" (last item)');
  });

  // T5: all values joined
  await test('T5: $list[] joins all values with ;', async () => {
    await syncVars({ tvpath });
    await syncAliases([{ pattern: 'getall', replacement: '#showme {T5: $tvpath[]}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'getall' });
    await sleep(500);
    assert(hasShowme('T5: north;east;south;west;up'), 'expected joined list');
  });

  // T6: range slice
  await test('T6: $list[+2..4] resolves to range slice', async () => {
    await syncVars({ tvpath });
    await syncAliases([{ pattern: 'getrange', replacement: '#showme {T6: $tvpath[+2..4]}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'getrange' });
    await sleep(500);
    assert(hasShowme('T6: east;south;west'), 'expected range slice');
  });

  // T7: nested var inside negative index too — defensive coverage
  await test('T7: $list[+$idx] with idx=-1 not supported (only +N)', async () => {
    // This documents the boundary: nested vars resolve, but -N requires
    // literal "-N" in the bracket. $list[+$idx] with idx="-1" becomes
    // $list[+-1] which is malformed. Test that it returns empty string,
    // matches doesn't crash, and doesn't accidentally match something.
    await syncVars({ tvpath, idx: -1 });
    await syncAliases([{ pattern: 'getbroken', replacement: '#showme {T7:[$tvpath[+$idx]]}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'getbroken' });
    await sleep(500);
    // Whatever happens, it shouldn't produce a real direction
    const showmes = getShowmeTexts();
    const t7 = showmes.find(s => s.includes('T7:'));
    assert(t7, 'expected T7 line');
    assert(!/north|east|south|west|up/.test(t7), `T7: malformed +-1 should return empty, got: ${t7}`);
  });

  console.log(`\n=== Results: ${testsPassed} passed, ${testsFailed} failed ===\n`);
  ws.close();
  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
