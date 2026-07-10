<?php
/**
 * IP bans list for the report page — report users only.
 * Fetches /ip-bans from the Lightsail wmt-server with the admin key held
 * server-side. Split out of report.php 2026-07-09 so a slow Lightsail
 * response can't block the report page render (it was a synchronous
 * 3s-timeout fetch before any HTML was emitted).
 */
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/functions.php';

initSession();
header('Content-Type: application/json');

if (!isReportUser()) {
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => 'Forbidden']);
    exit;
}

$adminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;
if (!$adminKey) {
    echo json_encode(['success' => true, 'bans' => []]);
    exit;
}

$ctx = stream_context_create([
    'http' => ['timeout' => 5, 'header' => "X-Admin-Key: {$adminKey}\r\n", 'ignore_errors' => true],
    'ssl' => ['verify_peer' => true, 'verify_peer_name' => true],
]);
$body = @file_get_contents('https://ws.wemudtogether.com/ip-bans', false, $ctx);
if ($body === false) {
    http_response_code(502);
    echo json_encode(['success' => false, 'error' => 'Could not reach the ban list']);
    exit;
}
$parsed = json_decode($body, true);
if (!is_array($parsed) || empty($parsed['success'])) {
    echo json_encode(['success' => true, 'bans' => []]);
    exit;
}
echo json_encode(['success' => true, 'bans' => $parsed['bans'] ?? []]);
