<?php
/**
 * WMT Client Configuration
 */

// Application settings
define('APP_NAME', 'WMT Client');
define('APP_VERSION', '1.0.0');

// MUD server settings
define('MUD_HOST', '3k.org');
define('MUD_PORT', 3000);

// WebSocket server settings
define('WS_HOST', '0.0.0.0');
define('WS_PORT', 8080);

// WebSocket URL for client connection
define('WS_CLIENT_URL', 'wss://ws.wemudtogether.com');  // Lightsail


// Paths
define('BASE_PATH', dirname(__DIR__));
define('DATA_PATH', BASE_PATH . '/data');
define('USERS_PATH', DATA_PATH . '/users');

// Session settings
define('SESSION_NAME', 'wmt_session');
define('SESSION_LIFETIME', 86400 * 7); // 7 days

// Security
define('CSRF_TOKEN_NAME', 'csrf_token');
define('PASSWORD_MIN_LENGTH', 6);

// Admin key for WebSocket proxy (broadcast, session management)
// Load from separate file to keep it out of git
$adminKeyFile = __DIR__ . '/render_admin_key.php';
if (file_exists($adminKeyFile)) {
    require_once $adminKeyFile;
} else {
    define('RENDER_ADMIN_KEY', null);
}

// User storage limits
define('MAX_USER_STORAGE', 25 * 1024 * 1024); // 25 MB
define('MAX_USER_FILES', 250);

// Default display settings
define('DEFAULT_FONT_FAMILY', 'Consolas, Monaco, monospace');
define('DEFAULT_FONT_SIZE', 14);
define('DEFAULT_TEXT_COLOR', '#00ff00');
define('DEFAULT_BACKGROUND_COLOR', '#000000');

// Ensure data directories exist
if (!is_dir(DATA_PATH)) {
    mkdir(DATA_PATH, 0755, true);
}
if (!is_dir(USERS_PATH)) {
    mkdir(USERS_PATH, 0755, true);
}
