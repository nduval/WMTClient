/**
 * Reconnect-gate test (client-side) — guards the SC4 fix.
 *
 * Loads the REAL assets/js/connection.js into a vm sandbox with mocked browser
 * globals, drives its actual `onclose` handler, and asserts the auto-reconnect
 * decision:
 *   - active session (mudLinkDead=false)      → auto-reconnects   (seamless resume preserved)
 *   - linkdead/parked char (mudLinkDead=true)  → does NOT reconnect (no resurrection on restart)
 *   - intentional disconnect (#end / menu)     → does NOT reconnect (existing behavior)
 *   - manual reconnect()                        → clears mudLinkDead (user intent to resume)
 *
 * Run: node test_reconnect_gate.js [/path/to/connection.js]
 */
const fs = require('fs');
const vm = require('vm');

const CONNECTION_JS = process.argv[2] || '/tmp/connection.js';

function newContext() {
  const scheduled = [];
  const sandbox = {
    window: { location: { hostname: 'localhost' } },
    WebSocket: function (url) { this.readyState = 0; this.close = () => {}; this.send = () => {}; },
    setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return 1; },
    clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    console, JSON,
  };
  sandbox.WebSocket.OPEN = 1;
  sandbox.module = { exports: {} };
  vm.createContext(sandbox);
  // Wrap in an IIFE so the top-level `class ConnectionManager` is in function scope
  // and can be returned (vm doesn't expose top-level class bindings on the context).
  const raw = fs.readFileSync(CONNECTION_JS, 'utf8');
  const CM = vm.runInContext('(function(){\n' + raw + '\nreturn MudConnection;\n})()', sandbox);
  return { CM, scheduled };
}

// Returns true if firing onclose scheduled a reconnect (setTimeout → connect()).
function reconnectsAfterClose(setup) {
  const { CM, scheduled } = newContext();
  const cm = new CM({ wsUrl: 'ws://localhost:3000' });
  cm.connect();           // assigns this.socket.onclose
  setup(cm);
  scheduled.length = 0;   // ignore anything connect() itself scheduled
  cm.socket.onclose({});  // fire the real close handler
  return scheduled.length > 0;
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  PASS: ' + name); } else { fail++; console.log('  FAIL: ' + name); } };

console.log('=== ReconnectGate ===');

check('active session (mudLinkDead=false) auto-reconnects',
  reconnectsAfterClose(cm => { cm.mudLinkDead = false; cm.intentionalDisconnect = false; cm.reconnectAttempts = 0; }) === true);

check('linkdead/parked char (mudLinkDead=true) does NOT auto-reconnect',
  reconnectsAfterClose(cm => { cm.mudLinkDead = true; cm.intentionalDisconnect = false; cm.reconnectAttempts = 0; }) === false);

check('intentional disconnect (#end/menu) does NOT auto-reconnect',
  reconnectsAfterClose(cm => { cm.mudLinkDead = false; cm.intentionalDisconnect = true; cm.reconnectAttempts = 0; }) === false);

check('manual reconnect() clears mudLinkDead', (() => {
  const { CM } = newContext();
  const cm = new CM({ wsUrl: 'ws://localhost:3000' });
  cm.mudLinkDead = true;
  cm.reconnect();
  return cm.mudLinkDead === false;
})());

console.log(`=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
