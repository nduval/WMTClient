<?php
/**
 * WMT Client - Server Logs API
 *
 * Server-to-server endpoint for persisting Render session/connection logs
 * so they survive deploys and restarts.
 *
 * All actions require admin key authentication.
 */

require_once __DIR__ . '/../includes/functions.php';

// Admin key authentication (server-to-server only)
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

$action = $_GET['action'] ?? '';
$logsFile = DATA_PATH . '/logs/server_logs.json';
$maxEntries = 2000;

switch ($action) {
    case 'save':
        // Append a batch of log entries from Render
        // POST with JSON body: { logs: [...] }
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('POST required', 405);
        }

        $input = json_decode(file_get_contents('php://input'), true);
        if (!$input || !isset($input['logs']) || !is_array($input['logs'])) {
            errorResponse('logs array required', 400);
        }

        // Load existing logs
        $existing = loadJsonFile($logsFile);
        $receivedAt = date('c');

        // Append new entries with receivedAt timestamp
        foreach ($input['logs'] as $entry) {
            if (!is_array($entry) || empty($entry['time'])) {
                continue; // Skip malformed entries
            }
            $entry['receivedAt'] = $receivedAt;
            $existing[] = $entry;
        }

        // Trim to max entries (drop oldest)
        if (count($existing) > $maxEntries) {
            $existing = array_slice($existing, count($existing) - $maxEntries);
        }

        if (!saveJsonFile($logsFile, $existing)) {
            errorResponse('Failed to save logs', 500);
        }

        successResponse([
            'message' => 'Logs saved',
            'added' => count($input['logs']),
            'total' => count($existing)
        ]);
        break;

    case 'list':
        // Retrieve persisted logs with optional filters
        // GET with optional params: ?type=DISCORD&since=ISO-timestamp&limit=200
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            errorResponse('GET required', 405);
        }

        $logs = loadJsonFile($logsFile);

        // Filter by type prefix
        $typeFilter = $_GET['type'] ?? '';
        if ($typeFilter !== '') {
            $logs = array_filter($logs, function($entry) use ($typeFilter) {
                return isset($entry['type']) && strpos($entry['type'], $typeFilter) === 0;
            });
        }

        // Filter by since timestamp
        $since = $_GET['since'] ?? '';
        if ($since !== '') {
            $sinceTime = strtotime($since);
            if ($sinceTime !== false) {
                $logs = array_filter($logs, function($entry) use ($sinceTime) {
                    $entryTime = strtotime($entry['time'] ?? '1970-01-01');
                    return $entryTime >= $sinceTime;
                });
            }
        }

        // Apply limit
        $limit = min(max((int)($_GET['limit'] ?? 200), 1), $maxEntries);
        $logs = array_values($logs);
        if (count($logs) > $limit) {
            // Return most recent entries
            $logs = array_slice($logs, count($logs) - $limit);
        }

        successResponse([
            'count' => count($logs),
            'logs' => $logs
        ]);
        break;

    case 'clear':
        // Wipe all stored logs
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('POST required', 405);
        }

        if (!saveJsonFile($logsFile, [])) {
            errorResponse('Failed to clear logs', 500);
        }

        successResponse(['message' => 'All logs cleared']);
        break;

    default:
        errorResponse('Invalid action. Valid: save, list, clear', 400);
}
