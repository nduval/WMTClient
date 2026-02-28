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

/**
 * List script files recursively, returning relative paths with sizes (for preview)
 */
function listSourceScripts($basePath, $currentPath = '') {
    $scripts = [];
    $fullPath = $currentPath ? $basePath . '/' . $currentPath : $basePath;

    if (!is_dir($fullPath)) return $scripts;

    $entries = scandir($fullPath);
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') continue;

        $entryFullPath = $fullPath . '/' . $entry;
        $relativePath = $currentPath ? $currentPath . '/' . $entry : $entry;

        if (is_dir($entryFullPath)) {
            $scripts = array_merge($scripts, listSourceScripts($basePath, $relativePath));
        } else {
            $ext = strtolower(pathinfo($entry, PATHINFO_EXTENSION));
            if (in_array($ext, ['txt', 'tin'])) {
                $scripts[] = [
                    'name' => $relativePath,
                    'size' => filesize($entryFullPath)
                ];
            }
        }
    }

    return $scripts;
}

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

        // Include classes when exporting triggers or aliases (for cross-user/cross-character import)
        if (isset($data['triggers']) || isset($data['aliases'])) {
            $classesPath = getCharacterDataPath($userId, $characterId) . '/classes.json';
            $classes = loadJsonFile($classesPath);
            if (!empty($classes)) {
                $data['classes'] = $classes;
            }
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

        // Build class ID mapping if import data includes classes
        $classIdMap = [];
        $classesCreated = 0;
        if (isset($data['classes']) && is_array($data['classes']) &&
            (isset($data['triggers']) || isset($data['aliases']))) {

            $importClasses = $data['classes'];
            $importClassMap = [];
            foreach ($importClasses as $ic) {
                $importClassMap[$ic['id']] = $ic;
            }

            $targetClassesPath = getCharacterDataPath($userId, $characterId) . '/classes.json';
            $targetClasses = loadJsonFile($targetClassesPath);

            foreach ($importClasses as $ic) {
                $sourceId = $ic['id'];
                $sourceName = $ic['name'];

                // Check if target already has a class with this name
                $found = null;
                foreach ($targetClasses as $tc) {
                    if (strtolower($tc['name']) === strtolower($sourceName)) {
                        $found = $tc;
                        break;
                    }
                }

                if ($found) {
                    $classIdMap[$sourceId] = $found['id'];
                } else {
                    $newClass = [
                        'id' => generateId(),
                        'name' => $sourceName,
                        'enabled' => $ic['enabled'] ?? true,
                        'created_at' => date('c')
                    ];
                    $targetClasses[] = $newClass;
                    $classIdMap[$sourceId] = $newClass['id'];
                    $classesCreated++;
                }
            }

            if ($classesCreated > 0) {
                saveJsonFile($targetClassesPath, $targetClasses);
                $imported[] = 'classes';
            }
        }

        // Helper to remap a class ID
        // If no classes were in the import data, pass through IDs unchanged
        $hasClassMapping = !empty($classIdMap);
        $remapClass = function($classId) use ($classIdMap, $hasClassMapping) {
            if (empty($classId)) return null;
            if (!$hasClassMapping) return $classId; // No class data in import — keep original IDs
            return $classIdMap[$classId] ?? null;
        };

        // Import triggers
        if (isset($data['triggers']) && is_array($data['triggers'])) {
            if ($mode === 'merge') {
                $existing = loadJsonFile(getTriggersPath($userId, $characterId));
                $existingPatterns = array_column($existing, 'pattern');

                foreach ($data['triggers'] as $trigger) {
                    if (!in_array($trigger['pattern'], $existingPatterns)) {
                        $trigger['id'] = generateId();
                        $trigger['class'] = $remapClass($trigger['class'] ?? null);
                        $existing[] = $trigger;
                    }
                }
                $data['triggers'] = $existing;
            } else {
                // Replace mode: remap classes on all imported items
                foreach ($data['triggers'] as &$trigger) {
                    $trigger['class'] = $remapClass($trigger['class'] ?? null);
                }
                unset($trigger);
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
                        $alias['class'] = $remapClass($alias['class'] ?? null);
                        $existing[] = $alias;
                    }
                }
                $data['aliases'] = $existing;
            } else {
                foreach ($data['aliases'] as &$alias) {
                    $alias['class'] = $remapClass($alias['class'] ?? null);
                }
                unset($alias);
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
            'mode' => $mode,
            'classesCreated' => $classesCreated
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

    case 'preview_source':
        // GET: Returns summary of source character's classes, item counts, and scripts
        $sourceCharId = $_GET['source_id'] ?? '';
        if (empty($sourceCharId)) {
            errorResponse('Source character ID is required');
        }

        // Validate source character belongs to same user
        $sourceChar = getCharacter($userId, $sourceCharId);
        if (!$sourceChar) {
            errorResponse('Source character not found', 404);
        }

        // Load source data
        $sourceClasses = loadJsonFile(getCharacterDataPath($userId, $sourceCharId) . '/classes.json');
        $sourceTriggers = loadJsonFile(getTriggersPath($userId, $sourceCharId));
        $sourceAliases = loadJsonFile(getAliasesPath($userId, $sourceCharId));
        $sourceTickers = loadJsonFile(getTickersPath($userId, $sourceCharId));

        // Count items per class
        $classCounts = []; // classId => [triggers, aliases, tickers]
        $unassigned = ['triggers' => 0, 'aliases' => 0, 'tickers' => 0];

        foreach ($sourceTriggers as $t) {
            $cls = $t['class'] ?? null;
            if (empty($cls)) { $unassigned['triggers']++; }
            else { $classCounts[$cls]['triggers'] = ($classCounts[$cls]['triggers'] ?? 0) + 1; }
        }
        foreach ($sourceAliases as $a) {
            $cls = $a['class'] ?? null;
            if (empty($cls)) { $unassigned['aliases']++; }
            else { $classCounts[$cls]['aliases'] = ($classCounts[$cls]['aliases'] ?? 0) + 1; }
        }
        foreach ($sourceTickers as $t) {
            $cls = $t['class'] ?? null;
            if (empty($cls)) { $unassigned['tickers']++; }
            else { $classCounts[$cls]['tickers'] = ($classCounts[$cls]['tickers'] ?? 0) + 1; }
        }

        // Build classes response
        $classesResult = [];
        foreach ($sourceClasses as $sc) {
            $counts = $classCounts[$sc['id']] ?? [];
            $classesResult[] = [
                'id' => $sc['id'],
                'name' => $sc['name'],
                'enabled' => $sc['enabled'] ?? true,
                'triggers' => $counts['triggers'] ?? 0,
                'aliases' => $counts['aliases'] ?? 0,
                'tickers' => $counts['tickers'] ?? 0
            ];
        }

        // List script files (reuse listScripts pattern from api/scripts.php)
        $sourceScriptsPath = getCharacterDataPath($userId, $sourceCharId) . '/scripts';
        $scriptsResult = [];
        if (is_dir($sourceScriptsPath)) {
            $scriptsResult = listSourceScripts($sourceScriptsPath);
        }

        successResponse([
            'classes' => $classesResult,
            'unassigned' => $unassigned,
            'scripts' => $scriptsResult
        ]);
        break;

    case 'copy_from':
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $input = json_decode(file_get_contents('php://input'), true);
        $sourceCharId = $input['source_character_id'] ?? '';
        $include = $input['include'] ?? ['triggers', 'aliases', 'tickers'];
        $mode = $input['mode'] ?? 'merge';
        $selectedClasses = $input['selected_classes'] ?? null; // null = all
        $includeUnassigned = $input['include_unassigned'] ?? true;
        $selectedScripts = $input['selected_scripts'] ?? [];
        $scriptCollision = $input['script_collision'] ?? 'skip';

        if (empty($sourceCharId)) {
            errorResponse('Source character ID is required');
        }

        // Validate source character belongs to same user
        $sourceChar = getCharacter($userId, $sourceCharId);
        if (!$sourceChar) {
            errorResponse('Source character not found', 404);
        }

        // Can't copy from self
        if ($sourceCharId === $characterId) {
            errorResponse('Cannot copy from the same character');
        }

        // Helper: check if an item should be included based on class filter
        $shouldIncludeItem = function($itemClass) use ($selectedClasses, $includeUnassigned) {
            if ($selectedClasses === null) return true; // no filter = include all
            if (empty($itemClass)) return $includeUnassigned;
            return in_array($itemClass, $selectedClasses);
        };

        // Load source classes
        $sourceClassesPath = getCharacterDataPath($userId, $sourceCharId) . '/classes.json';
        $sourceClasses = loadJsonFile($sourceClassesPath);
        $sourceClassMap = []; // source class ID → source class data
        foreach ($sourceClasses as $sc) {
            $sourceClassMap[$sc['id']] = $sc;
        }

        // Load target classes
        $targetClassesPath = getCharacterDataPath($userId, $characterId) . '/classes.json';
        $targetClasses = loadJsonFile($targetClassesPath);

        // Build class ID mapping: source ID → target ID
        $classIdMap = [];
        $classesCreated = 0;

        // Helper: map a source class ID to a target class ID
        $mapClassId = function($sourceClassId) use ($sourceClassMap, &$targetClasses, &$classIdMap, &$classesCreated) {
            if (empty($sourceClassId)) return null;
            if (isset($classIdMap[$sourceClassId])) return $classIdMap[$sourceClassId];

            // Look up source class name
            if (!isset($sourceClassMap[$sourceClassId])) {
                // Orphaned class reference
                $classIdMap[$sourceClassId] = null;
                return null;
            }

            $sourceName = $sourceClassMap[$sourceClassId]['name'];

            // Check if target already has a class with this name
            $found = null;
            foreach ($targetClasses as $tc) {
                if (strtolower($tc['name']) === strtolower($sourceName)) {
                    $found = $tc;
                    break;
                }
            }

            if ($found) {
                $classIdMap[$sourceClassId] = $found['id'];
            } else {
                // Create new class on target
                $newClass = [
                    'id' => generateId(),
                    'name' => $sourceName,
                    'enabled' => $sourceClassMap[$sourceClassId]['enabled'] ?? true,
                    'created_at' => date('c')
                ];
                $targetClasses[] = $newClass;
                $classIdMap[$sourceClassId] = $newClass['id'];
                $classesCreated++;
            }

            return $classIdMap[$sourceClassId];
        };

        $summary = ['classesCreated' => 0];

        // Copy triggers
        if (in_array('triggers', $include)) {
            $sourceTriggers = loadJsonFile(getTriggersPath($userId, $sourceCharId));
            $targetTriggers = ($mode === 'merge') ? loadJsonFile(getTriggersPath($userId, $characterId)) : [];

            // In replace mode with class filter, keep items NOT in selected classes
            if ($mode === 'replace' && $selectedClasses !== null) {
                $targetTriggers = loadJsonFile(getTriggersPath($userId, $characterId));
                // Remove only items whose class is in selectedClasses (or unassigned if includeUnassigned)
                $targetTriggers = array_values(array_filter($targetTriggers, function($t) use ($shouldIncludeItem) {
                    return !$shouldIncludeItem($t['class'] ?? null);
                }));
            }

            // Build existing patterns set for merge dedup (exact match)
            $existingPatterns = [];
            if ($mode === 'merge') {
                foreach ($targetTriggers as $t) {
                    $existingPatterns[] = $t['pattern'] ?? '';
                }
            }

            $copied = 0;
            foreach ($sourceTriggers as $trigger) {
                // Class filter
                if (!$shouldIncludeItem($trigger['class'] ?? null)) continue;

                if ($mode === 'merge' && in_array($trigger['pattern'] ?? '', $existingPatterns)) {
                    continue;
                }
                // Map class and generate new ID
                $trigger['id'] = generateId();
                $trigger['class'] = $mapClassId($trigger['class'] ?? null);
                $targetTriggers[] = $trigger;
                $copied++;
            }

            saveJsonFile(getTriggersPath($userId, $characterId), $targetTriggers);
            $summary['triggers'] = $copied;
        }

        // Copy aliases
        if (in_array('aliases', $include)) {
            $sourceAliases = loadJsonFile(getAliasesPath($userId, $sourceCharId));
            $targetAliases = ($mode === 'merge') ? loadJsonFile(getAliasesPath($userId, $characterId)) : [];

            // In replace mode with class filter, keep items NOT in selected classes
            if ($mode === 'replace' && $selectedClasses !== null) {
                $targetAliases = loadJsonFile(getAliasesPath($userId, $characterId));
                $targetAliases = array_values(array_filter($targetAliases, function($a) use ($shouldIncludeItem) {
                    return !$shouldIncludeItem($a['class'] ?? null);
                }));
            }

            // Build existing patterns set for merge dedup (case-insensitive)
            $existingPatterns = [];
            if ($mode === 'merge') {
                foreach ($targetAliases as $a) {
                    $existingPatterns[] = strtolower($a['pattern'] ?? '');
                }
            }

            $copied = 0;
            foreach ($sourceAliases as $alias) {
                if (!$shouldIncludeItem($alias['class'] ?? null)) continue;

                if ($mode === 'merge' && in_array(strtolower($alias['pattern'] ?? ''), $existingPatterns)) {
                    continue;
                }
                $alias['id'] = generateId();
                $alias['class'] = $mapClassId($alias['class'] ?? null);
                $targetAliases[] = $alias;
                $copied++;
            }

            saveJsonFile(getAliasesPath($userId, $characterId), $targetAliases);
            $summary['aliases'] = $copied;
        }

        // Copy tickers
        if (in_array('tickers', $include)) {
            $sourceTickers = loadJsonFile(getTickersPath($userId, $sourceCharId));
            $targetTickers = ($mode === 'merge') ? loadJsonFile(getTickersPath($userId, $characterId)) : [];

            // In replace mode with class filter, keep items NOT in selected classes
            if ($mode === 'replace' && $selectedClasses !== null) {
                $targetTickers = loadJsonFile(getTickersPath($userId, $characterId));
                $targetTickers = array_values(array_filter($targetTickers, function($t) use ($shouldIncludeItem) {
                    return !$shouldIncludeItem($t['class'] ?? null);
                }));
            }

            // Build existing names set for merge dedup (case-insensitive)
            $existingNames = [];
            if ($mode === 'merge') {
                foreach ($targetTickers as $t) {
                    $existingNames[] = strtolower($t['name'] ?? '');
                }
            }

            $copied = 0;
            foreach ($sourceTickers as $ticker) {
                if (!$shouldIncludeItem($ticker['class'] ?? null)) continue;

                if ($mode === 'merge' && in_array(strtolower($ticker['name'] ?? ''), $existingNames)) {
                    continue;
                }
                $ticker['id'] = generateId();
                $ticker['class'] = $mapClassId($ticker['class'] ?? null);
                $targetTickers[] = $ticker;
                $copied++;
            }

            saveJsonFile(getTickersPath($userId, $characterId), $targetTickers);
            $summary['tickers'] = $copied;
        }

        // Save target classes if any were created
        if ($classesCreated > 0) {
            saveJsonFile($targetClassesPath, $targetClasses);
        }
        $summary['classesCreated'] = $classesCreated;

        // Copy scripts
        $scriptsCopied = 0;
        $scriptsSkipped = 0;
        if (!empty($selectedScripts) && is_array($selectedScripts)) {
            $sourceScriptsPath = getCharacterDataPath($userId, $sourceCharId) . '/scripts';
            $targetScriptsPath = getCharacterDataPath($userId, $characterId) . '/scripts';

            if (!is_dir($targetScriptsPath)) {
                mkdir($targetScriptsPath, 0755, true);
            }

            foreach ($selectedScripts as $scriptPath) {
                // Sanitize: block traversal
                $scriptPath = str_replace('\\', '/', $scriptPath);
                $scriptPath = trim($scriptPath, '/');
                if (strpos($scriptPath, '..') !== false || strpos($scriptPath, '//') !== false) {
                    $scriptsSkipped++;
                    continue;
                }

                $srcFile = $sourceScriptsPath . '/' . $scriptPath;
                $dstFile = $targetScriptsPath . '/' . $scriptPath;

                // Validate source exists and is within scripts dir
                if (!file_exists($srcFile) || !is_file($srcFile)) {
                    $scriptsSkipped++;
                    continue;
                }
                $realSrc = realpath($srcFile);
                $realSrcBase = realpath($sourceScriptsPath);
                if ($realSrc === false || $realSrcBase === false || strpos($realSrc, $realSrcBase) !== 0) {
                    $scriptsSkipped++;
                    continue;
                }

                // Handle collision
                if (file_exists($dstFile)) {
                    if ($scriptCollision === 'skip') {
                        $scriptsSkipped++;
                        continue;
                    } elseif ($scriptCollision === 'rename') {
                        // Append -copy before extension
                        $ext = pathinfo($scriptPath, PATHINFO_EXTENSION);
                        $base = substr($scriptPath, 0, -(strlen($ext) + 1));
                        $n = 1;
                        do {
                            $suffix = $n === 1 ? '-copy' : "-copy{$n}";
                            $dstFile = $targetScriptsPath . '/' . $base . $suffix . '.' . $ext;
                            $n++;
                        } while (file_exists($dstFile));
                    }
                    // 'overwrite' falls through — just write
                }

                // Check storage limits
                $existingSize = file_exists($dstFile) ? filesize($dstFile) : 0;
                $newSize = filesize($srcFile);
                $isNewFile = !file_exists($dstFile);
                $limitCheck = checkUserStorageLimits($userId, $newSize - $existingSize, $isNewFile ? 1 : 0);
                if (!$limitCheck['allowed']) {
                    $scriptsSkipped++;
                    continue;
                }

                // Create parent directories
                $parentDir = dirname($dstFile);
                if (!is_dir($parentDir)) {
                    mkdir($parentDir, 0755, true);
                }

                // Validate destination is within target scripts dir
                $realDstBase = realpath($targetScriptsPath);
                $realParent = realpath($parentDir);
                if ($realDstBase === false || $realParent === false || strpos($realParent, $realDstBase) !== 0) {
                    $scriptsSkipped++;
                    continue;
                }

                if (copy($srcFile, $dstFile)) {
                    $scriptsCopied++;
                } else {
                    $scriptsSkipped++;
                }
            }

            $summary['scriptsCopied'] = $scriptsCopied;
            $summary['scriptsSkipped'] = $scriptsSkipped;
        }

        successResponse([
            'message' => 'Copy successful',
            'summary' => $summary,
            'mode' => $mode
        ]);
        break;

    default:
        errorResponse('Invalid action', 400);
}
