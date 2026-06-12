/**
 * block_trigger regression tests
 *
 * Verifies that triggers with both `blockStart` and `blockEnd` patterns
 * buffer multiple MUD lines and apply highlight actions to the joined
 * block, rather than per-line. Built 2026-05-03 to handle the ring-identify
 * "wrap across packets breaks the trigger" case.
 *
 * Scenarios:
 *   T1: Multi-line block — start, intermediate, end → all flush together,
 *       highlight applied to the joined text.
 *   T2: Block timeout — start fires but no end within 5s → buffered lines
 *       eventually flush as-is.
 *   T3: Match spanning a line break inside the block → markup is split
 *       per-line so each `mud` message has balanced <hl>...</hl>.
 *   T4: Lines outside any block pass through unchanged.
 *   T5: Block_end and block_start on the same line → 1-line block fires
 *       immediately.
 *
 * Run:    node test_block_trigger.js
 * Setup:  uses mock MUD __emit to inject multi-line content + a temporary
 *         block trigger configured via WebSocket set_triggers.
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const Database = require('/opt/wmt/node_modules/better-sqlite3');

const WS_URL = process.argv[2] || 'ws://localhost:3000';
const DB_PATH = '/opt/wmt/wmt.db';
const TIMEOUT_MS = 8000;

let ws;
let sessionToken = crypto.randomBytes(32).toString('hex');
let outputBuffer = [];   // each element: { line, ts }
let testsPassed = 0;
let testsFailed = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function send(type, data = {}) {
  ws.send(JSON.stringify({ type, ...data }));
}
function clearBuffers() { outputBuffer = []; }

async function test(name, fn) {
  clearBuffers();
  try {
    await fn();
    testsPassed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    testsFailed++;
    console.log(`  FAIL: ${name} — ${e.message}`);
    if (outputBuffer.length > 0) {
      console.log(`    Output (last 8): ${JSON.stringify(outputBuffer.slice(-8).map(o => o.line))}`);
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function lineMatches(substr) {
  return outputBuffer.some(o => o.line && o.line.includes(substr));
}

async function runTests() {
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
        outputBuffer.push({ line: msg.line || msg.text || msg.message || '', ts: Date.now() });
      }
    } catch (e) {}
  });

  // Auth + connect mock MUD
  send('auth', { token: sessionToken, userId: 'block-test', characterId: 'block-test-char', characterName: 'BlockRunner', packetPatch: 0 });
  await sleep(500);
  send('set_server', { host: 'localhost', port: 4000 });
  await sleep(500);
  send('set_aliases', { aliases: [] });
  send('set_variables', { variables: {} });
  send('set_functions', { functions: {} });
  await sleep(1500);
  send('command', { command: 'BlockRunner' });
  await sleep(500);
  send('command', { command: 'password' });
  await sleep(2000);

  // T1: Multi-line block with highlight applied to joined text
  await test('T1: Multi-line block buffers and highlights joined text', async () => {
    send('set_triggers', { triggers: [{
      id: 'blk_t1',
      pattern: '~highlightme',
      matchType: 'tintin',
      enabled: true,
      blockStart: '~^BLK_START_T1$',
      blockEnd:   '~^BLK_END_T1$',
      actions: [{ type: 'highlight', fgColor: '#ff00ff' }]
    }]});
    await sleep(300);
    clearBuffers();

    send('command', { command: '__emit BLK_START_T1' });
    await sleep(150);
    send('command', { command: '__emit middle highlightme line' });
    await sleep(150);
    // Before END arrives, none of the block lines should be visible yet.
    const preEndLines = outputBuffer.filter(o => /BLK_START_T1|highlightme|BLK_END_T1/.test(o.line));
    assert(preEndLines.length === 0,
      `Lines leaked before BLK_END_T1: ${JSON.stringify(preEndLines.map(o => o.line))}`);

    send('command', { command: '__emit BLK_END_T1' });
    await sleep(800);

    // After end, all three lines should have arrived.
    assert(lineMatches('BLK_START_T1'), 'start line missing from output');
    assert(lineMatches('BLK_END_T1'),   'end line missing from output');

    // The middle line should carry the <hl> markup
    const middle = outputBuffer.find(o => o.line.includes('highlightme'));
    assert(middle, 'middle line missing entirely');
    assert(/<hl style="[^"]*color:#ff00ff[^"]*">highlightme<\/hl>/.test(middle.line),
      `expected highlight markup in middle line, got: ${middle.line}`);
  });

  // T2: Block_end and block_start on same line → single-line block fires
  await test('T2: Single-line block fires immediately when start+end on same line', async () => {
    send('set_triggers', { triggers: [{
      id: 'blk_t2',
      pattern: '~hot',
      matchType: 'tintin',
      enabled: true,
      blockStart: '~hot one',
      blockEnd:   '~hot one',
      actions: [{ type: 'highlight', fgColor: '#00ff00' }]
    }]});
    await sleep(300);
    clearBuffers();

    send('command', { command: '__emit one hot one line' });
    await sleep(500);

    const out = outputBuffer.find(o => o.line.includes('hot'));
    assert(out, 'output line missing');
    assert(/<hl[^>]*>hot<\/hl>/.test(out.line),
      `expected hot to be highlighted, got: ${out.line}`);
  });

  // T3: Lines outside any block pass through unchanged
  await test('T3: Lines outside a block pass through unchanged', async () => {
    send('set_triggers', { triggers: [{
      id: 'blk_t3',
      pattern: '~hot',
      matchType: 'tintin',
      enabled: true,
      blockStart: '~^BLK_START_T3$',
      blockEnd:   '~^BLK_END_T3$',
      actions: [{ type: 'highlight', fgColor: '#00ff00' }]
    }]});
    await sleep(300);
    clearBuffers();

    send('command', { command: '__emit some random hot text' });
    await sleep(500);

    const out = outputBuffer.find(o => o.line.includes('hot'));
    assert(out, 'output line missing');
    assert(!/<hl/.test(out.line),
      `line outside any block should be unchanged, got: ${out.line}`);
  });

  // T4: Match spanning a line break inside the block → markup splits per-line
  await test('T4: Match with embedded \\n splits highlight wrap per line', async () => {
    // Pattern matches "alpha\nbeta" as one capture (since . won't span newlines
    // we use [\s\S] explicitly). Block buffers two lines, joined "alpha\nbeta".
    send('set_triggers', { triggers: [{
      id: 'blk_t4',
      pattern: '~alpha[\\s\\S]beta',
      matchType: 'tintin',
      enabled: true,
      blockStart: '~^BLK_START_T4$',
      blockEnd:   '~^BLK_END_T4$',
      actions: [{ type: 'highlight', fgColor: '#abcdef' }]
    }]});
    await sleep(300);
    clearBuffers();

    send('command', { command: '__emit BLK_START_T4' });
    await sleep(120);
    send('command', { command: '__emit alpha' });
    await sleep(120);
    send('command', { command: '__emit beta' });
    await sleep(120);
    send('command', { command: '__emit BLK_END_T4' });
    await sleep(700);

    // After flush, the alpha line and beta line should each carry their own
    // balanced <hl>...</hl> — no tag spans the messages.
    const alphaLine = outputBuffer.find(o => o.line.includes('alpha'));
    const betaLine  = outputBuffer.find(o => o.line.includes('beta'));
    assert(alphaLine, 'alpha line missing');
    assert(betaLine,  'beta line missing');
    // Each line should have a complete <hl>...</hl> (open and close on same line)
    const balanced = (s) => {
      const opens = (s.match(/<hl/g) || []).length;
      const closes = (s.match(/<\/hl>/g) || []).length;
      return opens === closes;
    };
    assert(balanced(alphaLine.line),
      `alpha line has unbalanced markup: ${alphaLine.line}`);
    assert(balanced(betaLine.line),
      `beta line has unbalanced markup: ${betaLine.line}`);
    assert(/<hl[^>]*>alpha<\/hl>/.test(alphaLine.line),
      `expected <hl>alpha</hl>, got: ${alphaLine.line}`);
    assert(/<hl[^>]*>beta<\/hl>/.test(betaLine.line),
      `expected <hl>beta</hl>, got: ${betaLine.line}`);
  });

  // T5: Block timeout — start fires, no end within 5s → flush as-is
  await test('T5: Block timeout flushes buffered lines unchanged', async () => {
    send('set_triggers', { triggers: [{
      id: 'blk_t5',
      pattern: '~timed',
      matchType: 'tintin',
      enabled: true,
      blockStart: '~^BLK_START_T5$',
      blockEnd:   '~^BLK_END_T5_NEVER$',  // never matched
      actions: [{ type: 'highlight', fgColor: '#999999' }]
    }]});
    await sleep(300);
    clearBuffers();

    send('command', { command: '__emit BLK_START_T5' });
    await sleep(100);
    send('command', { command: '__emit timed line' });
    // Wait > BLOCK_TIMEOUT_MS (5000ms in server.js), then send any unrelated
    // line which forces a stale-buffer flush check.
    await sleep(5500);
    send('command', { command: '__emit unrelated' });
    await sleep(500);

    // The buffered lines should have arrived (without highlight markup since
    // we timed out before the action could apply).
    assert(lineMatches('BLK_START_T5'), 'start line should have flushed after timeout');
    const timedLine = outputBuffer.find(o => o.line.includes('timed'));
    assert(timedLine, 'timed line should have flushed');
    assert(!/<hl/.test(timedLine.line),
      `timed-out lines should not have highlight markup, got: ${timedLine.line}`);
  });

  // Cleanup: clear the test trigger
  send('set_triggers', { triggers: [] });
  await sleep(200);

  // Cleanup any test-only DB rows (block-test-char if it ended up persisted)
  try {
    const db = new Database(DB_PATH);
    db.prepare('DELETE FROM triggers WHERE character_id = ?').run('block-test-char');
    db.prepare('DELETE FROM entity_guard WHERE character_id = ?').run('block-test-char');
    db.close();
  } catch (e) { /* ignore */ }

  console.log(`\n=== Results: ${testsPassed} passed, ${testsFailed} failed ===`);
  ws.close();
  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
