# Issue #2: Session overwrite on hard refresh (race condition)

**Status**: Fixed 2026-02-22
**Severity**: High — MUD connection lost, user must reconnect

## Symptoms

After a hard refresh, MUD connection drops entirely. The session appears to reset — all triggers, variables, and MUD state are lost.

## Root Cause

Race condition between the 3-second restore timer and browser reconnect.

When server.js restarts, it saves sessions to a file and restores them on startup. The restore runs on a 3-second timer. If a browser reconnects during that 3-second window:

1. Browser connects → creates new session object
2. 3s restore timer fires → overwrites the session map entry with the restored session
3. The new session's WebSocket and mudSocket references are orphaned
4. Browser is connected to nothing

## Fix Applied

Restore now checks if a live session already exists before overwriting:
- If `existing.ws` is non-null (browser connected) → skip restore
- If `existing.mudSocket` is alive → skip restore

## Lesson Learned

When restoring state from disk, always check if there's a fresher in-memory version first.
