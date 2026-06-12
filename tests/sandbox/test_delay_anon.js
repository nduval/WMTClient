/**
 * WMT Server-Side Anonymous #delay Regression Tests
 *
 * Locks in the fix for the bug found 2026-05-01 where multiple chained
 * `#delay {N} {cmd}` calls all collided under name="N" and cancelled each
 * other via clearTimeout — only the LAST schedule survived.
 *
 * Server-side parser at glitch/server.js was treating dargs.length >= 2 as
 * `{name} {command} {seconds}` for ALL forms. Now: 2-arg → anonymous
 * (unique counter+timestamp name), 3-arg → named.
 *
 * Usage: node test_delay_anon.js [ws_url]
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const WS_URL = process.argv[2] || 'ws://localhost:3000';

let ws;
let sessionToken = crypto.randomBytes(32).toString('hex');
let outputBuffer = [];
let testsPassed = 0;
let testsFailed = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function send(type, data = {}) {
  const msg = { type, ...data };
  if (type === 'auth') msg.token = sessionToken;
  ws.send(JSON.stringify(msg));
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
      console.log(`    Output: ${JSON.stringify(outputBuffer.slice(-10))}`);
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
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
      if (process.env.WMT_TEST_DEBUG) console.log('  >>', msg.type, JSON.stringify(msg).substring(0, 120));
      if (msg.type === 'mud' || msg.type === 'output' || msg.type === 'system') {
        outputBuffer.push(msg.line || msg.text || msg.message || '');
      }
    } catch (e) {}
  });

  // Mirror the auth/connect flow used by test_wmt_client.js
  send('auth', { token: sessionToken, userId: 'test-user', characterId: 'test-delay', characterName: 'DelayRunner', packetPatch: 0 });
  await sleep(500);
  send('set_server', { host: 'localhost', port: 4000 });
  await sleep(500);
  send('set_aliases', { aliases: [] });
  send('set_triggers', { triggers: [] });
  send('set_variables', { variables: {} });
  send('set_functions', { functions: {} });
  await sleep(1000);
  await sleep(1500);  // wait for MUD login prompt
  send('command', { command: 'DelayRunner' });
  await sleep(500);
  send('command', { command: 'password' });
  await sleep(2000);

  // Smoke test
  clearBuffers();
  send('command', { command: 'say smoke-check' });
  await sleep(500);
  if (!outputBuffer.some(l => l.includes('smoke-check'))) {
    console.error('Smoke test FAILED — say is not making it through. Captured:');
    console.error(JSON.stringify(outputBuffer, null, 2));
    process.exit(1);
  }

  // T1: Three chained anonymous delays with the SAME numeric "seconds" arg.
  // Pre-fix: name collision under "0.3" → only last survives.
  // Post-fix: each gets unique anonymous name → all three fire.
  await test('Chained anonymous #delay {N} should all fire (no name collision)', async () => {
    send('set_aliases', { aliases: [
      { pattern: 'tripletest',
        replacement: '#delay {0.3} {say anon-first};#delay {0.3} {say anon-second};#delay {0.3} {say anon-third}',
        matchType: 'exact', enabled: true },
    ]});
    await sleep(300);
    clearBuffers();
    send('command', { command: 'tripletest' });
    await sleep(900);
    const joined = outputBuffer.join(' | ');
    assert(joined.includes('anon-first'),  `Expected "anon-first" in output. Got: ${joined}`);
    assert(joined.includes('anon-second'), `Expected "anon-second" in output. Got: ${joined}`);
    assert(joined.includes('anon-third'),  `Expected "anon-third" in output. Got: ${joined}`);
  });

  // T2: Anonymous delay uses the FIRST arg as seconds, not as a name.
  // Pre-fix: seconds defaulted to 1, ignoring the {0.3} arg.
  // Post-fix: fires after ~0.3s.
  await test('Anonymous #delay {0.3} fires after ~0.3s (not 1s default)', async () => {
    send('set_aliases', { aliases: [
      { pattern: 'fasttest', replacement: '#delay {0.3} {say fast-fired}', matchType: 'exact', enabled: true },
    ]});
    await sleep(300);
    clearBuffers();
    const t0 = Date.now();
    send('command', { command: 'fasttest' });
    // Poll for output — measure when it appears
    let firedAt = null;
    while (Date.now() - t0 < 1500) {
      if (outputBuffer.some(l => l.includes('fast-fired'))) {
        firedAt = Date.now() - t0;
        break;
      }
      await sleep(20);
    }
    assert(firedAt !== null, `Output "fast-fired" never appeared`);
    assert(firedAt < 700, `Expected fire ~300ms, got ${firedAt}ms — server defaulted to 1s (regression)`);
  });

  // T3: Named #delay {name} {cmd} {seconds} — backward compatibility.
  await test('Named #delay {name} {cmd} {seconds} still works', async () => {
    send('set_aliases', { aliases: [
      { pattern: 'namedtest', replacement: '#delay {nd} {say named-fired} {0.3}', matchType: 'exact', enabled: true },
    ]});
    await sleep(300);
    clearBuffers();
    send('command', { command: 'namedtest' });
    await sleep(800);
    const joined = outputBuffer.join(' | ');
    assert(joined.includes('named-fired'), `Named delay didn't fire. Got: ${joined}`);
  });

  // T4: #undelay {name} cancels named delay (anonymous can't be cancelled, by design).
  await test('Named #delay can be cancelled by #undelay {name}', async () => {
    send('set_aliases', { aliases: [
      { pattern: 'canceltest',
        replacement: '#delay {ct} {say SHOULD-NOT-FIRE} {0.3};#undelay {ct}',
        matchType: 'exact', enabled: true },
    ]});
    await sleep(300);
    clearBuffers();
    send('command', { command: 'canceltest' });
    await sleep(800);
    const joined = outputBuffer.join(' | ');
    assert(!joined.includes('SHOULD-NOT-FIRE'), `Cancelled delay still fired. Got: ${joined}`);
  });

  // T5: Cooldown reminders longer than 5 minutes must not be silently clamped.
  // History: from 2026-04-11 (when server-side #delay was first implemented)
  // until 2026-05-03, the parser did `Math.min(seconds, 300)`, capping ALL
  // delays at 5 minutes. Nathan's #delay {Smurfs} {...} {3600} fired at 5min
  // instead of 1hr. Cap now 86400s (24h). This test source-checks server.js
  // because verifying behaviorally would need a >300s test wait.
  await test('Server source has no 300s #delay cap (regression check)', async () => {
    const fs = require('fs');
    const src = fs.readFileSync('/opt/wmt/server.js', 'utf8');
    assert(!/Math\.min\(seconds,\s*300\)/.test(src),
      'Found Math.min(seconds, 300) in server.js — re-introduces the 5-minute #delay cap that broke cooldown timers (see commit history 2026-04-11 → 2026-05-03)');
    assert(/Math\.min\(seconds,\s*86400\)/.test(src),
      'Expected Math.min(seconds, 86400) — the 24h #delay cap. If you intentionally changed it, update this test.');
  });

  console.log(`\n=== Results: ${testsPassed} passed, ${testsFailed} failed ===`);
  ws.close();
  process.exit(testsFailed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
