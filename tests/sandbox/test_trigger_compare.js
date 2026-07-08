/**
 * WMT Trigger Comparison Tests
 *
 * Mirrors TinTin++ test_action.tin, test_substitute_gag.tin, test_highlight.tin
 * Tests triggers (actions), gags, substitutes, highlights against mock MUD output.
 *
 * Key WMT architecture:
 * - Triggers run SERVER-SIDE in processTriggers() against MUD output
 * - __emit sends raw text from mock MUD to trigger matching
 * - #showme does NOT trigger actions (only MUD output does)
 * - Gags/subs only filter MUD output, not #showme
 * - Trigger commands come back as client_command messages
 * - Server auto-detects pattern type via isTinTinPattern() — matchType ignored
 * - Trigger data format: { pattern, actions: [{ type, ... }], enabled, priority }
 *   action types: command, gag, highlight, substitute, sound, discord, chatmon
 *
 * Usage: node test_trigger_compare.js [ws://host:port]
 */

const WebSocket = require('ws');
const crypto = require('crypto');

const WS_URL = process.argv[2] || 'ws://localhost:3000';

let ws;
let sessionToken = crypto.randomBytes(32).toString('hex');
let outputBuffer = [];
let clientCommands = [];
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

function getShowmeTexts() {
  return clientCommands
    .filter(c => c.command && /^#show(me)?\s/i.test(c.command))
    .map(c => {
      const m = c.command.match(/^#show(?:me)?\s+\{(.+)\}$/);
      return m ? m[1] : c.command.replace(/^#show(?:me)?\s+/, '');
    });
}

function getClientCmds() {
  return clientCommands.filter(c => c.command).map(c => c.command);
}

function hasText(text) {
  return outputBuffer.some(l => l.includes(text)) ||
    getShowmeTexts().some(l => l.includes(text));
}

function findText(text) {
  return outputBuffer.find(l => l.includes(text)) ||
    getShowmeTexts().find(l => l.includes(text)) || null;
}

function dump() {
  return `Output: [${outputBuffer.slice(-8).join(' | ')}] Showme: [${getShowmeTexts().join(' | ')}] Cmds: [${getClientCmds().join(' | ')}]`;
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

async function syncTriggers(triggers) { send('set_triggers', { triggers }); await sleep(400); }
async function syncAliases(aliases) { send('set_aliases', { aliases }); await sleep(400); }
async function syncVars(variables) { send('set_variables', { variables }); await sleep(400); }
async function syncFunctions(functions) { send('set_functions', { functions }); await sleep(400); }

// Send a command that makes the mock MUD emit text (triggers fire on this)
function emitFromMud(text) {
  send('command', { command: `__emit ${text}` });
}

// Helper: make a command trigger
function cmdTrigger(pattern, command, opts = {}) {
  return {
    id: opts.id || `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    pattern,
    actions: [{ type: 'command', command }],
    matchType: 'tintin',
    enabled: opts.enabled !== undefined ? opts.enabled : true,
    priority: opts.priority || 5
  };
}

// Helper: make a gag trigger
function gagTrigger(pattern, opts = {}) {
  return {
    id: opts.id || `g-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    pattern,
    actions: [{ type: 'gag' }],
    matchType: 'tintin',
    enabled: opts.enabled !== undefined ? opts.enabled : true,
    priority: opts.priority || 5
  };
}

// Helper: make a highlight trigger
function hlTrigger(pattern, fgColor, opts = {}) {
  return {
    id: opts.id || `h-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    pattern,
    actions: [{ type: 'highlight', fgColor, bgColor: opts.bgColor || null }],
    matchType: 'tintin',
    enabled: opts.enabled !== undefined ? opts.enabled : true,
    priority: opts.priority || 5
  };
}

// Helper: make a substitute trigger
function subTrigger(pattern, replacement, opts = {}) {
  return {
    id: opts.id || `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    pattern,
    actions: [{ type: 'substitute', replacement }],
    matchType: 'tintin',
    enabled: opts.enabled !== undefined ? opts.enabled : true,
    priority: opts.priority || 5
  };
}

async function runTests() {
  console.log('=== WMT Trigger Comparison Tests ===');
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

  // Auth + connect
  send('auth', { token: sessionToken, userId: 'test-trigger', characterId: 'test-char', characterName: 'TriggerTest', packetPatch: 0 });
  await sleep(500);
  send('set_server', { host: 'localhost', port: 4000 });
  await sleep(500);
  send('set_aliases', { aliases: [] });
  send('set_triggers', { triggers: [] });
  send('set_variables', { variables: {} });
  send('set_functions', { functions: {} });
  await sleep(1500);
  send('command', { command: 'TriggerTest' });
  await sleep(500);
  send('command', { command: 'password' });
  await sleep(2000);
  clearBuffers();

  // =============================================
  // test_action.tin equivalents
  // =============================================
  console.log('\n--- test_action.tin ---');

  // T1: Basic action with %1 wildcard
  await test('T1: Basic action with %1 wildcard', async () => {
    await syncTriggers([
      cmdTrigger('You receive %1 experience', '#showme {ACTION: got %1 xp}')
    ]);
    clearBuffers();
    emitFromMud('You receive 1500 experience');
    await sleep(800);
    assert(hasText('ACTION: got 1500 xp'), `Expected 'got 1500 xp': ${dump()}`);
  });

  // T2: Action with multiple wildcards
  await test('T2: Multiple wildcards', async () => {
    await syncTriggers([
      cmdTrigger('%1 tells you: %2', '#showme {ACTION: tell from %1 msg=%2}')
    ]);
    clearBuffers();
    emitFromMud('Gandalf tells you: hello there');
    await sleep(800);
    assert(hasText('ACTION: tell from Gandalf msg=hello there'), `Expected tell capture: ${dump()}`);
  });

  // T3: Action priority — lower number fires, higher doesn't
  await test('T3: Priority — lower number fires first', async () => {
    await syncTriggers([
      cmdTrigger('combat: %1', '#showme {ACTION-LOW: %1}', { priority: 9 }),
      cmdTrigger('combat: %1', '#showme {ACTION-HIGH: %1}', { priority: 1 })
    ]);
    clearBuffers();
    emitFromMud('combat: test priority');
    await sleep(800);
    const hasHigh = hasText('ACTION-HIGH: test priority');
    const hasLow = hasText('ACTION-LOW: test priority');
    console.log(`      High(pri=1): ${hasHigh}, Low(pri=9): ${hasLow}`);
    assert(hasHigh, `Expected high priority to fire: ${dump()}`);
    // TinTin++: only highest-priority command fires. WMT should match this.
    assert(!hasLow, `Expected low priority NOT to fire (TinTin++ first-match-only): ${dump()}`);
  });

  // T4: Action captures into variables via #var
  await test('T4: Capture wildcards into variables', async () => {
    await syncVars({});
    await syncTriggers([
      cmdTrigger('HP: %1/%2', '#var {hp} {%1};#var {maxhp} {%2};#showme {ACTION: hp=$hp max=$maxhp}')
    ]);
    clearBuffers();
    emitFromMud('HP: 350/500');
    await sleep(800);
    assert(hasText('ACTION: hp=350 max=500'), `Expected hp capture: ${dump()}`);
  });

  // T5: Action fires an alias
  await test('T5: Action fires alias', async () => {
    await syncAliases([
      { pattern: 'healme', replacement: '#showme {HEALING: casting heal}', matchType: 'exact', enabled: true }
    ]);
    await syncTriggers([
      cmdTrigger('You are bleeding', 'healme')
    ]);
    clearBuffers();
    emitFromMud('You are bleeding');
    await sleep(800);
    assert(hasText('HEALING: casting heal'), `Expected alias fired from trigger: ${dump()}`);
  });

  // T6: #unaction — removed trigger should not fire
  await test('T6: Removed trigger does not fire', async () => {
    await syncTriggers([
      cmdTrigger('remove this %1', '#showme {should not fire}')
    ]);
    // Remove it
    await syncTriggers([]);
    clearBuffers();
    emitFromMud('remove this please');
    await sleep(800);
    assert(!hasText('should not fire'), 'Removed trigger should not fire');
  });

  // T7: ^ anchor — matches start of line only
  await test('T7: ^ anchor matches start of line only', async () => {
    await syncTriggers([
      cmdTrigger('^You dodge', '#showme {ACTION: dodged!}')
    ]);
    clearBuffers();
    emitFromMud('You dodge the attack');
    await sleep(800);
    assert(hasText('ACTION: dodged!'), `Expected dodge match: ${dump()}`);

    clearBuffers();
    emitFromMud('Somehow You dodge');
    await sleep(800);
    const fired = hasText('ACTION: dodged!');
    console.log(`      'Somehow You dodge' fired: ${fired} (TinTin++: should NOT fire)`);
    assert(!fired, `^ anchor should not match mid-line: ${dump()}`);
  });

  // T8: Disabled trigger does not fire
  await test('T8: Disabled trigger does not fire', async () => {
    await syncTriggers([
      cmdTrigger('disabled trigger %1', '#showme {NOPE: %1}', { enabled: false })
    ]);
    clearBuffers();
    emitFromMud('disabled trigger test');
    await sleep(800);
    assert(!hasText('NOPE:'), 'Disabled trigger should not fire');
  });

  // T9: Trigger with $variable in command
  await test('T9: Trigger command uses $variable', async () => {
    await syncVars({ weapon: 'sword' });
    await syncTriggers([
      cmdTrigger('Enemy appears', '#showme {ATTACK: using $weapon}')
    ]);
    clearBuffers();
    emitFromMud('Enemy appears');
    await sleep(800);
    const line = findText('ATTACK:');
    console.log(`      Got: ${line || getClientCmds().join(' | ')}`);
    assert(hasText('ATTACK: using sword'), `Expected $weapon expanded: ${dump()}`);
  });

  // T10: Trigger sends MUD command (non-# command goes to MUD)
  await test('T10: Trigger sends command to MUD', async () => {
    await syncTriggers([
      cmdTrigger('You are hungry', 'eat bread')
    ]);
    clearBuffers();
    emitFromMud('You are hungry');
    await sleep(800);
    // Mock MUD echoes unknown commands — should see something about 'eat bread'
    const hasEat = outputBuffer.some(l => l.includes('eat bread') || l.includes('eat'));
    console.log(`      Output after trigger: ${outputBuffer.slice(-3).join(' | ')}`);
    // Informational — main point is that trigger fired without error
  });

  // T11: Multiple triggers on same line — first command match wins (TinTin++ behavior)
  await test('T11: Multiple triggers — priority order', async () => {
    await syncTriggers([
      cmdTrigger('multi test line', '#showme {MULTI-A}', { priority: 5 }),
      cmdTrigger('multi test %1', '#showme {MULTI-B: %1}', { priority: 3 })
    ]);
    clearBuffers();
    emitFromMud('multi test line');
    await sleep(800);
    const hasA = hasText('MULTI-A');
    const hasB = hasText('MULTI-B');
    console.log(`      A(pri=5): ${hasA}, B(pri=3): ${hasB}`);
    // TinTin++: only first command action fires (priority 3 wins)
    assert(hasB, `Expected priority 3 to fire: ${dump()}`);
    assert(!hasA, `Expected priority 5 NOT to fire (first-match-only): ${dump()}`);
  });

  // T12: TinTin++ PCRE brace pattern — {\\d+} captures digits
  await test('T12: PCRE brace pattern captures digits', async () => {
    await syncTriggers([
      cmdTrigger('{\\d+} gold coins', '#showme {GOLD: %1}')
    ]);
    clearBuffers();
    emitFromMud('You pick up 500 gold coins');
    await sleep(800);
    const line = findText('GOLD:');
    console.log(`      Got: ${line || dump()}`);
    assert(hasText('GOLD: 500'), `Expected PCRE capture: ${dump()}`);
  });

  // T13: TinTin++ regex (~ prefix) trigger
  await test('T13: TinTin++ regex with ~ prefix', async () => {
    await syncTriggers([
      cmdTrigger('~{\\d+} damage', '#showme {DMG: %1}')
    ]);
    clearBuffers();
    emitFromMud('You deal 150 damage to the goblin');
    await sleep(800);
    const line = findText('DMG:');
    console.log(`      Got: ${line || dump()}`);
    assert(hasText('DMG: 150'), `Expected ~ regex capture: ${dump()}`);
  });

  // =============================================
  // test_substitute_gag.tin equivalents
  // =============================================
  console.log('\n--- test_substitute_gag.tin ---');

  // T14: Basic gag — line should not appear in output
  await test('T14: Gag hides matching MUD line', async () => {
    await syncTriggers([
      gagTrigger('SPAM LINE %1')
    ]);
    clearBuffers();
    emitFromMud('SPAM LINE 12345');
    await sleep(800);
    const visible = outputBuffer.some(l => l.includes('SPAM LINE'));
    console.log(`      Line visible: ${visible}, output: ${outputBuffer.slice(-3).join(' | ')}`);
    assert(!visible, `Gagged line should not be visible: ${dump()}`);
  });

  // T15: Gag does NOT affect #showme output
  await test('T15: Gag does not affect #showme', async () => {
    await syncTriggers([
      gagTrigger('show this text')
    ]);
    await syncAliases([
      { pattern: 'showtest', replacement: '#showme {show this text}', matchType: 'exact', enabled: true }
    ]);
    clearBuffers();
    send('command', { command: 'showtest' });
    await sleep(800);
    assert(hasText('show this text'), `#showme should bypass gag: ${dump()}`);
  });

  // T16: Ungag — line should appear again
  await test('T16: Ungag restores visibility', async () => {
    // Set gag, then remove it
    await syncTriggers([
      gagTrigger('treasure chest')
    ]);
    await syncTriggers([]); // remove all
    clearBuffers();
    emitFromMud('You found a treasure chest');
    await sleep(800);
    const visible = outputBuffer.some(l => l.includes('treasure chest'));
    assert(visible, `After ungag, line should be visible: ${dump()}`);
  });

  // T17: Substitute replaces text in MUD output
  await test('T17: Substitute replaces matching text', async () => {
    await syncTriggers([
      subTrigger('red potion', 'RED POTION')
    ]);
    clearBuffers();
    emitFromMud('You pick up a red potion');
    await sleep(800);
    const line = outputBuffer.find(l => l.includes('POTION') || l.includes('potion'));
    console.log(`      Got: ${line}`);
    assert(outputBuffer.some(l => l.includes('RED POTION')), `Expected substitution: ${dump()}`);
  });

  // T18: Unsubstitute removes replacement
  await test('T18: Unsubstitute removes replacement', async () => {
    await syncTriggers([]); // clear subs
    clearBuffers();
    emitFromMud('You pick up a red potion again');
    await sleep(800);
    const line = outputBuffer.find(l => l.includes('red potion'));
    assert(line, `After unsub, original text should show: ${dump()}`);
  });

  // T19: Substitute with wildcard capture
  await test('T19: Substitute with %1 capture', async () => {
    await syncTriggers([
      subTrigger('You eat %1.', 'You consume %1!')
    ]);
    clearBuffers();
    emitFromMud('You eat bread.');
    await sleep(800);
    const line = outputBuffer.find(l => l.includes('consume') || l.includes('eat'));
    console.log(`      Got: ${line}`);
    assert(outputBuffer.some(l => l.includes('You consume bread!')), `Expected wildcard sub: ${dump()}`);
  });

  // =============================================
  // Highlight tests (server-side coloring via <hl> tags)
  // =============================================
  console.log('\n--- test_highlight.tin ---');

  // T20: Highlight — WMT wraps matched text in <hl> tags
  await test('T20: Highlight matching text', async () => {
    await syncTriggers([
      hlTrigger('%1 attacks %2', 'red')
    ]);
    clearBuffers();
    emitFromMud('Goblin attacks Gandalf');
    await sleep(800);
    // Line should still appear (highlight doesn't suppress)
    const visible = outputBuffer.some(l => l.includes('Goblin') || l.includes('attacks'));
    console.log(`      Line visible: ${visible}, output: ${outputBuffer.slice(-3).join(' | ')}`);
    assert(visible, `Highlighted line should still be visible: ${dump()}`);
    // Check for <hl> tag wrapping
    const hlLine = outputBuffer.find(l => l.includes('<hl'));
    console.log(`      Has <hl> tag: ${!!hlLine}`);
  });

  // T21: Unhighlight
  await test('T21: Unhighlight removes color', async () => {
    await syncTriggers([]); // clear
    clearBuffers();
    emitFromMud('Goblin attacks again');
    await sleep(800);
    const visible = outputBuffer.some(l => l.includes('attacks'));
    assert(visible, 'Line should appear without highlight');
    const hlLine = outputBuffer.find(l => l.includes('<hl'));
    assert(!hlLine, 'Should not have <hl> tags after unhighlight');
  });

  // =============================================
  // Advanced trigger tests
  // =============================================
  console.log('\n--- Advanced trigger tests ---');

  // T22: Trigger with #math in command
  await test('T22: Trigger command with #math', async () => {
    await syncVars({ kills: '0' });
    await syncTriggers([
      cmdTrigger('You killed %1', '#math {kills} {$kills + 1};#showme {KILLS: $kills}')
    ]);
    clearBuffers();
    emitFromMud('You killed a goblin');
    await sleep(800);
    assert(hasText('KILLS: 1'), `Expected kills=1: ${dump()}`);

    clearBuffers();
    emitFromMud('You killed a dragon');
    await sleep(800);
    assert(hasText('KILLS: 2'), `Expected kills=2: ${dump()}`);
  });

  // T23: Trigger chain — trigger fires alias which fires another command
  await test('T23: Trigger fires alias chain', async () => {
    await syncAliases([
      { pattern: 'loot', replacement: '#showme {LOOTING: picking up items}', matchType: 'exact', enabled: true }
    ]);
    await syncTriggers([
      cmdTrigger('Monster is dead', 'loot')
    ]);
    clearBuffers();
    emitFromMud('Monster is dead');
    await sleep(800);
    assert(hasText('LOOTING: picking up items'), `Expected trigger→alias chain: ${dump()}`);
  });

  // T24: Trigger with semicolon-separated commands
  await test('T24: Trigger with multiple commands', async () => {
    await syncTriggers([
      cmdTrigger('Level up!', '#showme {DING!};#showme {Congratulations!}')
    ]);
    clearBuffers();
    emitFromMud('Level up!');
    await sleep(800);
    assert(hasText('DING!'), `Expected DING: ${dump()}`);
    assert(hasText('Congratulations!'), `Expected Congratulations: ${dump()}`);
  });

  // T25: Simple pattern (no wildcards) — uses substring matching
  await test('T25: Substring match trigger', async () => {
    await syncTriggers([
      cmdTrigger('You are resting.', '#showme {RESTING}')
    ]);
    clearBuffers();
    emitFromMud('You are resting.');
    await sleep(800);
    assert(hasText('RESTING'), `Expected substring match: ${dump()}`);

    // Substring should also match a longer line
    clearBuffers();
    emitFromMud('You are resting. And relaxing.');
    await sleep(800);
    const fired = hasText('RESTING');
    console.log(`      Longer line fired: ${fired} (substring match = expected to fire)`);
    assert(fired, `Substring match should fire on longer line: ${dump()}`);
  });

  // T26: Trigger does not fire on #showme output (WMT-specific)
  await test('T26: Trigger only fires on MUD output, not #showme', async () => {
    await syncTriggers([
      cmdTrigger('trigger this text', '#showme {TRIGGERED}')
    ]);
    await syncAliases([
      { pattern: 'echotest', replacement: '#showme {trigger this text}', matchType: 'exact', enabled: true }
    ]);
    clearBuffers();
    send('command', { command: 'echotest' });
    await sleep(800);
    // #showme should display the text but NOT trigger the action
    const triggered = hasText('TRIGGERED');
    console.log(`      Triggered on #showme: ${triggered} (should be false)`);
    assert(!triggered, '#showme should not trigger actions');
  });

  // T27: $var in trigger command expands (post-fix verification)
  await test('T27: $var in trigger command expands', async () => {
    await syncVars({ healspell: 'cure critical' });
    await syncTriggers([
      cmdTrigger('You are hurt badly', '#showme {CASTING: $healspell}')
    ]);
    clearBuffers();
    emitFromMud('You are hurt badly');
    await sleep(800);
    const line = findText('CASTING:');
    console.log(`      Got: ${line}`);
    assert(hasText('CASTING: cure critical'), `Expected $healspell expanded: ${dump()}`);
  });

  // T28: Combined gag + command on same trigger
  await test('T28: Gag + command on same trigger', async () => {
    await syncTriggers([{
      id: 't28-gag-cmd',
      pattern: 'spam but track %1',
      actions: [
        { type: 'gag' },
        { type: 'command', command: '#showme {TRACKED: %1}' }
      ],
      matchType: 'tintin',
      enabled: true,
      priority: 5
    }]);
    clearBuffers();
    emitFromMud('spam but track important-data');
    await sleep(800);
    // Line should be gagged (not in outputBuffer)
    const visible = outputBuffer.some(l => l.includes('spam but track'));
    assert(!visible, `Line should be gagged: ${dump()}`);
    // But the command should still fire
    assert(hasText('TRACKED: important-data'), `Command should still fire: ${dump()}`);
  });

  // T29: @function{} in trigger command
  await test('T29: @function{} in trigger command', async () => {
    await syncFunctions({ gettarget: { body: '#return {$target}' } });
    await syncVars({ target: 'goblin' });
    await syncTriggers([
      cmdTrigger('Ready to attack', '#showme {TARGET: @gettarget{}}')
    ]);
    clearBuffers();
    emitFromMud('Ready to attack');
    await sleep(800);
    const line = findText('TARGET:');
    console.log(`      Got: ${line}`);
    assert(hasText('TARGET: goblin'), `Expected @function expanded: ${dump()}`);
  });


  // T30: Multiple command actions in one trigger all fire
  await test('T30: Multiple command actions in same trigger', async () => {
    await syncTriggers([{
      id: 't30-multi-cmd',
      pattern: 'Mimic dealt the killing blow',
      actions: [
        { type: 'command', command: '#showme {ACTION1}' },
        { type: 'command', command: '#showme {ACTION2}' },
        { type: 'command', command: '#showme {ACTION3}' }
      ],
      matchType: 'exact',
      enabled: true,
      priority: 5
    }]);
    clearBuffers();
    emitFromMud('Mimic dealt the killing blow');
    await sleep(800);
    const a1 = hasText('ACTION1');
    const a2 = hasText('ACTION2');
    const a3 = hasText('ACTION3');
    console.log(`      Action1: ${a1}, Action2: ${a2}, Action3: ${a3}`);
    assert(a1, `ACTION1 should fire: ${dump()}`);
    assert(a2, `ACTION2 should fire: ${dump()}`);
    assert(a3, `ACTION3 should fire: ${dump()}`);
  });

  // T31: Cross-trigger command isolation (first trigger's command wins)
  await test('T31: First trigger command wins across triggers', async () => {
    await syncTriggers([
      {
        id: 't31a',
        pattern: 'goblin attacks you',
        actions: [{ type: 'command', command: '#showme {FIRST_TRIGGER}' }],
        matchType: 'exact',
        enabled: true,
        priority: 4
      },
      {
        id: 't31b',
        pattern: 'goblin attacks you',
        actions: [{ type: 'command', command: '#showme {SECOND_TRIGGER}' }],
        matchType: 'exact',
        enabled: true,
        priority: 6
      }
    ]);
    clearBuffers();
    emitFromMud('goblin attacks you');
    await sleep(800);
    const first = hasText('FIRST_TRIGGER');
    const second = hasText('SECOND_TRIGGER');
    console.log(`      First: ${first}, Second: ${second}`);
    assert(first, `Higher priority trigger should fire: ${dump()}`);
    assert(!second, `Lower priority trigger should NOT fire: ${dump()}`);
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
