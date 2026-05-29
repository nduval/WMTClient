/**
 * Class-scoped variables test (client-side) — fix for bot step counters persisting
 * after `#class bots kill`. Loads the REAL assets/js/app.js into a vm sandbox
 * (mocking browser globals so the DOMContentLoaded init never runs), then exercises
 * the actual WMTClient.prototype methods:
 *   - cmdVar tags a variable with currentScriptClass when defined during a #class read
 *   - a runtime update (currentScriptClass null) PRESERVES the tag
 *   - removeVariablesForClass drops only that class's vars and returns the count
 *
 * Run: node test_var_class_scope.js [/path/to/app.js]
 */
const fs = require('fs');
const vm = require('vm');

const APP_JS = process.argv[2] || '/tmp/app.js';

function loadWMTClient() {
  const noop = () => {};
  const fakeEl = new Proxy({}, { get: () => noop });
  const sandbox = {
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null, createElement: () => fakeEl, body: fakeEl },
    window: { location: { hostname: 'localhost' }, addEventListener: noop, WMT_CONFIG: {} },
    navigator: { userAgent: 'test' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    WebSocket: function () {}, setTimeout: noop, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    console, JSON, Date, Math,
  };
  vm.createContext(sandbox);
  const raw = fs.readFileSync(APP_JS, 'utf8');
  return vm.runInContext('(function(){\n' + raw + '\nreturn WMTClient;\n})()', sandbox);
}

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('  PASS: ' + n); } else { fail++; console.log('  FAIL: ' + n); } };

const WMTClient = loadWMTClient();
const P = WMTClient.prototype;

// Minimal fake `this` with just what cmdVar / removeVariablesForClass touch.
function makeFake() {
  return {
    variables: {}, variableClasses: {}, currentScriptClass: null, _silent: true,
    appendOutput() {}, syncVariablesToServer() { this._synced = true; },
    parseVariableName: P.parseVariableName,
    setNestedVariable(name, keys, value) { this.variables[name] = value; },
    cmdVar: P.cmdVar,
    removeVariablesForClass: P.removeVariablesForClass,
  };
}

console.log('=== VarClassScope ===');

// 1. var defined during a #class read is tagged with that class
const f = makeFake();
f.currentScriptClass = 'bots-id';
f.cmdVar(['secstepnumber', '0']);
check('var defined under a class is tagged with that class', f.variableClasses.secstepnumber === 'bots-id');
check('var value is set', String(f.variables.secstepnumber) === '0');

// 2. runtime update (no open class) preserves the existing class tag
f.currentScriptClass = null;
f.cmdVar(['secstepnumber', '1']);
check('runtime update preserves the class tag', f.variableClasses.secstepnumber === 'bots-id');
check('runtime update changes the value', String(f.variables.secstepnumber) === '1');

// 3. a var defined with NO open class has no tag
f.cmdVar(['globalvar', '5']);
check('var defined outside any class is untagged', f.variableClasses.globalvar === undefined);

// 4. removeVariablesForClass drops only that class's vars, returns count
f.variables.othersbots = 7; f.variableClasses.othersbots = 'other-id';
const removed = f.removeVariablesForClass('bots-id');
check('removeVariablesForClass returns the count removed', removed === 1);
check('class var is removed from variables', !('secstepnumber' in f.variables));
check('class var is removed from variableClasses', !('secstepnumber' in f.variableClasses));
check('a different class\'s var is untouched', f.variables.othersbots === 7);
check('an untagged var is untouched', f.variables.globalvar === '5');

console.log(`=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
