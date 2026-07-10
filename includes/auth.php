<?php
/**
 * WMT Client Authentication Functions
 */

require_once __DIR__ . '/functions.php';
require_once __DIR__ . '/security.php';

/**
 * Fire-and-forget account sync to Lightsail DB.
 * JSON on IONOS stays primary — this is the backup copy.
 * If the call fails, nothing breaks. Back out: delete this function
 * and its call sites.
 */
function syncAccountToDb(string $action, array $user): void {
    $adminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;
    if (!$adminKey) return;

    // WS_SERVER_URL might not be defined — use the known Lightsail endpoint
    $url = 'https://ws.wemudtogether.com/account-sync';

    $payload = json_encode([
        'action' => $action,
        'user' => $user
    ]);

    // Non-blocking: use a short timeout, ignore failures
    $ctx = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\nX-Admin-Key: $adminKey\r\n",
            'content' => $payload,
            'timeout' => 3,
            'ignore_errors' => true
        ],
        'ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true
        ]
    ]);

    @file_get_contents($url, false, $ctx);
}

// Emit security response headers and run the request inspector. Both run
// once per request (idempotent via constants). Headers MUST go out before
// any output, which is safe here because auth.php is included at the top
// of every entry point before any HTML.
emitSecurityHeaders();
inspectRequestForThreats();

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

// ─── Login rate limiting ─────────────────────────────────────
// Two parallel limits, both must pass for a login attempt to proceed:
//   1. Per-IP   — catches a single attacker hammering many usernames
//   2. Per-user — catches a botnet hammering a single account
// Successful logins clear both counters for the (ip, user) pair.
// Storage is a small JSON file under data/logs/ (denied via .htaccess).

const RATE_IP_THRESHOLD   = 20;   // failures within window
const RATE_IP_WINDOW      = 300;  // 5 min
const RATE_IP_LOCKOUT     = 900;  // 15 min
const RATE_USER_THRESHOLD = 10;   // failures within window
const RATE_USER_WINDOW    = 600;  // 10 min
const RATE_USER_LOCKOUT   = 900;  // 15 min

function _loginRateLimitPath(): string {
    return __DIR__ . '/../data/logs/login_attempts.json';
}

function _loadLoginRateData(): array {
    $path = _loginRateLimitPath();
    if (!file_exists($path)) return ['ip' => [], 'user' => []];
    $raw = @file_get_contents($path);
    $data = $raw ? json_decode($raw, true) : null;
    if (!is_array($data)) $data = [];
    if (!isset($data['ip']))   $data['ip']   = [];
    if (!isset($data['user'])) $data['user'] = [];
    return $data;
}

function _saveLoginRateData(array $data): void {
    $path = _loginRateLimitPath();
    $dir  = dirname($path);
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    @file_put_contents($path, json_encode($data), LOCK_EX);
}

function _pruneRateBucket(array &$bucket, int $window): void {
    $cutoff = time() - $window;
    if (isset($bucket['failures']) && is_array($bucket['failures'])) {
        $bucket['failures'] = array_values(array_filter($bucket['failures'], function($t) use ($cutoff) {
            return $t > $cutoff;
        }));
    }
    if (isset($bucket['lockedUntil']) && $bucket['lockedUntil'] <= time()) {
        unset($bucket['lockedUntil']);
    }
}

/**
 * Check login rate limit before attempting authentication.
 * Returns null if OK, or ['reason' => 'ip'|'user', 'retryAfter' => seconds] if blocked.
 */
function checkLoginRateLimit(string $ip, string $username): ?array {
    $data = _loadLoginRateData();
    $now = time();
    $userKey = strtolower($username);

    if (isset($data['ip'][$ip]['lockedUntil']) && $data['ip'][$ip]['lockedUntil'] > $now) {
        return [
            'reason' => 'ip',
            'retryAfter' => $data['ip'][$ip]['lockedUntil'] - $now,
        ];
    }
    if (isset($data['user'][$userKey]['lockedUntil']) && $data['user'][$userKey]['lockedUntil'] > $now) {
        return [
            'reason' => 'user',
            'retryAfter' => $data['user'][$userKey]['lockedUntil'] - $now,
        ];
    }
    return null;
}

/**
 * Record a failed login attempt against both the IP and the username buckets.
 * If either bucket reaches its threshold, lock that bucket and clear its failures.
 */
function recordLoginFailure(string $ip, string $username): void {
    $data = _loadLoginRateData();
    $now = time();
    $userKey = strtolower($username);

    // IP bucket
    if (!isset($data['ip'][$ip])) {
        $data['ip'][$ip] = ['failures' => []];
    }
    _pruneRateBucket($data['ip'][$ip], RATE_IP_WINDOW);
    $data['ip'][$ip]['failures'][] = $now;
    if (count($data['ip'][$ip]['failures']) >= RATE_IP_THRESHOLD) {
        $data['ip'][$ip]['lockedUntil'] = $now + RATE_IP_LOCKOUT;
        $data['ip'][$ip]['failures'] = [];
        authLog("RATE_LIMIT IP_LOCKED ip=$ip until=" . date('c', $data['ip'][$ip]['lockedUntil']));
    }

    // User bucket
    if (!isset($data['user'][$userKey])) {
        $data['user'][$userKey] = ['failures' => []];
    }
    _pruneRateBucket($data['user'][$userKey], RATE_USER_WINDOW);
    $data['user'][$userKey]['failures'][] = $now;
    if (count($data['user'][$userKey]['failures']) >= RATE_USER_THRESHOLD) {
        $data['user'][$userKey]['lockedUntil'] = $now + RATE_USER_LOCKOUT;
        $data['user'][$userKey]['failures'] = [];
        authLog("RATE_LIMIT USER_LOCKED user=$userKey until=" . date('c', $data['user'][$userKey]['lockedUntil']));
    }

    _saveLoginRateData($data);
}

/**
 * Clear rate limit counters for both buckets after a successful login.
 * Also opportunistically prunes stale entries to keep the file small.
 */
function recordLoginSuccess(string $ip, string $username): void {
    $data = _loadLoginRateData();
    $userKey = strtolower($username);
    $now = time();

    if (isset($data['ip'][$ip])) {
        $data['ip'][$ip]['failures'] = [];
        unset($data['ip'][$ip]['lockedUntil']);
    }
    if (isset($data['user'][$userKey])) {
        $data['user'][$userKey]['failures'] = [];
        unset($data['user'][$userKey]['lockedUntil']);
    }

    // Opportunistic GC: drop empty/expired entries from BOTH buckets so the
    // file stays bounded over time without needing a separate cron job.
    foreach (['ip' => RATE_IP_WINDOW, 'user' => RATE_USER_WINDOW] as $kind => $window) {
        foreach ($data[$kind] as $key => &$bucket) {
            _pruneRateBucket($bucket, $window);
            if (empty($bucket['failures']) && (!isset($bucket['lockedUntil']) || $bucket['lockedUntil'] <= $now)) {
                unset($data[$kind][$key]);
            }
        }
        unset($bucket);
    }

    _saveLoginRateData($data);
}

/**
 * Get the client's real IP address (handles proxies)
 */
function getClientIp(): string {
    // Check common proxy headers
    if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
        // Take the first IP (original client)
        $ips = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
        return trim($ips[0]);
    }
    if (!empty($_SERVER['HTTP_X_REAL_IP'])) {
        return trim($_SERVER['HTTP_X_REAL_IP']);
    }
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
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
 * Find user by username — DB first, JSON safety-net fallback.
 */
function findUserByUsername(string $username): ?array {
    return userWithJsonFallback('username', $username);
}

/**
 * Find user by ID — DB first, JSON safety-net fallback.
 */
function findUserById(string $id): ?array {
    return userWithJsonFallback('id', $id);
}

/**
 * Check if user is a wizard (no session timeout)
 */
function isUserWizard(string $userId): bool {
    $user = findUserById($userId);
    return $user['isWizard'] ?? false;
}

/**
 * Set wizard status for a user
 */
function setUserWizard(string $userId, bool $isWizard): bool {
    $users = loadUsersIndex();

    foreach ($users as &$user) {
        if ($user['id'] === $userId) {
            $user['isWizard'] = $isWizard;
            $saved = saveUsersIndex($users);
            // Sync to the Lightsail DB — reads are DB-first (findUserById,
            // usersIndexWithJsonFallback), so a JSON-only write is invisible:
            // the admin toggle said "success" but nothing changed (igor,
            // 2026-07-10). /admin/user does a PARTIAL update (only isWizard);
            // do NOT use /account-sync 'update' here — it overwrites
            // username/email/password with whatever is passed.
            if ($saved) {
                $resp = pushToLightsail('/admin/user', ['id' => $userId, 'isWizard' => $isWizard]);
                if (!$resp || empty($resp['success'])) {
                    @error_log("setUserWizard: DB sync failed for $userId — JSON updated but DB (the read path) was not");
                    return false;   // surface it — a 'success' banner over a no-op is worse than an error
                }
            }
            return $saved;
        }
    }

    return false;
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
    $ip = getClientIp();
    authLog("REGISTER: user=$username, userId=$userId, email=$email, ip=$ip");
    initializeUserData($userId, $username, $hashedPassword, $email, $ip);

    // Add to users index
    $users = loadUsersIndex();
    $users[] = $user;
    if (!saveUsersIndex($users)) {
        error_log("registerUser: CRITICAL - Failed to save users_index for user $username ($userId)");
        // User data exists in profile.json, can be recovered via admin
    }

    // Sync new account to Lightsail DB (fire-and-forget)
    syncAccountToDb('register', [
        'id' => $userId, 'username' => $username, 'email' => $email,
        'password' => $hashedPassword, 'created_at' => date('c')
    ]);

    return ['success' => true, 'user_id' => $userId, 'username' => $username];
}

/**
 * Find user by email — DB first, JSON safety-net fallback.
 */
function findUserByEmail(string $email): ?array {
    return userWithJsonFallback('email', $email);
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

    // Check if user is banned
    if (isUserBanned($user['id'])) {
        $ip = getClientIp();
        authLog("LOGIN BLOCKED (banned): user=$username, userId={$user['id']}, ip=$ip");
        return ['success' => false, 'error' => 'This account has been suspended.'];
    }

    return ['success' => true, 'user_id' => $user['id'], 'username' => $user['username']];
}

/**
 * Check if a user is banned — DB first via findUserById (which uses safety net).
 * Falls through to profile.json as deepest fallback if both DB and users_index lack a record.
 */
function isUserBanned(string $userId): bool {
    $user = findUserById($userId);
    if ($user !== null && array_key_exists('banned', $user)) {
        return !empty($user['banned']);
    }
    // Deepest fallback: profile.json (legacy ban storage).
    $profile = loadJsonFile(getProfilePath($userId));
    return !empty($profile['banned']);
}

/**
 * Ban or unban a user
 */
function setUserBanned(string $userId, bool $banned, string $reason = ''): bool {
    $path = getProfilePath($userId);
    $profile = loadJsonFile($path);
    if (empty($profile)) return false;

    if ($banned) {
        $profile['banned'] = true;
        $profile['banned_at'] = date('c');
        if ($reason) $profile['ban_reason'] = $reason;
    } else {
        unset($profile['banned'], $profile['banned_at'], $profile['ban_reason']);
    }

    $result = saveJsonFile($path, $profile);

    // Sync ban status to Lightsail DB (fire-and-forget)
    if ($result) {
        syncAccountToDb('ban', [
            'id' => $userId, 'banned' => $banned, 'ban_reason' => $reason
        ]);
    }

    return $result;
}

/**
 * Configure and start session with proper cookie settings
 */
function initSession(): void {
    if (session_status() === PHP_SESSION_NONE) {
        session_name(SESSION_NAME);

        // Use a custom session save path inside our data directory.
        // On shared hosting (IONOS), system cron cleans /tmp sessions using the
        // global gc_maxlifetime (typically 24 min), ignoring per-app overrides.
        // Our own directory is immune to that cleanup.
        $sessionDir = DATA_PATH . '/sessions';
        if (!is_dir($sessionDir)) {
            @mkdir($sessionDir, 0700, true);
        }
        session_save_path($sessionDir);

        // Match server-side session lifetime to cookie lifetime
        // Default gc_maxlifetime is 24 minutes — far too short for a MUD client
        ini_set('session.gc_maxlifetime', SESSION_LIFETIME);

        // Strict mode: never ADOPT an unknown session id supplied by the request
        // cookie. If the cookie points at a session that session_regenerate_id() or GC
        // deleted, PHP issues a FRESH id instead of re-creating that id as an empty
        // session. Without this, a browser that kept a stale/dead cookie kept getting
        // its dead id resurrected as an empty (user_id NOT SET) session → a PERMANENT
        // "session expired" 401 loop. With strict mode it gets one fresh empty session
        // and a clean re-login sticks. (2026-06-27 double-login investigation.)
        ini_set('session.use_strict_mode', '1');

        // NOTE: the old per-request `setcookie(SESSION_NAME,'',-3600,'/api/')` legacy
        // clear was removed here — no code sets a path=/api/ session cookie anymore, so
        // it was vestigial, and emitting it on EVERY request (incl. the login response)
        // added Set-Cookie churn that helped the regenerated login cookie lose the race.

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
    $ip = getClientIp();
    authLog("LOGIN ATTEMPT: user=$username, userId=$userId, ip=$ip");

    initSession();

    $oldSessionId = session_id();
    authLog("Session initialized: oldSessionId=$oldSessionId");

    // IDEMPOTENT RE-LOGIN — do NOT regenerate if this browser already holds a VALID
    // session for the SAME user. session_regenerate_id(true) DESTROYS the current
    // session file; on a second login POST (two tabs, a back-button, or an app.php
    // "session expired" banner racing a fresh login) that id is the one the browser
    // is still actively using. Its in-flight/next request carries the pre-regenerate
    // cookie, hits the now-deleted id, and use_strict_mode (correctly) mints a fresh
    // EMPTY session → user_id NOT SET → the permanent "need to authenticate" loop the
    // user sees ("hit login, nothing; hit again, char screen says re-authenticate").
    // Regeneration exists for session-FIXATION protection, which only matters on the
    // anonymous→authenticated transition — re-authenticating the same already-logged-in
    // user is not a privilege change, so keeping the existing id is safe AND is exactly
    // what stops the loop (the old cookie stays live). PROVEN root of the 2026-07-04
    // recurrence from IONOS auth.log (login #2 regen'd the id login #1's browser was
    // using). Different user (account switch) or no current user still regenerates.
    $currentUserId = $_SESSION['user_id'] ?? null;
    $sameUserRelogin = ($currentUserId !== null && $currentUserId === $userId);

    if ($sameUserRelogin) {
        $newSessionId = $oldSessionId;
        authLog("session_regenerate_id: SKIPPED (same-user re-login, keeping id=$oldSessionId)");
    } else {
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

    // Capture the verification value while the session is still open.
    $verifyUserId = $_SESSION['user_id'] ?? 'NOT SET';

    // Force session to be written immediately, then DO NOT re-open it.
    //
    // A second initSession()/session_start() here was the root of the
    // intermittent double-login ("logged in, then immediately need to
    // authenticate"): after write_close the SAPI re-reads the *request*
    // cookie ($_COOKIE still holds the pre-regeneration id) and, on some
    // SAPIs, resumes/re-emits the OLD session id whose file regenerate_id
    // already deleted — so the browser stores a dead session and the next
    // request is DENIED. The post-login steps below (profile fields, DB
    // sync) and both callers' success responses are all $_SESSION-free, so
    // there is nothing left in this request that needs the session open.
    session_write_close();

    authLog("LOGIN COMPLETE: user=$username, verified_user_id=$verifyUserId, final_session_id=$newSessionId, ip=$ip");

    // Store last IP in user profile
    updateUserProfileField($userId, 'last_ip', $ip);
    updateUserProfileField($userId, 'last_login_at', date('c'));

    // Sync login to Lightsail DB (fire-and-forget)
    syncAccountToDb('login', [
        'id' => $userId, 'username' => $username,
        'last_login' => date('c'), 'last_ip' => $ip
    ]);
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

    // Clear WebSocket token cookies (ws_token_* pattern)
    // These persist session tokens for reconnection; clear them on logout
    foreach ($_COOKIE as $name => $value) {
        if (strpos($name, 'ws_token_') === 0) {
            setcookie($name, '', [
                'expires' => time() - 3600,
                'path' => '/',
                'secure' => isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on',
                'httponly' => true,
                'samesite' => 'Lax'
            ]);
        }
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

    // Sync password change to Lightsail DB (fire-and-forget)
    syncAccountToDb('password_change', [
        'id' => $userId, 'username' => $user['username'],
        'email' => $user['email'] ?? '', 'password' => password_hash($newPassword, PASSWORD_BCRYPT)
    ]);

    return ['success' => true];
}
