# WMT Client - Project Summary for Claude Code

## Project Overview
**WMT Client** is a PHP-based web MUD client specifically designed for connecting to 3k.org (port 3000). It features multi-user support, triggers, aliases, display customization, and settings import/export.

**Live URL:** https://client.wemudtogether.com

---

## Architecture

### Why This Architecture
- **User requested PHP-based web app** with multi-user login
- **MUD requires persistent TCP connection** - browsers can't do raw TCP, so we need a WebSocket proxy
- **IONOS shared hosting** doesn't allow background processes or non-standard ports (8080 blocked)
- **Solution:** Split architecture - web UI on IONOS, WebSocket proxy on Render.com (free)

### Components

1. **Web Frontend (IONOS - client.wemudtogether.com)**
   - PHP 8.x backend
   - HTML/CSS/JavaScript frontend
   - User authentication (bcrypt passwords)
   - JSON file storage for user data (triggers, aliases, preferences)
   - Session-based auth with proper cookie path handling for subdirectory

2. **WebSocket Proxy (Render.com - wmt-proxy.onrender.com)**
   - Node.js WebSocket server
   - Proxies browser WebSocket to MUD TCP connection (3k.org:3000)
   - Handles triggers and aliases server-side
   - GitHub repo: https://github.com/nduval/WMTClient

---

## Key Files

### IONOS Server (`/client/` directory)
```
├── index.php              # Login/register page
├── app.php                # Main MUD client interface
├── config/
│   └── config.php         # App config (WS_CLIENT_URL points to Render)
├── includes/
│   ├── auth.php           # Authentication (initSession with proper cookie path)
│   ├── functions.php      # Helpers (requireAuth also has session fix)
│   └── settings.php       # Settings management
├── api/
│   ├── auth.php           # Login/register/logout API
│   ├── triggers.php       # Trigger CRUD
│   ├── aliases.php        # Alias CRUD
│   ├── preferences.php    # Display settings
│   └── export.php         # Import/export
├── assets/
│   ├── css/style.css
│   └── js/
│       ├── app.js         # Main client logic
│       └── connection.js  # WebSocket handler
└── data/users/            # User data stored as JSON
```

### Render.com WebSocket Proxy
```
├── server.js              # Node.js WebSocket-to-TCP proxy
└── package.json           # Dependencies (ws library)
```

---

## Critical Fixes Applied

### 1. Session Cookie Path Issue (ERR_TOO_MANY_REDIRECTS)
**Problem:** Sessions weren't persisting between pages because cookie path was wrong for subdirectory hosting.

**Solution:** Created `initSession()` function in `includes/auth.php` that:
- Detects subdirectory from `$_SERVER['SCRIPT_NAME']`
- Sets proper cookie path (e.g., `/client/`)
- Configures secure, httponly, samesite cookies

**Also fixed in:**
- `includes/functions.php` - `requireAuth()` function duplicates this logic
- All API files use `initSession()` instead of raw `session_start()`

### 2. Session Not Saving After Login
**Problem:** Session data was empty after redirect to app.php.

**Solution:** In `startUserSession()`, added `session_write_close()` after setting session data, then restart session. Removed `session_regenerate_id()` which was causing issues.

### 3. Port 8080 Blocked on IONOS
**Problem:** WebSocket server couldn't run on IONOS because port 8080 is blocked.

**Solution:** Deployed WebSocket proxy to Render.com (free tier), updated `config.php`:
```php
define('WS_CLIENT_URL', 'wss://wmt-proxy.onrender.com');
```

---

## Access Credentials

**DO NOT COMMIT THESE FILES TO GIT**

- `sftp.txt` - SFTP credentials for IONOS file upload
- `ssh_user.txt` - SSH username and hostname
- `priv_key.txt` - SSH private key for IONOS

### SFTP Access (for file uploads)
- Host: `home295625025.1and1-data.host`
- User: See `sftp.txt`
- Used via Python paramiko library

### SSH Access (for commands)
- Host: `home295625025.1and1-data.host`
- User: See `ssh_user.txt`
- Key: `priv_key.txt`
- PHP 8.2 available at: `/usr/bin/php8.2-cli`

---

## How to Deploy Changes

### Using deploy.py (Recommended)

The `deploy.py` script handles both Render and IONOS deployments:

```bash
# Deploy to both Render and IONOS
python deploy.py all

# Deploy only to Render (WebSocket proxy)
python deploy.py render

# Deploy only to IONOS (PHP client)
python deploy.py ionos

# Deploy with custom commit message
python deploy.py render -m "Fix trigger handling"

# List what files would be deployed
python deploy.py --list
```

**Requirements:** `pip install paramiko` for IONOS deployment

### Manual Deployment

**Render (WebSocket proxy):**
```bash
cd D:\GitHub\client
git add server.js package.json
git commit -m "Your message"
git push origin main
```
Render auto-deploys from main branch.

**IONOS (PHP client):**
Uses SFTP with credentials from `sftp.txt`. The deploy.py script handles this automatically.

---

## Current Status

### Working
- User registration and login
- Session persistence across pages
- WebSocket connection to Render proxy
- MUD connection to 3k.org:3000
- Basic MUD output display
- Reconnect button
- Deployment workflow (deploy.py)
- Character profiles (create, select, switch, rename, delete)

### Needs Testing
- Triggers functionality
- Aliases functionality
- Display customization
- Import/export (now per-character)

### Known Issues
- None currently known

### Hosting Notes
- **Render is on PAID tier** - no cold starts, always responsive

---

## Useful Commands

### Test IONOS SSH
```python
import paramiko
key = paramiko.RSAKey.from_private_key_file('priv_key.txt')
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('home295625025.1and1-data.host', username='u54599139', pkey=key)
stdin, stdout, stderr = client.exec_command('ls -la ~/client/')
print(stdout.read().decode())
```

### Test Render Health
```
curl https://wmt-proxy.onrender.com/health
```

---

## Notes for Future Development

1. **Always use `initSession()`** - Never use raw `session_start()` or sessions will break

2. **Test in incognito** - Session issues are easiest to debug with fresh cookies

3. **PHP version on IONOS** - Default is PHP 4.4 (ancient). Use `/usr/bin/php8.2-cli` for CLI commands

4. **File permissions** - IONOS may need `chmod 755` on directories, `chmod 644` on files

5. **Update this summary** - Keep the changelog updated after each significant change

---

## Changelog

### 2026-01-10 - New MUD Character Creation Flow
- **Added:** "New to 3Kingdoms?" option on character selection page
- When creating a new MUD character:
  1. Enter desired character name (letters only)
  2. Creates local profile and connects to MUD
  3. Auto-sends character name to MUD after connection
  4. User continues with MUD's registration prompts (password, email, etc.)
- **Files changed:** `characters.php`, `app.php`, `assets/js/app.js`

### 2026-01-10 - Character Profiles Feature
- **Added:** Multi-character support - each user can create multiple characters
- **New files:**
  - `characters.php` - Character selection/management page
  - `api/characters.php` - Character CRUD API (create, select, rename, delete)
- **Modified files:**
  - `includes/functions.php` - Added character data path helpers and character management functions
  - `api/triggers.php`, `api/aliases.php`, `api/preferences.php`, `api/export.php` - Now require character selection, use per-character paths
  - `app.php` - Added character switcher dropdown in header
  - `assets/js/app.js` - Added character switching functionality
  - `assets/css/style.css` - Added character switcher styles
  - `index.php` - Redirects to characters.php after login
  - `deploy.py` - Added characters.php to deployment list
- **Data structure:** `/data/users/{userId}/characters/{charId}/` for per-character triggers, aliases, preferences
- **Flow:** Login → Character Select → App (with in-app character switcher)

### 2026-01-10 - Telnet Protocol Fix
- **Fixed:** Garbled characters (diamond boxes with question marks) on MUD output
- **Root cause:** MUD uses telnet protocol which sends IAC (Interpret As Command) control sequences for negotiation - these binary bytes were being displayed as text
- **Solution:** Added `stripTelnetSequences()` function to filter out telnet commands (WILL/WONT/DO/DONT, subnegotiations, etc.) before converting to text
- **Deployed:** Pushed to GitHub, Render auto-deployed

### 2026-01-10 - Deployment Workflow
- Created `deploy.py` script for automated deployments
- Set up git repo with GitHub token authentication
- Can now deploy to Render (git push) and IONOS (SFTP) with single command
- Usage: `python deploy.py all` or `python deploy.py render` or `python deploy.py ionos`

### 2026-01-10 - Reconnect Bug Fix
- **Fixed:** Reconnect button hanging issue
- **Root cause:** When reconnecting, server.js created new MUD socket but didn't attach event handlers (data, close, error)
- **Solution:** Refactored `connectToMud()` function that handles both initial connection and reconnects with all handlers properly attached
- **Deployed:** Pushed to GitHub, Render auto-deployed

### 2026-01-10 - Initial Build Session
- Created complete WMT Client application from scratch
- Built PHP backend with user auth, triggers, aliases, preferences, import/export
- Built JavaScript frontend with WebSocket connection handling
- Solved session cookie path issue for IONOS subdirectory hosting
- Discovered IONOS blocks port 8080 - created Node.js WebSocket proxy
- Deployed WebSocket proxy to Render.com (paid tier - always on)
- Successfully connected to 3k.org MUD through the proxy
- **Current state:** Login works, MUD connection works, basic UI functional
