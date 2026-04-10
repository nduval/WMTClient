<?php
/**
 * Audit log endpoint — called by server.js for reconnect/disconnect events.
 * Requires admin key authentication (server-to-server).
 */
require_once __DIR__ . '/../includes/functions.php';
require_once __DIR__ . '/../config/config.php';

header('Content-Type: application/json');

$adminKey = $_SERVER['HTTP_X_ADMIN_KEY'] ?? '';
$configAdminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;

if (!$configAdminKey || $adminKey !== $configAdminKey) {
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => 'Invalid admin key']);
    exit;
}

$input = json_decode(file_get_contents('php://input'), true);
if (!$input) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Invalid JSON']);
    exit;
}

$activity = $input['activity'] ?? '';
$account = $input['account'] ?? '';
$userId = $input['user_id'] ?? '';
$character = $input['character'] ?? '';
$realm = $input['realm'] ?? '3k';
$ip = $input['ip'] ?? '';

if (!$activity) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'activity required']);
    exit;
}

// Resolve account username from userId if not provided
if (!$account && $userId) {
    require_once __DIR__ . '/../includes/auth.php';
    $user = findUserById($userId);
    if ($user) $account = $user['username'];
}

auditLog($activity, $account ?: 'unknown', $character, $realm, $ip);
echo json_encode(['success' => true]);
