<?php
/**
 * WMT Client - Admin proxy to the Lightsail wmt-server admin HTTP endpoints.
 *
 * Keeps RENDER_ADMIN_KEY server-side: admin.php's browser JS calls this
 * instead of embedding the key in the page source (2026-07-09 review —
 * an XSS on the admin page could previously read the key out of the HTML).
 *
 *   GET  ?action=sessions   → GET  https://ws.wemudtogether.com/sessions
 *   POST ?action=broadcast  → POST https://ws.wemudtogether.com/broadcast
 *        body: {"message": "...", "csrf_token": "..."}
 *
 * Session-authenticated, admin usernames only.
 */

require_once __DIR__ . '/../includes/functions.php';
require_once __DIR__ . '/../includes/auth.php';

initSession();
header('Content-Type: application/json');

// Same admin gate as admin.php (shared list — adminUsernames() in functions.php)
if (!isAdminUser()) {
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => 'Admin only']);
    exit;
}

$adminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;
if (!$adminKey) {
    http_response_code(503);
    echo json_encode(['success' => false, 'error' => 'Admin key not configured']);
    exit;
}

function adminProxyContext(string $method, string $adminKey, ?string $payload = null) {
    $header = "X-Admin-Key: $adminKey\r\n";
    $http = ['method' => $method, 'header' => $header, 'timeout' => 8, 'ignore_errors' => true];
    if ($payload !== null) {
        $http['header'] .= "Content-Type: application/json\r\nContent-Length: " . strlen($payload) . "\r\n";
        $http['content'] = $payload;
    }
    return stream_context_create([
        'http' => $http,
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
    ]);
}

$action = $_GET['action'] ?? '';

if ($action === 'sessions' && $_SERVER['REQUEST_METHOD'] === 'GET') {
    $body = @file_get_contents('https://ws.wemudtogether.com/sessions', false, adminProxyContext('GET', $adminKey));
    if ($body === false) {
        http_response_code(502);
        echo json_encode(['success' => false, 'error' => 'Could not reach the session server']);
        exit;
    }
    echo $body;   // pass through wmt-server's JSON verbatim
    exit;
}

if ($action === 'broadcast' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true) ?: [];
    // Broadcast is an action (not a read) — require the session CSRF token.
    if (!validateCsrfToken($input['csrf_token'] ?? null)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Invalid CSRF token']);
        exit;
    }
    $message = trim((string)($input['message'] ?? ''));
    if ($message === '') {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Message required']);
        exit;
    }
    $payload = json_encode(['message' => $message]);
    $body = @file_get_contents('https://ws.wemudtogether.com/broadcast', false, adminProxyContext('POST', $adminKey, $payload));
    if ($body === false) {
        http_response_code(502);
        echo json_encode(['success' => false, 'error' => 'Could not reach the session server']);
        exit;
    }
    echo $body;
    exit;
}

http_response_code(400);
echo json_encode(['success' => false, 'error' => 'Unknown action']);
