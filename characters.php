<?php
/**
 * WMT Client - Character Selection Page
 */

require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/functions.php';

initSession();
requireAuth();

$userId = getCurrentUserId();
$username = getCurrentUsername();
$characters = getCharacters($userId);
$csrfToken = generateCsrfToken();

// Auto-backup: create daily backup if admin user and >24 hours since last backup
$ADMIN_USERS = ['nathan'];
if (in_array($username, $ADMIN_USERS)) {
    $backupDir = USERS_PATH . '/backups';
    if (!is_dir($backupDir)) {
        @mkdir($backupDir, 0755, true);
    }

    $lastBackupFile = $backupDir . '/.last_auto_backup';
    $lastBackup = file_exists($lastBackupFile) ? (int)file_get_contents($lastBackupFile) : 0;
    $dayAgo = time() - 86400;

    if ($lastBackup < $dayAgo) {
        // Create auto backup
        $timestamp = date('Y-m-d_H-i-s');
        $backupFile = $backupDir . '/auto_backup_' . $timestamp . '.json';

        $backup = [
            'timestamp' => date('c'),
            'version' => 1,
            'auto' => true,
            'users_index' => loadJsonFile(getUsersIndexPath()),
            'user_data' => []
        ];

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

        if (@file_put_contents($backupFile, json_encode($backup, JSON_PRETTY_PRINT))) {
            @file_put_contents($lastBackupFile, time());

            // Keep only last 7 auto backups
            $autoBackups = glob($backupDir . '/auto_backup_*.json');
            if (count($autoBackups) > 7) {
                usort($autoBackups, function($a, $b) { return filemtime($a) - filemtime($b); });
                $toDelete = array_slice($autoBackups, 0, count($autoBackups) - 7);
                foreach ($toDelete as $old) {
                    @unlink($old);
                }
            }
        }
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
    <title>Select Character - <?= APP_NAME ?></title>
    <link rel="stylesheet" href="assets/css/style.css">
    <style>
        body {
            overflow-y: auto;
        }

        .characters-container {
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
        }

        .characters-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
        }

        .characters-header h1 {
            margin: 0;
            color: #00ff00;
        }

        .user-info {
            color: #888;
            font-size: 14px;
        }

        .user-info a {
            color: #ff6666;
            text-decoration: none;
        }

        .user-info a:hover {
            text-decoration: underline;
        }

        .character-list {
            list-style: none;
            padding: 0;
            margin: 0 0 30px 0;
        }

        .character-item {
            background: #1a1a1a;
            border: 1px solid #333;
            border-radius: 8px;
            padding: 15px 20px;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
            transition: all 0.2s;
        }

        .character-item:hover {
            border-color: #00ff00;
            background: #222;
        }

        .character-name {
            font-size: 18px;
            color: #00ff00;
        }

        .character-created {
            font-size: 12px;
            color: #666;
        }

        .character-actions {
            display: flex;
            gap: 10px;
        }

        .character-actions button {
            padding: 5px 10px;
            font-size: 12px;
        }

        .btn-select {
            background: #00ff00;
            color: #000;
            border: none;
            padding: 8px 20px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
        }

        .btn-select:hover {
            background: #00cc00;
        }

        .btn-delete {
            background: transparent;
            color: #ff6666;
            border: 1px solid #ff6666;
            padding: 5px 10px;
            border-radius: 4px;
            cursor: pointer;
        }

        .btn-delete:hover {
            background: #ff6666;
            color: #000;
        }

        .btn-rename {
            background: transparent;
            color: #6699ff;
            border: 1px solid #6699ff;
            padding: 5px 10px;
            border-radius: 4px;
            cursor: pointer;
        }

        .btn-rename:hover {
            background: #6699ff;
            color: #000;
        }

        .btn-password {
            background: transparent;
            color: #ffaa00;
            border: 1px solid #ffaa00;
            padding: 5px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }

        .btn-password:hover {
            background: #ffaa00;
            color: #000;
        }

        .btn-password.has-password {
            color: #00ff00;
            border-color: #00ff00;
        }

        .btn-password.has-password:hover {
            background: #00ff00;
            color: #000;
        }

        .new-character {
            background: #0a0a0a;
            border: 2px dashed #333;
            border-radius: 8px;
            padding: 20px;
            text-align: center;
        }

        .new-character h3 {
            margin: 0 0 15px 0;
            color: #888;
        }

        .new-character-form {
            display: flex;
            gap: 10px;
            justify-content: center;
            max-width: 450px;
            margin: 0 auto;
        }

        .new-character-form input {
            padding: 10px 15px;
            border: 1px solid #333;
            border-radius: 4px;
            background: #1a1a1a;
            color: #fff;
            font-size: 16px;
            flex: 1;
            min-width: 0;
        }

        .new-character-form input:focus {
            outline: none;
            border-color: #00ff00;
        }

        .new-character-form button {
            padding: 10px 20px;
            background: #00ff00;
            color: #000;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            white-space: nowrap;
            min-width: 120px;
        }

        .new-character-form button:hover {
            background: #00cc00;
        }

        .form-help {
            font-size: 12px;
            color: #666;
            margin-top: 10px;
            text-align: center;
        }

        .new-mud-character {
            border-color: #6699ff;
            margin-top: 20px;
        }

        .new-mud-character h3 {
            color: #6699ff;
        }

        .btn-new-mud {
            background: #6699ff !important;
        }

        .btn-new-mud:hover {
            background: #4477dd !important;
        }

        .empty-state {
            text-align: center;
            padding: 40px;
            color: #666;
        }

        .empty-state p {
            margin-bottom: 20px;
        }

        .error-message {
            background: #331111;
            border: 1px solid #ff6666;
            color: #ff6666;
            padding: 10px 15px;
            border-radius: 4px;
            margin-bottom: 20px;
        }

        .success-message {
            background: #113311;
            border: 1px solid #00ff00;
            color: #00ff00;
            padding: 10px 15px;
            border-radius: 4px;
            margin-bottom: 20px;
        }

        /* Server Toggle */
        .server-toggle {
            display: inline-flex;
            align-items: center;
            background: #222;
            border-radius: 4px;
            padding: 2px;
            font-size: 11px;
            cursor: pointer;
            flex-shrink: 0;
        }

        .server-toggle .server-option {
            padding: 3px 8px;
            border-radius: 3px;
            color: #666;
            transition: all 0.2s;
        }

        .server-toggle .server-option.active {
            background: #00ff00;
            color: #000;
            font-weight: bold;
        }

        .server-toggle.is-3s .server-option.active {
            background: #6699ff;
        }

        .server-toggle:hover .server-option:not(.active) {
            color: #aaa;
        }

        /* Responsive styles */
        @media (max-width: 600px) {
            .characters-container {
                margin: 20px auto;
                padding: 15px;
            }

            .characters-header {
                flex-direction: column;
                align-items: flex-start;
                gap: 10px;
            }

            .characters-header h1 {
                font-size: 24px;
            }

            .user-info {
                font-size: 12px;
            }

            .character-item {
                flex-direction: column;
                align-items: flex-start;
                gap: 12px;
                padding: 12px 15px;
            }

            .character-name {
                font-size: 16px;
            }

            .character-actions {
                width: 100%;
                flex-wrap: wrap;
                gap: 8px;
            }

            .character-actions button {
                padding: 8px 12px;
            }

            .btn-select {
                flex: 1;
                min-width: 80px;
            }

            .new-character-form {
                flex-direction: column;
            }

            .new-character-form input {
                width: 100%;
                box-sizing: border-box;
            }

            .new-character-form button {
                width: 100%;
            }
        }

        @media (max-width: 400px) {
            .character-actions {
                justify-content: space-between;
            }

            .btn-rename, .btn-delete {
                font-size: 11px;
                padding: 6px 8px;
            }
        }
    </style>
</head>
<body>
    <div class="characters-container">
        <div class="characters-header">
            <h1>Select Character</h1>
            <div class="user-info">
                Logged in as <strong><?= htmlspecialchars($username) ?></strong>
                <?php if (in_array($username, $ADMIN_USERS)): ?>
                    | <a href="admin.php">Admin</a>
                <?php endif; ?>
                | <a href="#" onclick="showChangePassword(); return false;">Change Password</a>
                | <a href="#" onclick="logout(); return false;">Logout</a>
            </div>
        </div>

        <div id="message-area"></div>

        <?php if (empty($characters)): ?>
            <div class="empty-state">
                <p>You don't have any characters yet.<br>Create one to get started!</p>
            </div>
        <?php else: ?>
            <ul class="character-list" id="character-list">
                <?php foreach ($characters as $char):
                    $charServer = $char['server'] ?? '3k';
                ?>
                    <li class="character-item" data-id="<?= htmlspecialchars($char['id']) ?>" data-server="<?= $charServer ?>">
                        <div class="character-info">
                            <div class="character-name"><?= htmlspecialchars($char['name']) ?></div>
                            <div class="character-created">Created <?= date('M j, Y', strtotime($char['created_at'])) ?></div>
                        </div>
                        <div class="character-actions">
                            <span class="server-toggle <?= $charServer === '3s' ? 'is-3s' : '' ?>" onclick="toggleServer('<?= $char['id'] ?>', '<?= $charServer ?>'); event.stopPropagation();" title="Click to switch server">
                                <span class="server-option <?= $charServer === '3k' ? 'active' : '' ?>">3K</span>
                                <span class="server-option <?= $charServer === '3s' ? 'active' : '' ?>">3S</span>
                            </span>
                            <button class="btn-password <?= !empty($char['password']) ? 'has-password' : '' ?>" onclick="setPassword('<?= $char['id'] ?>'); event.stopPropagation();" title="<?= !empty($char['password']) ? 'Password saved - click to change' : 'Set password for auto-login' ?>">
                                <?= !empty($char['password']) ? '🔐' : '🔑' ?>
                            </button>
                            <button class="btn-rename" onclick="renameCharacter('<?= $char['id'] ?>', '<?= htmlspecialchars($char['name'], ENT_QUOTES) ?>'); event.stopPropagation();">Rename</button>
                            <button class="btn-delete" onclick="deleteCharacter('<?= $char['id'] ?>', '<?= htmlspecialchars($char['name'], ENT_QUOTES) ?>'); event.stopPropagation();">Delete</button>
                            <button class="btn-select" onclick="selectCharacter('<?= $char['id'] ?>'); event.stopPropagation();">Play</button>
                        </div>
                    </li>
                <?php endforeach; ?>
            </ul>
        <?php endif; ?>

        <div class="new-character">
            <h3>Add Character Profile</h3>
            <form class="new-character-form" id="create-form" onsubmit="createCharacter(event)">
                <input type="text" id="new-character-name" placeholder="Character name" maxlength="50" required>
                <span class="server-toggle" id="create-server-toggle" title="Select server for this profile">
                    <span class="server-option active" data-server="3k">3K</span>
                    <span class="server-option" data-server="3s">3S</span>
                </span>
                <button type="submit">Add Profile</button>
            </form>
            <p class="form-help">Creates a profile for an existing character - stores triggers, aliases, and settings.</p>
        </div>

        <div class="new-character new-mud-character">
            <h3>New to 3Kingdoms?</h3>
            <p class="form-help" style="margin-bottom: 15px;">Create a brand new character on the MUD. You'll go through the registration process.</p>
            <form class="new-character-form" id="create-mud-form" onsubmit="createMudCharacter(event)">
                <input type="text" id="new-mud-character-name" placeholder="Choose a character name" maxlength="50" required pattern="[a-zA-Z]+" title="Letters only, no spaces">
                <span class="server-toggle" id="create-mud-server-toggle" title="Select server">
                    <span class="server-option active" data-server="3k">3K</span>
                    <span class="server-option" data-server="3s">3S</span>
                </span>
                <button type="submit" class="btn-new-mud">Create Character</button>
            </form>
        </div>
    </div>

    <!-- Change Password Modal -->
    <div id="passwordModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; align-items: center; justify-content: center;">
        <div style="background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 25px; width: 100%; max-width: 400px;">
            <h3 style="margin: 0 0 20px 0; color: #00ff00;">Change Password</h3>
            <div id="password-error" class="error-message" style="display: none;"></div>
            <div id="password-success" class="success-message" style="display: none;"></div>
            <form id="changePasswordForm" onsubmit="changePassword(event)">
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 8px; color: #ccc;">Current Password</label>
                    <input type="password" id="current-password" required autocomplete="current-password"
                           style="width: 100%; padding: 12px; border: 1px solid #333; border-radius: 4px; background: #222; color: #fff; font-size: 14px; box-sizing: border-box;">
                </div>
                <div style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 8px; color: #ccc;">New Password</label>
                    <input type="password" id="new-password" required autocomplete="new-password" minlength="6"
                           style="width: 100%; padding: 12px; border: 1px solid #333; border-radius: 4px; background: #222; color: #fff; font-size: 14px; box-sizing: border-box;">
                </div>
                <div style="margin-bottom: 20px;">
                    <label style="display: block; margin-bottom: 8px; color: #ccc;">Confirm New Password</label>
                    <input type="password" id="confirm-new-password" required autocomplete="new-password"
                           style="width: 100%; padding: 12px; border: 1px solid #333; border-radius: 4px; background: #222; color: #fff; font-size: 14px; box-sizing: border-box;">
                </div>
                <div style="display: flex; gap: 10px; justify-content: flex-end;">
                    <button type="button" style="padding: 10px 20px; background: #333; color: #fff; border: none; border-radius: 4px; cursor: pointer;" onclick="hideChangePassword()">Cancel</button>
                    <button type="submit" id="change-password-btn" style="padding: 10px 20px; background: #00ff00; color: #000; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Change Password</button>
                </div>
            </form>
        </div>
    </div>

    <script>
        const csrfToken = '<?= $csrfToken ?>';

        async function logout() {
            try {
                await fetch('api/auth.php?action=logout');
                window.location.href = 'index.php';
            } catch (e) {
                window.location.href = 'index.php';
            }
        }

        function showMessage(message, isError = false) {
            const area = document.getElementById('message-area');
            area.innerHTML = `<div class="${isError ? 'error-message' : 'success-message'}">${message}</div>`;
            setTimeout(() => area.innerHTML = '', 5000);
        }

        async function selectCharacter(characterId) {
            try {
                const res = await fetch('api/characters.php?action=select', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ character_id: characterId, csrf_token: csrfToken })
                });
                const data = await res.json();
                if (data.success) {
                    window.location.href = 'app.php';
                } else {
                    showMessage(data.error || 'Failed to select character', true);
                }
            } catch (e) {
                showMessage('Failed to select character', true);
            }
        }

        // Get selected server from a toggle element
        function getSelectedServer(toggleId) {
            const toggle = document.getElementById(toggleId);
            if (!toggle) return '3k';
            const active = toggle.querySelector('.server-option.active');
            return active ? active.dataset.server : '3k';
        }

        async function createCharacter(e) {
            e.preventDefault();
            const name = document.getElementById('new-character-name').value.trim();
            if (!name) return;

            const server = getSelectedServer('create-server-toggle');

            try {
                const res = await fetch('api/characters.php?action=create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: name, server: server, csrf_token: csrfToken })
                });
                const data = await res.json();
                if (data.success) {
                    window.location.reload();
                } else {
                    showMessage(data.error || 'Failed to create character', true);
                }
            } catch (e) {
                showMessage('Failed to create character', true);
            }
        }

        async function createMudCharacter(e) {
            e.preventDefault();
            const name = document.getElementById('new-mud-character-name').value.trim();
            if (!name) return;

            // Validate: letters only
            if (!/^[a-zA-Z]+$/.test(name)) {
                showMessage('Character name must contain only letters (no spaces or numbers)', true);
                return;
            }

            const server = getSelectedServer('create-mud-server-toggle');

            try {
                // Create the local profile first
                const res = await fetch('api/characters.php?action=create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: name, server: server, csrf_token: csrfToken })
                });
                const data = await res.json();
                if (data.success) {
                    // Select this character
                    const selectRes = await fetch('api/characters.php?action=select', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ character_id: data.character.id, csrf_token: csrfToken })
                    });
                    const selectData = await selectRes.json();
                    if (selectData.success) {
                        // Go to app with newchar flag - will auto-send name to MUD
                        window.location.href = 'app.php?newchar=' + encodeURIComponent(name);
                    } else {
                        showMessage('Failed to select character', true);
                    }
                } else {
                    showMessage(data.error || 'Failed to create character', true);
                }
            } catch (e) {
                showMessage('Failed to create character', true);
            }
        }

        async function deleteCharacter(characterId, characterName) {
            if (!confirm(`Delete character "${characterName}"? This cannot be undone.`)) {
                return;
            }

            try {
                const res = await fetch('api/characters.php?action=delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ character_id: characterId, csrf_token: csrfToken })
                });
                const data = await res.json();
                if (data.success) {
                    window.location.reload();
                } else {
                    showMessage(data.error || 'Failed to delete character', true);
                }
            } catch (e) {
                showMessage('Failed to delete character', true);
            }
        }

        async function renameCharacter(characterId, currentName) {
            const newName = prompt('Enter new name:', currentName);
            if (!newName || newName.trim() === currentName) return;

            try {
                const res = await fetch('api/characters.php?action=rename', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        character_id: characterId,
                        name: newName.trim(),
                        csrf_token: csrfToken
                    })
                });
                const data = await res.json();
                if (data.success) {
                    window.location.reload();
                } else {
                    showMessage(data.error || 'Failed to rename character', true);
                }
            } catch (e) {
                showMessage('Failed to rename character', true);
            }
        }

        async function setPassword(characterId) {
            const password = prompt('Enter MUD password for auto-login (leave empty to remove):');
            if (password === null) return; // Cancelled

            try {
                const res = await fetch('api/characters.php?action=set_password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        character_id: characterId,
                        password: password,
                        csrf_token: csrfToken
                    })
                });
                const data = await res.json();
                if (data.success) {
                    if (password) {
                        showMessage('Password saved. It will be sent automatically when 3K asks for it.');
                    } else {
                        showMessage('Password removed.');
                    }
                    window.location.reload();
                } else {
                    showMessage(data.error || 'Failed to save password', true);
                }
            } catch (e) {
                showMessage('Failed to save password', true);
            }
        }

        async function toggleServer(characterId, currentServer) {
            const newServer = currentServer === '3k' ? '3s' : '3k';

            try {
                const res = await fetch('api/characters.php?action=set_server', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        character_id: characterId,
                        server: newServer,
                        csrf_token: csrfToken
                    })
                });
                const data = await res.json();
                if (data.success) {
                    // Update UI without full reload
                    const item = document.querySelector(`[data-id="${characterId}"]`);
                    if (item) {
                        item.dataset.server = newServer;
                        const toggle = item.querySelector('.server-toggle');
                        if (toggle) {
                            toggle.classList.toggle('is-3s', newServer === '3s');
                            toggle.setAttribute('onclick', `toggleServer('${characterId}', '${newServer}'); event.stopPropagation();`);
                            const options = toggle.querySelectorAll('.server-option');
                            options[0].classList.toggle('active', newServer === '3k');
                            options[1].classList.toggle('active', newServer === '3s');
                        }
                    }
                    showMessage(`Server changed to ${newServer.toUpperCase()}`);
                } else {
                    showMessage(data.error || 'Failed to change server', true);
                }
            } catch (e) {
                showMessage('Failed to change server', true);
            }
        }

        // Change password functions
        function showChangePassword() {
            document.getElementById('changePasswordForm').reset();
            document.getElementById('password-error').style.display = 'none';
            document.getElementById('password-success').style.display = 'none';
            document.getElementById('passwordModal').style.display = 'flex';
            document.getElementById('current-password').focus();
        }

        function hideChangePassword() {
            document.getElementById('passwordModal').style.display = 'none';
        }

        async function changePassword(e) {
            e.preventDefault();
            const errorDiv = document.getElementById('password-error');
            const successDiv = document.getElementById('password-success');
            const btn = document.getElementById('change-password-btn');

            const currentPassword = document.getElementById('current-password').value;
            const newPassword = document.getElementById('new-password').value;
            const confirmPassword = document.getElementById('confirm-new-password').value;

            errorDiv.style.display = 'none';
            successDiv.style.display = 'none';

            if (newPassword !== confirmPassword) {
                errorDiv.textContent = 'New passwords do not match';
                errorDiv.style.display = 'block';
                return;
            }

            if (newPassword.length < 6) {
                errorDiv.textContent = 'New password must be at least 6 characters';
                errorDiv.style.display = 'block';
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Changing...';

            try {
                const res = await fetch('api/auth.php?action=change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        current_password: currentPassword,
                        new_password: newPassword
                    })
                });
                const data = await res.json();

                if (data.success) {
                    successDiv.textContent = 'Password changed successfully!';
                    successDiv.style.display = 'block';
                    document.getElementById('changePasswordForm').reset();
                    setTimeout(() => {
                        hideChangePassword();
                    }, 1500);
                } else {
                    errorDiv.textContent = data.error || 'Failed to change password';
                    errorDiv.style.display = 'block';
                }
            } catch (err) {
                errorDiv.textContent = 'Connection error. Please try again.';
                errorDiv.style.display = 'block';
            }

            btn.disabled = false;
            btn.textContent = 'Change Password';
        }

        // Close modal on escape key
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                hideChangePassword();
            }
        });

        // Close modal on backdrop click
        document.getElementById('passwordModal').addEventListener('click', function(e) {
            if (e.target === this) {
                hideChangePassword();
            }
        });

        // Click on character item to select
        document.querySelectorAll('.character-item').forEach(item => {
            item.addEventListener('click', () => {
                selectCharacter(item.dataset.id);
            });
        });

        // Server toggle click handlers for create forms
        document.querySelectorAll('#create-server-toggle, #create-mud-server-toggle').forEach(toggle => {
            toggle.addEventListener('click', function(e) {
                e.stopPropagation();
                const options = this.querySelectorAll('.server-option');
                options.forEach(opt => opt.classList.remove('active'));

                // Find clicked option or toggle to the other one
                const clickedOption = e.target.closest('.server-option');
                if (clickedOption) {
                    clickedOption.classList.add('active');
                } else {
                    // Clicked on toggle container, switch to inactive option
                    const inactive = this.querySelector('.server-option:not(.active)');
                    if (inactive) inactive.classList.add('active');
                }

                // Update toggle styling for 3S
                const activeServer = this.querySelector('.server-option.active')?.dataset.server;
                this.classList.toggle('is-3s', activeServer === '3s');
            });
        });
    </script>
</body>
</html>
