# Issue #1: Stuck at "Sending character name" after hard refresh

**Status**: Fixed 2026-02-28
**Severity**: High — user cannot play until they clear cookies or wait for session timeout
**Frequency**: Recurring (reported multiple times)

## Symptoms

After a hard refresh (Ctrl+F5 or browser close/reopen), the client shows:
- "Session resumed - MUD was disconnected."
- "Sending character name to 3K..."
- Then nothing. No MUD response. Stuck indefinitely.

## Root Cause

**Two inconsistent `mudConnected` checks created a dead-end.**

### The Three Checks

| Location | Code | Checks `.writable`? |
|----------|------|---------------------|
| Resume (line ~3020) | `mudSocket && !destroyed && writable` | YES |
| Disconnect (line ~3539) | `mudSocket && !destroyed` | NO |
| set_server guard (line ~3411) | `mudSocket && !destroyed` | NO |

### The Dead-End Flow

When BridgeSocket has `destroyed=false` but `writable=false`:

1. **Browser disconnect**: Disconnect check says `mudConnected=true` (no writable check)
2. **Browser reconnect**: Resume check says `mudConnected=false` (writable=false fails)
3. Client receives `session_resumed` with `mudConnected: false`
4. Client calls `onConnect()` — starts full login flow
5. Client sends `set_server` to server
6. Server's set_server handler: `mudSocket && !destroyed` → true → **skips connectToMud**
7. Client sends character name via `sendCommand()`
8. Server tries `mudSocket.write()` → BridgeSocket.write() checks `this.writable` → **returns false silently**
9. Character name never reaches MUD
10. MUD never responds → **stuck forever**

### Why writable=false?

BridgeSocket.writable starts as `false` in the constructor and is only set to `true` when the bridge responds with a 'connected' event. Several scenarios can leave it false:
- Bridge WebSocket dropped and reconnected (BridgeSockets survive but don't re-establish)
- Bridge responded slowly and the BridgeSocket was in a transient state
- Rekey sent a 'rekey' message to bridge, but bridge.js doesn't have the rekey handler yet (pending restart)

## Fix Applied

**Two changes to server.js:**

### Fix 1: Resume check — remove `.writable` (line ~3020)
```javascript
// Before:
const mudConnected = session.mudSocket && !session.mudSocket.destroyed && session.mudSocket.writable;

// After:
const mudConnected = session.mudSocket && !session.mudSocket.destroyed;
```
Now matches the disconnect check. If mudSocket exists and isn't destroyed, it's considered connected.
Added diagnostic logging when mudSocket exists but isn't writable.

### Fix 2: set_server guard — add `.writable` (line ~3411)
```javascript
// Before:
} else if (BRIDGE_URL && session.mudSocket && !session.mudSocket.destroyed) {

// After:
} else if (BRIDGE_URL && session.mudSocket && !session.mudSocket.destroyed && session.mudSocket.writable) {
```
Belt-and-suspenders: if somehow the resume check still reports false and the client sends set_server, the handler will now correctly call connectToMud instead of skipping.

### How The Fixes Work Together

**Normal case (mudSocket healthy):**
- Resume: `!destroyed` = true → mudConnected=true → client re-sends triggers, no re-login
- set_server: not sent (client takes mudConnected path)

**Edge case (writable=false, destroyed=false):**
- Resume: `!destroyed` = true → mudConnected=true → client re-sends triggers, no re-login
- If data doesn't flow, client health check will catch it
- Diagnostic log helps debug

**Fallback (if resume somehow says false anyway):**
- set_server: `!destroyed && writable` = false → calls connectToMud → new MUD connection
- No more dead-end

## Test Verification

1. Connect a character, verify MUD works
2. Hard refresh (Ctrl+F5) — should show "Session resumed - MUD connection active"
3. Verify MUD data continues flowing
4. Check server logs for `mudConnected=true` on SESSION_RESUME

## Related Issues

- Bridge.js rekey handler not yet deployed — bridge doesn't remap tokens on rekey
- Session overwrite race (fixed 2026-02-22) — separate but related timing bug
