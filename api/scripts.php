<?php
/**
 * WMT Client Scripts API
 * Manages TinTin++ style script files (.txt, .tin)
 */

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/functions.php';

initSession();
requireAuth();
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

/**
 * Sanitize filename (allow only alphanumeric, dash, underscore)
 */
function sanitizeFilename($name) {
    // Remove extension if present
    $name = preg_replace('/\.(txt|tin)$/i', '', $name);
    // Only allow safe characters
    $name = preg_replace('/[^a-zA-Z0-9_\-]/', '', $name);
    return $name;
}

/**
 * Get list of script files
 */
function listScripts($path) {
    $scripts = [];
    if (!is_dir($path)) {
        return $scripts;
    }

    $files = glob($path . '/*.{txt,tin}', GLOB_BRACE);
    foreach ($files as $file) {
        $filename = basename($file);
        $scripts[] = [
            'name' => $filename,
            'size' => filesize($file),
            'modified' => date('c', filemtime($file))
        ];
    }

    // Sort by name
    usort($scripts, function($a, $b) {
        return strcasecmp($a['name'], $b['name']);
    });

    return $scripts;
}

switch ($action) {
    case 'list':
        $scripts = listScripts($scriptsPath);
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

        // Sanitize and reconstruct filename
        $baseName = sanitizeFilename($filename);
        if (empty($baseName)) {
            errorResponse('Invalid filename');
        }

        $filePath = $scriptsPath . '/' . $baseName . '.' . $ext;

        if (!file_exists($filePath)) {
            // Try the other extension
            $otherExt = $ext === 'txt' ? 'tin' : 'txt';
            $filePath = $scriptsPath . '/' . $baseName . '.' . $otherExt;
            if (!file_exists($filePath)) {
                errorResponse('Script file not found');
            }
        }

        $content = file_get_contents($filePath);
        successResponse([
            'filename' => basename($filePath),
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

        // Sanitize filename
        $baseName = sanitizeFilename($filename);
        if (empty($baseName)) {
            errorResponse('Invalid filename');
        }

        if (strlen($baseName) > 50) {
            errorResponse('Filename too long (max 50 characters)');
        }

        // Check size
        if (strlen($content) > MAX_SCRIPT_SIZE) {
            errorResponse('Script too large (max 256KB)');
        }

        $filePath = $scriptsPath . '/' . $baseName . '.' . $ext;

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

        successResponse([
            'filename' => $baseName . '.' . $ext,
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

        // Sanitize filename
        $baseName = sanitizeFilename($file['name']);
        if (empty($baseName)) {
            errorResponse('Invalid filename');
        }

        if (strlen($baseName) > 50) {
            $baseName = substr($baseName, 0, 50);
        }

        $filePath = $scriptsPath . '/' . $baseName . '.' . $ext;

        // Check storage limits (account for existing file size if overwriting)
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
            'filename' => $baseName . '.' . $ext,
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

        // Sanitize filename
        $baseName = sanitizeFilename($filename);
        if (empty($baseName)) {
            errorResponse('Invalid filename');
        }

        $filePath = $scriptsPath . '/' . $baseName . '.' . $ext;

        if (!file_exists($filePath)) {
            errorResponse('Script file not found');
        }

        if (!unlink($filePath)) {
            errorResponse('Failed to delete script');
        }

        successResponse(['message' => 'Script deleted']);
        break;

    default:
        errorResponse('Invalid action', 400);
}
