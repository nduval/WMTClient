<?php
/**
 * WMT Client Helper Functions
 */

require_once __DIR__ . '/../config/config.php';

/**
 * Generate a unique ID
 */
function generateId(): string {
    return bin2hex(random_bytes(16));
}

/**
 * Generate CSRF token
 */
function generateCsrfToken(): string {
    if (!isset($_SESSION[CSRF_TOKEN_NAME])) {
        $_SESSION[CSRF_TOKEN_NAME] = bin2hex(random_bytes(32));
    }
    return $_SESSION[CSRF_TOKEN_NAME];
}

/**
 * Validate CSRF token
 */
function validateCsrfToken(?string $token): bool {
    if (!$token || !isset($_SESSION[CSRF_TOKEN_NAME])) {
        return false;
    }
    return hash_equals($_SESSION[CSRF_TOKEN_NAME], $token);
}

/**
 * Sanitize input string
 */
function sanitize(string $input): string {
    return htmlspecialchars(trim($input), ENT_QUOTES, 'UTF-8');
}

/**
 * Send JSON response
 */
function jsonResponse(array $data, int $statusCode = 200): void {
    http_response_code($statusCode);
    header('Content-Type: application/json');
    header('Cache-Control: no-cache, no-store, must-revalidate');
    echo json_encode($data);
    exit;
}

/**
 * Send error response
 */
function errorResponse(string $message, int $statusCode = 400): void {
    jsonResponse(['success' => false, 'error' => $message], $statusCode);
}

/**
 * Send success response
 */
function successResponse(array $data = []): void {
    jsonResponse(array_merge(['success' => true], $data));
}

/**
 * Get user data directory path
 */
function getUserDataPath(string $userId): string {
    return USERS_PATH . '/' . $userId;
}

/**
 * Calculate total size of a directory recursively
 */
function getDirectorySize(string $path): int {
    $size = 0;
    if (!is_dir($path)) {
        return 0;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, RecursiveDirectoryIterator::SKIP_DOTS)
    );

    foreach ($iterator as $file) {
        if ($file->isFile()) {
            $size += $file->getSize();
        }
    }

    return $size;
}

/**
 * Count total files in a directory recursively
 */
function getDirectoryFileCount(string $path): int {
    $count = 0;
    if (!is_dir($path)) {
        return 0;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, RecursiveDirectoryIterator::SKIP_DOTS)
    );

    foreach ($iterator as $file) {
        if ($file->isFile()) {
            $count++;
        }
    }

    return $count;
}

/**
 * Check if user can store additional data
 * Returns array with 'allowed' bool and 'error' message if not allowed
 */
function checkUserStorageLimits(string $userId, int $additionalBytes = 0, int $additionalFiles = 0): array {
    $userPath = getUserDataPath($userId);

    $currentSize = getDirectorySize($userPath);
    $currentFiles = getDirectoryFileCount($userPath);

    if ($currentSize + $additionalBytes > MAX_USER_STORAGE) {
        $maxMB = round(MAX_USER_STORAGE / 1024 / 1024);
        $usedMB = round($currentSize / 1024 / 1024, 2);
        return [
            'allowed' => false,
            'error' => "Storage limit exceeded. Using {$usedMB}MB of {$maxMB}MB allowed."
        ];
    }

    if ($currentFiles + $additionalFiles > MAX_USER_FILES) {
        return [
            'allowed' => false,
            'error' => "File limit exceeded. You have {$currentFiles} of " . MAX_USER_FILES . " files allowed."
        ];
    }

    return ['allowed' => true];
}

/**
 * Get user storage stats
 */
function getUserStorageStats(string $userId): array {
    $userPath = getUserDataPath($userId);
    $currentSize = getDirectorySize($userPath);
    $currentFiles = getDirectoryFileCount($userPath);

    return [
        'used_bytes' => $currentSize,
        'used_mb' => round($currentSize / 1024 / 1024, 2),
        'max_mb' => round(MAX_USER_STORAGE / 1024 / 1024),
        'files' => $currentFiles,
        'max_files' => MAX_USER_FILES,
        'percent_used' => round(($currentSize / MAX_USER_STORAGE) * 100, 1)
    ];
}

/**
 * Load JSON file
 */
function loadJsonFile(string $path): array {
    if (!file_exists($path)) {
        return [];
    }
    $content = file_get_contents($path);
    $data = json_decode($content, true);
    return is_array($data) ? $data : [];
}

/**
 * Save JSON file atomically (write to temp, then rename)
 * This prevents partial/corrupted writes
 */
function saveJsonFile(string $path, array $data): bool {
    $dir = dirname($path);
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }

    $json = json_encode($data, JSON_PRETTY_PRINT);
    if ($json === false) {
        error_log("saveJsonFile: Failed to encode JSON for $path");
        return false;
    }

    // Write to temp file first
    $tempPath = $path . '.tmp.' . uniqid();
    if (file_put_contents($tempPath, $json) === false) {
        error_log("saveJsonFile: Failed to write temp file $tempPath");
        return false;
    }

    // Verify the temp file is valid JSON before replacing
    $verify = json_decode(file_get_contents($tempPath), true);
    if ($verify === null && json_last_error() !== JSON_ERROR_NONE) {
        error_log("saveJsonFile: Temp file validation failed for $path");
        @unlink($tempPath);
        return false;
    }

    // Atomic rename (on Windows, need to delete first)
    if (PHP_OS_FAMILY === 'Windows' && file_exists($path)) {
        @unlink($path);
    }

    if (!rename($tempPath, $path)) {
        error_log("saveJsonFile: Failed to rename temp to $path");
        @unlink($tempPath);
        return false;
    }

    return true;
}

/**
 * Get user's profile file path
 */
function getProfilePath(string $userId): string {
    return getUserDataPath($userId) . '/profile.json';
}

/**
 * Get user's characters list file path
 */
function getCharactersListPath(string $userId): string {
    return getUserDataPath($userId) . '/characters.json';
}

/**
 * Get character data directory path
 */
function getCharacterDataPath(string $userId, string $characterId): string {
    return getUserDataPath($userId) . '/characters/' . $characterId;
}

/**
 * Get character's triggers file path
 */
function getTriggersPath(string $userId, string $characterId): string {
    return getCharacterDataPath($userId, $characterId) . '/triggers.json';
}

/**
 * Get character's aliases file path
 */
function getAliasesPath(string $userId, string $characterId): string {
    return getCharacterDataPath($userId, $characterId) . '/aliases.json';
}

/**
 * Get character's tickers file path
 */
function getTickersPath(string $userId, string $characterId): string {
    return getCharacterDataPath($userId, $characterId) . '/tickers.json';
}

/**
 * Get character's preferences file path
 */
function getPreferencesPath(string $userId, string $characterId): string {
    return getCharacterDataPath($userId, $characterId) . '/preferences.json';
}

/**
 * Get character's MIP conditions file path
 */
function getMipConditionsPath(string $userId, string $characterId): string {
    return getCharacterDataPath($userId, $characterId) . '/mip_conditions.json';
}

/**
 * Initialize user data directory with default files
 * Stores password hash in profile for recovery purposes
 */
function initializeUserData(string $userId, string $username, string $passwordHash = '', string $email = ''): void {
    $userPath = getUserDataPath($userId);

    if (!is_dir($userPath)) {
        mkdir($userPath, 0755, true);
    }

    // Create characters directory
    $charsDir = $userPath . '/characters';
    if (!is_dir($charsDir)) {
        mkdir($charsDir, 0755, true);
    }

    // Default profile (includes password hash for recovery)
    $profile = [
        'id' => $userId,
        'username' => $username,
        'created_at' => date('c')
    ];
    if ($passwordHash) {
        $profile['password_hash'] = $passwordHash;
    }
    if ($email) {
        $profile['email'] = $email;
    }
    saveJsonFile(getProfilePath($userId), $profile);

    // Empty characters list
    saveJsonFile(getCharactersListPath($userId), []);
}

/**
 * Create a new character for a user
 */
function createCharacter(string $userId, string $characterName, string $server = '3k'): array {
    $characterId = generateId();
    $charPath = getCharacterDataPath($userId, $characterId);

    if (!is_dir($charPath)) {
        mkdir($charPath, 0755, true);
    }

    $character = [
        'id' => $characterId,
        'name' => $characterName,
        'password' => '',
        'server' => $server,
        'created_at' => date('c')
    ];

    // Add to characters list
    $characters = loadJsonFile(getCharactersListPath($userId));
    $characters[] = $character;
    saveJsonFile(getCharactersListPath($userId), $characters);

    // Initialize character data files
    saveJsonFile(getTriggersPath($userId, $characterId), []);
    saveJsonFile(getAliasesPath($userId, $characterId), []);
    saveJsonFile(getTickersPath($userId, $characterId), []);
    saveJsonFile(getPreferencesPath($userId, $characterId), [
        'fontFamily' => DEFAULT_FONT_FAMILY,
        'fontSize' => DEFAULT_FONT_SIZE,
        'textColor' => DEFAULT_TEXT_COLOR,
        'backgroundColor' => DEFAULT_BACKGROUND_COLOR,
        'echoCommands' => true,
        'scrollOnOutput' => true,
        'keepAlive' => true,
        'keepAliveInterval' => 60
    ]);

    return $character;
}

/**
 * Get all characters for a user
 */
function getCharacters(string $userId): array {
    return loadJsonFile(getCharactersListPath($userId));
}

/**
 * Get a specific character
 */
function getCharacter(string $userId, string $characterId): ?array {
    $characters = getCharacters($userId);
    foreach ($characters as $char) {
        if ($char['id'] === $characterId) {
            return $char;
        }
    }
    return null;
}

/**
 * Reorder characters based on array of IDs
 */
function reorderCharacters(string $userId, array $orderedIds): bool {
    $characters = getCharacters($userId);

    // Build a map of id => character for quick lookup
    $charMap = [];
    foreach ($characters as $char) {
        $charMap[$char['id']] = $char;
    }

    // Validate all IDs exist
    foreach ($orderedIds as $id) {
        if (!isset($charMap[$id])) {
            return false; // Invalid ID in order list
        }
    }

    // Rebuild array in new order
    $newOrder = [];
    foreach ($orderedIds as $id) {
        $newOrder[] = $charMap[$id];
        unset($charMap[$id]);
    }

    // Append any characters not in the order list (shouldn't happen, but safety)
    foreach ($charMap as $char) {
        $newOrder[] = $char;
    }

    return saveJsonFile(getCharactersListPath($userId), $newOrder);
}

/**
 * Delete a character
 */
function deleteCharacter(string $userId, string $characterId): bool {
    $characters = getCharacters($userId);
    $newCharacters = array_filter($characters, function($c) use ($characterId) {
        return $c['id'] !== $characterId;
    });

    if (count($newCharacters) === count($characters)) {
        return false; // Character not found
    }

    saveJsonFile(getCharactersListPath($userId), array_values($newCharacters));

    // Delete character data directory
    $charPath = getCharacterDataPath($userId, $characterId);
    if (is_dir($charPath)) {
        $files = glob($charPath . '/*');
        foreach ($files as $file) {
            unlink($file);
        }
        rmdir($charPath);
    }

    return true;
}

/**
 * Rename a character
 */
function renameCharacter(string $userId, string $characterId, string $newName): bool {
    $characters = getCharacters($userId);
    $found = false;

    foreach ($characters as &$char) {
        if ($char['id'] === $characterId) {
            $char['name'] = $newName;
            $found = true;
            break;
        }
    }

    if (!$found) {
        return false;
    }

    return saveJsonFile(getCharactersListPath($userId), $characters);
}

/**
 * Update character password
 */
function updateCharacterPassword(string $userId, string $characterId, string $password): bool {
    $characters = getCharacters($userId);
    $found = false;

    foreach ($characters as &$char) {
        if ($char['id'] === $characterId) {
            $char['password'] = $password;
            $found = true;
            break;
        }
    }

    if (!$found) {
        return false;
    }

    return saveJsonFile(getCharactersListPath($userId), $characters);
}

/**
 * Get character password
 */
function getCharacterPassword(string $userId, string $characterId): string {
    $character = getCharacter($userId, $characterId);
    return $character['password'] ?? '';
}

/**
 * Check if character has wizard status (unlimited session timeout)
 */
function isCharacterWizard(string $userId, string $characterId): bool {
    $character = getCharacter($userId, $characterId);
    return $character['isWizard'] ?? false;
}

/**
 * Set wizard status for a character
 * Note: This only sets the flag - caller should verify account-level wizard status first
 */
function setCharacterWizard(string $userId, string $characterId, bool $isWizard): bool {
    $characters = getCharacters($userId);
    $found = false;

    foreach ($characters as &$char) {
        if ($char['id'] === $characterId) {
            $char['isWizard'] = $isWizard;
            $found = true;
            break;
        }
    }

    if (!$found) {
        return false;
    }

    return saveJsonFile(getCharactersListPath($userId), $characters);
}

/**
 * Update character server (3k or 3s)
 */
function updateCharacterServer(string $userId, string $characterId, string $server): bool {
    // Validate server value
    if (!in_array($server, ['3k', '3s'])) {
        return false;
    }

    $characters = getCharacters($userId);
    $found = false;

    foreach ($characters as &$char) {
        if ($char['id'] === $characterId) {
            $char['server'] = $server;
            $found = true;
            break;
        }
    }

    if (!$found) {
        return false;
    }

    return saveJsonFile(getCharactersListPath($userId), $characters);
}

/**
 * Get character server (defaults to '3k')
 */
function getCharacterServer(string $userId, string $characterId): string {
    $character = getCharacter($userId, $characterId);
    return $character['server'] ?? '3k';
}

/**
 * Convert ANSI codes to HTML
 */
function ansiToHtml(string $text): string {
    $ansiColors = [
        '0' => '</span>',
        '1' => '<span style="font-weight:bold">',
        '4' => '<span style="text-decoration:underline">',
        '30' => '<span style="color:#000000">',
        '31' => '<span style="color:#cc0000">',
        '32' => '<span style="color:#00cc00">',
        '33' => '<span style="color:#cccc00">',
        '34' => '<span style="color:#0000cc">',
        '35' => '<span style="color:#cc00cc">',
        '36' => '<span style="color:#00cccc">',
        '37' => '<span style="color:#cccccc">',
        '90' => '<span style="color:#666666">',
        '91' => '<span style="color:#ff0000">',
        '92' => '<span style="color:#00ff00">',
        '93' => '<span style="color:#ffff00">',
        '94' => '<span style="color:#0000ff">',
        '95' => '<span style="color:#ff00ff">',
        '96' => '<span style="color:#00ffff">',
        '97' => '<span style="color:#ffffff">',
        '40' => '<span style="background-color:#000000">',
        '41' => '<span style="background-color:#cc0000">',
        '42' => '<span style="background-color:#00cc00">',
        '43' => '<span style="background-color:#cccc00">',
        '44' => '<span style="background-color:#0000cc">',
        '45' => '<span style="background-color:#cc00cc">',
        '46' => '<span style="background-color:#00cccc">',
        '47' => '<span style="background-color:#cccccc">'
    ];

    // Match ANSI escape sequences
    $pattern = '/\x1b\[([0-9;]+)m/';

    $result = preg_replace_callback($pattern, function($matches) use ($ansiColors) {
        $codes = explode(';', $matches[1]);
        $html = '';
        foreach ($codes as $code) {
            if (isset($ansiColors[$code])) {
                $html .= $ansiColors[$code];
            }
        }
        return $html;
    }, $text);

    return $result;
}

/**
 * Require authentication
 */
function requireAuth(): void {
    // Debug logging
    $logFile = __DIR__ . '/../data/logs/auth.log';
    $timestamp = date('Y-m-d H:i:s');
    $uri = $_SERVER['REQUEST_URI'] ?? 'unknown';
    $sessionCookie = $_COOKIE[SESSION_NAME] ?? 'NOT SET';
    @file_put_contents($logFile, "[$timestamp] requireAuth called: uri=$uri, cookie=$sessionCookie\n", FILE_APPEND | LOCK_EX);

    if (session_status() === PHP_SESSION_NONE) {
        session_name(SESSION_NAME);

        // Delete any old cookies with /api/ path (legacy bug fix)
        if (isset($_COOKIE[SESSION_NAME])) {
            setcookie(SESSION_NAME, '', time() - 3600, '/api/');
        }

        // Always use root path for cookies to ensure they work across all pages
        session_set_cookie_params([
            'lifetime' => SESSION_LIFETIME,
            'path' => '/',
            'secure' => isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on',
            'httponly' => true,
            'samesite' => 'Lax'
        ]);

        session_start();
    }

    $sessionId = session_id();
    $userId = $_SESSION['user_id'] ?? 'NOT SET';
    @file_put_contents($logFile, "[$timestamp] requireAuth session: id=$sessionId, user_id=$userId\n", FILE_APPEND | LOCK_EX);

    if (!isset($_SESSION['user_id'])) {
        @file_put_contents($logFile, "[$timestamp] requireAuth DENIED: no user_id in session\n", FILE_APPEND | LOCK_EX);
        if (strpos($_SERVER['REQUEST_URI'], '/api/') !== false) {
            errorResponse('Authentication required', 401);
        } else {
            header('Location: index.php');
            exit;
        }
    }
}

/**
 * Get current user ID
 */
function getCurrentUserId(): ?string {
    return $_SESSION['user_id'] ?? null;
}

/**
 * Get current username
 */
function getCurrentUsername(): ?string {
    return $_SESSION['username'] ?? null;
}

/**
 * Get current character ID
 */
function getCurrentCharacterId(): ?string {
    return $_SESSION['character_id'] ?? null;
}

/**
 * Get current character name
 */
function getCurrentCharacterName(): ?string {
    return $_SESSION['character_name'] ?? null;
}

/**
 * Set current character in session
 */
function setCurrentCharacter(string $characterId, string $characterName, string $server = '3k'): void {
    $_SESSION['character_id'] = $characterId;
    $_SESSION['character_name'] = $characterName;
    $_SESSION['character_server'] = $server;
}

/**
 * Get current character server
 */
function getCurrentCharacterServer(): string {
    return $_SESSION['character_server'] ?? '3k';
}

/**
 * Clear current character from session
 */
function clearCurrentCharacter(): void {
    unset($_SESSION['character_id']);
    unset($_SESSION['character_name']);
    unset($_SESSION['character_server']);
}

/**
 * Check if a character is selected
 */
function hasCharacterSelected(): bool {
    return isset($_SESSION['character_id']) && !empty($_SESSION['character_id']);
}

/**
 * Require a character to be selected.
 * API endpoints get a JSON error; page loads get a redirect.
 */
function requireCharacter(): void {
    if (!hasCharacterSelected()) {
        if (strpos($_SERVER['REQUEST_URI'] ?? '', '/api/') !== false) {
            header('Content-Type: application/json');
            http_response_code(401);
            echo json_encode(['success' => false, 'error' => 'No character selected']);
            exit;
        }
        header('Location: characters.php');
        exit;
    }
}

/**
 * Check if the current session is a guest
 */
function isGuest(): bool {
    return !empty($_SESSION['is_guest']);
}

/**
 * Block write operations for guest sessions
 */
function denyGuest(): void {
    if (isGuest()) {
        errorResponse('Guest accounts cannot save data', 403);
    }
}
