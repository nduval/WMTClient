/**
 * Login-conflict + reconnect-dedup test (client-side) — guards the #4 hardening for
 * the 2026-06-02 deploy lockout (docs/connection-issues/005).
 *
 * Loads the REAL assets/js/app.js (WMTClient) and assets/js/connection.js
 * (MudConnection) into vm sandboxes and exercises the actual prototype methods:
 *   - a MUD "currently logged in and active" line trips handleActiveLoginConflict
 *   - that stops auto-login: loginBlocked=true, password is NOT auto-sent, and the
 *     connection's auto-reconnect is gated (mudLinkDead=true)
 *   - a user-initiated reconnect() clears loginBlocked
 *   - connection.connect() won't stack sockets while one is OPEN or CONNECTING
 *
 * Run: node test_login_conflict.js [/path/to/app.js] [/path/to/connection.js]
 */
const fs = require('fs');
const vm = require('vm');

const args = process.argv.slice(2).filter(a => !a.startsWith('ws'));
const APP_JS = args[0] || '/opt/wmt/assets/js/app.js';
const CONNECTION_JS = args[1] || '/opt/wmt/assets/js/connection.js';

function loadWMTClient() {
  const noop = () => {};
  const fakeEl = new Proxy({}, { get: () => noop });
  const sandbox = {
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, createElement: () => fakeEl, body: fakeEl },
    window: { location: { hostname: 'localhost' }, addEventListener: noop, WMT_CONFIG: {} },
    navigator: { userAgent: 'test' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    WebSocket: function () {}, setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    console, JSON, Date, Math,
  };
  vm.createContext(sandbox);
  const raw = fs.readFileSync(APP_JS, 'utf8');
  return vm.runInContext('(function(){\n' + raw + '\nreturn WMTClient;\n})()', sandbox);
}

function loadMudConnection(wsCounter) {
  const noop = () => {};
  function FakeWS() { wsCounter.n++; this.readyState = 0 /* CONNECTING */; this.close = () => {}; this.send = () => {}; }
  FakeWS.OPEN = 1; FakeWS.CONNECTING = 0; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  const sandbox = {
    window: { location: { hostname: 'localhost' } },
    WebSocket: FakeWS,
    setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop,
    console, JSON,
  };
  sandbox.module = { exports: {} };
  vm.createContext(sandbox);
  const raw = fs.readFileSync(CONNECTION_JS, 'utf8');
  const CM = vm.runInContext('(function(){\n' + raw + '\nreturn MudConnection;\n})()', sandbox);
  return CM;
}

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  PASS: ' + n); } else { fail++; console.log('  FAIL: ' + n); } };

console.log('=== LoginConflict ===');

const WMTClient = loadWMTClient();
const P = WMTClient.prototype;

// Fake `this` with just what onMessage('mud') + handleActiveLoginConflict touch.
function makeClient() {
  const sentCommands = [];
  return {
    passwordSent: false, loginBlocked: false, pendingReconnect: false,
    characterPassword: 'secretpw', mipStarted: true, // mipStarted=true skips the MIP block
    preferences: {}, _sent: sentCommands,
    connection: { mudLinkDead: false, sendCommand: (c) => sentCommands.push(c), reconnect() { this._rc = true; } },
    appendOutput() {}, updateConnectionStatus() {},
    handleActiveLoginConflict: P.handleActiveLoginConflict,
    onMessage: P.onMessage,
    reconnect: P.reconnect,
  };
}

// 1. "currently logged in and active" (ANSI-wrapped) trips the conflict handler
const c1 = makeClient();
c1.onMessage({ type: 'mud', line: '\x1b[31mYour character is currently logged in and active.\x1b[0m' });
check('active-login line sets loginBlocked', c1.loginBlocked === true);
check('active-login line gates auto-reconnect (mudLinkDead=true)', c1.connection.mudLinkDead === true);
check('active-login line suppresses further password send (passwordSent=true)', c1.passwordSent === true);

// 2. while blocked, a Password: prompt does NOT auto-send the password
const c2 = makeClient();
c2.loginBlocked = true; c2.passwordSent = false;
c2.onMessage({ type: 'mud', line: 'Password:' });
check('blocked: password is NOT auto-sent', c2._sent.length === 0);

// 3. NOT blocked: a Password: prompt DOES auto-send (baseline still works)
const c3 = makeClient();
c3.onMessage({ type: 'mud', line: 'Password:' });
check('not blocked: password IS auto-sent', c3._sent.length === 1 && c3._sent[0] === 'secretpw');

// 4. a normal MUD line does NOT trip the conflict
const c4 = makeClient();
c4.onMessage({ type: 'mud', line: 'A goblin attacks you!' });
check('normal line does not set loginBlocked', c4.loginBlocked === false);

// 5. user-initiated reconnect() clears loginBlocked
const c5 = makeClient();
c5.loginBlocked = true;
c5.reconnect();
check('reconnect() clears loginBlocked', c5.loginBlocked === false);

// 6. connection.connect() does not stack sockets while CONNECTING/OPEN
const wsCounter = { n: 0 };
const CM = loadMudConnection(wsCounter);
const cm = new CM({ wsUrl: 'ws://localhost:3000', onStatusChange() {}, onError() {} });
cm.connect();                       // creates socket #1 (readyState CONNECTING)
cm.connect();                       // should bail (CONNECTING) — no new socket
check('connect() bails while a connect is in flight (no socket stacking)', wsCounter.n === 1);
cm.socket.readyState = 1;           // OPEN
cm.connect();                       // should bail (OPEN)
check('connect() bails while OPEN', wsCounter.n === 1);

console.log(`=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
