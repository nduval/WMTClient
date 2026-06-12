/**
 * suppressSelfAlerts regression tests
 *
 * Verifies that ChatMon messages where the speaker is this session's character
 * carry suppressAlert=true on the WS payload when the global preference is on,
 * so the client skips the ding and the server skips Discord/IFTTT webhooks.
 *
 * Built 2026-05-03 as the gate for the "no alerts from messages I send myself"
 * preference. Only the dispatch flag is observable from the test harness; the
 * Discord/IFTTT skip is enforced by sharing the same `suppressAlert` decision.
 *
 * MIP CAA payload shape (parts split on '~'):
 *   parts[0] = channel id (e.g. 'mage', 'ptell')
 *   parts[1] = channel display name
 *   parts[2] = speaker name  (case may vary across channels)
 *   parts[3+] = message body
 *
 * The mock MUD's `__mip` command produces \x03TYPE\x04data\x03\x04 — a different
 * encoding than the WMT-server expects (`%99999NNN<TYPE>data`), so we emit the
 * percent-format directly via __emit and prime MIP processing with set_mip.
 *
 * Scenarios:
 *   T1: CAA from another player          → sender captured, suppressAlert=false
 *   T2: CAA from self, pref OFF          → sender captured, suppressAlert=false
 *   T3: CAA from self, pref ON           → sender captured, suppressAlert=true
 *   T4: CAA from other player, pref ON   → sender captured, suppressAlert=false
 *   T5: CAA self with case mismatch      → suppressAlert=true (case-insensitive)
 *   T6: ptell-shape "system event" with self in parts[2], pref ON → suppressAlert=true
 *       (documented trade-off — Nathan opted in to this on 2026-05-03)
 *
 * Run: node test_self_alerts.js
 */
const WebSocket = require('ws');
const crypto = require('crypto');

const WS_URL = process.argv[2] || 'ws://localhost:3000';

let ws;
let chatBuffer = []; // captured mip_chat messages
let testsPassed = 0;
let testsFailed = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function send(type, data = {}) {
  ws.send(JSON.stringify({ type, ...data }));
}
function clearBuffers() { chatBuffer = []; }

async function test(name, fn) {
  clearBuffers();
  try {
    await fn();
    testsPassed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    testsFailed++;
    console.log(`  FAIL: ${name} — ${e.message}`);
    if (chatBuffer.length > 0) {
      console.log(`    chatBuffer: ${JSON.stringify(chatBuffer)}`);
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Build a WMT-server-format MIP marker line. The server scans for
// /%(\d{5})(\d{3})([A-Z]{3})/ and treats the next `length` bytes as `data`.
// We use mipId='99999' and 3-digit length zero-padded.
function emitMipCaa(speaker, body, channel = 'mage', display = 'Mage') {
  const data = `${channel}~${display}~${speaker}~${body}`;
  const len = String(Buffer.byteLength(data, 'utf8')).padStart(3, '0');
  if (len.length !== 3) throw new Error(`MIP data too long (${len})`);
  send('command', { command: `__emit %99999${len}CAA${data}` });
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
      if (msg.type === 'mip_chat') {
        chatBuffer.push({
          chatType: msg.chatType,
          channel: msg.channel,
          sender: msg.sender,
          suppressAlert: msg.suppressAlert,
          outbound: msg.outbound,
          rawText: msg.rawText,
          ts: msg.ts
        });
      }
    } catch (e) {}
  });

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const SELF_NAME = 'Elminster';

  send('auth', { token: sessionToken, userId: 'self-alert-test', characterId: 'self-alert-char', characterName: SELF_NAME, packetPatch: 0 });
  await sleep(500);
  send('set_server', { host: 'localhost', port: 4000 });
  await sleep(500);
  send('set_aliases', { aliases: [] });
  send('set_triggers', { triggers: [] });
  send('set_variables', { variables: {} });
  send('set_functions', { functions: {} });
  // Prime MIP processing with a known mipId so percent-format markers parse.
  send('set_mip', { enabled: true, mipId: '99999' });
  await sleep(1500);
  // Mock MUD prompts for name then password
  send('command', { command: SELF_NAME });
  await sleep(500);
  send('command', { command: 'password' });
  await sleep(2000);

  // Make sure the global pref starts OFF
  send('set_discord_prefs', { channelPrefs: {}, username: SELF_NAME, iftttKey: '', suppressSelfAlerts: false });
  await sleep(300);

  // T1: CAA from another player → suppressAlert false, sender captured
  await test('T1: CAA from another player → suppressAlert=false, sender captured', async () => {
    clearBuffers();
    emitMipCaa('Frank', '[Mage(180)] Frank : hello');
    await sleep(600);
    const m = chatBuffer.find(c => c.channel === 'mage');
    assert(m, `expected a mip_chat for channel=mage, got: ${JSON.stringify(chatBuffer)}`);
    assert(m.sender === 'Frank', `sender expected 'Frank', got ${JSON.stringify(m.sender)}`);
    assert(m.suppressAlert === false, `suppressAlert expected false, got ${m.suppressAlert}`);
  });

  // T2: CAA from self, pref OFF → suppressAlert false (default behavior preserved)
  await test('T2: CAA from self, pref OFF → suppressAlert=false', async () => {
    clearBuffers();
    emitMipCaa(SELF_NAME, `[Mage(178)] ${SELF_NAME} : holy smokes`);
    await sleep(600);
    const m = chatBuffer.find(c => c.channel === 'mage');
    assert(m, 'expected a mip_chat for channel=mage');
    assert(m.sender === SELF_NAME, `sender expected '${SELF_NAME}', got ${JSON.stringify(m.sender)}`);
    assert(m.suppressAlert === false, `suppressAlert expected false (pref off), got ${m.suppressAlert}`);
  });

  // Turn pref ON for the rest
  send('set_discord_prefs', { channelPrefs: {}, username: SELF_NAME, iftttKey: '', suppressSelfAlerts: true });
  await sleep(300);

  // T3: CAA from self, pref ON → suppressAlert true
  await test('T3: CAA from self, pref ON → suppressAlert=true', async () => {
    clearBuffers();
    emitMipCaa(SELF_NAME, `[Mage(178)] ${SELF_NAME} : self message`);
    await sleep(600);
    const m = chatBuffer.find(c => c.channel === 'mage');
    assert(m, 'expected a mip_chat for channel=mage');
    assert(m.sender === SELF_NAME, `sender expected '${SELF_NAME}', got ${JSON.stringify(m.sender)}`);
    assert(m.suppressAlert === true, `suppressAlert expected true, got ${m.suppressAlert}`);
    // The chat panel must still receive the message (only the alert is suppressed)
    assert(/self message/.test(m.rawText || ''), 'rawText should still contain the body');
  });

  // T4: CAA from other player, pref ON → suppressAlert false (others still alert)
  await test('T4: CAA from other player, pref ON → suppressAlert=false', async () => {
    clearBuffers();
    emitMipCaa('Volt', 'Volt shouts: anyone want to group?', 'shout', 'Shout');
    await sleep(600);
    const m = chatBuffer.find(c => c.channel === 'shout');
    assert(m, 'expected a mip_chat for channel=shout');
    assert(m.sender === 'Volt', `sender expected 'Volt', got ${JSON.stringify(m.sender)}`);
    assert(m.suppressAlert === false, `suppressAlert expected false, got ${m.suppressAlert}`);
  });

  // T5: case-insensitive self match (ptell uses lowercase 'elminster')
  await test('T5: CAA case-insensitive self match → suppressAlert=true', async () => {
    clearBuffers();
    emitMipCaa(SELF_NAME.toLowerCase(), `[PARTY] ${SELF_NAME}: test`, 'ptell', 'Party');
    await sleep(600);
    const m = chatBuffer.find(c => c.channel === 'ptell');
    assert(m, 'expected a mip_chat for channel=ptell');
    assert(m.sender === SELF_NAME.toLowerCase(),
      `sender expected '${SELF_NAME.toLowerCase()}', got ${JSON.stringify(m.sender)}`);
    assert(m.suppressAlert === true, `suppressAlert expected true (case-insensitive), got ${m.suppressAlert}`);
  });

  // T6: ptell system event with self in parts[2] (e.g. party leader change)
  // documented trade-off: gets suppressed (Nathan opted into this on 2026-05-03)
  await test('T6: ptell system-event with self in parts[2], pref ON → suppressAlert=true', async () => {
    clearBuffers();
    emitMipCaa(SELF_NAME.toLowerCase(), '[PARTY] Lost our leader!', 'ptell', 'Party');
    await sleep(600);
    const m = chatBuffer.find(c => c.channel === 'ptell');
    assert(m, 'expected a mip_chat for channel=ptell');
    assert(m.suppressAlert === true,
      `system event with self in parts[2] should be suppressed (per agreed trade-off), got ${m.suppressAlert}`);
  });

  // T7: every mip_chat carries a numeric `ts` (epoch ms) so ChatMon's hover
  // timestamp reflects real receipt time and survives DB replay on resume.
  // Regression for: replayed history showed session-resume time, not receipt.
  await test('T7: mip_chat is stamped with a numeric receipt ts', async () => {
    clearBuffers();
    const before = Date.now();
    emitMipCaa('Frank', '[Mage(180)] Frank : timestamp check');
    await sleep(600);
    const m = chatBuffer.find(c => c.channel === 'mage');
    assert(m, `expected a mip_chat for channel=mage, got: ${JSON.stringify(chatBuffer)}`);
    assert(typeof m.ts === 'number', `ts expected a number, got ${JSON.stringify(m.ts)}`);
    // Sanity: stamped within a reasonable window of "now" (not 0, not resume-time).
    assert(m.ts >= before - 5000 && m.ts <= Date.now() + 5000,
      `ts ${m.ts} should be near now (${before}..${Date.now()})`);
  });

  ws.close();
  console.log(`\n=== Results: ${testsPassed} passed, ${testsFailed} failed ===\n`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

console.log('=== SelfAlerts ===');
runTests().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
