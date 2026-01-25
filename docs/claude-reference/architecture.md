# Architecture Documentation

System architecture details for the WMT client.

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

### Health Check System (v2.1.0+)

Detects and recovers from "zombie" WebSocket connections - sockets that appear OPEN but the actual TCP connection is dead.

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

**Why this matters for PWA:**
iOS completely freezes PWA apps when backgrounded. WebSocket object survives in memory but TCP connection dies. `socket.readyState` may still show `OPEN` even though it's dead. Health check with timeout detects this zombie state.

### Multi-Device Session Management (v2.5.0+)

When user logs into same character from different device, old session's MUD connection is automatically closed.

**How it works:**
1. Client sends `userId` and `characterId` with auth message
2. Server tracks sessions by user+character in `userCharacterSessions` map
3. When new session connects for same user+character:
   - Old session receives `session_taken` message
   - Old session's MUD connection is closed
   - New session proceeds normally

---

## Trigger Processing Architecture (CRITICAL)

**Triggers run SERVER-SIDE, not client-side.** This is a deliberate architectural decision for mobile support.

### Why Server-Side Triggers?

On mobile devices, browsers can disconnect at any time (app switching, network blips, screen lock). With session persistence, the MUD connection survives these disconnects. If triggers ran client-side, they would STOP WORKING when the browser disconnects.

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

`#showme` sends text to the server via `test_line` message, which runs it through `processTriggers()` exactly like MUD output.

### DO NOT Move Triggers Client-Side

Any refactoring that moves trigger processing to the client will break:
- Session persistence (triggers stop during disconnects)
- Mobile usability (triggers fail during app switches)
- Combat automation (missed triggers during brief network issues)

---

## Admin Broadcast Feature (v2.4.0+)

Admins can send messages to all currently connected users.

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

### How It Works

1. Admin enters message in admin.php Broadcast section
2. JavaScript POSTs to `https://wmt-proxy.onrender.com/broadcast` with:
   - `X-Admin-Key` header
   - JSON body: `{ "message": "your message" }`
3. Server validates key, sends `broadcast` message to each connected WebSocket
4. Client displays message prominently with system styling

### Key Files
- `glitch/server.js`: `/broadcast` endpoint handler
- `admin.php`: Broadcast form and `sendBroadcast()` function
- `assets/js/app.js`: `case 'broadcast':` message handler

### WebSocket URL vs HTTP URL

`WS_CLIENT_URL` is `wss://...` (WebSocket). Broadcast uses HTTP, so convert:
```javascript
const proxyUrl = WS_CLIENT_URL.replace('wss://', 'https://');
fetch(proxyUrl + '/broadcast', { ... });
```

---

## Multi-Server Support (3K/3S Toggle)

The client supports both 3Kingdoms and 3Scapes MUDs.

### How It Works

1. **Character Data** (`includes/functions.php`):
   - Each character has `server` field: `'3k'` or `'3s'`
   - Default is `'3k'` for backwards compatibility

2. **Session Tracking**:
   - `setCurrentCharacter()` stores server in `$_SESSION['character_server']`
   - `app.php` reads this to set `mudHost` and `mudPort` in `WMT_CONFIG`

3. **WebSocket Proxy** (`glitch/server.js`):
   - Does NOT auto-connect on WebSocket open
   - Waits for `set_server` message with host/port
   - **Security**: Only allows whitelisted servers:
     ```javascript
     const allowedServers = [
       { host: '3k.org', port: 3000 },
       { host: '3scapes.org', port: 3200 }
     ];
     ```

4. **Client Connection** (`assets/js/app.js`):
   - `onConnect()` always sends `set_server` first with host/port from `WMT_CONFIG`

5. **Character Selection** (`characters.php`):
   - Toggle UI next to each character
   - API endpoint: `api/characters.php?action=set_server`

### Duplicate Character Names

Characters with same name allowed if on different servers. Duplicate check compares both name AND server.

### MIP Detection for 3Scapes

3Scapes has different login messages. MIP detection triggers on:
- `"3Kingdoms welcomes you"` or `"entering 3Kingdoms"` (3K)
- `"3Scapes welcomes you"` or `"entering 3Scapes"` (3S)

---

## Mobile UI Architecture

On mobile (screens < 768px), panels become full-screen overlays.

### Panel Types

| Element | CSS Class | Purpose |
|---------|-----------|---------|
| Settings Panel | `.side-panel` | Settings, preferences |
| Actions Panel | `.scripts-sidebar` | Triggers, aliases, classes |

### Mobile Full-Screen Behavior

```css
@media (max-width: 768px) {
    .side-panel, .scripts-sidebar {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        width: 100%;
        max-width: none;
        z-index: 100;
    }
}
```

### PWA-Specific Overrides

PWA mode has additional media queries for safe areas:
- `@media (display-mode: standalone) and (max-width: 768px)`

These add padding for iPhone notch (`safe-area-inset-top`) and home indicator (`safe-area-inset-bottom`).

**CRITICAL:** PWA rules must include ALL positioning properties. Partial overrides cause layout issues.

---

## Adding New Action Types

When adding a new action type (triggers, aliases, etc.), update:

### 1. UI Buttons (3 places in `app.php`)
- **+New dropdown menu** (~line 76-83)
- **Hamburger menu** (~line 101-106)
- **Actions sidebar buttons** - in `app.js` `renderScriptsSidebar()`

### 2. JavaScript Methods (in `app.js`)
- `open[Type]Modal(editIndex)`
- `save[Type]()`
- `delete[Type]ById(id)` / `edit[Type]ById(id)`
- `cmd[Type](args)` - TinTin++ command handler

### 3. Modal HTML (in `app.php`)
- Add `<div class="modal-overlay" id="[type]-modal">` section

### 4. Data Storage
- Add to `this.[types]` array in app.js
- Add save/load in `saveScriptsToServer()` / `loadScriptsFromServer()`
- Server-side: update `api/scripts.php` if needed

### 5. Styling
- Modals use `.modal-overlay.open` to display

### Checklist
- [ ] +New dropdown menu button
- [ ] Hamburger menu button
- [ ] Actions sidebar button
- [ ] Modal HTML with form fields
- [ ] `open[Type]Modal()` method
- [ ] `save[Type]()` method
- [ ] Class dropdown in modal
- [ ] TinTin++ command handler if applicable
- [ ] Data persistence
