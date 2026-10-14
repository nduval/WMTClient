# WMT Backlog — the single source for OPEN work

> **Rule (2026-07-11):** every work session updates this file — items move to DONE
> with commit + date, new items get added when discovered, and "done" claims in
> conversation MUST match this file. Born from the Phase-3 confusion: "step 1
> shipped" read as "Phase 3 shipped" weeks later. If it's not DONE here, it's not done.

## SHIPPED 6a52fe4 2026-10-14 (IONOS-only) — UI trigger renames lost on every connect (`#action` delete+recreate)
- locrian: "renaming triggers and they aren't saving". Data: DB had 94 trigger rows vs 80 in her
  client; 17 patterns duplicated — one row with her custom name ("Fade - Heartening Laugh",
  "Dodge - Blink"…), one with the default pattern-as-name, all class Bard. startup.tin `#read`s
  bard.txt on every connect/resume.
- Cause (app.js `cmdAction`): the ONLY entity command that removed the same-pattern trigger and
  pushed a NEW one (new id, `name = pattern.substring(0,30)`); cmdAlias/cmdGag/cmdHighlight/
  cmdSubstitute all update in place. So each `#read` renamed her trigger back; the server's
  mergeDevicePush then kept her (content-differing) renamed copy as a preserved row → duplicate.
  The ENTITY_ECHO_GUARD lines in her journal are the normal resume bookkeeping, not the cause.
- Fix: cmdAction updates the existing same-pattern command trigger in place (keeps id, name,
  enabled; sets actions/matchType/priority; class only when inside `#class {read}`), prefers the
  renamed copy when several exist and drops the others — her 17 dups self-heal on her next connect
  (omitted ids share the script's content key → mergeDevicePush drops them). Gate 146/146 (subset).
- NOT covered: no sandbox test for cmdAction (client-side JS, no harness); a UI edit of a
  script-owned trigger's pattern/command/match type is still overwritten by the next `#read`
  (only the name/id survive — by design, the script owns the definition); DB rows not scrubbed
  by hand. ⏳ live confirm: her next connect → `SELECT pattern,COUNT(*) … HAVING COUNT(*)>1` = 0
  and the custom names still present.

## SHIPPED 12b3e24 2026-10-14 — "Incorrect password" after resume (3klient into Password:) + password in JSONL
- locrian 13:55Z: fresh login, browser WS dropped as `Password:` arrived (password never sent),
  resume's `enableMip()` fired `3klient …` into the password prompt → "Incorrect password." → MUD
  closed → auto-reconnect; then her startup.tin's 10s `#delay` fired 4 raw `setm*` commands into
  the new name prompt → "Invalid character in position 29/24/30/50". Nathan: "hit that same
  password issue a few times myself".
- server.js: drop `3klient` while `_eagerAtPasswordPrompt` (≤120s after the prompt) + one
  `system` notice "The MUD is waiting for your password"; JSONL `input` record for the captured
  password = `[password redacted]` (every auto-login password was in plaintext in /var/log/wmt;
  older files age out in 7 days). Gate MipNamePromptGuard T3/T4, negative-controlled (2 FAIL on
  the pre-fix server). Deploy = `deploy.py all` (wmt-server restart).
- locrian's startup.tin EnterMess delay 10s → 90s (matches elminster's), IONOS + DB mirror verified.
- NOT covered: the resume path still doesn't auto-send the password (player types it or the MUD
  times out → fresh login); startup-script raw commands pre-login in general (script-side: use a
  trigger on "3Kingdoms welcomes you"); the `con` alias she references isn't on locrian.
- ⏳ live confirm: next "Dropped MIP cmd at password prompt" in the journal + no "Incorrect
  password." following a SESSION_RESUME; JSONL shows `[password redacted]`.

## SHIPPED 2026-10-14 (IONOS-only) — Delete button inside every entity edit modal
- Nathan: "if i open a trigger, alias, gag etc. it has save/cancel but it would be nice to have
  delete, so i dont have to hit cancel, go find it in the list, and click the little x" + "maybe
  a prompt of are you sure you want to delete". app.php: a `btn-danger` Delete (`<kind>-delete-btn`,
  left-aligned, hidden for New) in the trigger/alias/gag/highlight/substitute/ticker footers.
  app.js: `_setModalDeleteVisible()` toggled by each `open*Modal`; `deleteFromModal(kind)` reads
  the modal's editing index/id, confirms ONCE naming the item ("Delete this trigger: "x"? This
  cannot be undone."), closes the modal, then calls the SAME deleter the list "×" uses
  (`deleteTrigger`/`deleteAlias`/`deleteTickerById`, new `confirmed=true` arg skips their own
  prompt) so persistence + panel/sidebar refresh are identical. Sandbox node --check + php -l OK.
  ⏳ Nathan's click-through.

## SHIPPED 2026-10-14 (IONOS-only) — "+ New class…" in every entity modal's class dropdown
- Nathan: "when making a new trigger … a New Class option, to build a class that you want it to go
  into". `renderClassOptions()` appends a `__new__` sentinel; one delegated `change` listener
  (`_onClassSelectChange`) snaps the select back to its previous value (the sentinel can never be
  saved as a class id) and opens an inline name row under the select (`_openInlineNewClass`:
  Create / Cancel / Enter / Esc). Create → `createClass()` (now returns the class; same rules as
  api/classes.php: non-empty, ≤50, unique — an existing name just gets selected) → options
  re-rendered with the new class selected. Covers trigger, alias, ticker, gag, highlight,
  substitute modals (the only `*-class` selects). Verified: sandbox `node --check` + client gate.
- [ ] ⏳ Nathan's live click-through.

## SHIPPED 2026-10-13 (IONOS-only, no wmt-server restart) — Discord webhook URL silently blanked on save (mimic, 21 forum-channel webhooks)
- **Root (prod change_log + journal, 2026-10-13):** mimic re-pointed 21 channels (all `bchat *`,
  9 knight channels, soul, tell) at Discord FORUM-channel webhooks = `…/<token>?thread_id=<post>`.
  `api/preferences.php` save regex required the URL to END at the token → stored `''` for each,
  SILENTLY (13:51–14:02Z, 4 modal saves). The live wmt-server (prefix check only) kept the URLs
  in memory and posted fine all afternoon (DISCORD_SEND, 0 errors) → "initially worked"; the
  21:38Z reconnect reloaded prefs from the DB and Discord died on those channels. NOT the
  locrian switch (22:53Z) — that's just when she looked. The typed URLs were not captured
  anywhere server-side (JSONL/persist/proxy don't log them).
- [x] NEW `includes/discord_webhook.php` (NOT site-wide included): one validator, accepts
      `?thread_id=<digits>`, strips NBSP/ZWSP/BOM paste junk. `api/preferences.php` uses it for
      per-channel + global webhook; a REFUSED URL now keeps the stored one (never `''`) and the
      save response carries `rejected.webhooks[]` / `rejected.discordWebhookUrl`.
- [x] `assets/js/app.js` `_applyWebhookRejections()`: error line naming the channels + accepted
      form, resyncs in-memory `channelPrefs` and the open modal row to what the DB kept BEFORE
      pushing to the WS server — all three copies agree. Called from saveChannelPrefs +
      savePreferences.
- [x] Gate: NEW `DiscordWebhookUrl` (`tests/sandbox/test_discord_webhook_url.php`, PHP CLI) 22/22;
      registered in deploy.py PHP_SUITE_SCRIPTS. Lint + `node --check` on sandbox.
- [ ] ⏳ LIVE CONFIRM: mimic re-enters the forum URLs → change_log row shows `?thread_id=` stored
      (not `''`) + DISCORD_SEND on bchat/knight/soul/tell after her next reload.
- NOT covered: no e2e test of the save path (needs a PHP session + Lightsail; PhpLogin harness
  doesn't reach `/admin/preferences`); `api/export.php` import path untouched (doesn't validate
  webhooks); WS `set_discord_prefs` still prefix-only (client resync makes that moot — no restart).
  Old 21 URLs remain recoverable from change_log id 579669 if she ever wants them back.

## SHIPPED a327194 — DEPLOYED 2026-10-14 20:12:54Z (full gate 1359/1359; 8/8 live chars restored via bridge, 0 name prompts) — bot death on phone = `#show` browser hop
- ⏳ LIVE CONFIRM PENDING: first JSONL trigger record with `src:"showme"` (written by serverShowme when a
  trigger's #show output matches another trigger) — e.g. celbot `You cannot take that.` → `#show coins here.`
  with NO browser attached. None yet as of 20:14Z (bot running, path not exercised).
- **Root (prod JSONL 2026-10-13 + journal + code):** a server-side trigger's `#show`/`#showme`
  was forwarded to ONE browser as a `client_command` and only trigger-checked when that
  browser bounced it back as `test_line`. With ZERO browsers attached (phone app
  backgrounded 19:20:39Z, next attach 19:37; none at all 19:55→21:36) the `#show` sat in the
  replay buffer and the chain died. celbot: `Basilisk dealt the killing blow` 19:25:40Z →
  MUD said `You cannot take that.` → `#show coins here.` → the `coins here.` trigger
  (`#delay {celdelay} {k celestial}`) never fired → last step celstep148, idle until 21:37.
  Every post-kill `You cannot take that.` 10-09..10-13 WITH a browser advanced in 10s.
  tt++ `src/show.c do_showme` checks triggers on the text itself — WMT now does the same.
- [x] `glitch/server.js`: `serverShowme()` / `forwardHashCommand()` / `executeTriggerResults()`;
      all 10 executor forward sites routed through `forwardHashCommand`; test_line handler
      uses the shared executor; row form `#show {x} {row}` still browser-side; depth cap 20.
- [x] Gate: NEW `ShowmeServerTriggers` (`tests/sandbox/test_showme_server_triggers.js`,
      T1 = detached-browser pivot) 5/5; Triggers T15/T26 rewritten to tt++ semantics;
      VarSubst harness reads mud lines. Full gate 1336/1337 → the 1 was the VarSubst harness
      read, fixed and re-run 7/7.
- [x] Docs: troubleshooting.md (Trigger Issues), architecture.md (#showme section).
- [ ] ⏳ `python deploy.py all` — restarts wmt-server during Nathan's live session; WAITING for OK.
- [ ] ⏳ Live confirm after deploy: JSONL shows `"type":"trigger"...,"src":"showme"` records
      for `coins here.`, and a post-kill `You cannot take that.` with no browser attached
      still advances (celstep continues).
- [ ] Behaviour note to watch: a gag matching your own `#showme` text now suppresses it
      (tt++-faithful); a trigger's `#showme` fires matching actions exactly once (was once
      per attached-browser bounce).
- [ ] Not verified: which device held tokens 246df7dd / 16308bda (auth.log not pulled);
      the 10-07 22:59Z stall's browser state (journal expired). Prod `/tmp/capture_phone.*`
      from 09-28 still not cleaned (remote write denied this session).

## SHIPPED 2026-09-26 (commit 63c2ebf) — PHP session died at exactly 7 days (cookie cliff)
- **Root (auth.log 08-22→09-26 + session files):** the PHP session cookie is issued once at
  login with `lifetime = SESSION_LIFETIME` (7d, includes/auth.php initSession) and never
  re-sent, so it expires in the browser 168h after login regardless of activity. 124 authed
  sessions >24h in the log: 23 (11 users) end in the 167.5–168.5h band, max span 168.0h.
  Minutes after each cliff the same character's next API call has `cookie=NOT SET` while
  `data/sessions/sess_<id>` still exists with user_id. Nathan's 09-25 evening "session died"
  was two of his sessions (509078a1, 297181ab) hitting 168h.
- [x] **Fix (63c2ebf, deployed ionos 12:20 CDT, PHP-only, no wmt-server restart):**
      `refreshSessionCookie()` (includes/auth.php) re-issues the SAME session id with a fresh
      7d expiry on authed requests, throttled once/hour via `$_SESSION['_cookie_issued_at']`
      (stamped at login so the login response emits no 2nd cookie). Called from requireAuth
      (functions.php) and isLoggedIn. Logs `session cookie REFRESHED`. Sessions that predate
      the deploy have no stamp → refreshed on their next authed request.
- [x] **Proof:** PhpLogin T9a/b/c — NEGATIVE-CONTROLLED on the sandbox (old phpsrc: T9b
      fails "cookies=[]"; patched: 11/11). Gate 124/124. Deployed files verified on IONOS;
      index.php / app.php / api check all 200 after the site-wide include change.
- [ ] ⏳ CONFIRM live: auth.log shows `session cookie REFRESHED` lines, and no Nathan
      session ends at the 168.0h mark after 2026-10-03.
- [ ] **Separate, unproven:** 2026-09-26 09:08 CDT loss of a 39h-old session (fa5b029e alive
      server-side, browser sent no cookie after PC wake). Not the cliff. Needs capture.
- [x] (shipped e4cccf4, 2026-09-26 09:16 CDT, client-only) `cmdRead` 401-after-retry →
      `logout()` → login screen instead of the stranded "Failed to read script startup.tin".
- [ ] Same 401→login treatment for `loadSettings()` (app.js:392) — still fails silently; a
      dead stale tab re-fires the 7-call list burst every 10–25 min.
- [ ] `tests/sandbox/test_session_recovery.js` (T1/T2 pass, T3 red = remember-me gap) is
      untracked — `git add` + decide whether T3 stays red-by-design or a recovery path ships.

## SHIPPED 2026-09-14 (commit 2ec261e) — resume-echo multi-device clobber (the July recurrence)
- **Root:** the 2026-07-21 mergeDevicePush fix (199daaf) did NOT cover the resume
  path. When a 2nd device resumes, the server replays the full entity set via
  `authoritative_state`; the client echoes it straight back, which credited that
  device with AUTHORING entities it never created. Its next bare push then
  deleted them by omission — elminster's aliases 986→125 with ZERO ENTITY_MERGE
  (2026-09-12). Two-device only; single-device play was always safe.
- **Fix:** echo guard. `loadAndPushAuthoritativeState` stamps `ws._echoExpected`
  (content keys just sent, 15s window); `mergeDevicePush` keeps echoed entities
  OUT of the device's authored-baseline (gates authorship only, never the session
  set), so an echo can't license a later delete. Logs ENTITY_ECHO_GUARD.
- **Proof:** new gate suite ResumeEchoClobber (3 tests), NEGATIVE-CONTROLLED —
  red on HEAD server.js, green on patched; MultiDeviceEntitySync stayed 8/8.
  Full gate 1329/1329. Prod deploy: 2 live players RESTORE_BRIDGE_RESUME, 0
  boots/suppressions/fresh-logins; echo-guard code confirmed in /opt/wmt/server.js.
- **NOT covered / follow-up:** this is still a containment guard on a racy design
  (any device can win a full-state bulk replace). The durable end is per-entity
  ownership (single-owner model). Echo window is time+content-boxed (15s) — a
  genuine load of the SAME content within 15s of resume is treated as echo
  (harmless: entity already exists). Cross-device explicit deletes unchanged.

## SHIPPED 2026-08-30 (commit c2f4937) — SLOW_REGEX false-positive kill + guard blind spot
- **Root incident:** the ReDoS guard disabled elminster's in-combat
  `^Coff: ... Mon\(...\)` trigger on ONE 63ms wall-clock sample (02:18:01, a
  GC/CPU blip — the pattern runs cleanly every 2s all day) → `$combat` stuck
  off mid-celbot, out-of-combat body ran every round (study spam, $sitting
  climbing). Same guard killed the trivially-linear "stands fast, resisting
  your stun" trigger Aug 24 (75ms). Both re-enabled 03:11:18 via /admin/trigger.
- **Fix A — 3-strike slow-regex disable** (server.js processTriggers): disable
  only after 3 slow hits (>50ms) within 60s, tracked on session.loopTracker;
  sub-threshold samples log `SLOW_REGEX_WARN` and the completed match is USED
  (no skip — skipping let the sibling out-of-combat trigger fire instead).
  test_line/MIP paths (no tracker) can never disable. Gate: **SlowRegexGuard**
  (new, T1 red on pre-fix server → green).
- **Fix B — entity_guard extractor blind spot**: triggers extractor now includes
  `enabled` + `priority` (tickers: `enabled`) in the compared identity. Without
  it, an enabled-ONLY admin edit looked "caught up" to the guard → cleared →
  the browser's next bulk sync re-disabled the trigger **1s** after the admin
  fix (observed live 02:46:06→02:46:07). Gate: EntityGuard **T6** (red→green).
- Gate 1326/1326; deploy bridge-resumed all live sessions (elminster
  bridgeResumed:true, zero fresh logins).
- **✅ LIVE-VERIFIED 03:18 UTC:** next real fight (Mon(Put)) fired `#var combat on`
  every round; last out-of-combat body on a combat line was 03:10:29 (pre-fix);
  zero SLOW_REGEX since deploy. Remaining cosmetic: Nathan's browser holds
  enabled=false in ITS memory until his next hard refresh — DB is protected by
  Fix B meanwhile (guard override on his next bulk sync is gate-proven, not yet
  observed live).
- NOT changed: loop-detection disable (50 fires/2s) — a genuine signal, kept
  as-is; client-side disable_trigger persistence (a 3-strike disable still
  saves as before, intended for real ReDoS).

## SHIPPED 2026-08-09 (commits 0026dd0 + a82c2c8)
- **Script editor CodeMirror upgrade + TinTin++ syntax highlighting.** The
  scripts-panel editor modal now lazy-loads the same vendored CM stack as the
  FTP editor (textarea fallback intact): custom `tintin` mode written against
  tintin-reference/parsing.md (command-position `#commands`; `#nop` comments
  styled through to their `;` terminator so the missing-semicolon trap is
  visible; `{}` depth + auto-indent; `$&*` vars; `%N`/pattern atoms; `@func`;
  `\`-escapes; `<abc>` color tags; bold `;`), line numbers, folding, find/
  replace (newly vendored search.js addon — CAUGHT: new untracked file missed
  the auto-commit → app.js referenced it before it was uploaded; committed +
  deployed in a82c2c8, verified byte-identical on IONOS), go-to-line, Ctrl-S
  save-without-close, dirty guard on Cancel/✕/outside-click (outside-click was
  silently discarding edits even pre-CM). Modal widened to 1100px.
  Gates 121/121 + php -l. NOT covered: no gate exercises the editor UI —
  verify live; light-theme palette not done (dark only, matches client).
  Also committed the ghost EspCapture suite (was untracked, gate ran it from
  the working tree).

## SHIPPED 2026-08-02 (commits f924b71 + 2c33270)
- **ESP → ChatMon capture** (jedi telepathy — plain game text the MUD left out of
  MIP). `observeEspLine()` in server.js passively watches output for
  `<Name> thinks . o O (` / sender echo `You think to <Name> . o O (` (both
  live-verified formats), buffers indented continuations to the closing `)`
  (5s safety-net flush), reflows to one paragraph, and emits `mip_chat` on
  channel **esp** — so it inherits ChatMon tab, resume replay, 30-day DB history,
  Discord/IFTTT channel prefs, suppressSelfAlerts with ZERO client changes.
  Raw lines still render in the terminal. Gate: EspCapture (8 scenarios).
  Verified post-deploy: prod file has the code; all 8 live players bridge-resumed.
  **NOT covered:** no live ESP thought has flowed through prod yet (Ukyo check
  pending); Discord/IFTTT for 'esp' untested live (needs channel prefs set);
  only the two verified formats match — unknown variants (broadcast/emote forms)
  are ignored by design; a thought line ending in `)` mid-thought flushes early
  (partial to ChatMon, rest terminal-only).
- **deploy.py now ships glitch/mock-mud.js + restarts the sandbox mock** during
  gate staging. The sandbox mock had been frozen since Jun 9 (no `__emitline`) —
  its red "Unknown test command" replies were fake MUD output inside suites.
  First gate run failed EspCapture exactly this way; fixed mock → 1323/1323.

## SHIPPED 2026-07-11 (commit 5813499 + review-fix batch)
- **`var_query` `#var` server cross-check** (Phase 3 step-3 precursor). Client
  `#var <name>` asks the server for the authoritative value and warns on
  divergence — the $ring-incident diagnostic. Gate: ServerVarEngine T10.
- **Script backup rotation** — `backupScriptFile()` 3-tier (.1–.10 + daily/weekly)
  before overwrite. Closes the 'twist stone' zero-history gap. Gate: ScriptBackup
  (new PHP CLI suite; deploy.py now runs *.php suites with `php`).

### Fable reviewer (commit 5813499) → ACCEPT-WITH-CONDITIONS → all conditions fixed:
- F1 ✅ export.php copy-character overwrite now backs up first (was an uncovered
  clobber path — the exact class the feature was built for).
- F2 ✅ backup artifacts excluded from the storage quota (`isBackupArtifact` in
  getDirectorySize/getDirectoryFileCount) — was a slow file-count wedge.
- F3 ✅ script delete now sweeps its backup siblings (was orphaning them + wedging
  empty-folder deletion).
- F4 ✅ var_query flushes pending writes first + skips during bulk #read (was a
  false "SERVER has NO variable" on set-then-query — would train users to ignore it).
- F6 ✅ order-insensitive value compare (`_canonicalJson`) — was crying wolf on
  key-reordered tables.
- F7 ✅ ISO-year weekly label (`o` not `Y`) in BOTH backupScriptFile AND the
  pre-existing saveJsonFile (year-boundary weekly self-pruned on creation).
- F9a ✅ debug.php `state` listing filters backups; F9b ✅ duplicateCharacter no
  longer clones backup files.
- F10 ✅ ScriptBackup PHP test added (16 cases); ghost gate suites committed.
- **F5 DEFERRED (documented, not silent)** → see Phase 3 open items: indexed
  `#var hp[self]` gets no cross-check yet. A nested compare risks the false-
  positives F4/F6 just removed; needs the server to echo keys (a wmt-server change)
  to do right. Scalar — the proven $ring case — is fully covered.
- F8 (dedupe backupScriptFile vs saveJsonFile into one helper) → open, below.
- **RECEIVED INPUT dedup — still deferred** (Phase 3 Step 4). Needs live idle-system
  verification, not a batch ride-along.

## 🔥 ACTIVE: Phase 3 — single-owner variable model completion ("client as view")
The cure for the client/server variable-divergence class. Two fresh bite marks
this week: phone resume re-init killed dosec (2026-07-10), and `#var ring` showed
the client store's stale "on" while the server evaluated undefined (2026-07-11).
Plan lives in `docs/review-2026-07-07-variable-model-findings.md` ("Minimal Phase 3").

- [x] Step 1 — per-key `var_ops` replaces full-store push (cea2836, 2026-07-08)
- [x] (unplanned) resume-startup `#var` = init-if-absent — the phone-hop bot-killer
      (94310d1, 2026-07-10, gate: ResumeStartupGuard)
- [x] Step 2 — connect-time variable flush removed (resume = pull-only; legit
      blip-queued ops flush via the before-every-command path), stale op queues
      (>60s untouched = suspended tab) dropped instead of sent, set_functions
      gated on non-empty like events (2026-07-11, gate: ResumeStartupGuard T6-T8)
- [ ] Step 3-precursor followup — indexed `#var name[key]` server cross-check
      (F5 from the 2026-07-11 review). Needs server var_query to echo the queried
      keys so the client resolves+compares the nested slice without a false-positive
      nested compare. wmt-server change → own deploy.
- [x] Step 3-precursor (scalar) — `#var <name>` cross-checks + flags the SERVER
      value. SHIPPED 5813499 + review-fixes (see SHIPPED section), gate ServerVarEngine T10.
- [x] **Step 3 SHIPPED 2026-07-11** — typed `#var`(set, incl. indexed)/`#math`
      (scalar)/`#unvar`(exact) lines route WHOLE + UNSUBSTITUTED to the server's
      command executor (the same gate-covered pipeline every alias/trigger chain
      uses); the client store is a VIEW for those writes (var_update applies via
      the new `_applyVarUpdate` choke point; typed #OK/#math feedback prints from
      the AUTHORITATIVE round-trip value). ZERO server.js changes — the server
      pipeline already owned these verbs for every other path. Gate:
      TypedVarRouting (30 cases, negative-controlled: 0/20 on pre-change app.js),
      full gate 1277/1277.
      **Stays LOCAL by design (documented decisions, not gaps):** queries/
      wildcards (display + var_query cross-check), `#list` (server F10 corrupts
      associative objects — route AFTER F10 is fixed), table-creation values
      `{{k}{v}...}` (server would store a string), chains containing any
      non-routed verb (#end/#ticker/#showme keep their typed semantics),
      multi-line PASTES (async routing would stale-substitute line 2), bulk
      `#read`/silent contexts (class scoping + init-if-absent), disconnected
      fallback (local + ops queue as before). Trigger/event/#delay/MIP executors
      still client-side = Step 5.
      ⏳ LIVE CHECK pending (Nathan): hard refresh → `#var ring on` → #OK line
      appears (round-trip working) → `#var ring` shows it, var_query silent.
- [x] **Step 4 SHIPPED 2026-07-11 (49b791a)** — RECEIVED INPUT dedup: the client's
      local fireEvent (app.js sendCommand) DELETED; the server's per-'command'
      dispatch (server.js:8448, skips name prompt) is the ONLY fire. $idle reset
      was already server-side (Phase 1) — unaffected. Cumulative handlers
      (#math c $c+1) stop double-counting; a handler sending a MUD command no
      longer triple-fires. lastUserInput deadman stamp KEPT. Gate: TypedVarRouting
      T30/T31 (T30 regex negative-controlled against pre-change app.js), subset
      79/79. Behavior note: local-only typed lines (# queries) no longer count as
      "input" — matches lastInputAt, which only ever stamped on real sends.
- [x] **Step 5a SHIPPED 2026-07-11 (f08414a, gate 1298/1298, 4/4 live players
      resumed through the restart — elminster/donovan/mimic/hooligan, buffered
      MUD data delivered)** — typed `#delay` schedule forms route to the server
      (survive phone sleep; silent, tt++ parity); NEW `delay_query`/`delay_list`
      messages (var_query pattern): bare `#delay` lists the AUTHORITATIVE pending
      set incl. trigger-scheduled delays that were previously INVISIBLE (name,
      command, remaining secs from _wmt_fireAt); typed `#undelay {pat}` removes
      with wildcard + prints the count. BONUS parity fix: inline #undelay
      (trigger bodies) was exact-name-only — `#undelay {heal*}` silently no-opped
      (F4 class); now wildcard-capable via shared removeDelaysMatching(). Gate:
      ServerVarEngine T11-T13 (negative-controlled: 3 FAIL on pre-change server),
      TypedVarRouting T32-T47. Stays local: literal-bad-seconds (client usage
      error), mixed-brace forms (conservative), #read scripts, offline (a delay
      created offline lives client-side + won't appear in the server listing —
      tiny window, still fires).
- [x] **Step 5b SHIPPED 2026-07-11 (f507d2f, gate 1307/1307, 8/8 players resumed
      through the restart)** — MIP conditions evaluate SERVER-side: conditions
      load from the prefs blob in wmt.db (loadMipConditions at auth/resume/
      restore + live-refresh when a prefs save lands via /data-sync), evaluated
      on every FFF stats update (mipVarsOf mirrors the client derivation
      field-for-field; evalMipCond is a verbatim port incl. loose ==; 5s
      cooldown; combatOnly round-gate; AND/OR subConditions), firing through
      executeExpandedInline. DOUBLE-FIRE-PROOF transition: server evaluates ONLY
      for clients that declared `mipCond:1` at auth; old cached tabs keep their
      local brain (ServerVarEngine T20, negative-controlled). Delegation rides
      the persist payload → a suspended phone's heal-gating survives deploys.
      Client evaluator retired (TypedVarRouting T48/49). Gate: SVE T18 (fires on
      low hp), T19 (cooldown), T20 (capability gate) — all red on pre-change
      server. Per-char JSONL logs `mip_condition` rows on every fire.
      ⏳ LIVE CHECK (Nathan): next real fight with a heal condition enabled —
      watch it gate. Also on it: mip_debug echo of server fires is NOT ported
      (client mipDebug flag only affected local eval) — check JSONL instead.
      ⚠️→✅ **HOTFIX 2e586f1 (~31 min after 5b shipped)**: loadMipConditions read
      `prefs.mip_conditions` (snake) but the REAL key preferences.php writes is
      `mipConditions` (camelCase) — 16 live characters carry conditions under it;
      for them server evaluation loaded NOTHING (and new clients no longer eval
      locally). Caught by the cold-archive verification pass, fixed + gated
      (SVE re-seeded with the REAL key shape) + deployed same hour.
      ⭐ LESSON: seed suite fixtures from a REAL production record's shape, never
      from the author's assumption — the original test seeded the same wrong key
      and greenly masked the bug.
- [x] **Step 5c SHIPPED 2026-07-11 (same deploy)** — #loop/#foreach/#break/
      #continue execute server-side (exact client parity: 1000-iteration cap,
      #break stops after the current body, table-form value iteration with
      numeric-then-lexicographic key order, braced/semicolon list fallback;
      iteration vars stamp _varServerModified; view gets ONE final var_update —
      inner parts are server-substituted per-iteration). PLUS a server-only
      safety the browser never needed: 10k total-iteration budget shared across
      nesting (a runaway nested loop on a shared single-threaded server stalls
      EVERYONE, not just the author). Gate: SVE T14-T17, red on pre-change
      server. #local left client-side (ephemeral by definition, zero divergence
      surface). Invalid arg shapes still fall through → client prints its usage
      errors (parity).
- [ ] Server verb-layer refactor (was "pre-step-3"; verified 2026-07-11 as NOT
      required for Step 3): verb dispatch table + one executeExpanded() helper +
      one state-mutation choke point (kills the ~6× copy-paste). Verified by read:
      every mutation site ALREADY stamps `_varServerModified` + emits var_update,
      so the choke-point PROPERTY holds today. Do this as prep for Step 5.

## Variable model — review findings batch (same doc)
- [ ] F6–F13 batch (parser drift, misc) — "behind new negative-controlled gate
      cases; then F9–F13 opportunistically"
- [ ] Runtime tickers visible in the client ticker LIST (view-only push — Phase 3 adjacent)

## Accounts migration (job_accounts_migration.md)
- [x] Phase 1 — characters DB-first + is_wizard + backfill 209/209 + orphan purge
      (feba296 + b2146e4, 2026-07-10)
- [ ] Freeze pass (after soak): drop JSON writes for characters.json + the
      users_index mutation flows (loadUsersIndex read-modify-write → DB endpoints)
- [ ] DECISION needed (Nathan): keep the login-path JSON net permanently as
      Lightsail-outage insurance, or full DB-only auth?
- [ ] profile.json: fold registered_ip/banned_at into users table, or leave (low value)

## Multi-device / session identity
- [x] 🔥 **Mobile-botting clobber FIXED 2026-07-21 (199daaf, gate 1315/1315,
      8/8 live players bridge-resumed through the deploy)** — root cause proven
      same day from logs (memory: bug_mobile_bot_multidevice_trigger_clobber):
      a second attached client (home PC, sec script NOT loaded, 222 triggers/
      125 aliases) re-pushed its FULL trigger/alias/ticker state every ~100s
      (riding the stuck `#unticker {hasted}` loop); set_triggers/set_aliases/
      set_tickers were last-write-wins bulk replaces → the bot device's
      script-loaded entities (230/573) were deleted by omission → bot died at
      its next trigger dependence ("kill 1 mob then stop"; all 3 deaths matched
      the push cadence: 104s/107s/109s). FIX: `mergeDevicePush()` in the three
      set_* handlers — a device may only delete-by-omission entities it ITSELF
      pushed on this connection (baseline = ids+content of its previous push);
      a connection's first push deletes nothing; content-duplicates (same
      script on two devices under different client ids) don't double-register
      (double-fire = regression-checklist #12 class); _runtime tickers stay
      owned by updateSessionTickers. Zero client changes, no new message
      types — old cached tabs are contained, not upgraded. Gate:
      MultiDeviceEntitySync (8 cases; negative-controlled: T1/T3/T5/T6 red on
      pre-change server). Observability: `entity_merge` JSONL row + ENTITY_MERGE
      journal line whenever a push has entities preserved.
      **NOT covered (explicit):** cross-device deletion (device B deleting
      entities it never pushed — e.g. `#class kill` typed on the OTHER device —
      is suppressed server-side until the owning device syncs it); the client's
      HTTP save path to the DB was not audited this pass (the WS dual-write
      dbSave* now writes the MERGED set, which stops the observed DB
      flip-flop); the per-entity-ops refactor (true single-owner for entities,
      var_ops-style) remains the architectural follow-up — this is the
      containment fix.
      ⏳ LIVE CHECK (Nathan): next mobile bot launch with the home PC still
      online — bot should survive past ~105s; `entity_merge` rows in the
      per-char JSONL are the tell.
- [ ] Rekey ping-pong: a joining device should JOIN, not take the token
      ("coexist, not fight" — project_disconnect_detach_redesign). Still the
      standing suspect for stale-view confusion on device hops.
- [ ] LIVE TEST pending (Nathan): phone hop onto a running bot after the
      ResumeStartupGuard fix + phone hard-refresh — validates the 2026-07-10 fix
- [ ] UNEXPLAINED: aegis bot stop 2026-07-10 05:47, ~20 min after the 05:26
      deploy restart — same delayed-fuse shape, cause unpinned
- [ ] `#unticker {hasted}` loop — STILL LIVE 2026-07-21 (fires every ~100s,
      verified in today's logs). Now upgraded from cosmetic to AGGRAVATOR: each
      fire triggers the full-state re-push that clobbers mobile bots (see item
      above). Lives on the bare client (home PC); a clean relaunch of that tab
      should stop it — if not, dig.

## Scripts (.tin) durability
- [x] Backup rotations for .tin saves — SHIPPED (82daa64, gate ScriptBackup 16/16
      + review-fix batch). 3-tier scheme; excluded from quota; delete sweeps them.
- [ ] Stale-save guard for the script editor (save carries loaded-version mtime/
      hash; reject if the file changed since it was opened). This is the piece that
      actually PREVENTS the multi-device clobber; rotations only make it recoverable.
      NOT started — a real feature, needs the editor to send the loaded mtime/hash.
- [ ] Review F8: dedupe backupScriptFile vs saveJsonFile rotation logic into one
      shared helper. DEFERRED deliberately — saveJsonFile is the core persistence
      fn for all triggers/aliases and is NOT exercised by any gate suite, so a
      refactor regression wouldn't be caught. The F7 correctness fix already landed
      in both copies. Do this in isolation WITH a saveJsonFile test first, not bundled.

## Repo / infra (review architecture items + leftovers)
- [ ] 🔥 **ALL outbound email dead since ~Feb 2026 — SendGrid account has 0 credits**
      (found 2026-07-31, `memory/bug_password_reset_sendgrid_no_credits.md`).
      Proven: `/v3/user/credits` total=0/remain=0/hard-limit; replayed mail/send
      → 401 "Maximum credits exceeded"; stats = 6 delivered Jan, 0 requests
      Feb–Jul. Password-reset flow itself verified sound end-to-end (live repro
      2026-07-31: token written, 200 returned, nothing reached SendGrid);
      contact.php uses the same sendEmail() so it's dead too. Client hides the
      failure by design (anti-enumeration). FIX = Nathan's billing call: pay
      SendGrid, or swap provider in includes/email.php (SES recommended — AWS
      account already exists, ~$0.10/1k). Also consider surfacing send-failures
      somewhere reachable (IONOS error_log destination never found).
- [x] Commit ghosts: maplib.js + .htaccess (0e4a41e); the 6 untracked gate suites
      (82daa64). Remaining: verify no sandbox-only suite is still uncommitted.
- [x] ✅ Review F7c FIXED (2026-07-11): gate no longer counts exit-0-without-a-
      results-line as a pass — fails closed (a silent/early-dying harness can't
      green the gate, esp. a 1-2 suite subset). Every current suite emits the line.
- [x] ✅ Review F6 FIXED (2026-07-11): known-failures are now per-SUITE-label
      (`KNOWN_FAILING_SUITES` set), not a global count — a subset budget can't
      absorb an unrelated real failure. Currently empty (every failure blocks).
- [ ] Gate runner: retry ONCE on ssh transport failures ("Connection timed out
      during banner exchange") — two 2026-07-11 gate runs each lost one suite to
      this flake (SelfAlerts, then SessionPersist); both re-ran green solo; each
      flake cost a full 10-min re-gate. Distinguish transport failure from test
      failure (the fail-closed parse already catches silent-no-output cases).
- [ ] Manual-suite note (2026-07-11): back-to-back MANUAL ServerVarEngine runs
      contaminate each other via mock-MUD reconnect state (T9 c3=NaN) — restart
      mock-mud + wmt-server between manual runs. The real gate is unaffected.
- [ ] Review F7b: gate/abort block copy-pasted in 5 dispatcher sites. DEFERRED —
      refactoring the critical deploy dispatcher for cosmetic gain, right after
      adding all the new gate logic, is how a subtle deploy-breaking bug slips in.
      Do in isolation after this soaks.
- [ ] Behavioral suites for the suite-uncovered api/ endpoints (review F3):
      preferences (the default-deny whitelist foot-gun), aliases/triggers/tickers/
      classes, characters, export/copy, the admin + discord/report proxies. They
      parse-check now but nothing tests their logic. Highest value: preferences.
- [x] ✅ Review F2 FIXED (2026-07-11): `deploy_test_server(restart_server=False)`.
      The client/PHP gate no longer pushes the working-tree server.js or restarts
      wmt-server with it — it stages the suite inputs (tests, app.js/connection.js,
      phpsrc) and runs against the sandbox's EXISTING build (server.js unchanged for
      a client/PHP deploy == what's on prod). Verified: 3 client-VM suites DO open a
      real WS (VarClassScope/ReconnectGate/LoginConflict) — they pass 71/71 against
      the existing server without a redeploy. So a broken/WIP server.js can no longer
      block an unrelated PHP hotfix. If the sandbox wmt-server is somehow down, the
      light path restarts the EXISTING binary (no working-tree push) and, failing
      that, reports clearly (--force still available).
- [ ] Review F6: `KNOWN_FAILURES` is a global count applied to subset runs too.
      Currently 0 (latent). If ever >0, a 2-suite subset where both fail could
      compute unexpected=0 and deploy. Scope known-failures per-suite/label.
- [ ] Review F7b: the gate/abort block is copy-pasted in 5 sites (all/lightsail/
      ionos/auto-server/auto-ionos) with drifting wording + print_prod_db_health
      present in some. Extract one helper before the next semantics change.
- [ ] Review F5 (memory note, not code): deploy_test_server clobbers the
      sandbox-only staged server.js on every gated deploy now — the ON-HOLD
      block-trigger job's uncommitted sandbox code is thus unviable to keep there.
- [x] ⚠️→✅ PHP/client-only deploys were UNGATED (surfaced+fixed 2026-07-11,
      reviewed → fixed conditions). `deploy.py auto`/`ionos` shipped api/*,
      includes/*, app.js to IONOS with NO suite run and (turns out) NO php -l
      either — deploy.py never linted. FIX: `relevant_test_scripts()` maps changed
      files → suites (PHP → PhpLogin+ScriptBackup; app.js/connection.js → the 5
      client-VM suites; css/docs → none); auto IONOS-only branch + explicit `ionos`
      stage the sandbox + run that subset (`run_test_suites(only_scripts=...)`),
      PLUS `php_lint_changed()` runs `php -l` on EVERY changed PHP file. Server.js
      changes still run the FULL gate. Drift guard: a requested suite missing from
      the live list aborts (can't silently skip). Ungated files (css/.htaccess)
      print a loud "UNGATED → prod" line. Verified: PHP subset ran exactly
      PhpLogin+ScriptBackup (24/24); php -l negative-controlled (catches a parse
      error, passes good files).
      ⚠️ HONEST COVERAGE (review F3): the two PHP suites exercise only the auth
      login-cycle (api/auth.php + the login include chain) and functions.php
      backup rotation. Most api/ endpoints (preferences, aliases, triggers,
      tickers, classes, characters, export, discord/report proxies, admin) are
      now PARSE-CHECKED (php -l) but NOT behaviorally suite-covered — a green gate
      on a preferences.php change proves it parses + login still works, NOT that
      preferences logic is correct. Real behavioral coverage for those = new
      suites (below).
- [x] **Dead weight DELETED 2026-07-12** (Nathan's go): root server.js + websocket/
      Ratchet (git rm + removed from deploy.py IONOS list + deleted from the IONOS
      server incl. its deny-all .htaccess); Bot Engine block cut from glitch/server.js
      (11.8k chars: engine block + template + 6 reference points, 0 session.bot refs
      remain; full gate = the referee); 5 orphaned PHP path builders removed
      (getClassesPath never existed); PII purged from the OneDrive tree (db_users.json,
      2 pcaps, 12 screenshots, mimic_prefs backup).
      **DEFERRED as a pair:** api/bots.php + getBotsPath + the CLIENT bot panel code
      (app.js bot_status/bot_start/fetches) — the dead panel still fetches the
      endpoint; remove both sides together so it degrades to invisible, not to
      console errors. NOTE: bots.json files went in the cold sweep BEFORE bots.php
      (sequencing slip, zero harm — loadJsonFile(missing)→[] so the dead panel
      lists empty).
- [x] **JSON cold archive DELETED 2026-07-11**: 1671 files / 15MB (aliases/triggers/
      tickers/preferences/classes/bots/mip_conditions .json + all rotations) swept
      from IONOS data/users/*/characters/*/, 0 failures. Coldness PROVEN first:
      zero callers of every path builder; get/save_mip_conditions are DB-only.
      Belt+suspenders: 844 bare .json files archived to sandbox
      /opt/wmt/offsite-backups/json_cold_archive_2026-07-11.zip (471K).
      ⭐ The verification pass ALSO caught the mipConditions camelCase key bug in
      the fresh 5b code (see below).
- [x] **Prod disk RECLAIMED 2026-07-12**: wmt.db.pre-shrink (6.7G) + 
      wmt.db.pre_entity_guard.20260503 (1.9G — earlier "already gone" claim was
      WRONG, I'd checked the unsuffixed name) both deleted; disk 39%→17%.
- [ ] Extract shared TinTin evaluator (mathexp/tintoi/tineval) into one file used
      by both sides + parity gate suite
- [ ] tt++ parity: standalone `#elseif`/`#else` after a `;`/newline split
      (real tt++ remembers the previous #if's result; WMT only parses the chain
      inside ONE #if command → "Unknown command: #elseif", Nathan 2026-08-10).
      Touches the protected command pipeline BOTH sides — own change + gate,
      not a ride-along. Workaround: unbroken chain or positional else.
- [ ] Prod disk: delete wmt.db.pre-shrink (6.7G) — shrink stable since 2026-06,
      offsite nightlies running since 2026-07-07; verified still present 2026-07-11,
      awaiting Nathan's go (destructive). NOTE: wmt.db.pre_entity_guard (1.9G) is
      ALREADY GONE (verified absent 2026-07-11 — removed at some earlier point).
- [ ] Bridge-restart runbook (for the eventual forced restart)
- [ ] Sandbox box = SPOF for the safety story (only gate runner) — document/mitigate
- [ ] JSON cold archive cleanup: the frozen data/users character JSON files
      (~9.5MB/user backups included) — deletable whenever, zero urgency

## Map — coordinate layer + graphml interchange (PLANNED 2026-08-24)
Plan: `docs/map-coordinate-layer-plan.md`. Concept agreed with Nathan: every room
gets a persistent curated x/y (layout moves from runtime to build time); Byron's
3kdb stays graph truth (regenerated); coords = our layer keyed by vnum, survives
re-pulls; graphml = import/export curation format (yEd round-trip), NOT storage.
Trigger: player-submitted `CZ Shadows Map.graphml` — 327 rooms NOT in Byron's map
(light side only; force-field room desc proves it), perfect 30px grid.
- [ ] 1. Coordinate layer + offline bake (port existing layout logic, run over 776 areas)
- [ ] 2. Renderer reads stored coords (skip BFS grid-walk)
- [ ] 3. Exporter: area → graphml (vnum/name/edge attrs embedded)
- [ ] 4. Importer: graphml → coords/overlay (vnum-tagged exact; untagged inferred + synthetic vnums)
- [ ] 5. Prove loop on CZ Shadows (blocked on: how to enter Shadows in-game; how
      levels connect; meaning of hidden labels — ask the mapmaker)
- [ ] 6. MAYBE later: player-authored maps (enrich-on-visit = trust mechanism)

## Parked / declined (so they don't resurface as "open")
- ChatMon: silenced channels count against the replay window — Nathan explicitly
  OK with it (2026-07-09); per-channel replay design noted in reference_chatmon_replay_model
- Native bot system — scrapped, cleanup only (see dead weight above)
- ipinfo Lite endpoint — deliberately NOT used (no city); standard endpoint + token live
