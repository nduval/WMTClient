# WMT Backlog — the single source for OPEN work

> **Rule (2026-07-11):** every work session updates this file — items move to DONE
> with commit + date, new items get added when discovered, and "done" claims in
> conversation MUST match this file. Born from the Phase-3 confusion: "step 1
> shipped" read as "Phase 3 shipped" weeks later. If it's not DONE here, it's not done.

## ⚠️ HAND-OFF STATE 2026-07-11 (Opus session → Nathan swapping to Fable to evaluate)
There is UNCOMMITTED, UNDEPLOYED work in the tree — 4 files, +106 lines, all
ADDITIVE (verified `git diff --stat`; all 4 pass php -l / node --check on sandbox).
NOT gated, NOT deployed — left local ON PURPOSE so Fable can review the diff before
anything touches prod or the DB (Nathan: "opus has done harm to my code and database").
Nothing here has written to prod or the DB. What the diff contains:

1. **Phase 3 step-3 PRECURSOR — `#var` server cross-check** (glitch/server.js +
   assets/js/app.js). New `var_query` WS message (server reads session.variables,
   returns `{defined, value}`); client `cmdVar` single-name display sends it and
   `_onVarQueryResult` flags divergence ("⚠ SERVER has NO variable {ring}…"). Pure
   read on the server; additive on the client. This is the fix that would have
   surfaced the $ring outage on the first `#var ring`.
   → TO SHIP: gate (VarSyncFlush/ServerVarEngine unaffected; add a var_query gate
     case ideally) + deploy.py auto (client+server → wmt-server restart → verify
     seamless resume). LIVE CHECK: `#var somevar` when client/server agree = silent;
     force a divergence = the warning shows.

2. **Script backup rotation** (includes/functions.php `backupScriptFile()` +
   api/scripts.php save & upload paths). Mirrors the triggers/aliases 3-tier scheme
   (.1–.10 rotations + .daily kept 14d + .weekly kept 8w) BEFORE an overwrite.
   Closes the 'twist stone' zero-history gap. Backup files have non-tin/txt
   extensions → `listScripts` (scripts.php:188) filters them from the list and
   they're not loadable. @copy/@unlink are best-effort (won't break a save).
   → NOT covered: delete path keeps no backup (deletes are explicit+confirmed,
     lower clobber risk); storage-limit check runs before the write and doesn't
     count the backup bytes (modest, best-effort — a near-limit user slightly
     overshoots, harmless). IONOS-only deploy (no server restart), but NEEDS the
     stale-save guard too (below) to actually stop the multi-device clobber.

3. **RECEIVED INPUT dedup — REVERTED, deliberately not shipped.** Opus started it
   then reverted (the diff is clean of it). Reason: it changes the idle/auto-#end
   system, which has a real history of wrongly disconnecting players
   (bug_serverside_end_idle_active_kick). Server dispatch is confirmed present
   (server.js:8449) so the dedup is CORRECT per plan — but it needs LIVE
   verification ($idle still resets on input; idle auto-#end still fires when
   genuinely idle; no client-only event regressions) before shipping, not a
   ride-along in a batch. Left as an open step below.

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
- [ ] Step 3 — route typed `#var`/`#math`/`#list`/`#unvar` to the SERVER store;
      client store becomes view-only (var_update + resume pull). This is the one
      that makes `#var ring` tell the truth.
- [~] Step 3-precursor — `#var <name>` cross-checks + flags the SERVER value.
      CODE WRITTEN, uncommitted (see HAND-OFF STATE). Needs gate + deploy + live check.
- [ ] Step 4 — RECEIVED INPUT dedup (remove client fireEvent at app.js ~4589).
      Server dispatch confirmed (server.js:8449). STARTED then REVERTED for the
      hand-off — needs live verification of $idle reset + idle auto-#end before
      shipping (touches the player-disconnect system; do NOT batch it).
- [ ] Step 5 (deferred by design) — MIP conditions + #delay server-side; retire
      client_command by porting the remainder
- [ ] Pre-step-3 server refactor (recommended by review): verb dispatch table +
      one executeExpanded() helper + one state-mutation choke point that stamps
      `_varServerModified` and emits view updates (kills the ~6× copy-paste)

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
- [ ] Rekey ping-pong: a joining device should JOIN, not take the token
      ("coexist, not fight" — project_disconnect_detach_redesign). Still the
      standing suspect for stale-view confusion on device hops.
- [ ] LIVE TEST pending (Nathan): phone hop onto a running bot after the
      ResumeStartupGuard fix + phone hard-refresh — validates the 2026-07-10 fix
- [ ] UNEXPLAINED: aegis bot stop 2026-07-10 05:47, ~20 min after the 05:26
      deploy restart — same delayed-fuse shape, cause unpinned
- [ ] `#unticker {hasted}` loop (fires every ~100s since 2026-07-10 16:57) —
      confirm it stopped after Nathan's next clean relaunch; if not, dig

## Scripts (.tin) durability
- [~] Backup rotations for .tin saves — CODE WRITTEN, uncommitted (see HAND-OFF
      STATE). 3-tier scheme like triggers/aliases. Needs deploy (IONOS-only) + a
      live save→verify-backup-appears check.
- [ ] Stale-save guard for the script editor (save carries loaded-version mtime/
      hash; reject if the file changed since it was opened). This is the piece that
      actually PREVENTS the multi-device clobber; rotations only make it recoverable.
      NOT started.

## Repo / infra (review architecture items + leftovers)
- [ ] Commit remaining ghosts: glitch/maplib.js (REQUIRED by server.js, still
      untracked!), .htaccess, tests/sandbox strays; sandbox-only suites beyond the
      3 core ones
- [ ] Gate runner: require the `Results:` line (exit-0-with-unparseable-output
      currently counts as PASS)
- [ ] Delete dead weight: root server.js (stale since Feb), websocket/ Ratchet
      server (vestigial, still deployed), Bot Engine block (server.js ~5166–5529)
      + api/bots.php + getBotsPath, root pcaps/screenshots/db dumps (PII in OneDrive)
- [ ] Extract shared TinTin evaluator (mathexp/tintoi/tineval) into one file used
      by both sides + parity gate suite
- [ ] Prod disk: delete wmt.db.pre-shrink (6.7G) + wmt.db.pre_entity_guard (1.9G)
      once shrink confirmed stable (it has been since 2026-06)
- [ ] Bridge-restart runbook (for the eventual forced restart)
- [ ] Sandbox box = SPOF for the safety story (only gate runner) — document/mitigate
- [ ] JSON cold archive cleanup: the frozen data/users character JSON files
      (~9.5MB/user backups included) — deletable whenever, zero urgency

## Parked / declined (so they don't resurface as "open")
- ChatMon: silenced channels count against the replay window — Nathan explicitly
  OK with it (2026-07-09); per-channel replay design noted in reference_chatmon_replay_model
- Native bot system — scrapped, cleanup only (see dead weight above)
- ipinfo Lite endpoint — deliberately NOT used (no city); standard endpoint + token live
