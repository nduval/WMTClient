# WMT WebSocket Proxy for Glitch

This is the WebSocket server component for WMT Client. Deploy this to Glitch.com to proxy WebSocket connections to the 3k.org MUD.

## Setup on Glitch

1. Go to https://glitch.com and sign up/login
2. Click "New Project" -> "Import from GitHub" or "glitch-hello-node"
3. If starting fresh, delete all files and upload these files:
   - `server.js`
   - `package.json`
4. Glitch will automatically install dependencies and start the server
5. Your WebSocket URL will be: `wss://YOUR-PROJECT-NAME.glitch.me`

## Update WMT Client Config

Edit `config/config.php` on your IONOS hosting:

```php
define('WS_CLIENT_URL', 'wss://YOUR-PROJECT-NAME.glitch.me');
```

Replace `YOUR-PROJECT-NAME` with your actual Glitch project name.
