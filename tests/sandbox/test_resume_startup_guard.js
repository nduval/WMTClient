/**
 * Resume-startup #var guard (client-side) — the phone-hop bot-killer fix.
 *
 * 2026-07-10: a device that resumed a live session re-ran startup.tin, whose
 * #var INIT block force-reset 28 bot-state variables; var_ops pushed the
 * defaults over the server's live store and elminster's dosec died 29 minutes
 * later when the study cycle hit the corrupted gates (proven from logs — the
 * 16:19:48 var_ops batch matched startup.tin's init block 28/28).
 *
 * Contract: while `_resumeInitRead` is set (only during a startup-script read
 * triggered by session RESUME), `#var name value` is INIT-IF-ABSENT:
 *   - existing variable  → untouched, NO op queued (server value wins)
 *   - absent variable    → set + op queued (real init still works)
 * Outside the flag (fresh login, page load, user-typed #read), #var keeps its
 * normal force-set semantics.
 *
 * Run: node test_resume_startup_guard.js [/path/to/app.js]
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

function makeFake() {
  const f = Object.create(P);          // real prototype methods (cmdVar, setVariable, ...)
  f.variables = {};
  f.variableClasses = {};
  f.currentScriptClass = null;
  f._pendingVarOps = null;
  f._varSyncTimer = null;
  f._silent = true;
  f.appendOutput = () => {};           // shadow UI/event machinery with noops
  f.fireEvent = () => {};
  f.connection = { connected: true, send: () => {} };
  return f;
}

const queuedSets = (f) => (f._pendingVarOps ? [...f._pendingVarOps.set] : []);

console.log('=== ResumeStartupGuard ===');

// T1: normal semantics without the flag — #var force-sets and queues an op
let f = makeFake();
f.variables.studying = '1';
f.cmdVar(['studying', '0']);
check('T1a: without flag, #var overwrites existing value', f.variables.studying === '0');
check('T1b: without flag, op queued', queuedSets(f).includes('studying'));

// T2: flag ON + variable EXISTS — untouched, no op (the bot-killer case)
f = makeFake();
f.variables.studying = '1';
f._resumeInitRead = true;
f.cmdVar(['studying', '0']);
check('T2a: with flag, existing variable NOT overwritten', f.variables.studying === '1');
check('T2b: with flag, NO op queued for existing variable', !queuedSets(f).includes('studying'));

// T3: flag ON + variable ABSENT — init still applies
f = makeFake();
f._resumeInitRead = true;
f.cmdVar(['brandnew', '5']);
check('T3a: with flag, absent variable IS initialized', f.variables.brandnew === '5');
check('T3b: with flag, op queued for the new variable', queuedSets(f).includes('brandnew'));

// T4: flag cleared — normal force-set returns
f = makeFake();
f.variables.studying = '1';
f._resumeInitRead = true;
f.cmdVar(['studying', '0']);
f._resumeInitRead = false;
f.cmdVar(['studying', '0']);
check('T4: after flag clears, #var force-sets again', f.variables.studying === '0');

// T5: table syntax also guarded (startup inits can be tables)
f = makeFake();
f.variables.def = { a: '1' };
f._resumeInitRead = true;
f.cmdVar(['def', '{{x}{9}}']);
check('T5: with flag, existing table variable NOT overwritten', f.variables.def && f.variables.def.a === '1' && !f.variables.def.x);

// ── Phase 3 step 2: stale-queue guard in _sendVarOps ──
// A queue last touched >60s ago = the tab was suspended; its ops carry
// frozen-world values and must be dropped, not sent.
function makeSyncFake() {
  const calls = [];
  const f2 = Object.create(P);
  f2.variables = {};
  f2._pendingVarOps = null;
  f2._varSyncTimer = null;
  f2.connection = { connected: true, send: (type, data) => calls.push({ type, data }) };
  f2.calls = calls;
  return f2;
}

// T6: fresh queue sends normally
let s = makeSyncFake();
s.variables.x = '1';
s._pendingVarOps = { set: new Set(['x']), del: new Set() };
s._pendingVarOpsTouchedAt = Date.now() - 5000;   // 5s old — fresh
s._sendVarOps();
check('T6: fresh queue (5s) is sent', s.calls.length === 1 && s.calls[0].data.set.x === '1');

// T7: stale queue dropped (suspended tab)
s = makeSyncFake();
s.variables.studying = '0';
s._pendingVarOps = { set: new Set(['studying']), del: new Set() };
s._pendingVarOpsTouchedAt = Date.now() - 120000;  // 2 min — tab slept
s._sendVarOps();
check('T7a: stale queue (2min) NOT sent', s.calls.length === 0);
check('T7b: stale queue cleared (no later leak)', s._pendingVarOps === null);

// T8: queue with no stamp (legacy path safety) still sends
s = makeSyncFake();
s.variables.y = '2';
s._pendingVarOps = { set: new Set(['y']), del: new Set() };
s._pendingVarOpsTouchedAt = undefined;
s._sendVarOps();
check('T8: unstamped queue still sends (no false drops)', s.calls.length === 1);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
