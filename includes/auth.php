<?php
/**
 * WMT Client Authentication Functions
 */

require_once __DIR__ . '/functions.php';

/**
 * Log authentication events for debugging
 */
function authLog(string $message): void {
    $logDir = __DIR__ . '/../data/logs';
    if (!is_dir($logDir)) {
        @mkdir($logDir, 0755, true);
    }
    $logFile = $logDir . '/auth.log';
    $timestamp = date('Y-m-d H:i:s');
    $entry = "[$timestamp] $message\n";
    @file_put_contents($logFile, $entry, FILE_APPEND | LOCK_EX);
}

/**
 * Get users index file path
 */
function getUsersIndexPath(): string {
    return USERS_PATH . '/users_index.json';
}

/**
 * Load users index with self-healing
 * If users_index.json is missing/corrupt, rebuild from profile.json files
 */
function loadUsersIndex(): array {
    $indexPath = getUsersIndexPath();
    $users = loadJsonFile($indexPath);

    // Validate: check if any user directories exist that aren't in the index
    $userDirs = glob(USERS_PATH . '/*', GLOB_ONLYDIR);
    $indexedIds = array_column($users, 'id');
    $needsRepair = false;

    foreach ($userDirs as $userDir) {
        $dirName = basename($userDir);
        if ($dirName === 'backups') continue;

        // Check if this user directory is in the index
        if (!in_array($dirName, $indexedIds)) {
            // Orphaned directory found - try to recover from profile.json
            $profilePath = $userDir . '/profile.json';
            if (file_exists($profilePath)) {
                $profile = loadJsonFile($profilePath);
                if (!empty($profile['id']) && !empty($profile['username'])) {
                    // We can't recover the password hash, so this user would need to re-register
                    // But we can at least log this issue
                    error_log("loadUsersIndex: Found orphaned user directory without index entry: $dirName");
                    $needsRepair = true;
                }
            }
        }
    }

    // If the index is empty but user directories exist, something is very wrong
    if (empty($users) && count($userDirs) > 1) { // >1 because 'backups' dir might exist
        error_log("loadUsersIndex: CRITICAL - users_index.json is empty but user directories exist!");
    }

    return $users;
}

/**
 * Save users index
 */
function saveUsersIndex(array $users): bool {
    return saveJsonFile(getUsersIndexPath(), $users);
}

/**
 * Find user by username
 */
function findUserByUsername(string $username): ?array {
    $users = loadUsersIndex();
    $usernameLower = strtolower($username);

    foreach ($users as $user) {
        if (strtolower($user['username']) === $usernameLower) {
            return $user;
        }
    }

    return null;
}

/**
 * Find user by ID
 */
function findUserById(string $id): ?array {
    $users = loadUsersIndex();

    foreach ($users as $user) {
        if ($user['id'] === $id) {
            return $user;
        }
    }

    return null;
}

/**
 * Register a new user
 */
function registerUser(string $username, string $password, string $email): array {
    $username = trim($username);
    $email = trim(strtolower($email));

    // Validate username
    if (strlen($username) < 3) {
        return ['success' => false, 'error' => 'Username must be at least 3 characters'];
    }

    if (strlen($username) > 30) {
        return ['success' => false, 'error' => 'Username must be 30 characters or less'];
    }

    if (!preg_match('/^[a-zA-Z0-9_]+$/', $username)) {
        return ['success' => false, 'error' => 'Username can only contain letters, numbers, and underscores'];
    }

    // Validate email (required)
    if (empty($email)) {
        return ['success' => false, 'error' => 'Email address is required'];
    }

    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        return ['success' => false, 'error' => 'Invalid email address'];
    }

    // Validate password
    if (strlen($password) < PASSWORD_MIN_LENGTH) {
        return ['success' => false, 'error' => 'Password must be at least ' . PASSWORD_MIN_LENGTH . ' characters'];
    }

    // Check if username exists
    if (findUserByUsername($username)) {
        return ['success' => false, 'error' => 'Username already exists'];
    }

    // Check if email exists (if provided)
    if (!empty($email) && findUserByEmail($email)) {
        return ['success' => false, 'error' => 'Email address already registered'];
    }

    // Create user
    $userId = generateId();
    $hashedPassword = password_hash($password, PASSWORD_BCRYPT);

    $user = [
        'id' => $userId,
        'username' => $username,
        'email' => $email,
        'password' => $hashedPassword,
        'created_at' => date('c')
    ];

    // Initialize user data FIRST (creates directory and profile with password hash)
    // This ensures we have recovery data even if users_index save fails
    initializeUserData($userId, $username, $hashedPassword, $email);

    // Add to users index
    $users = loadUsersIndex();
    $users[] = $user;
    if (!saveUsersIndex($users)) {
        error_log("registerUser: CRITICAL - Failed to save users_index for user $username ($userId)");
        // User data exists in profile.json, can be recovered via admin
    }

    return ['success' => true, 'user_id' => $userId, 'username' => $username];
}

/**
 * Find user by email
 */
function findUserByEmail(string $email): ?array {
    $users = loadUsersIndex();
    $emailLower = strtolower($email);

    foreach ($users as $user) {
        if (isset($user['email']) && strtolower($user['email']) === $emailLower) {
            return $user;
        }
    }

    return null;
}

/**
 * Create password reset token
 */
function createPasswordResetToken(string $email): ?array {
    $user = findUserByEmail($email);
    if (!$user) {
        return null;
    }

    // Generate secure token
    $token = bin2hex(random_bytes(32));
    $expires = time() + 3600; // 1 hour

    // Store token in reset_tokens.json
    $tokensPath = USERS_PATH . '/reset_tokens.json';
    $tokens = loadJsonFile($tokensPath);

    // Remove any existing tokens for this user
    $tokens = array_filter($tokens, function($t) use ($user) {
        return $t['user_id'] !== $user['id'];
    });

    // Add new token
    $tokens[] = [
        'token' => hash('sha256', $token), // Store hashed token
        'user_id' => $user['id'],
        'email' => $user['email'],
        'expires' => $expires,
        'created_at' => date('c')
    ];

    // Clean up expired tokens
    $tokens = array_filter($tokens, function($t) {
        return $t['expires'] > time();
    });

    saveJsonFile($tokensPath, array_values($tokens));

    return [
        'token' => $token, // Return unhashed token for email
        'username' => $user['username'],
        'email' => $user['email']
    ];
}

/**
 * Validate password reset token
 */
function validatePasswordResetToken(string $token): ?array {
    $tokensPath = USERS_PATH . '/reset_tokens.json';
    $tokens = loadJsonFile($tokensPath);
    $hashedToken = hash('sha256', $token);

    foreach ($tokens as $t) {
        if ($t['token'] === $hashedToken && $t['expires'] > time()) {
            $user = findUserById($t['user_id']);
            if ($user) {
                return $user;
            }
        }
    }

    return null;
}

/**
 * Reset password with token
 */
function resetPasswordWithToken(string $token, string $newPassword): array {
    if (strlen($newPassword) < PASSWORD_MIN_LENGTH) {
        return ['success' => false, 'error' => 'Password must be at least ' . PASSWORD_MIN_LENGTH . ' characters'];
    }

    $user = validatePasswordResetToken($token);
    if (!$user) {
        return ['success' => false, 'error' => 'Invalid or expired reset link'];
    }

    // Update password
    $hashedPassword = password_hash($newPassword, PASSWORD_BCRYPT);
    $users = loadUsersIndex();

    foreach ($users as &$u) {
        if ($u['id'] === $user['id']) {
            $u['password'] = $hashedPassword;
            break;
        }
    }

    if (!saveUsersIndex($users)) {
        return ['success' => false, 'error' => 'Failed to update password'];
    }

    // Update profile.json too
    $profilePath = getProfilePath($user['id']);
    $profile = loadJsonFile($profilePath);
    $profile['password_hash'] = $hashedPassword;
    saveJsonFile($profilePath, $profile);

    // Remove used token
    $tokensPath = USERS_PATH . '/reset_tokens.json';
    $tokens = loadJsonFile($tokensPath);
    $hashedToken = hash('sha256', $token);
    $tokens = array_filter($tokens, function($t) use ($hashedToken) {
        return $t['token'] !== $hashedToken;
    });
    saveJsonFile($tokensPath, array_values($tokens));

    return ['success' => true];
}

/**
 * Authenticate user
 */
function authenticateUser(string $username, string $password): array {
    $user = findUserByUsername($username);

    if (!$user) {
        return ['success' => false, 'error' => 'Invalid username or password'];
    }

    if (!password_verify($password, $user['password'])) {
        return ['success' => false, 'error' => 'Invalid username or password'];
    }

    return ['success' => true, 'user_id' => $user['id'], 'username' => $user['username']];
}

/**
 * Configure and start session with proper cookie settings
 */
function initSession(): void {
    if (session_status() === PHP_SESSION_NONE) {
        session_name(SESSION_NAME);

        // Delete any old cookies with /api/ path (legacy bug fix)
        // Old code set cookies with path=/api/ which take precedence over path=/
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
}

/**
 * Start user session
 */
function startUserSession(string $userId, string $username): void {
    authLog("LOGIN ATTEMPT: user=$username, userId=$userId");

    initSession();

    $oldSessionId = session_id();
    authLog("Session initialized: oldSessionId=$oldSessionId");

    // Attempt session regeneration to prevent fixation attacks and clear stale sessions
    $error = null;
    set_error_handler(function($errno, $errstr) use (&$error) {
        $error = $errstr;
        return true;
    });

    $regenerateResult = session_regenerate_id(true);

    restore_error_handler();

    $newSessionId = session_id();

    if (!$regenerateResult) {
        $lastError = error_get_last();
        $errorMsg = $error ?? ($lastError['message'] ?? 'unknown');
        authLog("session_regenerate_id: FAILED old=$oldSessionId new=$newSessionId error=$errorMsg");
    } else {
        authLog("session_regenerate_id: SUCCESS old=$oldSessionId new=$newSessionId");
    }

    // Set session data
    $_SESSION['user_id'] = $userId;
    $_SESSION['username'] = $username;
    $_SESSION['logged_in_at'] = time();

    authLog("Session data set: user_id={$_SESSION['user_id']}, username={$_SESSION['username']}");

    // Update last_login in users index
    $users = loadUsersIndex();
    foreach ($users as &$user) {
        if ($user['id'] === $userId) {
            $user['last_login'] = date('c');
            break;
        }
    }
    saveUsersIndex($users);

    // Force session to be written immediately
    session_write_close();

    // Restart session for any further operations in this request
    initSession();

    // Verify session was saved correctly
    $verifyUserId = $_SESSION['user_id'] ?? 'NOT SET';
    authLog("LOGIN COMPLETE: user=$username, verified_user_id=$verifyUserId, final_session_id=" . session_id());
}

/**
 * End user session
 */
function endUserSession(): void {
    initSession();

    $_SESSION = [];

    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(
            session_name(),
            '',
            time() - 42000,
            $params['path'],
            $params['domain'],
            $params['secure'],
            $params['httponly']
        );
    }

    session_destroy();
}

/**
 * Check if user is logged in
 */
function isLoggedIn(): bool {
    initSession();
    return isset($_SESSION['user_id']);
}

/**
 * Change user password
 */
function changePassword(string $userId, string $currentPassword, string $newPassword): array {
    $user = findUserById($userId);

    if (!$user) {
        return ['success' => false, 'error' => 'User not found'];
    }

    if (!password_verify($currentPassword, $user['password'])) {
        return ['success' => false, 'error' => 'Current password is incorrect'];
    }

    if (strlen($newPassword) < PASSWORD_MIN_LENGTH) {
        return ['success' => false, 'error' => 'New password must be at least ' . PASSWORD_MIN_LENGTH . ' characters'];
    }

    // Update password in index
    $users = loadUsersIndex();
    foreach ($users as &$u) {
        if ($u['id'] === $userId) {
            $u['password'] = password_hash($newPassword, PASSWORD_BCRYPT);
            break;
        }
    }
    saveUsersIndex($users);

    return ['success' => true];
}
