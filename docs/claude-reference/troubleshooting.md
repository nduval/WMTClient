# Troubleshooting Guide

Common issues and their solutions for the WMT client.

## MIP Issues

### MIP data showing as raw text
1. Verify the MIP filter is the FIRST check in the data handler (after empty line check)
2. Use regex `/%\d{5}\d{3}[A-Z]{3}/` - no anchors, catches pattern anywhere in line
3. Check Lightsail version to ensure latest code is deployed (`https://ws.wemudtogether.com/health`)

### Blank lines accumulating from MIP data (fixed 2026-03-16)
**Problem:** Steady stream of empty lines every few seconds while idle or active. MIP status updates (guild stats, exp, timers) arrive as `#K%...\r\n`. When split by `\n`, this produces `["MIP_DATA\r", ""]`. The MIP line is correctly gagged, but the trailing `""` passes through as a blank line.

**Fix:** Pop trailing empty string after `split('\n')` when `fullText.endsWith('\n')` — at all 3 data handler sites in server.js (bridge mode, direct mode, main handler). This removes the protocol artifact without affecting intentional blank lines in MUD content.

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

### "Incorrect password." right after "Session resumed" (fixed 2026-10-14, commit 12b3e24)
**Symptom** (locrian 2026-10-14 13:55Z, Nathan "a few times"): fresh login → name typed →
the browser's WebSocket drops at the exact moment `Password:` arrives (so the client never
sends the password) → "Session resumed - MUD connection active." → "MIP enabled (ID: …)" →
**"Incorrect password."** → MUD closes → auto-reconnect does a fresh login. Often followed by
"Invalid character in position N" lines if a startup-script `#delay` fires raw commands into the
new name prompt (see below).
**Cause** (JSONL `input` records + code): the resume's `enableMip()` sends the three `3klient …`
registration lines; the first one lands on the `Password:` prompt as the password. The 2026-06-14
guard (drop `3klient` while `_atNamePrompt`) didn't apply because `_atNamePrompt` clears the
moment the name is typed.
**Fix**: `case 'command'` also drops `3klient` while `_eagerAtPasswordPrompt` is set (bounded to
120s after the prompt) and sends ONE `system` notice "The MUD is waiting for your password — type
it to continue." (the prompt itself is usually not in the replay buffer). Gate: MipNamePromptGuard
T3 (negative-controlled). Residual: the player must type the password (or the MUD times the prompt
out and the client's auto-reconnect does a fresh login) — the resume path does NOT auto-send it.

### Startup-script `#delay` firing raw MUD commands into the name prompt ("Invalid character in position N")
The startup script runs at CONNECT (before the name is sent) and again on a non-brief resume.
`#delay` is a browser timer that does not care whether the MUD is logged in. A short delay
(locrian had 10s) can fire plain commands into a reconnect's name prompt → one "Invalid character
in position N" per command. Nathan's startup.tin uses `{90}`; locrian's was changed to match
(2026-10-14). Better still: put post-login commands in a trigger on "3Kingdoms welcomes you".

### Passwords were written to the JSONL input log (fixed 2026-10-14, commit 12b3e24)
`writeSessionLog(session, 'input', …)` recorded every command verbatim, including the password the
client auto-sends at `Password:`. Now the command captured by the eager password-prompt flag is
logged as `[password redacted]`. Gate: MipNamePromptGuard T4. Files older than the fix age out
with the 7-day retention (`LOG_RETENTION_DAYS`).

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

## Variable Issues

### `${var}` brace-delimited variable syntax (v2.6.8+)

**Problem:** `$hpmax[<088>$hpchange<269>]` is misinterpreted — the parser reads `[<088>...]` as a nested key access on `$hpmax` instead of literal display characters.

**Root Cause:** The `$var[key]` nested variable regex runs before simple `$var` substitution, so any `$varname` followed by `[` gets consumed as a nested key lookup.

**Fix:** Support TinTin++ `${var}` brace-delimited syntax for disambiguation. `${hpmax}` resolves the variable before the nested key parser sees it, leaving the `[...]` as literal text.

Processed before `$var[key]` in `substituteVariables()`:
```javascript
str = str.replace(/\$\{(\w+)\}/g, (match, name) => { ... });
```

**Example:**
```
#show {HP: ${hpmax}[<088>$hpchange<269>]}
```
Produces: `HP: 1832[-160]` — `${hpmax}` resolves to `1832`, brackets are literal, `$hpchange` resolves separately.

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

### Bot stalls after a kill when no browser is attached — `#show` chain dropped (fixed 2026-10-13)

**Problem:** elminster's celbot stopped after `Basilisk dealt the killing blow` at
19:25:40Z on 2026-10-13 and sat idle for two hours. Same kill sequence had advanced
fine ten minutes earlier. Nathan's read: "connected from my phone and my bot died".

**Root cause (JSONL + journal + code):** the post-kill loot answer varies. When the
MUD says `There is no coins here.` the `coins here.` trigger schedules
`#delay {celdelay} {k celestial}` directly. When it says `You cannot take that.`
the script relies on tt++ semantics: that trigger runs `#show coins here.`, whose
text is trigger-checked and fires the same `coins here.` trigger. The server did not
do that itself: it forwarded the `#show` to ONE browser as a `client_command` and
waited for the browser to bounce it back as `test_line`. At 19:25 the only device
(the phone) had backgrounded three minutes earlier, so the `#show` was buffered for
nobody and the chain died. Every post-kill `You cannot take that.` on 10-09..10-13
with a browser attached advanced in 10s; the two with none (10-07 22:59Z, 10-13
19:25Z) stalled. Zero `coins here.` trigger records ever appeared in JSONL because
the match happened on the `test_line` path, which did not log.

**Fix:** `serverShowme()` in `glitch/server.js` — server-originated `#show`/`#showme`
is matched, logged (`src: 'showme'`), displayed to every device and executed
in-process, exactly as tt++ `do_showme` does. All executors funnel through
`forwardHashCommand()`. Gate: `ShowmeServerTriggers`. Side effect, also tt++-faithful:
a gag whose pattern matches your own `#showme` text now suppresses it.

**Lesson:** "the phone kills my bot" was literally true but indirect: the phone
becomes the only attached device, then backgrounds, and any script step that
needed a browser round-trip dies. Grep the JSONL for the LAST bot step and diff the
end of that fight against a fight that advanced; the fork was one MUD reply.

### Triggers not firing on MUD text but working with #showme (v2.6.7+)

**Problem:** A trigger like `tells you` fires when tested with `#showme` but not on actual MUD output showing the same visible text.

**Root Cause:** MUD output contains embedded ANSI color codes (e.g., `\x1b[1;33mHot\x1b[0m tells you`). The trigger pattern matched against the raw line including invisible ANSI codes, which broke the match. `#showme` sends clean text without ANSI.

**Fix:** Strip ANSI codes from the line before trigger matching (but preserve them in the output for colors):
```javascript
const matchLine = stripAnsi(line);
// Use matchLine for pattern matching, keep original line for output
```

**Lesson:** Always match triggers against stripped text. TinTin++ does this internally.

### Channel webhook "disappears" after a save — URL rejected by the save validator (fixed 2026-10-13)

**Symptom (mimic, 2026-10-13):** she put Discord *forum-channel* webhooks on 21 ChatMon channels
(all `bchat *`, nine knight channels, soul, tell). Discord kept working for hours, then after a
reload every one of those channels had an empty webhook URL and the Discord checkbox still on.

**Root cause (prod `change_log` + journal):** a forum-channel webhook URL is
`https://discord.com/api/webhooks/<id>/<token>?thread_id=<post id>`. The `api/preferences.php`
save regex required the URL to END at the token, so each save stored `''` for those channels —
silently, no error. Three validators disagreed: the save path (strict), the WebSocket
`set_discord_prefs` handler (prefix only) and `api/discord_proxy.php` (prefix only). The browser
pushed the same URLs to the live server, which posted from memory with zero errors
(`DISCORD_SEND` 14:02→21:38Z) — "initially working". The next reconnect re-pulled prefs from the
DB (`loadSettings` on `session_resumed`), pushed the blanked set, and Discord died.

**Fix:** `includes/discord_webhook.php` (`wmtValidateDiscordWebhookUrl`, not site-wide included)
is the one definition: accepts the plain form and `?thread_id=<digits>`, strips NBSP/zero-width/
BOM paste junk. `preferences.php` now keeps the STORED URL when a submitted one is refused and
returns `rejected.webhooks[]`; `app.js _applyWebhookRejections()` prints an error naming the
channels and the accepted form, and resyncs memory + the modal row before the WS push.
Gate: `DiscordWebhookUrl` (`tests/sandbox/test_discord_webhook_url.php`).

**How to spot it:** `change_log` rows for `preferences` where `channelPrefs.<ch>.webhookUrl`
goes `<url>` → `""` while `discord` stays `true`, paired with `DISCORD_PREFS_SET webhookCount`
NOT dropping at the same second. Old URLs are recoverable from the row's `old_data`.

### Discord webhooks silently failing when multiple webhooks fire (v2.6.7+)

**Problem:** Trigger with two Discord webhook actions — first webhook sends, second silently fails.

**Root Cause:** Node.js `https.request()` response body was not being consumed. Without `res.resume()`, the connection stays in the pool and can block subsequent requests.

**Fix:** Add `res.resume()` to all Discord webhook response handlers:
```javascript
const req = https.request(options, (res) => {
  res.resume(); // Must consume response to free connection
  // ... status check
});
```

**Lesson:** In Node.js, always consume HTTP response bodies even if you don't need the data. Use `res.resume()` to drain and free the connection.

### Wrong modal opening for triggers with highlight+discord

**Problem:** Triggers with highlight AND discord/chatmon opened highlight modal instead of trigger modal.

**Root Cause:** `getTriggerType()` only checked for `command` type.

**Fix:** Check for all complex action types:
```javascript
const hasComplexAction = trigger.actions.some(a =>
    a.type === 'command' || a.type === 'discord' || a.type === 'chatmon' || a.type === 'sound'
);
```
