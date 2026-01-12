<?php
/**
 * WMT Client - Preferences API
 */

require_once __DIR__ . '/../includes/functions.php';
require_once __DIR__ . '/../includes/auth.php';

initSession();
requireAuth();

$userId = getCurrentUserId();
$characterId = getCurrentCharacterId();

if (!$characterId) {
    errorResponse('No character selected', 400);
}

$action = $_GET['action'] ?? '';

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

        // Font size (10-24)
        if (isset($preferences['fontSize'])) {
            $fontSize = intval($preferences['fontSize']);
            $validated['fontSize'] = max(10, min(24, $fontSize));
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

        // Keep alive interval (30-300 seconds)
        if (isset($preferences['keepAliveInterval'])) {
            $interval = intval($preferences['keepAliveInterval']);
            $validated['keepAliveInterval'] = max(30, min(300, $interval));
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

            // Validate variable
            if (!in_array($condition['variable'], $allowedVariables)) {
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
                    if (!in_array($sub['variable'], $allowedVariables)) continue;
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
