/**
 * ChatMon replay: hidden ("silenced") channels are excluded — regression tests
 *
 * 2026-07-09: 74 of elminster's 100 replayed lines were on silenced atalk, so his
 * visible channel tabs got ~26 messages after a reconnect. Fix: every reconnect
 * replay path routes through replayChatBuffer() → buildChatReplayList(), which
 * skips channels whose prefs carry hidden=true (and re-reads the DB deeper so
 * visible channels still fill the window). CAPTURE is untouched — hidden-channel
 * messages still stream live and still land in chat_messages.
 *
 * Key scheme mirrors the client: prefs keyed by channel.toLowerCase(), with a
 * legacy space-stripped variant (bug_channel_name_space_stripped) — 'bchat bard'
 * must match a pref stored under 'bchatbard'.
 *
 * Scenarios:
 *   T1: live capture unaffected — hidden-channel messages still arrive in real time
 *   T2: reconnect replay sends chat_clear first
 *   T3: replay contains every visible-channel message
 *   T4: replay contains NO hidden-channel messages
 *   T5: spaced channel matches its space-stripped pref key (hidden honored)
 *   T6: no prefs on the session → unfiltered replay (fallback = old behavior)
 *
 * Run: node test_chat_replay_hidden.js ws://localhost:3000
 */
const WebSocket = require('ws');
const crypto = require('crypto');

const WS_URL = process.argv[2] || 'ws://localhost:3000';

let testsPassed = 0;
let testsFailed = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function test(name, fn) {
  try {
    await fn();
    testsPassed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    testsFailed++;
    console.log(`  FAIL: ${name} — ${e.message}`);
  }
}

// Build a WMT-server-format MIP CAA marker (same encoding as test_self_alerts.js).
function caaLine(channel, body, speaker = 'Someone') {
  const data = `${channel}~${channel}~${speaker}~${body}`;
  const len = String(Buffer.byteLength(data, 'utf8')).padStart(3, '0');
  if (len.length !== 3) throw new Error(`MIP data too long (${len})`);
  return `__emit %99999${len}CAA${data}`;
}

function connect() {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => res(ws));
    ws.on('error', rej);
    setTimeout(() => rej(new Error('connect timeout')), 5000);
  });
}

function collector(ws) {
  const state = { live: [], replay: [], gotClear: false };
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'chat_clear') { state.gotClear = true; state.replay = []; return; }
      if (msg.type === 'mip_chat') {
        (state.gotClear ? state.replay : state.live).push({ channel: msg.channel, text: msg.text || msg.message || msg.rawText || '' });
      }
    } catch (e) {}
  });
  return state;
}

// Bring a session up on the mock MUD far enough that CAA lines are captured.
async function startSession(ws, token, charId, charName) {
  const send = (type, data = {}) => ws.send(JSON.stringify({ type, ...data }));
  send('auth', { token, userId: 'chat-replay-test', characterId: charId, characterName: charName, packetPatch: 0 });
  await sleep(400);
  send('set_server', { host: 'localhost', port: 4000 });
  await sleep(400);
  send('set_aliases', { aliases: [] });
  send('set_triggers', { triggers: [] });
  send('set_variables', { variables: {} });
  send('set_functions', { functions: {} });
  send('set_mip', { enabled: true, mipId: '99999' });
  await sleep(1500);
  send('command', { command: charName });   // mock MUD name prompt
  await sleep(400);
  send('command', { command: 'password' }); // mock MUD password prompt
  await sleep(600);
  return send;
}

async function runScenario({ withPrefs }) {
  const token = crypto.randomBytes(32).toString('hex');
  const charId = 'chat-replay-' + crypto.randomBytes(8).toString('hex');   // unique per run — keeps the DB-deepen path from seeing prior runs' rows

  const ws1 = await connect();
  const c1 = collector(ws1);
  const send = await startSession(ws1, token, charId, 'Replaytester');

  if (withPrefs) {
    send('set_discord_prefs', {
      channelPrefs: {
        atalk: { hidden: true },
        mage: {},
        bchatbard: { hidden: true },   // legacy space-stripped key for 'bchat bard'
      },
    });
    await sleep(300);
  }

  send('command', { command: caaLine('atalk', 'hidden-one') });
  send('command', { command: caaLine('mage', 'visible-one') });
  send('command', { command: caaLine('atalk', 'hidden-two') });
  send('command', { command: caaLine('bchat bard', 'hidden-spaced') });
  send('command', { command: caaLine('mage', 'visible-two') });
  await sleep(1200);

  const live = c1.live.slice();
  ws1.close();
  await sleep(600);

  // Reconnect with the same token → session resume → chat replay.
  const ws2 = await connect();
  const c2 = collector(ws2);
  ws2.send(JSON.stringify({ type: 'auth', token, userId: 'chat-replay-test', characterId: charId, characterName: 'Replaytester', packetPatch: 0 }));
  await sleep(1500);
  ws2.close();

  return { live, gotClear: c2.gotClear, replay: c2.replay };
}

async function runTests() {
  console.log('ChatMon hidden-channel replay tests\n');

  const main = await runScenario({ withPrefs: true });

  await test('T1: live capture unaffected — hidden-channel messages still stream in real time', async () => {
    const liveAtalk = main.live.filter(m => m.channel === 'atalk').length;
    const liveMage = main.live.filter(m => m.channel === 'mage').length;
    assert(liveAtalk === 2, `expected 2 live atalk, got ${liveAtalk} (live=${JSON.stringify(main.live)})`);
    assert(liveMage === 2, `expected 2 live mage, got ${liveMage}`);
  });

  await test('T2: reconnect replay sends chat_clear first', async () => {
    assert(main.gotClear, 'no chat_clear received on resume');
  });

  await test('T3: replay contains every visible-channel message', async () => {
    const mage = main.replay.filter(m => m.channel === 'mage').map(m => m.text);
    assert(mage.length === 2, `expected 2 mage messages in replay, got ${mage.length} (replay=${JSON.stringify(main.replay)})`);
    assert(mage[0].includes('visible-one') && mage[1].includes('visible-two'), `mage replay wrong/misordered: ${JSON.stringify(mage)}`);
  });

  await test('T4: replay contains NO hidden-channel messages', async () => {
    const atalk = main.replay.filter(m => m.channel === 'atalk');
    assert(atalk.length === 0, `hidden atalk leaked into replay: ${JSON.stringify(atalk)}`);
  });

  await test('T5: spaced channel matches its space-stripped pref key (hidden honored)', async () => {
    const spaced = main.replay.filter(m => m.channel === 'bchat bard');
    assert(spaced.length === 0, `'bchat bard' (pref key bchatbard) leaked into replay: ${JSON.stringify(spaced)}`);
  });

  const control = await runScenario({ withPrefs: false });

  await test('T6: no prefs on the session → unfiltered replay (fallback)', async () => {
    assert(control.gotClear, 'no chat_clear received on control resume');
    const atalk = control.replay.filter(m => m.channel === 'atalk').length;
    const mage = control.replay.filter(m => m.channel === 'mage').length;
    assert(atalk === 2 && mage === 2, `expected unfiltered 2 atalk + 2 mage, got atalk=${atalk} mage=${mage} (replay=${JSON.stringify(control.replay)})`);
  });

  console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed ? 1 : 0);
}

runTests().catch(e => {
  console.error('Test harness error:', e);
  console.log(`\nResults: ${testsPassed} passed, ${testsFailed + 1} failed`);
  process.exit(1);
});
