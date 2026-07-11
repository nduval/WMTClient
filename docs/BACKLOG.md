# WMT Backlog — the single source for OPEN work

> **Rule (2026-07-11):** every work session updates this file — items move to DONE
> with commit + date, new items get added when discovered, and "done" claims in
> conversation MUST match this file. Born from the Phase-3 confusion: "step 1
> shipped" read as "Phase 3 shipped" weeks later. If it's not DONE here, it's not done.

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
- [ ] Dedupe backupScriptFile vs saveJsonFile rotation logic into one shared
      helper (review F8) — two copies now, same scheme; next fix should land once.

## Repo / infra (review architecture items + leftovers)
- [ ] Commit remaining ghosts: glitch/maplib.js (REQUIRED by server.js, still
      untracked!), .htaccess, tests/sandbox strays; sandbox-only suites beyond the
      3 core ones
- [ ] Gate runner: require the `Results:` line (exit-0-with-unparseable-output
      currently counts as PASS)
- [ ] ⚠️ PHP-only / client-only deploys SKIP the gate entirely (surfaced
      2026-07-11): `deploy.py auto`/`ionos` ship api/*, includes/*, app.js to
      IONOS with only `php -l`/`node --check`, no suite run — because the gate is
      wired to the server.js/Lightsail path. So the PhpLogin + new ScriptBackup
      suites only run when server.js also changes. Any auth/api/includes change
      reaches prod un-suite-tested. Fix: run at least the PHP + client-VM suites
      before an IONOS-only deploy (needs the sandbox test-server up, which
      deploy_test_server already does).
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
