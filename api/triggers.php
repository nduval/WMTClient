<?php
/**
 * WMT Client - Triggers API
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
        // DB-first read with JSON safety net for characters whose data was
        // never dual-written (silent FK-fail). See listWithJsonFallback.
        $r = listWithJsonFallback('/admin/triggers', 'triggers', $characterId, getTriggersPath($userId, $characterId));
        successResponse(['triggers' => $r['list'], 'source' => $r['source']]);
        break;

    case 'save':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $triggers = $data['triggers'] ?? [];

        // Validate triggers
        $validatedTriggers = [];
        foreach ($triggers as $trigger) {
            if (empty($trigger['pattern'])) {
                continue;
            }

            $validated = [
                'id' => $trigger['id'] ?? generateId(),
                // NOTE: do NOT call sanitize() on the name. Each save would
                // re-htmlspecialchars the field, accumulating &amp;amp;...
                // every round-trip until the name turns to soup. The UI
                // escapes at display time (escapeHtml in app.js), so storing
                // raw text is safe. Bug observed and fixed 2026-04-28.
                'name' => trim($trigger['name'] ?? ''),
                'pattern' => $trigger['pattern'],
                'matchType' => in_array($trigger['matchType'] ?? '', ['exact', 'contains', 'startsWith', 'endsWith', 'regex', 'tintin'])
                    ? $trigger['matchType']
                    : 'contains',
                'actions' => $trigger['actions'] ?? [],
                'enabled' => $trigger['enabled'] ?? true,
                'priority' => intval($trigger['priority'] ?? 0),
                'class' => $trigger['class'] ?? null
            ];
            $validatedTriggers[] = $validated;
        }

        // Sort by priority
        usort($validatedTriggers, function($a, $b) {
            return $b['priority'] - $a['priority'];
        });

        saveJsonFile(getTriggersPath($userId, $characterId), $validatedTriggers);
        pushBulkToLightsail('/admin/triggers-bulk', 'triggers', $characterId, $validatedTriggers);
        successResponse(['triggers' => $validatedTriggers]);
        break;

    case 'add':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);

        if (empty($data['pattern'])) {
            errorResponse('Pattern is required');
        }

        $triggers = loadJsonFile(getTriggersPath($userId, $characterId));

        // Check storage limits (estimate ~500 bytes per trigger)
        $limitCheck = checkUserStorageLimits($userId, 500, 0);
        if (!$limitCheck['allowed']) {
            errorResponse($limitCheck['error']);
        }

        $trigger = [
            'id' => generateId(),
            'name' => trim($data['name'] ?? ''),
            'pattern' => $data['pattern'],
            'matchType' => in_array($data['matchType'] ?? '', ['exact', 'contains', 'startsWith', 'endsWith', 'regex'])
                ? $data['matchType']
                : 'contains',
            'actions' => $data['actions'] ?? [],
            'enabled' => true,
            'priority' => intval($data['priority'] ?? 0),
            'class' => $data['class'] ?? null
        ];

        $triggers[] = $trigger;
        saveJsonFile(getTriggersPath($userId, $characterId), $triggers);
        pushBulkToLightsail('/admin/triggers-bulk', 'triggers', $characterId, $triggers);

        successResponse(['trigger' => $trigger]);
        break;

    case 'update':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $triggerId = $data['id'] ?? '';

        if (empty($triggerId)) {
            errorResponse('Trigger ID is required');
        }

        $triggers = loadJsonFile(getTriggersPath($userId, $characterId));
        $found = false;

        foreach ($triggers as &$trigger) {
            if ($trigger['id'] === $triggerId) {
                if (isset($data['name'])) $trigger['name'] = trim($data['name']);
                if (isset($data['pattern'])) $trigger['pattern'] = $data['pattern'];
                if (isset($data['matchType'])) $trigger['matchType'] = $data['matchType'];
                if (isset($data['actions'])) $trigger['actions'] = $data['actions'];
                if (isset($data['enabled'])) $trigger['enabled'] = (bool)$data['enabled'];
                if (isset($data['priority'])) $trigger['priority'] = intval($data['priority']);
                if (array_key_exists('class', $data)) $trigger['class'] = $data['class'];
                $found = true;
                break;
            }
        }

        if (!$found) {
            errorResponse('Trigger not found', 404);
        }

        saveJsonFile(getTriggersPath($userId, $characterId), $triggers);
        pushBulkToLightsail('/admin/triggers-bulk', 'triggers', $characterId, $triggers);
        successResponse(['message' => 'Trigger updated']);
        break;

    case 'delete':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $triggerId = $data['id'] ?? '';

        if (empty($triggerId)) {
            errorResponse('Trigger ID is required');
        }

        $triggers = loadJsonFile(getTriggersPath($userId, $characterId));
        $triggers = array_filter($triggers, function($t) use ($triggerId) {
            return $t['id'] !== $triggerId;
        });

        $triggers = array_values($triggers);
        saveJsonFile(getTriggersPath($userId, $characterId), $triggers);
        pushBulkToLightsail('/admin/triggers-bulk', 'triggers', $characterId, $triggers);
        successResponse(['message' => 'Trigger deleted']);
        break;

    default:
        errorResponse('Invalid action', 400);
}
