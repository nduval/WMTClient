<?php
/**
 * WMT Client - Tickers API
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
        $tickers = loadJsonFile(getTickersPath($userId, $characterId));
        successResponse(['tickers' => $tickers]);
        break;

    case 'save':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $tickers = $data['tickers'] ?? [];

        // Validate tickers
        $validatedTickers = [];
        foreach ($tickers as $ticker) {
            if (empty($ticker['command'])) {
                continue;
            }

            $validatedTickers[] = [
                'id' => $ticker['id'] ?? generateId(),
                'name' => sanitize($ticker['name'] ?? ''),
                'command' => $ticker['command'],
                'interval' => max(1, intval($ticker['interval'] ?? 60)),
                'enabled' => $ticker['enabled'] ?? true,
                'class' => $ticker['class'] ?? null
            ];
        }

        saveJsonFile(getTickersPath($userId, $characterId), $validatedTickers);
        successResponse(['tickers' => $validatedTickers]);
        break;

    case 'add':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);

        if (empty($data['command'])) {
            errorResponse('Command is required');
        }

        $tickers = loadJsonFile(getTickersPath($userId, $characterId));

        // Check storage limits
        $limitCheck = checkUserStorageLimits($userId, 300, 0);
        if (!$limitCheck['allowed']) {
            errorResponse($limitCheck['error']);
        }

        $ticker = [
            'id' => generateId(),
            'name' => sanitize($data['name'] ?? ''),
            'command' => $data['command'],
            'interval' => max(1, intval($data['interval'] ?? 60)),
            'enabled' => true,
            'class' => $data['class'] ?? null
        ];

        $tickers[] = $ticker;
        saveJsonFile(getTickersPath($userId, $characterId), $tickers);

        successResponse(['ticker' => $ticker]);
        break;

    case 'update':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $tickerId = $data['id'] ?? '';

        if (empty($tickerId)) {
            errorResponse('Ticker ID is required');
        }

        $tickers = loadJsonFile(getTickersPath($userId, $characterId));
        $found = false;

        foreach ($tickers as &$ticker) {
            if ($ticker['id'] === $tickerId) {
                if (isset($data['name'])) $ticker['name'] = sanitize($data['name']);
                if (isset($data['command'])) $ticker['command'] = $data['command'];
                if (isset($data['interval'])) $ticker['interval'] = max(1, intval($data['interval']));
                if (isset($data['enabled'])) $ticker['enabled'] = (bool)$data['enabled'];
                if (array_key_exists('class', $data)) $ticker['class'] = $data['class'];
                $found = true;
                break;
            }
        }

        if (!$found) {
            errorResponse('Ticker not found', 404);
        }

        saveJsonFile(getTickersPath($userId, $characterId), $tickers);
        successResponse(['message' => 'Ticker updated']);
        break;

    case 'delete':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $tickerId = $data['id'] ?? '';

        if (empty($tickerId)) {
            errorResponse('Ticker ID is required');
        }

        $tickers = loadJsonFile(getTickersPath($userId, $characterId));
        $tickers = array_filter($tickers, function($t) use ($tickerId) {
            return $t['id'] !== $tickerId;
        });

        saveJsonFile(getTickersPath($userId, $characterId), array_values($tickers));
        successResponse(['message' => 'Ticker deleted']);
        break;

    default:
        errorResponse('Invalid action', 400);
}
