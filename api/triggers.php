<?php
/**
 * WMT Client - Triggers API
 *
 * DB-only since 2026-07-10 (JSON dual-store retired — see
 * project_database_migration.md). The browser's WS sync (set_triggers) is the
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
        $list = dbList('/admin/triggers', 'triggers', $characterId);
        if ($list === null) {
            errorResponse('Triggers temporarily unavailable', 503);
        }
        successResponse(['triggers' => $list, 'source' => 'db']);
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
                'class' => $trigger['class'] ?? null,
                // Block-trigger fields ("capture following lines"). Must round-trip
                // or an HTTP-fallback save turns a block trigger back into a
                // per-line one (triggers-bulk writes NULL when absent).
                'blockStart' => (isset($trigger['blockStart']) && is_string($trigger['blockStart']) && $trigger['blockStart'] !== '') ? $trigger['blockStart'] : null,
                'blockEnd' => (isset($trigger['blockEnd']) && is_string($trigger['blockEnd']) && $trigger['blockEnd'] !== '') ? $trigger['blockEnd'] : null,
                'oneshot' => !empty($trigger['oneshot'])
            ];
            $validatedTriggers[] = $validated;
        }

        // Sort by priority
        usort($validatedTriggers, function($a, $b) {
            return $b['priority'] - $a['priority'];
        });

        $t1 = microtime(true);
        $pushOk = pushBulkToLightsail('/admin/triggers-bulk', 'triggers', $characterId, $validatedTriggers);
        $ms = round((microtime(true) - $t1) * 1000);
        $logFile = __DIR__ . '/../data/logs/auth.log';
        $ts = date('Y-m-d H:i:s');
        @file_put_contents($logFile, "[$ts] triggers save: push=" . ($pushOk ? 'OK' : 'FAIL') . " ms=$ms count=" . count($validatedTriggers) . " cid=$characterId\n", FILE_APPEND | LOCK_EX);
        if (!$pushOk) {
            errorResponse('Save failed — data server unreachable, nothing was changed', 503);
        }
        successResponse(['triggers' => $validatedTriggers]);
        break;

    default:
        errorResponse('Invalid action', 400);
}
