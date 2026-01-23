<?php
/**
 * WMT Client - Admin Panel
 * For backup, restore, and data management
 */

require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/functions.php';

initSession();

// Simple admin check - must be logged in and username must be 'nathan' (or add to config)
$ADMIN_USERS = ['nathan']; // Add admin usernames here

if (!isLoggedIn() || !in_array(getCurrentUsername(), $ADMIN_USERS)) {
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
            case 'backup':
                $result = createBackup();
                if ($result['success']) {
                    $message = 'Backup created: ' . $result['filename'];
                    $messageType = 'success';
                } else {
                    $message = 'Backup failed: ' . $result['error'];
                    $messageType = 'error';
                }
                break;

            case 'restore':
                $backupFile = $_POST['backup_file'] ?? '';
                if ($backupFile) {
                    $result = restoreBackup($backupFile);
                    if ($result['success']) {
                        $message = 'Restore successful';
                        $messageType = 'success';
                    } else {
                        $message = 'Restore failed: ' . $result['error'];
                        $messageType = 'error';
                    }
                }
                break;

            case 'adopt_orphan':
                $orphanId = $_POST['orphan_id'] ?? '';
                $targetUserId = $_POST['target_user_id'] ?? '';
                if ($orphanId && $targetUserId) {
                    $result = adoptOrphanedCharacters($orphanId, $targetUserId);
                    if ($result['success']) {
                        $message = 'Adopted ' . $result['count'] . ' character(s)';
                        $messageType = 'success';
                    } else {
                        $message = 'Adopt failed: ' . $result['error'];
                        $messageType = 'error';
                    }
                }
                break;

            case 'delete_orphan':
                $orphanId = $_POST['orphan_id'] ?? '';
                if ($orphanId) {
                    $result = deleteOrphanedDirectory($orphanId);
                    if ($result['success']) {
                        $message = 'Orphaned directory deleted';
                        $messageType = 'success';
                    } else {
                        $message = 'Delete failed: ' . $result['error'];
                        $messageType = 'error';
                    }
                }
                break;

            case 'repair_index':
                $result = repairUsersIndex();
                if ($result['success']) {
                    $message = 'Index repaired: ' . $result['recovered'] . ' user(s) recovered';
                    $messageType = 'success';
                } else {
                    $message = 'Repair failed: ' . $result['error'];
                    $messageType = 'error';
                }
                break;

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

            case 'reset_password':
                $targetUserId = $_POST['user_id'] ?? '';
                $newPassword = $_POST['new_password'] ?? '';
                if ($targetUserId && $newPassword) {
                    $result = adminResetPassword($targetUserId, $newPassword);
                    if ($result['success']) {
                        $message = 'Password reset for: ' . $result['username'];
                        $messageType = 'success';
                    } else {
                        $message = 'Reset failed: ' . $result['error'];
                        $messageType = 'error';
                    }
                } else {
                    $message = 'User ID and new password are required';
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
        }
    }
}

// Helper functions for admin operations
function createBackup(): array {
    $timestamp = date('Y-m-d_H-i-s');
    $backupDir = USERS_PATH . '/backups';

    if (!is_dir($backupDir)) {
        mkdir($backupDir, 0755, true);
    }

    $backupFile = $backupDir . '/backup_' . $timestamp . '.json';

    // Gather all data
    $backup = [
        'timestamp' => date('c'),
        'version' => 1,
        'users_index' => loadJsonFile(getUsersIndexPath()),
        'user_data' => []
    ];

    // Get all user directories
    $userDirs = glob(USERS_PATH . '/*', GLOB_ONLYDIR);
    foreach ($userDirs as $userDir) {
        $dirName = basename($userDir);
        if ($dirName === 'backups') continue;

        $userData = [
            'id' => $dirName,
            'profile' => loadJsonFile($userDir . '/profile.json'),
            'characters' => loadJsonFile($userDir . '/characters.json'),
            'character_data' => []
        ];

        // Get character data
        $charDirs = glob($userDir . '/characters/*', GLOB_ONLYDIR);
        foreach ($charDirs as $charDir) {
            $charId = basename($charDir);
            $userData['character_data'][$charId] = [
                'triggers' => loadJsonFile($charDir . '/triggers.json'),
                'aliases' => loadJsonFile($charDir . '/aliases.json'),
                'preferences' => loadJsonFile($charDir . '/preferences.json')
            ];
        }

        $backup['user_data'][$dirName] = $userData;
    }

    if (file_put_contents($backupFile, json_encode($backup, JSON_PRETTY_PRINT))) {
        return ['success' => true, 'filename' => basename($backupFile)];
    }

    return ['success' => false, 'error' => 'Failed to write backup file'];
}

function restoreBackup(string $filename): array {
    $backupFile = USERS_PATH . '/backups/' . basename($filename);

    if (!file_exists($backupFile)) {
        return ['success' => false, 'error' => 'Backup file not found'];
    }

    $backup = json_decode(file_get_contents($backupFile), true);
    if (!$backup || !isset($backup['users_index'])) {
        return ['success' => false, 'error' => 'Invalid backup file'];
    }

    // Restore users_index
    saveJsonFile(getUsersIndexPath(), $backup['users_index']);

    // Restore user data
    foreach ($backup['user_data'] as $userId => $userData) {
        $userPath = USERS_PATH . '/' . $userId;

        if (!is_dir($userPath)) {
            mkdir($userPath, 0755, true);
        }
        if (!is_dir($userPath . '/characters')) {
            mkdir($userPath . '/characters', 0755, true);
        }

        if (!empty($userData['profile'])) {
            saveJsonFile($userPath . '/profile.json', $userData['profile']);
        }
        if (isset($userData['characters'])) {
            saveJsonFile($userPath . '/characters.json', $userData['characters']);
        }

        // Restore character data
        foreach ($userData['character_data'] as $charId => $charData) {
            $charPath = $userPath . '/characters/' . $charId;
            if (!is_dir($charPath)) {
                mkdir($charPath, 0755, true);
            }

            saveJsonFile($charPath . '/triggers.json', $charData['triggers'] ?? []);
            saveJsonFile($charPath . '/aliases.json', $charData['aliases'] ?? []);
            saveJsonFile($charPath . '/preferences.json', $charData['preferences'] ?? []);
        }
    }

    return ['success' => true];
}

function getOrphanedDirectories(): array {
    $orphans = [];
    $usersIndex = loadJsonFile(getUsersIndexPath());
    $indexedIds = array_column($usersIndex, 'id');

    $userDirs = glob(USERS_PATH . '/*', GLOB_ONLYDIR);
    foreach ($userDirs as $userDir) {
        $dirName = basename($userDir);
        if ($dirName === 'backups') continue;

        if (!in_array($dirName, $indexedIds)) {
            $orphan = [
                'id' => $dirName,
                'profile' => loadJsonFile($userDir . '/profile.json'),
                'characters' => loadJsonFile($userDir . '/characters.json')
            ];
            $orphans[] = $orphan;
        }
    }

    return $orphans;
}

function adoptOrphanedCharacters(string $orphanId, string $targetUserId): array {
    $orphanPath = USERS_PATH . '/' . $orphanId;
    $targetPath = USERS_PATH . '/' . $targetUserId;

    if (!is_dir($orphanPath)) {
        return ['success' => false, 'error' => 'Orphan directory not found'];
    }
    if (!is_dir($targetPath)) {
        return ['success' => false, 'error' => 'Target user not found'];
    }

    $orphanChars = loadJsonFile($orphanPath . '/characters.json');
    $targetChars = loadJsonFile($targetPath . '/characters.json');

    $adopted = 0;
    foreach ($orphanChars as $char) {
        // Check for duplicate names
        $exists = false;
        foreach ($targetChars as $tc) {
            if (strtolower($tc['name']) === strtolower($char['name'])) {
                $exists = true;
                break;
            }
        }

        if (!$exists) {
            $targetChars[] = $char;

            // Copy character data directory
            $srcCharPath = $orphanPath . '/characters/' . $char['id'];
            $dstCharPath = $targetPath . '/characters/' . $char['id'];

            if (is_dir($srcCharPath) && !is_dir($dstCharPath)) {
                mkdir($dstCharPath, 0755, true);
                $files = glob($srcCharPath . '/*.json');
                foreach ($files as $file) {
                    copy($file, $dstCharPath . '/' . basename($file));
                }
            }

            $adopted++;
        }
    }

    saveJsonFile($targetPath . '/characters.json', $targetChars);

    return ['success' => true, 'count' => $adopted];
}

function deleteOrphanedDirectory(string $orphanId): array {
    $orphanPath = USERS_PATH . '/' . $orphanId;

    // Safety check - make sure it's actually orphaned
    $usersIndex = loadJsonFile(getUsersIndexPath());
    foreach ($usersIndex as $user) {
        if ($user['id'] === $orphanId) {
            return ['success' => false, 'error' => 'This is not an orphaned directory'];
        }
    }

    if (!is_dir($orphanPath)) {
        return ['success' => false, 'error' => 'Directory not found'];
    }

    // Recursively delete
    $files = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($orphanPath, RecursiveDirectoryIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );

    foreach ($files as $file) {
        if ($file->isDir()) {
            rmdir($file->getRealPath());
        } else {
            unlink($file->getRealPath());
        }
    }
    rmdir($orphanPath);

    return ['success' => true];
}

function repairUsersIndex(): array {
    $usersIndex = loadJsonFile(getUsersIndexPath());
    $indexedIds = array_column($usersIndex, 'id');
    $recovered = 0;

    $userDirs = glob(USERS_PATH . '/*', GLOB_ONLYDIR);
    foreach ($userDirs as $userDir) {
        $dirName = basename($userDir);
        if ($dirName === 'backups') continue;

        if (!in_array($dirName, $indexedIds)) {
            // Try to recover from profile.json
            $profilePath = $userDir . '/profile.json';
            if (file_exists($profilePath)) {
                $profile = loadJsonFile($profilePath);
                if (!empty($profile['id']) && !empty($profile['username'])) {
                    // Check for password hash in profile
                    $passwordHash = $profile['password_hash'] ?? '';

                    if ($passwordHash) {
                        // Full recovery possible
                        $usersIndex[] = [
                            'id' => $profile['id'],
                            'username' => $profile['username'],
                            'password' => $passwordHash,
                            'created_at' => $profile['created_at'] ?? date('c'),
                            'recovered_at' => date('c')
                        ];
                        $recovered++;
                    }
                }
            }
        }
    }

    if ($recovered > 0) {
        if (!saveJsonFile(getUsersIndexPath(), $usersIndex)) {
            return ['success' => false, 'error' => 'Failed to save repaired index'];
        }
    }

    return ['success' => true, 'recovered' => $recovered];
}

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

    return ['success' => true, 'username' => $username];
}

function adminResetPassword(string $userId, string $newPassword): array {
    if (strlen($newPassword) < 6) {
        return ['success' => false, 'error' => 'Password must be at least 6 characters'];
    }

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

    // Hash the new password
    $passwordHash = password_hash($newPassword, PASSWORD_DEFAULT);

    // Update in users index
    $users[$userIndex]['password'] = $passwordHash;
    if (!saveUsersIndex($users)) {
        return ['success' => false, 'error' => 'Failed to update users index'];
    }

    // Also update in user's profile.json for consistency
    $profilePath = getUserDataPath($userId) . '/profile.json';
    if (file_exists($profilePath)) {
        $profile = loadJsonFile($profilePath);
        $profile['password_hash'] = $passwordHash;
        saveJsonFile($profilePath, $profile);
    }

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

function getBackupFiles(): array {
    $backupDir = USERS_PATH . '/backups';
    if (!is_dir($backupDir)) {
        return [];
    }

    $files = glob($backupDir . '/backup_*.json');
    $backups = [];

    foreach ($files as $file) {
        $backups[] = [
            'filename' => basename($file),
            'size' => filesize($file),
            'modified' => filemtime($file)
        ];
    }

    // Sort by date descending
    usort($backups, function($a, $b) {
        return $b['modified'] - $a['modified'];
    });

    return $backups;
}

// Get data for display
$usersIndex = loadJsonFile(getUsersIndexPath());
$orphans = getOrphanedDirectories();
$backups = getBackupFiles();
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

        .orphan-card {
            background: #2a2a1a;
            border: 1px solid #ff6600;
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 15px;
        }

        .orphan-card h4 {
            margin: 0 0 10px 0;
            color: #ff6600;
        }

        .char-list {
            margin: 10px 0;
            padding-left: 20px;
        }

        .char-list li {
            color: #aaa;
            margin: 5px 0;
        }

        .orphan-actions {
            display: flex;
            gap: 10px;
            margin-top: 15px;
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
                <div class="stat-value"><?= count($orphans) ?></div>
                <div class="stat-label">Orphaned</div>
            </div>
            <div class="stat">
                <div class="stat-value"><?= count($backups) ?></div>
                <div class="stat-label">Backups</div>
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

        <!-- Maintenance Section -->
        <div class="section">
            <h2>Maintenance</h2>
            <div style="display: flex; gap: 15px; flex-wrap: wrap;">
                <form method="post" style="margin: 0;">
                    <input type="hidden" name="csrf_token" value="<?= $csrfToken ?>">
                    <input type="hidden" name="action" value="backup">
                    <button type="submit" class="btn btn-primary">Create Backup Now</button>
                </form>

                <form method="post" style="margin: 0;" onsubmit="return confirm('Attempt to repair the users index from profile.json files?');">
                    <input type="hidden" name="csrf_token" value="<?= $csrfToken ?>">
                    <input type="hidden" name="action" value="repair_index">
                    <button type="submit" class="btn btn-warning">Repair Users Index</button>
                </form>
            </div>
            <p style="color: #666; font-size: 12px; margin-top: 10px;">
                Repair Index: Recovers orphaned users from profile.json if they have a stored password hash.
            </p>
        </div>

        <!-- Backup Section -->
        <div class="section">
            <h2>Backups</h2>

            <?php if (empty($backups)): ?>
                <p style="color: #888;">No backups yet.</p>
            <?php else: ?>
                <h3>Available Backups</h3>
                <div class="backup-list">
                    <?php foreach ($backups as $backup): ?>
                        <div class="backup-item">
                            <div class="backup-info">
                                <div><?= htmlspecialchars($backup['filename']) ?></div>
                                <div class="backup-date">
                                    <?= date('M j, Y g:i A', $backup['modified']) ?>
                                    (<?= number_format($backup['size'] / 1024, 1) ?> KB)
                                </div>
                            </div>
                            <form method="post" style="margin: 0;" onsubmit="return confirm('Restore this backup? Current data will be overwritten.');">
                                <input type="hidden" name="csrf_token" value="<?= $csrfToken ?>">
                                <input type="hidden" name="action" value="restore">
                                <input type="hidden" name="backup_file" value="<?= htmlspecialchars($backup['filename']) ?>">
                                <button type="submit" class="btn btn-warning">Restore</button>
                            </form>
                        </div>
                    <?php endforeach; ?>
                </div>
            <?php endif; ?>
        </div>

        <!-- Users Section -->
        <div class="section">
            <h2>Registered Users</h2>

            <?php if (empty($usersIndex)): ?>
                <p style="color: #888;">No users registered.</p>
            <?php else: ?>
                <table>
                    <thead>
                        <tr>
                            <th>Username</th>
                            <th>Email</th>
                            <th>Storage</th>
                            <th>Files</th>
                            <th>Last Login</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php foreach ($usersIndex as $user):
                            $stats = getUserStorageStats($user['id']);
                            $isAdmin = in_array($user['username'], $ADMIN_USERS);
                        ?>
                            <tr>
                                <td>
                                    <?= htmlspecialchars($user['username']) ?>
                                    <?php if ($isAdmin): ?>
                                        <span style="color: #ff6600; font-size: 11px;">(admin)</span>
                                    <?php endif; ?>
                                </td>
                                <td>
                                    <?php if (!empty($user['email'])): ?>
                                        <span style="color: #00ff00;"><?= htmlspecialchars($user['email']) ?></span>
                                    <?php else: ?>
                                        <span style="color: #666;">-</span>
                                    <?php endif; ?>
                                </td>
                                <td>
                                    <span style="color: <?= $stats['percent_used'] > 80 ? '#ff6600' : '#888' ?>;">
                                        <?= $stats['used_mb'] ?> MB
                                    </span>
                                    <span style="color: #444; font-size: 11px;">/ <?= $stats['max_mb'] ?></span>
                                </td>
                                <td>
                                    <span style="color: <?= ($stats['files'] / $stats['max_files']) > 0.8 ? '#ff6600' : '#888' ?>;">
                                        <?= $stats['files'] ?>
                                    </span>
                                    <span style="color: #444; font-size: 11px;">/ <?= $stats['max_files'] ?></span>
                                </td>
                                <td>
                                    <?php if (!empty($user['last_login'])): ?>
                                        <span style="color: #888;"><?= date('M j, Y g:i A', strtotime($user['last_login'])) ?></span>
                                    <?php else: ?>
                                        <span style="color: #666;">Never</span>
                                    <?php endif; ?>
                                </td>
                                <td style="white-space: nowrap;">
                                    <?php if (!empty($user['email'])): ?>
                                        <form method="post" style="display: inline;" onsubmit="return confirm('Send password reset email to <?= htmlspecialchars($user['email']) ?>?');">
                                            <input type="hidden" name="csrf_token" value="<?= $csrfToken ?>">
                                            <input type="hidden" name="action" value="send_reset_email">
                                            <input type="hidden" name="user_id" value="<?= htmlspecialchars($user['id']) ?>">
                                            <button type="submit" class="btn btn-primary" style="margin-right: 5px;" title="Send reset email to <?= htmlspecialchars($user['email']) ?>">
                                                Email Reset
                                            </button>
                                        </form>
                                    <?php endif; ?>
                                    <button type="button" class="btn btn-warning" style="margin-right: 5px;"
                                            onclick="showResetPasswordModal('<?= htmlspecialchars($user['id']) ?>', '<?= htmlspecialchars($user['username']) ?>')">
                                        Set PW
                                    </button>
                                    <?php if (!$isAdmin): ?>
                                        <button type="button" class="btn btn-danger"
                                                onclick="showDeleteModal('<?= htmlspecialchars($user['id']) ?>', '<?= htmlspecialchars($user['username']) ?>')">
                                            Delete
                                        </button>
                                    <?php endif; ?>
                                </td>
                            </tr>
                        <?php endforeach; ?>
                    </tbody>
                </table>
            <?php endif; ?>
        </div>

        <!-- Orphaned Directories Section -->
        <div class="section">
            <h2>Orphaned Directories</h2>
            <p style="color: #888; font-size: 13px; margin-bottom: 15px;">
                These directories exist on disk but are not linked to any user account.
            </p>

            <?php if (empty($orphans)): ?>
                <p style="color: #00ff00;">No orphaned directories found.</p>
            <?php else: ?>
                <?php foreach ($orphans as $orphan): ?>
                    <div class="orphan-card">
                        <h4>Orphaned Directory</h4>
                        <div class="id-cell">ID: <?= htmlspecialchars($orphan['id']) ?></div>

                        <?php if (!empty($orphan['profile'])): ?>
                            <p>Original username: <strong><?= htmlspecialchars($orphan['profile']['username'] ?? 'Unknown') ?></strong></p>
                        <?php endif; ?>

                        <?php if (!empty($orphan['characters'])): ?>
                            <h3>Characters (<?= count($orphan['characters']) ?>)</h3>
                            <ul class="char-list">
                                <?php foreach ($orphan['characters'] as $char): ?>
                                    <li>
                                        <strong><?= htmlspecialchars($char['name']) ?></strong>
                                        <?php if (!empty($char['password'])): ?>
                                            <span style="color: #00ff00;">(has password)</span>
                                        <?php endif; ?>
                                        <br>
                                        <span style="font-size: 11px; color: #666;">
                                            Created: <?= date('M j, Y g:i A', strtotime($char['created_at'])) ?>
                                        </span>
                                    </li>
                                <?php endforeach; ?>
                            </ul>
                        <?php endif; ?>

                        <div class="orphan-actions">
                            <form method="post" style="margin: 0;">
                                <input type="hidden" name="csrf_token" value="<?= $csrfToken ?>">
                                <input type="hidden" name="action" value="adopt_orphan">
                                <input type="hidden" name="orphan_id" value="<?= htmlspecialchars($orphan['id']) ?>">
                                <input type="hidden" name="target_user_id" value="<?= htmlspecialchars($userId) ?>">
                                <button type="submit" class="btn btn-primary" onclick="return confirm('Adopt these characters into your account?');">
                                    Adopt Characters to My Account
                                </button>
                            </form>

                            <form method="post" style="margin: 0;">
                                <input type="hidden" name="csrf_token" value="<?= $csrfToken ?>">
                                <input type="hidden" name="action" value="delete_orphan">
                                <input type="hidden" name="orphan_id" value="<?= htmlspecialchars($orphan['id']) ?>">
                                <button type="submit" class="btn btn-danger" onclick="return confirm('Permanently delete this orphaned directory? This cannot be undone.');">
                                    Delete Permanently
                                </button>
                            </form>
                        </div>
                    </div>
                <?php endforeach; ?>
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

    <!-- Reset Password Modal -->
    <div id="resetPasswordModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; align-items: center; justify-content: center;">
        <div style="background: #1a1a1a; border: 1px solid #ff9900; border-radius: 8px; padding: 25px; width: 100%; max-width: 450px;">
            <h3 style="margin: 0 0 20px 0; color: #ff9900;">Reset User Password</h3>
            <p style="color: #ccc; margin-bottom: 15px;">
                Reset password for: <strong id="resetModalUsername" style="color: #fff;"></strong>
            </p>
            <form method="post" id="resetPasswordForm">
                <input type="hidden" name="csrf_token" value="<?= $csrfToken ?>">
                <input type="hidden" name="action" value="reset_password">
                <input type="hidden" name="user_id" id="resetModalUserId">
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 8px; color: #ccc;">New Password:</label>
                    <input type="text" name="new_password" id="resetModalPassword" required autocomplete="off"
                           style="width: 100%; padding: 12px; border: 1px solid #333; border-radius: 4px; background: #222; color: #fff; font-size: 14px;"
                           placeholder="Enter new password (min 6 characters)">
                </div>
                <div style="display: flex; gap: 10px; justify-content: flex-end;">
                    <button type="button" class="btn btn-secondary" onclick="hideResetPasswordModal()">Cancel</button>
                    <button type="submit" class="btn btn-warning">Reset Password</button>
                </div>
            </form>
        </div>
    </div>

    <script>
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

        function showResetPasswordModal(userId, username) {
            document.getElementById('resetModalUserId').value = userId;
            document.getElementById('resetModalUsername').textContent = username;
            document.getElementById('resetModalPassword').value = '';
            document.getElementById('resetPasswordModal').style.display = 'flex';
            document.getElementById('resetModalPassword').focus();
        }

        function hideResetPasswordModal() {
            document.getElementById('resetPasswordModal').style.display = 'none';
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
                hideResetPasswordModal();
            }
        });

        // Close modal on backdrop click
        document.getElementById('deleteModal').addEventListener('click', function(e) {
            if (e.target === this) {
                hideDeleteModal();
            }
        });

        document.getElementById('resetPasswordModal').addEventListener('click', function(e) {
            if (e.target === this) {
                hideResetPasswordModal();
            }
        });

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
                // Convert wss:// to https:// for HTTP endpoint
                const proxyUrl = '<?= WS_CLIENT_URL ?>'.replace('wss://', 'https://').replace('ws://', 'http://');
                const response = await fetch(proxyUrl + '/broadcast', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Key': '<?= RENDER_ADMIN_KEY ?? '' ?>'
                    },
                    body: JSON.stringify({ message: message })
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
