/**
 * WMT Alias Comparison Tests v2
 *
 * Mirrors TinTin++ test_alias, test_alias_advanced, test_alias_args, test_alias_vars
 * and verifies WMT produces matching behavior.
 *
 * Key WMT architecture note:
 * - Server expands aliases and sends resulting commands back as client_command messages
 * - #showme comes back as client_command, NOT as MUD output
 * - #var/#math run server-side inline during alias expansion (sequential execution)
 * - Aliases sync from client→server via set_aliases message
 *
 * Usage: node test_alias_compare.js [ws://host:port]
 */

const WebSocket = require('ws');
const crypto = require('crypto');

const WS_URL = process.argv[2] || 'ws://localhost:3000';

let ws;
let sessionToken = crypto.randomBytes(32).toString('hex');
let outputBuffer = [];   // MUD output, system messages
let clientCommands = [];  // client_command messages from server
let testsPassed = 0;
let testsFailed = 0;

function clearBuffers() { outputBuffer = []; clientCommands = []; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function send(type, data = {}) {
  const msg = { type, ...data };
  if (type === 'auth') msg.token = sessionToken;
  ws.send(JSON.stringify(msg));
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

// Extract text from #showme client_command messages
function getShowmeTexts() {
  return clientCommands
    .filter(c => c.command && /^#show(me)?\s/i.test(c.command))
    .map(c => {
      const m = c.command.match(/^#show(?:me)?\s+\{(.+)\}$/);
      return m ? m[1] : c.command.replace(/^#show(?:me)?\s+/, '');
    });
}

// Get raw client_command strings
function getClientCmds() {
  return clientCommands.filter(c => c.command).map(c => c.command);
}

// Check text in BOTH output buffer AND showme client commands
function hasText(text) {
  return outputBuffer.some(l => l.includes(text)) ||
    getShowmeTexts().some(l => l.includes(text));
}

// Find first matching line in either buffer
function findText(text) {
  return outputBuffer.find(l => l.includes(text)) ||
    getShowmeTexts().find(l => l.includes(text)) || null;
}

// Count matching lines across both buffers
function countText(text) {
  return outputBuffer.filter(l => l.includes(text)).length +
    getShowmeTexts().filter(l => l.includes(text)).length;
}

// Debug dump
function dump() {
  return `Output: [${outputBuffer.slice(-5).join(' | ')}] Showme: [${getShowmeTexts().join(' | ')}] Cmds: [${getClientCmds().join(' | ')}]`;
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
  }
}

async function syncAliases(aliases) { send('set_aliases', { aliases }); await sleep(400); }
async function syncVars(variables) { send('set_variables', { variables }); await sleep(400); }
async function syncFunctions(functions) { send('set_functions', { functions }); await sleep(400); }

async function runTests() {
  console.log('=== WMT Alias Comparison Tests v2 ===');
  console.log(`Connecting to ${WS_URL}...`);

  ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'mud' || msg.type === 'output' || msg.type === 'system') {
        outputBuffer.push(msg.line || msg.text || msg.message || '');
      } else if (msg.type === 'client_command') {
        clientCommands.push(msg);
      }
    } catch (e) {}
  });

  // Auth + connect to mock MUD
  send('auth', { token: sessionToken, userId: 'test-alias', characterId: 'test-char', characterName: 'AliasTest', packetPatch: 0 });
  await sleep(500);
  send('set_server', { host: 'localhost', port: 4000 });
  await sleep(500);
  send('set_aliases', { aliases: [] });
  send('set_triggers', { triggers: [] });
  send('set_variables', { variables: {} });
  send('set_functions', { functions: {} });
  await sleep(1500);
  send('command', { command: 'AliasTest' });
  await sleep(500);
  send('command', { command: 'password' });
  await sleep(2000);
  clearBuffers();

  // =============================================
  // test_alias.tin equivalents
  // =============================================
  console.log('\n--- test_alias.tin ---');

  await test('T1: Basic alias', async () => {
    await syncAliases([{ pattern: 'hello', replacement: '#showme {hello world}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'hello' });
    await sleep(500);
    assert(hasText('hello world'), `Expected 'hello world': ${dump()}`);
  });

  await test('T2: Alias with %1 wildcard', async () => {
    await syncAliases([{ pattern: 'greet %1', replacement: '#showme {greetings, %1!}', matchType: 'tintin', enabled: true }]);
    clearBuffers();
    send('command', { command: 'greet Bob' });
    await sleep(500);
    assert(hasText('greetings, Bob!'), `Expected 'greetings, Bob!': ${dump()}`);
  });

  await test('T3: Alias with %1 %2 and #math', async () => {
    await syncAliases([{ pattern: 'add %1 %2', replacement: '#math {res} {%1 + %2};#showme {%1 + %2 = $res}', matchType: 'tintin', enabled: true }]);
    await syncVars({});
    clearBuffers();
    send('command', { command: 'add 10 25' });
    await sleep(800);
    assert(hasText('10 + 25 = 35'), `Expected '10 + 25 = 35': ${dump()}`);
  });

  await test('T4: Alias overwrite', async () => {
    await syncAliases([{ pattern: 'hello', replacement: '#showme {hello overwritten}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'hello' });
    await sleep(500);
    assert(hasText('hello overwritten'), `Expected 'hello overwritten': ${dump()}`);
  });

  await test('T5: %0 captures full input text', async () => {
    await syncAliases([{ pattern: 'echo %1', replacement: '#showme {full: %0 / arg: %1}', matchType: 'tintin', enabled: true }]);
    clearBuffers();
    send('command', { command: 'echo testing this' });
    await sleep(500);
    // TinTin++: %0 = "echo testing this", %1 = "testing this"
    const line = findText('full:');
    assert(line, `Expected output with 'full:': ${dump()}`);
    console.log(`      Got: ${line}`);
    // Check %0 includes alias name
    const has0 = line.includes('full: echo testing this');
    console.log(`      %0 includes alias name: ${has0}`);
  });

  await test('T6: Alias chain (A calls B)', async () => {
    await syncAliases([
      { pattern: 'step1', replacement: '#showme {step1 done};step2', matchType: 'exact', enabled: true },
      { pattern: 'step2', replacement: '#showme {step2 done}', matchType: 'exact', enabled: true }
    ]);
    clearBuffers();
    send('command', { command: 'step1' });
    await sleep(500);
    assert(hasText('step1 done'), `Expected 'step1 done': ${dump()}`);
    assert(hasText('step2 done'), `Expected 'step2 done': ${dump()}`);
  });

  await test('T7: Alias body uses $variable', async () => {
    await syncVars({ target: 'goblin' });
    await syncAliases([{ pattern: 'attack', replacement: '#showme {attacking $target}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'attack' });
    await sleep(500);
    const line = findText('attacking');
    console.log(`      Got: ${line || getClientCmds().join(' | ')}`);
    // Expected: "attacking goblin" (var expanded at runtime)
    // If we see "attacking $target", var substitution is broken
    const expanded = hasText('attacking goblin');
    const literal = hasText('attacking $target');
    console.log(`      $target expanded: ${expanded}, literal: ${literal}`);
    assert(expanded, `$target should expand to 'goblin'`);
  });

  await test('T8: #var side effect — sequential in body', async () => {
    await syncVars({});
    await syncAliases([{ pattern: 'setx', replacement: '#var {x} {42};#showme {x is now $x}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'setx' });
    await sleep(800);
    const line = findText('x is now');
    console.log(`      Got: ${line || getClientCmds().join(' | ')}`);
    const has42 = hasText('x is now 42');
    const hasLiteral = hasText('x is now $x');
    console.log(`      $x=42: ${has42}, literal $x: ${hasLiteral}`);
    assert(has42, `Expected 'x is now 42' (sequential #var then $x expansion)`);
  });

  await test('T9: #unalias removes alias', async () => {
    await syncAliases([{ pattern: 'removeme', replacement: '#showme {should not see}', matchType: 'exact', enabled: true }]);
    await syncAliases([]); // clear all
    clearBuffers();
    send('command', { command: 'removeme' });
    await sleep(500);
    assert(!hasText('should not see'), 'Removed alias should not fire');
  });

  // =============================================
  // test_alias_advanced.tin equivalents
  // =============================================
  console.log('\n--- test_alias_advanced.tin ---');

  await test('T10: 3-step alias chain', async () => {
    await syncAliases([
      { pattern: 'chain1', replacement: '#showme {T10: step1};chain2', matchType: 'exact', enabled: true },
      { pattern: 'chain2', replacement: '#showme {T10: step2};chain3', matchType: 'exact', enabled: true },
      { pattern: 'chain3', replacement: '#showme {T10: step3}', matchType: 'exact', enabled: true }
    ]);
    clearBuffers();
    send('command', { command: 'chain1' });
    await sleep(800);
    assert(hasText('T10: step1'), 'Expected step1');
    assert(hasText('T10: step2'), 'Expected step2');
    assert(hasText('T10: step3'), 'Expected step3');
  });

  await test('T11: Alias recursion with #math counter', async () => {
    await syncVars({ rcount: '0' });
    await syncAliases([
      { pattern: 'recurse', replacement: '#math {rcount} {$rcount + 1};#if {$rcount < 5} {recurse};#showme {T11: depth=$rcount}', matchType: 'exact', enabled: true }
    ]);
    clearBuffers();
    send('command', { command: 'recurse' });
    await sleep(2000);
    const depthLines = getShowmeTexts().filter(l => l.includes('T11: depth='));
    const outLines = outputBuffer.filter(l => l.includes('T11: depth='));
    const allDepths = [...depthLines, ...outLines];
    console.log(`      Depth lines: ${allDepths.join(' | ')}`);
    // TinTin++: "depth=5" five times (each recursion level unwinds and shows)
    assert(allDepths.length > 0, `Expected depth output: ${dump()}`);
    assert(allDepths.some(l => l.includes('depth=5')), `Expected depth=5: ${allDepths.join(' | ')}`);
  });

  await test('T12: Alias overrides direction name', async () => {
    await syncAliases([{ pattern: 'north', replacement: '#showme {T12: intercepted}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'north' });
    await sleep(500);
    assert(hasText('T12: intercepted'), 'Expected north intercepted');
    // Remove and verify passthrough
    await syncAliases([]);
    clearBuffers();
    send('command', { command: 'north' });
    await sleep(500);
    assert(!hasText('T12: intercepted'), 'After removal, should not intercept');
  });

  await test('T13: $var runtime expansion in alias', async () => {
    await syncVars({ victim: 'goblin' });
    await syncAliases([{ pattern: 'autokill', replacement: '#showme {T13: killing $victim}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'autokill' });
    await sleep(500);
    const line1 = findText('T13:');
    console.log(`      With goblin: ${line1 || getClientCmds().join(' | ')}`);

    await syncVars({ victim: 'dragon' });
    clearBuffers();
    send('command', { command: 'autokill' });
    await sleep(500);
    const line2 = findText('T13:');
    console.log(`      With dragon: ${line2 || getClientCmds().join(' | ')}`);
    assert(hasText('killing dragon'), 'Expected dragon after var change');
  });

  await test('T14: $$var produces literal $var', async () => {
    await syncVars({ target: 'goblin' });
    await syncAliases([{ pattern: 'showlit', replacement: '#showme {T14: lit=$$target}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'showlit' });
    await sleep(500);
    const line = findText('T14:');
    const cmds = getClientCmds();
    console.log(`      Got line: ${line}`);
    console.log(`      Got cmds: ${cmds.join(' | ')}`);
    // TinTin++ expects: "lit=$target" (literal)
    if (line) {
      console.log(`      Shows literal: ${line.includes('lit=$target')}, expanded: ${line.includes('lit=goblin')}`);
    }
  });

  // =============================================
  // test_alias_args.tin equivalents
  // =============================================
  console.log('\n--- test_alias_args.tin ---');

  await test('T15: %1 captures single arg', async () => {
    await syncAliases([{ pattern: 'greet %1', replacement: '#showme {T15: hello %1}', matchType: 'tintin', enabled: true }]);
    clearBuffers();
    send('command', { command: 'greet World' });
    await sleep(500);
    assert(hasText('T15: hello World'), `Expected 'hello World': ${dump()}`);
  });

  await test('T16: %1 %2 captures multiple args', async () => {
    await syncAliases([{ pattern: 'attack %1 with %2', replacement: '#showme {T16: %1 using %2}', matchType: 'tintin', enabled: true }]);
    clearBuffers();
    send('command', { command: 'attack goblin with sword' });
    await sleep(500);
    assert(hasText('T16: goblin using sword'), `Expected 'goblin using sword': ${dump()}`);
  });

  await test('T17: %0 = full matched text', async () => {
    await syncAliases([{ pattern: 'mysay %0', replacement: '#showme {T17: %0}', matchType: 'tintin', enabled: true }]);
    clearBuffers();
    send('command', { command: 'mysay hello there friend' });
    await sleep(500);
    const line = findText('T17:');
    console.log(`      Got: ${line || getClientCmds().join(' | ')}`);
    // TinTin++ %0 = full matched line including alias name
    // Check what WMT gives us
  });

  await test('T18: Exact alias with trailing args', async () => {
    // In TinTin++, simple alias matches as startsWith and extra text becomes %0/%1/etc
    // WMT exact aliases should also handle this
    await syncAliases([{ pattern: 'testargs', replacement: '#showme {T18: got=%0 one=%1 two=%2}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'testargs one two three' });
    await sleep(500);
    const line = findText('T18:');
    const cmds = getClientCmds();
    console.log(`      Got line: ${line}`);
    console.log(`      Got cmds: ${cmds.join(' | ')}`);
  });

  await test('T19: No %N in body — extra args dropped', async () => {
    await syncAliases([{ pattern: 'ping', replacement: '#showme {T19: pong}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'ping extra args' });
    await sleep(500);
    // Does "ping extra args" match exact alias "ping"? WMT treats exact as exact.
    const hasPong = hasText('T19: pong');
    console.log(`      Matched: ${hasPong}, output: ${dump()}`);
  });

  await test('T20: Nested alias passes args', async () => {
    await syncAliases([
      { pattern: 'outer %1', replacement: '#showme {T20a: outer got %1};inner %1', matchType: 'tintin', enabled: true },
      { pattern: 'inner %1', replacement: '#showme {T20b: inner got %1}', matchType: 'tintin', enabled: true }
    ]);
    clearBuffers();
    send('command', { command: 'outer dragon' });
    await sleep(500);
    assert(hasText('T20a: outer got dragon'), `Expected outer got dragon: ${dump()}`);
    assert(hasText('T20b: inner got dragon'), `Expected inner got dragon: ${dump()}`);
  });

  await test('T21: Exact vs wildcard precedence', async () => {
    await syncAliases([
      { pattern: 'xact', replacement: '#showme {T21: exact}', matchType: 'exact', enabled: true },
      { pattern: 'xact %1', replacement: '#showme {T21: wild=%1}', matchType: 'tintin', enabled: true }
    ]);
    clearBuffers();
    send('command', { command: 'xact' });
    await sleep(500);
    const bare = findText('T21:');
    console.log(`      'xact' -> ${bare || getClientCmds().join(' | ')}`);

    clearBuffers();
    send('command', { command: 'xact hello' });
    await sleep(500);
    const withArg = findText('T21:');
    console.log(`      'xact hello' -> ${withArg || getClientCmds().join(' | ')}`);
    // TinTin++ expected: exact fires for both (exact alias matches prefix)
    // WMT: depends on matchType handling
  });

  // =============================================
  // test_alias_vars.tin equivalents
  // =============================================
  console.log('\n--- test_alias_vars.tin ---');

  await test('T22: $var expansion timing', async () => {
    await syncVars({ fruit: 'apple' });
    await syncAliases([{ pattern: 'showfruit', replacement: '#showme {T22: fruit=$fruit}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'showfruit' });
    await sleep(500);
    const line1 = findText('T22:');
    console.log(`      Before change: ${line1 || getClientCmds().join(' | ')}`);

    await syncVars({ fruit: 'banana' });
    clearBuffers();
    send('command', { command: 'showfruit' });
    await sleep(500);
    const line2 = findText('T22:');
    console.log(`      After change:  ${line2 || getClientCmds().join(' | ')}`);
    // WMT should expand at runtime -> banana after change
    assert(line2 && line2.includes('banana'), `Expected banana after var change`);
  });

  await test('T23: @function{} in alias body', async () => {
    await syncVars({ target: 'goblin' });
    await syncFunctions({ gettarget: { body: '#return {$target}' } });
    await syncAliases([{ pattern: 'showt', replacement: '#showme {T23: target=@gettarget{}}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'showt' });
    await sleep(500);
    const line1 = findText('T23:');
    console.log(`      With goblin: ${line1 || getClientCmds().join(' | ')}`);

    await syncVars({ target: 'dragon' });
    clearBuffers();
    send('command', { command: 'showt' });
    await sleep(500);
    const line2 = findText('T23:');
    console.log(`      With dragon: ${line2 || getClientCmds().join(' | ')}`);
    assert(line1 && line1.includes('target=goblin'), `Expected goblin via @func: ${dump()}`);
  });

  await test('T24: %%N produces literal %N', async () => {
    await syncAliases([{ pattern: 'pcttest', replacement: '#showme {T24: %%0=%%0 %%1=%%1}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'pcttest hello world' });
    await sleep(500);
    const line = findText('T24:');
    console.log(`      Got: ${line || getClientCmds().join(' | ')}`);
    // TinTin++ expected: %%N → literal %N
  });

  await test('T25: startsWith alias appends extra args', async () => {
    await syncAliases([{ pattern: 'atk', replacement: 'say attacking', matchType: 'startsWith', enabled: true }]);
    clearBuffers();
    send('command', { command: 'atk goblin' });
    await sleep(500);
    console.log(`      Output: ${outputBuffer.join(' | ')}`);
    // WMT startsWith should produce 'say attacking goblin'
    const has = outputBuffer.some(l => l.includes('attacking goblin'));
    assert(has, `Expected 'attacking goblin': ${dump()}`);
  });

  // =============================================
  // WMT-specific tests
  // =============================================
  console.log('\n--- WMT-specific ---');

  await test('T26: Alias sync timing', async () => {
    await syncAliases([{ pattern: 'synced', replacement: '#showme {T26: works}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'synced' });
    await sleep(500);
    assert(hasText('T26: works'), `Alias should be available after sync: ${dump()}`);
  });

  await test('T27: Empty sync clears all', async () => {
    await syncAliases([{ pattern: 'clearme', replacement: '#showme {T27: here}', matchType: 'exact', enabled: true }]);
    await syncAliases([]);
    clearBuffers();
    send('command', { command: 'clearme' });
    await sleep(500);
    assert(!hasText('T27: here'), 'Cleared alias should not fire');
  });

  await test('T28: Disabled alias does not fire', async () => {
    await syncAliases([{ pattern: 'disabled', replacement: '#showme {T28: nope}', matchType: 'exact', enabled: false }]);
    clearBuffers();
    send('command', { command: 'disabled' });
    await sleep(500);
    assert(!hasText('T28: nope'), 'Disabled alias should not fire');
  });

  await test('T29: Case-sensitive matching', async () => {
    await syncAliases([{ pattern: 'Hello', replacement: '#showme {T29: matched}', matchType: 'exact', enabled: true }]);
    clearBuffers();
    send('command', { command: 'Hello' });
    await sleep(500);
    assert(hasText('T29: matched'), `Hello should match: ${dump()}`);

    clearBuffers();
    send('command', { command: 'hello' });
    await sleep(500);
    assert(!hasText('T29: matched'), 'hello should NOT match Hello');
  });

  await test('T30: Priority — lower number wins', async () => {
    await syncAliases([
      { pattern: 'pritest', replacement: '#showme {T30: pri5}', matchType: 'exact', enabled: true, priority: 5 },
      { pattern: 'pritest', replacement: '#showme {T30: pri1}', matchType: 'exact', enabled: true, priority: 1 }
    ]);
    clearBuffers();
    send('command', { command: 'pritest' });
    await sleep(500);
    const lines = [...outputBuffer.filter(l => l.includes('T30:')), ...getShowmeTexts().filter(l => l.includes('T30:'))];
    console.log(`      Got: ${lines.join(' | ') || getClientCmds().join(' | ')}`);
    // Should fire only priority 1 (lower = higher priority)
  });

  // Done
  console.log(`\n=== Results: ${testsPassed} passed, ${testsFailed} failed ===`);
  ws.close();
  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
