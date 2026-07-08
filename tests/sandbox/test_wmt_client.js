/**
 * WMT Pipeline Integration Tests
 *
 * Connects to the WMT WebSocket server and tests the actual command pipeline,
 * including things TinTin++ never needs to handle:
 * - Variable sync between client/server
 * - Sequential #math in alias chains (the secbot pattern)
 * - Alias expansion with server-side variable substitution
 * - Escape sequence passthrough
 * - !command passthrough to MUD
 * - Bulk loading behavior
 *
 * Usage: node test_wmt_client.js [ws_url]
 *   Default: ws://localhost:3000
 */

const WebSocket = require('ws');
const crypto = require('crypto');

const WS_URL = process.argv[2] || 'ws://localhost:3000';
const TIMEOUT_MS = 10000;

// Test state
let ws;
let sessionToken = crypto.randomBytes(32).toString('hex'); // 64-char token like client generates
let outputBuffer = [];
let clientCommands = [];
let testsPassed = 0;
let testsFailed = 0;
let currentTest = null;

// Collect all output/client_commands for a test
function clearBuffers() {
  outputBuffer = [];
  clientCommands = [];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Send a WS message
function send(type, data = {}) {
  const msg = { type, ...data };
  // Always include token for auth and command messages
  if (type === 'auth') {
    msg.token = sessionToken;
  }
  ws.send(JSON.stringify(msg));
}

// Wait for condition on collected output, with timeout
function waitFor(conditionFn, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const result = conditionFn();
      if (result) return resolve(result);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timeout waiting for condition (${timeoutMs}ms)`));
      }
      setTimeout(check, 50);
    };
    check();
  });
}

// Wait for N output lines
function waitForOutput(n, timeoutMs = 3000) {
  return waitFor(() => outputBuffer.length >= n ? outputBuffer : null, timeoutMs);
}

// Wait for N client_command messages
function waitForClientCmd(predicate, timeoutMs = 3000) {
  return waitFor(() => {
    const found = clientCommands.find(predicate);
    return found || null;
  }, timeoutMs);
}

// Run a test
async function test(name, fn) {
  currentTest = name;
  clearBuffers();
  try {
    await fn();
    testsPassed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    testsFailed++;
    console.log(`  FAIL: ${name} — ${e.message}`);
    // Show debug info
    if (outputBuffer.length > 0) {
      console.log(`    Output: ${JSON.stringify(outputBuffer.slice(-5))}`);
    }
    if (clientCommands.length > 0) {
      console.log(`    ClientCmds: ${JSON.stringify(clientCommands.slice(-5).map(c => c.command))}`);
    }
  }
}

// Assert helper
function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ============= Tests =============

async function runTests() {
  console.log('=== WMT Pipeline Integration Tests ===');
  console.log(`Connecting to ${WS_URL}...`);

  // Connect
  ws = new WebSocket(WS_URL);

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });

  // Handle messages
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

  console.log(`Connected. Token: ${sessionToken.substring(0, 8)}...`);

  // Authenticate — client generates token, sends with auth
  send('auth', { token: sessionToken, userId: 'test-user', characterId: 'test-char', characterName: 'TestRunner', packetPatch: 0 });
  await sleep(500);

  // Tell server which MUD to connect to (mock MUD on localhost:4000)
  send('set_server', { host: 'localhost', port: 4000 });
  await sleep(500);

  // Sync empty aliases/triggers so server marks _aliasesSynced
  send('set_aliases', { aliases: [] });
  send('set_triggers', { triggers: [] });
  send('set_variables', { variables: {} });
  send('set_functions', { functions: {} });
  await sleep(1000);

  // Wait for MUD login prompt, then log in
  await sleep(1500);
  console.log(`Pre-login output: ${outputBuffer.length} lines`);
  send('command', { command: 'TestRunner' }); // name
  await sleep(500);
  send('command', { command: 'password' }); // any password
  await sleep(2000);
  console.log(`Post-login output: ${outputBuffer.length} lines`);
  if (outputBuffer.length > 0) {
    console.log(`First 3 lines: ${outputBuffer.slice(0, 3).map(l => l.substring(0, 80)).join(' | ')}`);
  }

  // === TEST SUITE ===

  // T1: Basic command passthrough
  await test('Basic command reaches MUD', async () => {
    clearBuffers();
    send('command', { command: 'look' });
    await sleep(1000);
    // Should see room description from mock MUD
    const hasRoom = outputBuffer.some(l => l.includes('Town Square') || l.includes('exits'));
    assert(hasRoom, `Expected room description, got: ${outputBuffer.slice(0, 5).join(' | ')}`);
  });

  // T2: ! command passthrough (3K background exec)
  await test('!command passes through to MUD untouched', async () => {
    clearBuffers();
    send('command', { command: '!look' });
    await sleep(500);
    // Mock MUD echoes unknown commands, should see "!look" echoed
    const hasEcho = outputBuffer.some(l => l.includes('!look'));
    assert(hasEcho, 'Expected !look to be echoed by MUD');
  });

  // T3: Semicolon splitting
  await test('Semicolons split into multiple commands', async () => {
    clearBuffers();
    send('command', { command: 'say hello;say world' });
    await sleep(500);
    const hellos = outputBuffer.filter(l => l.includes('You say:'));
    assert(hellos.length >= 2, `Expected 2 say outputs, got ${hellos.length}`);
  });

  // T4: Alias expansion
  await test('Alias expansion works', async () => {
    send('set_aliases', { aliases: [
      { pattern: 'hw', replacement: 'say hello world', matchType: 'exact', enabled: true }
    ]});
    await sleep(300);
    clearBuffers();
    send('command', { command: 'hw' });
    await sleep(500);
    const hasSay = outputBuffer.some(l => l.includes('You say: hello world'));
    assert(hasSay, 'Expected alias to expand to say hello world');
  });

  // T5: Sequential #var/#math in alias chain (THE SECBOT PATTERN)
  await test('Sequential #math in alias chain — var set before next expansion', async () => {
    // This is the critical test: #var sets a value, and the NEXT command
    // in the same alias body uses $var — it must see the updated value.
    send('set_aliases', { aliases: [
      { pattern: 'seqtest', replacement: '#var {seqstep} {1};seqdo$seqstep', matchType: 'exact', enabled: true },
      { pattern: 'seqdo1', replacement: 'say step 1 done', matchType: 'exact', enabled: true },
      { pattern: 'seqdo2', replacement: 'say step 2 WRONG', matchType: 'exact', enabled: true },
    ]});
    send('set_variables', { variables: { seqstep: '0' } });
    await sleep(300);
    clearBuffers();
    send('command', { command: 'seqtest' });
    await sleep(1000);
    const hasStep1 = outputBuffer.some(l => l.includes('step 1 done'));
    const hasStep2 = outputBuffer.some(l => l.includes('step 2 WRONG'));
    assert(hasStep1, 'Expected seqdo1 to fire (step 1 done)');
    assert(!hasStep2, 'seqdo2 should NOT fire — $seqstep should be 1 not 2');
  });

  // T6: Multi-step #math increment (rapid variable updates)
  await test('Multi-step #math increment — sequential execution', async () => {
    send('set_aliases', { aliases: [
      { pattern: 'counttest', replacement: '#math {counter} {$counter + 1};#math {counter} {$counter + 1};#math {counter} {$counter + 1};say counter is $counter', matchType: 'exact', enabled: true },
    ]});
    // Zero the counter via a SERVER-side write (typed #var), not a legacy
    // set_variables push: after a sandbox restart, restore may have merged a
    // previous run's persisted `counter` and stamped it against legacy-push
    // clobber for ~30s (review F2) — the legacy init was silently refused and
    // the test inherited stale state. A command write is always authoritative.
    send('command', { command: '#var {counter} {0}' });
    await sleep(300);
    clearBuffers();
    send('command', { command: 'counttest' });
    await sleep(1000);
    // Counter should be 3 (0 + 1 + 1 + 1), not 1 (if all expanded at once)
    const counterLine = outputBuffer.find(l => l.includes('counter is'));
    assert(counterLine, 'Expected counter output');
    assert(counterLine.includes('counter is 3'), `Expected counter=3, got: ${counterLine}`);
  });

  // T7: Escape sequences
  await test('Escape sequences preserved through pipeline', async () => {
    clearBuffers();
    send('command', { command: 'say hello\\;world' });
    await sleep(500);
    // \; should become literal ; — MUD sees "say hello;world"
    const hasSay = outputBuffer.some(l => l.includes('You say: hello;world'));
    assert(hasSay, `Expected literal semicolon in output, got: ${outputBuffer.join(' | ')}`);
  });

  // T8: $variable substitution in commands
  await test('$variable substitution in commands', async () => {
    send('set_variables', { variables: { mytarget: 'dragon' } });
    await sleep(300);
    clearBuffers();
    send('command', { command: 'say attacking $mytarget' });
    await sleep(500);
    const hasDragon = outputBuffer.some(l => l.includes('attacking dragon'));
    assert(hasDragon, 'Expected $mytarget to be substituted with dragon');
  });

  // T9: Case-sensitive alias matching
  await test('Case-sensitive alias matching', async () => {
    send('set_aliases', { aliases: [
      { pattern: 'Hello', replacement: 'say matched Hello', matchType: 'exact', enabled: true },
    ]});
    await sleep(300);
    clearBuffers();
    send('command', { command: 'Hello' });
    await sleep(500);
    const hasMatch = outputBuffer.some(l => l.includes('matched Hello'));
    assert(hasMatch, 'Expected Hello alias to match');

    clearBuffers();
    send('command', { command: 'hello' });
    await sleep(500);
    const hasWrong = outputBuffer.some(l => l.includes('matched Hello'));
    assert(!hasWrong, 'hello (lowercase) should NOT match Hello alias');
  });

  // T10: Alias with arguments
  await test('Alias with argument passthrough', async () => {
    send('set_aliases', { aliases: [
      { pattern: 'atk', replacement: 'say attacking %1 with %2', matchType: 'startsWith', enabled: true },
    ]});
    await sleep(300);
    clearBuffers();
    send('command', { command: 'atk goblin sword' });
    await sleep(500);
    // At minimum the alias should fire and produce something
    const hasSay = outputBuffer.some(l => l.includes('You say:'));
    assert(hasSay, 'Expected alias expansion to produce say command');
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
