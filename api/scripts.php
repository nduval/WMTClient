<?php
/**
 * WMT Client Scripts API
 * Manages TinTin++ style script files (.txt, .tin) with folder support
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
$scriptsPath = $characterPath . '/scripts';

// Ensure scripts directory exists
if (!is_dir($scriptsPath)) {
    mkdir($scriptsPath, 0755, true);
}

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

// Size limit: 256KB
const MAX_SCRIPT_SIZE = 262144;

// Allowed extensions
const ALLOWED_EXTENSIONS = ['txt', 'tin'];

// Max folder depth
const MAX_FOLDER_DEPTH = 3;

/**
 * Sanitize a path that may include subdirectories.
 * Returns the sanitized path WITHOUT extension, or false if invalid.
 * Allows: alphanumeric, dash, underscore, forward slash (for folders)
 * Blocks: .., leading /, trailing /, double //, and any other special chars
 */
function sanitizePath($name) {
    // Remove extension if present
    $name = preg_replace('/\.(txt|tin)$/i', '', $name);

    // Normalize backslashes to forward slashes
    $name = str_replace('\\', '/', $name);

    // Strip leading/trailing slashes
    $name = trim($name, '/');

    // Block path traversal
    if (strpos($name, '..') !== false) {
        return false;
    }

    // Block double slashes
    if (strpos($name, '//') !== false) {
        return false;
    }

    // Only allow safe characters (alphanumeric, dash, underscore, forward slash)
    if (!preg_match('/^[a-zA-Z0-9_\-\/]+$/', $name)) {
        return false;
    }

    // Check folder depth
    $parts = explode('/', $name);
    if (count($parts) > MAX_FOLDER_DEPTH + 1) { // +1 for the filename itself
        return false;
    }

    // Each path segment must be non-empty and max 50 chars
    foreach ($parts as $part) {
        if (empty($part) || strlen($part) > 50) {
            return false;
        }
    }

    return $name;
}

/**
 * Sanitize a folder path (no filename).
 * Returns sanitized path or false if invalid.
 */
function sanitizeFolderPath($path) {
    // Normalize backslashes
    $path = str_replace('\\', '/', $path);

    // Strip leading/trailing slashes
    $path = trim($path, '/');

    if (empty($path)) {
        return false;
    }

    // Block path traversal
    if (strpos($path, '..') !== false) {
        return false;
    }

    // Block double slashes
    if (strpos($path, '//') !== false) {
        return false;
    }

    // Only allow safe characters
    if (!preg_match('/^[a-zA-Z0-9_\-\/]+$/', $path)) {
        return false;
    }

    // Check depth
    $parts = explode('/', $path);
    if (count($parts) > MAX_FOLDER_DEPTH) {
        return false;
    }

    foreach ($parts as $part) {
        if (empty($part) || strlen($part) > 50) {
            return false;
        }
    }

    return $path;
}

/**
 * Validate that a resolved path is within the scripts directory.
 * Must be called AFTER the file/dir exists (realpath needs existing path).
 * For new files, validate the parent directory instead.
 */
function validatePathWithin($fullPath, $scriptsPath) {
    $realScripts = realpath($scriptsPath);
    if ($realScripts === false) return false;

    // For existing paths, use realpath directly
    if (file_exists($fullPath)) {
        $realFull = realpath($fullPath);
        return $realFull !== false && strpos($realFull, $realScripts) === 0;
    }

    // For new paths, validate the parent directory exists and is within bounds
    $parentDir = dirname($fullPath);
    if (!is_dir($parentDir)) return false;

    $realParent = realpath($parentDir);
    return $realParent !== false && strpos($realParent, $realScripts) === 0;
}

/**
 * Get list of script files recursively, returning relative paths
 */
function listScripts($basePath, $currentPath = '') {
    $scripts = [];
    $fullPath = $currentPath ? $basePath . '/' . $currentPath : $basePath;

    if (!is_dir($fullPath)) {
        return $scripts;
    }

    $entries = scandir($fullPath);
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') continue;

        $entryFullPath = $fullPath . '/' . $entry;
        $relativePath = $currentPath ? $currentPath . '/' . $entry : $entry;

        if (is_dir($entryFullPath)) {
            // Add folder entry
            $scripts[] = [
                'name' => $relativePath,
                'type' => 'folder',
                'modified' => date('c', filemtime($entryFullPath))
            ];
            // Recurse into subdirectory
            $scripts = array_merge($scripts, listScripts($basePath, $relativePath));
        } else {
            // Check extension
            $ext = strtolower(pathinfo($entry, PATHINFO_EXTENSION));
            if (in_array($ext, ALLOWED_EXTENSIONS)) {
                $scripts[] = [
                    'name' => $relativePath,
                    'type' => 'file',
                    'size' => filesize($entryFullPath),
                    'modified' => date('c', filemtime($entryFullPath))
                ];
            }
        }
    }

    return $scripts;
}

/**
 * Sort scripts: folders first (alphabetical), then files (alphabetical)
 * Within each folder, its contents follow it immediately
 */
function sortScripts($scripts) {
    usort($scripts, function($a, $b) {
        // Compare by path depth, then type, then name
        $aDir = ($a['type'] === 'folder') ? $a['name'] : dirname($a['name']);
        $bDir = ($b['type'] === 'folder') ? $b['name'] : dirname($b['name']);

        if ($aDir === '.') $aDir = '';
        if ($bDir === '.') $bDir = '';

        // Same directory - folders first, then files alphabetically
        if ($aDir === $bDir) {
            if ($a['type'] !== $b['type']) {
                return $a['type'] === 'folder' ? -1 : 1;
            }
            return strcasecmp($a['name'], $b['name']);
        }

        // If one is parent of the other, parent goes first
        if ($aDir && strpos($bDir, $aDir . '/') === 0) return -1;
        if ($bDir && strpos($aDir, $bDir . '/') === 0) return 1;

        return strcasecmp($a['name'], $b['name']);
    });

    return $scripts;
}

switch ($action) {
    case 'list':
        $scripts = listScripts($scriptsPath);
        $scripts = sortScripts($scripts);
        successResponse(['scripts' => $scripts]);
        break;

    case 'get':
        $filename = $_GET['filename'] ?? '';
        if (empty($filename)) {
            errorResponse('Filename is required');
        }

        // Validate extension
        $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
        if (!in_array($ext, ALLOWED_EXTENSIONS)) {
            errorResponse('Invalid file extension');
        }

        // Sanitize path (may include folders)
        $basePath = sanitizePath($filename);
        if ($basePath === false) {
            errorResponse('Invalid filename');
        }

        $filePath = $scriptsPath . '/' . $basePath . '.' . $ext;

        if (!file_exists($filePath)) {
            // Try the other extension
            $otherExt = $ext === 'txt' ? 'tin' : 'txt';
            $filePath = $scriptsPath . '/' . $basePath . '.' . $otherExt;
            if (!file_exists($filePath)) {
                errorResponse('Script file not found');
            }
            $ext = $otherExt;
        }

        // Validate resolved path is within scripts dir
        if (!validatePathWithin($filePath, $scriptsPath)) {
            errorResponse('Invalid file path');
        }

        $content = file_get_contents($filePath);
        // Return the relative path including folder
        $relativeName = $basePath . '.' . $ext;
        successResponse([
            'filename' => $relativeName,
            'content' => $content,
            'size' => strlen($content)
        ]);
        break;

    case 'save':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $filename = $data['filename'] ?? '';
        $content = $data['content'] ?? '';

        if (empty($filename)) {
            errorResponse('Filename is required');
        }

        // Get or default extension
        $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
        if (!in_array($ext, ALLOWED_EXTENSIONS)) {
            $ext = 'tin'; // Default to .tin
        }

        // Sanitize path (may include folders)
        $basePath = sanitizePath($filename);
        if ($basePath === false) {
            errorResponse('Invalid filename');
        }

        // Check size
        if (strlen($content) > MAX_SCRIPT_SIZE) {
            errorResponse('Script too large (max 256KB)');
        }

        $filePath = $scriptsPath . '/' . $basePath . '.' . $ext;

        // Auto-create parent directories
        $parentDir = dirname($filePath);
        if (!is_dir($parentDir)) {
            mkdir($parentDir, 0755, true);
        }

        // Validate path is within scripts dir
        if (!validatePathWithin($filePath, $scriptsPath)) {
            errorResponse('Invalid file path');
        }

        // Check storage limits (account for existing file size if overwriting)
        $existingSize = file_exists($filePath) ? filesize($filePath) : 0;
        $isNewFile = !file_exists($filePath);
        $additionalBytes = strlen($content) - $existingSize;
        $additionalFiles = $isNewFile ? 1 : 0;

        $limitCheck = checkUserStorageLimits($userId, $additionalBytes, $additionalFiles);
        if (!$limitCheck['allowed']) {
            errorResponse($limitCheck['error']);
        }

        if (file_put_contents($filePath, $content) === false) {
            errorResponse('Failed to save script');
        }

        $relativeName = $basePath . '.' . $ext;
        successResponse([
            'filename' => $relativeName,
            'size' => strlen($content)
        ]);
        break;

    case 'upload':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        if (!isset($_FILES['file'])) {
            errorResponse('No file uploaded');
        }

        $file = $_FILES['file'];
        // Optional target folder from POST data
        $targetFolder = $_POST['folder'] ?? '';

        if ($file['error'] !== UPLOAD_ERR_OK) {
            errorResponse('Upload failed');
        }

        // Check size
        if ($file['size'] > MAX_SCRIPT_SIZE) {
            errorResponse('Script too large (max 256KB)');
        }

        // Validate extension
        $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        if (!in_array($ext, ALLOWED_EXTENSIONS)) {
            errorResponse('Invalid file type. Only .txt and .tin files allowed');
        }

        // Sanitize just the filename (no path from upload name)
        $uploadName = basename($file['name']);
        $uploadName = preg_replace('/\.(txt|tin)$/i', '', $uploadName);
        $uploadName = preg_replace('/[^a-zA-Z0-9_\-]/', '', $uploadName);
        if (empty($uploadName)) {
            errorResponse('Invalid filename');
        }
        if (strlen($uploadName) > 50) {
            $uploadName = substr($uploadName, 0, 50);
        }

        // Build path with optional target folder
        if (!empty($targetFolder)) {
            $folderPath = sanitizeFolderPath($targetFolder);
            if ($folderPath === false) {
                errorResponse('Invalid folder path');
            }
            $relativeName = $folderPath . '/' . $uploadName . '.' . $ext;
        } else {
            $relativeName = $uploadName . '.' . $ext;
        }

        $filePath = $scriptsPath . '/' . $relativeName;

        // Auto-create parent directories
        $parentDir = dirname($filePath);
        if (!is_dir($parentDir)) {
            mkdir($parentDir, 0755, true);
        }

        // Validate path
        if (!validatePathWithin($filePath, $scriptsPath)) {
            errorResponse('Invalid file path');
        }

        // Check storage limits
        $existingSize = file_exists($filePath) ? filesize($filePath) : 0;
        $isNewFile = !file_exists($filePath);
        $additionalBytes = $file['size'] - $existingSize;
        $additionalFiles = $isNewFile ? 1 : 0;

        $limitCheck = checkUserStorageLimits($userId, $additionalBytes, $additionalFiles);
        if (!$limitCheck['allowed']) {
            errorResponse($limitCheck['error']);
        }

        if (!move_uploaded_file($file['tmp_name'], $filePath)) {
            errorResponse('Failed to save uploaded file');
        }

        $content = file_get_contents($filePath);

        successResponse([
            'filename' => $relativeName,
            'size' => filesize($filePath),
            'content' => $content
        ]);
        break;

    case 'delete':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $filename = $data['filename'] ?? '';

        if (empty($filename)) {
            errorResponse('Filename is required');
        }

        // Validate extension
        $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
        if (!in_array($ext, ALLOWED_EXTENSIONS)) {
            errorResponse('Invalid file extension');
        }

        // Sanitize path
        $basePath = sanitizePath($filename);
        if ($basePath === false) {
            errorResponse('Invalid filename');
        }

        $filePath = $scriptsPath . '/' . $basePath . '.' . $ext;

        if (!file_exists($filePath)) {
            errorResponse('Script file not found');
        }

        // Validate path
        if (!validatePathWithin($filePath, $scriptsPath)) {
            errorResponse('Invalid file path');
        }

        if (!unlink($filePath)) {
            errorResponse('Failed to delete script');
        }

        // Clean up empty parent directories (up to scripts root)
        $parentDir = dirname($filePath);
        $realScripts = realpath($scriptsPath);
        while ($parentDir !== $realScripts && is_dir($parentDir)) {
            $remaining = glob($parentDir . '/*');
            if (empty($remaining)) {
                rmdir($parentDir);
                $parentDir = dirname($parentDir);
            } else {
                break;
            }
        }

        successResponse(['message' => 'Script deleted']);
        break;

    case 'mkdir':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $folder = $data['folder'] ?? '';

        if (empty($folder)) {
            errorResponse('Folder name is required');
        }

        $folderPath = sanitizeFolderPath($folder);
        if ($folderPath === false) {
            errorResponse('Invalid folder name');
        }

        $fullPath = $scriptsPath . '/' . $folderPath;

        if (is_dir($fullPath)) {
            errorResponse('Folder already exists');
        }

        if (!mkdir($fullPath, 0755, true)) {
            errorResponse('Failed to create folder');
        }

        successResponse(['folder' => $folderPath]);
        break;

    case 'rmdir':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $folder = $data['folder'] ?? '';

        if (empty($folder)) {
            errorResponse('Folder name is required');
        }

        $folderPath = sanitizeFolderPath($folder);
        if ($folderPath === false) {
            errorResponse('Invalid folder name');
        }

        $fullPath = $scriptsPath . '/' . $folderPath;

        if (!is_dir($fullPath)) {
            errorResponse('Folder not found');
        }

        // Validate path
        if (!validatePathWithin($fullPath, $scriptsPath)) {
            errorResponse('Invalid folder path');
        }

        // Check if folder is empty
        $contents = glob($fullPath . '/*');
        if (!empty($contents)) {
            errorResponse('Folder is not empty. Delete all files first.');
        }

        if (!rmdir($fullPath)) {
            errorResponse('Failed to delete folder');
        }

        // Clean up empty parent directories
        $parentDir = dirname($fullPath);
        $realScripts = realpath($scriptsPath);
        while ($parentDir !== $realScripts && is_dir($parentDir)) {
            $remaining = glob($parentDir . '/*');
            if (empty($remaining)) {
                rmdir($parentDir);
                $parentDir = dirname($parentDir);
            } else {
                break;
            }
        }

        successResponse(['message' => 'Folder deleted']);
        break;

    case 'rename':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $oldName = $data['oldName'] ?? '';
        $newName = $data['newName'] ?? '';

        if (empty($oldName) || empty($newName)) {
            errorResponse('Both old and new names are required');
        }

        // Determine if renaming a file or folder
        $ext = strtolower(pathinfo($oldName, PATHINFO_EXTENSION));
        $isFile = in_array($ext, ALLOWED_EXTENSIONS);

        if ($isFile) {
            $newExt = strtolower(pathinfo($newName, PATHINFO_EXTENSION));
            if (!in_array($newExt, ALLOWED_EXTENSIONS)) {
                $newExt = $ext;
            }

            $oldPath = sanitizePath($oldName);
            $newPath = sanitizePath($newName);
            if ($oldPath === false || $newPath === false) {
                errorResponse('Invalid filename');
            }

            $oldFull = $scriptsPath . '/' . $oldPath . '.' . $ext;
            $newFull = $scriptsPath . '/' . $newPath . '.' . $newExt;
        } else {
            // Folder rename
            $oldPath = sanitizeFolderPath($oldName);
            $newPath = sanitizeFolderPath($newName);
            if ($oldPath === false || $newPath === false) {
                errorResponse('Invalid folder name');
            }

            $oldFull = $scriptsPath . '/' . $oldPath;
            $newFull = $scriptsPath . '/' . $newPath;
        }

        if (!file_exists($oldFull)) {
            errorResponse('Source not found');
        }

        if (file_exists($newFull)) {
            errorResponse('Destination already exists');
        }

        // Validate paths
        if (!validatePathWithin($oldFull, $scriptsPath)) {
            errorResponse('Invalid source path');
        }

        // Auto-create parent dir for destination
        $newParent = dirname($newFull);
        if (!is_dir($newParent)) {
            mkdir($newParent, 0755, true);
        }

        if (!validatePathWithin($newFull, $scriptsPath)) {
            errorResponse('Invalid destination path');
        }

        if (!rename($oldFull, $newFull)) {
            errorResponse('Failed to rename');
        }

        successResponse(['message' => 'Renamed successfully']);
        break;

    default:
        errorResponse('Invalid action', 400);
}
