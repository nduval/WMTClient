# Issue #3: Double character name send → "Wrong password"

**Status**: Fixed 2026-02-28
**Severity**: High — user gets kicked from MUD, can't reconnect without clearing session
**Frequency**: Recurring ("this must be a dozen times we have dealt with this")

## Symptoms

After a session resume with `mudConnected=false`, the client output shows:
```
Session resumed - MUD was disconnected.
Connected to WebSocket server.
Connected to 3k.org:3000!
Connected to WebSocket server.     ← SECOND onConnect()
Sending character name to 3K...
Sending character name to 3K...    ← SECOND char name
Password:
Incorrect password.
MUD has closed the connection.
```

Two `onConnect()` calls = two "Connected to WebSocket server." messages = two character names sent. The MUD interprets the second name as a wrong password and kicks the connection.

## Root Cause (two bugs)

### Bug A: Stale `_bridgeModeInit` flag

When a new session is created in bridge mode:
1. `_bridgeModeInit = true` (line ~3136)
2. Client sends triggers → server calls `connectToMud()`
3. When MUD connects, callback checks `_bridgeModeInit` → sends `session_new` → clears flag

**But if the bridge can't remap the token** (e.g., old bridge.js didn't have the `rekey` handler), the bridge responds with `{ type: 'connected', token: OLD_TOKEN }`. Server looks up `bridgeSockets.get(OLD_TOKEN)` → not found (it was remapped to new token during rekey). The callback never fires. **`_bridgeModeInit` stays true forever.**

On the next `connectToMud` success (e.g., after a resume), the stale flag triggers an extra `session_new` → client calls `onConnect()` a second time → double character name.

### Bug B: `onSessionResumed(false)` called `onConnect()`

When a session resume found `mudConnected=false`, the client called `onConnect()` which:
- Sent `set_server` → `connectToMud()` → new MUD connection ✓
- Sent character name on a **blind 1500ms timer** ✗

The timer was unreliable — it didn't wait for the MUD connection to actually be established. And it triggered even during resumes where the character name shouldn't be sent until the MUD is ready.

## Fix Applied

### Fix 1: Clear `_bridgeModeInit` on resume (server.js)

Both the normal resume path and the rekey path now clear `_bridgeModeInit` and `_pendingBridgeResume`:
```javascript
session._bridgeModeInit = false;   // Prevents stale session_new
session._pendingBridgeResume = false;
```

### Fix 2: Replace `onConnect()` with targeted reconnect (app.js)

The `onSessionResumed(false)` path no longer calls `onConnect()`. Instead:
```javascript
this.pendingReconnect = true;  // Send char name when "Connected to" arrives
this.connection.setServer(mudHost, mudPort);  // Trigger connectToMud
this.sendFilteredTriggersAndAliases();
```

The `pendingReconnect` mechanism (line ~979) waits for the actual "Connected to 3k.org:3000!" system message before sending the character name. This is:
- **Reliable**: only fires when MUD TCP is actually established
- **Single-send**: `pendingReconnect = false` after first trigger, prevents doubles
- **No blind timer**: no 1500ms guess

## The cascade failure (mimic's case, 2026-02-28)

1. Session created with `_bridgeModeInit = true`
2. Bridge rekey sent to OLD bridge.js (no rekey handler) → ignored
3. Bridge responded with old token → server couldn't find BridgeSocket → callback dropped
4. `_bridgeModeInit` stuck as `true` permanently
5. Later resume → `connectToMud` succeeds → stale `_bridgeModeInit` → sends `session_new`
6. Client receives `session_new` → calls `onConnect()` AGAIN
7. Two character names sent → MUD interprets second as wrong password → kicks connection

## Verification

1. Hard refresh while connected to MUD → should see "Session resumed - MUD connection active." (single message)
2. Hard refresh after MUD disconnect → should see "Reconnecting to MUD..." then "Connected to" then character name sent ONCE
3. Bridge restart → should auto-reconnect, character name sent ONCE via `pendingReconnect`
4. Check server logs: only ONE "Target server set" per resume, no duplicate discord/ticker batches
