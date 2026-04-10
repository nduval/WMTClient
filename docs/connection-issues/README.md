# Connection Issues — Findings, Fixes & Ongoing Investigation

This folder documents recurring connection bugs, root cause analysis, and fixes for the WMT client's session persistence system.

## Architecture Quick Reference

```
Browser (app.js/connection.js)
  └─ WebSocket ─── server.js (Lightsail)
                      └─ BridgeSocket ─── bridge.js ─── TCP ─── MUD
```

- **server.js**: Restartable. Browser auto-reconnects. Safe to deploy anytime.
- **bridge.js**: Holds raw TCP connections. Restarting = linkdeath for ALL users.
- **BridgeSocket**: net.Socket-compatible wrapper in server.js that talks through bridge.js.

## Key Session States

| State | Meaning |
|-------|---------|
| `session.ws` | Browser WebSocket (null when disconnected) |
| `session.mudSocket` | BridgeSocket or net.Socket to MUD |
| `session.mudSocket.destroyed` | Socket fully dead |
| `session.mudSocket.writable` | Can write data (BridgeSocket: starts false, set true on bridge 'connected') |
| `session.disconnectedAt` | When browser disconnected (for timeout) |
| `session.explicitDisconnect` | User typed #end/quit (suppress auto-reconnect) |

## Bridge Restart Safety (added 2026-02-28)

When bridge.js drops (restart or crash), the system now:
1. **Server detects bridge drop** → properly closes all BridgeSockets → clients get "Connection to MUD closed."
2. **Server detects bridge reconnect** → sends `mud_reconnect` to all connected browsers
3. **Client handles `mud_reconnect`** → sends `set_server` → server creates new MUD connection → `pendingReconnect` auto-sends character name
4. **User experience:** ~3-5 seconds of "Connection to MUD closed." then automatic re-login. No refresh needed.

## Index of Issues

| # | Issue | Status | File |
|---|-------|--------|------|
| 1 | [Stuck at "Sending character name"](001-stuck-sending-charname.md) | Fixed 2026-02-28 | server.js |
| 2 | [Session overwrite on hard refresh](002-session-overwrite.md) | Fixed 2026-02-22 | server.js |
| 3 | [Double character name → wrong password](003-double-charname-send.md) | Fixed 2026-02-28 | server.js + app.js |
| 4 | [Session hangs after device switch (bridge rekey)](004-bridge-rekey-hang.md) | Fixed 2026-03-16 | server.js |
