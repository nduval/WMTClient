<?php
/**
 * WMT Client Classes API
 * Manages script classes (groups of triggers/aliases/gags)
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
$characterPath = getCharacterDataPath($userId, $characterId);
$classesPath = $characterPath . '/classes.json';

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

/**
 * Load classes for current character
 */
function loadClasses($path) {
    return loadJsonFile($path);
}

/**
 * Save classes for current character
 */
function saveClasses($path, $classes) {
    return saveJsonFile($path, $classes);
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
        $classes = loadClasses($classesPath);
        successResponse(['classes' => $classes]);
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

        $classes = loadClasses($classesPath);

        // Check storage limits (estimate ~200 bytes per class)
        $limitCheck = checkUserStorageLimits($userId, 200, 0);
        if (!$limitCheck['allowed']) {
            errorResponse($limitCheck['error']);
        }

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
        saveClasses($classesPath, $classes);

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

        $classes = loadClasses($classesPath);
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

        saveClasses($classesPath, $classes);

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

        $classes = loadClasses($classesPath);
        $found = findClassById($classes, $classId);

        if (!$found) {
            errorResponse('Class not found');
        }

        // Remove class from array
        array_splice($classes, $found['index'], 1);
        saveClasses($classesPath, $classes);

        // Handle items in this class
        if ($deleteItems) {
            // Delete all triggers and aliases in this class
            $triggersPath = $characterPath . '/triggers.json';
            $aliasesPath = $characterPath . '/aliases.json';

            $triggers = loadJsonFile($triggersPath);
            $triggers = array_values(array_filter($triggers, function($t) use ($classId) {
                return ($t['class'] ?? null) !== $classId;
            }));
            saveJsonFile($triggersPath, $triggers);

            $aliases = loadJsonFile($aliasesPath);
            $aliases = array_values(array_filter($aliases, function($a) use ($classId) {
                return ($a['class'] ?? null) !== $classId;
            }));
            saveJsonFile($aliasesPath, $aliases);
        } else {
            // Just remove class reference from items (make them classless)
            $triggersPath = $characterPath . '/triggers.json';
            $aliasesPath = $characterPath . '/aliases.json';

            $triggers = loadJsonFile($triggersPath);
            foreach ($triggers as &$t) {
                if (($t['class'] ?? null) === $classId) {
                    $t['class'] = null;
                }
            }
            saveJsonFile($triggersPath, $triggers);

            $aliases = loadJsonFile($aliasesPath);
            foreach ($aliases as &$a) {
                if (($a['class'] ?? null) === $classId) {
                    $a['class'] = null;
                }
            }
            saveJsonFile($aliasesPath, $aliases);
        }

        successResponse(['message' => 'Class deleted']);
        break;

    case 'toggle':
        // Quick toggle enabled state
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $classId = $data['class_id'] ?? '';

        if (empty($classId)) {
            errorResponse('Class ID is required');
        }

        $classes = loadClasses($classesPath);
        $found = findClassById($classes, $classId);

        if (!$found) {
            errorResponse('Class not found');
        }

        $classes[$found['index']]['enabled'] = !$classes[$found['index']]['enabled'];
        saveClasses($classesPath, $classes);

        successResponse([
            'class' => $classes[$found['index']],
            'enabled' => $classes[$found['index']]['enabled']
        ]);
        break;

    case 'get_items':
        // Get all items in a class
        $classId = $_GET['class_id'] ?? '';

        if (empty($classId)) {
            errorResponse('Class ID is required');
        }

        $triggersPath = $characterPath . '/triggers.json';
        $aliasesPath = $characterPath . '/aliases.json';

        $triggers = loadJsonFile($triggersPath);
        $aliases = loadJsonFile($aliasesPath);

        $classTrigers = array_values(array_filter($triggers, function($t) use ($classId) {
            return ($t['class'] ?? null) === $classId;
        }));

        $classAliases = array_values(array_filter($aliases, function($a) use ($classId) {
            return ($a['class'] ?? null) === $classId;
        }));

        successResponse([
            'triggers' => $classTrigers,
            'aliases' => $classAliases
        ]);
        break;

    default:
        errorResponse('Invalid action', 400);
}
