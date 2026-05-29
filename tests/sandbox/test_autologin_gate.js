/**
 * Auto-login gate test (server-side) — SC4 defense-in-depth.
 *
 * The server must NOT auto-login a character on an AUTOMATIC reconnect when the
 * MUD is sitting at a name prompt (char not already logged in) — that resurrects
 * a character the user let go linkdead. Only USER-initiated connects may auto-login.
 *
 * Runs against the sandbox wmt-server in DIRECT mode (no bridge), where
 * bridgeResumed=false and mudLoggedIn=false on a fresh connect, so the gate
 * condition reduces to `session._autoReconnect`:
 *   - auth {autoReconnect:false} + set_server  → connects ("Connected to ...!")  [login proceeds]
 *   - auth {autoReconnect:true}  + set_server  → suppressed ("Connection to MUD closed.") [no resurrection]
 *
 * Backward-compat: an auth WITHOUT the flag is treated as user-initiated (the full
 * existing suite exercises that path and must stay green).
 *
 * Run: node test_autologin_gate.js [ws://localhost:3000]
 */
const WebSocket = require('ws');
const crypto = require('crypto');

const WS_URL = process.argv[2] || 'ws://localhost:3000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  PASS: ' + n); } else { fail++; console.log('  FAIL: ' + n); } };

// Connect, auth with the given autoReconnect value, request a MUD connection,
// and report which system messages arrived.
function runScenario(autoReconnect) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const sys = [];
    let done = false;
    const finish = () => { if (done) return; done = true; try { ws.close(); } catch (e) {} resolve(sys); };
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'system' && m.message) sys.push(m.message);
      } catch (e) {}
    });
    ws.on('open', async () => {
      const token = crypto.randomBytes(32).toString('hex');
      ws.send(JSON.stringify({ type: 'auth', token, userId: 'gate-test-user',
        characterId: 'gate-test-char', characterName: 'GateRunner', packetPatch: 0, autoReconnect }));
      await sleep(500);
      ws.send(JSON.stringify({ type: 'set_server', host: 'localhost', port: 4000 }));
      await sleep(2500);
      finish();
    });
    ws.on('error', () => finish());
    setTimeout(finish, 6000);
  });
}

(async () => {
  console.log('=== AutoLoginGate ===');

  const userInitiated = await runScenario(false);
  const sawConnected = userInitiated.some(m => /Connected to .*!/.test(m));
  check('user-initiated connect (autoReconnect=false) is allowed to connect/login', sawConnected);

  const auto = await runScenario(true);
  const autoSawConnected = auto.some(m => /Connected to .*!/.test(m));
  const autoSawClosed = auto.some(m => /Connection to MUD closed/.test(m));
  check('automatic reconnect (autoReconnect=true) is SUPPRESSED (no auto-login)', !autoSawConnected);
  check('automatic reconnect reports the MUD link closed', autoSawClosed);

  console.log(`=== Results: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})();
