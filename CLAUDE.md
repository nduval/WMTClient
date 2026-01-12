# WMT Client - Project Notes

## IMPORTANT: Maintaining This File

**After solving any significant bug or discovering important technical details, ALWAYS update this file with:**
1. What the problem was
2. What the solution was
3. Why it works (the underlying cause)

This ensures future sessions have context for troubleshooting. Hard-won knowledge should never be lost to context limits.

---

## Deployment

This project has two deployment targets:

### IONOS (PHP Client)
- **Production URL**: https://client.wemudtogether.com/app.php
- **Remote path**: root (subdomain document root is /client on server)
- **Command**: `python deploy.py ionos`
- Deploys PHP files, assets, config, etc. via SFTP
- Credentials stored in `sftp.txt`
- **Always deploy to IONOS after making changes to PHP, JS, or CSS files**

### Render (WebSocket Proxy)
- **Command**: `python deploy.py render`
- Deploys `server.js` via GitHub push (Render auto-deploys from main branch)
- Only needed when `glitch/server.js` changes

### Deploy Both
- **Command**: `python deploy.py all`

## Architecture

- **Frontend**: PHP on IONOS (index.php, app.php, etc.)
- **WebSocket Proxy**: Node.js on Render (server.js) - connects browser to MUD
- **MUD Server**: 3k.org:3000

## Key Directories

- `assets/js/app.js` - Main client JavaScript (triggers, aliases, TinTin++ commands)
- `assets/css/style.css` - All styling
- `glitch/server.js` - WebSocket proxy server (deployed to Render)
- `includes/` - PHP helper functions (auth, functions, settings)
- `api/` - PHP API endpoints
- `config/config.php` - App configuration

## TinTin++ Compatibility

This client supports TinTin++ style scripting:
- Pattern matching: `%*`, `%d`, `%w`, `%1`-`%99`, etc.
- Commands: `#action`, `#alias`, `#gag`, `#highlight`, `#var`, `#math`, `#if`, `#loop`, `#showme`, `#bell`, `#split`, `#ticker`, `#delay`, `#class`, `#read`, `#write`
- Script files: `.tin` format supported

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

### Fresh Login Timing (CRITICAL)
Fresh logins (non-linkdeath) start in a **stasis room** with only a "jump" exit. MIP does NOT work in this room - stats won't be sent until the player enters the real game world.

**Solution:** For fresh logins, we detect "Obvious exits:" and wait until exits are NOT just "jump" before enabling MIP. This ensures MIP registers after the player has jumped into the real world.

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

### Key Files
- `assets/js/app.js` - MIP enable/disable, stat bar updates, conditions
- `glitch/server.js` - MIP message parsing (parseMipMessage, parseFFFStats)

### Verifying Render Deployments
The WebSocket proxy includes a version indicator:
- Visit `https://wmt-proxy.onrender.com/` - shows version in page title
- Visit `https://wmt-proxy.onrender.com/health` - returns JSON with version field

If changes aren't taking effect, check that the version number updated. Render free tier can take 1-2 minutes to deploy after a push.

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
