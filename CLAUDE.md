# WMT Client - Project Notes

## IMPORTANT: Always Deploy

**After making ANY code changes, run `python deploy.py all` immediately.** Do not wait for the user to ask. This deploys to both IONOS (PHP/JS/CSS) and Render (WebSocket proxy). It's safe to run even if only one side changed.

---

## IMPORTANT: Git Security

**NEVER commit sensitive files to git.** The following are in `.gitignore` for a reason:
- `config/sendgrid.php` - Contains API keys
- `sftp.txt`, `ssh_user.txt`, `priv_key.txt`, `github_token.txt` - Credentials

Before running `git add -A` or committing, verify no secrets are being staged. If in doubt, check `git status` and review what's being added.

---

## IMPORTANT: Maintaining This File

**After solving any significant bug or discovering important technical details, ALWAYS update this file with:**
1. What the problem was
2. What the solution was
3. Why it works (the underlying cause)

This ensures future sessions have context for troubleshooting. Hard-won knowledge should never be lost to context limits.

---

## Local Development Environment

### MUD Box (AWS EC2)
SSH to the development MUD server where TinTin++ scripts are stored:
```bash
ssh ec2-user@52.5.228.15 -i ~/.ssh/3k.pem
```
- **TinTin++ scripts location**: `/elminster/*.tin`
- **Purpose**: Reference scripts to check WMT client compatibility

### Development Environments

This project is developed on two machines that share the same git repo:

| Environment | Path | Notes |
|-------------|------|-------|
| **Windows** | `D:/GitHub/client` | Primary, uses Git Bash |
| **Mac Mini** | `~/github/client` | Secondary, SSH accessible |

**Sync between environments:**
```bash
python .claude/sync.py status   # Check both
python .claude/sync.py push     # Push local changes via git
python .claude/sync.py pull     # Pull remote changes via git
```

Local tracking files are in `.claude/` (gitignored):
- `sync_config.json` - Environment configuration
- `session_notes.md` - Recent work log for Claude context
- `sync.py` - Sync helper script

### SSH to Mac Mini
```bash
ssh nathan@192.168.86.55 -i ~/.ssh/id_rsa
```
- Repo path: `/Users/nathan/github/client`
- May have environment-specific config (deploy credentials differ)

### SSH to MUD Box (AWS EC2)
```bash
ssh ec2-user@52.5.228.15 -i ~/.ssh/id_rsa
```
- **TinTin++ scripts**: `~/elminster/*.tin` (main character)
- Other characters: `~/jaeger/`, `~/lestat/`, `~/heimdall/`, etc.

### Windows + Git Bash Path Notes
Claude Code runs in a Git Bash environment on Windows. Path quirks:
- Use forward slashes: `C:/Users/nduva/.ssh/` (not backslashes)
- Git Bash mount: `/c/Users/nduva/` also works
- For SSH keys: `~/.ssh/` expands to `/c/Users/nduva/.ssh/`
- Windows paths with spaces need quotes: `"C:/Users/name/My Documents/"`

## TinTin++ Script Compatibility Analysis

Based on analysis of production TinTin++ scripts (`~/elminster/*.tin`), here's the compatibility status:

### Fully Supported Commands
| Command | Notes |
|---------|-------|
| `#act` / `#action` | Triggers with pattern matching |
| `#alias` | Command aliases |
| `#var` / `#unvar` | Variables (case insensitive) |
| `#math` | Arithmetic operations |
| `#if` / `#elseif` | Conditionals with string/numeric comparison |
| `#delay` | Delayed command execution |
| `#ticker` / `#unticker` | Repeating timers (server-side) |
| `#gag` | Suppress matching lines |
| `#highlight` / `#high` | Color matching lines |
| `#showme` | Display text locally |
| `#echo` | Display without trigger processing |
| `#bell` | Play alert sound |
| `#nop` | Comments |
| `#read` | Load script files |
| `#loop` | Numeric iteration |
| `#foreach` | List iteration |
| `#list` | List manipulation |
| `#replace` | String substitution in variables |
| `#format` | String formatting |
| `#regex` / `#regexp` | Pattern matching with captures |
| `#class` | Group actions by class |
| `#send` | Send raw command |
| `#break` / `#continue` | Loop control |
| `#function` / `#unfunction` | User-defined functions with `@name{}` |
| `#return` | Return value from function |
| `#local` / `#unlocal` | Scoped local variables |
| `#switch` / `#case` / `#default` | Switch/case conditionals |
| `#event` / `#unevent` | Session event handlers |

### Partially Supported
| Command | Status |
|---------|--------|
| `#split {0} {rows}` | Creates split screen, row display limited |
| `#showme {text} {-row}` | Row number ignored (no split screen regions) |
| `#prompt` | Basic support, row parameter ignored |
| `#config {SPEEDWALK}` | Speedwalk ON/OFF works, other configs ignored |
| `#unact` / `#unaction` | Works by pattern, not by name |

### NOT Supported (by design)
| Command | Reason |
|---------|--------|
| `#system` | Security - no shell command execution |
| `#CONFIG` (most) | TinTin++-specific settings (buffer size, packet patch, etc.) |
| `#PATHDIR` | Path/direction mapping not implemented |
| `#EVENT` | Event handlers (RECEIVED INPUT, etc.) not implemented |
| `#end` | Not applicable to web client |
| `#run` / `#session` | Multi-session not supported |

### Pattern Features Supported
```
%1-%99    Numbered captures
%*        Any text (greedy)
%w        Word characters
%d        Digits
%s        Whitespace
%S        Non-whitespace
^         Line start anchor
$         Line end anchor
{a|b|c}   PCRE alternation
{[0-9]+}  PCRE character classes
```

### Variable Features Supported
```
$varname           Simple variable
$var[key]          Nested/indexed variable
$var[key][subkey]  Deep nesting
$list[%*]          All list items (for #foreach)
```

### Known Gaps from Real Scripts
1. **`#EVENT {RECEIVED INPUT}`** - Replaced by "idle disconnect" setting (deadman switch)
2. **`#CONFIG {PACKET PATCH}`** - Server handles buffering automatically
3. **`#system` calls** - Used for Discord notifications; use server-side Discord webhooks instead
4. **Split screen rows** - `#showme {text} {-5}` row positioning doesn't work; all output goes to main area

### Idle Disconnect (Deadman Switch) - v2.6.4+

Replaces TinTin++ `#EVENT {RECEIVED INPUT}` for idle detection. Found in Settings → "Auto-disconnect after inactivity".

**How it works:**
- Tracks time since user last typed a command (not trigger activity)
- Options: Disabled, 15/30/60/120 minutes
- Warns 1 minute before disconnect
- Triggers still run, only disconnects if YOU stopped typing

**Key distinction:**
- MUD timeout: no activity at all (including triggers)
- Deadman timeout: no USER input (triggers keep running, bots work, but human walked away)

### #split Analysis - What's Missing

TinTin++ `#split` creates dedicated screen regions:
```
#split {top} {bottom} {left} {right} {input}
```

**Full TinTin++ split features:**
- Top status bar (fixed rows at top)
- Bottom status bar (fixed rows above input)
- Left/right sidebars
- Scrolling region in center
- `#showme {text} {-row}` displays to specific row in split regions

**Current WMT implementation:**
- `#split {top} {bottom}` - Creates split config but doesn't render separate regions
- All output still goes to main scrollable area
- Row numbers in `#showme {text} {-5}` are ignored

**Why it's hard:**
- Web browsers don't have VT100 terminal emulation
- Would require custom CSS grid layout with fixed-position divs
- Need to intercept row-targeted output and route to correct div
- Significant UI architecture change

**Workaround:** Use the MIP status bar for HP/SP display instead of split screen rows.

### Remaining Features to Consider

| Feature | Difficulty | Value | Notes |
|---------|------------|-------|-------|
| `#buffer` | Hard | Low | Scroll buffer manipulation |
| `#screen` | Hard | Low | Terminal manipulation (not applicable to web) |
| `#draw` | Hard | Low | ASCII art drawing (not applicable to web) |
| `RECEIVED_LINE` event | Medium | Medium | Already handled by triggers |

---

## Deployment

This project has two deployment targets:

### IONOS (PHP Client)
- **Production URL**: https://client.wemudtogether.com/app.php
- **Remote path**: root (subdomain document root is /client on server)
- **Command**: `python deploy.py ionos`
- Deploys PHP files, assets, config, etc. via SFTP
- Credentials stored in `sftp.txt`

### Render (WebSocket Proxy)
- **Command**: `python deploy.py render`
- Deploys `server.js` via GitHub push (Render auto-deploys from main branch)
- Only needed when `glitch/server.js` changes

### Deploy Both
- **Command**: `python deploy.py all`
- **Use this by default** - it's safe to run even if only one side changed

## Architecture

- **Frontend**: PHP on IONOS (index.php, app.php, etc.)
- **WebSocket Proxy**: Node.js on Render (server.js) - connects browser to MUD
- **MUD Servers**:
  - 3Kingdoms: 3k.org:3000 (default)
  - 3Scapes: 3scapes.org:3200

## Session Persistence (v2.0.0+)

MUD connections survive browser disconnects (app switching, network blips). Users can reconnect to their existing session without losing their MUD connection.

### How It Works

1. **Token-Based Sessions**:
   - PHP generates a 64-character random token per character session (`app.php`)
   - Token stored in PHP session: `$_SESSION['ws_token']`
   - Client sends token as first message after WebSocket connects
   - Server maps token → session object

2. **Session Lifecycle**:
   - New connection: client sends `auth` message with token
   - Server creates session or resumes existing one
   - On browser disconnect (unexpected): MUD connection kept alive, output buffered
   - On reconnect: buffered output replayed, MIP stats restored
   - On explicit disconnect (button/tab close): MUD connection closed

3. **Resume Behavior**:
   - On reconnect, client simply resumes receiving new lines (no history replay)
   - MIP stats sent immediately on reconnect to restore HP bar, etc.
   - Buffer is cleared on resume to free memory

4. **Session Timeout**:
   - 30 minutes without browser connection = session closed
   - MUD's own 2-hour idle timeout also applies

### Key Files
- `app.php:32-39` - Token generation
- `glitch/server.js` - Session management, `createSession()`, `sendToClient()`, `replayBuffer()`
- `assets/js/connection.js` - Auth handshake, `onSessionResumed` callback
- `assets/js/app.js` - `onSessionResumed()` handler

### Security
- Tokens are 256-bit random (cryptographically secure)
- Transmitted only over WSS (encrypted)
- Tied to PHP session (expires on logout)
- Cannot guess or brute-force

### Explicit vs Unexpected Disconnect
- **Explicit**: Disconnect button or closing tab sends `disconnect` message → closes MUD
- **Unexpected**: Browser crash, app switch, network drop → session persists

### Session Persistence Fixes (v2.0.1+)

**Problem:** After reconnecting (e.g., app switch on mobile), client would "hang" - no input accepted, no new scrolling.

**Root Causes:**
1. **Buffer replay overwhelming browser**: Sending many messages rapidly caused the browser's DOM to lock up.
2. **Silent WebSocket death**: On mobile, when the OS suspends the app, the WebSocket can die without firing the `onclose` event.

**Solutions:**
1. **No buffer replay**: On session resume, buffer is cleared. User simply starts receiving new lines. MIP stats are still sent to restore HP bar. This eliminates the DOM flood issue entirely.

2. **Visibility change detection** (`app.js:bindEvents`):
   ```javascript
   document.addEventListener('visibilitychange', () => {
     if (document.visibilityState === 'visible') {
       // Check if WebSocket is actually alive
       if (socket.readyState === WebSocket.CLOSED) {
         // Reconnect immediately
       }
     }
   });
   ```

**Key insight:** Mobile browsers aggressively suspend background tabs/apps. WebSocket connections die but JavaScript state persists. Must actively check connection health when app returns to foreground.

### Health Check System (v2.1.0+)

Detects and recovers from "zombie" WebSocket connections - sockets that appear OPEN but the actual TCP connection is dead.

**How it works:**
```
Client                          Server
   |                               |
   |-- health_check ------------->|
   |        (start 5s timeout)     |
   |<------------ health_ok ------|
   |        (cancel timeout)       |
   |                               |
   |  If timeout fires:            |
   |  -> connection is zombie      |
   |  -> force close socket        |
   |  -> reconnect with same token |
   |  -> session restored!         |
```

**Key files:**
- `assets/js/app.js`: `verifyConnectionHealth()`, `onHealthCheckResponse()`
- `glitch/server.js`: handles `health_check` message, responds with `health_ok`

**Why this matters for PWA:**
iOS completely freezes PWA apps when backgrounded. The WebSocket object survives in memory but the underlying TCP connection dies. When the app unfreezes, `socket.readyState` may still show `OPEN` even though it's dead. A simple `send()` goes into the browser's buffer but never reaches the server. The health check with timeout detects this zombie state and forces a clean reconnect.

**Recovery is seamless** because the MUD connection lives on the server. Only the browser↔proxy WebSocket died. Reconnecting with the same token restores the existing session with MUD still connected.

### Multi-Device Session Management (v2.5.0+)

When a user logs into the same character from a different device (different PHP session = different token), the old session's MUD connection is automatically closed first. This prevents the "login loop" where two devices fight over the same MUD character.

**Problem solved:**
- User logged in at home, left session open
- User logs in at office (different browser/device)
- Previously: Both sessions fought, MUD kept kicking each login
- Now: Old session is closed automatically, new session connects cleanly

**How it works:**
1. Client sends `userId` and `characterId` with the auth message
2. Server tracks sessions by user+character in `userCharacterSessions` map
3. When new session connects for same user+character:
   - Old session receives `session_taken` message
   - Old session's MUD connection is closed
   - New session proceeds normally

**Key files:**
- `app.php`: Sends `userId` in WMT_CONFIG
- `connection.js`: Includes `userId` and `characterId` in auth message
- `glitch/server.js`: `userCharacterSessions` map, auth handler logic

## Admin Broadcast Feature (v2.4.0+)

Admins can send messages to all currently connected users from the admin panel.

### Setup Required

1. **On Render** - Set environment variable:
   ```
   ADMIN_KEY=your-secure-random-key-here
   ```

2. **On IONOS** - Create `config/render_admin_key.php`:
   ```php
   <?php
   define('RENDER_ADMIN_KEY', 'your-secure-random-key-here');
   ```
   (Must match the key on Render)

### How It Works

1. Admin enters message in admin.php Broadcast section
2. JavaScript sends POST to `https://wmt-proxy.onrender.com/broadcast` with:
   - `X-Admin-Key` header containing the admin key
   - JSON body: `{ "message": "your message" }`
3. Server validates admin key, iterates all sessions, sends `broadcast` message to each connected WebSocket
4. Client displays message prominently with system styling and plays beep sound

### Key Files
- `glitch/server.js`: `/broadcast` endpoint handler (lines 216-281)
- `admin.php`: Broadcast form and `sendBroadcast()` JavaScript function
- `assets/js/app.js`: `case 'broadcast':` message handler

### Security
- Admin key required in HTTP header - without it, returns 403
- Key is not committed to git (in `.gitignore`)
- Only accessible to users in `$ADMIN_USERS` array (admin.php)

### Gotcha: WebSocket URL vs HTTP URL
`WS_CLIENT_URL` in config is `wss://wmt-proxy.onrender.com` (WebSocket protocol). The broadcast endpoint uses HTTP, so the JavaScript must convert `wss://` to `https://` before calling fetch:
```javascript
const proxyUrl = WS_CLIENT_URL.replace('wss://', 'https://');
fetch(proxyUrl + '/broadcast', { ... });
```
Without this conversion, fetch fails with "Failed to fetch" because `wss://` is not a valid HTTP protocol.

## Multi-Server Support (3K/3S Toggle)

The client supports both 3Kingdoms and 3Scapes MUDs. Each character profile can be configured for either server.

### How It Works

1. **Character Data** (`includes/functions.php`):
   - Each character has a `server` field: `'3k'` or `'3s'`
   - Default is `'3k'` for backwards compatibility
   - Functions: `updateCharacterServer()`, `getCharacterServer()`, `getCurrentCharacterServer()`

2. **Session Tracking**:
   - `setCurrentCharacter()` stores server in `$_SESSION['character_server']`
   - `app.php` reads this to set `mudHost` and `mudPort` in `WMT_CONFIG`

3. **WebSocket Proxy** (`glitch/server.js`):
   - Does NOT auto-connect on WebSocket open
   - Waits for `set_server` message from client with host/port
   - **Security**: Only allows whitelisted servers:
     ```javascript
     const allowedServers = [
       { host: '3k.org', port: 3000 },
       { host: '3scapes.org', port: 3200 }
     ];
     ```
   - On `set_server`, validates against whitelist, then connects to MUD

4. **Client Connection** (`assets/js/app.js`):
   - `onConnect()` always sends `set_server` first with host/port from `WMT_CONFIG`
   - This ensures correct server before any MUD interaction

5. **Character Selection** (`characters.php`):
   - Toggle UI next to each character (left of password icon)
   - Toggle in "Add Character Profile" and "New to 3Kingdoms" forms
   - API endpoint: `api/characters.php?action=set_server`

### Duplicate Character Names
Characters with the same name are allowed if they're on different servers. The duplicate check in `api/characters.php` compares both name AND server.

### MIP Detection for 3Scapes
3Scapes has different login messages. MIP detection triggers on:
- `"3Kingdoms welcomes you"` or `"entering 3Kingdoms"` (3K)
- `"3Scapes welcomes you"` or `"entering 3Scapes"` (3S)

## Key Directories

- `assets/js/app.js` - Main client JavaScript (triggers, aliases, TinTin++ commands)
- `assets/css/style.css` - All styling
- `glitch/server.js` - WebSocket proxy server (deployed to Render)
- `includes/` - PHP helper functions (auth, functions, settings)
- `api/` - PHP API endpoints
- `config/config.php` - App configuration

## Adding New Action Types (Trigger, Alias, etc.)

When adding a new action type (like triggers, aliases, gags, highlights, substitutes, tickers), update these locations:

### 1. UI Buttons (3 places in `app.php`)
- **+New dropdown menu** (~line 76-83): Desktop header dropdown
- **Hamburger menu** (~line 101-106): Mobile menu (inside `.hamburger-menu`)
- **Actions sidebar buttons** - rendered in `app.js` `renderScriptsSidebar()` (~line 2585)

### 2. JavaScript Methods (in `app.js`)
- `open[Type]Modal(editIndex)` - Open modal for create/edit
- `save[Type]()` - Save the item
- `delete[Type]ById(id)` / `edit[Type]ById(id)` - List operations
- `cmd[Type](args)` - TinTin++ command handler (e.g., `#action`, `#alias`)

### 3. Modal HTML (in `app.php`)
- Add a `<div class="modal-overlay" id="[type]-modal">` section
- Follow the pattern of existing modals (trigger-modal, alias-modal, etc.)

### 4. Data Storage
- Add to `this.[types]` array in app.js initialization
- Add save/load in `saveScriptsToServer()` / `loadScriptsFromServer()`
- Server-side: update `api/scripts.php` if needed

### 5. Styling
- Modals use `.modal-overlay.open` to display (not `.active`)
- Mobile full-screen styles in `@media (max-width: 768px)` and PWA media queries

### Checklist for New Action Type
- [ ] +New dropdown menu button
- [ ] Hamburger menu button
- [ ] Actions sidebar button
- [ ] Modal HTML with form fields
- [ ] `open[Type]Modal()` method
- [ ] `save[Type]()` method
- [ ] Class dropdown in modal (`renderClassOptions()`)
- [ ] TinTin++ command handler if applicable
- [ ] Data persistence (scripts API)

## TinTin++ Compatibility

This client supports TinTin++ style scripting:
- Pattern matching: `%*`, `%d`, `%w`, `%1`-`%99`, etc.
- Commands: `#action`, `#alias`, `#gag`, `#highlight`, `#var`, `#math`, `#if`, `#loop`, `#foreach`, `#list`, `#showme`, `#bell`, `#split`, `#ticker`, `#delay`, `#class`, `#read`, `#write`, `#regexp`, `#prompt`, `#break`, `#continue`
- Nested variables: `$hp[max]`, `$stats[str][base]`
- Speedwalk: `3n2e` expands to `n;n;n;e;e`
- Script files: `.tin` format supported

### TinTin++ Pattern Reference

Reference: https://tintin.mudhalla.net/manual/pcre.php

#### Pattern Auto-Detection
Patterns are automatically detected as TinTin++ regex if they contain:
- `%` followed by wildcards (`*`, `+`, `?`, `.`) or type codes (`d`, `w`, `s`, etc.)
- `%1` through `%99` numbered capture groups
- `^` anchor at start or `$` anchor at end
- `{ }` braces for PCRE embedding

Plain text patterns use simple "contains" matching.

#### Wildcards (All Capturing, All Greedy)

| Pattern | Regex | Meaning |
|---------|-------|---------|
| `%1`-`%99` | `(.*)` | Numbered capture group |
| `%*` | `(.*)` | Zero or more chars (excl. newlines) |
| `%+` | `(.+)` | One or more chars |
| `%?` | `(.?)` | Zero or one char |
| `%.` | `(.)` | Exactly one char |
| `%d` | `([0-9]*)` | Zero or more digits |
| `%D` | `([^0-9]*)` | Zero or more non-digits |
| `%w` | `([A-Za-z0-9_]*)` | Zero or more word chars |
| `%W` | `([^A-Za-z0-9_]*)` | Zero or more non-word chars |
| `%s` | `(\\s*)` | Zero or more whitespace |
| `%S` | `(\\S*)` | Zero or more non-whitespace |
| `%a` | `([\\s\\S]*)` | Zero or more chars (incl. newlines) |
| `%A` | `([\\r\\n]*)` | Zero or more newlines only |
| `%c` | `(?:\\x1b\\[[0-9;]*m)*` | Zero or more ANSI color codes |
| `%p` | `([\\x20-\\x7E]*)` | Zero or more printable ASCII |
| `%P` | `([^\\x20-\\x7E]*)` | Zero or more non-printable |
| `%u` | `(.*)` | Unicode - same as %* |
| `%U` | `([\\x00-\\x7F]*)` | ASCII only (0x00-0x7F) |

#### Anchors

| Pattern | Meaning |
|---------|---------|
| `^` | Match start of line |
| `$` | Match end of line |

#### Modifiers

| Pattern | Meaning |
|---------|---------|
| `%i` | Case insensitive from this point |
| `%I` | Case sensitive from this point (default) |

#### Non-Capturing Variants

| Pattern | Regex | Meaning |
|---------|-------|---------|
| `%!*` | `(?:.*)` | Non-capturing zero or more |
| `%!d` | `(?:[0-9]*)` | Non-capturing digits |
| `%!{regex}` | `(?:regex)` | Non-capturing PCRE group |

#### PCRE Embedding

| Pattern | Regex | Example |
|---------|-------|---------|
| `{regex}` | `(regex)` | `{hit\|miss}` → matches "hit" or "miss" |
| `{a\|b\|c}` | `(a\|b\|c)` | Alternation |
| `%!{regex}` | `(?:regex)` | Non-capturing group |

#### Range Syntax

Format: `%+min..max[type]` or `%+min[type]`

| Pattern | Regex | Meaning |
|---------|-------|---------|
| `%+1d` | `([0-9]{1,})` | One or more digits |
| `%+3..5d` | `([0-9]{3,5})` | 3 to 5 digits |
| `%+2w` | `([A-Za-z0-9_]{2,})` | 2+ word chars |

#### Variable Substitution

| Context | Syntax | Storage | Example |
|---------|--------|---------|---------|
| `#action` command | `%0`-`%99` | In trigger action | `#act {^%1 says '%2'} {reply %1 I heard %2}` |
| `#regexp` command | `&0`-`&99` | Temporary | `#regexp {hello world} {%1 %2} {#show &1 &2}` |

- `%0` / `&0` = entire matched string
- `%1` / `&1` = first capture group, etc.
- ANSI codes are stripped from captured values before substitution

#### Implementation Notes

1. **All wildcards are GREEDY** - they capture as much as possible
2. **Case insensitive by default** - all pattern matching ignores case unless `%I` is used
3. **ANSI stripping** - captured values have color codes removed to prevent command corruption
4. **Special chars escaped** - `[ ] { } ( ) | + ? * . \\` are treated as literals unless in `{ }` braces

### #if Command Reference

Reference: https://tintin.mudhalla.net/manual/if.php

**Syntax:**
```
#if {condition} {true_commands} {false_commands}
```

**String vs Numeric Comparison:**
- **Quoted = String**: `#if {"$health" == "bad"} {#show See a doctor}`
- **Unquoted = Numeric**: `#if {$hpcur > 5000} {#show Healthy!}`

**Comparison Operators:**

| Operator | Meaning | Notes |
|----------|---------|-------|
| `==` | Equal | Can use regex with strings: `"$var" == "{yes\|no}"` |
| `!=` | Not equal | Can use regex with strings |
| `===` | Strict equal | Never uses regex |
| `!==` | Strict not equal | Never uses regex |
| `<` | Less than | Numeric or alphabetic |
| `>` | Greater than | Numeric or alphabetic |
| `<=` | Less than or equal | Numeric or alphabetic |
| `>=` | Greater than or equal | Numeric or alphabetic |

**Logical Operators:**

| Operator | Meaning | Example |
|----------|---------|---------|
| `&&` or `and` | Logical AND | `$hp > 100 && $sp > 50` |
| `\|\|` or `or` | Logical OR | `$hp < 100 \|\| $sp < 50` |
| `^^` or `xor` | Logical XOR | True if exactly one is true |
| `!` or `not` | Logical NOT | `!$dead` |

**Regex Pattern Matching:**
```
#if {"$class" == "{mage|wizard|sorcerer}"} {#show You cast spells!}
```

**Chained Conditions:**
```
#if {$hp < 100} {#show Critical!} {#if {$hp < 500} {#show Low} {#show OK}}
```

### #foreach Command Reference (v2.6.3+)

Iterates over a list of items, executing commands for each.

**Syntax:**
```
#foreach {list} {variable} {commands}
```

**Examples:**
```
#foreach {a;b;c} {item} {say $item}
#foreach {$mylist[%*]} {x} {#showme Item: $x}
#foreach {north;south;east;west} {dir} {look $dir}
```

**Notes:**
- List items are separated by semicolons
- The variable is set to each item in turn
- Commands can use `#break` to exit early or `#continue` to skip to next item
- Works with list variables: `#foreach {$mylist[%*]} {x} {...}`

### #list Command Reference (v2.6.3+)

Manages list variables with TinTin++ compatible operations.

Reference: https://tintin.mudhalla.net/manual/list.php

**Syntax:**
```
#list {variable} {option} [arguments]
```

**Options:**

| Option | Usage | Description |
|--------|-------|-------------|
| `add` | `#list {var} add {item}` | Add item(s) to end of list |
| `clear` | `#list {var} clear` | Remove all items |
| `create` | `#list {var} create {a;b;c}` | Create list from items |
| `delete` | `#list {var} delete {index}` | Remove item at index |
| `find` | `#list {var} find {item} {result}` | Find item, store index in result |
| `get` | `#list {var} get {index} {result}` | Get item at index, store in result |
| `insert` | `#list {var} insert {index} {item}` | Insert item at index |
| `set` | `#list {var} set {index} {value}` | Set item at index |
| `size` | `#list {var} size {result}` | Store list size in result |
| `sort` | `#list {var} sort` | Sort alphabetically |
| `reverse` | `#list {var} reverse` | Reverse order |
| `shuffle` | `#list {var} shuffle` | Randomize order |

**Examples:**
```
#list targets create {orc;goblin;troll}
#list targets add {dragon}
#list targets get {1} {first}
#showme First target: $first
#list targets size {count}
#showme Total targets: $count
```

**Accessing List Items:**
```
$mylist[1]    - First item (1-indexed)
$mylist[-1]   - Last item
$mylist[%*]   - All items (for #foreach)
```

### #break and #continue (v2.6.3+)

Loop control statements for `#loop` and `#foreach`.

**#break** - Exit the loop immediately:
```
#loop {1} {10} {i} {
    #if {$i == 5} {#break};
    say $i
}
```

**#continue** - Skip to next iteration:
```
#foreach {1;2;3;4;5} {n} {
    #if {$n == 3} {#continue};
    say $n
}
```

### Nested Variables (v2.6.3+)

Variables can have nested keys for structured data.

**Syntax:**
```
#var {name[key]} {value}
#var {name[key][subkey]} {value}
```

**Examples:**
```
#var hp[current] 500
#var hp[max] 1000
#var stats[str][base] 18
#var stats[str][bonus] 2

#showme HP: $hp[current]/$hp[max]
#math stats[str][total] {$stats[str][base] + $stats[str][bonus]}
```

**Notes:**
- Keys can be any string
- Nested depth is unlimited
- Lists use numeric keys: `$mylist[1]`, `$mylist[2]`
- Access all list items with `$var[%*]` for #foreach

### #prompt Command Reference (v2.6.3+)

Captures and optionally modifies the MUD prompt line.

Reference: https://tintin.mudhalla.net/manual/prompt.php

**Syntax:**
```
#prompt {pattern} {replacement} {row}
```

**Parameters:**
- `pattern` - TinTin++ pattern to match prompt
- `replacement` - Optional replacement text (use `{}` for none)
- `row` - Display row: `-1` for top split, `-2` for bottom split

**Examples:**
```
#prompt {HP: %1/%2 SP: %3/%4} {} {-2}
#prompt {^%*$} {[PROMPT] %0} {-1}
```

**Notes:**
- Prompts are lines that don't end with newline (detected via telnet GA)
- Row `-2` is typically used for status display at screen bottom
- Captured values available as `%1`, `%2`, etc.

### #function Command Reference (v2.6.4+)

User-defined functions that can be called inline with `@name{args}` syntax.

Reference: https://tintin.mudhalla.net/manual/function.php

**Syntax:**
```
#function {name} {body}
@name{arg1;arg2}
```

**Examples:**
```
#function {double} {#math result {%1 * 2}}
#showme The double of 5 is @double{5}

#function {rnd} {#math result {1 d (%2 - %1 + 1) + %1 - 1}}
#showme Random 1-100: @rnd{1;100}

#function {gettime} {#format result {%t} {%H:%M}}
#showme Current time: @gettime{}
```

**Inside functions:**
- `%0` = all arguments as a string
- `%1`, `%2`, etc. = individual arguments (semicolon-separated)
- `#return {value}` or set `$result` to return a value
- `#local {var} {val}` for scoped variables

### #local Command Reference (v2.6.4+)

Creates variables scoped to the current function or alias execution.

**Syntax:**
```
#local {name} {value}
#unlocal {name}
```

**Example:**
```
#alias {swap} {#local x %0;#replace x {e} {u};#showme $x}
```

**Notes:**
- Local variables shadow global variables of the same name
- Automatically cleaned up when function/alias completes
- Useful to avoid polluting global namespace

### #switch / #case / #default (v2.6.4+)

Cleaner alternative to chained `#if` / `#elseif` statements.

**Syntax:**
```
#switch {value} {#case {v1} {cmd1};#case {v2} {cmd2};#default {cmd}}
```

**Example:**
```
#switch {$direction} {
    #case {north} {#showme Going up!};
    #case {south} {#showme Going down!};
    #default {#showme Going somewhere!}
}

#switch {1d4} {#case 1 cackle;#case 2 smile;#default giggle}
```

### #event Command Reference (v2.6.4+)

Hook into session lifecycle events to run commands automatically.

**Syntax:**
```
#event {event_name} {commands}
#unevent {event_name}
```

**Supported Events:**

| Event | When Fired | Argument |
|-------|------------|----------|
| `SESSION_CONNECTED` | WebSocket connects | - |
| `SESSION_DISCONNECTED` | WebSocket disconnects | - |
| `SESSION_RESUMED` | Session resumed after reconnect | - |
| `VARIABLE_UPDATE` | Any variable is changed | Variable name |
| `CLASS_ACTIVATED` | Class is enabled | Class name |
| `CLASS_DEACTIVATED` | Class is disabled | Class name |

**Examples:**
```
#event {SESSION_CONNECTED} {#showme Connected!;look}
#event {SESSION_DISCONNECTED} {#showme Lost connection!}
#event {VARIABLE_UPDATE} {#if {"%1" == "hp"} {#showme HP changed!}}
#event {CLASS_ACTIVATED} {#showme Class %1 enabled}
```

### Speedwalk (v2.6.3+)

Condensed movement commands that expand to multiple directions.

**Enable:**
```
#config {SPEEDWALK} {ON}
```

**Syntax:**
```
[count]direction[count]direction...
```

**Examples:**
```
3n2e     → n;n;n;e;e
2n3e2s   → n;n;e;e;e;s;s
nnnee    → n;n;n;e;e
```

**Supported Directions:**
- `n`, `e`, `s`, `w` - Cardinal directions
- `u`, `d` - Up, down
- `ne`, `nw`, `se`, `sw` - Diagonals (if supported by MUD)

**Notes:**
- Only works when speedwalk is enabled
- Commands are sent with configurable delay between each
- Disable with `#config {SPEEDWALK} {OFF}`

## Trigger Processing Architecture (CRITICAL)

**Triggers run SERVER-SIDE, not client-side.** This is a deliberate architectural decision for mobile support.

### Why Server-Side Triggers?

On mobile devices, browsers can disconnect at any time (app switching, network blips, screen lock). With session persistence (v2.0.0+), the MUD connection survives these disconnects. If triggers ran client-side, they would STOP WORKING when the browser disconnects - you'd miss combat triggers, chat captures, etc.

By running triggers server-side (`glitch/server.js`):
- Triggers keep firing even when browser is disconnected
- Trigger commands execute immediately (no round-trip delay)
- Buffer captures trigger-processed output for replay on reconnect

### Key Files

- **`glitch/server.js`** - Contains all trigger processing:
  - `processTriggers(line, triggers)` - Main trigger engine
  - `tinTinToRegex(pattern)` - TinTin++ to JS regex conversion
  - `isTinTinPattern(pattern)` - Detects TinTin++ syntax
  - `replaceTinTinVars(command, matches)` - Substitutes %0-%99 captures

- **`assets/js/app.js`** - Client-side:
  - Stores triggers in `this.triggers[]`
  - Sends triggers to server via `setTriggers()`
  - Does NOT process triggers locally (except via `test_line` for #showme)

### #showme Trigger Testing

`#showme` sends text to the server via `test_line` message, which runs it through `processTriggers()` exactly like MUD output. This allows testing triggers without actual MUD input.

```
#showme Hot dealt the killing blow
```

This text is:
1. Sent to server as `test_line` message
2. Processed through all triggers (gags, highlights, substitutes, actions)
3. Result sent back to client for display
4. Any trigger commands execute (local `#` commands or MUD commands)

**`#echo`** is the alternative for local-only display without trigger processing.

### DO NOT Move Triggers Client-Side

Any refactoring that moves trigger processing to the client will break:
- Session persistence (triggers stop during disconnects)
- Mobile usability (triggers fail during app switches)
- Combat automation (missed triggers during brief network issues)

If you need client-side pattern matching (e.g., for #regexp), implement it as a SEPARATE function, not by moving the main trigger engine.

## Storage Limits

- 25 MB total per user
- 250 files max per user

## MIP (MUD Interface Protocol)

MIP is 3k.org's protocol for sending game stats (HP, SP, room, exits, etc.) to clients.

### Registration Format (CRITICAL)
The 3klient registration command format is **very sensitive**:

```
3klient <5-digit-id>~~<clientname><version>
```

**Key requirements:**
1. **Two tildes (`~~`)** between ID and client name
2. **Client name must start with "Portal"** - the MUD checks for this prefix to send HP/SP data
3. Current format: `3klient 12345~~PortalWMT1.0.0`

Reference TinTin++ format: `3klient $mip[id]~~Po3kdb$mip[Version]`

Without the proper format, the MUD will still send some MIP data (room names, exits, guild lines) but will NOT send FFF messages containing HP/SP/GP stats.

### MIP Loading Timing (CRITICAL)

**Problem:** MIP registration must happen when the player is fully in the game world. The old approach tried to detect the "jump" stasis room, but this failed for wizard characters who skip the stasis room entirely.

**Solution (v2.6.2+):** Use simple fixed delays after login detection instead of complex room detection:

| Login Type | Delay | Detection |
|------------|-------|-----------|
| **Fresh login** | 10 seconds | "3Kingdoms welcomes you" or "entering 3Kingdoms" (same for 3Scapes) |
| **Linkdeath recovery** | 4 seconds | "welcomes you back from linkdeath" |

**Why this works:**
- Fixed delays are predictable and work for all character types (normal players AND wizards)
- 10 seconds is enough time for normal players to type "jump" and enter the world
- Wizards who skip stasis are already in-world, so the delay just ensures everything is settled
- Simpler code with no edge cases to worry about

**Key code location:** `app.js` in the `case 'mud':` message handler (~line 507)

### MIP Wire Format
MIP messages are embedded in MUD output with this structure:
```
#K%<mipId:5><length:3><type:3><data:length>
```
- **mipId**: 5-digit session ID (e.g., `62395`)
- **length**: 3-digit decimal length of data portion (e.g., `010` = 10 chars)
- **type**: 3-letter message type (e.g., `FFF`, `BAD`, `DDD`)
- **data**: Exactly `length` characters of payload

The length field is critical - MIP data can be embedded mid-line, so we must extract exactly `length` characters and output any remaining text.

### MIP Message Types
- **FFF** - Composite stats (A=HP current, B=HP max, C=SP current, D=SP max, E/F=GP1, G/H=GP2, I/J=guild lines, K=enemy name, L=enemy %, N=round)
- **BAD** - Room name
- **DDD** - Exits (tilde-separated)
- **BBA/BBB/BBC/BBD** - Labels for GP1/GP2/HP/SP
- **AAC** - Time until reboot
- **AAF** - Server uptime
- **BAB** - Tells (2-way comms)
- **CAA** - Chat channel messages

### Alternate MIP Format
MIP data can also appear WITHOUT the `#K` prefix:
```
%<mipId:5><length:3><type:3><data:length>
```
Example: `%00378011AAC3.7 days` where mipId=00378, length=011, type=AAC

### MIP Filtering - Critical Fix (v1.1.2+)

**Problem:** Raw MIP data like `%00378011AAC3.7 days` was leaking through to the display despite multiple filter attempts.

**Solution:** The MIP filter MUST run as the **FIRST LINE OF DEFENSE** - before ANY other processing in the data handler. Previous attempts placed filters later in the code path, but various code branches could send data to the client before reaching those filters.

**Working pattern** (in `glitch/server.js`):
```javascript
// FIRST thing after checking for empty line:
if (/%\d{5}\d{3}[A-Z]{3}/.test(line)) {
  // Parse stats if possible, then ALWAYS return (gag the line)
  return;
}
```

**Why other approaches failed:**
- Filters placed after MIP parsing blocks were bypassed by early `return` statements
- Pattern-specific filters (`%${mipId}...`) failed when mipId wasn't set yet or didn't match
- The generic regex `/%\d{5}\d{3}[A-Z]{3}/` catches ALL MIP data regardless of session ID

## Understanding MUD Packet Handling (CRITICAL)

This section documents fundamental knowledge about how MUD data flows through TCP/telnet. This understanding is essential for debugging display issues.

### The Data Flow
```
MUD Server (3k.org:3000)
    ↓ TCP packets (arbitrary boundaries, NOT line-aligned)
    ↓ Telnet protocol (control sequences like GA embedded in stream)
WebSocket Proxy (Render - server.js)
    ↓ Must reassemble complete lines
    ↓ Must detect prompts via GA signal
    ↓ Must filter MIP protocol data
Browser Client (IONOS - app.js)
    ↓ Receives clean, complete lines
Display
```

### Why Lines Break (TCP Fragmentation)
TCP is a stream protocol - it does NOT preserve message boundaries. When the MUD sends:
```
=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=\n
```
TCP may deliver it as multiple packets:
```
Packet 1: =-=-=-=-=-=-=-=-=-=-
Packet 2: =-=-=-=-=-=-=-=-=-=-=\n
```

**If you process packets immediately, you get broken lines.** You MUST buffer until you see a newline.

### Why Prompts Need Special Handling
MUD prompts typically don't end with newlines - they wait for input on the same line:
```
Enter your name: _
```

With line buffering, this would sit in the buffer forever. Two solutions:
1. **Telnet GA (Go Ahead):** The proper signal. IAC GA (255 249) means "done sending, waiting for input"
2. **Timeout fallback:** If no GA, flush buffer after ~100ms of silence

### Reference: TinTin++ Packet Patch
TinTin++ has the same challenges and solves them similarly:
- `#config {packet patch} 0.5` - wait up to 0.5s for complete lines
- Uses GA/EOR signals to detect prompts
- This is a universal MUD client issue, not specific to our implementation

---

### TCP Line Buffering - Critical Fix (v1.2.0+)

**Problem:** Lines were being broken mid-way (e.g., `=-=-=` appearing on separate lines). This was NOT caused by MIP - TinTin++ with no MIP awareness displayed lines correctly.

**Root Cause:** TCP doesn't guarantee message boundaries. Data arrives in arbitrary chunks that may split lines. The original code processed each TCP chunk immediately, sending partial lines to the client.

**Solution:** Buffer incoming data until a newline is received:
```javascript
let lineBuffer = '';

mudSocket.on('data', (data) => {
  const fullText = lineBuffer + text;
  const parts = fullText.split('\n');

  // If no trailing newline, last part is incomplete - buffer it
  if (!text.endsWith('\n') && parts.length > 0) {
    lineBuffer = parts.pop();
  } else {
    lineBuffer = '';
  }

  // Process only complete lines
  parts.forEach(line => { ... });
});
```

**Key insight:** TinTin++ works correctly because it buffers until newline. Our proxy must do the same.

### Telnet GA (Go Ahead) for Prompts (v1.2.2+)

**Problem:** With line buffering, prompts that don't end with newlines would be delayed until the 100ms timeout.

**Solution:** Detect telnet GA (Go Ahead, IAC GA = 255 249) signal. GA means "I'm done sending, waiting for input" - perfect for flushing the buffer immediately for prompts.

**Reference:** TinTin++ has a similar "packet patch" setting (0.5-1.0 seconds) for this issue. They also mention using GA/EOR to detect prompts.

**Implementation:**
- `stripTelnetSequences()` now returns `{ buffer, hasGA }`
- When GA is detected, flush and process all buffered content immediately
- Fallback 100ms timeout still exists for MUDs that don't send GA

### MIP Disabled State
When "Enable MIP" is toggled off in settings:
- Sub-toggles (HP bar, ChatMon, etc.) are greyed out with `mip-disabled` class
- HP status bar is hidden
- ChatMon button is hidden and ChatMon panel closes if open
- Managed by `updateMipDependentUI()` in `app.js`

### Key Files
- `assets/js/app.js` - MIP enable/disable, stat bar updates, conditions
- `glitch/server.js` - MIP message parsing (parseMipMessage, parseFFFStats)

### Verifying Render Deployments
The WebSocket proxy includes a version indicator:
- Visit `https://wmt-proxy.onrender.com/` - shows version in page title
- Visit `https://wmt-proxy.onrender.com/health` - returns JSON with version field

If changes aren't taking effect, check that the version number updated. Render free tier can take 1-2 minutes to deploy after a push.

## ANSI Color Handling

This section documents everything learned about handling ANSI escape codes for terminal colors and styling.

### ANSI Escape Code Format

Basic format: `\x1b[<codes>m` (or `\033[<codes>m` in octal)

- `\x1b[` or `\033[` - escape sequence introducer (ESC + `[`)
- `<codes>` - semicolon-separated list of SGR (Select Graphic Rendition) parameters
- `m` - terminates the sequence

**Examples:**
- `\x1b[31m` - set red foreground
- `\x1b[1;31m` - set bold AND red (compound code)
- `\x1b[0m` - reset all attributes
- `\x1b[0;33m` - reset, then set yellow

### Common SGR Codes

| Code | Meaning |
|------|---------|
| 0 | Reset ALL attributes |
| 1 | Bold/bright |
| 4 | Underline |
| 30-37 | Dim foreground colors (black, red, green, yellow, blue, magenta, cyan, white) |
| 90-97 | Bright foreground colors (same order) |
| 40-47 | Background colors |
| 100-107 | Bright background colors |

### Key Implementation Details

#### 1. Reset Means Reset ALL

ANSI code `0` resets ALL attributes - bold, underline, colors, everything. It does NOT mean "close the most recent style." Any HTML/CSS representation must match this semantic.

**Wrong approach:**
```javascript
'0': '</span>'  // Only closes ONE span
```

**Correct approach:**
```javascript
// Track ALL open spans, close them ALL on reset
if (code === '0') {
    result += '</span>'.repeat(openSpans);
    openSpans = 0;
}
```

#### 2. Compound Codes Open Multiple Attributes

`\x1b[1;31m` sets BOTH bold AND red in one sequence. The client must handle this by either:
- Opening multiple spans and tracking count (current approach)
- Building a single span with combined styles (alternative)

#### 3. Cross-Line State Tracking (Server-Side)

MUDs often send one ANSI code at the start of a multi-line block (like room descriptions), with reset only at the end. Since we process line-by-line, we must track state across lines.

**Location:** `glitch/server.js` - `session.currentAnsiState`

```javascript
// If line doesn't start with ANSI but we have active state, prepend it
if (!startsWithAnsi && session.currentAnsiState) {
    line = session.currentAnsiState + line;
}

// Track: save last code if no reset, clear on reset
if (line.includes('\x1b[0m')) {
    session.currentAnsiState = '';
} else if (lastAnsiCode) {
    session.currentAnsiState = lastAnsiCode;
}
```

#### 4. TCP Can Split ANSI Codes

TCP fragmentation can split a line mid-ANSI sequence:
```
Packet 1: "You see \x1b[31"
Packet 2: "mred text\x1b[0m here"
```

**Solution:** Buffer until newline (or GA signal). Never process partial lines.

#### 5. ANSI Must Be Stripped for Pattern Matching

When matching trigger patterns against MUD output, ANSI codes must be stripped first. Otherwise patterns won't match colored text.

**Location:** `glitch/server.js` - `stripAnsi()` function used in `processTriggers()`

### Client-Side Conversion (ansiToHtml)

**Location:** `assets/js/app.js` - `ansiToHtml()` method

Converts ANSI escape sequences to HTML spans:
1. Escape HTML entities first (`&`, `<`, `>`)
2. Parse each `\x1b[<codes>m` sequence
3. Split codes by `;` to handle compound sequences
4. Track open span count
5. On reset (code 0), close ALL open spans
6. Map color codes to CSS spans with inline styles

### Common Pitfalls

1. **Forgetting compound codes**: `\x1b[1;31m` is ONE sequence that sets TWO attributes
2. **Single close on reset**: Reset must close ALL open spans, not just one
3. **Not tracking cross-line state**: Multi-line colored blocks lose color after first line
4. **Processing before buffering**: TCP fragments can split ANSI sequences
5. **Not stripping for triggers**: ANSI codes break pattern matching

## Troubleshooting

### MIP data showing as raw text
1. Verify the MIP filter is the FIRST check in the data handler (after empty line check)
2. Use regex `/%\d{5}\d{3}[A-Z]{3}/` - no anchors, catches pattern anywhere in line
3. Check Render version to ensure latest code is deployed

### Lines breaking unexpectedly mid-text
1. Ensure TCP line buffering is implemented (lineBuffer variable)
2. Only process lines after receiving newline character
3. This is a TCP fragmentation issue, not MIP-related

### HP/SP bars not updating
1. Check that client name starts with "Portal" in the 3klient registration
2. For fresh logins, ensure MIP enables AFTER leaving the stasis room (exits != "jump")
3. Verify mipId is being captured and sent to server via set_mip message

### Colors dropping mid-line
1. Usually caused by line fragmentation - fix TCP buffering first
2. ANSI codes are at line start; split lines lose color context

### ANSI colors bleeding to adjacent text (v2.5.1+)

**Problem:** On lines with multiple colors (like HP/SP status bars), colors would "bleed" into text that should be default color. For example, bold styling might leak to everything after the first colored segment.

**Root Cause:** The `ansiToHtml()` function in `app.js` wasn't balancing span tags properly. When the MUD sends compound ANSI codes like `\x1b[1;31m` (bold + red in one sequence):
- The code split by `;` and opened TWO spans: `<span style="font-weight:bold"><span style="color:#cc4444">`
- But reset code `\x1b[0m` mapped to only ONE `</span>`
- The bold span was left unclosed, leaking to all subsequent text

**Example:**
```
Input:  \x1b[1;31mHP:\x1b[0m 803/774
Before: <span style="font-weight:bold"><span style="color:#cc4444">HP:</span> 803/774
        ↑ bold span never closed, leaks to "803/774"
After:  <span style="font-weight:bold"><span style="color:#cc4444">HP:</span></span> 803/774
        ↑ both spans properly closed
```

**Solution:** Track open span count and close ALL spans on reset:
```javascript
let openSpans = 0;

for (const code of codeList) {
    if (code === '0' || code === '') {
        // Reset: close ALL open spans
        result += '</span>'.repeat(openSpans);
        openSpans = 0;
    } else if (ansiSpans[code]) {
        result += ansiSpans[code];
        openSpans++;
    }
}
```

**Key insight:** ANSI reset (code 0) means "reset ALL attributes" - not just the most recent one. The HTML span model must match this semantic.

### 3S character connecting to wrong server
1. Verify character's server field is set to `'3s'` in their data
2. Check `app.php` is reading `getCurrentCharacterServer()` correctly
3. Ensure client sends `set_server` message before any other interaction
4. Check proxy logs - should show "Connecting to 3scapes.org:3200"

### Double connection on 3S (connects to 3K then 3S)
**Problem:** Saw "Connecting to 3k.org:3000" then "Connecting to 3scapes.org:3200"
**Cause:** Proxy was auto-connecting on WebSocket open before receiving set_server
**Fix:** Removed auto-connect from proxy. Client MUST send set_server first, which triggers the connection.

### Mobile app freezing after switching apps (Wake Lock bug)
**Problem:** App freezes after switching to another app and back, even when idle. After force-closing and reopening, user can send 2 commands before it hangs again.

**Root Cause:** The `requestWakeLock()` function was adding a new `visibilitychange` event handler every time it was called. That handler calls `requestWakeLock()` again when the page becomes visible, creating exponential growth:
- First app switch: 1 handler
- Second: 2 handlers (each fires, adding more)
- Third: 4 handlers
- Fourth: 8 handlers
- After 10 cycles: 1000+ handlers all firing simultaneously

**Fix:** Added a flag `wakeLockVisibilityHandlerAdded` to ensure the handler is only added once:
```javascript
if (!this.wakeLockVisibilityHandlerAdded) {
    this.wakeLockVisibilityHandlerAdded = true;
    document.addEventListener('visibilitychange', ...);
}
```

**Lesson:** Never add event listeners inside functions that may be called multiple times. Use flags or move listener setup to initialization code.

### Multi-line colored blocks only show color on first line (v1.2.3+)

**Problem:** Room descriptions or other multi-line content set to a color (e.g., `aset room_long yellow`) only showed color on the first line. Subsequent lines displayed in default color.

**Root Cause:** The MUD sends one ANSI code at the start of the block, then multiple lines, then a reset. When we split by lines:
- Line 1: `\x1b[33mThis is the center of Pinnacle...` → has color
- Line 2: `street runs north and south...` → NO color code
- Line 3: `the middle of the street.\x1b[0m` → has reset only

**Solution:** Track ANSI state across lines:
```javascript
let currentAnsiState = '';

// If line doesn't start with ANSI but we have state, prepend it
if (!startsWithAnsi && currentAnsiState) {
  line = currentAnsiState + line;
}

// Track state: update on color codes, clear on reset
if (line.includes('\x1b[0m')) {
  currentAnsiState = '';
} else if (lastAnsiCode) {
  currentAnsiState = lastAnsiCode;
}
```

### Reconnect after idle timeout immediately disconnects again

**Problem:** User idles for a long time, MUD kicks them. They click Reconnect, connect briefly, then immediately disconnect again. Usually only happens once.

**Root Cause:** When MUD closed the connection (idle kick), `mudSocket.on('close')` was calling `closeSession()` which deleted the session from the map entirely. But:
1. The WebSocket to the browser was still open
2. The `session` variable in the WebSocket handler still referenced the old (now orphaned) session object
3. On reconnect, operations used this orphaned session not in the map
4. This caused inconsistent state - the session worked partially but had issues

**Fix:** When MUD closes unexpectedly, DON'T delete the entire session. Just clean up the socket reference:
```javascript
session.mudSocket.on('close', () => {
  sendToClient(session, { type: 'system', message: 'Connection to MUD closed.' });
  // Don't delete session - user might want to reconnect
  session.mudSocket = null;
  // Only delete session on explicit disconnect (user clicked button)
  if (session.explicitDisconnect) {
    closeSession(session, 'explicit disconnect');
  }
});
```

**Result:** Session stays in the map with all triggers/aliases intact. User can reconnect cleanly without the session being in an inconsistent state.

### Reconnect robustness improvements (v2.6.2+)

The reconnect flow was improved to handle edge cases more reliably.

**Server-side (`connectToMud` in `server.js`):**
- Remove all event listeners before destroying socket (prevents spurious events during teardown)
- Clear `lineBuffer` and `lineBufferTimeout` from previous connection
- Reset MIP state (`mipId`, `currentAnsiState`) for fresh connection

**Client-side (`reconnect` in `app.js`):**
- Reset all MIP-related state (`mipEnabled`, `mipReady`, `mipStarted`)
- Check if WebSocket is actually OPEN before sending `requestReconnect` message
- If WebSocket is dead/closed, perform full WebSocket reconnect instead of just MUD reconnect

**Client-side (`reconnect` in `connection.js`):**
- Reset all connection flags (`connected`, `authenticated`, `sessionResumed`)
- Null out event handlers before closing socket (prevents handlers firing during close)
- Force close socket even if in weird state

**Flow:**
1. User clicks Reconnect
2. Check WebSocket state:
   - **OPEN**: Send `reconnect` message → server cleans up old MUD socket → connects fresh MUD
   - **CLOSED/CLOSING**: Full WebSocket teardown → fresh WebSocket → fresh MUD connection

### Font size not saving below 10px (pinch-to-zoom)

**Problem:** User pinches to zoom to 6px font, but it reverts to 10px after opening/closing panels or refreshing.

**Root Cause:** The PHP API (`api/preferences.php`) was validating font size with `max(10, min(24, $fontSize))`, but the UI slider allows 6-24px. Values below 10 were clamped to 10 on save.

**Fix:** Change validation to `max(6, min(24, $fontSize))` to match the UI slider's `min="6"` attribute.

**Lesson:** Always keep frontend and backend validation ranges in sync.

### Login loops back to login screen (cookie path mismatch) - January 2026

**Problem:** User logs in successfully but gets redirected back to the login screen. Clearing cookies doesn't help. Affects all users.

**Root Cause:** Cookie path mismatch between API and pages - a latent bug exposed by `session_regenerate_id(true)`.

The old code in `initSession()` and `requireAuth()` calculated cookie path from `dirname($_SERVER['SCRIPT_NAME'])`:
- For `/api/auth.php` → cookie path = `/api/`
- For `/characters.php` → cookie path = `/`

**Why it suddenly became a problem:**

This bug existed for months but was harmless until `session_regenerate_id(true)` was added to `startUserSession()`:

- **Before regenerate:** Login kept the same session ID. Even with two cookies (different paths), both pointed to the same session → worked fine.
- **After regenerate:** Login creates NEW session ID, deletes old session file. New cookie set with path `/`, but old cookie with path `/api/` still exists with OLD session ID. API calls send old cookie → empty session → "Authentication required"

**How we found it:** Added auth logging (`data/logs/auth.log`) which showed:
```
LOGIN COMPLETE: final_session_id=2d90b4d28bbbd5dc51cbbd178989b656
requireAuth /characters.php: cookie=2d90b4d28bbbd5dc51cbbd178989b656, user_id=nathan ✓
requireAuth /api/characters.php: cookie=009362cd7be200fe3e4a028964d68fdc, user_id=NOT SET ✗
```
The API was receiving a DIFFERENT (old) cookie than the pages - classic path mismatch.

**Fix (two parts):**

1. Always use `/` as cookie path in both `initSession()` and `requireAuth()`:
```php
session_set_cookie_params([
    'lifetime' => SESSION_LIFETIME,
    'path' => '/',  // Always root, not calculated from script path
    ...
]);
```

2. Delete old `/api/` path cookies to clean up existing users:
```php
// Delete any old cookies with /api/ path (legacy bug fix)
if (isset($_COOKIE[SESSION_NAME])) {
    setcookie(SESSION_NAME, '', time() - 3600, '/api/');
}
```

**Auth Debug Logging:**

Debug logging remains in place at `data/logs/auth.log`:
- `startUserSession()` logs login attempts, session regeneration, final session ID
- `requireAuth()` logs URI, cookie value, session ID, and user_id

**TODO (April 2026):** If no further session issues arise, consider removing the debug logging from `requireAuth()` in `includes/functions.php` and `startUserSession()` in `includes/auth.php` to reduce log growth. The logging was invaluable for diagnosing this issue but adds overhead for each request.

**Lessons:**
1. When debugging session issues, log session IDs across requests. Different IDs = cookie problem.
2. `session_regenerate_id()` can expose latent cookie bugs that were harmless before.
3. Cookie path specificity matters: `/api/` takes precedence over `/` for requests to `/api/*`.

### #delay commands skipping lines when run from alias (v2.6.1+)

**Problem:** An alias with 24 `#delay` commands only executed 3 of them. Also, "Delay set:" confirmation messages were printing for each delay.

**Root Cause:** The auto-generated delay name used `Date.now()`:
```javascript
name = 'delay_' + Date.now();
```
When multiple delays are created within the same millisecond (which happens when an alias rapidly creates many delays), they all get the SAME name and overwrite each other. Only the last delay with each timestamp survives.

**Fix:**
1. Use a sequential counter instead of timestamp:
```javascript
name = 'delay_' + (++this.delayCounter);
```

2. Remove the "Delay set:" confirmation message (TinTin++ doesn't print confirmations).

3. Execute `#` commands directly via `processClientCommand()` instead of round-tripping through the server.

4. **Semicolon parsing:** When delay fires, split command by semicolons (respecting brace depth) before executing. Added `parseCommands()` helper to `app.js`. This allows delays like:
```
#delay {5} {#showme {Hello};say world}
```
The `#showme` runs client-side, then `say world` is sent to MUD.

**Also fixed:** TinTin++ VT100 color codes `<xyz>` now support digits 8 and 9:
- `8` = default foreground/background (reset to terminal default)
- `9` = default (same as 8 for practical purposes)

So `<179>` now correctly produces bold (1) + white (7) + default background (9).

### Command parsing in tickers and aliases

**Problem:** Ticker/alias commands like `#showme {text};grepdebug foo` were treated as a single command instead of being split on the semicolon.

**Root Cause:** `expandCommandWithAliases()` in `server.js` only split commands AFTER alias expansion. If no alias matched, the entire string was returned unsplit.

**Fix:** Modified `expandCommandWithAliases()` to split by `parseCommands()` FIRST, then process each part for alias expansion. This ensures semicolon-separated commands always get split, regardless of whether aliases are involved.

## Mobile UI Architecture

On mobile (screens < 768px), panels become full-screen overlays for focused interaction.

### Panel Types

There are TWO different panel elements - don't confuse them:

| Element | CSS Class | Purpose | Location |
|---------|-----------|---------|----------|
| Settings Panel | `.side-panel` | Settings, preferences | `app.php:229` |
| Actions Panel | `.scripts-sidebar` | Triggers, aliases, classes | `app.php:240` |

### Mobile Full-Screen Behavior

Both panels use these mobile styles:
```css
@media (max-width: 768px) {
    .side-panel, .scripts-sidebar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;  /* Full screen - covers command bar */
        width: 100%;
        max-width: none;
        z-index: 100;
    }
}
```

### PWA-Specific Overrides

PWA mode (`display-mode: standalone`) has additional media queries for safe areas:
- `@media (display-mode: standalone) and (max-width: 768px)`
- `@media (display-mode: standalone) and (max-width: 480px)`

These add padding for iPhone notch (`safe-area-inset-top`) and home indicator (`safe-area-inset-bottom`).

**CRITICAL:** PWA rules must include ALL positioning properties (`position`, `top`, `left`, `right`, `bottom`, `width`, `max-width`). If they only override some properties (e.g., just `bottom`), the panel may not be full-screen because base mobile rules get partially overwritten.

### Common Mobile Panel Issues

**Panel not full-width on mobile:**
1. Check if the correct element is being styled (`.side-panel` vs `.scripts-sidebar`)
2. Verify PWA media queries include all positioning properties
3. Check z-index - panel might be behind other elements

**Panel leaves gap at bottom (command bar visible):**
- Both panels should have `bottom: 0` for true full-screen
- If gap appears, check that all media queries set `bottom: 0`

**Safe area issues on iPhone:**
- Header needs `padding-top: calc(X + env(safe-area-inset-top))`
- Footer needs `padding-bottom: calc(X + env(safe-area-inset-bottom))`
