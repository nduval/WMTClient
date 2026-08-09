/**
 * ESP capture regression tests
 *
 * ESP is the jedi-guild telepathy skill — the MUD sends it as PLAIN game
 * text (it was never added to MIP). The server observes the output stream
 * and synthesizes a `mip_chat` message on the 'esp' channel so ESP behaves
 * exactly like a MIP chat channel downstream (ChatMon tab, replay buffer,
 * chat_messages history, Discord/IFTTT channel prefs, suppressSelfAlerts).
 *
 * Verified formats (2026-08-02, live captures from Nathan/Ukyo):
 *   inbound : Ukyo thinks . o O (  text, MUD-wrapped across indented lines  )
 *   outbound: You think to Elminster . o O (  message  )   <- sender's echo
 * `(` opens, `)` closes — always. Continuation lines are indented.
 *
 * The observer is PASSIVE: the raw lines must still render in the terminal.
 *
 * Scenarios:
 *   T1: multi-line inbound ESP → ONE mip_chat, channel=esp, sender captured,
 *       text reflowed to a single paragraph
 *   T2: raw ESP lines still render as normal `mud` output (passive tap)
 *   T3: single-line inbound ESP → captured
 *   T4: outbound echo → sender=self, outbound=true
 *   T5: outbound + suppressSelfAlerts ON → suppressAlert=true
 *   T6: negative controls — "thinks" without ". o O (" and a bare
 *       parenthesized line produce NO mip_chat
 *   T7: foreign non-indented line interrupts an open thought → partial
 *       flushed, foreign line excluded
 *   T8: closing paren never arrives → 5s safety-net flush delivers partial
 *
 * Run: node test_esp_capture.js
 */
const WebSocket = require('ws');
const crypto = require('crypto');

const WS_URL = process.argv[2] || 'ws://localhost:3000';

let ws;
let chatBuffer = [];  // captured mip_chat messages
let mudBuffer = [];   // captured mud output lines
let testsPassed = 0;
let testsFailed = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function send(type, data = {}) {
  ws.send(JSON.stringify({ type, ...data }));
}
function clearBuffers() { chatBuffer = []; mudBuffer = []; }

async function test(name, fn) {
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
    console.log(`    mudBuffer tail: ${JSON.stringify(mudBuffer.slice(-15))}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function espMsgs() { return chatBuffer.filter(c => c.channel === 'esp'); }

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
          channel: msg.channel,
          sender: msg.sender,
          suppressAlert: msg.suppressAlert,
          outbound: msg.outbound,
          rawText: msg.rawText,
          message: msg.message
        });
      } else if (msg.type === 'mud' && msg.line) {
        mudBuffer.push(msg.line);
      }
    } catch (e) {}
  });

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const SELF_NAME = 'Elminster';

  send('auth', { token: sessionToken, userId: 'esp-test', characterId: 'esp-test-char', characterName: SELF_NAME, packetPatch: 0 });
  await sleep(500);
  send('set_server', { host: 'localhost', port: 4000 });
  await sleep(500);
  send('set_aliases', { aliases: [] });
  send('set_triggers', { triggers: [] });
  send('set_variables', { variables: {} });
  send('set_functions', { functions: {} });
  await sleep(1500);
  send('command', { command: SELF_NAME });
  await sleep(500);
  send('command', { command: 'password' });
  await sleep(2000);

  // Pref starts OFF
  send('set_discord_prefs', { channelPrefs: {}, username: SELF_NAME, iftttKey: '', suppressSelfAlerts: false });
  await sleep(300);

  // T1 + T2 share one emission
  clearBuffers();
  send('command', { command: '__emit Ukyo thinks . o O (  if you decide to do some coding, and need' });
  await sleep(150);
  send('command', { command: '__emitline 11 to know what the skill is, its ESP, but it only opens up' });
  await sleep(150);
  send('command', { command: '__emitline 11 from training the jedi skill telepathy  )' });
  await sleep(800);

  await test('T1: multi-line inbound ESP → one mip_chat on esp, sender + reflowed text', async () => {
    const msgs = espMsgs();
    assert(msgs.length === 1, `expected exactly 1 esp mip_chat, got ${msgs.length}: ${JSON.stringify(msgs)}`);
    const m = msgs[0];
    assert(m.sender === 'Ukyo', `sender expected 'Ukyo', got ${JSON.stringify(m.sender)}`);
    assert(m.suppressAlert === false, `suppressAlert expected false, got ${m.suppressAlert}`);
    assert(/Ukyo thinks \. o O \(/.test(m.rawText), `rawText should keep the flavor prefix: ${m.rawText}`);
    // Reflowed: start of line 1, middle of line 2, end of line 3, one paragraph
    assert(m.rawText.includes('decide to do some coding'), `line-1 text missing: ${m.rawText}`);
    assert(m.rawText.includes('its ESP'), `line-2 text missing: ${m.rawText}`);
    assert(m.rawText.includes('telepathy )'), `line-3 text + closer missing: ${m.rawText}`);
    assert(!m.rawText.includes('\n'), 'reflowed text must not contain newlines');
    assert(!/\s\s/.test(m.rawText), `reflowed text must collapse whitespace: ${m.rawText}`);
  });

  await test('T2: raw ESP lines still render as mud output (passive tap)', async () => {
    const startLine = mudBuffer.find(l => /Ukyo thinks \. o O \(/.test(l));
    assert(startLine, `ESP start line missing from mud output: ${JSON.stringify(mudBuffer.slice(-8))}`);
    const contLine = mudBuffer.find(l => /telepathy\s+\)/.test(l));
    assert(contLine, 'ESP closing line missing from mud output');
  });

  await test('T3: single-line inbound ESP → captured', async () => {
    clearBuffers();
    send('command', { command: '__emit Ukyo thinks . o O ( hail )' });
    await sleep(600);
    const msgs = espMsgs();
    assert(msgs.length === 1, `expected 1 esp mip_chat, got ${msgs.length}`);
    assert(msgs[0].sender === 'Ukyo', `sender expected 'Ukyo', got ${JSON.stringify(msgs[0].sender)}`);
    assert(msgs[0].rawText.includes('hail'), `body missing: ${msgs[0].rawText}`);
  });

  await test('T4: outbound echo → sender=self, outbound=true', async () => {
    clearBuffers();
    send('command', { command: '__emit You think to Frank . o O (  on my way  )' });
    await sleep(600);
    const msgs = espMsgs();
    assert(msgs.length === 1, `expected 1 esp mip_chat, got ${msgs.length}`);
    const m = msgs[0];
    assert(String(m.sender).toLowerCase() === SELF_NAME.toLowerCase(),
      `sender expected '${SELF_NAME}', got ${JSON.stringify(m.sender)}`);
    assert(m.outbound === true, `outbound expected true, got ${m.outbound}`);
    assert(m.rawText.includes('You think to Frank'), `recipient should stay visible: ${m.rawText}`);
  });

  // Pref ON for T5
  send('set_discord_prefs', { channelPrefs: {}, username: SELF_NAME, iftttKey: '', suppressSelfAlerts: true });
  await sleep(300);

  await test('T5: outbound + suppressSelfAlerts ON → suppressAlert=true', async () => {
    clearBuffers();
    send('command', { command: '__emit You think to Frank . o O ( quiet one )' });
    await sleep(600);
    const msgs = espMsgs();
    assert(msgs.length === 1, `expected 1 esp mip_chat, got ${msgs.length}`);
    assert(msgs[0].suppressAlert === true, `suppressAlert expected true, got ${msgs[0].suppressAlert}`);
  });

  send('set_discord_prefs', { channelPrefs: {}, username: SELF_NAME, iftttKey: '', suppressSelfAlerts: false });
  await sleep(300);

  await test('T6: negative controls → no esp mip_chat', async () => {
    clearBuffers();
    send('command', { command: '__emit Ukyo thinks about what to code next.' });
    await sleep(300);
    send('command', { command: '__emit The sign reads ( keep out )' });
    await sleep(600);
    assert(espMsgs().length === 0, `expected 0 esp mip_chat, got: ${JSON.stringify(espMsgs())}`);
  });

  await test('T7: foreign non-indented line interrupts → partial flushed without it', async () => {
    clearBuffers();
    send('command', { command: '__emit Ukyo thinks . o O (  a thought that never' });
    await sleep(150);
    send('command', { command: '__emit You feel a disturbance in the force.' });
    await sleep(600);
    const msgs = espMsgs();
    assert(msgs.length === 1, `expected 1 partial esp mip_chat, got ${msgs.length}`);
    assert(msgs[0].rawText.includes('a thought that never'), `partial body missing: ${msgs[0].rawText}`);
    assert(!msgs[0].rawText.includes('disturbance'), `foreign line leaked into thought: ${msgs[0].rawText}`);
  });

  await test('T8: unterminated thought → 5s safety-net flush delivers partial', async () => {
    clearBuffers();
    send('command', { command: '__emit Ukyo thinks . o O (  trailing off forever' });
    await sleep(6200);
    const msgs = espMsgs();
    assert(msgs.length === 1, `expected 1 timed-out esp mip_chat, got ${msgs.length}`);
    assert(msgs[0].rawText.includes('trailing off forever'), `partial body missing: ${msgs[0].rawText}`);
  });

  ws.close();
  console.log(`\n=== Results: ${testsPassed} passed, ${testsFailed} failed ===\n`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

console.log('=== EspCapture ===');
runTests().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
