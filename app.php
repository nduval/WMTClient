<?php
/**
 * WMT Client - Main Application
 */

require_once __DIR__ . '/includes/auth.php';
require_once __DIR__ . '/includes/functions.php';

// Prevent aggressive caching (especially for iOS PWA)
header('Cache-Control: no-cache, must-revalidate');
header('Pragma: no-cache');
header('Expires: 0');

// Require authentication and character selection
initSession();
requireAuth();
requireCharacter();

$userId = getCurrentUserId();
$username = getCurrentUsername();
$characterId = getCurrentCharacterId();
$characterName = getCurrentCharacterName();
$characterServer = getCurrentCharacterServer();
$isGuest = !empty($_SESSION['is_guest']);

// Guest users have no stored data - skip file-based lookups
$characters = $isGuest ? [] : getCharacters($userId);
$isWizard = $isGuest ? false : isUserWizard($userId);

// Determine MUD host/port based on character server
$mudHost = MUD_HOST;
$mudPort = MUD_PORT;
if ($characterServer === '3s') {
    $mudHost = '3scapes.org';
    $mudPort = 3200;
}

// Check if this is a new MUD character creation
$newMudChar = isset($_GET['newchar']) ? trim($_GET['newchar']) : '';

// Generate or retrieve WebSocket session token for reconnection
// This token allows the proxy to identify this user/character session
if (!isset($_SESSION['ws_token']) || !isset($_SESSION['ws_token_char']) || $_SESSION['ws_token_char'] !== $characterId) {
    // Generate new token for this character session
    $_SESSION['ws_token'] = bin2hex(random_bytes(32));
    $_SESSION['ws_token_char'] = $characterId;
}
$wsToken = $_SESSION['ws_token'];
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <!-- iOS PWA meta tags -->
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="<?= APP_NAME ?>">
    <link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
    <link rel="apple-touch-icon" href="assets/apple-touch-icon.png">
    <title><?= APP_NAME ?> - <?= $mudHost ?></title>
    <link rel="stylesheet" href="assets/css/style.css?v=<?= filemtime('assets/css/style.css') ?>">
</head>
<body>
    <div class="app-container">
        <!-- Header -->
        <header class="header">
            <div class="header-left">
                <div class="logo"><?= APP_NAME ?></div>
                <div class="connection-status">
                    <span class="status-indicator"></span>
                    <span class="status-text">Connecting...</span>
                </div>
            </div>
            <div class="header-right">
                <button class="header-btn" id="chat-toggle-btn">ChatMon</button>
                <button class="header-btn" id="scripts-btn">Actions</button>
                <div class="header-dropdown">
                    <button class="header-btn" id="new-btn">+ New ▾</button>
                    <div class="header-dropdown-menu" id="new-menu">
                        <button onclick="wmtClient.openTriggerModal()">Trigger</button>
                        <button onclick="wmtClient.openAliasModal()">Alias</button>
                        <button onclick="wmtClient.openGagModal()">Gag</button>
                        <button onclick="wmtClient.openHighlightModal()">Highlight</button>
                        <button onclick="wmtClient.openSubstituteModal()">Substitute</button>
                        <button onclick="wmtClient.openTickerModal()">Ticker</button>
                    </div>
                </div>
                <button class="header-btn" id="settings-btn">Settings</button>

                <!-- Hamburger Menu (visible on small screens) -->
                <div class="header-dropdown hamburger-container">
                    <button class="hamburger-btn" id="hamburger-btn" aria-label="Menu">
                        <span></span>
                        <span></span>
                        <span></span>
                    </button>
                    <div class="hamburger-menu" id="hamburger-menu">
                        <button onclick="wmtClient.toggleChatWindow()">ChatMon</button>
                        <button onclick="wmtClient.toggleScriptsSidebar()">Actions</button>
                        <button onclick="wmtClient.openPanel('settings')">Settings</button>
                        <div class="menu-divider"></div>
                        <button onclick="wmtClient.openTriggerModal()">+ Trigger</button>
                        <button onclick="wmtClient.openAliasModal()">+ Alias</button>
                        <button onclick="wmtClient.openGagModal()">+ Gag</button>
                        <button onclick="wmtClient.openHighlightModal()">+ Highlight</button>
                        <button onclick="wmtClient.openSubstituteModal()">+ Substitute</button>
                        <button onclick="wmtClient.openTickerModal()">+ Ticker</button>
                        <div class="menu-divider"></div>
                        <button onclick="wmtClient.reconnect()">Reconnect</button>
                        <button onclick="wmtClient.disconnect()">Disconnect</button>
                        <div class="menu-divider"></div>
                        <button onclick="wmtClient.logout()">Logout</button>
                    </div>
                </div>
                <div class="header-dropdown character-dropdown">
                    <button class="character-btn" id="character-btn">
                        <?= htmlspecialchars(ucfirst($characterName)) ?> ▾
                    </button>
                    <div class="character-menu" id="character-menu">
                        <a href="characters.php">Character Selection</a>
                        <div class="menu-divider"></div>
                        <button onclick="wmtClient.reconnect()">Reconnect</button>
                        <button onclick="wmtClient.disconnect()">Disconnect</button>
                        <div class="menu-divider"></div>
                        <button onclick="wmtClient.logout()">Logout</button>
                    </div>
                </div>
                <span class="user-info">
                    <?= htmlspecialchars($username) ?>
                </span>
            </div>
        </header>

        <!-- Main Content -->
        <div class="main-content">
            <!-- Terminal Area (wraps chat, output, input) -->
            <div class="terminal-area">
            <!-- Chat Window (MIP Chat/Tells) -->
            <div id="chat-window" class="chat-window hidden">
                <div class="chat-header">
                    <span class="chat-title">Chat</span>
                    <div class="chat-controls">
                        <button class="chat-btn" id="chat-settings-btn" title="Channel settings">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
                        </button>
                        <button class="chat-btn" id="chat-dock-btn" title="Dock to top">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5v-7h14v7z"/></svg>
                        </button>
                        <button class="chat-btn" id="chat-float-btn" title="Float window">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/></svg>
                        </button>
                        <button class="chat-btn" id="chat-popout-btn" title="Pop out to new window">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
                        </button>
                        <button class="chat-btn chat-close" id="chat-close-btn" title="Close chat window">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                        </button>
                    </div>
                </div>
                <div class="chat-output" id="chat-output"></div>
                <div class="chat-resize-handle"></div>
            </div>

            <!-- Output Container -->
            <div class="output-container">
                <!-- Split screen status bar (TinTin++ #split) -->
                <div id="split-top" class="split-area split-top"></div>
                <div id="mud-output"></div>
                <div id="split-bottom" class="split-area split-bottom"></div>
                <!-- MIP Status Bar -->
                <div id="mip-status-bar" class="mip-status-bar hidden">
                    <div class="mip-row mip-row-primary">
                        <div class="mip-stat-block hp" id="hp-block">
                            <div class="stat-header">
                                <span class="stat-label" id="hp-label"><svg class="stat-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg></span>
                                <span class="stat-value" id="hp-value">0/0</span>
                            </div>
                            <div class="stat-bar">
                                <div class="stat-fill" id="hp-fill"></div>
                            </div>
                        </div>
                        <div class="mip-stat-block sp hidden" id="sp-block">
                            <div class="stat-header">
                                <span class="stat-label" id="sp-label"><svg class="stat-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg></span>
                                <span class="stat-value" id="sp-value">0/0</span>
                            </div>
                            <div class="stat-bar">
                                <div class="stat-fill" id="sp-fill"></div>
                            </div>
                        </div>
                        <div class="mip-stat-block gp1 hidden" id="gp1-block">
                            <div class="stat-header">
                                <span class="stat-label" id="gp1-label"><svg class="stat-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg></span>
                                <span class="stat-value" id="gp1-value">0/0</span>
                            </div>
                            <div class="stat-bar">
                                <div class="stat-fill" id="gp1-fill"></div>
                            </div>
                        </div>
                        <div class="mip-stat-block gp2 hidden" id="gp2-block">
                            <div class="stat-header">
                                <span class="stat-label" id="gp2-label"><svg class="stat-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 7l8 5 8-5-8-5zm0 7.5L5.5 5 12 1.5 18.5 5 12 9.5zM4 12l8 5 8-5v5l-8 5-8-5v-5z"/></svg></span>
                                <span class="stat-value" id="gp2-value">0/0</span>
                            </div>
                            <div class="stat-bar">
                                <div class="stat-fill" id="gp2-fill"></div>
                            </div>
                        </div>
                        <div class="mip-stat-block enemy" id="enemy-block">
                            <div class="stat-header">
                                <span class="stat-label"><svg class="stat-icon" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg></span>
                                <span class="stat-enemy-name" id="enemy-name"></span>
                                <span class="stat-value" id="enemy-value">0%</span>
                            </div>
                            <div class="stat-bar">
                                <div class="stat-fill" id="enemy-fill" style="width:0%"></div>
                            </div>
                        </div>
                    </div>
                    <div class="mip-row mip-row-secondary">
                        <div class="mip-guild-line" id="mip-gline1"></div>
                        <div class="mip-guild-line" id="mip-gline2"></div>
                        <div class="mip-location">
                            <span class="mip-room" id="mip-room"></span>
                            <span class="mip-exits" id="mip-exits"></span>
                        </div>
                    </div>
                </div>
                <div class="input-container">
                    <div class="input-wrapper">
                        <input type="text" id="command-input" placeholder="Enter command..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus>
                        <button id="send-btn">Send</button>
                    </div>
                </div>
            </div>
            </div>
            <!-- End Terminal Area -->

            <!-- Side Panel (for Settings) -->
            <aside id="side-panel" class="side-panel">
                <div class="panel-header">
                    <h3>Panel</h3>
                    <button class="panel-close">&times;</button>
                </div>
                <div class="panel-content" id="panel-content">
                    <!-- Dynamic content loaded here -->
                </div>
            </aside>

            <!-- Actions Sidebar (docked, resizable) -->
            <aside id="scripts-sidebar" class="scripts-sidebar">
                <div class="scripts-resize-handle"></div>
                <div class="scripts-sidebar-header">
                    <h3>Actions</h3>
                    <button class="scripts-sidebar-close" id="scripts-sidebar-close">&times;</button>
                </div>
                <div class="scripts-sidebar-content" id="scripts-sidebar-content">
                    <!-- Classes and items rendered by JavaScript -->
                </div>
                <div class="scripts-sidebar-footer">
                    <button class="btn btn-sm" id="add-class-btn">+ Class</button>
                    <input type="file" id="script-file-input" accept=".txt,.tin" style="display:none">
                    <button class="btn btn-sm" id="upload-script-btn" title="Upload .tin or .txt file">Upload</button>
                    <button class="btn btn-sm btn-danger btn-close-sidebar" id="close-scripts-btn">Close</button>
                </div>
            </aside>
        </div>
    </div>

    <!-- Trigger Modal -->
    <div class="modal-overlay" id="trigger-modal">
        <div class="modal">
            <div class="modal-header">
                <h3>Trigger</h3>
                <button class="panel-close" onclick="wmtClient.closeModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="trigger-name">Name (optional)</label>
                    <input type="text" id="trigger-name" placeholder="My Trigger">
                </div>
                <div class="form-group">
                    <label for="trigger-pattern">Pattern *</label>
                    <input type="text" id="trigger-pattern" placeholder="Text to match">
                </div>
                <div class="form-group">
                    <label for="trigger-class">Class</label>
                    <select id="trigger-class">
                        <option value="">No Class</option>
                        <!-- Populated by JavaScript -->
                    </select>
                </div>
                <div class="help-text" style="font-size:0.85em; color:#888; margin-bottom:15px; padding:10px; background:#111; border-radius:4px;">
                    <strong>TinTin++ Pattern Support:</strong><br>
                    <code>%*</code> any text &nbsp; <code>%+</code> 1+ chars &nbsp; <code>%d</code> digits &nbsp; <code>%w</code> word<br>
                    <code>%1</code>-<code>%99</code> capture groups &nbsp; <code>^</code>/<code>$</code> anchors &nbsp; <code>{a|b}</code> alternation<br>
                    <strong>Example:</strong> <code>^%1 tells you '%2'</code> → <code>reply %1 Got it: %2</code>
                </div>
                <div class="form-group">
                    <label>Actions</label>
                    <div id="trigger-actions" class="action-list"></div>
                    <button type="button" class="btn btn-secondary btn-sm add-action-btn" onclick="wmtClient.addTriggerAction()">
                        + Add Action
                    </button>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="wmtClient.closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="wmtClient.saveTrigger()">Save</button>
            </div>
        </div>
    </div>

    <!-- Alias Modal -->
    <div class="modal-overlay" id="alias-modal">
        <div class="modal">
            <div class="modal-header">
                <h3>Alias</h3>
                <button class="panel-close" onclick="wmtClient.closeModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="alias-pattern">Pattern *</label>
                    <input type="text" id="alias-pattern" placeholder="e.g., kk or kk %*">
                </div>
                <div class="form-group">
                    <label for="alias-replacement">Replacement *</label>
                    <textarea id="alias-replacement" rows="3" placeholder="e.g., kill kobold; get all from corpse"></textarea>
                </div>
                <div class="form-group">
                    <label for="alias-class">Class</label>
                    <select id="alias-class">
                        <option value="">No Class</option>
                        <!-- Populated by JavaScript -->
                    </select>
                </div>
                <div id="alias-help" class="help-text" style="font-size:0.85em; color:#888; margin-top:10px; padding:10px; background:#111; border-radius:4px;">
                    <strong>Simple:</strong> <code>kk</code> → <code>kill kobold</code><br>
                    <strong>With args:</strong> <code>kk $1</code> → <code>kill $1; get all</code> ($1, $2... = words, $* = all)<br>
                    <strong>TinTin++:</strong> <code>%1 x%2</code> → <code>#%2 %1</code> (%* = any, %d = digits)<br>
                    Separate commands with semicolons or newlines.
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="wmtClient.closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="wmtClient.saveAlias()">Save</button>
            </div>
        </div>
    </div>

    <!-- Gag Modal -->
    <div class="modal-overlay" id="gag-modal">
        <div class="modal">
            <div class="modal-header">
                <h3>Gag</h3>
                <button class="panel-close" onclick="wmtClient.closeModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="gag-name">Name (optional)</label>
                    <input type="text" id="gag-name" placeholder="My Gag">
                </div>
                <div class="form-group">
                    <label for="gag-pattern">Pattern *</label>
                    <input type="text" id="gag-pattern" placeholder="Text to hide">
                </div>
                <div class="form-group">
                    <label for="gag-class">Class</label>
                    <select id="gag-class">
                        <option value="">No Class</option>
                    </select>
                </div>
                <div class="help-text" style="font-size:0.85em; color:#888; padding:10px; background:#111; border-radius:4px;">
                    Lines matching this pattern will be hidden. Supports TinTin++ patterns (<code>%*</code>, <code>%d</code>, <code>^</code>/<code>$</code>).
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="wmtClient.closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="wmtClient.saveGag()">Save</button>
            </div>
        </div>
    </div>

    <!-- Highlight Modal -->
    <div class="modal-overlay" id="highlight-modal">
        <div class="modal">
            <div class="modal-header">
                <h3>Highlight</h3>
                <button class="panel-close" onclick="wmtClient.closeModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="highlight-pattern">Pattern *</label>
                    <input type="text" id="highlight-pattern" placeholder="Text to highlight">
                    <div style="font-size:0.8em; color:#888; margin-top:4px;">Supports TinTin++ patterns (<code>%*</code>, <code>%d</code>, <code>^</code>/<code>$</code>)</div>
                </div>
                <div class="form-group">
                    <label>Text Color (Foreground)</label>
                    <div class="color-preset-grid" id="fg-color-grid">
                        <button type="button" class="color-preset fg-preset" data-color="#ff0000" style="background:#ff0000" title="Red"></button>
                        <button type="button" class="color-preset fg-preset" data-color="#ff6666" style="background:#ff6666" title="Light Red"></button>
                        <button type="button" class="color-preset fg-preset" data-color="#ff8800" style="background:#ff8800" title="Orange"></button>
                        <button type="button" class="color-preset fg-preset" data-color="#ffff00" style="background:#ffff00" title="Yellow"></button>
                        <button type="button" class="color-preset fg-preset" data-color="#00ff00" style="background:#00ff00" title="Green"></button>
                        <button type="button" class="color-preset fg-preset" data-color="#66ff66" style="background:#66ff66" title="Light Green"></button>
                        <button type="button" class="color-preset fg-preset" data-color="#00ffff" style="background:#00ffff" title="Cyan"></button>
                        <button type="button" class="color-preset fg-preset" data-color="#0088ff" style="background:#0088ff" title="Blue"></button>
                        <button type="button" class="color-preset fg-preset" data-color="#ff00ff" style="background:#ff00ff" title="Magenta"></button>
                        <button type="button" class="color-preset fg-preset" data-color="#ff88ff" style="background:#ff88ff" title="Pink"></button>
                        <button type="button" class="color-preset fg-preset" data-color="#ffffff" style="background:#ffffff" title="White"></button>
                        <button type="button" class="color-preset fg-preset" data-color="" style="background:linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%),linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%);background-size:8px 8px;background-position:0 0,4px 4px" title="None"></button>
                    </div>
                    <div style="margin-top:8px; display:flex; align-items:center; gap:10px;">
                        <label for="highlight-fg-color" style="margin:0; white-space:nowrap;">Custom:</label>
                        <input type="color" id="highlight-fg-color" value="#ff0000" style="width:50px; height:30px; padding:0; border:none; cursor:pointer;">
                        <label style="margin:0; display:flex; align-items:center; gap:4px;"><input type="checkbox" id="highlight-fg-enabled" checked> Enable</label>
                    </div>
                </div>
                <div class="form-group">
                    <label>Background Color</label>
                    <div class="color-preset-grid" id="bg-color-grid">
                        <button type="button" class="color-preset bg-preset" data-color="" style="background:linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%),linear-gradient(45deg,#333 25%,transparent 25%,transparent 75%,#333 75%);background-size:8px 8px;background-position:0 0,4px 4px" title="None"></button>
                        <button type="button" class="color-preset bg-preset" data-color="#330000" style="background:#330000" title="Dark Red"></button>
                        <button type="button" class="color-preset bg-preset" data-color="#333300" style="background:#333300" title="Dark Yellow"></button>
                        <button type="button" class="color-preset bg-preset" data-color="#003300" style="background:#003300" title="Dark Green"></button>
                        <button type="button" class="color-preset bg-preset" data-color="#003333" style="background:#003333" title="Dark Cyan"></button>
                        <button type="button" class="color-preset bg-preset" data-color="#000033" style="background:#000033" title="Dark Blue"></button>
                        <button type="button" class="color-preset bg-preset" data-color="#330033" style="background:#330033" title="Dark Magenta"></button>
                        <button type="button" class="color-preset bg-preset" data-color="#222222" style="background:#222222" title="Dark Gray"></button>
                        <button type="button" class="color-preset bg-preset" data-color="#442200" style="background:#442200" title="Brown"></button>
                        <button type="button" class="color-preset bg-preset" data-color="#004422" style="background:#004422" title="Teal"></button>
                        <button type="button" class="color-preset bg-preset" data-color="#220044" style="background:#220044" title="Purple"></button>
                        <button type="button" class="color-preset bg-preset" data-color="#444444" style="background:#444444" title="Gray"></button>
                    </div>
                    <div style="margin-top:8px; display:flex; align-items:center; gap:10px;">
                        <label for="highlight-bg-color" style="margin:0; white-space:nowrap;">Custom:</label>
                        <input type="color" id="highlight-bg-color" value="#333300" style="width:50px; height:30px; padding:0; border:none; cursor:pointer;">
                        <label style="margin:0; display:flex; align-items:center; gap:4px;"><input type="checkbox" id="highlight-bg-enabled"> Enable</label>
                    </div>
                </div>
                <div class="form-group">
                    <div style="display:flex; gap:20px; align-items:center;">
                        <span style="color:#888; white-space:nowrap;">Text Styles:</span>
                        <label style="margin:0; display:flex; align-items:center; gap:4px;"><input type="checkbox" id="highlight-blink"> Blink</label>
                        <label style="margin:0; display:flex; align-items:center; gap:4px;"><input type="checkbox" id="highlight-underline"> Underline</label>
                    </div>
                </div>
                <div class="form-group">
                    <label>Preview</label>
                    <div id="highlight-preview" style="padding:8px 12px; background:#000; border-radius:4px; font-family:monospace;">
                        <span id="highlight-preview-text" style="color:#ff0000;">Sample highlighted text</span>
                    </div>
                </div>
                <div class="form-group">
                    <label for="highlight-class">Class</label>
                    <select id="highlight-class">
                        <option value="">No Class</option>
                    </select>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="wmtClient.closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="wmtClient.saveHighlight()">Save</button>
            </div>
        </div>
    </div>

    <!-- Substitute Modal -->
    <div class="modal-overlay" id="substitute-modal">
        <div class="modal">
            <div class="modal-header">
                <h3>Substitute</h3>
                <button class="panel-close" onclick="wmtClient.closeModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="substitute-pattern">Pattern *</label>
                    <input type="text" id="substitute-pattern" placeholder="Text to match">
                </div>
                <div class="form-group">
                    <label for="substitute-replacement">Replacement *</label>
                    <input type="text" id="substitute-replacement" placeholder="Replace with...">
                </div>
                <div class="form-group">
                    <label for="substitute-class">Class</label>
                    <select id="substitute-class">
                        <option value="">No Class</option>
                    </select>
                </div>
                <div class="help-text" style="font-size:0.85em; color:#888; padding:10px; background:#111; border-radius:4px;">
                    <strong>TinTin++ Pattern Support:</strong><br>
                    <code>%*</code> any text &nbsp; <code>%d</code> digits &nbsp; <code>%w</code> word &nbsp; <code>%1</code>-<code>%99</code> captures<br>
                    <strong>Use captures in replacement:</strong> <code>%1</code>, <code>%2</code>, etc.<br>
                    <strong>Example:</strong> Pattern <code>%1 hits %2</code> → Replacement <code>%1 SMASHES %2</code>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="wmtClient.closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="wmtClient.saveSubstitute()">Save</button>
            </div>
        </div>
    </div>

    <!-- Ticker Modal -->
    <div class="modal-overlay" id="ticker-modal">
        <div class="modal">
            <div class="modal-header">
                <h3>New Ticker</h3>
                <button class="panel-close" onclick="wmtClient.closeModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label for="ticker-name">Name *</label>
                    <input type="text" id="ticker-name" placeholder="e.g., autosave">
                </div>
                <div class="form-group">
                    <label for="ticker-command">Command(s) *</label>
                    <textarea id="ticker-command" rows="2" placeholder="e.g., save; look"></textarea>
                </div>
                <div class="form-group">
                    <label for="ticker-interval">Interval (seconds) *</label>
                    <input type="number" id="ticker-interval" min="1" step="1" value="60" placeholder="60">
                </div>
                <div class="form-group">
                    <label for="ticker-class">Class (optional)</label>
                    <select id="ticker-class"></select>
                </div>
                <div class="help-text" style="font-size:0.85em; color:#888; padding:10px; background:#111; border-radius:4px;">
                    Tickers run server-side and persist across sessions.<br>
                    They continue running even when your browser is closed.<br>
                    Assign to a class to enable/disable with other automation.
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="wmtClient.closeModal()">Cancel</button>
                <button class="btn btn-primary" onclick="wmtClient.saveTicker()">Save</button>
            </div>
        </div>
    </div>

    <!-- MIP Conditions Modal -->
    <div class="modal-overlay" id="mip-conditions-modal">
        <div class="modal">
            <div class="modal-header">
                <h3 id="mip-conditions-title">Conditions</h3>
                <button class="panel-close" onclick="wmtClient.closeMipConditionsModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div class="mip-current-value">
                    <span id="mip-cond-var-label">Current:</span>
                    <span id="mip-cond-var-value" class="mip-value-display">0</span>
                </div>

                <div id="mip-conditions-list" class="mip-conditions-list">
                    <!-- Existing conditions will be listed here -->
                </div>

                <div class="mip-add-condition">
                    <h4 id="mip-form-title">Add Condition</h4>
                    <div class="form-row mip-primary-condition">
                        <div class="form-group" style="flex:2">
                            <label>Variable</label>
                            <select id="mip-cond-variable">
                                <!-- Options populated dynamically based on available stats -->
                            </select>
                        </div>
                        <div class="form-group" style="flex:2">
                            <label>Operator</label>
                            <select id="mip-cond-operator">
                                <option value="<">&lt; (less than)</option>
                                <option value="<=">&lt;= (less or equal)</option>
                                <option value=">">&gt; (greater than)</option>
                                <option value=">=">&gt;= (greater or equal)</option>
                                <option value="==">== (equals)</option>
                                <option value="!=">!= (not equals)</option>
                            </select>
                        </div>
                        <div class="form-group" style="flex:1">
                            <label>Value</label>
                            <input type="number" id="mip-cond-value" value="50">
                        </div>
                    </div>

                    <!-- Sub-conditions container -->
                    <div id="mip-sub-conditions"></div>

                    <div class="mip-sub-condition-buttons">
                        <button type="button" class="btn btn-small" onclick="wmtClient.addSubCondition('AND')">+ AND</button>
                        <button type="button" class="btn btn-small" onclick="wmtClient.addSubCondition('OR')">+ OR</button>
                    </div>

                    <div class="form-group">
                        <label>Command to Execute</label>
                        <input type="text" id="mip-cond-command" placeholder="e.g., drink healing potion">
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" id="mip-cancel-btn" onclick="wmtClient.cancelMipConditionEdit()">Close</button>
                <button class="btn btn-primary" id="mip-save-btn" onclick="wmtClient.saveMipCondition()">Add</button>
            </div>
        </div>
    </div>

    <!-- Channel Settings Modal -->
    <div class="modal-overlay" id="channel-settings-modal">
        <div class="modal">
            <div class="modal-header">
                <h3>Channel Settings</h3>
                <button class="panel-close" onclick="wmtClient.closeChannelSettingsModal()">&times;</button>
            </div>
            <div class="modal-body">
                <p class="settings-hint" style="margin-bottom: 15px;">
                    Configure per-channel settings. Channels appear here after receiving messages.
                </p>
                <div id="channel-list" class="channel-settings-list">
                    <!-- Channel rows populated dynamically -->
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="wmtClient.closeChannelSettingsModal()">Close</button>
                <button class="btn btn-primary" onclick="wmtClient.saveChannelSettings()">Save</button>
            </div>
        </div>
    </div>

    <script>
        // Configuration from PHP
        window.WMT_CONFIG = {
            wsUrl: '<?= WS_CLIENT_URL ?>',
            mudHost: '<?= $mudHost ?>',
            mudPort: <?= $mudPort ?>,
            userId: '<?= $userId ?>',
            characterId: '<?= $characterId ?>',
            characterName: '<?= htmlspecialchars($characterName, ENT_QUOTES) ?>',
            characterServer: '<?= $characterServer ?>',
            csrfToken: '<?= generateCsrfToken() ?>',
            newMudChar: '<?= htmlspecialchars($newMudChar, ENT_QUOTES) ?>',
            wsToken: '<?= $wsToken ?>',
            isWizard: <?= $isWizard ? 'true' : 'false' ?>
        };
    </script>
    <script src="assets/js/connection.js?v=<?= filemtime('assets/js/connection.js') ?>"></script>
    <script src="assets/js/app.js?v=<?= filemtime('assets/js/app.js') ?>"></script>
</body>
</html>
