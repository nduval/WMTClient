<?php
/**
 * WMT Client - Custom Bots API
 * CRUD for user-created bot definitions (per character)
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
    case 'list':
        $bots = loadJsonFile(getBotsPath($userId, $characterId));
        successResponse(['bots' => $bots]);
        break;

    case 'areas':
        // Serve pre-built area definitions
        $areasPath = __DIR__ . '/../data/bot_areas.json';
        $areas = loadJsonFile($areasPath);
        successResponse(['areas' => $areas]);
        break;

    case 'save':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $botDef = $data['bot'] ?? null;

        if (!$botDef || empty($botDef['name']) || empty($botDef['path'])) {
            errorResponse('Bot name and path are required');
        }

        $bots = loadJsonFile(getBotsPath($userId, $characterId));

        // Check storage limits
        $limitCheck = checkUserStorageLimits($userId, 1000, 0);
        if (!$limitCheck['allowed']) {
            errorResponse($limitCheck['error']);
        }

        // Validate and sanitize
        $validated = [
            'id' => $botDef['id'] ?? generateId(),
            'name' => substr(trim($botDef['name']), 0, 100),
            'path' => $botDef['path'],
            'mobs' => [],
            'loop' => !empty($botDef['loop']),
            'playerCheck' => $botDef['playerCheck'] ?? true,
            'defaultDelay' => max(0, min(10, floatval($botDef['defaultDelay'] ?? 0.5))),
            'created_at' => date('c')
        ];

        // Validate mobs array
        if (!empty($botDef['mobs']) && is_array($botDef['mobs'])) {
            foreach ($botDef['mobs'] as $mob) {
                if (!empty($mob['pattern'])) {
                    $validated['mobs'][] = [
                        'pattern' => substr(trim($mob['pattern']), 0, 200),
                        'target' => substr(trim($mob['target'] ?? $mob['pattern']), 0, 100)
                    ];
                }
            }
        }

        // Check for existing bot with same name — update it
        $found = false;
        foreach ($bots as &$existing) {
            if ($existing['name'] === $validated['name']) {
                $validated['id'] = $existing['id'];
                $existing = $validated;
                $found = true;
                break;
            }
        }
        unset($existing);

        if (!$found) {
            $bots[] = $validated;
        }

        saveJsonFile(getBotsPath($userId, $characterId), $bots);
        successResponse(['bot' => $validated]);
        break;

    case 'delete':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $botId = $data['id'] ?? '';

        if (empty($botId)) {
            errorResponse('Bot ID is required');
        }

        $bots = loadJsonFile(getBotsPath($userId, $characterId));
        $bots = array_filter($bots, function($b) use ($botId) {
            return ($b['id'] ?? '') !== $botId;
        });

        saveJsonFile(getBotsPath($userId, $characterId), array_values($bots));
        successResponse(['message' => 'Bot deleted']);
        break;

    default:
        errorResponse('Invalid action', 400);
}
