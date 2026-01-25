# Protocol Documentation

Technical details about MIP, TCP packet handling, ANSI colors, and telnet protocols.

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

**Problem:** MIP registration must happen when the player is fully in the game world.

**Solution (v2.6.2+):** Use simple fixed delays after login detection:

| Login Type | Delay | Detection |
|------------|-------|-----------|
| **Fresh login** | 10 seconds | "3Kingdoms welcomes you" or "entering 3Kingdoms" |
| **Linkdeath recovery** | 4 seconds | "welcomes you back from linkdeath" |

**Why this works:**
- Fixed delays are predictable and work for all character types (players AND wizards)
- Wizards who skip stasis are already in-world, so delay just ensures everything is settled

**Key code location:** `app.js` in the `case 'mud':` message handler

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

| Type | Description |
|------|-------------|
| **FFF** | Composite stats (A=HP cur, B=HP max, C=SP cur, D=SP max, E/F=GP1, G/H=GP2, I/J=guild lines, K=enemy name, L=enemy %, N=round) |
| **BAD** | Room name |
| **DDD** | Exits (tilde-separated) |
| **BBA/BBB/BBC/BBD** | Labels for GP1/GP2/HP/SP |
| **AAC** | Time until reboot |
| **AAF** | Server uptime |
| **BAB** | Tells (2-way comms) |
| **CAA** | Chat channel messages |

### Alternate MIP Format

MIP data can also appear WITHOUT the `#K` prefix:
```
%<mipId:5><length:3><type:3><data:length>
```
Example: `%00378011AAC3.7 days` where mipId=00378, length=011, type=AAC

### MIP Filtering

**The MIP filter MUST run as the FIRST LINE OF DEFENSE** - before ANY other processing:

```javascript
// FIRST thing after checking for empty line:
if (/%\d{5}\d{3}[A-Z]{3}/.test(line)) {
  // Parse stats if possible, then ALWAYS return (gag the line)
  return;
}
```

The generic regex `/%\d{5}\d{3}[A-Z]{3}/` catches ALL MIP data regardless of session ID.

### MIP Disabled State

When "Enable MIP" is toggled off:
- Sub-toggles (HP bar, ChatMon, etc.) are greyed out with `mip-disabled` class
- HP status bar is hidden
- ChatMon button is hidden and panel closes
- Managed by `updateMipDependentUI()` in `app.js`

---

## TCP/Telnet Packet Handling

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

### TCP Line Buffering Solution

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

### Why Prompts Need Special Handling

MUD prompts typically don't end with newlines:
```
Enter your name: _
```

With line buffering, this would sit in the buffer forever. Two solutions:
1. **Telnet GA (Go Ahead):** IAC GA (255 249) means "done sending, waiting for input"
2. **Timeout fallback:** Flush buffer after ~100ms of silence

### Telnet GA (Go Ahead)

GA means "I'm done sending, waiting for input" - perfect for flushing the buffer immediately.

**Implementation:**
- `stripTelnetSequences()` returns `{ buffer, hasGA }`
- When GA detected, flush and process all buffered content immediately
- Fallback 100ms timeout still exists for MUDs that don't send GA

### Reference: TinTin++ Packet Patch

TinTin++ has the same challenges:
- `#config {packet patch} 0.5` - wait up to 0.5s for complete lines
- Uses GA/EOR signals to detect prompts
- This is a universal MUD client issue

---

## ANSI Color Handling

### ANSI Escape Code Format

Basic format: `\x1b[<codes>m` (or `\033[<codes>m` in octal)

- `\x1b[` or `\033[` - escape sequence introducer (ESC + `[`)
- `<codes>` - semicolon-separated SGR parameters
- `m` - terminates the sequence

**Examples:**
- `\x1b[31m` - set red foreground
- `\x1b[1;31m` - set bold AND red (compound code)
- `\x1b[0m` - reset all attributes

### Common SGR Codes

| Code | Meaning |
|------|---------|
| 0 | Reset ALL attributes |
| 1 | Bold/bright |
| 4 | Underline |
| 30-37 | Dim foreground (black, red, green, yellow, blue, magenta, cyan, white) |
| 90-97 | Bright foreground (same order) |
| 40-47 | Background colors |
| 100-107 | Bright background colors |

### Key Implementation Details

#### 1. Reset Means Reset ALL

ANSI code `0` resets ALL attributes. Any HTML representation must match this:

```javascript
// Track ALL open spans, close them ALL on reset
if (code === '0') {
    result += '</span>'.repeat(openSpans);
    openSpans = 0;
}
```

#### 2. Compound Codes Open Multiple Attributes

`\x1b[1;31m` sets BOTH bold AND red in one sequence. Must track count:
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

#### 3. Cross-Line State Tracking

MUDs often send one ANSI code at start of multi-line block. Must track state:

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

TCP fragmentation can split mid-sequence:
```
Packet 1: "You see \x1b[31"
Packet 2: "mred text\x1b[0m here"
```

**Solution:** Buffer until newline (or GA). Never process partial lines.

#### 5. Strip ANSI for Pattern Matching

When matching trigger patterns, ANSI codes must be stripped first. Otherwise patterns won't match colored text.

**Location:** `glitch/server.js` - `stripAnsi()` function in `processTriggers()`

### Common Pitfalls

1. **Forgetting compound codes**: `\x1b[1;31m` is ONE sequence that sets TWO attributes
2. **Single close on reset**: Reset must close ALL open spans, not just one
3. **Not tracking cross-line state**: Multi-line colored blocks lose color after first line
4. **Processing before buffering**: TCP fragments can split ANSI sequences
5. **Not stripping for triggers**: ANSI codes break pattern matching

---

## Verifying Render Deployments

The WebSocket proxy includes a version indicator:
- Visit `https://wmt-proxy.onrender.com/` - shows version in page title
- Visit `https://wmt-proxy.onrender.com/health` - returns JSON with version field

If changes aren't taking effect, check that the version number updated. Render free tier can take 1-2 minutes to deploy after a push.
