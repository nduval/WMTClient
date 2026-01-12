<?php
/**
 * WMT Client - Aliases API
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
    case 'list':
        $aliases = loadJsonFile(getAliasesPath($userId, $characterId));
        successResponse(['aliases' => $aliases]);
        break;

    case 'save':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $aliases = $data['aliases'] ?? [];

        // Validate aliases
        $validatedAliases = [];
        foreach ($aliases as $alias) {
            if (empty($alias['pattern']) || empty($alias['replacement'])) {
                continue;
            }

            $validatedAliases[] = [
                'id' => $alias['id'] ?? generateId(),
                'pattern' => trim($alias['pattern']),
                'replacement' => $alias['replacement'],
                'matchType' => in_array($alias['matchType'] ?? '', ['exact', 'startsWith', 'regex'])
                    ? $alias['matchType']
                    : 'exact',
                'enabled' => $alias['enabled'] ?? true,
                'class' => $alias['class'] ?? null
            ];
        }

        saveJsonFile(getAliasesPath($userId, $characterId), $validatedAliases);
        successResponse(['aliases' => $validatedAliases]);
        break;

    case 'add':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);

        if (empty($data['pattern']) || empty($data['replacement'])) {
            errorResponse('Pattern and replacement are required');
        }

        $aliases = loadJsonFile(getAliasesPath($userId, $characterId));

        // Check storage limits (estimate ~300 bytes per alias)
        $limitCheck = checkUserStorageLimits($userId, 300, 0);
        if (!$limitCheck['allowed']) {
            errorResponse($limitCheck['error']);
        }

        // Check for duplicate pattern
        $pattern = trim($data['pattern']);
        foreach ($aliases as $existing) {
            if (strtolower($existing['pattern']) === strtolower($pattern)) {
                errorResponse('An alias with this pattern already exists');
            }
        }

        $alias = [
            'id' => generateId(),
            'pattern' => $pattern,
            'replacement' => $data['replacement'],
            'matchType' => in_array($data['matchType'] ?? '', ['exact', 'startsWith', 'regex'])
                ? $data['matchType']
                : 'exact',
            'enabled' => true,
            'class' => $data['class'] ?? null
        ];

        $aliases[] = $alias;
        saveJsonFile(getAliasesPath($userId, $characterId), $aliases);

        successResponse(['alias' => $alias]);
        break;

    case 'update':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $aliasId = $data['id'] ?? '';

        if (empty($aliasId)) {
            errorResponse('Alias ID is required');
        }

        $aliases = loadJsonFile(getAliasesPath($userId, $characterId));
        $found = false;

        foreach ($aliases as &$alias) {
            if ($alias['id'] === $aliasId) {
                if (isset($data['pattern'])) $alias['pattern'] = trim($data['pattern']);
                if (isset($data['replacement'])) $alias['replacement'] = $data['replacement'];
                if (isset($data['matchType'])) $alias['matchType'] = $data['matchType'];
                if (isset($data['enabled'])) $alias['enabled'] = (bool)$data['enabled'];
                if (array_key_exists('class', $data)) $alias['class'] = $data['class'];
                $found = true;
                break;
            }
        }

        if (!$found) {
            errorResponse('Alias not found', 404);
        }

        saveJsonFile(getAliasesPath($userId, $characterId), $aliases);
        successResponse(['message' => 'Alias updated']);
        break;

    case 'delete':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $aliasId = $data['id'] ?? '';

        if (empty($aliasId)) {
            errorResponse('Alias ID is required');
        }

        $aliases = loadJsonFile(getAliasesPath($userId, $characterId));
        $aliases = array_filter($aliases, function($a) use ($aliasId) {
            return $a['id'] !== $aliasId;
        });

        saveJsonFile(getAliasesPath($userId, $characterId), array_values($aliases));
        successResponse(['message' => 'Alias deleted']);
        break;

    default:
        errorResponse('Invalid action', 400);
}
