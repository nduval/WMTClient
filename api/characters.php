<?php
/**
 * WMT Client - Characters API
 */

require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/functions.php';

initSession();
requireAuth();

// Block guest write operations
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    denyGuest();
}

$action = $_GET['action'] ?? '';
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

    default:
        errorResponse('Invalid action', 400);
}
