/**
 * PHP login-flow regression suite (2026-06-07) — the double-login guard.
 *
 * Boots the REAL PHP auth stack (includes/ + config/ + api/, staged by
 * deploy.py at /opt/wmt/phpsrc) under `php -S` against a throwaway data dir
 * with one bcrypt test user, then exercises the login → requireAuth cycle.
 *
 * What it guards (root: startUserSession ran a redundant 2nd session lifecycle
 * after session_write_close, which on some SAPIs re-emitted the pre-regenerate
 * session id → browser stored a dead session → "logged in, then need to
 * authenticate" double-login):
 *   T1 fresh login returns 200 + a Set-Cookie session cookie
 *   T2 the session sticks (requireAuth/check sees logged_in:true)
 *   T3 a 2nd login that CARRIES the prior cookie (browser-reconnect case) still sticks
 *   T4 the regenerating login emits exactly ONE non-empty wmt_session Set-Cookie
 *      (no stale/empty trailing cookie from a reintroduced 2nd lifecycle)
 *   T5 loop x20 (persistent jar) — every login sticks
 *   T6/T7 no /api/ cookie churn; strict mode issues a fresh id for an unknown cookie
 *   T8 IDEMPOTENT same-user re-login keeps the session id (does NOT regenerate/destroy
 *      the in-use session) and the original cookie still authenticates — the durable fix
 *      for the recurring double-login loop (2026-07-04 root: login #2 regen'd the id the
 *      browser was still using → strict-mode empty session → "need to authenticate" loop)
 *
 * NOTE: PHP 8.3's session module strips duplicate same-name session cookies, so
 * the original multi-cookie flake does not MANIFEST on this sandbox PHP; this
 * suite is a regression guard (login works + single clean cookie), not a repro
 * of the prod-only race. See memory job_php_login_harness_double_login.
 *
 * Run: node test_php_login.js   (ignores any ws:// arg the gate passes)
 */
const http = require('http');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const PHP_SRC = process.env.PHP_SRC || '/opt/wmt/phpsrc';
const PORT = parseInt(process.env.PHP_TEST_PORT || '8098', 10);
const ROOT = `/tmp/wmt_phptest_${process.pid}`;
const BASE = `127.0.0.1:${PORT}`;
const USER = 'harnessuser', PASS = 'testpass123';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS: ' + n); };
const bad = (n, m) => { fail++; console.log('  FAIL: ' + n + (m ? ' — ' + m : '')); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Minimal cookie jar: stores name->value for the session cookie (path-agnostic,
// last-non-deleted wins — mirrors curl's jar, which is what the bash harness used).
function applySetCookies(jar, headers) {
  const sc = headers['set-cookie'] || [];
  for (const line of sc) {
    const m = /^([^=]+)=([^;]*)/.exec(line);
    if (!m) continue;
    const name = m[1].trim(), val = m[2];
    const isDelete = /expires=Thu, 01 Jan 1970/i.test(line) || val === '' || val === 'deleted';
    // Only let a path=/ (or no-path) cookie set the jar value; a path=/api/ clear
    // must NOT clobber the real path=/ session (browsers key by path, curl too).
    const path = (/path=([^;]*)/i.exec(line) || [null, '/'])[1].trim();
    if (path !== '/' && path !== '') continue;
    if (isDelete) { delete jar[name]; } else { jar[name] = val; }
  }
}
function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}
function req(method, path, { jar, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    if (jar && Object.keys(jar).length) headers['Cookie'] = cookieHeader(jar);
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { if (jar) applySetCookies(jar, res.headers); resolve({ status: res.statusCode, headers: res.headers, body: data }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const login = (jar) => req('POST', '/api/auth.php?action=login', { jar, body: JSON.stringify({ username: USER, password: PASS }) });
const check = (jar) => req('GET', '/api/auth.php?action=check', { jar });

function stage() {
  execSync(`rm -rf ${ROOT}`);
  execSync(`mkdir -p ${ROOT}`);
  for (const d of ['includes', 'config', 'api']) execSync(`cp -r ${PHP_SRC}/${d} ${ROOT}/${d}`);
  execSync(`chmod -R u+w ${ROOT}`);   // scp'd source may be read-only; make the copy editable
  // Isolation: no prod DB admin key (force JSON user lookup), throwaway data dirs.
  execSync(`rm -f ${ROOT}/config/render_admin_key.php`);
  execSync(`mkdir -p ${ROOT}/data/users ${ROOT}/data/logs ${ROOT}/data/sessions`);
  const hash = execSync(`php -r 'echo password_hash("${PASS}", PASSWORD_DEFAULT);'`).toString().trim();
  fs.writeFileSync(`${ROOT}/data/users/users_index.json`,
    JSON.stringify([{ id: 'harness1', username: USER, password: hash, email: 'h@test.local' }]));
}

async function main() {
  console.log('=== PhpLogin ===');
  let srv;
  try {
    stage();
    try { execSync(`pkill -f "php -S ${BASE}"`); } catch (e) {}   // clear a stale server on this port
    srv = spawn('php', ['-S', BASE, '-t', ROOT], { stdio: 'ignore' });
    await sleep(1200);

    // T1: fresh login → 200 + a session Set-Cookie
    const jar = {};
    const r1 = await login(jar);
    const sc1 = (r1.headers['set-cookie'] || []).filter(l => /^wmt_session=/.test(l));
    if (r1.status === 200 && sc1.length >= 1) ok('T1: fresh login 200 + Set-Cookie');
    else return bad('T1: fresh login', `status=${r1.status}, cookies=${sc1.length}`), done(srv);

    // T2: session sticks
    const c2 = await check(jar);
    if (/"logged_in":true/.test(c2.body)) ok('T2: session sticks (logged_in:true)');
    else bad('T2: session sticks', c2.body.slice(0, 120));

    // T3: cookie-carrying 2nd login (browser-reconnect case) still sticks
    const r3 = await login(jar);             // jar already holds the prior cookie
    const c3 = await check(jar);
    if (/"logged_in":true/.test(c3.body)) ok('T3: cookie-carrying re-login still sticks');
    else bad('T3: cookie-carrying re-login', c3.body.slice(0, 120));

    // T4: a cookie-carrying same-user re-login emits AT MOST ONE non-empty wmt_session
    // path=/ cookie — never a stale/empty trailing cookie (the reintroduced-2nd-lifecycle
    // hazard) and never two competing ids. With the idempotent-relogin fix it emits ZERO
    // (the id is unchanged, so PHP sends no Set-Cookie); the invariant that matters is
    // "not ≥2 and no empty clobber", i.e. <= 1.
    const realCookies = (r3.headers['set-cookie'] || [])
      .filter(l => /^wmt_session=/.test(l))
      .filter(l => !/expires=Thu, 01 Jan 1970/i.test(l) && !/^wmt_session=(deleted)?;/.test(l));
    if (realCookies.length <= 1) ok('T4: no competing/stale wmt_session cookie on re-login (<=1)');
    else bad('T4: single clean cookie', `non-empty wmt_session cookies=${realCookies.length}: ${JSON.stringify(r3.headers['set-cookie'])}`);

    // T6: no legacy path=/api/ cookie-clear churn on a cookie-carrying request. The old
    // per-request `setcookie(wmt_session,'',-3600,'/api/')` was removed (#1) — it emitted an
    // extra Set-Cookie on every request incl. the login response, helping the regenerated
    // login cookie lose the race. r3 carried a cookie, so the OLD code would have emitted it.
    const apiPathCookies = (r3.headers['set-cookie'] || []).filter(l => /path=\/api\//i.test(l));
    if (apiPathCookies.length === 0) ok('T6: no path=/api/ cookie churn on a cookie-carrying request');
    else bad('T6: no /api/ cookie churn', JSON.stringify(apiPathCookies));

    // T7: session.use_strict_mode (#2) — an UNKNOWN session id from the cookie must NOT be
    // adopted (which would resurrect a dead id as an empty session = the permanent DENIED
    // loop). With strict mode PHP discards it and issues a FRESH id (new Set-Cookie).
    const bogusId = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const r7 = await req('GET', '/api/auth.php?action=check', { jar: { wmt_session: bogusId } });
    const freshIssued = (r7.headers['set-cookie'] || [])
      .filter(l => /^wmt_session=/.test(l) && !/expires=Thu, 01 Jan 1970/i.test(l) && !new RegExp('^wmt_session=' + bogusId).test(l));
    if (freshIssued.length >= 1) ok('T7: strict mode issues a fresh id for an unknown cookie (no resurrection)');
    else bad('T7: strict mode', 'no fresh id issued — use_strict_mode off? ' + JSON.stringify(r7.headers['set-cookie']));

    // T8: IDEMPOTENT same-user re-login must NOT regenerate the session id — the PROVEN
    // root of the 2026-07-04 recurrence (IONOS auth.log: login #2 called
    // session_regenerate_id(true), destroying the id login #1's browser was still using →
    // the browser's next request hit that dead id → use_strict_mode minted a fresh EMPTY
    // session → user_id NOT SET → the "need to authenticate" loop). The fix keeps the id on
    // a same-user re-login, so (a) the id is unchanged and (b) the ORIGINAL cookie still
    // authenticates. Negative-controlled: on the old code s2 !== s1 AND s1 is destroyed.
    const jar8 = {};
    await login(jar8);                 // fresh login (anon→auth) — this one DOES regenerate
    const s1 = jar8.wmt_session;
    await login(jar8);                 // 2nd login carrying s1 (the double-login POST)
    const s2 = jar8.wmt_session;       // unchanged on the fix (no Set-Cookie emitted)
    const idKept = !!s1 && !!s2 && s1 === s2;
    const c8 = await req('GET', '/api/auth.php?action=check', { jar: { wmt_session: s1 } });
    const s1StillValid = /"logged_in":true/.test(c8.body);
    if (idKept && s1StillValid) ok('T8: same-user re-login keeps the id + original cookie still authenticates');
    else bad('T8: idempotent re-login', `idKept=${idKept} (s1=${s1} s2=${s2}), s1StillValid=${s1StillValid}`);

    // T5: loop with a persistent jar — every login sticks
    let stuck = 0; const N = 20;
    for (let i = 0; i < N; i++) { await login(jar); const c = await check(jar); if (/"logged_in":true/.test(c.body)) stuck++; }
    if (stuck === N) ok(`T5: ${N}/${N} persistent-jar logins stick`);
    else bad('T5: persistent-jar loop', `${stuck}/${N} stuck`);

  } catch (e) {
    bad('harness', e.message);
  } finally {
    done(srv);
  }
}
function done(srv) {
  try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
  try { execSync(`rm -rf ${ROOT}`); } catch (e) {}
  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
