<?php
/**
 * WMT Client Classes API
 * Manages script classes (groups of triggers/aliases/gags)
 *
 * DB-only since 2026-07-10 (JSON dual-store retired — see
 * project_database_migration.md). Every mutation reads the CURRENT list from
 * the Lightsail DB, mutates, and pushes back. The old flow loaded JSON as
 * working state and pushed it over the DB — if JSON had drifted (e.g. items
 * authored in-game via WS), a class rename or delete replaced good DB rows
 * with stale data. The unused toggle/get_items actions were removed.
 */

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/functions.php';

initSession();
requireAuth();

// Block guest write operations
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    denyGuest();
}

requireCharacter();

header('Content-Type: application/json');

$userId = getCurrentUserId();
$characterId = getCurrentCharacterId();

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

/**
 * Load classes for the current character from the DB. 503s (and exits) if
 * the DB is unreachable — mutating against an unknown current state is how
 * data gets clobbered.
 */
function loadClassesDb(string $characterId): array {
    $list = dbList('/admin/classes', 'classes', $characterId);
    if ($list === null) {
        errorResponse('Classes temporarily unavailable', 503);
    }
    return $list;
}

/**
 * Push the full class list to the DB (the only store). Loud on failure.
 */
function saveClassesDb(string $characterId, array $classes): void {
    if (!pushBulkToLightsail('/admin/classes-bulk', 'classes', $characterId, $classes)) {
        errorResponse('Save failed — data server unreachable, nothing was changed', 503);
    }
}

/**
 * Find class by ID
 */
function findClassById($classes, $id) {
    foreach ($classes as $index => $class) {
        if ($class['id'] === $id) {
            return ['index' => $index, 'class' => $class];
        }
    }
    return null;
}

/**
 * Find class by name (case-insensitive)
 */
function findClassByName($classes, $name) {
    $nameLower = strtolower($name);
    foreach ($classes as $index => $class) {
        if (strtolower($class['name']) === $nameLower) {
            return ['index' => $index, 'class' => $class];
        }
    }
    return null;
}

switch ($action) {
    case 'list':
        successResponse(['classes' => loadClassesDb($characterId), 'source' => 'db']);
        break;

    case 'create':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $name = trim($data['name'] ?? '');

        if (empty($name)) {
            errorResponse('Class name is required');
        }

        if (strlen($name) > 50) {
            errorResponse('Class name must be 50 characters or less');
        }

        $classes = loadClassesDb($characterId);

        // Check if class with same name exists
        if (findClassByName($classes, $name)) {
            errorResponse('A class with this name already exists');
        }

        $newClass = [
            'id' => generateId(),
            'name' => $name,
            'enabled' => true,
            'created_at' => date('c')
        ];

        $classes[] = $newClass;
        saveClassesDb($characterId, $classes);

        successResponse(['class' => $newClass]);
        break;

    case 'update':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $classId = $data['class_id'] ?? '';
        $name = isset($data['name']) ? trim($data['name']) : null;
        $enabled = $data['enabled'] ?? null;

        if (empty($classId)) {
            errorResponse('Class ID is required');
        }

        $classes = loadClassesDb($characterId);
        $found = findClassById($classes, $classId);

        if (!$found) {
            errorResponse('Class not found');
        }

        if ($name !== null) {
            if (empty($name)) {
                errorResponse('Class name cannot be empty');
            }
            if (strlen($name) > 50) {
                errorResponse('Class name must be 50 characters or less');
            }
            // Check for duplicate name (excluding current class)
            $existing = findClassByName($classes, $name);
            if ($existing && $existing['class']['id'] !== $classId) {
                errorResponse('A class with this name already exists');
            }
            $classes[$found['index']]['name'] = $name;
        }

        if ($enabled !== null) {
            $classes[$found['index']]['enabled'] = (bool)$enabled;
        }

        saveClassesDb($characterId, $classes);

        successResponse(['class' => $classes[$found['index']]]);
        break;

    case 'delete':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $classId = $data['class_id'] ?? '';
        $deleteItems = $data['delete_items'] ?? false;

        if (empty($classId)) {
            errorResponse('Class ID is required');
        }

        $classes = loadClassesDb($characterId);
        $found = findClassById($classes, $classId);

        if (!$found) {
            errorResponse('Class not found');
        }

        // Read ALL current item lists from the DB BEFORE mutating anything —
        // if any read fails we abort with 503 and nothing has changed.
        $triggers = dbList('/admin/triggers', 'triggers', $characterId);
        $aliases  = dbList('/admin/aliases',  'aliases',  $characterId);
        $tickers  = dbList('/admin/tickers',  'tickers',  $characterId);
        if ($triggers === null || $aliases === null || $tickers === null) {
            errorResponse('Class delete aborted — data server unreachable, nothing was changed', 503);
        }

        // Remove class from array
        array_splice($classes, $found['index'], 1);

        if ($deleteItems) {
            // Delete all triggers, aliases, and tickers in this class
            $triggers = array_values(array_filter($triggers, function($t) use ($classId) {
                return ($t['class'] ?? null) !== $classId;
            }));
            $aliases = array_values(array_filter($aliases, function($a) use ($classId) {
                return ($a['class'] ?? null) !== $classId;
            }));
            $tickers = array_values(array_filter($tickers, function($t) use ($classId) {
                return ($t['class'] ?? null) !== $classId;
            }));
        } else {
            // Just remove class reference from items (make them classless)
            foreach ($triggers as &$t) {
                if (($t['class'] ?? null) === $classId) $t['class'] = null;
            }
            unset($t);
            foreach ($aliases as &$a) {
                if (($a['class'] ?? null) === $classId) $a['class'] = null;
            }
            unset($a);
            foreach ($tickers as &$t) {
                if (($t['class'] ?? null) === $classId) $t['class'] = null;
            }
            unset($t);
        }

        // Push the class list first, then cascade the item lists. Without the
        // cascade, deleting a class would leave orphan rows (delete_items=true)
        // or items referencing a dead class_id (delete_items=false).
        saveClassesDb($characterId, $classes);
        $ok = pushBulkToLightsail('/admin/triggers-bulk', 'triggers', $characterId, $triggers)
            & pushBulkToLightsail('/admin/aliases-bulk',  'aliases',  $characterId, $aliases)
            & pushBulkToLightsail('/admin/tickers-bulk',  'tickers',  $characterId, $tickers);
        if (!$ok) {
            errorResponse('Class deleted but item cleanup partially failed — refresh and retry', 500);
        }

        successResponse(['message' => 'Class deleted']);
        break;

    default:
        errorResponse('Invalid action', 400);
}
