<?php
/**
 * WMT Client - Admin Panel
 * For backup, restore, and data management
 */

require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/functions.php';

initSession();

// Admin gate — the username list lives in adminUsernames() (functions.php),
// shared with api/admin_proxy.php so the two can't drift.
$ADMIN_USERS = adminUsernames();   // still used below for badges + delete guard

if (!isAdminUser()) {
    header('Location: index.php');
    exit;
}

$userId = getCurrentUserId();
$username = getCurrentUsername();
$csrfToken = generateCsrfToken();
$message = '';
$messageType = '';

// Handle actions
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';

    if (!validateCsrfToken($_POST['csrf_token'] ?? null)) {
        $message = 'Invalid CSRF token';
        $messageType = 'error';
    } else {
        switch ($action) {
            // backup/restore handlers removed 2026-05-10. They walked
            // data/users/{id}/ JSON files, but the migration moved
            // aliases/triggers/classes/tickers/preferences to the SQLite DB
            // — so a JSON backup captured stale state and a JSON restore
            // would write back data the read paths now ignore. Replaced by
            // a cron-driven sqlite3 .backup of /opt/wmt/wmt.db on Lightsail.
            // See memory: reference_db_backup.md for the cron + retention.
            //
            // adopt_orphan / delete_orphan / repair_index removed 2026-07-09.
            // All three predate the DB migration: they compared disk dirs
            // against the JSON users_index, but accounts are DB-first now
            // (userWithJsonFallback), so "orphaned vs the JSON index" no
            // longer means abandoned — a DB-only user's dir would have shown
            // as orphaned, and Delete would have destroyed their .tin files.
            // Adopt copied characters.json without syncing the DB (the
            // char-sync gap). Verified 0 orphan dirs on prod at removal.
            case 'delete_user':
                $targetUserId = $_POST['user_id'] ?? '';
                $confirmUsername = $_POST['confirm_username'] ?? '';
                if ($targetUserId) {
                    $result = deleteUserAccount($targetUserId, $confirmUsername);
                    if ($result['success']) {
                        $message = 'User account deleted: ' . $result['username'];
                        $messageType = 'success';
                    } else {
                        $message = 'Delete failed: ' . $result['error'];
                        $messageType = 'error';
                    }
                } else {
                    $message = 'User ID is required';
                    $messageType = 'error';
                }
                break;

            case 'send_reset_email':
                require_once __DIR__ . '/includes/email.php';
                $targetUserId = $_POST['user_id'] ?? '';
                if ($targetUserId) {
                    $result = adminSendResetEmail($targetUserId, getAdminEmail());
                    if ($result['success']) {
                        $message = 'Reset email sent to ' . $result['email'] . ' for user: ' . $result['username'];
                        if ($result['bcc']) {
                            $message .= ' (BCC sent to you)';
                        }
                        $messageType = 'success';
                    } else {
                        $message = 'Send failed: ' . $result['error'];
                        $messageType = 'error';
                    }
                } else {
                    $message = 'User ID is required';
                    $messageType = 'error';
                }
                break;

            case 'toggle_ban':
                $targetUserId = $_POST['user_id'] ?? '';
                $banReason = trim($_POST['ban_reason'] ?? '');
                if ($targetUserId) {
                    $profile = loadJsonFile(getProfilePath($targetUserId));
                    $currentlyBanned = !empty($profile['banned']);
                    if (setUserBanned($targetUserId, !$currentlyBanned, $banReason)) {
                        $user = findUserById($targetUserId);
                        $uname = $user['username'] ?? $targetUserId;
                        $message = ($currentlyBanned ? 'Unbanned' : 'Banned') . ' user: ' . $uname;
                        if (!$currentlyBanned) {
                            authLog("ADMIN BAN: user=$uname, userId=$targetUserId, reason=$banReason, by=$username");
                        } else {
                            authLog("ADMIN UNBAN: user=$uname, userId=$targetUserId, by=$username");
                        }
                        $messageType = 'success';
                    } else {
                        $message = 'Failed to update ban status';
                        $messageType = 'error';
                    }
                } else {
                    $message = 'User ID is required';
                    $messageType = 'error';
                }
                break;

            case 'toggle_wizard':
                $targetUserId = $_POST['user_id'] ?? '';
                if ($targetUserId) {
                    $currentStatus = isUserWizard($targetUserId);
                    $newStatus = !$currentStatus;
                    if (setUserWizard($targetUserId, $newStatus)) {
                        $user = findUserById($targetUserId);
                        $message = ($newStatus ? 'Enabled' : 'Disabled') . ' wizard status for: ' . ($user['username'] ?? $targetUserId);
                        $messageType = 'success';
                    } else {
                        $message = 'Failed to update wizard status';
                        $messageType = 'error';
                    }
                } else {
                    $message = 'User ID is required';
                    $messageType = 'error';
                }
                break;
        }
    }
}

// Helper functions for admin operations
// (createBackup / restoreBackup removed 2026-05-10 — see DB-backup cron)
// (getOrphanedDirectories / adoptOrphanedCharacters / deleteOrphanedDirectory /
//  repairUsersIndex removed 2026-07-09 — pre-DB-migration tooling; see the
//  removal note in the action switch above)

function deleteUserAccount(string $userId, string $confirmUsername): array {
    // Find user in index
    $users = loadUsersIndex();
    $userIndex = -1;
    $username = '';

    foreach ($users as $i => $user) {
        if ($user['id'] === $userId) {
            $userIndex = $i;
            $username = $user['username'];
            break;
        }
    }

    if ($userIndex === -1) {
        return ['success' => false, 'error' => 'User not found'];
    }

    // Require username confirmation for safety
    if (strtolower($confirmUsername) !== strtolower($username)) {
        return ['success' => false, 'error' => 'Username confirmation does not match'];
    }

    // Don't allow deleting admin accounts
    global $ADMIN_USERS;
    if (in_array($username, $ADMIN_USERS)) {
        return ['success' => false, 'error' => 'Cannot delete admin accounts'];
    }

    // Delete user directory
    $userPath = getUserDataPath($userId);
    if (is_dir($userPath)) {
        $files = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($userPath, RecursiveDirectoryIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );

        foreach ($files as $file) {
            if ($file->isDir()) {
                rmdir($file->getRealPath());
            } else {
                unlink($file->getRealPath());
            }
        }
        rmdir($userPath);
    }

    // Remove from users index
    array_splice($users, $userIndex, 1);
    if (!saveUsersIndex($users)) {
        return ['success' => false, 'error' => 'Failed to update users index'];
    }

    // Sync the deletion to Lightsail DB. Without this, the user's row in the
    // `users` table stays alive and the WS auth keeps accepting the account
    // even after the JSON-side delete. Pre-existed the JSON→DB migration;
    // fixed 2026-05-10 after the Yggdrasil/Dwolin attacker's `dwolin2`
    // account survived an admin-panel delete.
    syncAccountToDb('delete', ['id' => $userId]);

    return ['success' => true, 'username' => $username];
}

function getAdminEmail(): string {
    $adminUser = findUserByUsername(getCurrentUsername());
    return $adminUser['email'] ?? '';
}

function adminSendResetEmail(string $userId, string $bccEmail): array {
    // Find user
    $users = loadUsersIndex();
    $targetUser = null;

    foreach ($users as $user) {
        if ($user['id'] === $userId) {
            $targetUser = $user;
            break;
        }
    }

    if (!$targetUser) {
        return ['success' => false, 'error' => 'User not found'];
    }

    if (empty($targetUser['email'])) {
        return ['success' => false, 'error' => 'User has no email address registered'];
    }

    // Create reset token
    $tokenData = createPasswordResetToken($targetUser['email']);
    if (!$tokenData) {
        return ['success' => false, 'error' => 'Failed to create reset token'];
    }

    // Determine base URL
    $protocol = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'];
    $baseUrl = $protocol . '://' . $host;

    // Send email with BCC to admin
    $result = sendPasswordResetEmail(
        $tokenData['email'],
        $tokenData['username'],
        $tokenData['token'],
        $baseUrl,
        $bccEmail
    );

    if ($result['success']) {
        return [
            'success' => true,
            'username' => $targetUser['username'],
            'email' => $targetUser['email'],
            'bcc' => !empty($bccEmail)
        ];
    }

    return ['success' => false, 'error' => $result['error'] ?? 'Failed to send email'];
}

// getBackupFiles removed 2026-05-10. JSON backup feature retired after the
// DB migration; DB snapshots are handled by cron on Lightsail.

// Get data for display. DB-first with JSON-only entries merged in — the pure
// JSON index hid DB-only drift (the stale `dwolin` attacker row was invisible
// here until 2026-07-09 precisely because this page rendered JSON only).
$usersIndex = usersIndexWithJsonFallback();
// JSON backup feature removed 2026-05-10; DB backups handled by Lightsail cron.
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
    <title>Admin Panel - <?= APP_NAME ?></title>
    <link rel="stylesheet" href="assets/css/style.css?v=<?= filemtime('assets/css/style.css') ?>">
    <style>
        body {
            overflow-y: auto;
        }

        .admin-container {
            max-width: 900px;
            margin: 30px auto;
            padding: 20px;
        }

        .admin-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
            padding-bottom: 15px;
            border-bottom: 1px solid #333;
        }

        .admin-header h1 {
            margin: 0;
            color: #ff6600;
        }

        .section {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 20px;
        }

        .section h2 {
            margin-top: 0;
            color: #00ff00;
            font-size: 18px;
            border-bottom: 1px solid #333;
            padding-bottom: 10px;
        }

        .section h3 {
            color: #6699ff;
            font-size: 14px;
            margin: 15px 0 10px 0;
        }

        table {
            width: 100%;
            border-collapse: collapse;
        }

        th, td {
            padding: 10px;
            text-align: left;
            border-bottom: 1px solid #333;
        }

        th {
            color: #888;
            font-size: 12px;
            text-transform: uppercase;
        }

        td {
            font-size: 14px;
        }

        .id-cell {
            font-family: monospace;
            font-size: 11px;
            color: #666;
        }

        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }

        .btn-primary {
            background: #00ff00;
            color: #000;
        }

        .btn-primary:hover {
            background: #00cc00;
        }

        .btn-warning {
            background: #ff6600;
            color: #000;
        }

        .btn-warning:hover {
            background: #cc5500;
        }

        .btn-danger {
            background: #ff3333;
            color: #fff;
        }

        .btn-danger:hover {
            background: #cc0000;
        }

        .btn-secondary {
            background: #333;
            color: #fff;
        }

        .btn-secondary:hover {
            background: #444;
        }

        .btn-info {
            background: #00cccc;
            color: #000;
        }

        .btn-info:hover {
            background: #00aaaa;
        }

        .btn-sm {
            padding: 5px 10px;
            font-size: 12px;
        }

        .message {
            padding: 15px;
            border-radius: 4px;
            margin-bottom: 20px;
        }

        .message.success {
            background: #113311;
            border: 1px solid #00ff00;
            color: #00ff00;
        }

        .message.error {
            background: #331111;
            border: 1px solid #ff3333;
            color: #ff3333;
        }

        .backup-list {
            max-height: 200px;
            overflow-y: auto;
        }

        .backup-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid #333;
        }

        .backup-item:last-child {
            border-bottom: none;
        }

        .backup-info {
            font-size: 13px;
        }

        .backup-date {
            color: #888;
            font-size: 12px;
        }

        .nav-links {
            display: flex;
            gap: 15px;
        }

        .nav-links a {
            color: #6699ff;
            text-decoration: none;
        }

        .nav-links a:hover {
            text-decoration: underline;
        }

        .stats {
            display: flex;
            gap: 30px;
            margin-bottom: 20px;
        }

        .stat {
            text-align: center;
        }

        .stat-value {
            font-size: 32px;
            color: #00ff00;
        }

        .stat-label {
            font-size: 12px;
            color: #888;
            text-transform: uppercase;
        }

        /* User cards */
        .user-card {
            background: #222;
            border: 1px solid #333;
            border-radius: 6px;
            padding: 12px 15px;
            margin-bottom: 8px;
        }

        .user-card.online {
            border-left: 3px solid #00ff00;
        }

        /* Default view: only online users (the full list got lengthy). */
        #users-list.filter-online .user-card:not(.online) {
            display: none;
        }

        .user-row-1 {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .user-info {
            display: flex;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
        }

        .user-name {
            font-size: 16px;
            font-weight: bold;
            color: #fff;
        }

        .badge {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 3px;
            text-transform: uppercase;
        }

        .badge-admin {
            background: #ff6600;
            color: #000;
        }

        .badge-wizard {
            background: #00cccc;
            color: #000;
        }

        .badge-banned {
            background: #ff0000;
            color: #fff;
        }

        .user-banned {
            border-color: #ff0000;
            opacity: 0.7;
        }

        .user-ip {
            color: #888;
            font-size: 11px;
            font-family: monospace;
        }

        .user-email {
            color: #888;
            font-size: 13px;
        }

        .user-stats {
            display: flex;
            gap: 15px;
        }

        .stat-item {
            font-size: 13px;
        }

        .stat-dim {
            color: #555;
            font-size: 11px;
            margin-left: 2px;
        }

        .user-row-2 {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 13px;
        }

        .user-status {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 180px;
        }

        .status-indicator {
            font-size: 10px;
        }

        .status-indicator.offline {
            color: #555;
        }

        .status-indicator.online {
            color: #00ff00;
        }

        .status-indicator.partial {
            color: #ffff00;
        }

        .status-text {
            color: #888;
        }

        .status-detail {
            color: #00ff00;
            font-size: 12px;
        }

        .user-login {
            color: #666;
            font-size: 12px;
        }

        .user-actions {
            display: flex;
            gap: 5px;
        }

        .user-actions .btn-sm {
            padding: 4px 8px;
            font-size: 11px;
        }
    </style>
</head>
<body>
    <div class="admin-container">
        <div class="admin-header">
            <h1>Admin Panel</h1>
            <div class="nav-links">
                <a href="characters.php">Characters</a>
                <a href="app.php">Play</a>
            </div>
        </div>

        <?php if ($message): ?>
            <div class="message <?= $messageType ?>"><?= htmlspecialchars($message) ?></div>
        <?php endif; ?>

        <div class="stats">
            <div class="stat">
                <div class="stat-value"><?= count($usersIndex) ?></div>
                <div class="stat-label">Users</div>
            </div>
            <div class="stat">
                <div class="stat-value" id="online-count">-</div>
                <div class="stat-label">Online</div>
            </div>
        </div>

        <!-- Broadcast Section -->
        <div class="section">
            <h2>Broadcast Message</h2>
            <p style="color: #888; font-size: 13px; margin-bottom: 15px;">
                Send a message to all currently connected users. Useful for announcing updates or scheduled maintenance.
            </p>
            <?php if (!defined('RENDER_ADMIN_KEY') || !RENDER_ADMIN_KEY): ?>
                <p style="color: #ff6600;">Broadcast is not configured. Set up config/render_admin_key.php and ADMIN_KEY on Render.</p>
            <?php else: ?>
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <textarea id="broadcast-message" placeholder="Enter your message here..."
                              style="width: 100%; height: 80px; padding: 12px; border: 1px solid #333; border-radius: 4px; background: #222; color: #fff; font-size: 14px; resize: vertical;"></textarea>
                    <div style="display: flex; gap: 10px; align-items: center;">
                        <button type="button" class="btn btn-primary" onclick="sendBroadcast()">Send Broadcast</button>
                        <span id="broadcast-status" style="color: #888; font-size: 13px;"></span>
                    </div>
                </div>
            <?php endif; ?>
        </div>

        <!-- Users Section -->
        <div class="section">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; margin-bottom: 10px;">
                <h2 style="border-bottom: none; margin-bottom: 10px;">Registered Users</h2>
                <div style="display: flex; gap: 6px;">
                    <button type="button" class="btn btn-sm btn-primary" id="filter-online" onclick="setUserFilter('online')">Online</button>
                    <button type="button" class="btn btn-sm btn-secondary" id="filter-all" onclick="setUserFilter('all')">All (<?= count($usersIndex) ?>)</button>
                </div>
            </div>
            <p id="filter-empty" style="display: none; color: #888;">No users online right now — click All to see everyone.</p>

            <?php if (empty($usersIndex)): ?>
                <p style="color: #888;">No users registered.</p>
            <?php else: ?>
                <div id="users-list" class="filter-online">
                    <?php foreach ($usersIndex as $user):
                        $stats = getUserStorageStats($user['id']);
                        $isAdmin = in_array($user['username'], $ADMIN_USERS);
                        $isWizard = $user['isWizard'] ?? false;
                        $profile = loadJsonFile(getProfilePath($user['id']));
                        $isBanned = !empty($user['banned']) || !empty($profile['banned']);   // DB flag first; profile.json is the legacy fallback
                        $lastIp = $profile['last_ip'] ?? '';
                        $registeredIp = $profile['registered_ip'] ?? '';
                    ?>
                        <div class="user-card <?= $isBanned ? 'user-banned' : '' ?>" data-user-id="<?= htmlspecialchars($user['id']) ?>">
                            <div class="user-row-1">
                                <div class="user-info">
                                    <span class="user-name"><?= htmlspecialchars($user['username']) ?></span>
                                    <?php if ($isBanned): ?>
                                        <span class="badge badge-banned">BANNED</span>
                                    <?php endif; ?>
                                    <?php if ($isAdmin): ?>
                                        <span class="badge badge-admin">admin</span>
                                    <?php endif; ?>
                                    <?php if ($isWizard): ?>
                                        <span class="badge badge-wizard">wizard</span>
                                    <?php endif; ?>
                                    <?php if (!empty($user['email'])): ?>
                                        <span class="user-email"><?= htmlspecialchars($user['email']) ?></span>
                                    <?php endif; ?>
                                    <?php if ($lastIp): ?>
                                        <span class="user-ip" title="Last IP<?= $registeredIp ? ' (registered from: ' . htmlspecialchars($registeredIp) . ')' : '' ?>"><?= htmlspecialchars($lastIp) ?></span>
                                    <?php endif; ?>
                                </div>
                                <div class="user-stats">
                                    <span class="stat-item" title="Storage used">
                                        <span style="color: <?= $stats['percent_used'] > 80 ? '#ff6600' : '#888' ?>;"><?= $stats['used_mb'] ?></span><span class="stat-dim">MB</span>
                                    </span>
                                    <span class="stat-item" title="Files count">
                                        <span style="color: <?= ($stats['files'] / $stats['max_files']) > 0.8 ? '#ff6600' : '#888' ?>;"><?= $stats['files'] ?></span><span class="stat-dim">files</span>
                                    </span>
                                </div>
                            </div>
                            <div class="user-row-2">
                                <div class="user-status">
                                    <span class="status-indicator offline" title="Offline">●</span>
                                    <span class="status-text">Offline</span>
                                    <span class="status-detail"></span>
                                </div>
                                <div class="user-login">
                                    <?php if (!empty($user['last_login'])): ?>
                                        Last login: <?= date('M j g:ia', strtotime($user['last_login'])) ?>
                                    <?php else: ?>
                                        Never logged in
                                    <?php endif; ?>
                                </div>
                                <div class="user-actions">
                                    <?php if (!empty($user['email'])): ?>
                                        <form method="post" style="margin: 0; display: inline;" onsubmit="return confirm('Send password reset email?');">
                                            <input type="hidden" name="csrf_token" value="<?= $csrfToken ?>">
                                            <input type="hidden" name="action" value="send_reset_email">
                                            <input type="hidden" name="user_id" value="<?= htmlspecialchars($user['id']) ?>">
                                            <button type="submit" class="btn btn-primary btn-sm" title="Send reset email">Reset</button>
                                        </form>
                                    <?php endif; ?>
                                    <form method="post" style="margin: 0; display: inline;">
                                        <input type="hidden" name="csrf_token" value="<?= $csrfToken ?>">
                                        <input type="hidden" name="action" value="toggle_wizard">
                                        <input type="hidden" name="user_id" value="<?= htmlspecialchars($user['id']) ?>">
                                        <button type="submit" class="btn btn-sm <?= $isWizard ? 'btn-info' : 'btn-secondary' ?>" title="Toggle wizard status">
                                            <?= $isWizard ? '★Wiz' : '☆Wiz' ?>
                                        </button>
                                    </form>
                                    <?php if (!$isAdmin): ?>
                                        <form method="post" style="margin: 0; display: inline;" onsubmit="return <?= $isBanned ? "confirm('Unban this user?')" : "confirmBan(this)" ?>;">
                                            <input type="hidden" name="csrf_token" value="<?= $csrfToken ?>">
                                            <input type="hidden" name="action" value="toggle_ban">
                                            <input type="hidden" name="user_id" value="<?= htmlspecialchars($user['id']) ?>">
                                            <input type="hidden" name="ban_reason" value="">
                                            <button type="submit" class="btn btn-sm <?= $isBanned ? 'btn-warning' : 'btn-danger' ?>" title="<?= $isBanned ? 'Unban user' : 'Ban user' ?>">
                                                <?= $isBanned ? 'Unban' : 'Ban' ?>
                                            </button>
                                        </form>
                                        <button type="button" class="btn btn-danger btn-sm" onclick="showDeleteModal('<?= htmlspecialchars($user['id']) ?>', '<?= htmlspecialchars($user['username']) ?>')">Del</button>
                                    <?php endif; ?>
                                </div>
                            </div>
                        </div>
                    <?php endforeach; ?>
                </div>
            <?php endif; ?>
        </div>

    </div>

    <!-- Delete User Modal -->
    <div id="deleteModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; align-items: center; justify-content: center;">
        <div style="background: #1a1a1a; border: 1px solid #ff3333; border-radius: 8px; padding: 25px; width: 100%; max-width: 450px;">
            <h3 style="margin: 0 0 20px 0; color: #ff3333;">Delete User Account</h3>
            <p style="color: #ff6600; margin-bottom: 15px;">
                You are about to permanently delete the account: <strong id="modalUsername" style="color: #fff;"></strong>
            </p>
            <p style="color: #888; margin-bottom: 20px; font-size: 13px;">
                This will delete all characters, triggers, aliases, scripts, and other data. This action cannot be undone.
            </p>
            <form method="post" id="deleteForm">
                <input type="hidden" name="csrf_token" value="<?= $csrfToken ?>">
                <input type="hidden" name="action" value="delete_user">
                <input type="hidden" name="user_id" id="modalUserId">
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 8px; color: #ccc;">Type the username to confirm:</label>
                    <input type="text" name="confirm_username" id="modalConfirmUsername" required autocomplete="off"
                           style="width: 100%; padding: 12px; border: 1px solid #333; border-radius: 4px; background: #222; color: #fff; font-size: 14px;"
                           placeholder="Enter username to confirm">
                </div>
                <div style="display: flex; gap: 10px; justify-content: flex-end;">
                    <button type="button" class="btn btn-secondary" onclick="hideDeleteModal()">Cancel</button>
                    <button type="submit" class="btn btn-danger">Delete Account</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        function confirmBan(form) {
            const reason = prompt('Ban reason (optional):');
            if (reason === null) return false; // cancelled
            form.querySelector('[name="ban_reason"]').value = reason;
            return confirm('Ban this user? They will be logged out and unable to log back in.');
        }

        let deleteUsername = '';

        function showDeleteModal(userId, username) {
            deleteUsername = username;
            document.getElementById('modalUserId').value = userId;
            document.getElementById('modalUsername').textContent = username;
            document.getElementById('modalConfirmUsername').value = '';
            document.getElementById('deleteModal').style.display = 'flex';
            document.getElementById('modalConfirmUsername').focus();
        }

        function hideDeleteModal() {
            document.getElementById('deleteModal').style.display = 'none';
        }

        // Validate username before submit
        document.getElementById('deleteForm').addEventListener('submit', function(e) {
            const confirm = document.getElementById('modalConfirmUsername').value;
            if (confirm.toLowerCase() !== deleteUsername.toLowerCase()) {
                e.preventDefault();
                alert('Username does not match. Please type the exact username to confirm deletion.');
            }
        });

        // Close modal on escape key
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                hideDeleteModal();
            }
        });

        // Close modal on backdrop click
        document.getElementById('deleteModal').addEventListener('click', function(e) {
            if (e.target === this) {
                hideDeleteModal();
            }
        });

        // ── User list filter: Online (default) / All ──
        let userFilter = 'online';
        let sessionsFetched = false;   // until the first successful /sessions fetch, "online" is unknown

        function setUserFilter(mode) {
            userFilter = mode;
            refreshFilterUI();
        }

        function refreshFilterUI() {
            const list = document.getElementById('users-list');
            if (!list) return;
            list.classList.toggle('filter-online', userFilter === 'online');
            const onlineCount = list.querySelectorAll('.user-card.online').length;
            const btnOnline = document.getElementById('filter-online');
            const btnAll = document.getElementById('filter-all');
            if (btnOnline) {
                btnOnline.textContent = sessionsFetched ? `Online (${onlineCount})` : 'Online (…)';
                btnOnline.className = 'btn btn-sm ' + (userFilter === 'online' ? 'btn-primary' : 'btn-secondary');
            }
            if (btnAll) {
                btnAll.className = 'btn btn-sm ' + (userFilter === 'all' ? 'btn-primary' : 'btn-secondary');
            }
            const empty = document.getElementById('filter-empty');
            if (empty) empty.style.display = (userFilter === 'online' && sessionsFetched && onlineCount === 0) ? '' : 'none';
        }

        // Fetch and display online sessions — via the PHP proxy so the admin
        // key never appears in page source (api/admin_proxy.php).
        async function fetchSessions() {
            try {
                const response = await fetch('api/admin_proxy.php?action=sessions');

                const result = await response.json();

                if (result.success) {
                    sessionsFetched = true;
                    updateOnlineStatus(result.sessions);
                }
            } catch (e) {
                console.error('Failed to fetch sessions:', e);
                // Online status unknown (proxy unreachable) — show everyone rather than a blank page.
                if (!sessionsFetched && userFilter === 'online') setUserFilter('all');
            }
        }

        function updateOnlineStatus(sessions) {
            // Group sessions by userId
            const userSessions = {};
            sessions.forEach(s => {
                if (s.userId) {
                    if (!userSessions[s.userId]) {
                        userSessions[s.userId] = [];
                    }
                    userSessions[s.userId].push(s);
                }
            });

            // Update online count
            const onlineCount = Object.keys(userSessions).length;
            document.getElementById('online-count').textContent = onlineCount;

            // Update each user card
            document.querySelectorAll('.user-card[data-user-id]').forEach(card => {
                const userId = card.getAttribute('data-user-id');
                const indicator = card.querySelector('.status-indicator');
                const statusText = card.querySelector('.status-text');
                const statusDetail = card.querySelector('.status-detail');
                const userSessionList = userSessions[userId];

                if (userSessionList && userSessionList.length > 0) {
                    // User is online
                    card.classList.add('online');

                    // Check if all sessions have MUD connected
                    const allConnected = userSessionList.every(s => s.mudConnected);
                    const anyConnected = userSessionList.some(s => s.mudConnected);

                    indicator.className = 'status-indicator ' + (allConnected ? 'online' : 'partial');
                    statusText.textContent = 'Online';

                    // Build character list
                    const charList = userSessionList.map(s => {
                        const charName = s.characterName || '?';
                        const serverTag = s.server === '3s' ? '3S' : '3K';
                        return `${charName}@${serverTag}`;
                    }).join(', ');
                    statusDetail.textContent = charList;
                } else {
                    // User is offline
                    card.classList.remove('online');
                    indicator.className = 'status-indicator offline';
                    statusText.textContent = 'Offline';
                    statusDetail.textContent = '';
                }
            });

            refreshFilterUI();
        }

        // Fetch sessions on page load and periodically
        refreshFilterUI();
        fetchSessions();
        setInterval(fetchSessions, 30000); // Refresh every 30 seconds

        // Broadcast functionality
        async function sendBroadcast() {
            const messageEl = document.getElementById('broadcast-message');
            const statusEl = document.getElementById('broadcast-status');
            const message = messageEl.value.trim();

            if (!message) {
                statusEl.textContent = 'Please enter a message';
                statusEl.style.color = '#ff6600';
                return;
            }

            if (!confirm('Send this broadcast to all connected users?')) {
                return;
            }

            statusEl.textContent = 'Sending...';
            statusEl.style.color = '#888';

            try {
                // Via the PHP proxy (api/admin_proxy.php) — admin key stays server-side.
                const response = await fetch('api/admin_proxy.php?action=broadcast', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: message, csrf_token: '<?= $csrfToken ?>' })
                });

                const result = await response.json();

                if (result.success) {
                    statusEl.textContent = `Sent to ${result.sentTo} user(s)`;
                    statusEl.style.color = '#00ff00';
                    messageEl.value = '';
                } else {
                    statusEl.textContent = 'Error: ' + (result.error || 'Unknown error');
                    statusEl.style.color = '#ff3333';
                }
            } catch (e) {
                statusEl.textContent = 'Error: ' + e.message;
                statusEl.style.color = '#ff3333';
            }
        }
    </script>
</body>
</html>
