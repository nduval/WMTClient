<?php
/**
 * WMT Client Authentication API
 */

require_once __DIR__ . '/../includes/auth.php';

// Initialize session with proper cookie path
initSession();

header('Content-Type: application/json');

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

switch ($action) {
    case 'register':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $username = $data['username'] ?? '';
        $password = $data['password'] ?? '';
        $email = $data['email'] ?? '';

        if (empty($username) || empty($password) || empty($email)) {
            errorResponse('Username, email, and password are required');
        }

        $result = registerUser($username, $password, $email);

        if ($result['success']) {
            startUserSession($result['user_id'], $result['username']);
            successResponse([
                'user_id' => $result['user_id'],
                'username' => $result['username']
            ]);
        } else {
            errorResponse($result['error']);
        }
        break;

    case 'forgot-password':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        require_once __DIR__ . '/../includes/email.php';

        $data = json_decode(file_get_contents('php://input'), true);
        $email = trim($data['email'] ?? '');

        if (empty($email)) {
            errorResponse('Email is required');
        }

        // Always return success to prevent email enumeration
        $tokenData = createPasswordResetToken($email);

        if ($tokenData) {
            // Determine base URL
            $protocol = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
            $host = $_SERVER['HTTP_HOST'];
            $path = dirname($_SERVER['SCRIPT_NAME']);
            $baseUrl = $protocol . '://' . $host . $path;
            $baseUrl = rtrim($baseUrl, '/api');

            $result = sendPasswordResetEmail(
                $tokenData['email'],
                $tokenData['username'],
                $tokenData['token'],
                $baseUrl
            );

            if (!$result['success']) {
                error_log("Failed to send reset email: " . ($result['error'] ?? 'Unknown error'));
            }
        }

        // Always return success to prevent email enumeration
        successResponse(['message' => 'If an account with that email exists, a reset link has been sent.']);
        break;

    case 'reset-password':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $token = $data['token'] ?? '';
        $password = $data['password'] ?? '';

        if (empty($token) || empty($password)) {
            errorResponse('Token and password are required');
        }

        $result = resetPasswordWithToken($token, $password);

        if ($result['success']) {
            successResponse(['message' => 'Password has been reset. You can now log in.']);
        } else {
            errorResponse($result['error']);
        }
        break;

    case 'validate-reset-token':
        $token = $_GET['token'] ?? '';

        if (empty($token)) {
            errorResponse('Token is required');
        }

        $user = validatePasswordResetToken($token);

        if ($user) {
            successResponse(['valid' => true, 'username' => $user['username']]);
        } else {
            errorResponse('Invalid or expired reset link');
        }
        break;

    case 'login':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        $data = json_decode(file_get_contents('php://input'), true);
        $username = $data['username'] ?? '';
        $password = $data['password'] ?? '';

        if (empty($username) || empty($password)) {
            errorResponse('Username and password are required');
        }

        $result = authenticateUser($username, $password);

        if ($result['success']) {
            startUserSession($result['user_id'], $result['username']);
            successResponse([
                'user_id' => $result['user_id'],
                'username' => $result['username']
            ]);
        } else {
            errorResponse($result['error']);
        }
        break;

    case 'logout':
        endUserSession();
        successResponse(['message' => 'Logged out successfully']);
        break;

    case 'check':
        if (isLoggedIn()) {
            successResponse([
                'logged_in' => true,
                'user_id' => getCurrentUserId(),
                'username' => getCurrentUsername()
            ]);
        } else {
            successResponse(['logged_in' => false]);
        }
        break;

    case 'change-password':
        if ($method !== 'POST') {
            errorResponse('Method not allowed', 405);
        }

        requireAuth();

        $data = json_decode(file_get_contents('php://input'), true);
        $currentPassword = $data['current_password'] ?? '';
        $newPassword = $data['new_password'] ?? '';

        if (empty($currentPassword) || empty($newPassword)) {
            errorResponse('Current and new passwords are required');
        }

        $result = changePassword(getCurrentUserId(), $currentPassword, $newPassword);

        if ($result['success']) {
            successResponse(['message' => 'Password changed successfully']);
        } else {
            errorResponse($result['error']);
        }
        break;

    case 'session-logs':
        // Admin-only endpoint to fetch auth/session logs for debugging
        requireAuth();

        $ADMIN_USERS = ['nathan'];
        if (!in_array(getCurrentUsername(), $ADMIN_USERS)) {
            errorResponse('Admin access required', 403);
        }

        $logFile = __DIR__ . '/../data/logs/auth.log';
        $lines = [];
        $limit = isset($_GET['limit']) ? min(500, max(1, (int)$_GET['limit'])) : 200;

        if (file_exists($logFile)) {
            // Read last N lines efficiently
            $file = new SplFileObject($logFile, 'r');
            $file->seek(PHP_INT_MAX);
            $totalLines = $file->key();

            $startLine = max(0, $totalLines - $limit);
            $file->seek($startLine);

            while (!$file->eof()) {
                $line = trim($file->fgets());
                if (!empty($line)) {
                    $lines[] = $line;
                }
            }
        }

        successResponse([
            'count' => count($lines),
            'limit' => $limit,
            'logs' => $lines
        ]);
        break;

    default:
        errorResponse('Invalid action', 400);
}
