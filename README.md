# WMT Client

A web-based MUD client for 3k.org built with PHP and WebSockets.

**Live URL**: https://client.wemudtogether.com/client/

## Features

- **Real-time MUD Connection**: WebSocket-based connection to 3k.org:3000
- **Multi-user Support**: User registration and login with secure password hashing
- **Triggers**: Automatic actions based on text patterns (regex support)
- **Aliases**: Command shortcuts with variable support ($1, $2, $*)
- **Customization**: Adjustable font, colors, and display settings
- **Import/Export**: Backup and restore your settings as JSON files

## Requirements

- PHP 8.0 or higher
- Composer (for Ratchet WebSocket library)
- Ability to run background PHP processes (for WebSocket server)

## IONOS Web Hosting Setup

### Step 1: Upload Files

Upload all files to your `/client` directory on IONOS via SFTP or File Manager.

### Step 2: Install Composer Dependencies

SSH into your IONOS hosting:
```bash
ssh username@access.ionos.com
cd ~/client
composer install
```

If `composer` is not available, try:
```bash
php composer.phar install
```

Or download Composer first:
```bash
curl -sS https://getcomposer.org/installer | php
php composer.phar install
```

### Step 3: Set Permissions

```bash
chmod 755 data
chmod 755 data/users
chmod 644 config/config.php
```

### Step 4: Configure WebSocket URL

Edit `config/config.php` and set the WebSocket URL:
```php
define('WS_CLIENT_URL', 'ws://client.wemudtogether.com:8080');
```

### Step 5: Start the WebSocket Server

**Important**: The WebSocket server must run continuously. Try:

```bash
# Option 1: Using nohup
nohup php websocket/server.php > /dev/null 2>&1 &

# Option 2: Using screen (if available)
screen -dmS wmt php websocket/server.php
```

**Note**: Shared hosting may kill long-running processes. If this happens, see "Alternative WebSocket Hosting" below.

### Step 6: Test

Visit: https://client.wemudtogether.com/client/

## Alternative WebSocket Hosting

If IONOS kills the WebSocket process, you can host the WebSocket server on a free cloud platform:

### Option A: Glitch.com (Free)

1. Create account at glitch.com
2. Create new Node.js project
3. Use a websocket-to-tcp proxy
4. Update `config/config.php`:
   ```php
   define('WS_CLIENT_URL', 'wss://your-project.glitch.me');
   ```

### Option B: Render.com (Free Tier)

1. Create account at render.com
2. Deploy the websocket folder as a web service
3. Update the config with the Render URL

### Option C: Railway.app (Free Tier)

Similar process to Render.

## Usage

### Getting Started

1. Register a new account or login with existing credentials
2. The client will automatically connect to 3k.org:3000
3. Type commands in the input field and press Enter to send

### Triggers

Triggers automatically execute actions when text matches a pattern.

1. Click **Triggers** in the header
2. Click **+ Add Trigger**
3. Enter a pattern to match
4. Choose match type:
   - **Contains**: Pattern appears anywhere in line
   - **Exact Match**: Line matches pattern exactly
   - **Starts With**: Line begins with pattern
   - **Ends With**: Line ends with pattern
   - **Regex**: Regular expression match
5. Add actions:
   - **Send Command**: Automatically send a command
   - **Highlight**: Highlight matching lines
   - **Gag**: Hide matching lines
   - **Play Sound**: Play an audio alert

### Aliases

Aliases are shortcuts for longer commands.

1. Click **Aliases** in the header
2. Click **+ Add Alias**
3. Enter the alias (what you type)
4. Enter the replacement (what gets sent)

**Variable support:**
- `$1`, `$2`, etc. - Individual arguments
- `$*` - All arguments

**Example:**
- Alias: `kk`
- Replacement: `kill $1; get all from corpse`
- Usage: `kk kobold` sends `kill kobold; get all from corpse`

### Settings

Customize your display:
- Font family and size
- Text and background colors
- Command echo on/off
- Auto-scroll behavior

### Import/Export

Backup your settings:
1. Go to **Settings**
2. Click **Export Settings** to download
3. Click **Import Settings** to restore

## File Structure

```
client/
├── index.php           # Login/register page
├── app.php             # Main application
├── composer.json       # PHP dependencies
├── config/
│   ├── config.php      # Application settings
│   └── .htaccess       # Deny direct access
├── includes/
│   ├── auth.php        # Authentication
│   ├── functions.php   # Helper functions
│   ├── settings.php    # Settings management
│   └── .htaccess       # Deny direct access
├── api/
│   ├── auth.php        # Auth API
│   ├── triggers.php    # Triggers API
│   ├── aliases.php     # Aliases API
│   ├── preferences.php # Preferences API
│   └── export.php      # Import/Export API
├── assets/
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js
│       └── connection.js
├── websocket/
│   ├── server.php      # WebSocket server
│   ├── MudHandler.php  # Connection handler
│   └── .htaccess       # Deny direct access
└── data/
    ├── users/          # User data (JSON files)
    └── .htaccess       # Deny direct access
```

## Configuration

Edit `config/config.php`:

```php
// MUD server
define('MUD_HOST', '3k.org');
define('MUD_PORT', 3000);

// WebSocket server (for running the server)
define('WS_HOST', '0.0.0.0');
define('WS_PORT', 8080);

// WebSocket URL (for client browser connection)
define('WS_CLIENT_URL', 'ws://client.wemudtogether.com:8080');
```

## Keyboard Shortcuts

- **Enter**: Send command
- **Up Arrow**: Previous command in history
- **Down Arrow**: Next command in history

## Troubleshooting

**WebSocket connection failed**
- Check if port 8080 is open on your hosting
- Verify the WebSocket server is running: `ps aux | grep websocket`
- Check server logs for errors

**Cannot connect to MUD**
- Verify 3k.org:3000 is accessible from your server
- Some hosts block outbound connections on non-standard ports

**Settings not saving**
- Ensure the `data/users/` directory is writable (chmod 755)

**WebSocket server keeps dying**
- Shared hosting may kill long-running processes
- Consider using an external WebSocket host (see alternatives above)
- Or set up a cron job to restart it

## Security Notes

- All passwords are hashed with bcrypt
- `.htaccess` files protect sensitive directories
- User data stored as JSON files (not exposed to web)

## License

MIT License
