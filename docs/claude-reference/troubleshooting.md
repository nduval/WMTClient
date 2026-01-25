# Troubleshooting Guide

Common issues and their solutions for the WMT client.

## MIP Issues

### MIP data showing as raw text
1. Verify the MIP filter is the FIRST check in the data handler (after empty line check)
2. Use regex `/%\d{5}\d{3}[A-Z]{3}/` - no anchors, catches pattern anywhere in line
3. Check Render version to ensure latest code is deployed

### HP/SP bars not updating
1. Check that client name starts with "Portal" in the 3klient registration
2. For fresh logins, ensure MIP enables AFTER leaving the stasis room (exits != "jump")
3. Verify mipId is being captured and sent to server via set_mip message

## Display Issues

### Lines breaking unexpectedly mid-text
1. Ensure TCP line buffering is implemented (lineBuffer variable)
2. Only process lines after receiving newline character
3. This is a TCP fragmentation issue, not MIP-related

### Colors dropping mid-line
1. Usually caused by line fragmentation - fix TCP buffering first
2. ANSI codes are at line start; split lines lose color context

### ANSI colors bleeding to adjacent text (v2.5.1+)

**Problem:** On lines with multiple colors (like HP/SP status bars), colors would "bleed" into text that should be default color.

**Root Cause:** The `ansiToHtml()` function wasn't balancing span tags properly. Compound ANSI codes like `\x1b[1;31m` opened TWO spans but reset only closed ONE.

**Solution:** Track open span count and close ALL spans on reset:
```javascript
let openSpans = 0;
for (const code of codeList) {
    if (code === '0' || code === '') {
        result += '</span>'.repeat(openSpans);
        openSpans = 0;
    } else if (ansiSpans[code]) {
        result += ansiSpans[code];
        openSpans++;
    }
}
```

### Multi-line colored blocks only show color on first line (v1.2.3+)

**Problem:** Room descriptions set to a color only showed color on the first line.

**Root Cause:** MUD sends one ANSI code at start of block, then multiple lines, then reset. Line splitting loses context.

**Solution:** Track ANSI state across lines in `server.js`:
```javascript
let currentAnsiState = '';
if (!startsWithAnsi && currentAnsiState) {
  line = currentAnsiState + line;
}
if (line.includes('\x1b[0m')) {
  currentAnsiState = '';
} else if (lastAnsiCode) {
  currentAnsiState = lastAnsiCode;
}
```

## Connection Issues

### 3S character connecting to wrong server
1. Verify character's server field is set to `'3s'` in their data
2. Check `app.php` is reading `getCurrentCharacterServer()` correctly
3. Ensure client sends `set_server` message before any other interaction
4. Check proxy logs - should show "Connecting to 3scapes.org:3200"

### Double connection on 3S (connects to 3K then 3S)
**Cause:** Proxy was auto-connecting on WebSocket open before receiving set_server
**Fix:** Removed auto-connect from proxy. Client MUST send set_server first.

### Reconnect after idle timeout immediately disconnects again

**Problem:** User idles, MUD kicks them. Reconnect works briefly then disconnects again.

**Root Cause:** When MUD closed connection, `closeSession()` deleted the session from the map but the WebSocket handler still referenced the orphaned session object.

**Fix:** When MUD closes unexpectedly, DON'T delete session. Just null the socket:
```javascript
session.mudSocket.on('close', () => {
  sendToClient(session, { type: 'system', message: 'Connection to MUD closed.' });
  session.mudSocket = null;
  if (session.explicitDisconnect) {
    closeSession(session, 'explicit disconnect');
  }
});
```

### Reconnect robustness improvements (v2.6.2+)

**Server-side (`connectToMud`):**
- Remove all event listeners before destroying socket
- Clear `lineBuffer` and `lineBufferTimeout` from previous connection
- Reset MIP state for fresh connection

**Client-side (`reconnect` in `app.js`):**
- Reset all MIP-related state
- Check if WebSocket is OPEN before sending `requestReconnect`
- If WebSocket is dead, perform full WebSocket reconnect

**Client-side (`reconnect` in `connection.js`):**
- Reset all connection flags
- Null out event handlers before closing socket
- Force close socket even if in weird state

## Mobile Issues

### Mobile app freezing after switching apps (Wake Lock bug)

**Problem:** App freezes after switching apps, even when idle.

**Root Cause:** `requestWakeLock()` added a new `visibilitychange` handler every call. Handler called `requestWakeLock()` again, creating exponential growth (1000+ handlers after 10 cycles).

**Fix:** Flag to ensure handler only added once:
```javascript
if (!this.wakeLockVisibilityHandlerAdded) {
    this.wakeLockVisibilityHandlerAdded = true;
    document.addEventListener('visibilitychange', ...);
}
```

**Lesson:** Never add event listeners inside functions called multiple times.

### Font size not saving below 10px (pinch-to-zoom)

**Problem:** Font reverts to 10px after pinch-zoom to 6px.

**Root Cause:** PHP API validated with `max(10, ...)` but UI slider allows 6px minimum.

**Fix:** Change validation to `max(6, min(24, $fontSize))` to match UI.

**Lesson:** Keep frontend and backend validation ranges in sync.

## Authentication Issues

### Login loops back to login screen (cookie path mismatch)

**Problem:** Login succeeds but redirects back to login. Affects all users.

**Root Cause:** Cookie path calculated from script path:
- `/api/auth.php` → cookie path = `/api/`
- `/characters.php` → cookie path = `/`

When `session_regenerate_id(true)` was added, new session created with `/` path but old `/api/` cookie still existed with old session ID.

**Fix:**
1. Always use `/` as cookie path
2. Delete old `/api/` path cookies:
```php
if (isset($_COOKIE[SESSION_NAME])) {
    setcookie(SESSION_NAME, '', time() - 3600, '/api/');
}
```

**Debug:** Auth logging at `data/logs/auth.log` shows session IDs across requests.

**Lessons:**
1. Different session IDs across requests = cookie problem
2. `session_regenerate_id()` can expose latent cookie bugs
3. Cookie path specificity: `/api/` takes precedence over `/` for `/api/*` requests

## Script/Command Issues

### #delay commands skipping lines when run from alias (v2.6.1+)

**Problem:** Alias with 24 `#delay` commands only executed 3.

**Root Cause:** Auto-generated delay name used `Date.now()`. Multiple delays in same millisecond got same name and overwrote each other.

**Fix:**
1. Use sequential counter: `name = 'delay_' + (++this.delayCounter);`
2. Remove confirmation messages
3. Execute `#` commands directly via `processClientCommand()`

### Command parsing in tickers and aliases

**Problem:** Commands like `#showme {text};grepdebug foo` treated as single command.

**Root Cause:** `expandCommandWithAliases()` only split AFTER alias expansion.

**Fix:** Split by `parseCommands()` FIRST, then process each part for alias expansion.

## Trigger Issues

### Trigger loops (v2.6.6+)

**Problem:** Trigger matching its own output creates infinite loop.

**Solution:** Loop detection tracks fire count per trigger within 2-second window. Threshold of 50 fires auto-disables trigger and notifies user.

### Wrong modal opening for triggers with highlight+discord

**Problem:** Triggers with highlight AND discord/chatmon opened highlight modal instead of trigger modal.

**Root Cause:** `getTriggerType()` only checked for `command` type.

**Fix:** Check for all complex action types:
```javascript
const hasComplexAction = trigger.actions.some(a =>
    a.type === 'command' || a.type === 'discord' || a.type === 'chatmon' || a.type === 'sound'
);
```
