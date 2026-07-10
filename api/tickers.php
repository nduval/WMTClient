<?php
/**
 * WMT Client - Tickers API
 *
 * DB-only since 2026-07-10 (JSON dual-store retired — see
 * project_database_migration.md). The browser's WS sync (set_tickers) is the
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
        $list = dbList('/admin/tickers', 'tickers', $characterId);
        if ($list === null) {
            errorResponse('Tickers temporarily unavailable', 503);
        }
        successResponse(['tickers' => $list, 'source' => 'db']);
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

            $validated = [
                'id' => $ticker['id'] ?? generateId(),
                'name' => sanitize($ticker['name'] ?? ''),
                'command' => $ticker['command'],
                'interval' => max(1, intval($ticker['interval'] ?? 60)),
                'enabled' => $ticker['enabled'] ?? true,
                'class' => $ticker['class'] ?? null
            ];
            $validatedTickers[] = $validated;
        }

        // DB is the only store — a failed push must be loud, not silent.
        if (!pushBulkToLightsail('/admin/tickers-bulk', 'tickers', $characterId, $validatedTickers)) {
            errorResponse('Save failed — data server unreachable, nothing was changed', 503);
        }
        successResponse(['tickers' => $validatedTickers]);
        break;

    default:
        errorResponse('Invalid action', 400);
}
