<?php
/**
 * WMT Client - Debug API
 *
 * Admin-key authenticated endpoint for inspecting user state.
 * Used for debugging script imports, triggers, variables, etc.
 */

require_once __DIR__ . '/../includes/functions.php';
require_once __DIR__ . '/../includes/auth.php';

// Admin key authentication
$adminKey = $_SERVER['HTTP_X_ADMIN_KEY'] ?? '';

require_once __DIR__ . '/../config/config.php';
$configAdminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;

if (!$configAdminKey) {
    errorResponse('Admin key not configured', 500);
}

if ($adminKey !== $configAdminKey) {
    errorResponse('Invalid admin key', 403);
}

$action = $_GET['action'] ?? '';
$username = $_GET['username'] ?? '';
$characterName = $_GET['character'] ?? '';

if (empty($username)) {
    errorResponse('username parameter required', 400);
}

// Look up user
$user = findUserByUsername($username);
if (!$user) {
    errorResponse('User not found', 404);
}

$userId = $user['id'];

// Find character if specified
$characterId = null;
if (!empty($characterName)) {
    $characters = getCharacters($userId);
    foreach ($characters as $char) {
        if (strtolower($char['name']) === strtolower($characterName)) {
            $characterId = $char['id'];
            break;
        }
    }
    if (!$characterId) {
        errorResponse('Character not found: ' . $characterName, 404);
    }
}

switch ($action) {
    case 'state':
        // Return full character state: triggers, aliases, tickers, preferences, scripts
        if (!$characterId) {
            errorResponse('character parameter required for state action', 400);
        }

        $triggers = loadJsonFile(getTriggersPath($userId, $characterId));
        $aliases = loadJsonFile(getAliasesPath($userId, $characterId));
        $tickers = loadJsonFile(getTickersPath($userId, $characterId));
        $preferences = loadJsonFile(getPreferencesPath($userId, $characterId));

        // List script files
        $scriptsPath = getCharacterDataPath($userId, $characterId) . '/scripts';
        $scripts = [];
        if (is_dir($scriptsPath)) {
            foreach (scandir($scriptsPath) as $file) {
                if ($file === '.' || $file === '..') continue;
                $scripts[] = [
                    'name' => $file,
                    'size' => filesize($scriptsPath . '/' . $file)
                ];
            }
        }

        successResponse([
            'userId' => $userId,
            'characterId' => $characterId,
            'triggers' => $triggers,
            'triggerCount' => count($triggers),
            'aliases' => $aliases,
            'aliasCount' => count($aliases),
            'tickers' => $tickers,
            'tickerCount' => count($tickers),
            'preferences' => $preferences,
            'scripts' => $scripts
        ]);
        break;

    case 'triggers':
        // Return just triggers with detail
        if (!$characterId) {
            errorResponse('character parameter required', 400);
        }

        $triggers = loadJsonFile(getTriggersPath($userId, $characterId));

        // Summarize triggers by type
        $summary = ['command' => 0, 'gag' => 0, 'highlight' => 0, 'substitute' => 0, 'sound' => 0, 'other' => 0];
        foreach ($triggers as $t) {
            $types = array_map(function($a) { return $a['type'] ?? 'other'; }, $t['actions'] ?? []);
            foreach ($types as $type) {
                if (isset($summary[$type])) $summary[$type]++;
                else $summary['other']++;
            }
        }

        successResponse([
            'triggers' => $triggers,
            'count' => count($triggers),
            'summary' => $summary
        ]);
        break;

    case 'script':
        // Return content of a specific script file
        if (!$characterId) {
            errorResponse('character parameter required', 400);
        }

        $filename = $_GET['filename'] ?? '';
        if (empty($filename)) {
            errorResponse('filename parameter required', 400);
        }

        $scriptsPath = getCharacterDataPath($userId, $characterId) . '/scripts';
        $ext = pathinfo($filename, PATHINFO_EXTENSION);
        if (!in_array(strtolower($ext), ['txt', 'tin'])) {
            errorResponse('Invalid file extension', 400);
        }

        $filePath = $scriptsPath . '/' . basename($filename);
        if (!file_exists($filePath)) {
            errorResponse('Script not found: ' . $filename, 404);
        }

        successResponse([
            'filename' => $filename,
            'content' => file_get_contents($filePath),
            'size' => filesize($filePath)
        ]);
        break;

    case 'characters':
        // List characters for this user
        $characters = getCharacters($userId);
        successResponse(['characters' => $characters]);
        break;

    default:
        errorResponse('Invalid action. Use: state, triggers, script, characters', 400);
}
