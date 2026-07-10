<?php
/**
 * WMT Client - Aliases API
 *
 * DB-only since 2026-07-10 (JSON dual-store retired — see
 * project_database_migration.md). The browser's WS sync (set_aliases) is the
 * primary save path; `save` here is the HTTP fallback when the WS is down.
 * The old item-level add/update/delete actions were removed: no client code
 * called them, and they loaded JSON as working state and bulk-pushed it over
 * the DB (a stale-clobber vector).
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
        $list = dbList('/admin/aliases', 'aliases', $characterId);
        if ($list === null) {
            errorResponse('Aliases temporarily unavailable', 503);
        }
        successResponse(['aliases' => $list, 'source' => 'db']);
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

            $validated = [
                'id' => $alias['id'] ?? generateId(),
                'pattern' => trim($alias['pattern']),
                'replacement' => $alias['replacement'],
                'matchType' => in_array($alias['matchType'] ?? '', ['exact', 'startsWith', 'regex', 'tintin'])
                    ? $alias['matchType']
                    : 'exact',
                'enabled' => $alias['enabled'] ?? true,
                'class' => $alias['class'] ?? null
            ];
            $validatedAliases[] = $validated;
        }

        // DB is the only store — a failed push must be loud, not silent.
        if (!pushBulkToLightsail('/admin/aliases-bulk', 'aliases', $characterId, $validatedAliases)) {
            errorResponse('Save failed — data server unreachable, nothing was changed', 503);
        }
        successResponse(['aliases' => $validatedAliases]);
        break;

    default:
        errorResponse('Invalid action', 400);
}
