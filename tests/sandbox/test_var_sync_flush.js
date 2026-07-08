/**
 * Variable-sync flush-before-command test (client-side) — ROOT fix for the
 * recurring bot-start race ("There is no reason to 'secstep$secstepnumber' here").
 *
 * 2026-07-08 (review F2 / Phase 3 step 1): the client no longer pushes its whole
 * variable store — it queues per-key ops (_queueVarOp) and sends `var_ops
 * {set, del}` for exactly the keys IT wrote. This suite asserts the new contract:
 *   - a queued write is flushed (var_ops sent) before a command, with the LATEST value
 *   - ONLY queued keys are sent — unqueued store keys are NOT asserted (the F2 fix:
 *     the client can no longer clobber/delete server state it didn't touch)
 *   - deletes are transported; a set-then-deleted key degrades to a delete
 *   - no queued ops → flush sends nothing
 *   - disconnected → ops stay queued (flushed after resume, not lost)
 *
 * Run: node test_var_sync_flush.js [/path/to/app.js]
 */
const fs = require('fs');
const vm = require('vm');
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

function makeFake(connected = true) {
  const calls = [];
  return {
    variables: {},
    _varSyncTimer: null,
    _pendingVarOps: null,
    connection: {
      connected,
      send(type, data) { calls.push({ op: type, data: JSON.parse(JSON.stringify(data)) }); },
      sendCommand(c) { calls.push({ op: 'command', cmd: c }); },
    },
    _queueVarOp: P._queueVarOp,
    _touchVar: P._touchVar,
    syncVariablesToServer: P.syncVariablesToServer,
    _sendVarOps: P._sendVarOps,
    _flushPendingVarSync: P._flushPendingVarSync,
    calls,
  };
}

console.log('=== VarSyncFlush ===');

// 1. queued write flushed before a command, with the LATEST value
let f = makeFake();
f.variables = { secstepnumber: '0', serverOwned: '99' };
f._queueVarOp('set', 'secstepnumber');
f.variables.secstepnumber = '1';           // value changes after queueing
f._flushPendingVarSync();                  // the sendCommand wrapper does this first
f.connection.sendCommand('secwalk');       // then the command
const ops = f.calls.filter(c => c.op === 'var_ops');
check('queued write flushed as var_ops', ops.length === 1);
check('flushed op carries the LATEST value (secstepnumber=1)', !!(ops[0] && ops[0].data.set && ops[0].data.set.secstepnumber === '1'));
const iOps = f.calls.findIndex(c => c.op === 'var_ops');
const iCmd = f.calls.findIndex(c => c.op === 'command');
check('var_ops sent BEFORE the command', iOps >= 0 && iCmd >= 0 && iOps < iCmd);

// 2. F2 core: unqueued store keys are NOT asserted
check('unqueued key (serverOwned) NOT in the op', !!(ops[0] && !('serverOwned' in ops[0].data.set)));
check('no deletes asserted for keys the client did not touch', !!(ops[0] && ops[0].data.del.length === 0));

// 3. deletes transported; set-then-deleted degrades to delete
f = makeFake();
f.variables = { a: '1', b: '2' };
f._queueVarOp('del', 'a');
f._queueVarOp('set', 'b');
delete f.variables.b;                      // deleted after being queued as set
f._flushPendingVarSync();
const op3 = f.calls.find(c => c.op === 'var_ops');
check('delete op transported', !!(op3 && op3.data.del.includes('a')));
check('set-then-deleted key degrades to delete', !!(op3 && op3.data.del.includes('b') && !('b' in op3.data.set)));

// 4. nothing queued → flush sends nothing
f = makeFake();
f._flushPendingVarSync();
check('no queued ops → no var_ops message', !f.calls.some(c => c.op === 'var_ops'));

// 5. disconnected → ops retained, not lost
f = makeFake(false);
f.variables = { x: '5' };
f._queueVarOp('set', 'x');
f._flushPendingVarSync();
check('disconnected → nothing sent', !f.calls.some(c => c.op === 'var_ops'));
check('disconnected → ops stay queued for the post-resume flush', !!(f._pendingVarOps && f._pendingVarOps.set.has('x')));
f.connection.connected = true;
f._flushPendingVarSync();
const op5 = f.calls.find(c => c.op === 'var_ops');
check('reconnect flush delivers the retained op', !!(op5 && op5.data.set.x === '5'));

console.log(`=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
