# 004: Session hangs after device switch (bridge rekey failure)

**Status:** Fixed 2026-03-16
**Affected:** server.js (SESSION_REKEY handler)

## Symptom

User connects from phone, then switches to desktop (or vice versa). Desktop says "Session resumed" but no commands flow — typing produces no output, MUD output stops.

## Root Cause

When a user connects from a new device with a new session token, `SESSION_REKEY` in server.js:
1. Remapped the BridgeSocket's internal token to the new session token
2. Sent a `rekey` message to bridge.js to update its routing table

If bridge.js missed the rekey message (which it consistently did — zero rekey entries in bridge logs), **both directions broke**: server couldn't route MUD data to the session, and commands couldn't reach the MUD.

## Fix

**Stop remapping the BridgeSocket token entirely.** The BridgeSocket keeps its original token for bridge communication. The bridge doesn't need to know about session token changes — it just needs a stable identifier for the TCP connection.

The persist/restore code already had a `bridgeToken` field for exactly this purpose: storing the bridge-side token separately from the session token.

Think of it like `screen` — the TCP connection stays alive with its original identity, you just reattach a different terminal (browser session) to it.

## Changes

- `server.js` lines ~2949-2959: Removed BridgeSocket token remapping and bridge rekey notification. Added comment explaining the approach.
