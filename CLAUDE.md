# WMT Client - Project Notes

## ⛔ CARDINAL RULES — these override everything else in this file

If any other rule (including Session Resilience below) would mean breaking one
of these, stop and do these first. These are scars from real sessions; see
`memory/feedback_read_full_model_no_tunnel.md` and
`memory/feedback_dont_be_a_goldfish.md`.

### 1. Don't guess — verify with data
- Never state a cause, mechanism, or "it's fixed" as fact unless a log line,
  code line, DB row, or file read backs it. If you're inferring, SAY so —
  then go get the evidence before acting on it.
- Pull the logs / query the DB / read the **deployed** file. A plausible story
  is not evidence.
- Confirm a fix by re-checking real state after deploy (read the deployed file,
  re-query the DB), not by assuming the edit took.

### 2. Scope it fully — no tunnel vision
- Before saying anything is "done," grep for ALL call sites / read + write
  paths / edge cases. State the VERIFIED scope ("done for X and Y; Z pending"),
  never a blanket "done." (The 2026-05-25 char-sync gap and the 2026-06-17
  duplicate-character id-collision were both half-checked scopes.)
- For churn-prone subsystems (reconnect / bridge / resume / DB / auth), read the
  governing whole-system doc FIRST (see the context-loading table below) before
  touching code.
- When there's a real trade-off, surface it — don't barrel into the first fix.
- When updating memory after work, document what was NOT covered as explicitly
  as what was.

**Everything below is secondary to these two.**

---

## Working norms (reads & credentials)

- **Routine reads are not permission-gated.** Do SFTP enumeration, log greps, DB
  SELECTs, file inspection, and public-data fetches directly — don't propose them
  first. Ask permission only for writes, deploys, destructive ops, or anything
  that affects other users.
- **Never echo secrets.** With credentials from local files (`sftp.txt`, ssh
  keys, `.pem`), verify with `wc -l <file>` or `test -f <file> && echo present` —
  never print contents. Pass credentials inline to python/ssh without printing.

---

## IMPORTANT: Pre-work Context Loading

The MEMORY.md index is auto-loaded, but the actual content of individual memory
files is NOT — I only have that context if I deliberately read the files BEFORE
making claims or writing code.

**Mandatory reads by work area:**

| If you're going to touch... | Read these first |
|---|---|
| `glitch/server.js` | `memory/regression-checklist.md`, `memory/admin_alias_endpoint.md`, `memory/feedback_db_is_source_of_truth.md` |
| Reconnect / bridge / session / token / resume / persist (in `glitch/server.js` or `glitch/bridge.js`) | `docs/connection-issues/005-resilience-identity-model-and-lockout.md` (READ FIRST — the whole-system model), `memory/bug_bridge_resume_miss_orphan_lockout.md`, plus `docs/connection-issues/001`–`004` |
| `assets/js/app.js` (preferences) | The "Adding a Preference Touches THREE Files" section below |
| Any DB schema or migration claim | `memory/admin_alias_endpoint.md`, `memory/feedback_db_is_source_of_truth.md`, `memory/feedback_use_admin_endpoints_for_user_data.md`, `memory/bug_characters_not_synced_to_lightsail_db.md` |
| A `.tin` file (TinTin++ scripts) | `tintin-reference/parsing.md`, `tintin-reference/README.md`, `memory/feedback_lint_tin_files_via_ttrun.md` |
| New TinTin++ verb handler | `memory/feedback_porting_commands.md`, `memory/feedback_check_callers_first.md` |
| Anything someone reported as a bug | Grep `memory/` for related bug_*.md and feedback_*.md files |

**When in doubt**: read the relevant `feedback_*.md` files in `memory/`.
They are scars from prior sessions and represent the highest-value context.

**To force a comprehensive context load at session start**: the user can
type "read all relevant memory before starting" and I will do a full
context-loading pass on the listed files before any work.

---

## IMPORTANT: Session Resilience — the big picture (read before ANY reconnect/bridge work)

**STATUS (2026-06-03):** The core defect is FIXED in prod (commit e1e16a9): the bridge
socket is now keyed by a stable `session.bridgeToken`, never the mutable session token.
Bridge-mode is covered by `tests/sandbox/test_bridge_rekey_resume.js` in the deploy
gate. Still-open defense-in-depth (does NOT reopen the lockout): bridge orphan-reaper +
char-dedup (needs a wmt-bridge restart) and client takeover/linkdead handling. Details +
the full identity model: `docs/connection-issues/005-resilience-identity-model-and-lockout.md`.

**What the feature is for:** a player must NEVER lose their MUD session or
in-game state from a browser close, network blip, mobile app-switch, or a
**server deploy**. `bridge.js` holds the raw MUD TCP and is never restarted;
`wmt-server` is disposable and re-attaches ("resume") after a restart; state is
persisted (DB for triggers/aliases/tickers; PHP store + 30s snapshots for
token/bridgeToken/vars/delays/chat); the browser auto-reconnects.

**The ONE invariant everything depends on:** *at most one live MUD connection per
(userId, characterId), and every resume must find it by a STABLE bridge identity —
never by the mutable session token.* Three identities must stay coherent: the
**session token** (mutable — rekeys on new device/tab, cookie loss, PHP GC), the
**bridgeToken** (stable key bridge uses for the TCP socket), and **(user,
character)** (the MUD allows only ONE live connection per character — a duplicate
is rejected "already logged in and active" or evicts the first).

**How it bites when violated (the 2026-06-02 lockout):** if the bridge connection
ever gets keyed by the *mutable* session token, a rekey + reconnect makes resume
look up the wrong token → miss → the server *fresh-logs-in* → 3K rejects/evicts the
duplicate → the original socket orphans (no reaper) → the character is stuck
"logged in and active" and the user is locked out of their own char. Full analysis:
`docs/connection-issues/005-resilience-identity-model-and-lockout.md`.

**Rules:**
- Do NOT restart `wmt-server` during a user's active session without their OK; a
  restart is only seamless if the resume-by-stable-identity path is intact.
- Prefer client-only deploys (`deploy.py auto` skips the wmt-server restart when
  server.js is unchanged). NEVER restart `wmt-bridge` (linkdeath for everyone).
- Recovery for a stuck char: `GET /sessions` (admin key from the service env) is
  ground truth; any MUD socket not owned by a `/sessions` entry is a provable
  orphan you can `ss -K`. Do NOT guess orphans from TCP byte counters.
- If you change ANY part of this subsystem, update ALL the notes that describe it
  (this section, `docs/connection-issues/*`, `docs/claude-reference/architecture.md`,
  `memory/bug_bridge_resume_miss_orphan_lockout.md`, the MEMORY.md index) so the
  map never contradicts the code.

---

## IMPORTANT: Always Deploy

**After making ANY code changes, run `python deploy.py all` immediately.** Do not wait for the user to ask. This deploys to both IONOS (PHP/JS/CSS) and Lightsail (WebSocket proxy). It's safe to run even if only one side changed. (For PHP/JS/CSS-only changes, `deploy.py ionos` is fine and avoids a wmt-server restart — preferable during live play.)

The deploy script **auto-commits tracked changes** before deploying (for easy rollback). Use `--no-commit` to skip. Only tracked files are staged (`git add -u`) — untracked files are never committed automatically.

**NEVER restart `wmt-bridge`.** Bridge.js holds the raw TCP connections to the MUD for every user. Restarting it causes instant linkdeath for ALL connected players. `deploy.py all` and `deploy.py lightsail` are safe — they only restart `wmt-server` while bridge preserves connections. Do not run `deploy.py bridge`, `systemctl restart wmt-bridge`, or any command that stops/restarts the bridge service unless the user explicitly asks for it.

> Before deploying server.js: a syntax error in a site-wide-included PHP file (e.g. `includes/functions.php`) is a full outage — lint on the sandbox first (`php -l`).

---

## IMPORTANT: Git Security

**NEVER commit sensitive files to git.** The following are in `.gitignore` for a reason:
- `config/sendgrid.php` - Contains API keys
- `sftp.txt`, `ssh_user.txt`, `priv_key.txt`, `github_token.txt` - Credentials

Before running `git add -A` or committing, verify no secrets are being staged.

---

## IMPORTANT: Protected Functionality (DO NOT BREAK)

**Before modifying `server.js` or `app.js`, read `memory/regression-checklist.md` for the full list.** These behaviors have been tested and confirmed working. Any change that touches these areas MUST be verified against the checklist.

**Stable baseline tag: `stable-secbot-v1`** — Use `git diff stable-secbot-v1` to review what changed since last known-good state.

Critical behaviors (summary — see checklist for details):
1. **Sequential #var/#math in alias chains** — `serverProcessInlineCommand()` runs DURING `expandCommandWithAliases`, not after. `#var x 1;dostep$x` must see updated `$x`.
2. **Variable sync race protection** — `set_variables` handler merges with 2s timestamp window. Server-modified vars (`_varServerModified`) are NOT overwritten by stale client sync.
3. **#class {name} {read}** loads ALL items — update paths in `cmdAlias`/`cmdGag`/`cmdHighlight`/`cmdSubstitute`/`cmdTicker` reassign `class` when `currentScriptClass` is set.
4. **Bulk loading defers saves** — `_bulkLoading` flag prevents 450+ HTTP requests during `#read`.
5. **`!command` passes through to MUD** — NOT intercepted. 3K uses `!` for background execution.
6. **Trigger execution sends movement** — `expandCommandWithAliases` in trigger forEach fully expands alias chains (secwalk→secstepN→direction+kill) in one synchronous pass.

**When in doubt, deploy and test `secon` on Beowulf. If the bot steps through rooms correctly, the core pipeline is intact.**

---

## IMPORTANT: Adding a Preference Touches THREE Files

When adding a new preference (settings toggle, dropdown, slider, etc.), updates are required in **all three** of these places or the value won't persist:

1. **`assets/js/app.js`** — UI markup in the settings panel render code AND read the value into `this.preferences` inside `savePreferences()`.
2. **`api/preferences.php`** — add a validation block in `case 'save'`. This is a **default-deny whitelist**: fields not listed here are silently dropped before being saved to the DB. Easy to forget; symptom is "I toggle it, click save, reload, and it's back to default."
3. **`glitch/server.js`** (only if server-side behavior cares) — handle the field on the relevant WS message (`set_discord_prefs`, etc.).

If a user reports "this new toggle doesn't save," the cause is almost always missing step 2.

> Preferences are now **DB-only** (no JSON) — load via `/admin/preferences`, save via `/data-sync`. ChatMon channel settings and mip_conditions both live in the prefs blob. See `memory/bug_channel_name_space_stripped.md`.

---

## IMPORTANT: Maintaining Documentation

**After solving any significant bug or discovering important technical details, update the appropriate file:**
- General bugs/fixes → `docs/claude-reference/troubleshooting.md`
- TinTin++ commands/patterns → `docs/claude-reference/tintin-reference.md`
- Protocol details (MIP, TCP, ANSI) → `docs/claude-reference/protocols.md`
- Architecture changes → `docs/claude-reference/architecture.md`

These files are NOT auto-loaded to save context. Read them on-demand when working on related topics.

---

## Reference (read on demand — NOT auto-loaded)

Project reference detail lives in `docs/claude-reference/` to keep this file focused:

| File | Contents |
|------|----------|
| `project-reference.md` | Dev environments, deploy commands, architecture overview, key directories, TinTin++ support, storage limits, quick troubleshooting |
| `tintin-reference.md` | TinTin++ patterns, wildcards, all command references |
| `troubleshooting.md` | Common issues and solutions |
| `protocols.md` | MIP, TCP packet handling, ANSI colors, telnet |
| `architecture.md` | Session persistence, triggers, multi-server, mobile UI |
