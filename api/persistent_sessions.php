<?php
/**
 * WMT Client - Persistent Sessions API
 *
 * Server-to-server endpoint for storing/retrieving active MUD sessions
 * that should survive Render server restarts.
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
$sessionsFile = DATA_PATH . '/persistent_sessions.json';

switch ($action) {
    case 'save':
        // Save wizard sessions for restore after restart
        // POST with JSON body: { sessions: [...] }
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('POST required', 405);
        }

        $input = json_decode(file_get_contents('php://input'), true);
        if (!$input || !isset($input['sessions'])) {
            errorResponse('sessions array required', 400);
        }

        $sessions = [];
        foreach ($input['sessions'] as $session) {
            // Validate required fields
            if (empty($session['userId']) || empty($session['characterId']) || empty($session['token'])) {
                continue; // Skip invalid entries
            }

            $sessions[] = [
                'userId' => $session['userId'],
                'characterId' => $session['characterId'],
                'characterName' => $session['characterName'] ?? '',
                'server' => $session['server'] ?? '3k',
                'token' => $session['token'],
                'isWizard' => $session['isWizard'] ?? false,
                'persistedAt' => $session['persistedAt'] ?? (time() * 1000),
                'savedAt' => date('c')
            ];
        }

        if (!saveJsonFile($sessionsFile, $sessions)) {
            errorResponse('Failed to save sessions', 500);
        }

        successResponse([
            'message' => 'Sessions saved',
            'count' => count($sessions)
        ]);
        break;

    case 'list':
        // Get sessions to restore
        if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
            errorResponse('GET required', 405);
        }

        $sessions = loadJsonFile($sessionsFile);

        // Filter out sessions older than 5 minutes (stale sessions from previous deploys)
        $cutoff = strtotime('-5 minutes');
        $validSessions = array_filter($sessions, function($s) use ($cutoff) {
            $savedAt = strtotime($s['savedAt'] ?? '1970-01-01');
            return $savedAt >= $cutoff;
        });

        successResponse([
            'sessions' => array_values($validSessions)
        ]);
        break;

    case 'remove':
        // Remove a specific session after successful restore
        // POST with JSON body: { token: "..." }
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('POST required', 405);
        }

        $input = json_decode(file_get_contents('php://input'), true);
        if (!$input || empty($input['token'])) {
            errorResponse('token required', 400);
        }

        $sessions = loadJsonFile($sessionsFile);
        $tokenToRemove = $input['token'];

        $sessions = array_filter($sessions, function($s) use ($tokenToRemove) {
            return $s['token'] !== $tokenToRemove;
        });

        if (!saveJsonFile($sessionsFile, array_values($sessions))) {
            errorResponse('Failed to update sessions', 500);
        }

        successResponse(['message' => 'Session removed']);
        break;

    case 'clear':
        // Clear all persistent sessions
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
            errorResponse('POST required', 405);
        }

        if (!saveJsonFile($sessionsFile, [])) {
            errorResponse('Failed to clear sessions', 500);
        }

        successResponse(['message' => 'All sessions cleared']);
        break;

    default:
        errorResponse('Invalid action. Valid: save, list, remove, clear', 400);
}
