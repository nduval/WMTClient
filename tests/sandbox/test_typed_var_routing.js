/**
 * Phase 3 Step 3 — typed variable mutations are SINGLE-OWNER (client-side contract).
 *
 * Typed #var/#math/#unvar lines route WHOLE and UNSUBSTITUTED to the server's
 * command pipeline (the same executor every alias/trigger chain uses); the
 * client store becomes a view populated by var_update, and the typed feedback
 * (#OK/#math lines) prints from the AUTHORITATIVE value when it round-trips.
 * This suite asserts the routing predicate, the non-substitution contract,
 * every documented local-fallback exclusion, and the view/echo application.
 *
 * Run: node test_typed_var_routing.js [/path/to/app.js]
 * (gate passes ws://... first — ignored, defaults to /opt/wmt/assets/js/app.js)
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

// Existence gate: if the Step-3 surface is missing (pre-change app.js), every
// contract below must FAIL, not crash — this is the suite's negative control.
const HAS_ROUTING = typeof P._shouldRouteTypedVarLine === 'function'
  && typeof P._routeTypedVarLine === 'function'
  && typeof P._applyVarUpdate === 'function';
check('Step-3 routing surface exists on the prototype', HAS_ROUTING);
if (!HAS_ROUTING) {
  console.log('\nResults: ' + pass + ' passed, ' + (fail + 19) + ' failed');
  process.exit(1);
}

function makeFake({ connected = true, mudLinkDead = false } = {}) {
  const calls = [];
  const outs = [];
  return {
    variables: {},
    variableClasses: {},
    functions: {},
    _bulkLoading: false, readingSilent: false, _silent: false,
    connection: {
      connected, mudLinkDead,
      send(type, data) { calls.push({ op: type, data: JSON.parse(JSON.stringify(data)) }); },
      sendCommand(c) { calls.push({ op: 'command', cmd: c }); },
    },
    appendOutput(msg, cls) { outs.push({ msg, cls }); },
    parseCommands: P.parseCommands,
    substituteVariables: P.substituteVariables,
    formatVariableValue: P.formatVariableValue,
    _classifyRoutablePart: P._classifyRoutablePart,
    _shouldRouteTypedVarLine: P._shouldRouteTypedVarLine,
    _routeTypedVarLine: P._routeTypedVarLine,
    _queueTypedVarEcho: P._queueTypedVarEcho,
    _takeTypedVarEcho: P._takeTypedVarEcho,
    _printTypedVarEcho: P._printTypedVarEcho,
    _applyVarUpdate: P._applyVarUpdate,
    calls, outs,
  };
}

console.log('=== TypedVarRouting ===');

// ── routing decisions ──
let f = makeFake();
check('T1: typed scalar set routes', f._shouldRouteTypedVarLine('#var ring on') === true);
check('T2: typed #math routes', f._shouldRouteTypedVarLine('#math x $x+1') === true);
check('T3: typed exact #unvar routes', f._shouldRouteTypedVarLine('#unvar foo') === true);
check('T4: indexed set routes', f._shouldRouteTypedVarLine('#var {hp[self]} {5}') === true);
check('T5: set+plain chain routes (the sequencing case)', f._shouldRouteTypedVarLine('#var x 1;dostep$x') === true);
check('T6: query stays local', f._shouldRouteTypedVarLine('#var ring') === false);
check('T7: wildcard #unvar stays local', f._shouldRouteTypedVarLine('#unvar sec*') === false);
check('T8: #list stays local (server F10 guard)', f._shouldRouteTypedVarLine('#list foo add {x}') === false);
check('T9: chain containing a non-routed verb stays local', f._shouldRouteTypedVarLine('#var x 1;#showme hi') === false);
check('T10: table-creation value stays local (shape divergence)', f._shouldRouteTypedVarLine('#var tbl {{a}{1}{b}{2}}') === false);
check('T11: #end never routes (typed #end means intentional disconnect)', f._shouldRouteTypedVarLine('#var x 1;#end') === false);
check('T12: query inside a chain keeps the whole line local', f._shouldRouteTypedVarLine('#var x 1;#var x') === false);
check('T13: indexed #math stays local (server falls through)', f._shouldRouteTypedVarLine('#math {hp[self]} {1}') === false);

// ── environment fallbacks ──
check('T14: disconnected → local fallback', makeFake({ connected: false })._shouldRouteTypedVarLine('#var x 1') === false);
check('T15: mudLinkDead → local fallback', makeFake({ mudLinkDead: true })._shouldRouteTypedVarLine('#var x 1') === false);
f = makeFake(); f._bulkLoading = true;
check('T16: bulk #read context → local', f._shouldRouteTypedVarLine('#var x 1') === false);
f = makeFake(); f.readingSilent = true;
check('T17: silent read context → local', f._shouldRouteTypedVarLine('#var x 1') === false);

// ── the non-substitution contract (the divergence killer) ──
f = makeFake();
f.variables = { x: 'STALE' };
f._routeTypedVarLine('#var x 1;dostep$x');
const sent = f.calls.find(c => c.op === 'command');
check('T18: line sent WHOLE and UNSUBSTITUTED (no stale $x baked in)', !!sent && sent.cmd === '#var x 1;dostep$x');
check('T19: routed set did NOT mutate the local store (server owns it)', f.variables.x === 'STALE');
check('T20: no var_ops queued for the routed write (no echo loop)', !f.calls.some(c => c.op === 'var_ops'));

// ── view application + typed feedback echo ──
f = makeFake();
f._routeTypedVarLine('#var ring on');
f._applyVarUpdate({ variables: { ring: 'on' } });
check('T21: var_update round-trip applies to the view', f.variables.ring === 'on');
check('T22: typed set echoes the local-format #OK line with the authoritative value',
  f.outs.some(o => o.msg === '#OK: #VARIABLE {ring} HAS BEEN SET TO {on}.'));

f = makeFake();
f._routeTypedVarLine('#math x $x+1');
f._applyVarUpdate({ variables: { x: 2 } });
check('T23: typed #math echoes the local-format result line', f.outs.some(o => o.msg === '#math: $x = 2'));

f = makeFake();
f.variables = { foo: '1' };
f._routeTypedVarLine('#unvar foo');
f._applyVarUpdate({ deleted: ['foo'] });
check('T24: typed #unvar deletes from the view', f.variables.foo === undefined);
check('T25: typed #unvar echoes 1 VARIABLE(S) REMOVED', f.outs.some(o => o.msg === '#OK: 1 VARIABLE(S) REMOVED.'));

f = makeFake();
f._routeTypedVarLine('#unvar nosuch');
f._applyVarUpdate({ deleted: ['nosuch'] });
check('T26: #unvar on a nonexistent var echoes 0 REMOVED (matches local)', f.outs.some(o => o.msg === '#OK: 0 VARIABLE(S) REMOVED.'));

// FIFO pairing: two writes to the same name in one chain echo in execution order
f = makeFake();
f._routeTypedVarLine('#var x 1;#math x $x+1');
f._applyVarUpdate({ variables: { x: '1' } });
f._applyVarUpdate({ variables: { x: 2 } });
const okIdx = f.outs.findIndex(o => o.msg.startsWith('#OK: #VARIABLE {x}'));
const mathIdx = f.outs.findIndex(o => o.msg === '#math: $x = 2');
check('T27: multi-write chain echoes pair up FIFO in execution order', okIdx >= 0 && mathIdx >= 0 && okIdx < mathIdx);

// Indexed echo prints the nested slice from the pushed base object
f = makeFake();
f._routeTypedVarLine('#var {hp[self]} {50}');
f._applyVarUpdate({ variables: { hp: { self: '50' } } });
check('T28: indexed set echoes the nested value', f.outs.some(o => o.msg === '#OK: #VARIABLE {hp[self]} HAS BEEN SET TO {50}.'));

// Trigger-driven (unrouted) updates stay silent — no cry-wolf feedback
f = makeFake();
f._applyVarUpdate({ variables: { serverThing: '7' } });
check('T29: var_update with no pending typed echo prints nothing', f.outs.length === 0 && f.variables.serverThing === '7');

// ── Phase 3 Step 5a: typed #delay/#undelay ──
const HAS_DELAY = typeof P._tryRouteTypedDelayQuery === 'function' && typeof P._onDelayList === 'function';
check('T32: Step-5a delay surface exists on the prototype', HAS_DELAY);
if (HAS_DELAY) {
  const mk = (opts) => {
    const g = makeFake(opts);
    g._tryRouteTypedDelayQuery = P._tryRouteTypedDelayQuery;
    g._onDelayList = P._onDelayList;
    return g;
  };
  // classification: schedule forms route as commands
  f = mk();
  check('T33: braced anon #delay {5} {cmd} routes', f._shouldRouteTypedVarLine('#delay {5} {say hi}') === true);
  check('T34: named #delay {n} {cmd} {5} routes', f._shouldRouteTypedVarLine('#delay {heals} {cast heal} {30}') === true);
  check('T35: $var seconds routes (server substitutes+clamps)', f._shouldRouteTypedVarLine('#delay {cd} {cast x} {$cooldown}') === true);
  check('T36: literal bad seconds stays local (client usage error prints)', f._shouldRouteTypedVarLine('#delay {abc} {say hi}') === false);
  check('T37: #undelay inside a chain routes', f._shouldRouteTypedVarLine('#var x 1;#undelay {heal*}') === true);
  check('T38: bare #delay in a chain keeps the line local', f._shouldRouteTypedVarLine('#var x 1;#delay') === false);
  // delay_query path: single-part list/undelay
  f = mk();
  check('T39: bare #delay sends delay_query pattern=*',
    f._tryRouteTypedDelayQuery('#delay') === true
    && f.calls.some(c => c.op === 'delay_query' && c.data.pattern === '*' && !c.data.remove));
  f = mk();
  check('T40: #delay {heal*} sends a filtered delay_query',
    f._tryRouteTypedDelayQuery('#delay {heal*}') === true
    && f.calls.some(c => c.op === 'delay_query' && c.data.pattern === 'heal*'));
  f = mk();
  check('T41: single-part #undelay sends delay_query remove:true',
    f._tryRouteTypedDelayQuery('#undelay {heals}') === true
    && f.calls.some(c => c.op === 'delay_query' && c.data.pattern === 'heals' && c.data.remove === true));
  f = mk();
  check('T42: #delay {5} (numeric single arg = malformed schedule) stays local',
    f._tryRouteTypedDelayQuery('#delay {5}') === false);
  check('T43: disconnected → delay query falls back local',
    mk({ connected: false })._tryRouteTypedDelayQuery('#delay') === false);
  // delay_list rendering
  f = mk();
  f._onDelayList({ pattern: '*', removed: null, delays: [{ name: 'heals', command: 'cast heal', remaining: 12.5 }] });
  check('T44: listing renders in local cmdDelay format', f.outs.some(o => o.msg === '#DELAY {heals} {cast heal} {12.5}'));
  f = mk();
  f._onDelayList({ pattern: '*', removed: null, delays: [] });
  check('T45: empty listing prints "no delays defined."', f.outs.some(o => o.msg === '#DELAY: no delays defined.'));
  f = mk();
  f._onDelayList({ pattern: 'x*', removed: 2, delays: [] });
  check('T46: removal feedback prints the count', f.outs.some(o => o.msg === '#OK: 2 DELAYS REMOVED.'));
  f = mk();
  f._onDelayList({ pattern: 'x*', removed: 0, delays: [] });
  check('T47: removed=0 prints nothing (matches local cmdUndelay)', f.outs.length === 0);
} else {
  fail += 15;
}

// ── Phase 3 Step 4: RECEIVED INPUT is dispatched ONLY by the server ──
// The client's typed path must NOT fire it locally (double-dispatch made
// cumulative handlers double-count). Source-level assertion — the fire lived
// in the DOM-bound sendCommand(), so behavior is asserted on the source text.
const SRC = fs.readFileSync(APP_JS, 'utf8');
check('T30: no client-side fireEvent for RECEIVED INPUT remains',
  !/fireEvent\(\s*['"]RECEIVED INPUT['"]/.test(SRC));
check('T31: the input deadman stamp (lastUserInput) is still in the typed path',
  /this\.lastUserInput = Date\.now\(\)/.test(SRC));

// ── Phase 3 Step 5b (client half): the browser combat brain is retired ──
// Even with ready stats and a condition that would fire, the local evaluator
// must do NOTHING — the server evaluates (this client declares mipCond at auth).
f = makeFake();
f.mipReady = true;
f.mipConditions = [{ id: 'x', enabled: true, variable: 'hp_pct', operator: '<', value: '99', command: 'say heal' }];
f.mipVars = { hp_pct: 10, round: 1 };
f.checkMipConditions = P.checkMipConditions;
f.checkMipConditions();
check('T48: client MIP evaluator retired (no local fire — the server owns evaluation)',
  !f.calls.some(c => c.op === 'command'));
let connSrc = '';
try { connSrc = fs.readFileSync(APP_JS.replace(/app\.js$/, 'connection.js'), 'utf8'); } catch (e) {}
check('T49: auth payload declares the mipCond capability', /mipCond:\s*1/.test(connSrc));

console.log('\nResults: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
