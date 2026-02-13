<?php
/**
 * Discord Webhook Proxy
 * Routes Discord webhooks through IONOS to avoid Cloudflare blocking Render's IPs
 */

header('Content-Type: application/json');

// Only allow POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POST required']);
    exit;
}

// Require admin key authentication (server-to-server only)
require_once __DIR__ . '/../config/config.php';

$adminKey = $_SERVER['HTTP_X_ADMIN_KEY'] ?? '';
$configAdminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;

if (!$configAdminKey || $adminKey !== $configAdminKey) {
    http_response_code(403);
    echo json_encode(['error' => 'Invalid admin key']);
    exit;
}

// Parse request
$input = json_decode(file_get_contents('php://input'), true);
$webhookUrl = $input['webhook_url'] ?? '';
$message = $input['message'] ?? '';
$username = $input['username'] ?? 'WMT Client';

if (empty($webhookUrl) || empty($message)) {
    http_response_code(400);
    echo json_encode(['error' => 'webhook_url and message required']);
    exit;
}

// Validate Discord webhook URL
if (!preg_match('#^https://discord(app)?\.com/api/webhooks/#', $webhookUrl)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid Discord webhook URL']);
    exit;
}

// Forward to Discord
$payload = json_encode([
    'content' => $message,
    'username' => $username
]);

$ch = curl_init($webhookUrl);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 10);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$error = curl_error($ch);
curl_close($ch);

// Return result
if ($httpCode === 200 || $httpCode === 204) {
    echo json_encode(['success' => true]);
} else {
    http_response_code(502);
    echo json_encode([
        'error' => 'Discord returned ' . $httpCode,
        'response' => $response,
        'curl_error' => $error
    ]);
}
