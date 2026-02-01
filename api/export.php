<?php
/**
 * WMT Client - Export/Import API
 */

require_once __DIR__ . '/../includes/functions.php';
require_once __DIR__ . '/../includes/auth.php';

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

$action = $_GET['action'] ?? '';

switch ($action) {
    case 'export':
        $include = $_GET['include'] ?? 'all';

        $data = [
            'version' => 1,
            'appName' => APP_NAME,
            'exportDate' => date('c'),
            'mudHost' => MUD_HOST,
            'mudPort' => MUD_PORT
        ];

        // Export triggers
        if ($include === 'all' || $include === 'triggers') {
            $data['triggers'] = loadJsonFile(getTriggersPath($userId, $characterId));
        }

        // Export aliases
        if ($include === 'all' || $include === 'aliases') {
            $data['aliases'] = loadJsonFile(getAliasesPath($userId, $characterId));
        }

        // Export preferences
        if ($include === 'all' || $include === 'preferences') {
            $data['preferences'] = loadJsonFile(getPreferencesPath($userId, $characterId));
        }

        // Set headers for file download
        header('Content-Type: application/json');
        header('Content-Disposition: attachment; filename="wmt-client-settings.json"');
        echo json_encode($data, JSON_PRETTY_PRINT);
        exit;

    case 'import':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        // Check for file upload
        if (isset($_FILES['file'])) {
            $file = $_FILES['file'];

            if ($file['error'] !== UPLOAD_ERR_OK) {
                errorResponse('File upload failed');
            }

            $content = file_get_contents($file['tmp_name']);
        } else {
            // JSON body
            $content = file_get_contents('php://input');
        }

        $data = json_decode($content, true);

        if (!$data) {
            errorResponse('Invalid JSON data');
        }

        // Validate it's a WMT Client export
        if (($data['appName'] ?? '') !== APP_NAME && ($data['appName'] ?? '') !== 'WMT Client') {
            errorResponse('Invalid settings file format');
        }

        $mode = $_GET['mode'] ?? 'replace'; // 'replace' or 'merge'
        $imported = [];

        // Import triggers
        if (isset($data['triggers']) && is_array($data['triggers'])) {
            if ($mode === 'merge') {
                $existing = loadJsonFile(getTriggersPath($userId, $characterId));
                $existingPatterns = array_column($existing, 'pattern');

                foreach ($data['triggers'] as $trigger) {
                    if (!in_array($trigger['pattern'], $existingPatterns)) {
                        $trigger['id'] = generateId(); // New ID for imported triggers
                        $existing[] = $trigger;
                    }
                }
                $data['triggers'] = $existing;
            }

            // Ensure all triggers have IDs
            foreach ($data['triggers'] as &$trigger) {
                if (empty($trigger['id'])) {
                    $trigger['id'] = generateId();
                }
            }

            saveJsonFile(getTriggersPath($userId, $characterId), $data['triggers']);
            $imported[] = 'triggers';
        }

        // Import aliases
        if (isset($data['aliases']) && is_array($data['aliases'])) {
            if ($mode === 'merge') {
                $existing = loadJsonFile(getAliasesPath($userId, $characterId));
                $existingPatterns = array_map('strtolower', array_column($existing, 'pattern'));

                foreach ($data['aliases'] as $alias) {
                    if (!in_array(strtolower($alias['pattern']), $existingPatterns)) {
                        $alias['id'] = generateId();
                        $existing[] = $alias;
                    }
                }
                $data['aliases'] = $existing;
            }

            // Ensure all aliases have IDs
            foreach ($data['aliases'] as &$alias) {
                if (empty($alias['id'])) {
                    $alias['id'] = generateId();
                }
            }

            saveJsonFile(getAliasesPath($userId, $characterId), $data['aliases']);
            $imported[] = 'aliases';
        }

        // Import preferences
        if (isset($data['preferences']) && is_array($data['preferences'])) {
            if ($mode === 'merge') {
                $existing = loadJsonFile(getPreferencesPath($userId, $characterId));
                $data['preferences'] = array_merge($existing, $data['preferences']);
            }

            saveJsonFile(getPreferencesPath($userId, $characterId), $data['preferences']);
            $imported[] = 'preferences';
        }

        successResponse([
            'message' => 'Import successful',
            'imported' => $imported,
            'mode' => $mode
        ]);
        break;

    case 'validate':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $content = file_get_contents('php://input');
        $data = json_decode($content, true);

        if (!$data) {
            errorResponse('Invalid JSON data');
        }

        if (($data['appName'] ?? '') !== APP_NAME && ($data['appName'] ?? '') !== 'WMT Client') {
            errorResponse('Invalid settings file format');
        }

        $summary = [
            'valid' => true,
            'version' => $data['version'] ?? 'unknown',
            'exportDate' => $data['exportDate'] ?? 'unknown',
            'triggersCount' => count($data['triggers'] ?? []),
            'aliasesCount' => count($data['aliases'] ?? []),
            'hasPreferences' => isset($data['preferences'])
        ];

        successResponse($summary);
        break;

    default:
        errorResponse('Invalid action', 400);
}
