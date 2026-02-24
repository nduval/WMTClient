<?php
/**
 * WMT Client - Settings Management
 */

require_once __DIR__ . '/functions.php';

/**
 * Get user triggers
 */
function getUserTriggers(string $userId): array {
    return loadJsonFile(getTriggersPath($userId));
}

/**
 * Save user triggers
 */
function saveUserTriggers(string $userId, array $triggers): bool {
    return saveJsonFile(getTriggersPath($userId), $triggers);
}

/**
 * Get user aliases
 */
function getUserAliases(string $userId): array {
    return loadJsonFile(getAliasesPath($userId));
}

/**
 * Save user aliases
 */
function saveUserAliases(string $userId, array $aliases): bool {
    return saveJsonFile(getAliasesPath($userId), $aliases);
}

/**
 * Get user preferences
 */
function getUserPreferences(string $userId): array {
    $defaults = [
        'fontFamily' => DEFAULT_FONT_FAMILY,
        'fontSize' => DEFAULT_FONT_SIZE,
        'textColor' => DEFAULT_TEXT_COLOR,
        'backgroundColor' => DEFAULT_BACKGROUND_COLOR,
        'echoCommands' => true,
        'verbatimMode' => false,
        'scrollOnOutput' => true,
        'keepAlive' => true,
        'keepAliveInterval' => 60
    ];

    $prefs = loadJsonFile(getPreferencesPath($userId));
    return array_merge($defaults, $prefs);
}

/**
 * Save user preferences
 */
function saveUserPreferences(string $userId, array $preferences): bool {
    return saveJsonFile(getPreferencesPath($userId), $preferences);
}

/**
 * Export all user settings
 */
function exportUserSettings(string $userId): array {
    return [
        'version' => 1,
        'appName' => APP_NAME,
        'exportDate' => date('c'),
        'triggers' => getUserTriggers($userId),
        'aliases' => getUserAliases($userId),
        'preferences' => getUserPreferences($userId)
    ];
}

/**
 * Import user settings
 */
function importUserSettings(string $userId, array $data, string $mode = 'replace'): array {
    $imported = [];

    if (isset($data['triggers'])) {
        if ($mode === 'merge') {
            $existing = getUserTriggers($userId);
            $existingPatterns = array_column($existing, 'pattern');
            foreach ($data['triggers'] as $trigger) {
                if (!in_array($trigger['pattern'], $existingPatterns)) {
                    $trigger['id'] = generateId();
                    $existing[] = $trigger;
                }
            }
            $data['triggers'] = $existing;
        }
        saveUserTriggers($userId, $data['triggers']);
        $imported[] = 'triggers';
    }

    if (isset($data['aliases'])) {
        if ($mode === 'merge') {
            $existing = getUserAliases($userId);
            $existingPatterns = array_map('strtolower', array_column($existing, 'pattern'));
            foreach ($data['aliases'] as $alias) {
                if (!in_array(strtolower($alias['pattern']), $existingPatterns)) {
                    $alias['id'] = generateId();
                    $existing[] = $alias;
                }
            }
            $data['aliases'] = $existing;
        }
        saveUserAliases($userId, $data['aliases']);
        $imported[] = 'aliases';
    }

    if (isset($data['preferences'])) {
        if ($mode === 'merge') {
            $existing = getUserPreferences($userId);
            $data['preferences'] = array_merge($existing, $data['preferences']);
        }
        saveUserPreferences($userId, $data['preferences']);
        $imported[] = 'preferences';
    }

    return $imported;
}
