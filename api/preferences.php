<?php
/**
 * WMT Client - Preferences API
 */

require_once __DIR__ . '/../includes/functions.php';
require_once __DIR__ . '/../includes/auth.php';

$action = $_GET['action'] ?? '';

// Special handling for server-to-server endpoint (admin key auth, not session auth)
// This must be handled completely separately before session auth
if ($action === 'get_discord_prefs') {
    // Server-to-server endpoint for WebSocket proxy to fetch Discord prefs
    // This allows the proxy to have Discord prefs even after restart
    // Requires admin key authentication (not user session)

    $adminKey = $_SERVER['HTTP_X_ADMIN_KEY'] ?? '';

    // Load admin key from config
    $configAdminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;

    if (!$configAdminKey) {
        errorResponse('Admin key not configured', 500);
    }

    if ($adminKey !== $configAdminKey) {
        errorResponse('Invalid admin key', 403);
    }

    // Get user_id and character_id from query params (not session)
    $reqUserId = $_GET['user_id'] ?? '';
    $reqCharacterId = $_GET['character_id'] ?? '';

    if (empty($reqUserId) || empty($reqCharacterId)) {
        errorResponse('user_id and character_id are required', 400);
    }

    // Validate user exists
    $user = findUserById($reqUserId);
    if (!$user) {
        errorResponse('User not found', 404);
    }

    // Load preferences for this character
    $prefsPath = getPreferencesPath($reqUserId, $reqCharacterId);
    if (!file_exists($prefsPath)) {
        // No preferences file - return empty prefs
        successResponse([
            'channelPrefs' => [],
            'discordUsername' => $user['username'] ?? 'WMT Client'
        ]);
        exit;
    }

    $preferences = loadJsonFile($prefsPath);

    // Extract just the Discord-relevant parts
    $channelPrefs = $preferences['channelPrefs'] ?? [];

    // Get character name for Discord username
    $characters = getCharacters($reqUserId);
    $characterName = 'WMT Client';
    foreach ($characters as $char) {
        if ($char['id'] === $reqCharacterId) {
            $characterName = $char['name'];
            break;
        }
    }

    successResponse([
        'channelPrefs' => $channelPrefs,
        'discordUsername' => $characterName
    ]);
    exit;
}

// All other actions require session auth
initSession();
requireAuth();

// Block guest write operations
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    denyGuest();
}

$userId = getCurrentUserId();
$characterId = getCurrentCharacterId();

if (!$characterId) {
    errorResponse('No character selected', 400);
}

switch ($action) {
    case 'get':
        $preferences = loadJsonFile(getPreferencesPath($userId, $characterId));

        // Merge with defaults
        $defaults = [
            'fontFamily' => DEFAULT_FONT_FAMILY,
            'fontSize' => DEFAULT_FONT_SIZE,
            'textColor' => DEFAULT_TEXT_COLOR,
            'backgroundColor' => DEFAULT_BACKGROUND_COLOR,
            'echoCommands' => true,
            'scrollOnOutput' => true,
            'keepAlive' => true,
            'keepAliveInterval' => 60
        ];

        $preferences = array_merge($defaults, $preferences);

        successResponse(['preferences' => $preferences]);
        break;

    case 'save':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $preferences = $data['preferences'] ?? [];

        // Validate and sanitize preferences
        $validated = [];

        // Font family (whitelist allowed values)
        $allowedFonts = [
            'Consolas, Monaco, monospace',
            "'Courier New', Courier, monospace",
            "'Lucida Console', Monaco, monospace",
            'monospace'
        ];
        if (isset($preferences['fontFamily']) && in_array($preferences['fontFamily'], $allowedFonts)) {
            $validated['fontFamily'] = $preferences['fontFamily'];
        }

        // Font size (6-24)
        if (isset($preferences['fontSize'])) {
            $fontSize = intval($preferences['fontSize']);
            $validated['fontSize'] = max(6, min(24, $fontSize));
        }

        // Colors (validate hex format)
        if (isset($preferences['textColor']) && preg_match('/^#[0-9a-fA-F]{6}$/', $preferences['textColor'])) {
            $validated['textColor'] = $preferences['textColor'];
        }

        if (isset($preferences['backgroundColor']) && preg_match('/^#[0-9a-fA-F]{6}$/', $preferences['backgroundColor'])) {
            $validated['backgroundColor'] = $preferences['backgroundColor'];
        }

        // Boolean settings
        if (isset($preferences['echoCommands'])) {
            $validated['echoCommands'] = (bool)$preferences['echoCommands'];
        }

        if (isset($preferences['scrollOnOutput'])) {
            $validated['scrollOnOutput'] = (bool)$preferences['scrollOnOutput'];
        }

        if (isset($preferences['retainLastCommand'])) {
            $validated['retainLastCommand'] = (bool)$preferences['retainLastCommand'];
        }

        if (isset($preferences['keepAlive'])) {
            $validated['keepAlive'] = (bool)$preferences['keepAlive'];
        }

        if (isset($preferences['mipDebug'])) {
            $validated['mipDebug'] = (bool)$preferences['mipDebug'];
        }

        if (isset($preferences['wakeLock'])) {
            $validated['wakeLock'] = (bool)$preferences['wakeLock'];
        }

        if (isset($preferences['mipEnabled'])) {
            $validated['mipEnabled'] = (bool)$preferences['mipEnabled'];
        }

        if (isset($preferences['mipHpBar'])) {
            $validated['mipHpBar'] = (bool)$preferences['mipHpBar'];
        }

        if (isset($preferences['mipShowStatBars'])) {
            $validated['mipShowStatBars'] = (bool)$preferences['mipShowStatBars'];
        }

        if (isset($preferences['mipShowGuild'])) {
            $validated['mipShowGuild'] = (bool)$preferences['mipShowGuild'];
        }

        if (isset($preferences['mipShowRoom'])) {
            $validated['mipShowRoom'] = (bool)$preferences['mipShowRoom'];
        }

        if (isset($preferences['mipShowExits'])) {
            $validated['mipShowExits'] = (bool)$preferences['mipShowExits'];
        }

        // Keep alive interval (30-300 seconds)
        if (isset($preferences['keepAliveInterval'])) {
            $interval = intval($preferences['keepAliveInterval']);
            $validated['keepAliveInterval'] = max(30, min(300, $interval));
        }

        // Scrollback limit (2000-20000 lines)
        if (isset($preferences['scrollbackLimit'])) {
            $limit = intval($preferences['scrollbackLimit']);
            $validated['scrollbackLimit'] = max(2000, min(20000, $limit));
        }

        // History size (100-2000)
        if (isset($preferences['historySize'])) {
            $size = intval($preferences['historySize']);
            $validated['historySize'] = max(100, min(2000, $size));
        }

        // Idle disconnect / deadman switch (0=disabled, 15/30/60/120 minutes)
        if (isset($preferences['idleDisconnectMinutes'])) {
            $minutes = intval($preferences['idleDisconnectMinutes']);
            // Only allow specific values
            $allowedMinutes = [0, 15, 30, 60, 120];
            if (in_array($minutes, $allowedMinutes)) {
                $validated['idleDisconnectMinutes'] = $minutes;
            }
        }

        // Channel preferences (for ChatMon)
        if (isset($preferences['channelPrefs']) && is_array($preferences['channelPrefs'])) {
            $validatedChannels = [];
            foreach ($preferences['channelPrefs'] as $channel => $prefs) {
                // Sanitize channel name (alphanumeric, lowercase, max 50 chars)
                $channel = strtolower(preg_replace('/[^a-zA-Z0-9_-]/', '', substr($channel, 0, 50)));
                if (empty($channel)) continue;

                $channelData = [
                    'sound' => isset($prefs['sound']) ? (bool)$prefs['sound'] : false,
                    'hidden' => isset($prefs['hidden']) ? (bool)$prefs['hidden'] : false,
                    'discord' => isset($prefs['discord']) ? (bool)$prefs['discord'] : false,
                    'webhookUrl' => ''
                ];

                // Validate webhook URL if provided
                if (isset($prefs['webhookUrl']) && is_string($prefs['webhookUrl'])) {
                    $url = trim($prefs['webhookUrl']);
                    if ($url === '' ||
                        preg_match('#^https://(discord\.com|discordapp\.com)/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$#', $url)) {
                        $channelData['webhookUrl'] = $url;
                    }
                }

                // Validate header color (hex string or empty)
                if (isset($prefs['headerColor']) && is_string($prefs['headerColor'])) {
                    $hc = trim($prefs['headerColor']);
                    if ($hc === '' || preg_match('/^#[0-9a-fA-F]{6}$/', $hc)) {
                        $channelData['headerColor'] = $hc;
                    }
                }

                // Validate background color (hex string or empty)
                if (isset($prefs['bgColor']) && is_string($prefs['bgColor'])) {
                    $bc = trim($prefs['bgColor']);
                    if ($bc === '' || preg_match('/^#[0-9a-fA-F]{6}$/', $bc)) {
                        $channelData['bgColor'] = $bc;
                    }
                }

                $validatedChannels[$channel] = $channelData;
            }
            $validated['channelPrefs'] = $validatedChannels;
        }

        // Discord webhook URL (validate format)
        if (isset($preferences['discordWebhookUrl'])) {
            $url = trim($preferences['discordWebhookUrl']);
            // Only allow Discord webhook URLs or empty string
            if ($url === '' ||
                preg_match('#^https://(discord\.com|discordapp\.com)/api/webhooks/[0-9]+/[A-Za-z0-9_-]+$#', $url)) {
                $validated['discordWebhookUrl'] = $url;
            }
        }

        // Startup script (validate filename)
        if (isset($preferences['startupScript'])) {
            $script = trim($preferences['startupScript']);
            if ($script === '' || preg_match('/^[a-zA-Z0-9_\-]+\.(tin|txt)$/', $script)) {
                $validated['startupScript'] = $script;
            }
        }

        // Debug flags
        if (isset($preferences['debugIf'])) {
            $validated['debugIf'] = (bool)$preferences['debugIf'];
        }

        // Notification sound (whitelist allowed values)
        $allowedSounds = ['classic', 'ping', 'double', 'chime', 'alert', 'gentle'];
        if (isset($preferences['notificationSound']) && in_array($preferences['notificationSound'], $allowedSounds)) {
            $validated['notificationSound'] = $preferences['notificationSound'];
        }

        // Notification volume (0-100)
        if (isset($preferences['notificationVolume'])) {
            $volume = intval($preferences['notificationVolume']);
            $validated['notificationVolume'] = max(0, min(100, $volume));
        }

        // ChatMon window mode (whitelist allowed values)
        $allowedChatModes = ['floating', 'docked', 'docked-left', 'docked-right'];
        if (isset($preferences['chatWindowMode']) && in_array($preferences['chatWindowMode'], $allowedChatModes)) {
            $validated['chatWindowMode'] = $preferences['chatWindowMode'];
        }

        // ChatMon window open state
        if (isset($preferences['chatWindowOpen'])) {
            $validated['chatWindowOpen'] = (bool)$preferences['chatWindowOpen'];
        }

        // Load existing and merge
        $existing = loadJsonFile(getPreferencesPath($userId, $characterId));
        $merged = array_merge($existing, $validated);

        saveJsonFile(getPreferencesPath($userId, $characterId), $merged);
        successResponse(['preferences' => $merged]);
        break;

    case 'reset':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $defaults = [
            'fontFamily' => DEFAULT_FONT_FAMILY,
            'fontSize' => DEFAULT_FONT_SIZE,
            'textColor' => DEFAULT_TEXT_COLOR,
            'backgroundColor' => DEFAULT_BACKGROUND_COLOR,
            'echoCommands' => true,
            'scrollOnOutput' => true,
            'keepAlive' => true,
            'keepAliveInterval' => 60
        ];

        saveJsonFile(getPreferencesPath($userId, $characterId), $defaults);
        successResponse(['preferences' => $defaults, 'message' => 'Preferences reset to defaults']);
        break;

    case 'get_mip_conditions':
        $conditionsPath = getMipConditionsPath($userId, $characterId);
        $conditions = loadJsonFile($conditionsPath);

        if (!is_array($conditions)) {
            $conditions = [];
        }

        successResponse(['conditions' => $conditions]);
        break;

    case 'save_mip_conditions':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $conditions = $data['conditions'] ?? [];

        // Validate conditions array
        $validated = [];
        $allowedVariables = ['hp', 'hp_pct', 'hp_max', 'sp', 'sp_pct', 'sp_max', 'gp1', 'gp1_pct', 'gp1_max', 'gp2', 'gp2_pct', 'gp2_max', 'enemy', 'round'];
        $allowedOperators = ['<', '<=', '==', '>=', '>', '!='];
        $allowedLogic = ['AND', 'OR'];

        foreach ($conditions as $condition) {
            if (!is_array($condition)) continue;

            // Validate required fields
            if (!isset($condition['id']) || !isset($condition['variable']) ||
                !isset($condition['operator']) || !isset($condition['value']) ||
                !isset($condition['command'])) {
                continue;
            }

            // Validate variable (allow base variables and guild_ prefixed variables)
            $isBaseVar = in_array($condition['variable'], $allowedVariables);
            $isGuildVar = preg_match('/^guild_[a-z0-9_]+$/', $condition['variable']);
            if (!$isBaseVar && !$isGuildVar) {
                continue;
            }

            // Validate operator
            if (!in_array($condition['operator'], $allowedOperators)) {
                continue;
            }

            // Validate value is numeric
            if (!is_numeric($condition['value'])) {
                continue;
            }

            // Sanitize command (basic sanitization, limit length)
            $command = trim($condition['command']);
            if (strlen($command) > 500 || strlen($command) === 0) {
                continue;
            }

            // Validate sub-conditions if present
            $validatedSubs = [];
            if (isset($condition['subConditions']) && is_array($condition['subConditions'])) {
                foreach ($condition['subConditions'] as $sub) {
                    if (!is_array($sub)) continue;

                    // Validate required sub-condition fields
                    if (!isset($sub['logic']) || !isset($sub['variable']) ||
                        !isset($sub['operator']) || !isset($sub['value'])) {
                        continue;
                    }

                    // Validate logic, variable, operator
                    if (!in_array($sub['logic'], $allowedLogic)) continue;
                    $isBaseVar = in_array($sub['variable'], $allowedVariables);
                    $isGuildVar = preg_match('/^guild_[a-z0-9_]+$/', $sub['variable']);
                    if (!$isBaseVar && !$isGuildVar) continue;
                    if (!in_array($sub['operator'], $allowedOperators)) continue;
                    if (!is_numeric($sub['value'])) continue;

                    $validatedSubs[] = [
                        'logic' => $sub['logic'],
                        'variable' => $sub['variable'],
                        'operator' => $sub['operator'],
                        'value' => floatval($sub['value'])
                    ];
                }
            }

            $validated[] = [
                'id' => $condition['id'],
                'variable' => $condition['variable'],
                'operator' => $condition['operator'],
                'value' => floatval($condition['value']),
                'command' => $command,
                'enabled' => isset($condition['enabled']) ? (bool)$condition['enabled'] : true,
                'subConditions' => $validatedSubs
            ];
        }

        $conditionsPath = getMipConditionsPath($userId, $characterId);
        saveJsonFile($conditionsPath, $validated);
        successResponse(['conditions' => $validated, 'message' => 'MIP conditions saved']);
        break;

    default:
        errorResponse('Invalid action', 400);
}
