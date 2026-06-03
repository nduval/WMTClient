# 005 — Session-resilience identity model & the deploy lockout (2026-06-02)

> **STATUS (2026-06-03):** The core fix (Tier A below — stable `session.bridgeToken`)
> is SHIPPED to production (commit e1e16a9) and VERIFIED: the deploy that ships it
> resumed all 6 live sessions seamlessly (6×`RESTORE_BRIDGE_RESUME`, 0 fresh logins,
> 0 orphans). Proven by `tests/sandbox/test_bridge_rekey_resume.js` (the project's
> first bridge-mode test; negative-controlled against the pre-fix server; now in the
> `deploy.py` gate). ALSO SHIPPED: client takeover/linkdead handling (commit
> 2cc1c19, client-only, no restart) and the bridge orphan-reaper (bridge.js v1.1.0,
> commit 8d857ee, deployed 2026-06-03 in a coordinated low-traffic window — all 4
> sessions reconnected, 0 orphans). char-dedup was dropped as unnecessary: the stable
> bridgeToken already prevents a duplicate-per-character. Optional/never-started:
> server-side G2/G3/G7 below.

This is a big-picture analysis of the session-persistence / zero-downtime-deploy
feature: what it is for, the invariant it depends on, and why a deploy locked a
user (elminster) out of his own character mid-combat. It ties together the prior
single-symptom writeups (001–004) and the 2026-05-28 SC4 finding, which are all
the SAME failure family.

## What the feature is FOR (the contract)

One sentence: **a player should never lose their MUD session or in-game state
because of a browser close, a network blip, a mobile app-switch, or a server
deploy.** Mechanism:

- `bridge.js` holds the raw TCP socket to the MUD and is NEVER restarted. It is
  the thing that makes the MUD connection outlive everything else.
- `wmt-server` (server.js) is disposable. It holds session state and proxies
  browser <-> bridge. A deploy restarts it; bridge keeps the TCP alive; the new
  server re-attaches ("resume") and the player notices nothing.
- State is persisted so a restart loses ≤30s: triggers/aliases/tickers in SQLite;
  token/bridgeToken/variables/delays/chat in the PHP store + 30s snapshots.
- The browser auto-reconnects its WebSocket and resumes.

## The core invariant it depends on (and the identity model)

There are THREE identities that must stay coherent:

1. **session token** — browser-facing. MUTABLE. It rekeys on: new device/tab,
   cookie loss/expiry, PHP session GC. (Generated in app.php; recovered from a
   30-day cookie.)
2. **bridgeToken** — the STABLE key bridge uses for the TCP socket. Set once at
   first connect. The 2026-03-16 fix (004-bridge-rekey-hang) deliberately chose
   the "screen session" model: do NOT rekey bridge; keep bridgeToken constant and
   reattach the mutable session token to it. bridge's `rekey` handler is therefore
   intentionally unused.
3. **(userId, characterId)** — the real-world identity. The MUD enforces ONE live
   connection per character; a second login is rejected ("already logged in and
   active") or evicts the first.

**THE INVARIANT that must always hold:** at most ONE live MUD connection per
(userId, characterId) at any instant, and every resume must find it by the STABLE
bridgeToken — never by the mutable session token. Every failure below is a
violation of this invariant.

## Why the deploy locked elminster out (confirmed from prod logs)

1. During his long session the session token had drifted from the bridgeToken
   bridge held the socket under (`37625117`). The session was now `bfcbb0ad`.
2. The deploy restarted wmt-server. On restore, the resume looked the socket up by
   the (drifted) token and **missed** (`No existing connection for bfcbb0ad`).
3. On a resume MISS the server falls back to `init` = a brand-new MUD login. That
   abandoned the original socket (still alive under `37625117`) and opened a
   second elminster connection.
4. 3K allows one connection per character → the duplicate collided → he was dumped
   to the name prompt; the original became an ORPHAN (alive in bridge, owned by no
   server session).
5. Nothing reaps orphans, and a wizard char has no idle timeout, so the orphan kept
   elminster "logged in and active," blocking every retry → hard lockout.
   Recovery required killing the orphan TCP socket(s) by hand (see
   [[bug_bridge_resume_miss_orphan_lockout]] for the `/sessions` + `ss -K` procedure).

## The systemic gaps that make this possible (not one bug — a cluster)

- **G1 — bridge socket keyed by the mutable session token. [FIXED 2026-06-03]**
  CONFIRMED root cause: restore already preferred `ps.bridgeToken` (line ~2687), but
  `connectToMud()` and `autoLoginToMud()` constructed `new BridgeSocket(session.token)`
  (lines ~2308, ~6526). So after a rekey, any fresh connect re-keyed the bridge socket
  to the drifted token, orphaning the original and poisoning the persisted bridgeToken.
  FIX: a stable `session.bridgeToken` set once in `createSession` (and pinned on
  restore), used by ALL three `BridgeSocket(...)` sites and both persist payloads. A
  rekey changes `session.token` but never `session.bridgeToken`.
- **G2 — identity map not persisted.** `userCharacterSessions` (user:char -> token)
  is rebuilt empty on restart, so the RESTORE_SKIP_ACTIVE / RESTORE_SKIP_BROWSER
  dedup guards can't see an existing identity during the restore window → duplicate
  sessions/connections.
- **G3 — resume-miss blindly logs in fresh.** On miss the server `init`s a new
  login even though the MUD may still hold the character → guaranteed duplicate →
  eviction/lockout. It also can't destroy the old socket because it doesn't know
  its (old) token.
- **G4 — no orphan reaper in bridge.** A socket whose `serverWs` is null lives
  forever (buffering until the cap, then dropping). No TTL, no reaper. This is the
  thing that turns a transient miss into a permanent lockout.
- **G5 — `init` is keyed by token, not by char.** bridge can hold two sockets for
  the same character under two tokens. `init` only replaces a same-token socket.
- **G6 — client auto-login has no takeover/linkdead handling.** On "already logged
  in and active" the client just loops name+password (2s backoff, then gives up),
  which on 3K spawns more collisions. It never surfaces a "you're still connected
  elsewhere — take over?" action.
- **G7 — `mudConnected` uses `!destroyed` without `.writable`.** A half-open/dead
  socket can be reported "connected," so the client withholds credentials and
  health-checks into a loop (this is the 001 bug's residue).

## This is a recurring regression area (validates the user's intuition)

The same subsystem has broken repeatedly, all around restart -> reconnect ->
fresh-login -> duplicate/eviction:
- 001 stuck-at-name-prompt (writable inconsistency)
- 002 session-overwrite race (restore vs browser reconnect)
- 003 double-charname send (stale `_bridgeModeInit` + blind timer)
- 004 bridge-rekey hang (token remapping) → introduced the bridgeToken model
- SC4 (2026-05-28) active-session EVICTION on deploy: a restart auto-re-logged-in a
  parked character and evicted the user's live one. Same family; "fix" was a
  partial client-side `mudLinkDead`/autoReconnect-suppression.

A daily player who went months without this and then hit a hard lockout is reading
the system correctly: the restart→reconnect path is fragile and has been actively
churned. The deploy was the trigger; the fragility is the cause.

## Remediation plan (staged by blast radius)

**Tier A — server.js core fix (stable bridgeToken). [SHIPPED 2026-06-03, commit e1e16a9]**
- G1: all `BridgeSocket(...)` and both persist payloads key by the stable
  `session.bridgeToken`, never the mutable session token. This alone closes the
  lockout path AND prevents orphans-from-key-drift (a reconnect now reuses the same
  bridge key, so bridge's `init` replaces the old socket instead of orphaning it).
  Verified seamless in prod + by `test_bridge_rekey_resume.js`.

**Tier B — server.js hardening (restarts wmt-server; sandbox-tested first). [OPEN]**
- G2: persist/rebuild userCharacterSessions before the restore window opens.
- G3: before any new `init` for a (user,char), reconcile/destroy any existing
  connection for that char; never fresh-login a char the MUD may still hold.
- G7: restore the `.writable` check on the connected/resume report.

**Tier C — client-only (deploys via IONOS SFTP, NO server/bridge restart). [SHIPPED 2026-06-03, commit 2cc1c19]**
- G6: detect "currently logged in and active" → STOP the auto-login loop (no more
  re-sending name/password), gate auto-reconnect, surface a Reconnect action.
- Reconnect dedup: connect() bails while a socket is OPEN or CONNECTING.
- Gated by `tests/sandbox/test_login_conflict.js`.

**Tier D — bridge.js (restart = linkdeath for ALL; needs a maintenance window). [reaper SHIPPED 2026-06-03, commit 8d857ee, bridge.js v1.1.0]**
- G4 [DONE]: orphan reaper — closes any socket no server re-claims within
  REAP_GRACE_MS (90s), with guards so it NEVER reaps while no server is connected
  or within a grace of a server (re)connect (so a server outage/restart can't trip
  it). Gated by `tests/sandbox/test_bridge_orphan_reaper.js`.
- G5 [DROPPED]: char-dedup unnecessary — the stable bridgeToken already prevents a
  duplicate connection per character.

## Operational rule reaffirmed

Restarting wmt-server is NOT truly zero-downtime while G1–G7 stand. Do not deploy
server.js during a user's active session without their go; prefer client-only
deploys (`deploy.py auto` skips the wmt-server restart when server.js is unchanged).
See [[feedback_session_continuity_and_regression]].
