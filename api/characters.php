<?php
/**
 * WMT Client - Characters API
 */

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/functions.php';

$action = $_GET['action'] ?? '';

// Special handling for server-to-server endpoint (admin key auth, not session auth)
// This must be handled completely separately before session auth
if ($action === 'get_password_admin') {
    // Server-to-server endpoint for WebSocket proxy to fetch character password
    // Used for auto-login after server restart
    // Requires admin key authentication (not user session)

    $adminKey = $_SERVER['HTTP_X_ADMIN_KEY'] ?? '';

    // Load admin key from config
    require_once __DIR__ . '/../config/config.php';
    $configAdminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;

    if (!$configAdminKey) {
        errorResponse('Admin key not configured', 500);
    }

    if ($adminKey !== $configAdminKey) {
        errorResponse('Invalid admin key', 403);
    }

    // Get user_id and character_id from query params (not session)
    $reqUserId = $_GET['user_id'] ?? '';
    $reqCharacterId = $_GET['character_id'] ?? '';

    if (empty($reqUserId) || empty($reqCharacterId)) {
        errorResponse('user_id and character_id are required', 400);
    }

    // Validate user exists
    $user = findUserById($reqUserId);
    if (!$user) {
        errorResponse('User not found', 404);
    }

    // Get password for this character
    $password = getCharacterPassword($reqUserId, $reqCharacterId);

    successResponse([
        'password' => $password
    ]);
    exit;
}

// All other actions require session auth
initSession();
requireAuth();

// Block guest write operations
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    denyGuest();
}

$userId = getCurrentUserId();

switch ($action) {
    case 'list':
        $characters = getCharacters($userId);
        successResponse(['characters' => $characters]);
        break;

    case 'create':
        $input = json_decode(file_get_contents('php://input'), true);

        if (!validateCsrfToken($input['csrf_token'] ?? null)) {
            errorResponse('Invalid CSRF token', 403);
        }

        $name = trim($input['name'] ?? '');
        $server = $input['server'] ?? '3k';

        if (empty($name)) {
            errorResponse('Character name is required');
        }

        if (strlen($name) > 50) {
            errorResponse('Character name too long (max 50 characters)');
        }

        if (!in_array($server, ['3k', '3s'])) {
            $server = '3k';
        }

        // Check for duplicate names on the same server
        $existing = getCharacters($userId);
        foreach ($existing as $char) {
            $charServer = $char['server'] ?? '3k';
            if (strtolower($char['name']) === strtolower($name) && $charServer === $server) {
                errorResponse('A character with that name already exists on ' . strtoupper($server));
            }
        }

        // Check storage limits (character adds ~5 files: triggers, aliases, classes, preferences, etc.)
        $limitCheck = checkUserStorageLimits($userId, 1000, 5);
        if (!$limitCheck['allowed']) {
            errorResponse($limitCheck['error']);
        }

        $character = createCharacter($userId, $name, $server);
        successResponse(['character' => $character]);
        break;

    case 'select':
        $input = json_decode(file_get_contents('php://input'), true);

        if (!validateCsrfToken($input['csrf_token'] ?? null)) {
            errorResponse('Invalid CSRF token', 403);
        }

        $characterId = $input['character_id'] ?? '';
        if (empty($characterId)) {
            errorResponse('Character ID is required');
        }

        $character = getCharacter($userId, $characterId);
        if (!$character) {
            errorResponse('Character not found', 404);
        }

        $server = $character['server'] ?? '3k';
        setCurrentCharacter($character['id'], $character['name'], $server);
        successResponse(['character' => $character]);
        break;

    case 'rename':
        $input = json_decode(file_get_contents('php://input'), true);

        if (!validateCsrfToken($input['csrf_token'] ?? null)) {
            errorResponse('Invalid CSRF token', 403);
        }

        $characterId = $input['character_id'] ?? '';
        $newName = trim($input['name'] ?? '');

        if (empty($characterId) || empty($newName)) {
            errorResponse('Character ID and new name are required');
        }

        if (strlen($newName) > 50) {
            errorResponse('Character name too long (max 50 characters)');
        }

        // Check for duplicate names on the same server (excluding current character)
        $existing = getCharacters($userId);
        $currentChar = getCharacter($userId, $characterId);
        $currentServer = $currentChar['server'] ?? '3k';
        foreach ($existing as $char) {
            $charServer = $char['server'] ?? '3k';
            if ($char['id'] !== $characterId && strtolower($char['name']) === strtolower($newName) && $charServer === $currentServer) {
                errorResponse('A character with that name already exists on ' . strtoupper($currentServer));
            }
        }

        if (!renameCharacter($userId, $characterId, $newName)) {
            errorResponse('Failed to rename character');
        }

        // Update session if this is the current character
        if (getCurrentCharacterId() === $characterId) {
            setCurrentCharacter($characterId, $newName);
        }

        successResponse(['message' => 'Character renamed']);
        break;

    case 'delete':
        $input = json_decode(file_get_contents('php://input'), true);

        if (!validateCsrfToken($input['csrf_token'] ?? null)) {
            errorResponse('Invalid CSRF token', 403);
        }

        $characterId = $input['character_id'] ?? '';
        if (empty($characterId)) {
            errorResponse('Character ID is required');
        }

        if (!deleteCharacter($userId, $characterId)) {
            errorResponse('Failed to delete character');
        }

        // Clear session if this was the current character
        if (getCurrentCharacterId() === $characterId) {
            clearCurrentCharacter();
        }

        successResponse(['message' => 'Character deleted']);
        break;

    case 'current':
        if (!hasCharacterSelected()) {
            errorResponse('No character selected', 404);
        }

        $character = getCharacter($userId, getCurrentCharacterId());
        if (!$character) {
            clearCurrentCharacter();
            errorResponse('Character not found', 404);
        }

        successResponse(['character' => $character]);
        break;

    case 'deselect':
        clearCurrentCharacter();
        successResponse(['message' => 'Character deselected']);
        break;

    case 'set_password':
        $input = json_decode(file_get_contents('php://input'), true);

        if (!validateCsrfToken($input['csrf_token'] ?? null)) {
            errorResponse('Invalid CSRF token', 403);
        }

        $characterId = $input['character_id'] ?? '';
        $password = $input['password'] ?? '';

        if (empty($characterId)) {
            errorResponse('Character ID is required');
        }

        if (!updateCharacterPassword($userId, $characterId, $password)) {
            errorResponse('Failed to update password');
        }

        successResponse(['message' => 'Password updated']);
        break;

    case 'get_password':
        $characterId = $_GET['character_id'] ?? getCurrentCharacterId();

        if (empty($characterId)) {
            errorResponse('Character ID is required');
        }

        $password = getCharacterPassword($userId, $characterId);
        successResponse(['password' => $password]);
        break;

    case 'set_server':
        $input = json_decode(file_get_contents('php://input'), true);

        if (!validateCsrfToken($input['csrf_token'] ?? null)) {
            errorResponse('Invalid CSRF token', 403);
        }

        $characterId = $input['character_id'] ?? '';
        $server = $input['server'] ?? '3k';

        if (empty($characterId)) {
            errorResponse('Character ID is required');
        }

        if (!in_array($server, ['3k', '3s'])) {
            errorResponse('Invalid server value');
        }

        if (!updateCharacterServer($userId, $characterId, $server)) {
            errorResponse('Failed to update server');
        }

        successResponse(['message' => 'Server updated', 'server' => $server]);
        break;

    case 'get_server':
        $characterId = $_GET['character_id'] ?? getCurrentCharacterId();

        if (empty($characterId)) {
            errorResponse('Character ID is required');
        }

        $server = getCharacterServer($userId, $characterId);
        successResponse(['server' => $server]);
        break;

    case 'reorder':
        $input = json_decode(file_get_contents('php://input'), true);

        if (!validateCsrfToken($input['csrf_token'] ?? null)) {
            errorResponse('Invalid CSRF token', 403);
        }

        $orderedIds = $input['order'] ?? [];

        if (!is_array($orderedIds) || empty($orderedIds)) {
            errorResponse('Order array is required');
        }

        if (!reorderCharacters($userId, $orderedIds)) {
            errorResponse('Failed to reorder characters');
        }

        successResponse(['message' => 'Characters reordered']);
        break;

    case 'set_character_wizard':
        // Toggle wizard status for a specific character
        // Only wizard accounts can mark characters as wizards
        $input = json_decode(file_get_contents('php://input'), true);

        if (!validateCsrfToken($input['csrf_token'] ?? null)) {
            errorResponse('Invalid CSRF token', 403);
        }

        // Check if account has wizard privileges
        if (!isUserWizard($userId)) {
            errorResponse('Only wizard accounts can set character wizard status', 403);
        }

        $characterId = $input['character_id'] ?? '';
        $isWizard = $input['is_wizard'] ?? false;

        if (empty($characterId)) {
            errorResponse('Character ID is required');
        }

        // Verify character belongs to this user
        $character = getCharacter($userId, $characterId);
        if (!$character) {
            errorResponse('Character not found', 404);
        }

        if (!setCharacterWizard($userId, $characterId, (bool)$isWizard)) {
            errorResponse('Failed to update wizard status');
        }

        successResponse([
            'message' => $isWizard ? 'Character marked as wizard' : 'Character wizard status removed',
            'isWizard' => (bool)$isWizard
        ]);
        break;

    case 'get_character_wizard':
        // Get wizard status for a character
        $characterId = $_GET['character_id'] ?? getCurrentCharacterId();

        if (empty($characterId)) {
            errorResponse('Character ID is required');
        }

        $isWizard = isCharacterWizard($userId, $characterId);
        successResponse(['isWizard' => $isWizard]);
        break;

    default:
        errorResponse('Invalid action', 400);
}
