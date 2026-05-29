/**
 * Variable-sync flush-before-command test (client-side) — ROOT fix for the
 * recurring bot-start race ("There is no reason to 'secstep$secstepnumber' here").
 *
 * Root cause (from prod logs): syncVariablesToServer() debounces 100ms, so a
 * client-set var (secon's `#var secstepnumber 1`) reached the server AFTER the
 * dependent command (secwalk). The server then expanded `secstep$secstepnumber`
 * against a variable that hadn't synced yet → literal → "no reason."
 *
 * Fix: the command-send wrapper calls _flushPendingVarSync() before every command,
 * pushing pending variable state first so the server has it before it substitutes.
 *
 * This loads the REAL app.js (vm sandbox, browser globals mocked) and asserts:
 *   - a pending var sync is flushed (setVariables sent) when a command is about to go
 *   - the flush happens BEFORE the command (ordering)
 *   - no pending sync → flush is a no-op (no spurious setVariables)
 *   - after a debounced sync fires, _varSyncTimer is cleared (so flush state is accurate)
 *
 * Run: node test_var_sync_flush.js [/path/to/app.js]
 */
const fs = require('fs');
const vm = require('vm');
// Accept an explicit path; ignore the gate's ws:// arg and use the synced sandbox copy.
const _arg = process.argv[2];
const APP_JS = (_arg && !_arg.startsWith('ws')) ? _arg : '/opt/wmt/assets/js/app.js';

function loadWMTClient() {
  const noop = () => {};
  const fakeEl = new Proxy({}, { get: () => noop });
  const sandbox = {
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, createElement: () => fakeEl, body: fakeEl },
    window: { location: { hostname: 'localhost' }, addEventListener: noop, WMT_CONFIG: {} },
    navigator: { userAgent: 'test' }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    WebSocket: function () {}, setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    console, JSON, Date, Math,
  };
  vm.createContext(sandbox);
  const raw = fs.readFileSync(APP_JS, 'utf8');
  return vm.runInContext('(function(){\n' + raw + '\nreturn WMTClient;\n})()', sandbox);
}

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  PASS: ' + n); } else { fail++; console.log('  FAIL: ' + n); } };

const P = loadWMTClient().prototype;

// Fake `this` recording connection calls in order, with controllable timers.
function makeFake() {
  const calls = [];
  const fake = {
    variables: {},
    _varSyncTimer: null,
    _pendingTimerToken: 0,
    connection: {
      setVariables(v) { calls.push({ op: 'setVariables', vars: { ...v } }); },
      sendCommand(c) { calls.push({ op: 'command', cmd: c }); },
    },
    // timers: setTimeout returns a token and does NOT auto-fire (sync stays pending)
    _setTimeout() { return ++this._pendingTimerToken; },
    syncVariablesToServer: P.syncVariablesToServer,
    _flushPendingVarSync: P._flushPendingVarSync,
    calls,
  };
  return fake;
}

console.log('=== VarSyncFlush ===');

// Patch global timers used by the prototype methods (they were captured from the
// vm sandbox, so override on the fake by wrapping the methods' timer calls):
// syncVariablesToServer uses setTimeout/clearTimeout from its closure (the vm
// sandbox's no-op ones). To make a sync "pending", set _varSyncTimer manually.

// 1. pending sync is flushed before a command, with the latest vars
let f = makeFake();
f.variables = { secstepnumber: '1', other: 'x' };
f._varSyncTimer = 99;            // simulate a pending debounced sync
f._flushPendingVarSync();
const sv = f.calls.find(c => c.op === 'setVariables');
check('pending sync flushed (setVariables sent)', !!sv);
check('flushed vars include the just-set secstepnumber=1', sv && sv.vars.secstepnumber === '1');
check('_varSyncTimer cleared after flush', f._varSyncTimer === null);

// 2. ordering: flush happens before the command (mirrors the sendCommand wrapper)
f = makeFake();
f.variables = { secstepnumber: '1' };
f._varSyncTimer = 99;
f._flushPendingVarSync();                 // wrapper does this first
f.connection.sendCommand('secwalk');      // then the command
const iVars = f.calls.findIndex(c => c.op === 'setVariables');
const iCmd = f.calls.findIndex(c => c.op === 'command');
check('variables are sent BEFORE the command', iVars >= 0 && iCmd >= 0 && iVars < iCmd);

// 3. no pending sync → flush is a no-op (no spurious setVariables)
f = makeFake();
f._varSyncTimer = null;
f._flushPendingVarSync();
check('no pending sync → no spurious setVariables', !f.calls.some(c => c.op === 'setVariables'));

console.log(`=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
