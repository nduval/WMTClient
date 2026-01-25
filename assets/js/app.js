/**
 * WMT Client - Main Application
 */

class WMTClient {
    constructor() {
        this.connection = null;
        this.commandHistory = [];
        this.historyIndex = -1;
        this.maxHistorySize = 500;  // Default, can be changed in settings
        this.historySearchPrefix = '';  // For filtered history search
        this.historySearchMatches = [];  // Filtered matches
        this.historySearchIndex = -1;  // Index within filtered matches
        this.pendingScroll = false;  // For throttled scroll updates
        this.triggers = [];
        this.aliases = [];
        this.classes = [];
        this.preferences = {};
        this.currentPanel = null;
        this.editingItem = null;
        this.characterPassword = '';
        this.passwordSent = false;

        // Tickers (server-side, persistent) and delays (client-side only)
        this.tickers = [];  // Array of ticker objects: {id, name, command, interval, enabled, class}
        this.delays = {};   // {name: {command, timerId}} - still client-side
        this.delayCounter = 0;  // Counter for auto-generated delay names

        // Variables for #var/#unvar (TinTin++ style)
        this.variables = {};

        // Functions for #function (TinTin++ style) - called with @name{args}
        this.functions = {};  // {name: {body: string}}

        // Local variable scope stack for #local
        // Each scope is an object of {varName: value}
        // Push on function/alias entry, pop on exit
        this.localScopes = [];

        // Event handlers for #event (TinTin++ style)
        // {eventName: [{body: string, class: string}]}
        this.eventHandlers = {};

        // Loop control flags for #break and #continue
        this.loopBreak = false;
        this.loopContinue = false;

        // Prompts for #prompt command (like triggers but display to split area)
        this.prompts = [];

        // Speedwalk configuration
        this.speedwalkEnabled = false;
        this.pathdirs = {
            // Default TinTin++ pathdirs: {dir: {reverse, coord}}
            'n': { reverse: 's', coord: 1 },
            'e': { reverse: 'w', coord: 2 },
            'ne': { reverse: 'sw', coord: 3 },
            's': { reverse: 'n', coord: 4 },
            'se': { reverse: 'nw', coord: 6 },
            'w': { reverse: 'e', coord: 8 },
            'nw': { reverse: 'se', coord: 9 },
            'sw': { reverse: 'ne', coord: 12 },
            'u': { reverse: 'd', coord: 16 },
            'd': { reverse: 'u', coord: 32 }
        };

        // MIP (MUD Interface Protocol) state
        this.mipEnabled = false;
        this.mipStarted = false;  // Tracks if MIP has been started this session
        this.mipId = null;
        this.mipVersion = '1.0.0';
        this.mipDebug = false;

        // Smart auto-scroll state
        this.userScrolledUp = false;  // Tracks if user manually scrolled up
        this.lastScrollTop = 0;  // Track scroll position to detect user scrolling UP vs content growing
        this.ignoreScrollEvents = false;  // Temporarily ignore scroll events (for mobile keyboard)

        // MIP Variables - auto-populated from MIP data
        this.mipVars = {
            hp: 0, hp_max: 0, hp_pct: 0,
            sp: 0, sp_max: 0, sp_pct: 0,
            gp1: 0, gp1_max: 0, gp1_pct: 0, gp1_name: 'GP1',
            gp2: 0, gp2_max: 0, gp2_pct: 0, gp2_name: 'GP2',
            enemy: 0, round: 0,
            room: '', exits: ''
        };
        this.mipReady = false;  // Only true after receiving first valid MIP stats

        // MIP Conditions - user-defined triggers based on MIP values
        // Each condition: {id, variable, operator, value, command, enabled, lastTriggered, subConditions: [{logic, variable, operator, value}]}
        this.mipConditions = [];
        this.mipConditionCooldown = 5000;  // Minimum ms between same condition firing
        this.pendingSubConditions = [];  // Sub-conditions being added in the modal

        // Wake Lock API - keeps screen awake
        this.wakeLockSentinel = null;
        this.wakeLockVisibilityHandlerAdded = false;

        // Split screen configuration (TinTin++ #split)
        this.splitConfig = { top: 0, bottom: 0 };
        this.splitRows = { top: [], bottom: [] };

        // Health check for detecting zombie WebSocket connections
        this.healthCheckTimeout = null;
        this.healthCheckPending = false;
        this.healthCheckInterval = null;

        // Idle disconnect (deadman switch) - disconnects if user hasn't typed in X minutes
        this.lastUserInput = Date.now();
        this.idleCheckInterval = null;

        // Chat window state
        this.chatWindowOpen = false;
        this.chatWindowMode = 'floating'; // 'docked', 'floating', 'popout'
        this.chatPopoutWindow = null;
        this.chatDragOffset = { x: 0, y: 0 };
        this.chatIsDragging = false;

        // Channel preferences for ChatMon
        // Format: { channelName: { sound: bool, hidden: bool, discord: bool, webhookUrl: string } }
        this.channelPrefs = {};

        // Current class being filled when reading scripts
        this.currentScriptClass = null;

        this.init();
    }

    async init() {
        try {
            await this.loadSettings();
            this.applyPreferences();
            this.setupConnection();
            this.bindEvents();
            this.initPanels();
        } catch (e) {
            console.error('Init failed:', e);
        }
    }

    async loadSettings() {
        try {
            // Load triggers
            const triggersRes = await fetch('api/triggers.php?action=list');
            const triggersData = await triggersRes.json();
            if (triggersData.success) {
                this.triggers = triggersData.triggers || [];
            }

            // Load aliases
            const aliasesRes = await fetch('api/aliases.php?action=list');
            const aliasesData = await aliasesRes.json();
            if (aliasesData.success) {
                this.aliases = aliasesData.aliases || [];
            }

            // Load tickers
            const tickersRes = await fetch('api/tickers.php?action=list');
            const tickersData = await tickersRes.json();
            if (tickersData.success) {
                this.tickers = tickersData.tickers || [];
            }

            // Load classes
            const classesRes = await fetch('api/classes.php?action=list');
            const classesData = await classesRes.json();
            if (classesData.success) {
                this.classes = classesData.classes || [];
            }

            // Load preferences
            const prefsRes = await fetch('api/preferences.php?action=get');
            const prefsData = await prefsRes.json();
            if (prefsData.success) {
                this.preferences = prefsData.preferences || {};
                // Load channel preferences (each channel can have its own webhook)
                this.channelPrefs = this.preferences.channelPrefs || {};
            }

            // Load character password for auto-login
            const pwRes = await fetch('api/characters.php?action=get_password');
            const pwData = await pwRes.json();
            if (pwData.success && pwData.password) {
                this.characterPassword = pwData.password;
            }

            // Load MIP conditions
            await this.loadMipConditions();

            // Load prompts from localStorage
            this.loadPrompts();
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    }

    applyPreferences() {
        const output = document.getElementById('mud-output');
        const mipBar = document.getElementById('mip-status-bar');
        if (!output) return;

        const prefs = this.preferences;

        if (prefs.fontFamily) {
            output.style.setProperty('--mud-font', prefs.fontFamily);
            if (mipBar) mipBar.style.setProperty('--mud-font', prefs.fontFamily);
        }
        if (prefs.fontSize) {
            output.style.setProperty('--mud-font-size', prefs.fontSize + 'px');
            if (mipBar) mipBar.style.setProperty('--mud-font-size', prefs.fontSize + 'px');
        }
        if (prefs.textColor) {
            output.style.setProperty('--mud-text-color', prefs.textColor);
        }
        if (prefs.backgroundColor) {
            output.style.setProperty('--mud-bg-color', prefs.backgroundColor);
        }

        // Apply MIP debug setting
        if (prefs.mipDebug !== undefined) {
            this.mipDebug = prefs.mipDebug;
            // Update server if MIP is enabled
            if (this.mipEnabled) {
                this.connection?.setMip(true, this.mipId, this.mipDebug);
            }
        }

        // Update MIP-dependent UI (HP bar, ChatMon button)
        this.updateMipDependentUI(prefs.mipEnabled !== false);

        // Apply individual MIP element visibility (room name, exits, guild, etc.)
        this.updateMipElementVisibility();

        // Handle wake lock preference
        if (prefs.wakeLock) {
            this.requestWakeLock();
        } else {
            this.releaseWakeLock();
        }

        // Apply history size
        if (prefs.historySize) {
            this.maxHistorySize = prefs.historySize;
            // Trim history if it exceeds new size
            while (this.commandHistory.length > this.maxHistorySize) {
                this.commandHistory.pop();
            }
        }

        // Restart idle checker if setting changed (deadman switch)
        if (this.connection && this.connection.connected) {
            this.startIdleChecker();
        }
    }

    // Wake Lock API - prevents screen from sleeping
    async requestWakeLock() {
        if (!('wakeLock' in navigator)) {
            console.log('Wake Lock API not supported');
            return;
        }

        // Set up visibility handler only once
        if (!this.wakeLockVisibilityHandlerAdded) {
            this.wakeLockVisibilityHandlerAdded = true;
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible' && this.preferences.wakeLock) {
                    // Delay wake lock request slightly to avoid conflicts on PWA resume
                    setTimeout(() => this.requestWakeLock(), 100);
                }
            });
        }

        try {
            this.wakeLockSentinel = await navigator.wakeLock.request('screen');
            console.log('Wake lock acquired');
        } catch (err) {
            console.log('Wake lock request failed:', err.message);
        }
    }

    releaseWakeLock() {
        if (this.wakeLockSentinel) {
            this.wakeLockSentinel.release();
            this.wakeLockSentinel = null;
            console.log('Wake lock released manually');
        }
    }

    // Health check to detect zombie WebSocket connections
    // Sends a ping, expects a response within timeout
    // If no response, connection is dead - force reconnect
    verifyConnectionHealth() {
        // Don't stack health checks
        if (this.healthCheckPending) {
            console.log('Health check already pending, skipping');
            return;
        }

        // Only check if fully connected and authenticated
        if (!this.connection || !this.connection.socket ||
            this.connection.socket.readyState !== WebSocket.OPEN ||
            !this.connection.authenticated) {
            console.log('Not fully connected, skipping health check');
            return;
        }

        console.log('Starting health check...');
        this.healthCheckPending = true;

        const sent = this.connection.send('health_check');
        if (!sent) {
            console.log('Failed to send health check');
            this.healthCheckPending = false;
            return;
        }

        // If no response within 5 seconds, connection is zombie
        this.healthCheckTimeout = setTimeout(() => {
            console.log('Health check timeout - connection is zombie, reconnecting...');
            this.healthCheckPending = false;
            this.healthCheckTimeout = null;

            // Prevent onclose from also trying to reconnect
            if (this.connection) {
                this.connection.intentionalDisconnect = true;
                this.connection.stopKeepAlive();

                // Force close the zombie socket
                if (this.connection.socket) {
                    try {
                        this.connection.socket.close();
                    } catch (e) {
                        console.log('Error closing socket:', e);
                    }
                }

                // Now manually reconnect (reset flag first)
                this.connection.intentionalDisconnect = false;
                this.connection.reconnectAttempts = 0;
                setTimeout(() => {
                    if (this.connection) {
                        this.connection.connect();
                    }
                }, 200);
            }
        }, 5000);
    }

    // Called when server responds to health check
    onHealthCheckResponse() {
        if (this.healthCheckTimeout) {
            clearTimeout(this.healthCheckTimeout);
            this.healthCheckTimeout = null;
        }
        this.healthCheckPending = false;
    }

    // Start periodic health checks (every 30 seconds)
    startPeriodicHealthCheck() {
        this.stopPeriodicHealthCheck();
        this.healthCheckInterval = setInterval(() => {
            this.verifyConnectionHealth();
        }, 30000);
    }

    // Stop periodic health checks
    stopPeriodicHealthCheck() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        // Also clear any pending health check
        if (this.healthCheckTimeout) {
            clearTimeout(this.healthCheckTimeout);
            this.healthCheckTimeout = null;
        }
        this.healthCheckPending = false;
    }

    // Start idle disconnect checker (deadman switch)
    // Disconnects if user hasn't manually typed a command in X minutes
    startIdleChecker() {
        this.stopIdleChecker();

        const idleMinutes = this.preferences.idleDisconnectMinutes;
        if (!idleMinutes || idleMinutes <= 0) {
            return; // Disabled
        }

        const idleTimeoutMs = idleMinutes * 60 * 1000;

        // Check every 30 seconds
        this.idleCheckInterval = setInterval(() => {
            const idleMs = Date.now() - this.lastUserInput;
            const idleMinutesElapsed = Math.floor(idleMs / 60000);

            // Warn at 1 minute before disconnect
            if (idleMs >= idleTimeoutMs - 60000 && idleMs < idleTimeoutMs - 55000) {
                this.appendOutput(`Warning: You will be disconnected in 1 minute due to inactivity. Type any command to stay connected.`, 'system');
                this.playNotificationSound();
            }

            // Disconnect when timeout reached
            if (idleMs >= idleTimeoutMs) {
                this.appendOutput(`Disconnecting after ${idleMinutes} minutes of inactivity.`, 'system');
                this.stopIdleChecker();
                if (this.connection) {
                    this.connection.disconnect();
                }
            }
        }, 30000);

        // Reset last input time when starting
        this.lastUserInput = Date.now();
    }

    // Stop idle disconnect checker
    stopIdleChecker() {
        if (this.idleCheckInterval) {
            clearInterval(this.idleCheckInterval);
            this.idleCheckInterval = null;
        }
    }

    // Get set of enabled class IDs
    getEnabledClassIds() {
        return new Set(
            this.classes
                .filter(c => c.enabled !== false)
                .map(c => c.id)
        );
    }

    // Filter triggers/aliases by enabled classes
    getFilteredTriggers() {
        const enabledClasses = this.getEnabledClassIds();
        return this.triggers.filter(t => {
            // If no class assigned, always include
            if (!t.class) return true;
            // If class assigned, check if class is enabled
            return enabledClasses.has(t.class);
        });
    }

    getFilteredAliases() {
        const enabledClasses = this.getEnabledClassIds();
        return this.aliases.filter(a => {
            // If no class assigned, always include
            if (!a.class) return true;
            // If class assigned, check if class is enabled
            return enabledClasses.has(a.class);
        });
    }

    getFilteredTickers() {
        const enabledClasses = this.getEnabledClassIds();
        return this.tickers.filter(t => {
            // If ticker is disabled, exclude
            if (!t.enabled) return false;
            // If no class assigned, always include
            if (!t.class) return true;
            // If class assigned, check if class is enabled
            return enabledClasses.has(t.class);
        });
    }

    // Send filtered triggers and aliases to server
    sendFilteredTriggersAndAliases() {
        this.connection.setTriggers(this.getFilteredTriggers());
        this.connection.setAliases(this.getFilteredAliases());
        this.connection.setTickers(this.getFilteredTickers());
        this.sendDiscordPrefsToServer();
    }

    // Send Discord preferences to server for server-side notifications (works when browser closed)
    sendDiscordPrefsToServer() {
        const charName = window.WMT_CONFIG?.characterName || 'WMT Client';
        this.connection.setDiscordPrefs(this.channelPrefs, charName);
    }

    setupConnection() {
        // Use configured WebSocket URL or fall back to default
        const wsUrl = window.WMT_CONFIG?.wsUrl || `ws://${window.location.hostname}:8080`;
        const wsToken = window.WMT_CONFIG?.wsToken || null;
        const userId = window.WMT_CONFIG?.userId || null;
        const characterId = window.WMT_CONFIG?.characterId || null;
        const isWizard = window.WMT_CONFIG?.isWizard || false;

        this.connection = new MudConnection({
            wsUrl: wsUrl,
            wsToken: wsToken,
            userId: userId,
            characterId: characterId,
            isWizard: isWizard,
            onConnect: () => this.onConnect(),
            onDisconnect: () => this.onDisconnect(),
            onMessage: (data) => this.onMessage(data),
            onError: (error) => this.onError(error),
            onStatusChange: (status) => this.updateConnectionStatus(status),
            onSessionResumed: (mudConnected) => this.onSessionResumed(mudConnected)
        });

        this.connection.connect();
    }

    onConnect() {
        this.appendOutput('Connected to WebSocket server.', 'system');
        this.passwordSent = false; // Reset for new connection
        this.mipStarted = false; // Reset MIP flag

        // Start periodic health checks to detect zombie connections
        this.startPeriodicHealthCheck();

        // Start idle disconnect checker (deadman switch)
        this.startIdleChecker();

        // Fire SESSION_CONNECTED event
        this.fireEvent('SESSION_CONNECTED');

        // Tell the proxy which server to connect to
        const mudHost = window.WMT_CONFIG.mudHost || '3k.org';
        const mudPort = window.WMT_CONFIG.mudPort || 3000;
        this.connection.setServer(mudHost, mudPort);

        // Send triggers and aliases to server (filtered by enabled classes)
        this.sendFilteredTriggersAndAliases();

        // MIP is now enabled after successful login (see onMessage password handling)

        // Send character name to MUD after connection
        // For new characters: sends name for registration
        // For existing characters: sends name to log in
        const charName = window.WMT_CONFIG.newMudChar || window.WMT_CONFIG.characterName;
        const serverName = mudHost === '3s.org' ? '3S' : '3K';
        if (charName) {
            setTimeout(() => {
                const nameLower = charName.toLowerCase();
                if (window.WMT_CONFIG.newMudChar) {
                    this.appendOutput(`Sending character name to ${serverName} for registration...`, 'system');
                } else {
                    this.appendOutput(`Sending character name to ${serverName}...`, 'system');
                }
                this.connection.sendCommand(nameLower);
                // Clear the newMudChar flag so it doesn't resend on reconnect
                window.WMT_CONFIG.newMudChar = '';
                // Remove the query parameter from URL without reload
                if (window.location.search.includes('newchar')) {
                    window.history.replaceState({}, document.title, 'app.php');
                }
            }, 1500);
        }
    }

    onSessionResumed(mudConnected) {
        // Called when reconnecting to an existing session (e.g., after app switch)
        // Restart periodic health checks
        this.startPeriodicHealthCheck();

        // Restart idle checker and reset last input time
        this.lastUserInput = Date.now();
        this.startIdleChecker();

        // Fire SESSION_RESUMED event
        this.fireEvent('SESSION_RESUMED');

        if (mudConnected) {
            this.appendOutput('Session resumed - MUD connection active.', 'system');
            // Re-send triggers and aliases in case they changed
            this.sendFilteredTriggersAndAliases();
            // MIP state is preserved server-side, but re-enable client tracking
            if (this.preferences.mipEnabled !== false) {
                this.mipEnabled = true;
            }
        } else {
            this.appendOutput('Session resumed - MUD was disconnected.', 'system');
            // MUD connection closed while we were away, treat like fresh connect
            this.onConnect();
        }
    }

    onDisconnect() {
        this.mipReady = false;  // Reset so conditions don't fire on stale data after reconnect
        // Stop health checks when disconnected
        this.stopPeriodicHealthCheck();
        // Stop idle checker when disconnected
        this.stopIdleChecker();

        // Fire SESSION_DISCONNECTED event
        this.fireEvent('SESSION_DISCONNECTED');

        // Only show disconnect message if it was intentional or we've given up reconnecting
        // Otherwise, stay quiet and let the reconnect happen - session resume will confirm success
        if (this.connection && (this.connection.intentionalDisconnect ||
            this.connection.reconnectAttempts >= this.connection.maxReconnectAttempts)) {
            this.appendOutput('Disconnected from server.', 'system');
        }
    }

    onMessage(data) {
        switch (data.type) {
            case 'mud':
                // Check for password prompt and auto-send password
                if (!this.passwordSent && this.characterPassword && data.line) {
                    // Check if this line contains "Password:" prompt
                    if (data.line.includes('Password:') || data.line.match(/password\s*:/i)) {
                        this.passwordSent = true;
                        setTimeout(() => {
                            this.appendOutput('Sending password...', 'system');
                            this.connection.sendCommand(this.characterPassword);
                        }, 500);
                    }
                }

                // For guest logins or manual logins - detect login success messages
                // Use fixed delays instead of trying to detect "jump" room (wizards skip it)
                if (!this.mipStarted && this.preferences.mipEnabled !== false && data.line) {
                    // Linkdeath recovery - character is already in world, use shorter delay
                    if (data.line.includes('welcomes you back from linkdeath')) {
                        this.mipStarted = true;
                        setTimeout(() => {
                            this.enableMip();
                        }, 4000);  // 4 seconds for linkdeath
                    }
                    // Fresh login - use fixed delay to ensure player is fully in-world
                    // This works for both normal players (who jump) and wizards (who skip stasis)
                    // Support both 3Kingdoms and 3Scapes
                    else if (!data.line.includes('linkdeath') &&
                             (data.line.includes('3Kingdoms welcomes you') ||
                              data.line.includes('entering 3Kingdoms') ||
                              data.line.includes('3Scapes welcomes you') ||
                              data.line.includes('entering 3Scapes'))) {
                        this.mipStarted = true;
                        setTimeout(() => {
                            this.enableMip();
                        }, 10000);  // 10 seconds for fresh login
                    }
                }

                this.appendOutput(data.line, 'mud', {
                    highlight: data.highlight,
                    sound: data.sound
                });
                break;

            case 'system':
                this.appendOutput(data.message, 'system');
                // Detect MUD connection closed
                if (data.message && data.message.includes('Connection to MUD closed')) {
                    this.updateConnectionStatus('mud_disconnected');
                }
                // Detect successful MUD connection
                if (data.message && data.message.includes('Connected to') && data.message.includes('!')) {
                    this.updateConnectionStatus('connected');
                }
                // Handle reconnect - send credentials when MUD connection is restored
                if (this.pendingReconnect && data.message && data.message.includes('Connected to')) {
                    this.pendingReconnect = false;
                    // Send character name after short delay
                    setTimeout(() => {
                        const charName = window.WMT_CONFIG.characterName;
                        if (charName) {
                            this.appendOutput('Sending character name...', 'system');
                            this.connection.sendCommand(charName.toLowerCase());
                        }
                    }, 500);
                }
                break;

            case 'error':
                this.appendOutput(data.message, 'error');
                break;

            case 'session_taken':
                // Another device took over this session
                this.appendOutput('Session taken over by another device. Refresh to reconnect.', 'system');
                this.updateConnectionStatus('disconnected');
                break;

            case 'broadcast':
                // Admin broadcast message - display prominently
                this.appendOutput('', 'system');
                this.appendOutput('==================== BROADCAST ====================', 'system');
                this.appendOutput(data.message, 'system');
                this.appendOutput('===================================================', 'system');
                this.appendOutput('', 'system');
                // Play notification sound if available
                this.playSound('beep');
                break;

            case 'keepalive_ack':
                // Keepalive acknowledged
                break;

            case 'health_ok':
                // Health check response - connection is alive
                this.onHealthCheckResponse();
                break;

            case 'client_command':
                // Execute client-side # command from trigger
                if (data.command && data.command.startsWith('#')) {
                    this.processClientCommand(data.command);
                }
                break;

            case 'disable_trigger':
                // Server detected a trigger loop - disable the offending trigger
                if (data.triggerId) {
                    const trigger = this.triggers.find(t => t.id === data.triggerId);
                    if (trigger && trigger.enabled) {
                        trigger.enabled = false;
                        this.saveTriggers();
                        this.renderScriptsSidebar();
                    }
                }
                break;

            case 'trigger_chatmon':
                // Trigger sent a message to ChatMon
                if (data.message) {
                    this.appendChatMessage(data.message, 'trigger', data.channel || 'trigger');
                }
                break;

            case 'mip_stats':
                // Update MIP status bar with stats from server
                if (data.stats) {
                    this.updateMipStatusBar(data.stats);
                    // Update server info (uptime/reboot)
                    this.updateServerInfo(data.stats);
                    // When debug is on, also log parsed guild lines
                    if (this.mipDebug && (data.stats.gline1Raw || data.stats.gline2Raw)) {
                        if (data.stats.gline1Raw) {
                            this.appendOutput(`[MIP I (gline1)] ${data.stats.gline1Raw}`, 'system');
                        }
                        if (data.stats.gline2Raw) {
                            this.appendOutput(`[MIP J (gline2)] ${data.stats.gline2Raw}`, 'system');
                        }
                    }
                }
                break;

            case 'mip_chat':
                // Handle MIP chat/tell messages
                if (data.message) {
                    this.appendChatMessage(data.message, data.chatType, data.channel, data.rawText);
                }
                break;

            case 'mip_debug':
                // Show raw MIP data when debug mode is on
                if (this.mipDebug) {
                    this.appendOutput(`[MIP ${data.msgType}] ${data.msgData}`, 'system');
                }
                break;
        }
    }

    // Update the MIP status bar with stats from server
    updateMipStatusBar(stats) {
        // Update MIP variables for conditions
        this.updateMipVars(stats);

        // HP (always show)
        this.updateStatBlock('hp', stats.hp.current, stats.hp.max, stats.hp.label, true);

        // SP (only show if max > 0)
        this.updateStatBlock('sp', stats.sp.current, stats.sp.max, stats.sp.label, stats.sp.max > 0);

        // GP1 (only show if max > 0)
        this.updateStatBlock('gp1', stats.gp1.current, stats.gp1.max, stats.gp1.label, stats.gp1.max > 0);

        // GP2 (only show if max > 0)
        this.updateStatBlock('gp2', stats.gp2.current, stats.gp2.max, stats.gp2.label, stats.gp2.max > 0);

        // Enemy health (always show bar, but value is 0 when not in combat)
        const enemyFill = document.getElementById('enemy-fill');
        const enemyValue = document.getElementById('enemy-value');
        const enemyName = document.getElementById('enemy-name');
        if (enemyFill) enemyFill.style.width = `${stats.enemy || 0}%`;
        if (enemyValue) enemyValue.textContent = `${stats.enemy || 0}%`;
        if (enemyName) {
            // Display enemy name, truncated if longer than 12 characters
            const name = stats.enemyName || '';
            if (name.length > 12) {
                enemyName.textContent = name.substring(0, 11) + '…';
                enemyName.title = name;  // Full name on hover
            } else {
                enemyName.textContent = name;
                enemyName.title = '';
            }
        }

        // Guild lines - wrap each stat item for smart flexbox wrapping
        const gline1 = document.getElementById('mip-gline1');
        const gline2 = document.getElementById('mip-gline2');
        if (gline1) gline1.innerHTML = this.wrapGuildStats(stats.gline1 || '');
        if (gline2) gline2.innerHTML = this.wrapGuildStats(stats.gline2 || '');

        // Room name
        const room = document.getElementById('mip-room');
        if (room && stats.room) {
            room.textContent = stats.room;
            room.title = stats.room;
        }

        // Exits
        const exits = document.getElementById('mip-exits');
        if (exits) {
            exits.textContent = stats.exits || '';
        }

        // Check MIP conditions after updating
        this.checkMipConditions();
    }

    // Wrap guild stats in spans for smart flexbox wrapping on mobile
    // Parses patterns like "Ammo:[0]", "Gxp: 53.4464%", "[....|.]"
    wrapGuildStats(html) {
        if (!html) return '';

        // First, protect any existing HTML spans (color formatting)
        // by replacing them with placeholders
        const spans = [];
        let safeHtml = html.replace(/<span[^>]*>.*?<\/span>/gi, (match) => {
            spans.push(match);
            return `\x00SPAN${spans.length - 1}\x00`;
        });

        // Pattern to match stat items:
        // - Word:[value] or Word: [value]
        // - Word: value (including %, /, decimals)
        // - Standalone [brackets] like [....|.]
        const items = [];

        // Match patterns and split into items
        // Regex: captures "Label:[val]", "Label: val", or standalone "[...]"
        const pattern = /(\w+:\s*\[[^\]]+\]|\w+:\s*[\w.%\/]+(?:\s+\w+)?|\[[^\]]+\])/g;

        let lastIndex = 0;
        let match;
        while ((match = pattern.exec(safeHtml)) !== null) {
            // Add any text before this match
            if (match.index > lastIndex) {
                const before = safeHtml.slice(lastIndex, match.index).trim();
                if (before) items.push(before);
            }
            items.push(match[1]);
            lastIndex = pattern.lastIndex;
        }
        // Add remaining text
        if (lastIndex < safeHtml.length) {
            const remaining = safeHtml.slice(lastIndex).trim();
            if (remaining) items.push(remaining);
        }

        // Wrap each item in a span and restore protected spans
        const wrapped = items.map(item => {
            // Restore any protected spans in this item
            let restored = item.replace(/\x00SPAN(\d+)\x00/g, (_, idx) => spans[parseInt(idx)]);
            return `<span class="guild-stat-item">${restored}</span>`;
        }).join('');

        return wrapped || html;
    }

    // Update server info display (uptime/reboot)
    updateServerInfo(stats) {
        const uptimeEl = document.getElementById('server-uptime');
        const rebootEl = document.getElementById('server-reboot');

        if (uptimeEl && stats.uptime !== undefined) {
            uptimeEl.textContent = stats.uptime || '';
        }
        if (rebootEl && stats.reboot !== undefined) {
            rebootEl.textContent = stats.reboot || '';
        }
    }

    // Update MIP variables from stats
    updateMipVars(stats) {
        // HP
        this.mipVars.hp = stats.hp.current;
        this.mipVars.hp_max = stats.hp.max;
        this.mipVars.hp_pct = stats.hp.max > 0 ? Math.round((stats.hp.current / stats.hp.max) * 100) : 0;

        // SP
        this.mipVars.sp = stats.sp.current;
        this.mipVars.sp_max = stats.sp.max;
        this.mipVars.sp_pct = stats.sp.max > 0 ? Math.round((stats.sp.current / stats.sp.max) * 100) : 0;

        // GP1
        this.mipVars.gp1 = stats.gp1.current;
        this.mipVars.gp1_max = stats.gp1.max;
        this.mipVars.gp1_pct = stats.gp1.max > 0 ? Math.round((stats.gp1.current / stats.gp1.max) * 100) : 0;
        this.mipVars.gp1_name = stats.gp1.label || 'GP1';

        // GP2
        this.mipVars.gp2 = stats.gp2.current;
        this.mipVars.gp2_max = stats.gp2.max;
        this.mipVars.gp2_pct = stats.gp2.max > 0 ? Math.round((stats.gp2.current / stats.gp2.max) * 100) : 0;
        this.mipVars.gp2_name = stats.gp2.label || 'GP2';

        // Enemy & Combat
        this.mipVars.enemy = stats.enemy || 0;
        this.mipVars.round = stats.round || 0;

        // Location
        this.mipVars.room = stats.room || '';
        this.mipVars.exits = stats.exits || '';

        // Guild variables (parsed from guild lines)
        if (stats.guildVars) {
            // Clear old guild vars first
            for (const key of Object.keys(this.mipVars)) {
                if (key.startsWith('guild_')) {
                    delete this.mipVars[key];
                }
            }
            // Copy new guild vars with 'guild_' prefix to avoid collisions
            for (const [key, value] of Object.entries(stats.guildVars)) {
                this.mipVars['guild_' + key] = value;
            }
        }

        // Mark MIP as ready once we receive valid stats (hp_max > 0 indicates real data)
        if (stats.hp.max > 0 && !this.mipReady) {
            this.mipReady = true;
            if (this.mipDebug) {
                this.appendOutput('[MIP] Stats received, conditions now active', 'system');
            }
        }
    }

    // Evaluate a single MIP condition expression
    evaluateMipCondition(variable, operator, value) {
        const currentValue = this.mipVars[variable];
        if (currentValue === undefined) return false;

        const compareValue = parseFloat(value);

        switch (operator) {
            case '<': return currentValue < compareValue;
            case '<=': return currentValue <= compareValue;
            case '>': return currentValue > compareValue;
            case '>=': return currentValue >= compareValue;
            case '==': return currentValue == compareValue;
            case '!=': return currentValue != compareValue;
            default: return false;
        }
    }

    // Check all MIP conditions and execute commands
    checkMipConditions() {
        // Don't evaluate conditions until we've received valid MIP stats
        if (!this.mipReady) return;

        const now = Date.now();

        for (const cond of this.mipConditions) {
            if (!cond.enabled) continue;

            // Check cooldown
            if (cond.lastTriggered && (now - cond.lastTriggered) < this.mipConditionCooldown) {
                continue;
            }

            // Evaluate primary condition
            let triggered = this.evaluateMipCondition(cond.variable, cond.operator, cond.value);

            // Evaluate sub-conditions if any
            if (cond.subConditions && cond.subConditions.length > 0) {
                for (const sub of cond.subConditions) {
                    const subResult = this.evaluateMipCondition(sub.variable, sub.operator, sub.value);

                    if (sub.logic === 'AND') {
                        triggered = triggered && subResult;
                    } else if (sub.logic === 'OR') {
                        triggered = triggered || subResult;
                    }
                }
            }

            if (triggered) {
                cond.lastTriggered = now;
                // Execute command
                if (cond.command.startsWith('#')) {
                    this.processClientCommand(cond.command);
                } else {
                    this.connection.sendCommand(cond.command);
                }
                if (this.mipDebug) {
                    let condDesc = `${cond.variable} ${cond.operator} ${cond.value}`;
                    if (cond.subConditions && cond.subConditions.length > 0) {
                        condDesc += ' ' + cond.subConditions.map(s => `${s.logic} ${s.variable} ${s.operator} ${s.value}`).join(' ');
                    }
                    this.appendOutput(`[MIP Condition] ${condDesc} -> ${cond.command}`, 'system');
                }
            }
        }
    }

    // Open MIP conditions modal for a specific stat
    openMipConditionsModal(statType) {
        this.currentConditionStat = statType;

        // Map stat type to default variable
        const varMap = {
            'hp': 'hp_pct',
            'sp': 'sp_pct',
            'gp1': 'gp1_pct',
            'gp2': 'gp2_pct',
            'enemy': 'enemy'
        };

        const defaultVar = varMap[statType] || 'hp_pct';

        // Set title based on stat type
        const titles = {
            'hp': 'HP Conditions',
            'sp': 'SP Conditions',
            'gp1': this.mipVars.gp1_name + ' Conditions',
            'gp2': this.mipVars.gp2_name + ' Conditions',
            'enemy': 'Enemy Conditions'
        };

        document.getElementById('mip-conditions-title').textContent = titles[statType] || 'Conditions';

        // Build variable options dynamically based on available stats
        const varSelect = document.getElementById('mip-cond-variable');
        varSelect.innerHTML = '';

        // Always available: HP, SP, Enemy, Round
        const baseOptions = [
            { value: 'hp_pct', label: 'HP %' },
            { value: 'hp', label: 'HP Current' },
            { value: 'sp_pct', label: 'SP %' },
            { value: 'sp', label: 'SP Current' }
        ];

        // Add GP1 options only if character has GP1
        if (this.mipVars.gp1_max > 0) {
            const gp1Name = this.mipVars.gp1_name || 'GP1';
            baseOptions.push(
                { value: 'gp1_pct', label: gp1Name + ' %' },
                { value: 'gp1', label: gp1Name + ' Current' }
            );
        }

        // Add GP2 options only if character has GP2
        if (this.mipVars.gp2_max > 0) {
            const gp2Name = this.mipVars.gp2_name || 'GP2';
            baseOptions.push(
                { value: 'gp2_pct', label: gp2Name + ' %' },
                { value: 'gp2', label: gp2Name + ' Current' }
            );
        }

        // Always add enemy and round
        baseOptions.push(
            { value: 'enemy', label: 'Enemy %' },
            { value: 'round', label: 'Combat Round' }
        );

        // Add guild variables dynamically
        const guildVars = [];
        for (const key of Object.keys(this.mipVars)) {
            if (key.startsWith('guild_')) {
                guildVars.push(key);
            }
        }
        // Sort guild vars and add to options
        guildVars.sort();
        for (const key of guildVars) {
            // Create readable label from key: guild_nukes_current -> Nukes Current
            const labelParts = key.replace('guild_', '').split('_');
            const label = labelParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
            baseOptions.push({ value: key, label: label });
        }

        // Populate dropdown
        baseOptions.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            varSelect.appendChild(option);
        });

        // Set default variable selection
        varSelect.value = defaultVar;

        // Clear any pending sub-conditions and reset editing state
        this.pendingSubConditions = [];
        this.editingConditionId = null;
        this.renderSubConditions();

        // Reset form UI
        document.getElementById('mip-cond-command').value = '';
        document.getElementById('mip-cond-value').value = '50';
        document.getElementById('mip-form-title').textContent = 'Add Condition';
        document.getElementById('mip-save-btn').textContent = 'Add';
        document.getElementById('mip-cancel-btn').textContent = 'Close';

        // Update current value display
        this.updateConditionValueDisplay();

        // Render existing conditions for this stat type
        this.renderMipConditions(statType);

        // Show modal
        document.getElementById('mip-conditions-modal').classList.add('open');
    }

    closeMipConditionsModal() {
        document.getElementById('mip-conditions-modal').classList.remove('open');
        this.currentConditionStat = null;
        this.editingConditionId = null;
    }

    // Get variable options HTML based on available stats
    getVariableOptionsHtml() {
        const options = [
            { value: 'hp_pct', label: 'HP %' },
            { value: 'hp', label: 'HP Current' },
            { value: 'sp_pct', label: 'SP %' },
            { value: 'sp', label: 'SP Current' }
        ];

        if (this.mipVars.gp1_max > 0) {
            const gp1Name = this.mipVars.gp1_name || 'GP1';
            options.push(
                { value: 'gp1_pct', label: gp1Name + ' %' },
                { value: 'gp1', label: gp1Name + ' Current' }
            );
        }

        if (this.mipVars.gp2_max > 0) {
            const gp2Name = this.mipVars.gp2_name || 'GP2';
            options.push(
                { value: 'gp2_pct', label: gp2Name + ' %' },
                { value: 'gp2', label: gp2Name + ' Current' }
            );
        }

        options.push(
            { value: 'enemy', label: 'Enemy %' },
            { value: 'round', label: 'Combat Round' }
        );

        // Add guild variables dynamically
        const guildVars = [];
        for (const key of Object.keys(this.mipVars)) {
            if (key.startsWith('guild_')) {
                guildVars.push(key);
            }
        }
        guildVars.sort();
        for (const key of guildVars) {
            const labelParts = key.replace('guild_', '').split('_');
            const label = labelParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
            options.push({ value: key, label: label });
        }

        return options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
    }

    // Add a sub-condition row
    addSubCondition(logic) {
        this.pendingSubConditions.push({
            logic: logic,
            variable: 'hp_pct',
            operator: '<',
            value: 50
        });
        this.renderSubConditions();
    }

    // Remove a sub-condition
    removeSubCondition(index) {
        this.pendingSubConditions.splice(index, 1);
        this.renderSubConditions();
    }

    // Render pending sub-conditions in the modal
    renderSubConditions() {
        const container = document.getElementById('mip-sub-conditions');
        if (!container) return;

        if (this.pendingSubConditions.length === 0) {
            container.innerHTML = '';
            return;
        }

        const varOptions = this.getVariableOptionsHtml();
        const opOptions = `
            <option value="<">&lt;</option>
            <option value="<=">&lt;=</option>
            <option value=">">&gt;</option>
            <option value=">=">&gt;=</option>
            <option value="==">==</option>
            <option value="!=">!=</option>
        `;

        container.innerHTML = this.pendingSubConditions.map((sub, idx) => `
            <div class="mip-sub-condition-row" data-index="${idx}">
                <span class="logic-label">${sub.logic}</span>
                <select class="sub-variable" onchange="wmtClient.updateSubCondition(${idx}, 'variable', this.value)">
                    ${varOptions}
                </select>
                <select class="sub-operator" onchange="wmtClient.updateSubCondition(${idx}, 'operator', this.value)">
                    ${opOptions}
                </select>
                <input type="number" class="sub-value" value="${sub.value}" style="width:70px"
                    onchange="wmtClient.updateSubCondition(${idx}, 'value', this.value)">
                <button class="remove-sub" onclick="wmtClient.removeSubCondition(${idx})">X</button>
            </div>
        `).join('');

        // Set selected values
        this.pendingSubConditions.forEach((sub, idx) => {
            const row = container.querySelector(`[data-index="${idx}"]`);
            if (row) {
                row.querySelector('.sub-variable').value = sub.variable;
                row.querySelector('.sub-operator').value = sub.operator;
            }
        });
    }

    // Update a pending sub-condition
    updateSubCondition(index, field, value) {
        if (this.pendingSubConditions[index]) {
            this.pendingSubConditions[index][field] = field === 'value' ? parseFloat(value) : value;
        }
    }

    updateConditionValueDisplay() {
        const varSelect = document.getElementById('mip-cond-variable');
        const variable = varSelect.value;
        const value = this.mipVars[variable];

        const label = varSelect.options[varSelect.selectedIndex].text;
        document.getElementById('mip-cond-var-label').textContent = label + ':';
        document.getElementById('mip-cond-var-value').textContent = value !== undefined ? value : '?';
    }

    renderMipConditions(statType) {
        const list = document.getElementById('mip-conditions-list');

        // Filter conditions relevant to this stat type
        const relevantVars = {
            'hp': ['hp', 'hp_max', 'hp_pct'],
            'sp': ['sp', 'sp_max', 'sp_pct'],
            'gp1': ['gp1', 'gp1_max', 'gp1_pct'],
            'gp2': ['gp2', 'gp2_max', 'gp2_pct'],
            'enemy': ['enemy', 'round']
        };

        const vars = relevantVars[statType] || [];
        const conditions = this.mipConditions.filter(c => vars.includes(c.variable));

        if (conditions.length === 0) {
            list.innerHTML = '<div class="empty-state" style="padding:20px;"><p>No conditions set</p></div>';
            return;
        }

        list.innerHTML = conditions.map(c => {
            // Build expression with sub-conditions
            let expr = `${c.variable} ${c.operator} ${c.value}`;
            let subsHtml = '';
            if (c.subConditions && c.subConditions.length > 0) {
                subsHtml = '<div class="mip-condition-subs">' +
                    c.subConditions.map(s => `${s.logic} ${s.variable} ${s.operator} ${s.value}`).join('<br>') +
                    '</div>';
            }
            return `
                <div class="mip-condition-item ${c.enabled ? '' : 'disabled'}" data-id="${c.id}">
                    <div class="mip-condition-expr">${expr}${subsHtml}</div>
                    <div class="mip-condition-cmd" title="${this.escapeHtml(c.command)}">${this.escapeHtml(c.command)}</div>
                    <div class="mip-condition-actions">
                        <button onclick="wmtClient.editMipCondition('${c.id}')">Edit</button>
                        <button onclick="wmtClient.toggleMipCondition('${c.id}')">${c.enabled ? 'On' : 'Off'}</button>
                        <button class="delete" onclick="wmtClient.deleteMipCondition('${c.id}')">X</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    editMipCondition(id) {
        const cond = this.mipConditions.find(c => c.id === id);
        if (!cond) return;

        this.editingConditionId = id;

        // Populate form with condition values
        document.getElementById('mip-cond-variable').value = cond.variable;
        document.getElementById('mip-cond-operator').value = cond.operator;
        document.getElementById('mip-cond-value').value = cond.value;
        document.getElementById('mip-cond-command').value = cond.command;

        // Load sub-conditions
        this.pendingSubConditions = cond.subConditions ? [...cond.subConditions] : [];
        this.renderSubConditions();

        // Update UI to show edit mode
        document.getElementById('mip-form-title').textContent = 'Edit Condition';
        document.getElementById('mip-save-btn').textContent = 'Update';
        document.getElementById('mip-cancel-btn').textContent = 'Cancel';

        // Update current value display
        this.updateConditionValueDisplay();
    }

    cancelMipConditionEdit() {
        if (this.editingConditionId) {
            // Cancel edit - reset form
            this.editingConditionId = null;
            document.getElementById('mip-cond-command').value = '';
            document.getElementById('mip-cond-value').value = '50';
            this.pendingSubConditions = [];
            this.renderSubConditions();

            // Reset UI
            document.getElementById('mip-form-title').textContent = 'Add Condition';
            document.getElementById('mip-save-btn').textContent = 'Add';
            document.getElementById('mip-cancel-btn').textContent = 'Close';
        } else {
            // Just close the modal
            this.closeMipConditionsModal();
        }
    }

    saveMipCondition() {
        const variable = document.getElementById('mip-cond-variable').value;
        const operator = document.getElementById('mip-cond-operator').value;
        const value = document.getElementById('mip-cond-value').value;
        const command = document.getElementById('mip-cond-command').value.trim();

        if (!command) {
            this.appendOutput('Please enter a command to execute.', 'error');
            return;
        }

        if (this.editingConditionId) {
            // Update existing condition
            const cond = this.mipConditions.find(c => c.id === this.editingConditionId);
            if (cond) {
                cond.variable = variable;
                cond.operator = operator;
                cond.value = parseFloat(value);
                cond.command = command;
                cond.subConditions = this.pendingSubConditions.length > 0 ? [...this.pendingSubConditions] : [];
                this.appendOutput(`Updated condition: ${variable} ${operator} ${value} -> ${command}`, 'system');
            }
            this.editingConditionId = null;
        } else {
            // Add new condition
            const condition = {
                id: Date.now().toString(),
                variable,
                operator,
                value: parseFloat(value),
                command,
                enabled: true,
                lastTriggered: null,
                subConditions: this.pendingSubConditions.length > 0 ? [...this.pendingSubConditions] : []
            };
            this.mipConditions.push(condition);

            // Build condition description for output
            let condDesc = `${variable} ${operator} ${value}`;
            if (condition.subConditions.length > 0) {
                condDesc += ' ' + condition.subConditions.map(s => `${s.logic} ${s.variable} ${s.operator} ${s.value}`).join(' ');
            }
            this.appendOutput(`Added condition: ${condDesc} -> ${command}`, 'system');
        }

        this.saveMipConditions();

        // Clear inputs and reset UI
        document.getElementById('mip-cond-command').value = '';
        document.getElementById('mip-cond-value').value = '50';
        this.pendingSubConditions = [];
        this.renderSubConditions();

        document.getElementById('mip-form-title').textContent = 'Add Condition';
        document.getElementById('mip-save-btn').textContent = 'Add';
        document.getElementById('mip-cancel-btn').textContent = 'Close';

        // Re-render
        if (this.currentConditionStat) {
            this.renderMipConditions(this.currentConditionStat);
        }
    }

    toggleMipCondition(id) {
        const cond = this.mipConditions.find(c => c.id === id);
        if (cond) {
            cond.enabled = !cond.enabled;
            this.saveMipConditions();
            if (this.currentConditionStat) {
                this.renderMipConditions(this.currentConditionStat);
            }
        }
    }

    deleteMipCondition(id) {
        this.mipConditions = this.mipConditions.filter(c => c.id !== id);
        this.saveMipConditions();
        if (this.currentConditionStat) {
            this.renderMipConditions(this.currentConditionStat);
        }
    }

    async saveMipConditions() {
        try {
            await fetch('api/preferences.php?action=save_mip_conditions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conditions: this.mipConditions })
            });
        } catch (e) {
            console.error('Failed to save MIP conditions:', e);
        }
    }

    async loadMipConditions() {
        try {
            const res = await fetch('api/preferences.php?action=get_mip_conditions');
            const data = await res.json();
            if (data.success && data.conditions) {
                this.mipConditions = data.conditions;
            }
        } catch (e) {
            console.error('Failed to load MIP conditions:', e);
        }
    }

    // ==========================================
    // Chat Window Functions
    // ==========================================

    toggleChatWindow() {
        const chatWindow = document.getElementById('chat-window');
        if (!chatWindow) return;

        this.chatWindowOpen = !this.chatWindowOpen;

        if (this.chatWindowOpen) {
            chatWindow.classList.remove('hidden');
            // On mobile, always use docked mode
            const isMobile = window.innerWidth <= 768;
            const mode = isMobile ? 'docked' : this.chatWindowMode;
            this.setChatMode(mode);
            document.getElementById('chat-toggle-btn')?.classList.add('active');
            this.clearChatNotification();
        } else {
            chatWindow.classList.add('hidden');
            const terminalArea = document.querySelector('.terminal-area');
            terminalArea?.classList.remove('chat-docked', 'chat-docked-left', 'chat-docked-right');
            document.getElementById('chat-toggle-btn')?.classList.remove('active');
        }
    }

    setChatMode(mode) {
        const chatWindow = document.getElementById('chat-window');
        const terminalArea = document.querySelector('.terminal-area');
        if (!chatWindow) return;

        // Remove all mode classes
        chatWindow.classList.remove('docked', 'docked-left', 'docked-right', 'floating');
        terminalArea?.classList.remove('chat-docked', 'chat-docked-left', 'chat-docked-right');

        // Update button states
        document.getElementById('chat-dock-btn')?.classList.remove('active');
        document.getElementById('chat-float-btn')?.classList.remove('active');

        this.chatWindowMode = mode;

        if (mode === 'docked') {
            chatWindow.classList.add('docked');
            terminalArea?.classList.add('chat-docked');
            document.getElementById('chat-dock-btn')?.classList.add('active');
            this.updateDockButtonTitle('top');
            // Reset position for docked mode
            chatWindow.style.top = '';
            chatWindow.style.left = '';
            chatWindow.style.width = '';
        } else if (mode === 'docked-left') {
            chatWindow.classList.add('docked-left');
            terminalArea?.classList.add('chat-docked-left');
            document.getElementById('chat-dock-btn')?.classList.add('active');
            this.updateDockButtonTitle('left');
            // Reset position for docked mode
            chatWindow.style.top = '';
            chatWindow.style.left = '';
            chatWindow.style.height = '';
        } else if (mode === 'docked-right') {
            chatWindow.classList.add('docked-right');
            terminalArea?.classList.add('chat-docked-right');
            document.getElementById('chat-dock-btn')?.classList.add('active');
            this.updateDockButtonTitle('right');
            // Reset position for docked mode
            chatWindow.style.top = '';
            chatWindow.style.left = '';
            chatWindow.style.height = '';
        } else if (mode === 'floating') {
            chatWindow.classList.add('floating');
            document.getElementById('chat-float-btn')?.classList.add('active');
            this.updateDockButtonTitle('none');
        }
    }

    // Cycle through dock positions: floating -> top -> left -> right -> floating
    cycleDockPosition() {
        // Only cycle docked positions on desktop
        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
            // On mobile, just toggle docked
            this.setChatMode(this.chatWindowMode === 'docked' ? 'floating' : 'docked');
            return;
        }

        const positions = ['floating', 'docked', 'docked-left', 'docked-right'];
        const currentIndex = positions.indexOf(this.chatWindowMode);
        const nextIndex = (currentIndex + 1) % positions.length;
        this.setChatMode(positions[nextIndex]);
    }

    // Update dock button tooltip based on current position
    updateDockButtonTitle(position) {
        const dockBtn = document.getElementById('chat-dock-btn');
        if (!dockBtn) return;

        const titles = {
            'none': 'Dock to top',
            'top': 'Dock to left',
            'left': 'Dock to right',
            'right': 'Float window'
        };
        dockBtn.title = titles[position] || 'Dock window';
    }

    appendChatMessage(message, chatType = 'channel', channel = '', rawText = '') {
        // Get channel preferences
        const channelKey = channel.toLowerCase();
        const prefs = this.channelPrefs[channelKey] || {};

        // Check if channel is hidden
        if (prefs.hidden) {
            return; // Don't display hidden channels
        }

        // Play sound if enabled for this channel
        if (prefs.sound) {
            this.playBell();
        }

        // Discord is handled server-side (works even when browser is closed)

        // Track this channel for the settings UI
        if (channel && !this.channelPrefs[channelKey]) {
            this.channelPrefs[channelKey] = { sound: false, hidden: false, discord: false, webhookUrl: '' };
        }

        // Append to chat window
        const chatOutput = document.getElementById('chat-output');
        if (chatOutput) {
            const line = document.createElement('div');
            line.className = `chat-line ${chatType}`;
            line.dataset.channel = channelKey;
            line.innerHTML = message;
            chatOutput.appendChild(line);

            // Auto-scroll to bottom
            chatOutput.scrollTop = chatOutput.scrollHeight;
        }

        // Also send to pop-out window if open
        if (this.chatPopoutWindow && !this.chatPopoutWindow.closed) {
            const popoutOutput = this.chatPopoutWindow.document.getElementById('chat-output');
            if (popoutOutput) {
                const line = this.chatPopoutWindow.document.createElement('div');
                line.className = `chat-line ${chatType}`;
                line.dataset.channel = channelKey;
                line.innerHTML = message;
                popoutOutput.appendChild(line);
                popoutOutput.scrollTop = popoutOutput.scrollHeight;
            }
        }

        // Show notification if chat window is closed or not focused
        const chatWindow = document.getElementById('chat-window');
        const chatInput = document.getElementById('chat-input');
        const isChatFocused = chatWindow && (
            document.activeElement === chatInput ||
            chatWindow.contains(document.activeElement)
        );

        if (!this.chatWindowOpen || !isChatFocused) {
            // Add indicator to chat button (stays until chat is focused)
            const chatBtn = document.getElementById('chat-toggle-btn');
            if (chatBtn) {
                chatBtn.classList.add('has-new');
            }
            // Also highlight the chat window header if it's open but not focused
            if (this.chatWindowOpen && chatWindow) {
                chatWindow.classList.add('has-new');
            }
        }
    }


    // Save channel preferences (each channel can have its own webhook URL)
    async saveChannelPrefs() {
        try {
            this.preferences.channelPrefs = this.channelPrefs;
            await fetch('api/preferences.php?action=save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    preferences: {
                        channelPrefs: this.channelPrefs
                    }
                })
            });
            // Also send to server for server-side notifications (works when browser closed)
            this.sendDiscordPrefsToServer();
        } catch (e) {
            console.error('Failed to save channel preferences:', e);
        }
    }

    // Open channel settings modal
    openChannelSettingsModal() {
        const modal = document.getElementById('channel-settings-modal');
        if (!modal) return;

        // Render the channel list
        const channelList = document.getElementById('channel-list');
        if (channelList) {
            const channels = Object.keys(this.channelPrefs);
            if (channels.length === 0) {
                channelList.innerHTML = '<p class="no-channels">No channels detected yet. Chat messages will appear here as they arrive.</p>';
            } else {
                channelList.innerHTML = channels.sort().map(channel => {
                    const prefs = this.channelPrefs[channel] || {};
                    const webhookUrl = prefs.webhookUrl || '';
                    return `
                        <div class="channel-row" data-channel="${channel}">
                            <div class="channel-row-main">
                                <span class="channel-name">${channel}</span>
                                <label class="channel-option" title="Play sound on message">
                                    <input type="checkbox" class="channel-sound" ${prefs.sound ? 'checked' : ''}>
                                    <span class="channel-icon">🔔</span>
                                </label>
                                <label class="channel-option" title="Hide this channel">
                                    <input type="checkbox" class="channel-hidden" ${prefs.hidden ? 'checked' : ''}>
                                    <span class="channel-icon">👁️</span>
                                </label>
                                <label class="channel-option" title="Send to Discord">
                                    <input type="checkbox" class="channel-discord" ${prefs.discord ? 'checked' : ''}>
                                    <span class="channel-icon">📤</span>
                                </label>
                            </div>
                            <div class="channel-webhook-row" style="display: ${prefs.discord ? 'flex' : 'none'};">
                                <input type="text" class="channel-webhook"
                                    placeholder="Discord webhook URL for ${channel}..."
                                    value="${webhookUrl}">
                            </div>
                        </div>
                    `;
                }).join('');

                // Add event listeners to toggle webhook input visibility
                channelList.querySelectorAll('.channel-discord').forEach(checkbox => {
                    checkbox.addEventListener('change', (e) => {
                        const row = e.target.closest('.channel-row');
                        const webhookRow = row.querySelector('.channel-webhook-row');
                        if (webhookRow) {
                            webhookRow.style.display = e.target.checked ? 'flex' : 'none';
                        }
                    });
                });
            }
        }

        modal.classList.add('open');
    }

    // Close channel settings modal
    closeChannelSettingsModal() {
        const modal = document.getElementById('channel-settings-modal');
        if (modal) {
            modal.classList.remove('open');
        }
    }

    // Save channel settings from modal
    saveChannelSettings() {
        const channelRows = document.querySelectorAll('#channel-list .channel-row');
        channelRows.forEach(row => {
            const channel = row.dataset.channel;
            const sound = row.querySelector('.channel-sound')?.checked || false;
            const hidden = row.querySelector('.channel-hidden')?.checked || false;
            const discord = row.querySelector('.channel-discord')?.checked || false;
            const webhookUrl = row.querySelector('.channel-webhook')?.value?.trim() || '';
            this.channelPrefs[channel] = { sound, hidden, discord, webhookUrl };
        });
        this.saveChannelPrefs();
        this.closeChannelSettingsModal();
        this.appendOutput('Channel settings saved.', 'system');
    }

    // Clear chat notification when chat is focused
    clearChatNotification() {
        document.getElementById('chat-toggle-btn')?.classList.remove('has-new');
        document.getElementById('chat-window')?.classList.remove('has-new');
    }

    sendChatCommand() {
        const chatInput = document.getElementById('chat-input');
        if (!chatInput) return;

        const command = chatInput.value.trim();
        if (!command) return;

        // Send to MUD
        this.connection.sendCommand(command);

        // Clear input
        chatInput.value = '';
    }

    popOutChatWindow() {
        // Close existing pop-out if any
        if (this.chatPopoutWindow && !this.chatPopoutWindow.closed) {
            this.chatPopoutWindow.close();
        }

        // Get current chat content
        const chatOutput = document.getElementById('chat-output');
        const chatContent = chatOutput ? chatOutput.innerHTML : '';

        // Create pop-out window
        const width = 500;
        const height = 400;
        const left = (screen.width - width) / 2;
        const top = (screen.height - height) / 2;

        this.chatPopoutWindow = window.open('', 'WMT_Chat',
            `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`);

        if (!this.chatPopoutWindow) {
            this.appendOutput('Failed to open pop-out window. Please allow pop-ups.', 'error');
            return;
        }

        // Write content to pop-out window
        const doc = this.chatPopoutWindow.document;
        doc.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WMT Chat</title>
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body {
                        font-family: Consolas, Monaco, monospace;
                        background: #1a1a2e;
                        color: #e0e0e0;
                        height: 100vh;
                        display: flex;
                        flex-direction: column;
                    }
                    #chat-output {
                        flex: 1;
                        overflow-y: auto;
                        padding: 10px;
                        font-size: 14px;
                        line-height: 1.4;
                    }
                    .chat-line { margin-bottom: 4px; padding: 2px 4px; border-radius: 2px; }
                    .chat-line.tell { background: rgba(255, 100, 100, 0.1); border-left: 2px solid #ff6464; padding-left: 8px; }
                    .chat-line.channel { background: rgba(100, 200, 255, 0.1); border-left: 2px solid #64c8ff; padding-left: 8px; }
                    .input-container {
                        display: flex;
                        gap: 8px;
                        padding: 10px;
                        background: #2a2a3e;
                        border-top: 1px solid #3a3a4e;
                    }
                    #chat-input {
                        flex: 1;
                        padding: 8px 12px;
                        background: #1a1a2e;
                        border: 1px solid #3a3a4e;
                        border-radius: 4px;
                        color: #e0e0e0;
                        font-family: inherit;
                        font-size: 14px;
                    }
                    #chat-input:focus { outline: none; border-color: #00ff00; }
                    #send-btn {
                        padding: 8px 16px;
                        background: #00ff00;
                        color: #000;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-weight: bold;
                    }
                    #send-btn:hover { background: #00cc00; }
                </style>
            </head>
            <body>
                <div id="chat-output">${chatContent}</div>
                <div class="input-container">
                    <input type="text" id="chat-input" placeholder="Type chat command...">
                    <button id="send-btn">Send</button>
                </div>
                <script>
                    const input = document.getElementById('chat-input');
                    const sendBtn = document.getElementById('send-btn');

                    function sendCommand() {
                        const cmd = input.value.trim();
                        if (cmd && window.opener && window.opener.wmtClient) {
                            window.opener.wmtClient.connection.sendCommand(cmd);
                            input.value = '';
                        }
                    }

                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') sendCommand();
                    });
                    sendBtn.addEventListener('click', sendCommand);
                    input.focus();
                </script>
            </body>
            </html>
        `);
        doc.close();

        // Hide main chat window
        this.chatWindowOpen = false;
        document.getElementById('chat-window')?.classList.add('hidden');
        document.querySelector('.terminal-area')?.classList.remove('chat-docked', 'chat-docked-left', 'chat-docked-right');
        document.getElementById('chat-toggle-btn')?.classList.remove('active');
    }

    initChatDragging() {
        const chatWindow = document.getElementById('chat-window');
        const chatHeader = chatWindow?.querySelector('.chat-header');
        if (!chatWindow || !chatHeader) return;

        chatHeader.addEventListener('mousedown', (e) => {
            if (this.chatWindowMode !== 'floating') return;
            if (e.target.closest('.chat-controls')) return;

            this.chatIsDragging = true;
            const rect = chatWindow.getBoundingClientRect();
            this.chatDragOffset = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            chatWindow.style.transition = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!this.chatIsDragging) return;

            const x = e.clientX - this.chatDragOffset.x;
            const y = e.clientY - this.chatDragOffset.y;

            chatWindow.style.left = `${Math.max(0, x)}px`;
            chatWindow.style.top = `${Math.max(0, y)}px`;
        });

        document.addEventListener('mouseup', () => {
            this.chatIsDragging = false;
            if (chatWindow) {
                chatWindow.style.transition = '';
            }
        });
    }

    // Helper to update a single stat block (with conditional display)
    updateStatBlock(statId, current, max, label, show) {
        const block = document.getElementById(`${statId}-block`);
        const fill = document.getElementById(`${statId}-fill`);
        const value = document.getElementById(`${statId}-value`);
        const labelEl = document.getElementById(`${statId}-label`);

        // Show/hide block based on whether it has data
        if (block) {
            if (show) {
                block.classList.remove('hidden');
            } else {
                block.classList.add('hidden');
                return; // Don't update hidden blocks
            }
        }

        if (fill && max > 0) {
            const percent = Math.min(100, Math.max(0, (current / max) * 100));
            fill.style.width = `${percent}%`;

            // Add color classes for HP based on percentage
            if (statId === 'hp') {
                fill.classList.remove('low', 'medium');
                if (percent <= 25) {
                    fill.classList.add('low');
                } else if (percent <= 50) {
                    fill.classList.add('medium');
                }
            }
        }

        if (value) {
            value.textContent = `${current}/${max}`;
        }

        if (labelEl && label) {
            // Set tooltip instead of replacing icon with text
            labelEl.title = label;
        }
    }

    onError(error) {
        console.error('=== CONNECTION ERROR ===', error);
        // Don't show alarming error messages if we're going to auto-reconnect
        // The session resume message will confirm everything is fine
        if (this.connection && this.connection.intentionalDisconnect) {
            this.appendOutput('Error: ' + error, 'error');
        }
        // Otherwise stay quiet - reconnect will either succeed (session resumed) or fail (then show error)
    }

    updateConnectionStatus(status) {
        const indicator = document.querySelector('.status-indicator');
        const text = document.querySelector('.status-text');

        if (indicator) {
            indicator.className = 'status-indicator ' + status;
        }

        if (text) {
            const mudHost = window.WMT_CONFIG?.mudHost || '3k.org';
            const statusMap = {
                'connected': `Connected to ${mudHost}`,
                'connecting': 'Connecting...',
                'authenticating': 'Authenticating...',
                'disconnected': 'Disconnected',
                'mud_disconnected': `Disconnected from ${mudHost}`
            };
            text.textContent = statusMap[status] || status;
        }
    }

    appendOutput(text, type = 'mud', options = {}) {
        const output = document.getElementById('mud-output');
        if (!output) return;

        const line = document.createElement('div');
        line.className = 'line ' + type;

        // Convert ANSI codes to HTML
        let html = this.ansiToHtml(text);

        // Convert <hl style="...">text</hl> tags to styled spans (from server-side highlights)
        html = html.replace(/&lt;hl style="([^"]*)"&gt;(.*?)&lt;\/hl&gt;/gi, '<span style="$1">$2</span>');

        line.innerHTML = html;

        output.appendChild(line);

        // Scrollback limit - remove old lines to prevent memory issues
        // Use efficient batch removal to minimize layout thrashing (which can reset mobile zoom)
        const maxLines = this.preferences.scrollbackLimit || 5000;
        const trimAmount = 500; // Remove in batches for efficiency
        if (output.children.length > maxLines + trimAmount) {
            // Use Range API for efficient batch removal (single reflow)
            const range = document.createRange();
            range.setStartBefore(output.firstChild);
            range.setEndAfter(output.children[trimAmount - 1]);
            range.deleteContents();
        }

        // Smart auto-scroll: scroll to bottom if enabled AND user hasn't scrolled up
        // Use requestAnimationFrame to batch scroll updates (prevents mobile zoom reset)
        if (this.preferences.scrollOnOutput !== false && !this.userScrolledUp) {
            if (!this.pendingScroll) {
                this.pendingScroll = true;
                requestAnimationFrame(() => {
                    this.pendingScroll = false;
                    const out = document.getElementById('mud-output');
                    if (out) {
                        out.scrollTop = out.scrollHeight;
                        // Update lastScrollTop so scroll detection doesn't think user scrolled
                        this.lastScrollTop = out.scrollTop;
                    }
                });
            }
        }

        // Play sound if specified
        if (options.sound) {
            this.playSound(options.sound);
        }
    }

    ansiToHtml(text) {
        // Escape HTML first
        text = text.replace(/&/g, '&amp;')
                   .replace(/</g, '&lt;')
                   .replace(/>/g, '&gt;');

        const ansiSpans = {
            '1': '<span style="font-weight:bold">',
            '4': '<span style="text-decoration:underline">',
            '30': '<span style="color:#555555">',  // dark gray (visible on black)
            '31': '<span style="color:#cc4444">',  // dim red
            '32': '<span style="color:#44cc44">',  // dim green
            '33': '<span style="color:#cccc44">',  // dim yellow
            '34': '<span style="color:#4444cc">',  // dim blue
            '35': '<span style="color:#cc44cc">',  // dim magenta
            '36': '<span style="color:#44cccc">',  // dim cyan
            '37': '<span style="color:#cccccc">',  // dim white/gray
            '90': '<span style="color:#888888">',  // bright black (gray)
            '91': '<span style="color:#ff5555">',  // bright red
            '92': '<span style="color:#55ff55">',  // bright green
            '93': '<span style="color:#ffff55">',  // bright yellow
            '94': '<span style="color:#5555ff">',  // bright blue
            '95': '<span style="color:#ff55ff">',  // bright magenta
            '96': '<span style="color:#55ffff">',  // bright cyan
            '97': '<span style="color:#ffffff">'   // bright white
        };

        // Track open spans so we can close them all on reset
        let openSpans = 0;

        return text.replace(/\x1b\[([0-9;]+)m/g, (match, codes) => {
            const codeList = codes.split(';');
            let result = '';

            for (const code of codeList) {
                if (code === '0' || code === '') {
                    // Reset: close ALL open spans
                    result += '</span>'.repeat(openSpans);
                    openSpans = 0;
                } else if (ansiSpans[code]) {
                    result += ansiSpans[code];
                    openSpans++;
                }
            }

            return result;
        });
    }

    playSound(sound) {
        // Use the same notification sound settings as playBell
        this.playBell();
    }

    // Pinch-to-zoom font size on mobile
    setupPinchZoom(element) {
        let initialDistance = null;
        let initialFontSize = null;

        const getDistance = (touches) => {
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        };

        element.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                initialDistance = getDistance(e.touches);
                initialFontSize = this.preferences.fontSize || 14;
                e.preventDefault(); // Prevent browser zoom
            }
        }, { passive: false });

        element.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2 && initialDistance !== null) {
                e.preventDefault(); // Prevent browser zoom

                const currentDistance = getDistance(e.touches);
                const scale = currentDistance / initialDistance;

                // Calculate new font size with some dampening
                let newSize = Math.round(initialFontSize * scale);

                // Clamp to valid range (matches settings slider)
                newSize = Math.max(6, Math.min(24, newSize));

                // Only update if changed
                if (newSize !== this.preferences.fontSize) {
                    this.preferences.fontSize = newSize;

                    // Apply to output and MIP bar
                    const output = document.getElementById('mud-output');
                    const mipBar = document.querySelector('.mip-status-bar');
                    if (output) output.style.setProperty('--mud-font-size', newSize + 'px');
                    if (mipBar) mipBar.style.setProperty('--mud-font-size', newSize + 'px');

                    // Show indicator
                    this.showFontSizeIndicator(newSize);
                }
            }
        }, { passive: false });

        element.addEventListener('touchend', (e) => {
            if (initialDistance !== null && e.touches.length < 2) {
                // Gesture ended - save the preference immediately without reading from DOM
                this.saveCurrentPreferences();
                initialDistance = null;
                initialFontSize = null;
            }
        });
    }

    // Show brief font size indicator during pinch zoom
    showFontSizeIndicator(size) {
        let indicator = document.getElementById('font-size-indicator');

        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'font-size-indicator';
            indicator.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(0, 0, 0, 0.8);
                color: #00ff00;
                padding: 15px 25px;
                border-radius: 8px;
                font-size: 24px;
                font-weight: bold;
                z-index: 10000;
                pointer-events: none;
                transition: opacity 0.3s;
            `;
            document.body.appendChild(indicator);
        }

        indicator.textContent = size + 'px';
        indicator.style.opacity = '1';

        // Clear existing timeout
        if (this.fontSizeIndicatorTimeout) {
            clearTimeout(this.fontSizeIndicatorTimeout);
        }

        // Hide after delay
        this.fontSizeIndicatorTimeout = setTimeout(() => {
            indicator.style.opacity = '0';
        }, 800);
    }

    bindEvents() {
        // Command input
        const input = document.getElementById('command-input');
        const sendBtn = document.getElementById('send-btn');
        const output = document.getElementById('mud-output');

        if (input) {
            input.addEventListener('keydown', (e) => this.handleInputKeydown(e));
            // Reset history search when user types/modifies input
            // This ensures up arrow starts fresh after any text change
            input.addEventListener('input', () => this.resetHistorySearch());
        }

        if (sendBtn) {
            sendBtn.addEventListener('click', () => this.sendCommand());
        }

        // Smart auto-scroll: detect when user scrolls up manually
        if (output) {
            output.addEventListener('scroll', () => {
                // Ignore scroll events briefly after sending command (mobile keyboard causes false triggers)
                if (this.ignoreScrollEvents) return;

                const currentScrollTop = output.scrollTop;
                const atBottom = output.scrollHeight - currentScrollTop - output.clientHeight < 50;

                // Only set userScrolledUp=true if user actually scrolled UP (scrollTop decreased)
                // This prevents false triggers when new content increases scrollHeight
                if (currentScrollTop < this.lastScrollTop - 10) {
                    // User scrolled up - stop auto-scroll
                    this.userScrolledUp = true;
                } else if (atBottom) {
                    // User scrolled to bottom - resume auto-scroll
                    this.userScrolledUp = false;
                }
                // If scrollTop increased or stayed same, don't change the flag
                // (content was added, or user scrolled down)

                this.lastScrollTop = currentScrollTop;
            });

            // Click anywhere on output to focus command input
            output.addEventListener('click', (e) => {
                // Don't focus if user is selecting text
                const selection = window.getSelection();
                if (selection && selection.toString().length > 0) return;

                // Focus the command input
                document.getElementById('command-input')?.focus();
            });

            // Pinch-to-zoom for font size on mobile
            this.setupPinchZoom(output);
        }

        // Also allow clicking on the output container (outside the output itself)
        const outputContainer = document.querySelector('.output-container');
        if (outputContainer) {
            outputContainer.addEventListener('click', (e) => {
                // Only if clicking on the container itself, not its children that have their own handlers
                if (e.target === outputContainer || e.target.classList.contains('split-area')) {
                    document.getElementById('command-input')?.focus();
                }
            });
        }

        // MIP stat bar click handlers - open conditions modal
        document.querySelector('.mip-stat-block.hp')?.addEventListener('click', () => this.openMipConditionsModal('hp'));
        document.querySelector('.mip-stat-block.sp')?.addEventListener('click', () => this.openMipConditionsModal('sp'));
        document.querySelector('.mip-stat-block.gp1')?.addEventListener('click', () => this.openMipConditionsModal('gp1'));
        document.querySelector('.mip-stat-block.gp2')?.addEventListener('click', () => this.openMipConditionsModal('gp2'));
        document.querySelector('.mip-stat-block.enemy')?.addEventListener('click', () => this.openMipConditionsModal('enemy'));

        // MIP condition variable dropdown change handler
        document.getElementById('mip-cond-variable')?.addEventListener('change', () => this.updateConditionValueDisplay());

        // Header buttons
        document.getElementById('scripts-btn')?.addEventListener('click', () => this.toggleScriptsSidebar());

        // Chat window buttons
        document.getElementById('chat-toggle-btn')?.addEventListener('click', () => this.toggleChatWindow());
        document.getElementById('chat-settings-btn')?.addEventListener('click', () => this.openChannelSettingsModal());
        document.getElementById('chat-dock-btn')?.addEventListener('click', () => this.cycleDockPosition());
        document.getElementById('chat-float-btn')?.addEventListener('click', () => this.setChatMode('floating'));
        document.getElementById('chat-popout-btn')?.addEventListener('click', () => this.popOutChatWindow());
        document.getElementById('chat-close-btn')?.addEventListener('click', () => this.toggleChatWindow());

        // Clear notification when clicking on chat window
        document.getElementById('chat-window')?.addEventListener('click', () => {
            this.clearChatNotification();
        });

        // Initialize chat window dragging
        this.initChatDragging();

        // New dropdown menu
        const newBtn = document.getElementById('new-btn');
        const newMenu = document.getElementById('new-menu');
        if (newBtn && newMenu) {
            newBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                newMenu.classList.toggle('open');
            });
            // Close dropdown when clicking elsewhere
            document.addEventListener('click', () => {
                newMenu.classList.remove('open');
            });
            // Close dropdown when clicking menu items
            newMenu.querySelectorAll('button').forEach(btn => {
                btn.addEventListener('click', () => {
                    newMenu.classList.remove('open');
                });
            });
        }

        // Hamburger menu for small screens
        const hamburgerBtn = document.getElementById('hamburger-btn');
        const hamburgerMenu = document.getElementById('hamburger-menu');
        if (hamburgerBtn && hamburgerMenu) {
            hamburgerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                hamburgerMenu.classList.toggle('open');
                // Close character menu if open
                document.getElementById('character-menu')?.classList.remove('open');
            });
            // Close menu when clicking elsewhere
            document.addEventListener('click', () => {
                hamburgerMenu.classList.remove('open');
            });
            // Close menu when clicking menu items
            hamburgerMenu.querySelectorAll('button').forEach(btn => {
                btn.addEventListener('click', () => {
                    hamburgerMenu.classList.remove('open');
                });
            });
        }

        // Character dropdown menu
        const characterBtn = document.getElementById('character-btn');
        const characterMenu = document.getElementById('character-menu');
        if (characterBtn && characterMenu) {
            characterBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                characterMenu.classList.toggle('open');
                // Close hamburger menu if open
                hamburgerMenu?.classList.remove('open');
            });
            // Close menu when clicking elsewhere
            document.addEventListener('click', () => {
                characterMenu.classList.remove('open');
            });
        }

        document.getElementById('settings-btn')?.addEventListener('click', () => this.openPanel('settings'));
        document.getElementById('reconnect-btn')?.addEventListener('click', () => this.reconnect());
        document.getElementById('disconnect-btn')?.addEventListener('click', () => this.disconnect());
        document.getElementById('logout-btn')?.addEventListener('click', () => this.logout());

        // Handle app returning from background (mobile app switching)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                // PWA on iOS needs a moment to stabilize after unfreeze
                const isPWA = window.navigator.standalone === true;
                const delay = isPWA ? 500 : 50;

                setTimeout(() => {
                    // App came back to foreground - check if WebSocket is still alive
                    if (this.connection && this.connection.socket) {
                        const state = this.connection.socket.readyState;
                        if (state === WebSocket.CLOSED || state === WebSocket.CLOSING) {
                            // Obviously dead - reconnect immediately
                            if (!this.connection.socket || this.connection.socket.readyState !== WebSocket.CONNECTING) {
                                console.log('WebSocket dead after app resume, reconnecting...');
                                this.connection.reconnectAttempts = 0;
                                this.connection.connect();
                            }
                        } else if (state === WebSocket.OPEN) {
                            // Connection looks alive - use health check to verify
                            // This will auto-reconnect if no response within 5 seconds
                            this.verifyConnectionHealth();
                        }
                    }
                }, delay);
            }
        });

        // MIP is now controlled via Settings panel, auto-enabled on connect

        // Scripts sidebar
        document.getElementById('scripts-sidebar-close')?.addEventListener('click', () => this.closeScriptsSidebar());
        document.getElementById('close-scripts-btn')?.addEventListener('click', () => this.closeScriptsSidebar());
        document.getElementById('add-class-btn')?.addEventListener('click', () => this.promptAddClass());
        document.getElementById('upload-script-btn')?.addEventListener('click', () => {
            document.getElementById('script-file-input')?.click();
        });
        document.getElementById('script-file-input')?.addEventListener('change', (e) => this.handleScriptUpload(e));
        this.initSidebarResize();

        // Panel close buttons
        document.querySelectorAll('.panel-close').forEach(btn => {
            btn.addEventListener('click', () => this.closePanel());
        });

        // Modal close
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    this.closeModal();
                }
            });
        });

        // Window focus - prevent multiple connections
        window.addEventListener('focus', () => {
            if (!this.connection.isConnected()) {
                this.connection.connect();
            }
        });
    }

    handleInputKeydown(e) {
        const input = e.target;

        switch (e.key) {
            case 'Enter':
                e.preventDefault();
                this.sendCommand();
                break;

            case 'ArrowUp':
                e.preventDefault();
                this.navigateHistory(1);  // Go to older commands (higher index)
                break;

            case 'ArrowDown':
                e.preventDefault();
                this.navigateHistory(-1);  // Go to newer commands (lower index)
                break;

            case 'Tab':
                e.preventDefault();
                // TODO: Tab completion
                break;
        }
    }

    sendCommand() {
        const input = document.getElementById('command-input');
        if (!input) return;

        const command = input.value;

        // Track last user input for idle disconnect (deadman switch)
        this.lastUserInput = Date.now();

        // Add to history (only non-empty commands)
        if (command.trim()) {
            this.commandHistory.unshift(command);
            if (this.commandHistory.length > this.maxHistorySize) {
                this.commandHistory.pop();
            }
        }
        this.resetHistorySearch();

        // Echo command if enabled (show empty as just ">")
        if (this.preferences.echoCommands !== false) {
            this.appendOutput('> ' + command, 'command');
        }

        // Check for client-side # commands
        if (command.startsWith('#')) {
            this.executeCommandString(command);
        } else {
            // Substitute variables before sending (allows alias names with $vars like celstep$num)
            let expandedCommand = this.substituteVariables(command);

            // Check for speedwalk expansion (e.g., "3n2e" -> "n;n;n;e;e")
            const speedwalkExpanded = this.expandSpeedwalk(expandedCommand);
            if (speedwalkExpanded) {
                expandedCommand = speedwalkExpanded;
            }

            // Send to server (empty commands are allowed - e.g., "press enter to continue")
            this.connection.sendCommand(expandedCommand);
        }

        // Scroll to bottom and resume auto-scroll when sending a command
        this.userScrolledUp = false;
        this.ignoreScrollEvents = true;  // Ignore scroll events from keyboard hide
        const output = document.getElementById('mud-output');
        if (output) {
            output.scrollTop = output.scrollHeight;
            this.lastScrollTop = output.scrollTop;
        }
        // Re-enable scroll detection after keyboard animation completes
        setTimeout(() => {
            this.ignoreScrollEvents = false;
            // Scroll to bottom again in case content came in during the delay
            if (output && !this.userScrolledUp) {
                output.scrollTop = output.scrollHeight;
                this.lastScrollTop = output.scrollTop;
            }
        }, 500);

        // Clear input unless retainLastCommand is enabled
        if (!this.preferences.retainLastCommand) {
            input.value = '';
        } else {
            // Select all text so next typing replaces it
            input.select();
        }
    }

    navigateHistory(direction) {
        const input = document.getElementById('command-input');
        if (!input || this.commandHistory.length === 0) return;

        // If starting a new search (index is -1 and going up)
        if (this.historyIndex === -1 && direction === 1) {
            const currentInput = input.value;
            this.historySearchPrefix = currentInput;

            // Build filtered matches list
            if (currentInput) {
                // Filter history to commands starting with the prefix
                this.historySearchMatches = this.commandHistory.filter(cmd =>
                    cmd.toLowerCase().startsWith(currentInput.toLowerCase())
                );
            } else {
                // No prefix - use full history
                this.historySearchMatches = [...this.commandHistory];
            }
            this.historySearchIndex = -1;
        }

        // Navigate within filtered matches
        const newIndex = this.historySearchIndex + direction;

        if (newIndex < -1) return;
        if (newIndex >= this.historySearchMatches.length) return;

        this.historySearchIndex = newIndex;
        this.historyIndex = newIndex;  // Keep in sync for reset

        if (this.historySearchIndex === -1) {
            // Back to original input
            input.value = this.historySearchPrefix;
        } else {
            input.value = this.historySearchMatches[this.historySearchIndex];
        }

        // Move cursor to end
        input.setSelectionRange(input.value.length, input.value.length);
    }

    // Reset history search state (called when input changes or command is sent)
    resetHistorySearch() {
        this.historyIndex = -1;
        this.historySearchIndex = -1;
        this.historySearchPrefix = '';
        this.historySearchMatches = [];
    }

    reconnect() {
        this.appendOutput('Attempting to reconnect...', 'system');
        // Reset flags so credentials will be sent again
        this.passwordSent = false;
        this.mipStarted = false;
        this.mipEnabled = false;
        this.mipReady = false;
        this.pendingReconnect = true;  // Flag to trigger credential send on reconnect

        // Check WebSocket state - if not open, we need a full reconnect
        const socket = this.connection?.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            this.appendOutput('WebSocket not connected, performing full reconnect...', 'system');
            // Full WebSocket reconnect (disconnect + connect)
            this.connection.reconnect();
        } else {
            // WebSocket is open, just request MUD reconnection
            this.connection.requestReconnect();
        }
    }

    disconnect() {
        this.appendOutput('Disconnecting from MUD...', 'system');
        this.connection.disconnect();
        this.mipEnabled = false;
        this.mipStarted = false;
        this.updateMipBarVisibility();
    }

    // MIP (MUD Interface Protocol) functions
    toggleMip(enabled) {
        if (enabled) {
            this.enableMip();
        } else {
            this.disableMip();
        }
    }

    enableMip() {
        // Generate random 5-digit ID (like TinTin++ 1d10-1 loop)
        this.mipId = '';
        for (let i = 0; i < 5; i++) {
            this.mipId += Math.floor(Math.random() * 10);
        }

        this.mipEnabled = true;

        // Update UI - show status bar if HP bar preference is enabled
        this.updateMipBarVisibility();

        // Tell server to gag MIP lines and parse stats
        this.connection.setMip(true, this.mipId, this.mipDebug);

        // Send MIP registration commands after short delay
        setTimeout(() => {
            this.connection.sendCommand(`3klient ${this.mipId}~~PortalWMT${this.mipVersion}`);
            this.connection.sendCommand('3klient LINEFEED on');
            this.connection.sendCommand('3klient HAA off');
        }, 500);

        this.appendOutput(`MIP enabled (ID: ${this.mipId}, Client: PortalWMT${this.mipVersion})`, 'system');
    }

    disableMip() {
        if (this.mipEnabled) {
            // Send MIP disable command
            this.connection.sendCommand('3klient off');
        }

        // Tell server to stop gagging MIP lines
        this.connection.setMip(false, null);

        this.mipEnabled = false;
        this.mipId = null;
        this.mipReady = false;  // Reset so conditions don't fire on stale data

        // Hide status bar
        document.getElementById('mip-status-bar')?.classList.add('hidden');

        this.appendOutput('MIP disabled', 'system');
    }

    // #mip command - reload/control MIP
    cmdMip(args) {
        const action = (args[0] || 'reload').toLowerCase();

        switch (action) {
            case 'on':
            case 'enable':
                this.enableMip();
                break;
            case 'off':
            case 'disable':
                this.disableMip();
                break;
            case 'reload':
            case 'restart':
            default:
                // Just re-enable - new registration replaces old one
                this.mipEnabled = false;
                this.mipId = null;
                this.enableMip();
                break;
        }
    }

    // Update MIP status bar visibility based on preference
    updateMipBarVisibility() {
        const mipBar = document.getElementById('mip-status-bar');
        if (!mipBar) return;

        // Show bar only if MIP is enabled AND HP bar preference is enabled
        if (this.mipEnabled && this.preferences.mipHpBar !== false) {
            mipBar.classList.remove('hidden');
        } else {
            mipBar.classList.add('hidden');
        }

        // Also update individual element visibility
        this.updateMipElementVisibility();
    }

    // Update visibility of individual MIP elements based on preferences
    updateMipElementVisibility() {
        // Stat bars row (HP/SP/GP bars)
        const statBarsRow = document.querySelector('.mip-row-primary');
        if (statBarsRow) {
            statBarsRow.style.display = this.preferences.mipShowStatBars !== false ? '' : 'none';
        }

        // Guild data lines
        const guildLines = document.querySelectorAll('.mip-guild-line');
        guildLines.forEach(el => {
            el.style.display = this.preferences.mipShowGuild !== false ? '' : 'none';
        });

        // Room name
        const roomEl = document.getElementById('mip-room');
        if (roomEl) {
            roomEl.style.display = this.preferences.mipShowRoom !== false ? '' : 'none';
        }

        // Exits
        const exitsEl = document.getElementById('mip-exits');
        if (exitsEl) {
            exitsEl.style.display = this.preferences.mipShowExits !== false ? '' : 'none';
        }
    }

    // Update UI elements that depend on MIP being enabled
    updateMipDependentUI(mipEnabled) {
        // Hide/show MIP status bar
        const mipBar = document.getElementById('mip-status-bar');
        if (mipBar) {
            if (mipEnabled && this.preferences.mipHpBar !== false) {
                mipBar.classList.remove('hidden');
            } else {
                mipBar.classList.add('hidden');
            }
        }

        // Hide/show ChatMon button and close ChatMon if open
        const chatBtn = document.getElementById('chat-toggle-btn');
        const chatWindow = document.getElementById('chat-window');
        if (chatBtn) {
            chatBtn.style.display = mipEnabled ? '' : 'none';
        }
        if (!mipEnabled && chatWindow && this.chatWindowOpen) {
            this.toggleChatWindow();  // Close ChatMon
        }
    }

    // Toggle MIP debug mode (shows raw MIP data in output)
    toggleMipDebug(enabled) {
        this.mipDebug = enabled;
        this.preferences.mipDebug = enabled;

        // Update server if MIP is currently enabled
        if (this.mipEnabled) {
            this.connection.setMip(true, this.mipId, this.mipDebug);
        }

        // Save preference
        fetch('api/preferences.php?action=save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferences: { mipDebug: enabled } })
        }).catch(e => console.error('Failed to save mipDebug preference:', e));

        this.appendOutput(`MIP debug ${enabled ? 'enabled' : 'disabled'}`, 'system');
    }

    async logout() {
        try {
            await fetch('api/auth.php?action=logout');
            window.location.href = 'index.php';
        } catch (e) {
            console.error('Logout failed:', e);
        }
    }

    async switchCharacter(characterId) {
        if (characterId === window.WMT_CONFIG.characterId) {
            return; // Same character, no switch needed
        }

        try {
            const res = await fetch('api/characters.php?action=select', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    character_id: characterId,
                    csrf_token: window.WMT_CONFIG.csrfToken
                })
            });
            const data = await res.json();

            if (data.success) {
                // Reload page to load new character's settings
                window.location.reload();
            } else {
                this.appendOutput('Failed to switch character: ' + (data.error || 'Unknown error'), 'error');
                // Reset dropdown to current character
                document.getElementById('character-select').value = window.WMT_CONFIG.characterId;
            }
        } catch (e) {
            console.error('Character switch failed:', e);
            this.appendOutput('Failed to switch character', 'error');
            document.getElementById('character-select').value = window.WMT_CONFIG.characterId;
        }
    }

    // Panel Management
    initPanels() {
        // Initialize panel content based on type
    }

    openPanel(panelType) {
        const panel = document.getElementById('side-panel');
        if (!panel) return;

        // If same panel is already open, close it (toggle behavior)
        if (this.currentPanel === panelType && panel.classList.contains('open')) {
            this.closePanel();
            return;
        }

        this.closePanel();
        panel.classList.add('open');
        this.currentPanel = panelType;

        // Update panel header
        const header = panel.querySelector('.panel-header h3');
        if (header) {
            const titles = {
                'triggers': 'Triggers',
                'aliases': 'Aliases',
                'settings': 'Settings'
            };
            header.textContent = titles[panelType] || panelType;
        }

        // Load panel content
        this.loadPanelContent(panelType);
    }

    closePanel() {
        const panel = document.getElementById('side-panel');
        if (panel) {
            panel.classList.remove('open');
        }
        this.currentPanel = null;
    }

    // ==========================================
    // Scripts Sidebar
    // ==========================================

    toggleScriptsSidebar() {
        const sidebar = document.getElementById('scripts-sidebar');
        if (sidebar?.classList.contains('open')) {
            this.closeScriptsSidebar();
        } else {
            this.openScriptsSidebar();
        }
    }

    openScriptsSidebar() {
        const sidebar = document.getElementById('scripts-sidebar');
        if (sidebar) {
            sidebar.classList.add('open');
            this.renderScriptsSidebar();
        }
    }

    closeScriptsSidebar() {
        const sidebar = document.getElementById('scripts-sidebar');
        if (sidebar) {
            sidebar.classList.remove('open');
        }
    }

    initSidebarResize() {
        const sidebar = document.getElementById('scripts-sidebar');
        const handle = sidebar?.querySelector('.scripts-resize-handle');
        if (!handle) return;

        let isResizing = false;
        let startX, startWidth;

        handle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = sidebar.offsetWidth;
            handle.classList.add('dragging');
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const diff = startX - e.clientX;
            const newWidth = Math.min(Math.max(startWidth + diff, 200), 600);
            sidebar.style.width = newWidth + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                handle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }

    renderScriptsSidebar() {
        const content = document.getElementById('scripts-sidebar-content');
        if (!content) return;

        let html = '';

        // Add buttons at top (paired: Trigger/Alias, Gag/Highlight, Substitute/Ticker)
        html += `
            <div class="sidebar-add-buttons">
                <button class="btn btn-sm btn-secondary" onclick="wmtClient.openTriggerModal()">+ Trigger</button>
                <button class="btn btn-sm btn-secondary" onclick="wmtClient.openAliasModal()">+ Alias</button>
                <button class="btn btn-sm btn-secondary" onclick="wmtClient.openGagModal()">+ Gag</button>
                <button class="btn btn-sm btn-secondary" onclick="wmtClient.openHighlightModal()">+ Highlight</button>
                <button class="btn btn-sm btn-secondary" onclick="wmtClient.openSubstituteModal()">+ Substitute</button>
                <button class="btn btn-sm btn-secondary" onclick="wmtClient.openTickerModal()">+ Ticker</button>
            </div>
        `;

        // Render each class
        this.classes.forEach(cls => {
            const classTrigs = this.triggers.filter(t => t.class === cls.id);
            const classAliases = this.aliases.filter(a => a.class === cls.id);
            const classTickers = this.tickers.filter(t => t.class === cls.id);
            const itemCount = classTrigs.length + classAliases.length + classTickers.length;
            const isEnabled = cls.enabled !== false;
            const isExpanded = cls._expanded !== false; // Default to expanded

            html += `
                <div class="class-section ${isEnabled ? '' : 'disabled'} ${isExpanded ? 'expanded' : ''}" data-class-id="${cls.id}">
                    <div class="class-header" onclick="wmtClient.toggleClassExpand('${cls.id}')">
                        <span class="class-expand">▶</span>
                        <span class="class-name">${this.escapeHtml(cls.name)}</span>
                        <span class="class-count">${itemCount}</span>
                        <div class="class-toggle ${isEnabled ? 'enabled' : ''}" onclick="event.stopPropagation(); wmtClient.toggleClassEnabled('${cls.id}')"></div>
                        <div class="class-actions">
                            <button onclick="event.stopPropagation(); wmtClient.editClass('${cls.id}')" title="Rename">✎</button>
                            <button onclick="event.stopPropagation(); wmtClient.confirmDeleteClass('${cls.id}')" title="Delete">×</button>
                        </div>
                    </div>
                    <div class="class-items">
                        ${this.renderClassItems(classTrigs, classAliases, classTickers)}
                    </div>
                </div>
            `;
        });

        // Render unassigned items
        const unassignedTrigs = this.triggers.filter(t => !t.class);
        const unassignedAliases = this.aliases.filter(a => !a.class);
        const unassignedTickers = this.tickers.filter(t => !t.class);

        if (unassignedTrigs.length > 0 || unassignedAliases.length > 0 || unassignedTickers.length > 0) {
            html += `
                <div class="unassigned-section">
                    <div class="unassigned-header">Unassigned (${unassignedTrigs.length + unassignedAliases.length + unassignedTickers.length})</div>
                    ${this.renderClassItems(unassignedTrigs, unassignedAliases, unassignedTickers)}
                </div>
            `;
        }

        // Empty state
        if (this.classes.length === 0 && unassignedTrigs.length === 0 && unassignedAliases.length === 0 && unassignedTickers.length === 0) {
            html += `
                <div class="empty-state" style="padding: 20px;">
                    <p>No scripts yet.</p>
                    <p style="font-size: 0.85em;">Create triggers and aliases to automate your MUD experience.</p>
                </div>
            `;
        }

        content.innerHTML = html;
    }

    renderClassItems(triggers, aliases, tickers = []) {
        let html = '';

        triggers.forEach(t => {
            const isEnabled = t.enabled !== false;
            // Determine trigger type for icon
            const triggerType = this.getTriggerType(t);
            const iconMap = { gag: 'G', highlight: 'H', substitute: 'S', trigger: 'T' };
            const icon = iconMap[triggerType] || 'T';

            html += `
                <div class="script-item ${isEnabled ? '' : 'disabled'}" data-type="trigger" data-id="${t.id}">
                    <span class="script-item-icon ${triggerType}">${icon}</span>
                    <span class="script-item-name" onclick="wmtClient.editTriggerById('${t.id}')" title="${this.escapeHtml(t.pattern)}">${this.escapeHtml(t.name || t.pattern)}</span>
                    <div class="script-item-toggle ${isEnabled ? 'enabled' : ''}" onclick="wmtClient.toggleTriggerById('${t.id}')"></div>
                    <div class="script-item-actions">
                        <button onclick="wmtClient.deleteTriggerById('${t.id}')" title="Delete">×</button>
                    </div>
                </div>
            `;
        });

        aliases.forEach(a => {
            const isEnabled = a.enabled !== false;
            html += `
                <div class="script-item ${isEnabled ? '' : 'disabled'}" data-type="alias" data-id="${a.id}">
                    <span class="script-item-icon alias">A</span>
                    <span class="script-item-name" onclick="wmtClient.editAliasById('${a.id}')" title="${this.escapeHtml(a.replacement)}">${this.escapeHtml(a.pattern)}</span>
                    <div class="script-item-toggle ${isEnabled ? 'enabled' : ''}" onclick="wmtClient.toggleAliasById('${a.id}')"></div>
                    <div class="script-item-actions">
                        <button onclick="wmtClient.deleteAliasById('${a.id}')" title="Delete">×</button>
                    </div>
                </div>
            `;
        });

        tickers.forEach(t => {
            const isEnabled = t.enabled !== false;
            html += `
                <div class="script-item ${isEnabled ? '' : 'disabled'}" data-type="ticker" data-id="${t.id}">
                    <span class="script-item-icon ticker">K</span>
                    <span class="script-item-name" onclick="wmtClient.editTickerById('${t.id}')" title="${this.escapeHtml(t.command)} (${t.interval}s)">${this.escapeHtml(t.name || t.command)}</span>
                    <div class="script-item-toggle ${isEnabled ? 'enabled' : ''}" onclick="wmtClient.toggleTickerEnabled('${t.id}')"></div>
                    <div class="script-item-actions">
                        <button onclick="wmtClient.deleteTickerById('${t.id}')" title="Delete">×</button>
                    </div>
                </div>
            `;
        });

        return html;
    }

    // Determine the type of trigger for icon display
    getTriggerType(trigger) {
        if (!trigger.actions || trigger.actions.length === 0) return 'trigger';

        // Check what actions the trigger has
        const hasGag = trigger.actions.some(a => a.type === 'gag');
        const hasHighlight = trigger.actions.some(a => a.type === 'highlight');
        const hasSubstitute = trigger.actions.some(a => a.type === 'substitute');
        const hasCommand = trigger.actions.some(a => a.type === 'command');

        // If only gag action, it's a gag
        if (hasGag && !hasHighlight && !hasSubstitute && !hasCommand) return 'gag';
        // If only highlight action, it's a highlight
        if (hasHighlight && !hasGag && !hasSubstitute && !hasCommand) return 'highlight';
        // If only substitute action, it's a substitute
        if (hasSubstitute && !hasGag && !hasHighlight && !hasCommand) return 'substitute';
        // Otherwise it's a regular trigger
        return 'trigger';
    }

    toggleClassExpand(classId) {
        const cls = this.classes.find(c => c.id === classId);
        if (cls) {
            cls._expanded = cls._expanded === false ? true : false;
            this.renderScriptsSidebar();
        }
    }

    async toggleClassEnabled(classId) {
        const cls = this.classes.find(c => c.id === classId);
        if (cls) {
            const newState = cls.enabled === false ? true : false;
            await this.setClassEnabled(classId, newState);
            this.renderScriptsSidebar();
        }
    }

    promptAddClass() {
        const name = prompt('Enter class name:');
        if (name && name.trim()) {
            this.createClass(name.trim());
        }
    }

    editClass(classId) {
        const cls = this.classes.find(c => c.id === classId);
        if (!cls) return;

        const newName = prompt('Rename class:', cls.name);
        if (newName && newName.trim() && newName.trim() !== cls.name) {
            this.renameClass(classId, newName.trim());
        }
    }

    async renameClass(classId, newName) {
        try {
            const res = await fetch('api/classes.php?action=update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ class_id: classId, name: newName })
            });
            const data = await res.json();
            if (data.success) {
                const cls = this.classes.find(c => c.id === classId);
                if (cls) cls.name = newName;
                this.renderScriptsSidebar();
                this.appendOutput(`Class renamed to: ${newName}`, 'system');
            } else {
                alert(data.error || 'Failed to rename class');
            }
        } catch (e) {
            alert('Failed to rename class');
        }
    }

    confirmDeleteClass(classId) {
        const cls = this.classes.find(c => c.id === classId);
        if (!cls) return;

        if (confirm(`Delete class "${cls.name}"? Items in this class will become unassigned.`)) {
            this.deleteClass(classId, false);
        }
    }

    // Edit/toggle/delete by ID (for sidebar)
    editTriggerById(id) {
        const index = this.triggers.findIndex(t => t.id === id);
        if (index >= 0) {
            const trigger = this.triggers[index];
            const type = this.getTriggerType(trigger);

            // Route to appropriate modal based on type
            if (type === 'gag') {
                this.openGagModal(index);
            } else if (type === 'highlight') {
                this.openHighlightModal(index);
            } else if (type === 'substitute') {
                this.openSubstituteModal(index);
            } else {
                this.openTriggerModal(index);
            }
        }
    }

    async toggleTriggerById(id) {
        const index = this.triggers.findIndex(t => t.id === id);
        if (index >= 0) {
            this.triggers[index].enabled = !this.triggers[index].enabled;
            await this.saveTriggers();
            this.renderScriptsSidebar();
        }
    }

    async deleteTriggerById(id) {
        if (!confirm('Delete this trigger?')) return;
        const index = this.triggers.findIndex(t => t.id === id);
        if (index >= 0) {
            this.triggers.splice(index, 1);
            await this.saveTriggers();
            this.renderScriptsSidebar();
        }
    }

    editAliasById(id) {
        const index = this.aliases.findIndex(a => a.id === id);
        if (index >= 0) {
            this.openAliasModal(index);
        }
    }

    async toggleAliasById(id) {
        const index = this.aliases.findIndex(a => a.id === id);
        if (index >= 0) {
            this.aliases[index].enabled = !this.aliases[index].enabled;
            await this.saveAliases();
            this.renderScriptsSidebar();
        }
    }

    async deleteAliasById(id) {
        if (!confirm('Delete this alias?')) return;
        const index = this.aliases.findIndex(a => a.id === id);
        if (index >= 0) {
            this.aliases.splice(index, 1);
            await this.saveAliases();
            this.renderScriptsSidebar();
        }
    }

    loadPanelContent(panelType) {
        const content = document.getElementById('panel-content');
        if (!content) return;

        switch (panelType) {
            case 'triggers':
                content.innerHTML = this.renderTriggersPanel();
                this.bindTriggersEvents();
                break;

            case 'aliases':
                content.innerHTML = this.renderAliasesPanel();
                this.bindAliasesEvents();
                break;

            case 'settings':
                content.innerHTML = this.renderSettingsPanel();
                this.bindSettingsEvents();
                break;
        }
    }

    // Triggers Panel
    renderTriggersPanel() {
        let html = `
            <button class="btn btn-primary" id="add-trigger-btn" style="width:100%;margin-bottom:15px;">
                + Add Trigger
            </button>
        `;

        if (this.triggers.length === 0) {
            html += `
                <div class="empty-state">
                    <p>No triggers configured.</p>
                    <p>Triggers automatically respond to text from the MUD.</p>
                </div>
            `;
        } else {
            html += '<ul class="item-list">';
            this.triggers.forEach((trigger, index) => {
                const matchLabels = {
                    'regex': '<span style="color:#ffaa00;font-size:0.8em;">[regex]</span>',
                    'tintin': '<span style="color:#ff88ff;font-size:0.8em;">[tt++]</span>',
                    'exact': '<span style="color:#6699ff;font-size:0.8em;">[exact]</span>',
                    'startsWith': '<span style="color:#6699ff;font-size:0.8em;">[starts]</span>',
                    'endsWith': '<span style="color:#6699ff;font-size:0.8em;">[ends]</span>'
                };
                const matchLabel = matchLabels[trigger.matchType] || '';
                const className = this.getClassName(trigger.class);
                const classLabel = className ? `<span style="color:#88cc88;font-size:0.8em;">[${this.escapeHtml(className)}]</span>` : '';
                const classDisabled = trigger.class && !this.isClassEnabled(trigger.class);
                const disabledClass = (trigger.enabled === false || classDisabled) ? 'disabled' : '';
                html += `
                    <li class="${disabledClass}" data-index="${index}">
                        <div class="item-info">
                            <div class="item-name">${this.escapeHtml(trigger.name || 'Unnamed Trigger')} ${matchLabel} ${classLabel}</div>
                            <div class="item-pattern">${this.escapeHtml(trigger.pattern)}</div>
                        </div>
                        <div class="item-actions">
                            <button class="edit-trigger" data-index="${index}">Edit</button>
                            <button class="toggle-trigger" data-index="${index}">
                                ${trigger.enabled === false ? 'Enable' : 'Disable'}
                            </button>
                            <button class="delete delete-trigger" data-index="${index}">Delete</button>
                        </div>
                    </li>
                `;
            });
            html += '</ul>';
        }

        return html;
    }

    bindTriggersEvents() {
        document.getElementById('add-trigger-btn')?.addEventListener('click', () => this.openTriggerModal());

        document.querySelectorAll('.edit-trigger').forEach(btn => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                this.openTriggerModal(index);
            });
        });

        document.querySelectorAll('.toggle-trigger').forEach(btn => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                this.toggleTrigger(index);
            });
        });

        document.querySelectorAll('.delete-trigger').forEach(btn => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                this.deleteTrigger(index);
            });
        });
    }

    // Helper to render class options for dropdowns
    renderClassOptions(selectedClassId = null) {
        let options = '<option value="">No Class</option>';
        this.classes.forEach(cls => {
            const selected = cls.id === selectedClassId ? 'selected' : '';
            const disabled = cls.enabled === false ? ' (disabled)' : '';
            options += `<option value="${cls.id}" ${selected}>${this.escapeHtml(cls.name)}${disabled}</option>`;
        });
        return options;
    }

    // Get class name by ID
    getClassName(classId) {
        if (!classId) return null;
        const cls = this.classes.find(c => c.id === classId);
        return cls ? cls.name : null;
    }

    // Check if a class is enabled
    isClassEnabled(classId) {
        if (!classId) return true; // No class = always enabled
        const cls = this.classes.find(c => c.id === classId);
        return cls ? cls.enabled !== false : true;
    }

    openTriggerModal(index = null) {
        const trigger = index !== null ? this.triggers[index] : null;
        this.editingItem = index;

        const modal = document.getElementById('trigger-modal');
        if (!modal) return;

        // Populate form
        document.getElementById('trigger-name').value = trigger?.name || '';
        document.getElementById('trigger-pattern').value = trigger?.pattern || '';

        // Populate class dropdown
        const classSelect = document.getElementById('trigger-class');
        if (classSelect) {
            classSelect.innerHTML = this.renderClassOptions(trigger?.class);
        }

        // Populate actions
        const actionsContainer = document.getElementById('trigger-actions');
        actionsContainer.innerHTML = '';

        if (trigger?.actions?.length) {
            trigger.actions.forEach(action => {
                this.addTriggerAction(action);
            });
        } else {
            this.addTriggerAction();
        }

        modal.classList.add('open');
    }

    addTriggerAction(action = null) {
        const container = document.getElementById('trigger-actions');
        const div = document.createElement('div');
        div.className = 'action-item';
        const actionType = action?.type || 'command';
        const value = this.escapeHtml(action?.command || action?.replacement || '');
        const webhookUrl = this.escapeHtml(action?.webhookUrl || '');
        const discordMessage = this.escapeHtml(action?.type === 'discord' ? (action?.message || '') : '');
        const chatmonMessage = this.escapeHtml(action?.type === 'chatmon' ? (action?.message || '') : '');
        const chatmonChannel = this.escapeHtml(action?.channel || '');
        const fgColor = action?.fgColor || action?.color || '#ffff00';
        const bgColor = action?.bgColor || '';

        // Build the input fields HTML based on action type
        const buildInputFields = (type, val, webhook, discMsg, chatMsg, chatChan, fg, bg) => {
            if (type === 'command') {
                return `<textarea class="action-value" placeholder="Command(s) - use semicolons or newlines to separate" rows="2">${val}</textarea>`;
            } else if (type === 'discord') {
                return `
                    <div class="discord-fields">
                        <input type="text" class="action-webhook" placeholder="Discord Webhook URL" value="${webhook}">
                        <input type="text" class="action-message" placeholder="Message (use %1, %2, $var)" value="${discMsg}">
                    </div>
                `;
            } else if (type === 'chatmon') {
                return `
                    <div class="chatmon-fields">
                        <input type="text" class="action-chatmon-msg" placeholder="Message (use %1, %2, $var)" value="${chatMsg}">
                        <input type="text" class="action-chatmon-channel" placeholder="Channel (optional)" value="${chatChan}">
                    </div>
                `;
            } else if (type === 'highlight') {
                return `
                    <div class="highlight-fields">
                        <label>Text: <input type="color" class="action-fg-color" value="${fg || '#ffff00'}"></label>
                        <label>BG: <input type="color" class="action-bg-color" value="${bg || '#000000'}"></label>
                        <label><input type="checkbox" class="action-bg-enabled" ${bg ? 'checked' : ''}> Use BG</label>
                    </div>
                `;
            } else if (type === 'gag') {
                return `<span class="gag-note">Line will be hidden</span>`;
            } else {
                return `<input type="text" class="action-value" placeholder="Value" value="${val}">`;
            }
        };

        div.innerHTML = `
            <select class="action-type">
                <option value="command" ${actionType === 'command' ? 'selected' : ''}>Send Command</option>
                <option value="chatmon" ${actionType === 'chatmon' ? 'selected' : ''}>Send to ChatMon</option>
                <option value="discord" ${actionType === 'discord' ? 'selected' : ''}>Send to Discord</option>
                <option value="highlight" ${actionType === 'highlight' ? 'selected' : ''}>Highlight</option>
                <option value="gag" ${actionType === 'gag' ? 'selected' : ''}>Gag (Hide)</option>
                <option value="substitute" ${actionType === 'substitute' ? 'selected' : ''}>Substitute</option>
                <option value="sound" ${actionType === 'sound' ? 'selected' : ''}>Play Sound</option>
            </select>
            <div class="action-fields">
                ${buildInputFields(actionType, value, webhookUrl, discordMessage, chatmonMessage, chatmonChannel, fgColor, bgColor)}
            </div>
            <button type="button" class="btn btn-sm btn-danger remove-action">X</button>
        `;

        // Switch between input types based on action type
        const typeSelect = div.querySelector('.action-type');
        const fieldsContainer = div.querySelector('.action-fields');

        typeSelect.addEventListener('change', () => {
            const newType = typeSelect.value;
            fieldsContainer.innerHTML = buildInputFields(newType, '', '', '', '', '', '#ffff00', '');
        });

        div.querySelector('.remove-action').addEventListener('click', () => div.remove());
        container.appendChild(div);
    }

    /**
     * Detect if a pattern uses TinTin++ syntax
     * Returns 'tintin' if pattern contains % wildcards, anchors, or { } braces
     * Returns 'contains' for simple text patterns
     */
    detectPatternType(pattern) {
        // Check for % followed by wildcard chars or digits
        if (/%[*+?.dDwWsSaAcCpPuU0-9!]/.test(pattern)) return 'tintin';
        // Check for ^ anchor at start
        if (pattern.startsWith('^')) return 'tintin';
        // Check for $ anchor at end
        if (pattern.endsWith('$')) return 'tintin';
        // Check for { } PCRE embedding
        if (/\{.*\}/.test(pattern)) return 'tintin';
        return 'contains';
    }

    async saveTrigger() {
        const name = document.getElementById('trigger-name').value.trim();
        const pattern = document.getElementById('trigger-pattern').value.trim();
        const classId = document.getElementById('trigger-class')?.value || null;

        if (!pattern) {
            alert('Pattern is required');
            return;
        }

        // Auto-detect pattern type
        const matchType = this.detectPatternType(pattern);

        const actions = [];
        document.querySelectorAll('#trigger-actions .action-item').forEach(item => {
            const type = item.querySelector('.action-type').value;

            const action = { type };
            if (type === 'command') {
                action.command = item.querySelector('.action-value')?.value || '';
            } else if (type === 'discord') {
                action.webhookUrl = item.querySelector('.action-webhook')?.value || '';
                action.message = item.querySelector('.action-message')?.value || '';
            } else if (type === 'chatmon') {
                action.message = item.querySelector('.action-chatmon-msg')?.value || '';
                action.channel = item.querySelector('.action-chatmon-channel')?.value || 'trigger';
            } else if (type === 'highlight') {
                action.fgColor = item.querySelector('.action-fg-color')?.value || '#ffff00';
                const bgEnabled = item.querySelector('.action-bg-enabled')?.checked;
                if (bgEnabled) {
                    action.bgColor = item.querySelector('.action-bg-color')?.value || '#000000';
                }
            } else if (type === 'substitute') {
                action.replacement = item.querySelector('.action-value')?.value || '';
            } else if (type === 'sound') {
                action.sound = item.querySelector('.action-value')?.value || 'beep';
            }

            actions.push(action);
        });

        const trigger = {
            id: this.editingItem !== null ? this.triggers[this.editingItem].id : this.generateId(),
            name: name || pattern,
            pattern,
            matchType,
            actions,
            enabled: true,
            class: classId || null
        };

        if (this.editingItem !== null) {
            trigger.enabled = this.triggers[this.editingItem].enabled;
            this.triggers[this.editingItem] = trigger;
        } else {
            this.triggers.push(trigger);
        }

        await this.saveTriggers();
        this.closeModal();
        this.loadPanelContent('triggers');
    }

    async toggleTrigger(index) {
        this.triggers[index].enabled = !this.triggers[index].enabled;
        await this.saveTriggers();
        this.loadPanelContent('triggers');
    }

    async deleteTrigger(index) {
        if (!confirm('Delete this trigger?')) return;
        this.triggers.splice(index, 1);
        await this.saveTriggers();
        this.loadPanelContent('triggers');
    }

    async saveTriggers() {
        try {
            await fetch('api/triggers.php?action=save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ triggers: this.triggers })
            });
            this.sendFilteredTriggersAndAliases();
            // Refresh sidebar if open
            if (document.getElementById('scripts-sidebar')?.classList.contains('open')) {
                this.renderScriptsSidebar();
            }
        } catch (e) {
            console.error('Failed to save triggers:', e);
        }
    }

    // Aliases Panel
    renderAliasesPanel() {
        let html = `
            <button class="btn btn-primary" id="add-alias-btn" style="width:100%;margin-bottom:15px;">
                + Add Alias
            </button>
        `;

        if (this.aliases.length === 0) {
            html += `
                <div class="empty-state">
                    <p>No aliases configured.</p>
                    <p>Aliases are shortcuts for longer commands.</p>
                </div>
            `;
        } else {
            html += '<ul class="item-list">';
            this.aliases.forEach((alias, index) => {
                const matchLabel = alias.matchType === 'regex' ? ' <span style="color:#ffaa00;font-size:0.8em;">[regex]</span>' :
                                   alias.matchType === 'tintin' ? ' <span style="color:#ff88ff;font-size:0.8em;">[tt++]</span>' :
                                   alias.matchType === 'startsWith' ? ' <span style="color:#6699ff;font-size:0.8em;">[starts]</span>' : '';
                const className = this.getClassName(alias.class);
                const classLabel = className ? ` <span style="color:#88cc88;font-size:0.8em;">[${this.escapeHtml(className)}]</span>` : '';
                const classDisabled = alias.class && !this.isClassEnabled(alias.class);
                const disabledClass = (alias.enabled === false || classDisabled) ? 'disabled' : '';
                html += `
                    <li class="${disabledClass}" data-index="${index}">
                        <div class="item-info">
                            <div class="item-name">${this.escapeHtml(alias.pattern)}${matchLabel}${classLabel}</div>
                            <div class="item-pattern">${this.escapeHtml(alias.replacement)}</div>
                        </div>
                        <div class="item-actions">
                            <button class="edit-alias" data-index="${index}">Edit</button>
                            <button class="toggle-alias" data-index="${index}">
                                ${alias.enabled === false ? 'Enable' : 'Disable'}
                            </button>
                            <button class="delete delete-alias" data-index="${index}">Delete</button>
                        </div>
                    </li>
                `;
            });
            html += '</ul>';
        }

        return html;
    }

    bindAliasesEvents() {
        document.getElementById('add-alias-btn')?.addEventListener('click', () => this.openAliasModal());

        document.querySelectorAll('.edit-alias').forEach(btn => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                this.openAliasModal(index);
            });
        });

        document.querySelectorAll('.toggle-alias').forEach(btn => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                this.toggleAlias(index);
            });
        });

        document.querySelectorAll('.delete-alias').forEach(btn => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                this.deleteAlias(index);
            });
        });
    }

    openAliasModal(index = null) {
        const alias = index !== null ? this.aliases[index] : null;
        this.editingItem = index;

        const modal = document.getElementById('alias-modal');
        if (!modal) return;

        document.getElementById('alias-pattern').value = alias?.pattern || '';
        document.getElementById('alias-replacement').value = alias?.replacement || '';

        // Populate class dropdown
        const classSelect = document.getElementById('alias-class');
        if (classSelect) {
            classSelect.innerHTML = this.renderClassOptions(alias?.class);
        }

        modal.classList.add('open');
    }

    // Open gag modal
    openGagModal(editIndex = null) {
        const modal = document.getElementById('gag-modal');
        if (!modal) return;

        this.editingGagIndex = editIndex;
        const existing = editIndex !== null ? this.triggers[editIndex] : null;

        // Populate form
        // For name, strip auto-generated "Gag: " prefix if present
        let displayName = existing?.name || '';
        if (displayName.startsWith('Gag: ')) {
            displayName = '';  // Don't show auto-generated names
        }
        document.getElementById('gag-name').value = displayName;
        document.getElementById('gag-pattern').value = existing?.pattern || '';

        // Populate class dropdown
        const classSelect = document.getElementById('gag-class');
        if (classSelect) {
            classSelect.innerHTML = this.renderClassOptions(existing?.class || null);
        }

        // Update modal title
        const title = modal.querySelector('.modal-header h3');
        if (title) title.textContent = existing ? 'Edit Gag' : 'New Gag';

        modal.classList.add('open');
    }

    // Save gag from modal
    async saveGag() {
        const name = document.getElementById('gag-name').value.trim();
        const pattern = document.getElementById('gag-pattern').value.trim();
        const classId = document.getElementById('gag-class')?.value || null;

        if (!pattern) {
            alert('Pattern is required');
            return;
        }

        // Auto-detect pattern type
        const matchType = this.detectPatternType(pattern);

        // Use provided name or auto-generate from pattern
        const displayName = name || `Gag: ${pattern.substring(0, 20)}`;

        if (this.editingGagIndex !== null) {
            // Update existing
            const trigger = this.triggers[this.editingGagIndex];
            trigger.pattern = pattern;
            trigger.matchType = matchType;
            trigger.name = displayName;
            trigger.class = classId || null;
            this.appendOutput(`Gag updated: ${pattern}`, 'system');
        } else {
            // Create new gag trigger
            const trigger = {
                id: this.generateId(),
                name: displayName,
                pattern: pattern,
                matchType: matchType,
                actions: [{ type: 'gag' }],
                enabled: true,
                class: classId || null
            };
            this.triggers.push(trigger);
            this.appendOutput(`Gag created: ${pattern}`, 'system');
        }

        await this.saveTriggers();
        this.closeModal();
        this.renderScriptsSidebar();
        this.editingGagIndex = null;
    }

    // Open highlight modal
    openHighlightModal(editIndex = null) {
        const modal = document.getElementById('highlight-modal');
        if (!modal) return;

        this.editingHighlightIndex = editIndex;
        const existing = editIndex !== null ? this.triggers[editIndex] : null;
        const existingAction = existing?.actions?.find(a => a.type === 'highlight') || {};

        // Populate form
        document.getElementById('highlight-pattern').value = existing?.pattern || '';

        // Handle colors - check for old 'color' field as well as new fgColor/bgColor
        const hasFgColor = existingAction.fgColor || existingAction.color;
        const hasBgColor = existingAction.bgColor;

        document.getElementById('highlight-fg-color').value = existingAction.fgColor || existingAction.color || '#ff0000';
        document.getElementById('highlight-fg-enabled').checked = existing ? !!hasFgColor : true;
        document.getElementById('highlight-bg-color').value = existingAction.bgColor || '#333300';
        document.getElementById('highlight-bg-enabled').checked = !!hasBgColor;

        this.updateHighlightPreview();

        // Clear selected presets
        modal.querySelectorAll('.color-preset').forEach(btn => btn.classList.remove('selected'));

        // Populate class dropdown
        const classSelect = document.getElementById('highlight-class');
        if (classSelect) {
            classSelect.innerHTML = this.renderClassOptions(existing?.class || null);
        }

        // Update modal title
        const title = modal.querySelector('.modal-header h3');
        if (title) title.textContent = existing ? 'Edit Highlight' : 'New Highlight';

        // Setup color preset click handlers (only once)
        if (!modal.dataset.colorHandlersSet) {
            // Foreground color presets
            modal.querySelectorAll('.fg-preset').forEach(btn => {
                btn.addEventListener('click', () => {
                    const color = btn.dataset.color;
                    if (color) {
                        document.getElementById('highlight-fg-color').value = color;
                        document.getElementById('highlight-fg-enabled').checked = true;
                    } else {
                        document.getElementById('highlight-fg-enabled').checked = false;
                    }
                    modal.querySelectorAll('.fg-preset').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                    this.updateHighlightPreview();
                });
            });

            // Background color presets
            modal.querySelectorAll('.bg-preset').forEach(btn => {
                btn.addEventListener('click', () => {
                    const color = btn.dataset.color;
                    if (color) {
                        document.getElementById('highlight-bg-color').value = color;
                        document.getElementById('highlight-bg-enabled').checked = true;
                    } else {
                        document.getElementById('highlight-bg-enabled').checked = false;
                    }
                    modal.querySelectorAll('.bg-preset').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                    this.updateHighlightPreview();
                });
            });

            // Custom color inputs
            document.getElementById('highlight-fg-color')?.addEventListener('input', () => {
                document.getElementById('highlight-fg-enabled').checked = true;
                modal.querySelectorAll('.fg-preset').forEach(b => b.classList.remove('selected'));
                this.updateHighlightPreview();
            });

            document.getElementById('highlight-bg-color')?.addEventListener('input', () => {
                document.getElementById('highlight-bg-enabled').checked = true;
                modal.querySelectorAll('.bg-preset').forEach(b => b.classList.remove('selected'));
                this.updateHighlightPreview();
            });

            // Enable checkboxes
            document.getElementById('highlight-fg-enabled')?.addEventListener('change', () => this.updateHighlightPreview());
            document.getElementById('highlight-bg-enabled')?.addEventListener('change', () => this.updateHighlightPreview());

            modal.dataset.colorHandlersSet = 'true';
        }

        modal.classList.add('open');
    }

    // Update highlight color preview
    updateHighlightPreview() {
        const previewText = document.getElementById('highlight-preview-text');
        if (!previewText) return;

        const fgEnabled = document.getElementById('highlight-fg-enabled')?.checked;
        const bgEnabled = document.getElementById('highlight-bg-enabled')?.checked;
        const fgColor = document.getElementById('highlight-fg-color')?.value || '#ff0000';
        const bgColor = document.getElementById('highlight-bg-color')?.value || '#333300';

        // Apply foreground color
        previewText.style.color = fgEnabled ? fgColor : '#cccccc';

        // Apply background color
        previewText.style.backgroundColor = bgEnabled ? bgColor : 'transparent';
        previewText.style.padding = bgEnabled ? '2px 4px' : '0';
        previewText.style.borderRadius = bgEnabled ? '2px' : '0';
    }

    // Save highlight from modal
    async saveHighlight() {
        const pattern = document.getElementById('highlight-pattern').value.trim();
        const fgEnabled = document.getElementById('highlight-fg-enabled')?.checked;
        const bgEnabled = document.getElementById('highlight-bg-enabled')?.checked;
        const fgColor = document.getElementById('highlight-fg-color')?.value;
        const bgColor = document.getElementById('highlight-bg-color')?.value;
        const classId = document.getElementById('highlight-class')?.value || null;

        if (!pattern) {
            alert('Pattern is required');
            return;
        }

        if (!fgEnabled && !bgEnabled) {
            alert('Please enable at least one color (foreground or background)');
            return;
        }

        // Auto-detect pattern type
        const matchType = this.detectPatternType(pattern);

        // Build action with fg/bg colors
        const action = { type: 'highlight' };
        if (fgEnabled && fgColor) {
            action.fgColor = fgColor;
        }
        if (bgEnabled && bgColor) {
            action.bgColor = bgColor;
        }

        const colorDesc = [];
        if (fgEnabled) colorDesc.push(`fg:${fgColor}`);
        if (bgEnabled) colorDesc.push(`bg:${bgColor}`);

        if (this.editingHighlightIndex !== null) {
            // Update existing
            const trigger = this.triggers[this.editingHighlightIndex];
            trigger.pattern = pattern;
            trigger.matchType = matchType;
            trigger.name = `Highlight: ${pattern.substring(0, 20)}`;
            trigger.actions = [action];
            trigger.class = classId || null;
            this.appendOutput(`Highlight updated: ${pattern} [${colorDesc.join(', ')}]`, 'system');
        } else {
            // Create new highlight trigger
            const trigger = {
                id: this.generateId(),
                name: `Highlight: ${pattern.substring(0, 20)}`,
                pattern: pattern,
                matchType: matchType,
                actions: [action],
                enabled: true,
                class: classId || null
            };
            this.triggers.push(trigger);
            this.appendOutput(`Highlight created: ${pattern} [${colorDesc.join(', ')}]`, 'system');
        }

        await this.saveTriggers();
        this.closeModal();
        this.renderScriptsSidebar();
        this.editingHighlightIndex = null;
    }

    // Open ticker modal (editIndex is the ticker id to edit, or null for new)
    openTickerModal(editId = null) {
        const modal = document.getElementById('ticker-modal');
        if (!modal) return;

        this.editingTickerId = editId;
        const ticker = editId ? this.tickers.find(t => t.id === editId) : null;

        // Set form values
        document.getElementById('ticker-name').value = ticker?.name || '';
        document.getElementById('ticker-command').value = ticker?.command || '';
        document.getElementById('ticker-interval').value = ticker?.interval || '60';

        // Update class dropdown
        const classSelect = document.getElementById('ticker-class');
        if (classSelect) {
            classSelect.innerHTML = this.renderClassOptions(ticker?.class);
        }

        // Update modal title
        const title = modal.querySelector('h3');
        if (title) {
            title.textContent = editId ? 'Edit Ticker' : 'New Ticker';
        }

        modal.classList.add('open');
    }

    // Save ticker from modal
    async saveTicker() {
        const name = document.getElementById('ticker-name').value.trim();
        const command = document.getElementById('ticker-command').value.trim();
        const interval = parseFloat(document.getElementById('ticker-interval').value);
        const tickerClass = document.getElementById('ticker-class')?.value || null;

        if (!name) {
            alert('Name is required');
            return;
        }
        if (!command) {
            alert('Command is required');
            return;
        }
        if (isNaN(interval) || interval < 1) {
            alert('Interval must be at least 1 second');
            return;
        }

        if (this.editingTickerId) {
            // Update existing ticker
            const ticker = this.tickers.find(t => t.id === this.editingTickerId);
            if (ticker) {
                ticker.name = name;
                ticker.command = command;
                ticker.interval = interval;
                ticker.class = tickerClass || null;
            }
        } else {
            // Create new ticker
            const ticker = {
                id: 'ticker_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                name: name,
                command: command,
                interval: interval,
                enabled: true,
                class: tickerClass || null
            };
            this.tickers.push(ticker);
        }

        await this.saveTickers();
        this.closeModal();
        this.editingTickerId = null;
    }

    // Edit ticker by id
    editTickerById(id) {
        this.openTickerModal(id);
    }

    // Delete ticker by id
    async deleteTickerById(id) {
        if (!confirm('Delete this ticker?')) return;
        this.tickers = this.tickers.filter(t => t.id !== id);
        await this.saveTickers();
    }

    // Toggle ticker enabled/disabled
    async toggleTickerEnabled(id) {
        const ticker = this.tickers.find(t => t.id === id);
        if (ticker) {
            ticker.enabled = !ticker.enabled;
            await this.saveTickers();
        }
    }

    async saveAlias() {
        const pattern = document.getElementById('alias-pattern').value.trim();
        const replacement = document.getElementById('alias-replacement').value.trim();
        const classId = document.getElementById('alias-class')?.value || null;

        if (!pattern || !replacement) {
            alert('Pattern and replacement are required');
            return;
        }

        // Auto-detect match type: if pattern has TinTin++ wildcards, use tintin mode
        // Otherwise use exact first-word matching
        const hasTinTinWildcards = /%[*+?.dDwWsSaAcCpPuU0-9!]/.test(pattern) ||
                                   pattern.startsWith('^') || pattern.endsWith('$');
        const matchType = hasTinTinWildcards ? 'tintin' : 'exact';

        const alias = {
            id: this.editingItem !== null ? this.aliases[this.editingItem].id : this.generateId(),
            pattern,
            matchType,
            replacement,
            enabled: true,
            class: classId || null
        };

        if (this.editingItem !== null) {
            alias.enabled = this.aliases[this.editingItem].enabled;
            this.aliases[this.editingItem] = alias;
        } else {
            this.aliases.push(alias);
        }

        await this.saveAliases();
        this.closeModal();
        this.loadPanelContent('aliases');
    }

    async toggleAlias(index) {
        this.aliases[index].enabled = !this.aliases[index].enabled;
        await this.saveAliases();
        this.loadPanelContent('aliases');
    }

    async deleteAlias(index) {
        if (!confirm('Delete this alias?')) return;
        this.aliases.splice(index, 1);
        await this.saveAliases();
        this.loadPanelContent('aliases');
    }

    async saveAliases() {
        try {
            await fetch('api/aliases.php?action=save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ aliases: this.aliases })
            });
            this.sendFilteredTriggersAndAliases();
            // Refresh sidebar if open
            if (document.getElementById('scripts-sidebar')?.classList.contains('open')) {
                this.renderScriptsSidebar();
            }
        } catch (e) {
            console.error('Failed to save aliases:', e);
        }
    }

    async saveTickers() {
        try {
            await fetch('api/tickers.php?action=save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tickers: this.tickers })
            });
            this.sendFilteredTriggersAndAliases();
            // Refresh sidebar if open
            if (document.getElementById('scripts-sidebar')?.classList.contains('open')) {
                this.renderScriptsSidebar();
            }
        } catch (e) {
            console.error('Failed to save tickers:', e);
        }
    }

    // Settings Panel
    renderSettingsPanel() {
        const prefs = this.preferences;

        return `
            <div class="settings-scroll-content">
            <div class="settings-section">
                <h4>Display</h4>
                <div class="form-group">
                    <label>Font Family</label>
                    <select id="pref-font-family">
                        <option value="Consolas, Monaco, monospace" ${prefs.fontFamily?.includes('Consolas') ? 'selected' : ''}>Consolas</option>
                        <option value="'Courier New', Courier, monospace" ${prefs.fontFamily?.includes('Courier') ? 'selected' : ''}>Courier New</option>
                        <option value="'Lucida Console', Monaco, monospace" ${prefs.fontFamily?.includes('Lucida') ? 'selected' : ''}>Lucida Console</option>
                        <option value="monospace" ${prefs.fontFamily === 'monospace' ? 'selected' : ''}>System Monospace</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Font Size: <span id="font-size-value">${prefs.fontSize || 14}px</span></label>
                    <input type="range" id="pref-font-size" min="6" max="24" value="${prefs.fontSize || 14}">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Text Color</label>
                        <input type="color" id="pref-text-color" value="${prefs.textColor || '#00ff00'}">
                    </div>
                    <div class="form-group">
                        <label>Background</label>
                        <input type="color" id="pref-bg-color" value="${prefs.backgroundColor || '#000000'}">
                    </div>
                </div>
            </div>

            <div class="settings-section">
                <h4>Behavior</h4>
                <div class="settings-toggle">
                    <span class="settings-toggle-label">Echo Commands</span>
                    <label class="settings-toggle-switch">
                        <input type="checkbox" id="pref-echo" ${prefs.echoCommands !== false ? 'checked' : ''}>
                        <span class="settings-toggle-slider"></span>
                    </label>
                </div>
                <div class="settings-toggle">
                    <span class="settings-toggle-label">Auto-scroll Output</span>
                    <label class="settings-toggle-switch">
                        <input type="checkbox" id="pref-scroll" ${prefs.scrollOnOutput !== false ? 'checked' : ''}>
                        <span class="settings-toggle-slider"></span>
                    </label>
                </div>
                <div class="form-group" style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; color: #ccc;">Scrollback Limit (lines)</label>
                    <select id="pref-scrollback" style="width: 100%; padding: 8px; background: #1a1a1a; border: 1px solid #333; color: #fff; border-radius: 4px;">
                        <option value="2000" ${(prefs.scrollbackLimit || 5000) == 2000 ? 'selected' : ''}>2,000</option>
                        <option value="5000" ${(prefs.scrollbackLimit || 5000) == 5000 ? 'selected' : ''}>5,000</option>
                        <option value="10000" ${(prefs.scrollbackLimit || 5000) == 10000 ? 'selected' : ''}>10,000</option>
                        <option value="20000" ${(prefs.scrollbackLimit || 5000) == 20000 ? 'selected' : ''}>20,000</option>
                    </select>
                    <p class="settings-hint" style="font-size: 11px; color: #666; margin-top: 5px;">Older lines are removed to prevent slowdown</p>
                </div>
                <div class="settings-toggle">
                    <span class="settings-toggle-label">Retain Last Command</span>
                    <label class="settings-toggle-switch">
                        <input type="checkbox" id="pref-retain" ${prefs.retainLastCommand ? 'checked' : ''}>
                        <span class="settings-toggle-slider"></span>
                    </label>
                </div>
                <div class="form-group" style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; color: #ccc;">Command History Size</label>
                    <select id="pref-history-size" style="width: 100%; padding: 8px; background: #1a1a1a; border: 1px solid #333; color: #fff; border-radius: 4px;">
                        <option value="100" ${(prefs.historySize || 500) == 100 ? 'selected' : ''}>100</option>
                        <option value="250" ${(prefs.historySize || 500) == 250 ? 'selected' : ''}>250</option>
                        <option value="500" ${(prefs.historySize || 500) == 500 ? 'selected' : ''}>500</option>
                        <option value="1000" ${(prefs.historySize || 500) == 1000 ? 'selected' : ''}>1,000</option>
                        <option value="2000" ${(prefs.historySize || 500) == 2000 ? 'selected' : ''}>2,000</option>
                    </select>
                    <p class="settings-hint" style="font-size: 11px; color: #666; margin-top: 5px;">Type a prefix and press Up to search history</p>
                </div>
                <div class="settings-toggle">
                    <span class="settings-toggle-label">Keep Screen Awake</span>
                    <label class="settings-toggle-switch">
                        <input type="checkbox" id="pref-wake-lock" ${prefs.wakeLock ? 'checked' : ''}>
                        <span class="settings-toggle-slider"></span>
                    </label>
                </div>
                <p class="settings-hint" style="font-size: 11px; color: #666; margin-top: -5px;">Prevents phone from sleeping while connected</p>
                <div class="form-group" style="margin-top: 15px; margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; color: #ccc;">Auto-disconnect after inactivity</label>
                    <select id="pref-idle-disconnect" style="width: 100%; padding: 8px; background: #1a1a1a; border: 1px solid #333; color: #fff; border-radius: 4px;">
                        <option value="0" ${!prefs.idleDisconnectMinutes ? 'selected' : ''}>Disabled</option>
                        <option value="15" ${prefs.idleDisconnectMinutes == 15 ? 'selected' : ''}>15 minutes</option>
                        <option value="30" ${prefs.idleDisconnectMinutes == 30 ? 'selected' : ''}>30 minutes</option>
                        <option value="60" ${prefs.idleDisconnectMinutes == 60 ? 'selected' : ''}>1 hour</option>
                        <option value="120" ${prefs.idleDisconnectMinutes == 120 ? 'selected' : ''}>2 hours</option>
                    </select>
                    <p class="settings-hint" style="font-size: 11px; color: #666; margin-top: 5px;">Disconnects if YOU haven't typed anything (triggers still run)</p>
                </div>
            </div>

            <div class="settings-section">
                <h4>Notifications</h4>
                <div class="form-group" style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; color: #ccc;">Alert Sound</label>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        <select id="pref-notification-sound" style="flex: 1; padding: 8px; background: #1a1a1a; border: 1px solid #333; color: #fff; border-radius: 4px;">
                            <option value="classic" ${(prefs.notificationSound || 'classic') == 'classic' ? 'selected' : ''}>Classic Beep</option>
                            <option value="ping" ${prefs.notificationSound == 'ping' ? 'selected' : ''}>Soft Ping</option>
                            <option value="double" ${prefs.notificationSound == 'double' ? 'selected' : ''}>Double Beep</option>
                            <option value="chime" ${prefs.notificationSound == 'chime' ? 'selected' : ''}>Chime</option>
                            <option value="alert" ${prefs.notificationSound == 'alert' ? 'selected' : ''}>Alert</option>
                            <option value="gentle" ${prefs.notificationSound == 'gentle' ? 'selected' : ''}>Gentle</option>
                        </select>
                        <button id="test-sound-btn" class="settings-btn" style="padding: 8px 12px; white-space: nowrap;">Test</button>
                    </div>
                    <p class="settings-hint" style="font-size: 11px; color: #666; margin-top: 5px;">Used for #bell command and channel alerts</p>
                </div>
                <div class="form-group" style="margin-bottom: 15px;">
                    <label style="display: block; margin-bottom: 5px; color: #ccc;">Alert Volume: <span id="volume-display">${prefs.notificationVolume ?? 30}%</span></label>
                    <input type="range" id="pref-notification-volume" min="0" max="100" value="${prefs.notificationVolume ?? 30}"
                        style="width: 100%; cursor: pointer;">
                </div>
            </div>

            <div class="settings-section">
                <h4>MIP (MUD Interface Protocol)</h4>
                <div class="settings-toggle">
                    <span class="settings-toggle-label">Enable MIP</span>
                    <label class="settings-toggle-switch">
                        <input type="checkbox" id="pref-mip-enabled" ${this.preferences.mipEnabled !== false ? 'checked' : ''}>
                        <span class="settings-toggle-slider"></span>
                    </label>
                </div>
                <p class="settings-hint" id="mip-reconnect-hint" style="display:none; color: var(--warning-color);">You must reconnect for this change to take effect.</p>
                <div id="mip-sub-options" class="${this.preferences.mipEnabled !== false ? '' : 'mip-disabled'}">
                    <div class="settings-toggle">
                        <span class="settings-toggle-label">Show MIP Status Bar</span>
                        <label class="settings-toggle-switch">
                            <input type="checkbox" id="pref-mip-hpbar" ${this.preferences.mipHpBar !== false ? 'checked' : ''}>
                            <span class="settings-toggle-slider"></span>
                        </label>
                    </div>
                    <p class="settings-hint" style="margin: 5px 0 10px 0; font-size: 12px; color: #888;">Individual elements (when bar is enabled):</p>
                    <div class="settings-toggle">
                        <span class="settings-toggle-label">Show Stat Bars (HP/SP/GP)</span>
                        <label class="settings-toggle-switch">
                            <input type="checkbox" id="pref-mip-statbars" ${this.preferences.mipShowStatBars !== false ? 'checked' : ''}>
                            <span class="settings-toggle-slider"></span>
                        </label>
                    </div>
                    <div class="settings-toggle">
                        <span class="settings-toggle-label">Show Guild Data</span>
                        <label class="settings-toggle-switch">
                            <input type="checkbox" id="pref-mip-guild" ${this.preferences.mipShowGuild !== false ? 'checked' : ''}>
                            <span class="settings-toggle-slider"></span>
                        </label>
                    </div>
                    <div class="settings-toggle">
                        <span class="settings-toggle-label">Show Room Name</span>
                        <label class="settings-toggle-switch">
                            <input type="checkbox" id="pref-mip-room" ${this.preferences.mipShowRoom !== false ? 'checked' : ''}>
                            <span class="settings-toggle-slider"></span>
                        </label>
                    </div>
                    <div class="settings-toggle">
                        <span class="settings-toggle-label">Show Exits</span>
                        <label class="settings-toggle-switch">
                            <input type="checkbox" id="pref-mip-exits" ${this.preferences.mipShowExits !== false ? 'checked' : ''}>
                            <span class="settings-toggle-slider"></span>
                        </label>
                    </div>
                    <div class="settings-toggle">
                        <span class="settings-toggle-label">Debug Mode (show raw MIP data)</span>
                        <label class="settings-toggle-switch">
                            <input type="checkbox" id="pref-mip-debug" ${this.mipDebug ? 'checked' : ''}>
                            <span class="settings-toggle-slider"></span>
                        </label>
                    </div>
                    <button class="settings-btn" id="mip-reload-btn" style="margin-top: 10px;">Reload MIP</button>
                </div>
            </div>

            <div class="settings-section">
                <h4>ChatMon</h4>
                <p class="settings-hint" style="font-size: 12px; color: #888; margin-bottom: 10px;">
                    Configure sounds, visibility, and Discord webhooks for each channel.
                    Each channel can have its own Discord webhook URL.
                </p>
                <button class="settings-btn" id="channel-settings-btn">Channel Settings</button>
            </div>

            <div class="settings-section">
                <h4>Export Settings</h4>
                <div class="export-options">
                    <label class="checkbox-label"><input type="checkbox" id="export-triggers" checked> Triggers</label>
                    <label class="checkbox-label"><input type="checkbox" id="export-aliases" checked> Aliases</label>
                    <label class="checkbox-label"><input type="checkbox" id="export-highlights" checked> Highlights</label>
                    <label class="checkbox-label"><input type="checkbox" id="export-gags" checked> Gags</label>
                    <label class="checkbox-label"><input type="checkbox" id="export-prefs" checked> Preferences</label>
                </div>
                <div class="form-row" style="margin-top:10px;">
                    <button class="btn btn-secondary" id="export-btn" style="flex:1">Export Selected</button>
                    <button class="btn btn-secondary" id="export-all-btn" style="flex:1">Export All</button>
                </div>
            </div>

            <div class="settings-section">
                <h4>Import Settings</h4>
                <div class="form-row">
                    <button class="btn btn-secondary" id="import-btn" style="flex:1">Import from File</button>
                </div>
                <input type="file" id="import-file" accept=".json" style="display:none">
            </div>

            <div class="settings-section">
                <h4>Script Files</h4>
                <div id="script-files-list" class="script-files-list">
                    <em>Loading...</em>
                </div>
            </div>

            <div class="settings-support-link">
                <a href="https://buymeacoffee.com/wemudtogether" target="_blank" rel="noopener">Support this project</a>
            </div>
            </div>

            <div class="settings-sticky-footer">
                <button class="btn btn-primary" id="save-settings-btn">Save</button>
                <button class="btn btn-danger" id="close-settings-btn">Close</button>
            </div>
        `;
    }

    bindSettingsEvents() {
        // Font size preview
        document.getElementById('pref-font-size')?.addEventListener('input', (e) => {
            document.getElementById('font-size-value').textContent = e.target.value + 'px';
        });

        // MIP enabled toggle - show warning about reconnect when turning off
        document.getElementById('pref-mip-enabled')?.addEventListener('change', (e) => {
            const hint = document.getElementById('mip-reconnect-hint');
            const subOptions = document.getElementById('mip-sub-options');

            if (hint) {
                // Show reconnect hint when toggling (either direction requires reconnect to take effect)
                if (e.target.checked !== (this.preferences.mipEnabled !== false)) {
                    hint.style.display = 'block';
                } else {
                    hint.style.display = 'none';
                }
            }

            // Grey out sub-options when MIP is disabled
            if (subOptions) {
                subOptions.classList.toggle('mip-disabled', !e.target.checked);
            }

            // Update MIP-dependent UI immediately
            this.updateMipDependentUI(e.target.checked);
        });

        // MIP status bar visibility toggle - takes effect immediately
        document.getElementById('pref-mip-hpbar')?.addEventListener('change', (e) => {
            this.preferences.mipHpBar = e.target.checked;
            this.updateMipBarVisibility();
        });

        // Individual MIP element toggles
        document.getElementById('pref-mip-statbars')?.addEventListener('change', (e) => {
            this.preferences.mipShowStatBars = e.target.checked;
            this.updateMipElementVisibility();
        });

        document.getElementById('pref-mip-guild')?.addEventListener('change', (e) => {
            this.preferences.mipShowGuild = e.target.checked;
            this.updateMipElementVisibility();
        });

        document.getElementById('pref-mip-room')?.addEventListener('change', (e) => {
            this.preferences.mipShowRoom = e.target.checked;
            this.updateMipElementVisibility();
        });

        document.getElementById('pref-mip-exits')?.addEventListener('change', (e) => {
            this.preferences.mipShowExits = e.target.checked;
            this.updateMipElementVisibility();
        });

        // MIP debug toggle
        document.getElementById('pref-mip-debug')?.addEventListener('change', (e) => {
            this.toggleMipDebug(e.target.checked);
        });

        // MIP reload button
        document.getElementById('mip-reload-btn')?.addEventListener('click', () => {
            this.cmdMip(['reload']);
        });

        // Notification sound dropdown
        document.getElementById('pref-notification-sound')?.addEventListener('change', (e) => {
            this.preferences.notificationSound = e.target.value;
        });

        // Notification volume slider
        document.getElementById('pref-notification-volume')?.addEventListener('input', (e) => {
            const volume = parseInt(e.target.value);
            this.preferences.notificationVolume = volume;
            document.getElementById('volume-display').textContent = volume + '%';
        });

        // Test sound button
        document.getElementById('test-sound-btn')?.addEventListener('click', () => {
            const soundType = document.getElementById('pref-notification-sound')?.value || 'classic';
            this.playBell(soundType);
        });

        // Channel settings button
        document.getElementById('channel-settings-btn')?.addEventListener('click', () => {
            this.openChannelSettingsModal();
        });

        // Save settings
        document.getElementById('save-settings-btn')?.addEventListener('click', () => this.savePreferences());

        // Close settings
        document.getElementById('close-settings-btn')?.addEventListener('click', () => this.closePanel());

        // Export selected
        document.getElementById('export-btn')?.addEventListener('click', () => this.exportSettings(false));

        // Export all
        document.getElementById('export-all-btn')?.addEventListener('click', () => this.exportSettings(true));

        // Import
        document.getElementById('import-btn')?.addEventListener('click', () => {
            document.getElementById('import-file').click();
        });

        document.getElementById('import-file')?.addEventListener('change', (e) => {
            if (e.target.files.length) {
                this.importSettings(e.target.files[0]);
            }
        });

        // Load script files list
        this.loadScriptFilesList();
    }

    // Quick save of current preferences (used by pinch-zoom, etc.)
    // Does NOT read from DOM - just saves what's in this.preferences
    async saveCurrentPreferences() {
        try {
            await fetch('api/preferences.php?action=save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ preferences: this.preferences })
            });
        } catch (e) {
            console.error('Failed to save preferences:', e);
        }
    }

    // Full save from settings panel (reads all values from DOM)
    async savePreferences() {
        const saveBtn = document.getElementById('save-settings-btn');
        const originalText = saveBtn?.textContent;

        this.preferences = {
            fontFamily: document.getElementById('pref-font-family')?.value || this.preferences.fontFamily || 'Consolas',
            fontSize: parseInt(document.getElementById('pref-font-size')?.value) || this.preferences.fontSize || 14,
            textColor: document.getElementById('pref-text-color')?.value || this.preferences.textColor || '#00ff00',
            backgroundColor: document.getElementById('pref-bg-color')?.value || this.preferences.backgroundColor || '#000000',
            echoCommands: document.getElementById('pref-echo')?.checked ?? this.preferences.echoCommands ?? true,
            scrollOnOutput: document.getElementById('pref-scroll')?.checked ?? this.preferences.scrollOnOutput ?? true,
            scrollbackLimit: parseInt(document.getElementById('pref-scrollback')?.value) || this.preferences.scrollbackLimit || 5000,
            retainLastCommand: document.getElementById('pref-retain')?.checked ?? this.preferences.retainLastCommand ?? false,
            historySize: parseInt(document.getElementById('pref-history-size')?.value) || this.preferences.historySize || 500,
            wakeLock: document.getElementById('pref-wake-lock')?.checked ?? this.preferences.wakeLock ?? false,
            idleDisconnectMinutes: parseInt(document.getElementById('pref-idle-disconnect')?.value) || 0,
            mipEnabled: document.getElementById('pref-mip-enabled')?.checked ?? this.preferences.mipEnabled ?? true,
            mipHpBar: document.getElementById('pref-mip-hpbar')?.checked ?? this.preferences.mipHpBar ?? true,
            mipShowStatBars: document.getElementById('pref-mip-statbars')?.checked ?? this.preferences.mipShowStatBars ?? true,
            mipShowGuild: document.getElementById('pref-mip-guild')?.checked ?? this.preferences.mipShowGuild ?? true,
            mipShowRoom: document.getElementById('pref-mip-room')?.checked ?? this.preferences.mipShowRoom ?? true,
            mipShowExits: document.getElementById('pref-mip-exits')?.checked ?? this.preferences.mipShowExits ?? true,
            mipDebug: document.getElementById('pref-mip-debug')?.checked ?? this.preferences.mipDebug ?? false,
            notificationSound: document.getElementById('pref-notification-sound')?.value || this.preferences.notificationSound || 'classic',
            notificationVolume: parseInt(document.getElementById('pref-notification-volume')?.value) ?? this.preferences.notificationVolume ?? 30
        };

        try {
            await fetch('api/preferences.php?action=save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ preferences: this.preferences })
            });

            this.applyPreferences();

            // Visual feedback on button
            if (saveBtn) {
                saveBtn.textContent = 'Saved!';
                saveBtn.classList.add('saved');
                setTimeout(() => {
                    saveBtn.textContent = originalText;
                    saveBtn.classList.remove('saved');
                }, 1500);
            }
        } catch (e) {
            console.error('Failed to save preferences:', e);
            if (saveBtn) {
                saveBtn.textContent = 'Error!';
                setTimeout(() => {
                    saveBtn.textContent = originalText;
                }, 1500);
            }
        }
    }

    async exportSettings(exportAll = false) {
        const data = {
            version: 1,
            appName: 'WMT Client',
            exportDate: new Date().toISOString()
        };

        // Determine what to export
        const exportTriggers = exportAll || document.getElementById('export-triggers')?.checked;
        const exportAliases = exportAll || document.getElementById('export-aliases')?.checked;
        const exportHighlights = exportAll || document.getElementById('export-highlights')?.checked;
        const exportGags = exportAll || document.getElementById('export-gags')?.checked;
        const exportPrefs = exportAll || document.getElementById('export-prefs')?.checked;

        // Filter triggers by type
        if (exportTriggers || exportHighlights || exportGags) {
            let triggersToExport = [];

            this.triggers.forEach(t => {
                const type = this.getTriggerType(t);
                if (type === 'trigger' && exportTriggers) {
                    triggersToExport.push(t);
                } else if (type === 'highlight' && exportHighlights) {
                    triggersToExport.push(t);
                } else if (type === 'gag' && exportGags) {
                    triggersToExport.push(t);
                }
            });

            if (triggersToExport.length > 0) {
                data.triggers = triggersToExport;
            }
        }

        if (exportAliases && this.aliases.length > 0) {
            data.aliases = this.aliases;
        }

        if (exportPrefs) {
            data.preferences = this.preferences;
        }

        // Check if anything to export
        if (!data.triggers && !data.aliases && !data.preferences) {
            alert('Nothing selected to export');
            return;
        }

        // Generate filename based on what's exported
        let filenameParts = [];
        if (data.triggers) {
            const types = [...new Set(data.triggers.map(t => this.getTriggerType(t)))];
            filenameParts.push(...types);
        }
        if (data.aliases) filenameParts.push('aliases');
        if (data.preferences) filenameParts.push('prefs');

        const filename = filenameParts.length > 2
            ? 'wmt-client-settings.json'
            : `wmt-${filenameParts.join('-')}.json`;

        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();

        URL.revokeObjectURL(url);

        const exportedItems = [];
        if (data.triggers) exportedItems.push(`${data.triggers.length} triggers`);
        if (data.aliases) exportedItems.push(`${data.aliases.length} aliases`);
        if (data.preferences) exportedItems.push('preferences');
        this.appendOutput(`Exported: ${exportedItems.join(', ')}`, 'system');
    }

    // Load list of uploaded script files
    async loadScriptFilesList() {
        const container = document.getElementById('script-files-list');
        if (!container) return;

        try {
            const res = await fetch('api/scripts.php?action=list');
            const data = await res.json();

            if (!data.success || !data.scripts || data.scripts.length === 0) {
                container.innerHTML = '<em style="color:#888">No script files uploaded</em>';
                return;
            }

            let html = '';
            data.scripts.forEach(script => {
                const filename = script.name;
                const size = this.formatFileSize(script.size);
                html += `
                    <div class="script-file-item">
                        <span class="script-file-name" title="${size}">${this.escapeHtml(filename)}</span>
                        <button class="btn btn-sm" onclick="wmtClient.downloadScriptFile('${this.escapeHtml(filename)}')" title="Download">↓</button>
                        <button class="btn btn-sm btn-danger" onclick="wmtClient.deleteScriptFile('${this.escapeHtml(filename)}')" title="Delete">×</button>
                    </div>
                `;
            });

            container.innerHTML = html;
        } catch (e) {
            container.innerHTML = '<em style="color:#f66">Failed to load files</em>';
        }
    }

    // Format file size for display
    formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // Download a script file
    async downloadScriptFile(filename) {
        try {
            const res = await fetch(`api/scripts.php?action=get&filename=${encodeURIComponent(filename)}`);
            const data = await res.json();

            if (!data.success) {
                alert('Failed to download: ' + (data.error || 'Unknown error'));
                return;
            }

            const blob = new Blob([data.content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();

            URL.revokeObjectURL(url);
            this.appendOutput(`Downloaded: ${filename}`, 'system');
        } catch (e) {
            alert('Failed to download file');
        }
    }

    // Delete a script file
    async deleteScriptFile(filename) {
        if (!confirm(`Delete script file "${filename}"?`)) return;

        try {
            const res = await fetch('api/scripts.php?action=delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename })
            });
            const data = await res.json();

            if (data.success) {
                this.appendOutput(`Deleted: ${filename}`, 'system');
                this.loadScriptFilesList();
            } else {
                alert('Failed to delete: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            alert('Failed to delete file');
        }
    }

    async importSettings(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);

            if (data.appName !== 'WMT Client') {
                throw new Error('Invalid settings file');
            }

            const confirmMsg = 'Import settings? This will replace your current triggers, aliases, and preferences.';
            if (!confirm(confirmMsg)) return;

            if (data.triggers) {
                this.triggers = data.triggers;
                await this.saveTriggers();
            }

            if (data.aliases) {
                this.aliases = data.aliases;
                await this.saveAliases();
            }

            if (data.preferences) {
                this.preferences = data.preferences;
                await fetch('api/preferences.php?action=save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ preferences: this.preferences })
                });
                this.applyPreferences();
            }

            this.loadPanelContent('settings');
            this.appendOutput('Settings imported successfully.', 'system');
        } catch (e) {
            alert('Failed to import settings: ' + e.message);
        }
    }

    // ==========================================
    // Client-side # Command Processing (TinTin++ style)
    // ==========================================

    processClientCommand(input) {
        const trimmed = input.trim();

        // Parse {arg} style arguments
        const parseArgs = (str) => {
            const args = [];
            let current = '';
            let depth = 0;
            let inBrace = false;

            for (let i = 0; i < str.length; i++) {
                const char = str[i];
                if (char === '{') {
                    if (depth === 0) {
                        inBrace = true;
                    } else {
                        current += char;
                    }
                    depth++;
                } else if (char === '}') {
                    depth--;
                    if (depth === 0) {
                        args.push(current);
                        current = '';
                        inBrace = false;
                    } else {
                        current += char;
                    }
                } else if (inBrace) {
                    current += char;
                } else if (char === ' ' && !inBrace && current) {
                    args.push(current);
                    current = '';
                } else if (char !== ' ' || current) {
                    current += char;
                }
            }
            if (current) args.push(current);
            return args;
        };

        // #N command - repeat N times
        const repeatMatch = trimmed.match(/^#(\d+)\s+(.+)$/);
        if (repeatMatch) {
            const count = parseInt(repeatMatch[1]);
            const cmd = repeatMatch[2];
            this.appendOutput(`Repeating ${count} times: ${cmd}`, 'system');
            for (let i = 0; i < count; i++) {
                this.connection.sendCommand(cmd);
            }
            return;
        }

        // Extract command name and rest
        const cmdMatch = trimmed.match(/^#(\w+)\s*(.*)$/);
        if (!cmdMatch) {
            this.appendOutput('Invalid # command syntax', 'error');
            return;
        }

        const cmdName = cmdMatch[1].toLowerCase();
        const rest = cmdMatch[2];
        const args = parseArgs(rest);

        switch (cmdName) {
            // Alias commands
            case 'alias':
            case 'ali':
                this.cmdAlias(args);
                break;
            case 'unalias':
            case 'unali':
                this.cmdUnalias(args);
                break;

            // Action/Trigger commands
            case 'action':
            case 'act':
                this.cmdAction(args);
                break;
            case 'unaction':
            case 'unact':
                this.cmdUnaction(args);
                break;

            // Ticker commands
            case 'ticker':
            case 'tick':
                this.cmdTicker(args);
                break;
            case 'unticker':
            case 'untick':
                this.cmdUnticker(args);
                break;

            // Delay commands
            case 'delay':
            case 'del':
                this.cmdDelay(args);
                break;
            case 'undelay':
            case 'undel':
                this.cmdUndelay(args);
                break;

            // Info/list commands
            case 'info':
                this.cmdInfo(args);
                break;

            // Class commands
            case 'class':
            case 'cls':
                this.cmdClass(args);
                break;

            // Script file commands
            case 'read':
                this.cmdRead(args);
                break;
            case 'write':
                this.cmdWrite(args);
                break;
            case 'scripts':
            case 'script':
            case 'files':
                this.cmdScripts(args);
                break;

            // Gag command (shortcut for gag trigger)
            case 'gag':
                this.cmdGag(args);
                break;
            case 'ungag':
                this.cmdUngag(args);
                break;

            // Highlight command
            case 'highlight':
            case 'high':
                this.cmdHighlight(args);
                break;
            case 'unhighlight':
            case 'unhigh':
                this.cmdUnhighlight(args);
                break;

            // Substitute command (text replacement)
            case 'substitute':
            case 'sub':
                this.cmdSubstitute(args);
                break;
            case 'unsubstitute':
            case 'unsub':
                this.cmdUnsubstitute(args);
                break;

            // Variable commands
            case 'var':
            case 'variable':
                this.cmdVar(args);
                break;
            case 'unvar':
            case 'unvariable':
                this.cmdUnvar(args);
                break;

            // Math command
            case 'math':
                this.cmdMath(args);
                break;

            // Regexp command
            case 'regexp':
            case 'regex':
                this.cmdRegexp(args);
                break;

            // Conditional commands
            case 'if':
                this.cmdIf(args, rest);
                break;

            // Display commands
            case 'showme':
            case 'show':
                this.cmdShowme(args, rest);
                break;
            case 'echo':
                this.cmdEcho(args, rest);
                break;

            // Audio commands
            case 'bell':
                this.cmdBell();
                break;

            // Send command (raw)
            case 'send':
                this.cmdSend(args);
                break;

            // Loop command
            case 'loop':
                this.cmdLoop(args, rest);
                break;

            // Foreach command
            case 'foreach':
                this.cmdForeach(args, rest);
                break;

            // List command
            case 'list':
                this.cmdList(args, rest);
                break;

            // Loop control commands
            case 'break':
                this.loopBreak = true;
                break;
            case 'continue':
                this.loopContinue = true;
                break;

            // Prompt command (capture to status bar)
            case 'prompt':
                this.cmdPrompt(args);
                break;
            case 'unprompt':
                this.cmdUnprompt(args);
                break;

            // Pathdir command (for speedwalk)
            case 'pathdir':
                this.cmdPathdir(args);
                break;
            case 'unpathdir':
                this.cmdUnpathdir(args);
                break;

            // Config command
            case 'config':
                this.cmdConfig(args);
                break;

            // Format command
            case 'format':
                this.cmdFormat(args);
                break;

            // Replace command
            case 'replace':
                this.cmdReplace(args);
                break;

            // Split screen commands
            case 'split':
                this.cmdSplit(args);
                break;
            case 'unsplit':
                this.cmdUnsplit();
                break;

            // No operation (comment)
            case 'nop':
                // Do nothing - it's a comment
                break;

            // MIP control
            case 'mip':
                this.cmdMip(args);
                break;

            // Help
            case 'help':
                this.cmdHelp();
                break;

            // Function commands (TinTin++ style)
            case 'function':
            case 'func':
                this.cmdFunction(args);
                break;
            case 'unfunction':
            case 'unfunc':
                this.cmdUnfunction(args);
                break;
            case 'return':
                this.cmdReturn(args, rest);
                break;

            // Local variable commands
            case 'local':
                this.cmdLocal(args);
                break;
            case 'unlocal':
                this.cmdUnlocal(args);
                break;

            // Switch/case commands
            case 'switch':
                this.cmdSwitch(args, rest);
                break;

            // Event commands
            case 'event':
                this.cmdEvent(args);
                break;
            case 'unevent':
                this.cmdUnevent(args);
                break;

            default:
                this.appendOutput(`Unknown command: #${cmdName}`, 'error');
        }
    }

    // #alias {pattern} {replacement}
    // Supports: #alias {name} {command} or #alias name command with multiple words
    cmdAlias(args) {
        if (args.length < 2) {
            // List aliases
            if (this.aliases.length === 0) {
                this.appendOutput('No aliases defined.', 'system');
            } else {
                this.appendOutput('Aliases:', 'system');
                this.aliases.forEach(a => {
                    const status = a.enabled === false ? ' [disabled]' : '';
                    this.appendOutput(`  ${a.pattern} = ${a.replacement}${status}`, 'system');
                });
            }
            return;
        }

        const pattern = args[0];
        // Join all remaining args as the replacement (allows "alias test say hello" without braces)
        const replacement = args.slice(1).join(' ');

        // Check if alias already exists
        const existing = this.aliases.findIndex(a => a.pattern.toLowerCase() === pattern.toLowerCase());
        if (existing >= 0) {
            this.aliases[existing].replacement = replacement;
            this.appendOutput(`Alias updated: ${pattern} = ${replacement}`, 'system');
        } else {
            this.aliases.push({
                id: this.generateId(),
                pattern: pattern,
                matchType: 'exact',
                replacement: replacement,
                enabled: true,
                class: this.currentScriptClass || null
            });
            this.appendOutput(`Alias created: ${pattern} = ${replacement}`, 'system');
        }

        this.saveAliases();
    }

    // #unalias {pattern}
    cmdUnalias(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #unalias {pattern}', 'error');
            return;
        }

        const pattern = args[0];
        const index = this.aliases.findIndex(a => a.pattern.toLowerCase() === pattern.toLowerCase());
        if (index >= 0) {
            this.aliases.splice(index, 1);
            this.appendOutput(`Alias removed: ${pattern}`, 'system');
            this.saveAliases();
        } else {
            this.appendOutput(`Alias not found: ${pattern}`, 'error');
        }
    }

    // #action {pattern} {command}
    cmdAction(args) {
        if (args.length < 2) {
            // List only triggers that have command actions (not gags/highlights/substitutes)
            const actions = this.triggers.filter(t => t.actions?.some(a => a.type === 'command'));
            if (actions.length === 0) {
                this.appendOutput('No actions defined.', 'system');
            } else {
                this.appendOutput('Actions:', 'system');
                actions.forEach(t => {
                    const status = t.enabled === false ? ' [disabled]' : '';
                    const cmds = t.actions?.filter(a => a.type === 'command').map(a => a.command).join('; ') || '';
                    this.appendOutput(`  ${t.pattern} = ${cmds}${status}`, 'system');
                });
            }
            return;
        }

        const pattern = args[0];
        const command = args[1];

        // Store pattern and command as-is using TinTin++ matchType
        // The server will handle the TinTin++ pattern matching with %1, %*, etc.

        // Check if trigger already exists with same pattern
        const existing = this.triggers.findIndex(t => t.pattern === pattern);
        if (existing >= 0) {
            this.triggers[existing].actions = [{ type: 'command', command: command }];
            this.triggers[existing].matchType = 'tintin';
            this.appendOutput(`Action updated: ${pattern}`, 'system');
        } else {
            this.triggers.push({
                id: this.generateId(),
                name: pattern.substring(0, 30),
                pattern: pattern,
                matchType: 'tintin',
                actions: [{ type: 'command', command: command }],
                enabled: true,
                class: this.currentScriptClass || null
            });
            this.appendOutput(`Action created: ${pattern} → ${command}`, 'system');
        }

        this.saveTriggers();
    }

    // #unaction {pattern}
    cmdUnaction(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #unaction {pattern}', 'error');
            return;
        }

        const pattern = args[0];
        // Find trigger by exact pattern match
        const index = this.triggers.findIndex(t => t.pattern === pattern);
        if (index >= 0) {
            this.triggers.splice(index, 1);
            this.appendOutput(`Action removed: ${pattern}`, 'system');
            this.saveTriggers();
        } else {
            this.appendOutput(`Action not found: ${pattern}`, 'error');
        }
    }

    // #ticker {name} {command} {interval}
    // #ticker {name} {command} {interval} - Create/update a ticker (server-side, persistent)
    cmdTicker(args) {
        if (args.length < 3) {
            // List tickers
            if (this.tickers.length === 0) {
                this.appendOutput('No tickers configured.', 'system');
            } else {
                this.appendOutput('Tickers:', 'system');
                this.tickers.forEach(t => {
                    const status = t.enabled ? 'ON' : 'OFF';
                    const classInfo = t.class ? ` [${t.class}]` : '';
                    this.appendOutput(`  ${t.name}: ${t.command} (every ${t.interval}s) [${status}]${classInfo}`, 'system');
                });
            }
            return;
        }

        const name = args[0];
        const command = args[1];
        const interval = parseFloat(args[2]);

        if (isNaN(interval) || interval < 1) {
            this.appendOutput('Interval must be at least 1 second', 'error');
            return;
        }

        // Check if ticker with this name exists
        const existing = this.tickers.find(t => t.name.toLowerCase() === name.toLowerCase());
        if (existing) {
            // Update existing
            existing.command = command;
            existing.interval = interval;
            existing.enabled = true;
            this.appendOutput(`Ticker updated: ${name} (${command} every ${interval}s)`, 'system');
        } else {
            // Create new
            const ticker = {
                id: 'ticker_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                name: name,
                command: command,
                interval: interval,
                enabled: true,
                class: null
            };
            this.tickers.push(ticker);
            this.appendOutput(`Ticker created: ${name} (${command} every ${interval}s)`, 'system');
        }

        this.saveTickers();
    }

    // #unticker {name} - Disable/delete a ticker
    cmdUnticker(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #unticker {name}', 'error');
            return;
        }

        const name = args[0];
        const ticker = this.tickers.find(t => t.name.toLowerCase() === name.toLowerCase());

        if (ticker) {
            // Toggle enabled off (or delete if you prefer)
            ticker.enabled = false;
            this.appendOutput(`Ticker disabled: ${name}`, 'system');
            this.saveTickers();
        } else {
            this.appendOutput(`Ticker not found: ${name}`, 'error');
        }
    }

    // #delay {seconds} {command} OR #delay {name} {command} {seconds}
    cmdDelay(args) {
        if (args.length < 2) {
            // List delays
            const names = Object.keys(this.delays);
            if (names.length === 0) {
                this.appendOutput('No delays pending.', 'system');
            } else {
                this.appendOutput('Pending delays:', 'system');
                names.forEach(name => {
                    const d = this.delays[name];
                    this.appendOutput(`  ${name}: ${d.command}`, 'system');
                });
            }
            return;
        }

        let name, command, seconds;

        if (args.length === 2) {
            // #delay {seconds} {command}
            seconds = parseFloat(args[0]);
            command = args[1];
            name = 'delay_' + (++this.delayCounter);
        } else {
            // #delay {name} {command} {seconds}
            name = args[0];
            command = args[1];
            seconds = parseFloat(args[2]);
        }

        if (isNaN(seconds) || seconds < 0.01) {
            this.appendOutput('Delay must be at least 0.01 seconds', 'error');
            return;
        }

        // Cancel existing delay with same name
        if (this.delays[name]) {
            clearTimeout(this.delays[name].timerId);
        }

        const timerId = setTimeout(() => {
            // Split command by semicolons/newlines (respecting brace depth) and execute each
            const commands = this.parseCommands(command);
            commands.forEach(cmd => {
                if (cmd.startsWith('#')) {
                    this.processClientCommand(cmd);
                } else {
                    this.connection.sendCommand(cmd);
                }
            });
            delete this.delays[name];
        }, seconds * 1000);

        this.delays[name] = { command, timerId };
        // No confirmation message - silent operation like TinTin++
    }

    // #undelay {name}
    cmdUndelay(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #undelay {name}', 'error');
            return;
        }

        const name = args[0];
        if (this.delays[name]) {
            clearTimeout(this.delays[name].timerId);
            delete this.delays[name];
            this.appendOutput(`Delay cancelled: ${name}`, 'system');
        } else {
            this.appendOutput(`Delay not found: ${name}`, 'error');
        }
    }

    // #class {name} [open|close|kill|read]
    async cmdClass(args) {
        if (args.length === 0) {
            // List all classes
            if (this.classes.length === 0) {
                this.appendOutput('No classes defined.', 'system');
            } else {
                this.appendOutput('Classes:', 'system');
                this.classes.forEach(cls => {
                    const status = cls.enabled === false ? ' [disabled]' : ' [enabled]';
                    const triggers = this.triggers.filter(t => t.class === cls.id).length;
                    const aliases = this.aliases.filter(a => a.class === cls.id).length;
                    this.appendOutput(`  ${cls.name}${status} (${triggers} triggers, ${aliases} aliases)`, 'system');
                });
            }
            return;
        }

        const className = args[0];
        const action = args[1]?.toLowerCase();

        // Find existing class
        const existingIndex = this.classes.findIndex(c => c.name.toLowerCase() === className.toLowerCase());
        const existing = existingIndex >= 0 ? this.classes[existingIndex] : null;

        if (!action) {
            // Just class name - create if doesn't exist, or show info
            if (existing) {
                const triggers = this.triggers.filter(t => t.class === existing.id).length;
                const aliases = this.aliases.filter(a => a.class === existing.id).length;
                const status = existing.enabled === false ? 'disabled' : 'enabled';
                this.appendOutput(`Class "${className}": ${status}, ${triggers} triggers, ${aliases} aliases`, 'system');
            } else {
                // Create new class
                await this.createClass(className);
            }
            return;
        }

        switch (action) {
            case 'open':
                // TinTin++ style: open class for adding items
                // Create if doesn't exist, then set as current for script loading
                if (!existing) {
                    await this.createClass(className);
                    // Find the newly created class
                    const newCls = this.classes.find(c => c.name.toLowerCase() === className.toLowerCase());
                    if (newCls) {
                        this.currentScriptClass = newCls.id;
                    }
                } else {
                    this.currentScriptClass = existing.id;
                    // Also enable the class
                    if (existing.enabled === false) {
                        await this.setClassEnabled(existing.id, true);
                    }
                }
                this.appendOutput(`Class opened: ${className}`, 'system');
                break;

            case 'close':
                // TinTin++ style: close class (stop adding items to it)
                this.currentScriptClass = null;
                this.appendOutput(`Class closed: ${className}`, 'system');
                break;

            case 'enable':
            case 'on':
                if (!existing) {
                    this.appendOutput(`Class not found: ${className}`, 'error');
                    return;
                }
                await this.setClassEnabled(existing.id, true);
                this.appendOutput(`Class enabled: ${className}`, 'system');
                break;

            case 'disable':
            case 'off':
                if (!existing) {
                    this.appendOutput(`Class not found: ${className}`, 'error');
                    return;
                }
                await this.setClassEnabled(existing.id, false);
                this.appendOutput(`Class disabled: ${className}`, 'system');
                break;

            case 'kill':
            case 'delete':
            case 'remove':
                if (!existing) {
                    this.appendOutput(`Class not found: ${className}`, 'error');
                    return;
                }
                await this.deleteClass(existing.id, false); // Don't delete items, just unassign
                this.appendOutput(`Class deleted: ${className}`, 'system');
                break;

            case 'read':
            case 'list':
            case 'show':
                if (!existing) {
                    this.appendOutput(`Class not found: ${className}`, 'error');
                    return;
                }
                this.appendOutput(`Class "${className}" contents:`, 'system');
                const classTriggers = this.triggers.filter(t => t.class === existing.id);
                const classAliases = this.aliases.filter(a => a.class === existing.id);
                if (classTriggers.length === 0 && classAliases.length === 0) {
                    this.appendOutput('  (empty)', 'system');
                } else {
                    classTriggers.forEach(t => {
                        this.appendOutput(`  [trigger] ${t.pattern}`, 'system');
                    });
                    classAliases.forEach(a => {
                        this.appendOutput(`  [alias] ${a.pattern} = ${a.replacement}`, 'system');
                    });
                }
                break;

            default:
                this.appendOutput(`Unknown class action: ${action}`, 'error');
                this.appendOutput('Valid actions: open, close, kill, read', 'system');
        }
    }

    // Create a new class
    async createClass(name) {
        try {
            const res = await fetch('api/classes.php?action=create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const data = await res.json();
            if (data.success) {
                this.classes.push(data.class);
                this.appendOutput(`Class created: ${name}`, 'system');
                this.renderScriptsSidebar();
            } else {
                this.appendOutput(`Failed to create class: ${data.error}`, 'error');
            }
        } catch (e) {
            this.appendOutput('Failed to create class', 'error');
        }
    }

    // Enable/disable a class
    async setClassEnabled(classId, enabled) {
        try {
            const res = await fetch('api/classes.php?action=update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ class_id: classId, enabled })
            });
            const data = await res.json();
            if (data.success) {
                const cls = this.classes.find(c => c.id === classId);
                if (cls) {
                    cls.enabled = enabled;
                    // Fire class activation/deactivation event
                    this.fireEvent(enabled ? 'CLASS_ACTIVATED' : 'CLASS_DEACTIVATED', cls.name);
                }
                // Re-send filtered triggers/aliases to server
                this.sendFilteredTriggersAndAliases();
                // Refresh panels if open
                if (this.currentPanel === 'triggers') this.loadPanelContent('triggers');
                if (this.currentPanel === 'aliases') this.loadPanelContent('aliases');
                // Refresh scripts sidebar if open
                if (document.getElementById('scripts-sidebar')?.classList.contains('open')) {
                    this.renderScriptsSidebar();
                }
            }
        } catch (e) {
            this.appendOutput('Failed to update class', 'error');
        }
    }

    // Delete a class
    async deleteClass(classId, deleteItems = false) {
        try {
            const res = await fetch('api/classes.php?action=delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ class_id: classId, delete_items: deleteItems })
            });
            const data = await res.json();
            if (data.success) {
                // Remove from local array
                this.classes = this.classes.filter(c => c.id !== classId);
                // Update local triggers/aliases to remove class reference
                if (!deleteItems) {
                    this.triggers.forEach(t => {
                        if (t.class === classId) t.class = null;
                    });
                    this.aliases.forEach(a => {
                        if (a.class === classId) a.class = null;
                    });
                } else {
                    // Remove items with this class
                    this.triggers = this.triggers.filter(t => t.class !== classId);
                    this.aliases = this.aliases.filter(a => a.class !== classId);
                }
                // Re-send to server
                this.sendFilteredTriggersAndAliases();
                // Refresh panels if open
                if (this.currentPanel === 'triggers') this.loadPanelContent('triggers');
                if (this.currentPanel === 'aliases') this.loadPanelContent('aliases');
                // Refresh scripts sidebar if open
                if (document.getElementById('scripts-sidebar')?.classList.contains('open')) {
                    this.renderScriptsSidebar();
                }
            }
        } catch (e) {
            this.appendOutput('Failed to delete class', 'error');
        }
    }

    // #info - show current state
    cmdInfo(args) {
        const type = args[0]?.toLowerCase() || 'all';

        if (type === 'all' || type === 'aliases') {
            this.appendOutput(`Aliases: ${this.aliases.length}`, 'system');
        }
        if (type === 'all' || type === 'triggers' || type === 'actions') {
            this.appendOutput(`Triggers/Actions: ${this.triggers.length}`, 'system');
        }
        if (type === 'all' || type === 'classes') {
            const enabled = this.classes.filter(c => c.enabled !== false).length;
            this.appendOutput(`Classes: ${this.classes.length} (${enabled} enabled)`, 'system');
        }
        if (type === 'all' || type === 'tickers') {
            this.appendOutput(`Tickers: ${Object.keys(this.tickers).length}`, 'system');
        }
        if (type === 'all' || type === 'delays') {
            this.appendOutput(`Delays: ${Object.keys(this.delays).length}`, 'system');
        }
    }

    // #help - show available commands
    cmdHelp() {
        this.appendOutput('Available # commands:', 'system');
        this.appendOutput('  #N command          - Repeat command N times', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Aliases & Triggers:', 'system');
        this.appendOutput('  #alias {name} {cmd} - Create alias', 'system');
        this.appendOutput('  #unalias {name}     - Remove alias', 'system');
        this.appendOutput('  #action {pat} {cmd} - Create trigger (TinTin++ patterns)', 'system');
        this.appendOutput('  #unaction {pattern} - Remove trigger', 'system');
        this.appendOutput('  #gag {pattern}      - Gag lines matching pattern', 'system');
        this.appendOutput('  #ungag {pattern}    - Remove gag', 'system');
        this.appendOutput('  #highlight {pat} {color} - Highlight matching lines', 'system');
        this.appendOutput('  #unhighlight {pat}  - Remove highlight', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Variables & Math:', 'system');
        this.appendOutput('  #var {name} {value} - Set variable ($name to use)', 'system');
        this.appendOutput('  #var {n[key]} {val} - Set nested: $n[key], $n[k][k2]', 'system');
        this.appendOutput('  #unvar {name}       - Remove variable', 'system');
        this.appendOutput('  #math {var} {expr}  - Calculate and store result', 'system');
        this.appendOutput('  #format {var} {fmt} - Format string (like printf)', 'system');
        this.appendOutput('  #replace {var} {old} {new} - Replace text in variable', 'system');
        this.appendOutput('  (Use &var[] for size, $var[+1]/-1 for first/last)', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Control Flow:', 'system');
        this.appendOutput('  #if {cond} {cmds}   - Conditional execution', 'system');
        this.appendOutput('  #loop {s} {e} {v} {cmds} - Loop from start to end', 'system');
        this.appendOutput('  #foreach {list} {v} {cmds} - Iterate over list', 'system');
        this.appendOutput('  #break              - Exit current loop', 'system');
        this.appendOutput('  #continue           - Skip to next iteration', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Lists:', 'system');
        this.appendOutput('  #list {var} add {items} - Add items to list', 'system');
        this.appendOutput('  #list {var} create {items} - Create new list', 'system');
        this.appendOutput('  #list {var} get {idx} {result} - Get item', 'system');
        this.appendOutput('  #list {var} size {result} - Get list size', 'system');
        this.appendOutput('  #list {var} delete {idx} - Delete item', 'system');
        this.appendOutput('  #list {var} find {item} {result} - Find item index', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Display & Sound:', 'system');
        this.appendOutput('  #showme {msg} [row] - Display message (or in split row)', 'system');
        this.appendOutput('  #echo {msg}         - Same as #showme', 'system');
        this.appendOutput('  #bell               - Play alert sound', 'system');
        this.appendOutput('  #send {text}        - Send raw text to MUD', 'system');
        this.appendOutput('  #split {top} [bot]  - Create split status areas', 'system');
        this.appendOutput('  #unsplit            - Remove split screen', 'system');
        this.appendOutput('  #mip [reload|on|off] - Reload/enable/disable MIP', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Timing:', 'system');
        this.appendOutput('  #ticker {name} {cmd} {secs} - Repeat every N seconds', 'system');
        this.appendOutput('  #unticker {name}    - Stop ticker', 'system');
        this.appendOutput('  #delay {secs} {cmd} - Execute after N seconds', 'system');
        this.appendOutput('  #undelay {name}     - Cancel named delay', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Classes & Scripts:', 'system');
        this.appendOutput('  #class              - List all classes', 'system');
        this.appendOutput('  #class {name}       - Create class or show info', 'system');
        this.appendOutput('  #class {name} open  - Enable a class', 'system');
        this.appendOutput('  #class {name} close - Disable a class', 'system');
        this.appendOutput('  #class {name} kill  - Delete a class', 'system');
        this.appendOutput('  #class {name} read  - List items in a class', 'system');
        this.appendOutput('  #read {filename}    - Load and execute script file', 'system');
        this.appendOutput('  #write {file} {cls} - Save class to script file', 'system');
        this.appendOutput('  #scripts            - List available script files', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Speedwalk & Config:', 'system');
        this.appendOutput('  #config {opt} {val} - Set config (e.g., SPEEDWALK ON)', 'system');
        this.appendOutput('  #pathdir {d} {r} {c} - Define direction mapping', 'system');
        this.appendOutput('  #unpathdir {dir}    - Remove direction mapping', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Prompts:', 'system');
        this.appendOutput('  #prompt {pat} {txt} [row] - Capture to status bar', 'system');
        this.appendOutput('  #unprompt {pattern} - Remove prompt', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Other:', 'system');
        this.appendOutput('  #info [type]        - Show counts', 'system');
        this.appendOutput('  #nop {comment}      - Comment (ignored)', 'system');
        this.appendOutput('  #help               - Show this help', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Functions:', 'system');
        this.appendOutput('  #function {name} {body} - Define function (call with @name{})', 'system');
        this.appendOutput('  #unfunction {name}  - Remove function', 'system');
        this.appendOutput('  #return {value}     - Return value from function', 'system');
        this.appendOutput('  #local {var} {val}  - Set local variable (scoped)', 'system');
        this.appendOutput('  #unlocal {var}      - Remove local variable', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Switch/Case:', 'system');
        this.appendOutput('  #switch {val} {#case {v1} {cmd};#default {cmd}}', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Events:', 'system');
        this.appendOutput('  #event {name} {cmd} - Hook into event', 'system');
        this.appendOutput('  #unevent {name}     - Remove event handler', 'system');
        this.appendOutput('  Events: SESSION_CONNECTED, SESSION_DISCONNECTED,', 'system');
        this.appendOutput('          VARIABLE_UPDATE, CLASS_ACTIVATED, CLASS_DEACTIVATED', 'system');
    }

    // ==========================================
    // Function Commands (#function, #return, @name{})
    // ==========================================

    // #function {name} {body}
    // Creates a function that can be called with @name{args}
    cmdFunction(args) {
        if (args.length === 0) {
            // List all functions
            const names = Object.keys(this.functions);
            if (names.length === 0) {
                this.appendOutput('No functions defined.', 'system');
            } else {
                this.appendOutput('Functions:', 'system');
                names.forEach(name => {
                    this.appendOutput(`  @${name}{} = ${this.functions[name].body}`, 'system');
                });
            }
            return;
        }

        if (args.length < 2) {
            this.appendOutput('Usage: #function {name} {body}', 'error');
            return;
        }

        const name = args[0].toLowerCase();
        const body = args[1];

        this.functions[name] = { body };
        this.appendOutput(`Function @${name}{} defined.`, 'system');
    }

    // #unfunction {name}
    cmdUnfunction(args) {
        if (args.length === 0) {
            this.appendOutput('Usage: #unfunction {name}', 'error');
            return;
        }

        const name = args[0].toLowerCase();
        if (this.functions[name]) {
            delete this.functions[name];
            this.appendOutput(`Function @${name}{} removed.`, 'system');
        } else {
            this.appendOutput(`Function @${name}{} not found.`, 'error');
        }
    }

    // #return {value}
    // Sets the result for the current function call
    cmdReturn(args, rest) {
        // The return value is stored in a special variable that the function caller reads
        const value = args.length > 0 ? this.substituteVariables(args[0]) : '';
        this.setVariable('result', value);
    }

    // Call a function by name with arguments
    // Returns the result (from #return or $result variable)
    callFunction(name, argString) {
        const func = this.functions[name.toLowerCase()];
        if (!func) {
            return `@${name}{${argString}}`; // Return unchanged if function not found
        }

        // Push a new local scope
        this.localScopes.push({});

        // Parse arguments (semicolon-separated)
        const funcArgs = argString ? argString.split(';').map(a => a.trim()) : [];

        // Set %0 through %99 for arguments
        this.setLocalVariable('%0', argString || '');
        funcArgs.forEach((arg, i) => {
            this.setLocalVariable(`%${i + 1}`, arg);
        });

        // Clear result
        this.setLocalVariable('result', '');

        // Execute the function body
        this.executeCommandString(func.body);

        // Get the result
        const result = this.getVariable('result') || '';

        // Pop the local scope
        this.localScopes.pop();

        return result;
    }

    // ==========================================
    // Local Variable Commands (#local, #unlocal)
    // ==========================================

    // #local {name} {value}
    cmdLocal(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #local {name} {value}', 'error');
            return;
        }

        const name = args[0];
        const value = args.length > 1 ? this.substituteVariables(args[1]) : '';

        this.setLocalVariable(name, value);
    }

    // #unlocal {name}
    cmdUnlocal(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #unlocal {name}', 'error');
            return;
        }

        const name = args[0];
        // Remove from current scope if exists
        if (this.localScopes.length > 0) {
            delete this.localScopes[this.localScopes.length - 1][name];
        }
    }

    // Set a local variable in the current scope
    setLocalVariable(name, value) {
        if (this.localScopes.length === 0) {
            // No local scope, use global
            this.setVariable(name, value);
            return;
        }
        this.localScopes[this.localScopes.length - 1][name] = value;
    }

    // Get a variable, checking local scopes first (innermost to outermost), then global
    getVariableWithScope(name) {
        // Check local scopes from innermost to outermost
        for (let i = this.localScopes.length - 1; i >= 0; i--) {
            if (name in this.localScopes[i]) {
                return this.localScopes[i][name];
            }
        }
        // Fall back to global
        return this.getVariable(name);
    }

    // ==========================================
    // Switch/Case Commands (#switch, #case, #default)
    // ==========================================

    // #switch {value} {#case {v1} {cmd1};#case {v2} {cmd2};#default {cmd}}
    cmdSwitch(args, rest) {
        if (args.length < 2) {
            this.appendOutput('Usage: #switch {value} {cases}', 'error');
            return;
        }

        const switchValue = this.substituteVariables(args[0]);
        const casesBlock = args[1];

        // Parse the cases block to find #case and #default
        // Format: #case {value} {commands};#case {value2} {commands2};#default {commands}
        const caseRegex = /#(case|default)\s*(?:\{([^}]*)\})?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gi;
        let match;
        let matched = false;
        let defaultCmd = null;

        while ((match = caseRegex.exec(casesBlock)) !== null) {
            const type = match[1].toLowerCase();
            const caseValue = match[2];
            const commands = match[3];

            if (type === 'default') {
                defaultCmd = commands;
            } else if (type === 'case' && !matched) {
                // Check if this case matches
                const expandedCaseValue = this.substituteVariables(caseValue);
                if (switchValue === expandedCaseValue) {
                    this.executeCommandString(commands);
                    matched = true;
                }
            }
        }

        // Execute default if no case matched
        if (!matched && defaultCmd) {
            this.executeCommandString(defaultCmd);
        }
    }

    // ==========================================
    // Event Commands (#event, #unevent)
    // ==========================================

    // Supported events:
    // SESSION_CONNECTED - when WebSocket connects
    // SESSION_DISCONNECTED - when WebSocket disconnects
    // SESSION_RESUMED - when session is resumed after reconnect
    // VARIABLE_UPDATE {varname} - when a variable is changed
    // CLASS_ACTIVATED {classname} - when a class is enabled
    // CLASS_DEACTIVATED {classname} - when a class is disabled

    // #event {name} {commands}
    cmdEvent(args) {
        if (args.length === 0) {
            // List all events
            const eventNames = Object.keys(this.eventHandlers);
            if (eventNames.length === 0) {
                this.appendOutput('No event handlers defined.', 'system');
            } else {
                this.appendOutput('Event handlers:', 'system');
                eventNames.forEach(name => {
                    const handlers = this.eventHandlers[name];
                    handlers.forEach(h => {
                        this.appendOutput(`  ${name} = ${h.body}`, 'system');
                    });
                });
            }
            return;
        }

        if (args.length < 2) {
            this.appendOutput('Usage: #event {name} {commands}', 'error');
            return;
        }

        const eventName = args[0].toUpperCase();
        const body = args[1];

        if (!this.eventHandlers[eventName]) {
            this.eventHandlers[eventName] = [];
        }
        this.eventHandlers[eventName].push({ body });
        this.appendOutput(`Event handler for ${eventName} added.`, 'system');
    }

    // #unevent {name}
    cmdUnevent(args) {
        if (args.length === 0) {
            this.appendOutput('Usage: #unevent {name}', 'error');
            return;
        }

        const eventName = args[0].toUpperCase();
        if (this.eventHandlers[eventName]) {
            delete this.eventHandlers[eventName];
            this.appendOutput(`Event handlers for ${eventName} removed.`, 'system');
        } else {
            this.appendOutput(`No event handlers for ${eventName}.`, 'error');
        }
    }

    // Fire an event - executes all handlers for that event
    fireEvent(eventName, eventArg = '') {
        const handlers = this.eventHandlers[eventName.toUpperCase()];
        if (!handlers || handlers.length === 0) return;

        // Push a local scope for event arguments
        this.localScopes.push({});
        if (eventArg) {
            this.setLocalVariable('%0', eventArg);
            this.setLocalVariable('%1', eventArg);
        }

        handlers.forEach(handler => {
            try {
                this.executeCommandString(handler.body);
            } catch (e) {
                console.error(`Error in event handler for ${eventName}:`, e);
            }
        });

        this.localScopes.pop();
    }

    // #read {filename} - Load and execute TinTin++ script file
    async cmdRead(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #read {filename}', 'error');
            return;
        }

        let filename = args[0];
        // Add extension if not present
        if (!filename.match(/\.(txt|tin)$/i)) {
            filename += '.tin';
        }

        this.appendOutput(`Reading script: ${filename}...`, 'system');

        try {
            const res = await fetch(`api/scripts.php?action=get&filename=${encodeURIComponent(filename)}`);
            const data = await res.json();

            if (!data.success) {
                this.appendOutput(`Failed to read script: ${data.error}`, 'error');
                return;
            }

            // Parse and execute the script
            const lines = data.content.split('\n');
            let lineCount = 0;
            let errorCount = 0;

            for (const line of lines) {
                const trimmed = line.trim();
                // Skip empty lines and comments
                if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('//')) {
                    continue;
                }

                // Execute the line as a command
                if (trimmed.startsWith('#')) {
                    try {
                        await this.executeTinTinLine(trimmed);
                        lineCount++;
                    } catch (e) {
                        errorCount++;
                        console.error('Script line error:', trimmed, e);
                    }
                }
            }

            this.appendOutput(`Script loaded: ${lineCount} commands executed${errorCount ? `, ${errorCount} errors` : ''}`, 'system');

            // Refresh sidebar if open
            if (document.getElementById('scripts-sidebar')?.classList.contains('open')) {
                this.renderScriptsSidebar();
            }
        } catch (e) {
            this.appendOutput('Failed to read script file', 'error');
            console.error(e);
        }
    }

    // Execute a single TinTin++ format line
    async executeTinTinLine(line) {
        // Parse TinTin++ style: #command {arg1} {arg2} {arg3}
        const parsed = this.parseTinTinCommand(line);
        if (!parsed) return;

        const { command, args } = parsed;

        // Route to appropriate handler
        switch (command.toLowerCase()) {
            case 'alias':
                this.cmdAlias(args);
                break;
            case 'unalias':
                this.cmdUnalias(args);
                break;
            case 'action':
                this.cmdAction(args);
                break;
            case 'unaction':
                this.cmdUnaction(args);
                break;
            case 'class':
                await this.cmdClass(args);
                break;
            case 'gag':
                this.cmdGag(args);
                break;
            case 'ungag':
                this.cmdUngag(args);
                break;
            case 'highlight':
            case 'high':
                this.cmdHighlight(args);
                break;
            case 'unhighlight':
            case 'unhigh':
                this.cmdUnhighlight(args);
                break;
            case 'substitute':
            case 'sub':
                this.cmdSubstitute(args);
                break;
            case 'unsubstitute':
            case 'unsub':
                this.cmdUnsubstitute(args);
                break;
            case 'regexp':
            case 'regex':
                this.cmdRegexp(args);
                break;
            case 'var':
            case 'variable':
                this.cmdVar(args);
                break;
            case 'unvar':
            case 'unvariable':
                this.cmdUnvar(args);
                break;
            case 'math':
                this.cmdMath(args);
                break;
            case 'if':
                this.cmdIf(args);
                break;
            case 'showme':
            case 'show':
                this.cmdShowme(args);
                break;
            case 'ticker':
            case 'tick':
                this.cmdTicker(args);
                break;
            case 'unticker':
            case 'untick':
                this.cmdUnticker(args);
                break;
            case 'delay':
                this.cmdDelay(args);
                break;
            case 'undelay':
                this.cmdUndelay(args);
                break;
            case 'read':
                await this.cmdRead(args);
                break;
            case 'send':
                this.cmdSend(args);
                break;
            case 'nop':
                // Comment - do nothing
                break;
            default:
                // Unknown command - ignore in scripts
                break;
        }
    }

    // Parse TinTin++ command format: #command {arg1} {arg2}
    parseTinTinCommand(line) {
        line = line.trim();
        if (!line.startsWith('#')) return null;

        // Remove the #
        line = line.substring(1);

        // Get command name (everything until first space or brace)
        const cmdMatch = line.match(/^(\w+)\s*/);
        if (!cmdMatch) return null;

        const command = cmdMatch[1];
        let rest = line.substring(cmdMatch[0].length);

        // Parse {arg} style arguments
        const args = [];
        while (rest.length > 0) {
            rest = rest.trim();
            if (rest.startsWith('{')) {
                // Find matching closing brace
                let depth = 0;
                let end = -1;
                for (let i = 0; i < rest.length; i++) {
                    if (rest[i] === '{') depth++;
                    else if (rest[i] === '}') {
                        depth--;
                        if (depth === 0) {
                            end = i;
                            break;
                        }
                    }
                }
                if (end === -1) {
                    // Unclosed brace - take rest as argument
                    args.push(rest.substring(1));
                    break;
                }
                args.push(rest.substring(1, end));
                rest = rest.substring(end + 1);
            } else if (rest.length > 0) {
                // Non-brace argument (space-separated)
                const spaceIdx = rest.indexOf(' ');
                if (spaceIdx === -1) {
                    args.push(rest);
                    break;
                } else {
                    args.push(rest.substring(0, spaceIdx));
                    rest = rest.substring(spaceIdx + 1);
                }
            }
        }

        return { command, args };
    }

    // #write {filename} {classname} - Save class to TinTin++ format script
    async cmdWrite(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #write {filename} [classname]', 'error');
            return;
        }

        let filename = args[0];
        const className = args[1] || null;

        // Add extension if not present
        if (!filename.match(/\.(txt|tin)$/i)) {
            filename += '.tin';
        }

        let content = '';
        content += `#nop {Script exported from WMT Client}\n`;
        content += `#nop {Date: ${new Date().toISOString()}}\n\n`;

        if (className) {
            // Export specific class
            const cls = this.classes.find(c => c.name.toLowerCase() === className.toLowerCase());
            if (!cls) {
                this.appendOutput(`Class not found: ${className}`, 'error');
                return;
            }

            content += this.exportClassToTinTin(cls);
        } else {
            // Export all classes and unassigned items
            for (const cls of this.classes) {
                content += this.exportClassToTinTin(cls);
                content += '\n';
            }

            // Export unassigned items
            const unassignedTriggers = this.triggers.filter(t => !t.class);
            const unassignedAliases = this.aliases.filter(a => !a.class);

            if (unassignedTriggers.length > 0 || unassignedAliases.length > 0) {
                content += `#nop {Unassigned items}\n`;
                for (const t of unassignedTriggers) {
                    content += this.triggerToTinTin(t);
                }
                for (const a of unassignedAliases) {
                    content += this.aliasToTinTin(a);
                }
            }
        }

        // Save to server
        try {
            const res = await fetch('api/scripts.php?action=save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename, content })
            });
            const data = await res.json();

            if (data.success) {
                this.appendOutput(`Script saved: ${data.filename} (${data.size} bytes)`, 'system');
            } else {
                this.appendOutput(`Failed to save script: ${data.error}`, 'error');
            }
        } catch (e) {
            this.appendOutput('Failed to save script', 'error');
        }
    }

    // Export a class to TinTin++ format
    exportClassToTinTin(cls) {
        let content = '';
        content += `#class {${cls.name}} {open}\n`;

        const classTriggers = this.triggers.filter(t => t.class === cls.id);
        const classAliases = this.aliases.filter(a => a.class === cls.id);

        for (const t of classTriggers) {
            content += this.triggerToTinTin(t);
        }
        for (const a of classAliases) {
            content += this.aliasToTinTin(a);
        }

        content += `#class {${cls.name}} {close}\n`;
        return content;
    }

    // Convert trigger to TinTin++ format
    triggerToTinTin(trigger) {
        // Check for gag, highlight, or substitute actions
        const hasGag = trigger.actions?.some(a => a.type === 'gag');
        const highlight = trigger.actions?.find(a => a.type === 'highlight');
        const substitute = trigger.actions?.find(a => a.type === 'substitute');
        const command = trigger.actions?.find(a => a.type === 'command');

        if (hasGag && !command) {
            return `#gag {${trigger.pattern}}\n`;
        }
        if (substitute && !command && !hasGag) {
            return `#sub {${trigger.pattern}} {${substitute.replacement || ''}}\n`;
        }
        if (highlight && !command && !hasGag && !substitute) {
            return `#highlight {${highlight.color || 'yellow'}} {${trigger.pattern}}\n`;
        }
        if (command) {
            return `#action {${trigger.pattern}} {${command.command}}\n`;
        }
        // Default to action format
        return `#action {${trigger.pattern}} {}\n`;
    }

    // Convert alias to TinTin++ format
    aliasToTinTin(alias) {
        return `#alias {${alias.pattern}} {${alias.replacement}}\n`;
    }

    // Handle script file upload
    async handleScriptUpload(event) {
        const file = event.target.files?.[0];
        if (!file) return;

        // Reset input so same file can be selected again
        event.target.value = '';

        // Validate file type
        if (!file.name.match(/\.(txt|tin)$/i)) {
            this.appendOutput('Invalid file type. Only .txt and .tin files allowed.', 'error');
            return;
        }

        // Check size (256KB limit)
        if (file.size > 262144) {
            this.appendOutput('File too large. Maximum size is 256KB.', 'error');
            return;
        }

        this.appendOutput(`Uploading: ${file.name}...`, 'system');

        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch('api/scripts.php?action=upload', {
                method: 'POST',
                body: formData
            });
            const data = await res.json();

            if (data.success) {
                this.appendOutput(`Script uploaded: ${data.filename}`, 'system');

                // Ask if user wants to execute the script now
                if (confirm(`Script "${data.filename}" uploaded. Execute it now?`)) {
                    // Parse and execute the content
                    const lines = data.content.split('\n');
                    let lineCount = 0;

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('//')) continue;
                        if (trimmed.startsWith('#')) {
                            try {
                                await this.executeTinTinLine(trimmed);
                                lineCount++;
                            } catch (e) {
                                console.error('Script line error:', trimmed, e);
                            }
                        }
                    }

                    this.appendOutput(`Script executed: ${lineCount} commands`, 'system');

                    // Refresh sidebar
                    if (document.getElementById('scripts-sidebar')?.classList.contains('open')) {
                        this.renderScriptsSidebar();
                    }
                }
            } else {
                this.appendOutput(`Upload failed: ${data.error}`, 'error');
            }
        } catch (e) {
            this.appendOutput('Failed to upload script', 'error');
            console.error(e);
        }
    }

    // #scripts - List available script files
    async cmdScripts(args) {
        try {
            const res = await fetch('api/scripts.php?action=list');
            const data = await res.json();

            if (!data.success) {
                this.appendOutput('Failed to list scripts', 'error');
                return;
            }

            if (data.scripts.length === 0) {
                this.appendOutput('No script files found.', 'system');
                this.appendOutput('Use #write {filename} to create one.', 'system');
            } else {
                this.appendOutput('Script files:', 'system');
                for (const script of data.scripts) {
                    const size = script.size < 1024 ? `${script.size}B` : `${Math.round(script.size/1024)}KB`;
                    this.appendOutput(`  ${script.name} (${size})`, 'system');
                }
            }
        } catch (e) {
            this.appendOutput('Failed to list scripts', 'error');
        }
    }

    // #gag {pattern} - Create a gag trigger (TinTin++ style)
    cmdGag(args) {
        if (args.length < 1) {
            // List gags
            const gags = this.triggers.filter(t => t.actions?.some(a => a.type === 'gag'));
            if (gags.length === 0) {
                this.appendOutput('No gags defined.', 'system');
            } else {
                this.appendOutput('Gags:', 'system');
                gags.forEach(g => {
                    const status = g.enabled === false ? ' [disabled]' : '';
                    this.appendOutput(`  ${g.pattern}${status}`, 'system');
                });
            }
            return;
        }

        const pattern = args[0];

        // Check if gag already exists
        const existing = this.triggers.findIndex(t =>
            t.pattern === pattern &&
            t.actions?.some(a => a.type === 'gag')
        );

        if (existing >= 0) {
            this.appendOutput(`Gag already exists: ${pattern}`, 'system');
            return;
        }

        // Create gag trigger with TinTin++ pattern matching
        this.triggers.push({
            id: this.generateId(),
            name: `Gag: ${pattern.substring(0, 25)}`,
            pattern: pattern,
            matchType: 'tintin',
            actions: [{ type: 'gag' }],
            enabled: true,
            class: this.currentScriptClass || null
        });

        this.appendOutput(`Gag created: ${pattern}`, 'system');
        this.saveTriggers();
    }

    // #ungag {pattern}
    cmdUngag(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #ungag {pattern}', 'error');
            return;
        }

        const pattern = args[0];
        const index = this.triggers.findIndex(t =>
            t.pattern === pattern &&
            t.actions?.some(a => a.type === 'gag')
        );

        if (index >= 0) {
            this.triggers.splice(index, 1);
            this.appendOutput(`Gag removed: ${pattern}`, 'system');
            this.saveTriggers();
        } else {
            this.appendOutput(`Gag not found: ${pattern}`, 'error');
        }
    }

    // #highlight/#high {pattern} {color} - Create highlight trigger (TinTin++ style)
    cmdHighlight(args) {
        if (args.length < 2) {
            // List highlights
            const highlights = this.triggers.filter(t => t.actions?.some(a => a.type === 'highlight'));
            if (highlights.length === 0) {
                this.appendOutput('No highlights defined.', 'system');
            } else {
                this.appendOutput('Highlights:', 'system');
                highlights.forEach(h => {
                    const color = h.actions.find(a => a.type === 'highlight')?.color || 'yellow';
                    const status = h.enabled === false ? ' [disabled]' : '';
                    this.appendOutput(`  [${color}] ${h.pattern}${status}`, 'system');
                });
            }
            return;
        }

        // TinTin++ syntax: #highlight {pattern} {color}
        const pattern = args[0];
        const color = args[1];

        // Convert TinTin++ color names to hex if needed
        const colorMap = {
            'red': '#ff0000', 'green': '#00ff00', 'blue': '#0000ff',
            'yellow': '#ffff00', 'cyan': '#00ffff', 'magenta': '#ff00ff',
            'white': '#ffffff', 'black': '#000000', 'orange': '#ff8800',
            'pink': '#ff88ff', 'bold': '#ffffff', 'light red': '#ff6666',
            'light green': '#66ff66', 'light blue': '#6666ff', 'bold yellow': '#ffff88',
            'bold white': '#ffffff', 'bold cyan': '#88ffff', 'bold magenta': '#ff88ff'
        };
        const hexColor = colorMap[color.toLowerCase()] || color;

        // Check if highlight already exists
        const existing = this.triggers.findIndex(t =>
            t.pattern === pattern &&
            t.actions?.some(a => a.type === 'highlight')
        );

        if (existing >= 0) {
            // Update existing
            const action = this.triggers[existing].actions.find(a => a.type === 'highlight');
            if (action) action.color = hexColor;
            this.triggers[existing].matchType = 'tintin';
            this.appendOutput(`Highlight updated: ${pattern} [${color}]`, 'system');
        } else {
            // Create new with TinTin++ pattern matching
            this.triggers.push({
                id: this.generateId(),
                name: `Highlight: ${pattern.substring(0, 20)}`,
                pattern: pattern,
                matchType: 'tintin',
                actions: [{ type: 'highlight', color: hexColor }],
                enabled: true,
                class: this.currentScriptClass || null
            });
            this.appendOutput(`Highlight created: ${pattern} [${color}]`, 'system');
        }

        this.saveTriggers();
    }

    // #unhighlight {pattern}
    cmdUnhighlight(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #unhighlight {pattern}', 'error');
            return;
        }

        const pattern = args[0];
        const index = this.triggers.findIndex(t =>
            t.pattern === pattern &&
            t.actions?.some(a => a.type === 'highlight')
        );

        if (index >= 0) {
            this.triggers.splice(index, 1);
            this.appendOutput(`Highlight removed: ${pattern}`, 'system');
            this.saveTriggers();
        } else {
            this.appendOutput(`Highlight not found: ${pattern}`, 'error');
        }
    }

    // #substitute/#sub {pattern} {replacement} - Create substitute trigger (TinTin++ style)
    cmdSubstitute(args) {
        if (args.length < 2) {
            // List substitutes
            const subs = this.triggers.filter(t => t.actions?.some(a => a.type === 'substitute'));
            if (subs.length === 0) {
                this.appendOutput('No substitutes defined.', 'system');
            } else {
                this.appendOutput('Substitutes:', 'system');
                subs.forEach(s => {
                    const replacement = s.actions.find(a => a.type === 'substitute')?.replacement || '';
                    const status = s.enabled === false ? ' [disabled]' : '';
                    this.appendOutput(`  ${s.pattern} → ${replacement}${status}`, 'system');
                });
            }
            return;
        }

        // TinTin++ syntax: #sub {pattern} {replacement}
        const pattern = args[0];
        const replacement = args[1];

        // Check if substitute already exists
        const existing = this.triggers.findIndex(t =>
            t.pattern === pattern &&
            t.actions?.some(a => a.type === 'substitute')
        );

        if (existing >= 0) {
            // Update existing
            const action = this.triggers[existing].actions.find(a => a.type === 'substitute');
            if (action) action.replacement = replacement;
            this.triggers[existing].matchType = 'tintin';
            this.appendOutput(`Substitute updated: ${pattern} → ${replacement}`, 'system');
        } else {
            // Create new with TinTin++ pattern matching
            this.triggers.push({
                id: this.generateId(),
                name: `Sub: ${pattern.substring(0, 20)}`,
                pattern: pattern,
                matchType: 'tintin',
                actions: [{ type: 'substitute', replacement: replacement }],
                enabled: true,
                class: this.currentScriptClass || null
            });
            this.appendOutput(`Substitute created: ${pattern} → ${replacement}`, 'system');
        }

        this.saveTriggers();
    }

    // #unsubstitute/#unsub {pattern}
    cmdUnsubstitute(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #unsub {pattern}', 'error');
            return;
        }

        const pattern = args[0];
        const index = this.triggers.findIndex(t =>
            t.pattern === pattern &&
            t.actions?.some(a => a.type === 'substitute')
        );

        if (index >= 0) {
            this.triggers.splice(index, 1);
            this.appendOutput(`Substitute removed: ${pattern}`, 'system');
            this.saveTriggers();
        } else {
            this.appendOutput(`Substitute not found: ${pattern}`, 'error');
        }
    }

    // Open substitute modal
    openSubstituteModal(editIndex = null) {
        const modal = document.getElementById('substitute-modal');
        if (!modal) return;
        this.editingSubstituteIndex = editIndex;

        const existing = editIndex !== null ? this.triggers[editIndex] : null;
        const action = existing?.actions?.find(a => a.type === 'substitute');

        document.getElementById('substitute-pattern').value = existing?.pattern || '';
        document.getElementById('substitute-replacement').value = action?.replacement || '';

        // Populate class dropdown
        const classSelect = document.getElementById('substitute-class');
        if (classSelect) {
            classSelect.innerHTML = this.renderClassOptions(existing?.class || null);
        }

        const title = modal.querySelector('.modal-header h3');
        if (title) title.textContent = existing ? 'Edit Substitute' : 'New Substitute';

        modal.classList.add('open');
    }

    // Save substitute from modal
    async saveSubstitute() {
        const pattern = document.getElementById('substitute-pattern').value.trim();
        const replacement = document.getElementById('substitute-replacement').value;
        const classId = document.getElementById('substitute-class')?.value || null;

        if (!pattern) {
            this.appendOutput('Pattern is required', 'error');
            return;
        }

        if (this.editingSubstituteIndex !== null) {
            // Update existing
            const trigger = this.triggers[this.editingSubstituteIndex];
            trigger.pattern = pattern;
            trigger.name = `Sub: ${pattern.substring(0, 20)}`;
            trigger.class = classId || null;
            const action = trigger.actions?.find(a => a.type === 'substitute');
            if (action) action.replacement = replacement;
            this.appendOutput(`Substitute updated: ${pattern} → ${replacement}`, 'system');
        } else {
            // Create new
            this.triggers.push({
                id: this.generateId(),
                name: `Sub: ${pattern.substring(0, 20)}`,
                pattern: pattern,
                matchType: 'tintin',
                actions: [{ type: 'substitute', replacement: replacement }],
                enabled: true,
                class: classId || null
            });
            this.appendOutput(`Substitute created: ${pattern} → ${replacement}`, 'system');
        }

        await this.saveTriggers();
        this.closeModal();
        this.renderScriptsSidebar();
        this.editingSubstituteIndex = null;
    }

    // #var {name} {value} - Set a variable
    // Supports nested syntax: #var hp[self] 34
    cmdVar(args) {
        if (args.length < 1) {
            // List all variables (recursive display for nested)
            const vars = Object.keys(this.variables);
            if (vars.length === 0) {
                this.appendOutput('No variables defined.', 'system');
            } else {
                this.appendOutput('Variables:', 'system');
                vars.forEach(name => {
                    this.displayVariable(name, this.variables[name], '  ');
                });
            }
            return;
        }

        const { name, keys } = this.parseVariableName(args[0]);

        if (args.length < 2) {
            // Show single variable or variables matching prefix
            if (keys.length > 0) {
                // Showing nested variable
                const val = this.getNestedVariable(name, keys);
                if (val !== undefined) {
                    this.displayVariable(args[0], val, '');
                } else {
                    this.appendOutput(`Variable not found: $${args[0]}`, 'error');
                }
            } else if (this.variables[name] !== undefined) {
                this.displayVariable(name, this.variables[name], '');
            } else {
                // Try prefix match (TinTin++ behavior)
                const matches = Object.keys(this.variables).filter(v => v.startsWith(name));
                if (matches.length > 0) {
                    this.appendOutput(`Variables matching '${name}':`, 'system');
                    matches.forEach(v => {
                        this.displayVariable(v, this.variables[v], '  ');
                    });
                } else {
                    this.appendOutput(`Variable not found: $${name}`, 'error');
                }
            }
            return;
        }

        // Join all remaining args as the value (handles spaces in captured text)
        const value = args.slice(1).join(' ');

        // Set the variable (handles nested if keys present)
        this.setNestedVariable(name, keys, value);
        // Silent - no confirmation message (TinTin++ behavior)
    }

    // Display a variable value (handles nested objects)
    displayVariable(name, value, indent) {
        if (typeof value === 'object' && value !== null) {
            this.appendOutput(`${indent}$${name}:`, 'system');
            Object.keys(value).forEach(key => {
                this.displayVariable(`${name}[${key}]`, value[key], indent + '  ');
            });
        } else {
            this.appendOutput(`${indent}$${name} = ${value}`, 'system');
        }
    }

    // #unvar {name} - Remove a variable
    // Supports nested syntax: #unvar hp[self]
    cmdUnvar(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #unvar {name}', 'error');
            return;
        }

        const { name, keys } = this.parseVariableName(args[0]);

        if (keys.length === 0) {
            // Simple variable
            if (this.variables[name] !== undefined) {
                delete this.variables[name];
                this.appendOutput(`Variable removed: $${name}`, 'system');
            } else {
                this.appendOutput(`Variable not found: $${name}`, 'error');
            }
        } else {
            // Nested variable - navigate to parent and delete key
            let current = this.variables[name];
            if (current === undefined) {
                this.appendOutput(`Variable not found: $${args[0]}`, 'error');
                return;
            }

            for (let i = 0; i < keys.length - 1; i++) {
                if (current === undefined || typeof current !== 'object') {
                    this.appendOutput(`Variable not found: $${args[0]}`, 'error');
                    return;
                }
                current = current[keys[i]];
            }

            const lastKey = keys[keys.length - 1];
            if (current && typeof current === 'object' && current[lastKey] !== undefined) {
                delete current[lastKey];
                this.appendOutput(`Variable removed: $${args[0]}`, 'system');
            } else {
                this.appendOutput(`Variable not found: $${args[0]}`, 'error');
            }
        }
    }

    // #math {variable} {expression} - Calculate and store result
    // Supports TinTin++ operators: arithmetic, bitwise, logical, comparison, dice, ternary
    // Supports nested variables: #math hp[current] {$hp[current] - 10}
    cmdMath(args) {
        if (args.length < 2) {
            this.appendOutput('Usage: #math {variable} {expression}', 'error');
            return;
        }

        const { name, keys } = this.parseVariableName(args[0]);
        let expression = args[1];

        // Substitute variables in expression
        expression = this.substituteVariables(expression);

        try {
            const result = this.evaluateMathExpression(expression);
            this.setNestedVariable(name, keys, result);
            this.appendOutput(`#math: $${args[0]} = ${result}`, 'system');
        } catch (e) {
            this.appendOutput(`Math error: ${e.message}`, 'error');
        }
    }

    // Evaluate a TinTin++ math expression
    // Supports: +, -, *, /, %, ** (power), // (roots), d (dice)
    // Bitwise: ~, <<, >>, &, ^, |
    // Logical: !, &&, ||, ^^ (xor)
    // Comparison: <, >, <=, >=, ==, !=, ===, !==
    // Ternary: ? :
    evaluateMathExpression(expression) {
        let expr = expression.trim();

        // Handle TinTin++ style dice: 1d6, 2d10, etc. (must be done before other processing)
        expr = expr.replace(/(\d+)d(\d+)/gi, (match, count, sides) => {
            let total = 0;
            const c = parseInt(count);
            const s = parseInt(sides);
            for (let i = 0; i < c; i++) {
                total += Math.floor(Math.random() * s) + 1;
            }
            return total.toString();
        });

        // Handle TinTin++ // operator for roots: //2 = sqrt, //3 = cbrt, //n = nth root
        // Convert "number //n" to "Math.pow(number, 1/n)"
        expr = expr.replace(/(\d+(?:\.\d+)?)\s*\/\/\s*(\d+)/g, (match, num, root) => {
            return `Math.pow(${num}, 1/${root})`;
        });

        // Handle ^^ (logical XOR) - convert to != for boolean context
        expr = expr.replace(/\^\^/g, '!=');

        // Validate expression - only allow safe characters
        // Numbers, operators, parentheses, spaces, decimal points, Math functions
        const safePattern = /^[\d\s+\-*/%<>=!&|^~?:().]+$|Math\.(pow|sqrt|abs|floor|ceil|round|min|max|random)/;

        // Remove string literals for validation (they're allowed in comparisons)
        const exprNoStrings = expr.replace(/"[^"]*"|'[^']*'/g, '0');

        if (!safePattern.test(exprNoStrings) && !/^[\d\s+\-*/%<>=!&|^~?:()."']+$/.test(expr)) {
            throw new Error('Invalid characters in expression');
        }

        // Prevent dangerous patterns
        if (/\b(function|eval|require|import|window|document|fetch|XMLHttp)\b/i.test(expr)) {
            throw new Error('Invalid expression');
        }

        // eslint-disable-next-line no-eval
        const result = eval(expr);

        // Return number or boolean as appropriate
        if (typeof result === 'boolean') {
            return result ? 1 : 0;
        }
        return result;
    }

    /**
     * Convert TinTin++ pattern to JavaScript regex (client-side version)
     * This mirrors the server-side implementation for #regexp
     */
    tinTinToRegex(pattern) {
        let result = '';
        let i = 0;

        while (i < pattern.length) {
            const char = pattern[i];

            if (char === '\\' && i + 1 < pattern.length) {
                const next = pattern[i + 1];
                if (next === '%') {
                    result += '%';
                    i += 2;
                } else if (next === '{' || next === '}') {
                    result += '\\' + next;
                    i += 2;
                } else {
                    result += '\\' + next;
                    i += 2;
                }
            } else if (char === '{') {
                // PCRE embedding: { } becomes ( )
                let depth = 1;
                let j = i + 1;
                let pcreContent = '';
                while (j < pattern.length && depth > 0) {
                    if (pattern[j] === '{' && pattern[j-1] !== '\\') {
                        depth++;
                        pcreContent += pattern[j];
                    } else if (pattern[j] === '}' && pattern[j-1] !== '\\') {
                        depth--;
                        if (depth > 0) pcreContent += pattern[j];
                    } else {
                        pcreContent += pattern[j];
                    }
                    j++;
                }
                result += '(' + pcreContent + ')';
                i = j;
            } else if (char === '%') {
                if (i + 1 < pattern.length) {
                    let next = pattern[i + 1];
                    let nonCapturing = false;

                    if (next === '!' && i + 2 < pattern.length) {
                        nonCapturing = true;
                        next = pattern[i + 2];
                        i += 1;

                        if (next === '{') {
                            let depth = 1;
                            let j = i + 2;
                            let pcreContent = '';
                            while (j < pattern.length && depth > 0) {
                                if (pattern[j] === '{' && pattern[j-1] !== '\\') {
                                    depth++;
                                    pcreContent += pattern[j];
                                } else if (pattern[j] === '}' && pattern[j-1] !== '\\') {
                                    depth--;
                                    if (depth > 0) pcreContent += pattern[j];
                                } else {
                                    pcreContent += pattern[j];
                                }
                                j++;
                            }
                            result += '(?:' + pcreContent + ')';
                            i = j;
                            continue;
                        }
                    }

                    const groupStart = nonCapturing ? '(?:' : '(';

                    if (next === '*') {
                        result += groupStart + '.*)';
                        i += 2;
                    } else if (next === '+') {
                        result += groupStart + '.+)';
                        i += 2;
                    } else if (next === '?') {
                        result += groupStart + '.?)';
                        i += 2;
                    } else if (next === '.') {
                        result += groupStart + '.)';
                        i += 2;
                    } else if (next === 'd') {
                        result += groupStart + '[0-9]*)';
                        i += 2;
                    } else if (next === 'D') {
                        result += groupStart + '[^0-9]*)';
                        i += 2;
                    } else if (next === 'w') {
                        result += groupStart + '[A-Za-z0-9_]*)';
                        i += 2;
                    } else if (next === 'W') {
                        result += groupStart + '[^A-Za-z0-9_]*)';
                        i += 2;
                    } else if (next === 's') {
                        result += groupStart + '\\s*)';
                        i += 2;
                    } else if (next === 'S') {
                        result += groupStart + '\\S*)';
                        i += 2;
                    } else if (next === 'a') {
                        result += groupStart + '[\\s\\S]*)';
                        i += 2;
                    } else if (next === 'A') {
                        result += groupStart + '[\\r\\n]*)';
                        i += 2;
                    } else if (next === 'i' || next === 'I') {
                        i += 2;
                    } else if (next >= '0' && next <= '9') {
                        let j = i + 1;
                        while (j < pattern.length && pattern[j] >= '0' && pattern[j] <= '9') {
                            j++;
                        }
                        result += '(.*)';
                        i = j;
                    } else {
                        result += '%';
                        i += 1;
                    }
                } else {
                    result += '%';
                    i += 1;
                }
            } else if (char === '^' || char === '$') {
                result += char;
                i += 1;
            } else if ('[]())|+?*.\\'.includes(char)) {
                result += '\\' + char;
                i += 1;
            } else {
                result += char;
                i += 1;
            }
        }

        return result;
    }

    /**
     * Substitute &0-&99 variables in a command string
     */
    substituteRegexpVars(command, matches) {
        let result = command;
        if (matches && matches.length > 0) {
            for (let i = 0; i < matches.length && i < 100; i++) {
                const regex = new RegExp('&' + i + '(?![0-9])', 'g');
                result = result.replace(regex, matches[i] || '');
            }
        }
        // Clean up any unreplaced &N
        result = result.replace(/&\d+/g, '');
        return result;
    }

    // #regexp {string} {expression} {true_commands} {false_commands}
    // Also aliased as #regex
    cmdRegexp(args) {
        if (args.length < 3) {
            this.appendOutput('Usage: #regexp {string} {expression} {true_cmds} {false_cmds}', 'error');
            return;
        }

        // Substitute variables in the string argument (e.g., $hpbar -> actual value)
        const string = this.substituteVariables(args[0]);
        const expression = args[1];
        const trueCmd = args[2];
        const falseCmd = args[3] || '';

        try {
            // Convert TinTin++ pattern to regex (case-sensitive)
            const regexPattern = this.tinTinToRegex(expression);
            const regex = new RegExp(regexPattern);
            const match = string.match(regex);

            if (match) {
                // Substitute &0, &1, etc. with captured groups
                const cmd = this.substituteRegexpVars(trueCmd, match);
                // Execute the command(s)
                this.executeCommandString(cmd);
            } else if (falseCmd) {
                this.executeCommandString(falseCmd);
            }
        } catch (e) {
            this.appendOutput(`Regexp error: ${e.message}`, 'error');
        }
    }

    // #if {condition} {true_commands} [#elseif {cond} {cmds}] [#else {cmds}]
    cmdIf(args, rest) {
        if (args.length < 2) {
            this.appendOutput('Usage: #if {condition} {commands}', 'error');
            return;
        }

        // Parse the full if/elseif/else chain
        const parseIfChain = (str) => {
            const parts = [];
            let current = { condition: null, commands: null };
            let depth = 0;
            let buffer = '';
            let state = 'condition'; // condition, commands, between

            for (let i = 0; i < str.length; i++) {
                const char = str[i];
                if (char === '{') {
                    if (depth === 0) {
                        depth++;
                        continue;
                    }
                    depth++;
                    buffer += char;
                } else if (char === '}') {
                    depth--;
                    if (depth === 0) {
                        if (state === 'condition') {
                            current.condition = buffer.trim();
                            buffer = '';
                            state = 'commands';
                        } else if (state === 'commands') {
                            current.commands = buffer.trim();
                            parts.push(current);
                            current = { condition: null, commands: null };
                            buffer = '';
                            state = 'between';
                        }
                        continue;
                    }
                    buffer += char;
                } else if (depth > 0) {
                    buffer += char;
                } else if (state === 'between') {
                    // Look for #elseif or #else
                    const remaining = str.substring(i).trim();
                    if (remaining.startsWith('#elseif') || remaining.startsWith('#elif')) {
                        const match = remaining.match(/^#(?:elseif|elif)\s*/);
                        if (match) {
                            i += match[0].length - 1;
                            state = 'condition';
                        }
                    } else if (remaining.startsWith('#else')) {
                        const match = remaining.match(/^#else\s*/);
                        if (match) {
                            i += match[0].length - 1;
                            current.condition = 'true'; // else always runs
                            state = 'commands';
                        }
                    }
                }
            }
            return parts;
        };

        const chain = parseIfChain(rest);
        if (chain.length === 0) {
            // Simple case - just use args
            chain.push({ condition: args[0], commands: args[1] });
            if (args.length >= 3) {
                chain.push({ condition: 'true', commands: args[2] });
            }
        }

        // Evaluate each condition in order
        for (const part of chain) {
            if (this.evaluateCondition(part.condition)) {
                // Execute the commands
                this.executeCommandString(part.commands);
                return;
            }
        }
    }

    /**
     * Evaluate a TinTin++ style condition
     *
     * String comparison (quoted): #if {"$var" == "value"} or {"$var" == "{pat1|pat2}"}
     * Numeric comparison (unquoted): #if {$var > 5000}
     *
     * Operators: == != < > <= >= === !== && || ^^ !
     * Regex matching: == and != can use {pattern|alt} syntax when comparing strings
     */
    evaluateCondition(condition) {
        if (!condition) return false;

        // Substitute variables first
        let cond = this.substituteVariables(condition);

        // Replace word-based logical operators
        cond = cond.replace(/\band\b/gi, '&&');
        cond = cond.replace(/\bor\b/gi, '||');
        cond = cond.replace(/\bxor\b/gi, '^^');
        cond = cond.replace(/\bnot\b/gi, '!');

        // Try to evaluate as a simple comparison first
        const result = this.evaluateSimpleCondition(cond);
        if (result !== null) return result;

        // Try compound conditions with && || ^^
        // Split by logical operators while respecting quotes
        const parts = this.splitConditionByLogic(cond);
        if (parts) {
            return this.evaluateCompoundCondition(parts);
        }

        // Fallback: try direct eval for simple numeric expressions
        try {
            // Only allow safe characters
            const safeExpr = cond.replace(/[^0-9+\-*/%().&|^!<>=\s]/g, '');
            if (safeExpr.trim()) {
                // eslint-disable-next-line no-eval
                return !!eval(safeExpr);
            }
        } catch (e) {
            // Ignore eval errors
        }

        return false;
    }

    /**
     * Evaluate a simple comparison (no && || ^^)
     * Returns null if not a simple comparison
     */
    evaluateSimpleCondition(cond) {
        cond = cond.trim();

        // Check for negation
        if (cond.startsWith('!') && !cond.startsWith('!=') && !cond.startsWith('!==')) {
            const inner = cond.substring(1).trim();
            // Remove parentheses if present
            const innerCond = inner.startsWith('(') && inner.endsWith(')')
                ? inner.slice(1, -1)
                : inner;
            const result = this.evaluateCondition(innerCond);
            return !result;
        }

        // Match comparison: "string" op "string" or number op number
        // Regex to capture: left side, operator, right side
        // Supports both quoted strings and unquoted values
        const comparisonMatch = cond.match(
            /^(["'].*?["']|\S+)\s*(===|!==|==|!=|<=|>=|<|>)\s*(["'].*?["']|\S+)$/
        );

        if (comparisonMatch) {
            let [, leftRaw, op, rightRaw] = comparisonMatch;

            // Extract values, removing quotes if present
            const isLeftQuoted = /^["']/.test(leftRaw);
            const isRightQuoted = /^["']/.test(rightRaw);
            const left = isLeftQuoted ? leftRaw.slice(1, -1) : leftRaw;
            const right = isRightQuoted ? rightRaw.slice(1, -1) : rightRaw;

            // Determine if this is a string or numeric comparison
            // Quoted = string, Unquoted with valid number = numeric
            const leftNum = parseFloat(left);
            const rightNum = parseFloat(right);
            const isNumeric = !isLeftQuoted && !isRightQuoted && !isNaN(leftNum) && !isNaN(rightNum);

            // For == and != with strings, check if right side is a regex pattern {a|b}
            const canUseRegex = (op === '==' || op === '!=') && (isLeftQuoted || isRightQuoted);
            const isRegexPattern = canUseRegex && /^\{.*\}$/.test(right);

            switch (op) {
                case '===':
                    // Strict equal - never regex
                    return isNumeric ? leftNum === rightNum : left === right;
                case '!==':
                    // Strict not equal - never regex
                    return isNumeric ? leftNum !== rightNum : left !== right;
                case '==':
                    if (isRegexPattern) {
                        // Convert {a|b|c} to regex (a|b|c) - case-sensitive
                        const pattern = right.slice(1, -1);
                        try {
                            const regex = new RegExp(`^(${pattern})$`);
                            return regex.test(left);
                        } catch (e) {
                            return left === right;
                        }
                    }
                    return isNumeric ? leftNum === rightNum : left === right;
                case '!=':
                    if (isRegexPattern) {
                        const pattern = right.slice(1, -1);
                        try {
                            const regex = new RegExp(`^(${pattern})$`);
                            return !regex.test(left);
                        } catch (e) {
                            return left !== right;
                        }
                    }
                    return isNumeric ? leftNum !== rightNum : left !== right;
                case '<':
                    return isNumeric ? leftNum < rightNum : left < right;
                case '>':
                    return isNumeric ? leftNum > rightNum : left > right;
                case '<=':
                    return isNumeric ? leftNum <= rightNum : left <= right;
                case '>=':
                    return isNumeric ? leftNum >= rightNum : left >= right;
            }
        }

        // Check for simple truthy value (non-zero number or non-empty string)
        const num = parseFloat(cond);
        if (!isNaN(num)) {
            return num !== 0;
        }

        // Non-empty string is truthy
        return cond.length > 0 && cond !== '0' && cond.toLowerCase() !== 'false';
    }

    /**
     * Split condition by && || ^^ while respecting quotes and parentheses
     */
    splitConditionByLogic(cond) {
        const parts = [];
        let current = '';
        let depth = 0;
        let inQuote = null;
        let lastOp = null;

        for (let i = 0; i < cond.length; i++) {
            const char = cond[i];
            const next = cond[i + 1];

            // Track quotes
            if ((char === '"' || char === "'") && cond[i - 1] !== '\\') {
                if (inQuote === char) {
                    inQuote = null;
                } else if (!inQuote) {
                    inQuote = char;
                }
            }

            // Track parentheses depth
            if (!inQuote) {
                if (char === '(' || char === '{') depth++;
                if (char === ')' || char === '}') depth--;
            }

            // Check for logical operators at depth 0, outside quotes
            if (depth === 0 && !inQuote) {
                if (char === '&' && next === '&') {
                    parts.push({ value: current.trim(), op: lastOp });
                    lastOp = '&&';
                    current = '';
                    i++; // Skip next &
                    continue;
                }
                if (char === '|' && next === '|') {
                    parts.push({ value: current.trim(), op: lastOp });
                    lastOp = '||';
                    current = '';
                    i++; // Skip next |
                    continue;
                }
                if (char === '^' && next === '^') {
                    parts.push({ value: current.trim(), op: lastOp });
                    lastOp = '^^';
                    current = '';
                    i++; // Skip next ^
                    continue;
                }
            }

            current += char;
        }

        if (current.trim()) {
            parts.push({ value: current.trim(), op: lastOp });
        }

        return parts.length > 1 ? parts : null;
    }

    /**
     * Evaluate compound condition with && || ^^
     */
    evaluateCompoundCondition(parts) {
        let result = this.evaluateCondition(parts[0].value);

        for (let i = 1; i < parts.length; i++) {
            const part = parts[i];
            const partResult = this.evaluateCondition(part.value);

            switch (part.op) {
                case '&&':
                    result = result && partResult;
                    break;
                case '||':
                    result = result || partResult;
                    break;
                case '^^':
                    // XOR: true if exactly one is true
                    result = (result && !partResult) || (!result && partResult);
                    break;
            }
        }

        return result;
    }

    // Substitute $variables and @functions in a string
    // Supports: $var, $var[key], $var[key][subkey], $var[+1], $var[-1], &var[], *var[], @func{args}
    substituteVariables(str) {
        if (!str) return str;

        // First handle @function{args} calls
        // Match @name{args} where args can contain nested braces
        let maxIterations = 10; // Prevent infinite loops from nested function calls
        while (maxIterations-- > 0) {
            const funcMatch = str.match(/@(\w+)\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/);
            if (!funcMatch) break;

            const funcName = funcMatch[1];
            const funcArgs = funcMatch[2];
            const result = this.callFunction(funcName, funcArgs);
            str = str.replace(funcMatch[0], result);
        }

        // First handle &variable[] for size (must come before $ handling)
        str = str.replace(/&(\w+)\[\]/g, (match, name) => {
            const val = this.variables[name];
            if (val === undefined) return '0';
            if (typeof val === 'object' && val !== null) {
                return Object.keys(val).length.toString();
            }
            // For simple variables, size is 1
            return '1';
        });

        // Handle *variable[] for listing all keys
        str = str.replace(/\*(\w+)\[\]/g, (match, name) => {
            const val = this.variables[name];
            if (val === undefined) return '';
            if (typeof val === 'object' && val !== null) {
                return Object.keys(val).join(';');
            }
            return name;
        });

        // Handle $variable[key] and $variable[key][subkey] patterns
        // This regex matches $varname followed by one or more [key] brackets
        str = str.replace(/\$(\w+)((?:\[[^\]]*\])+)/g, (match, name, brackets) => {
            let val = this.variables[name];
            if (val === undefined) {
                // Try MIP variables
                val = this.mipVars[name];
            }
            if (val === undefined) return match;

            // Parse the bracket keys
            const keys = [];
            const keyRegex = /\[([^\]]*)\]/g;
            let keyMatch;
            while ((keyMatch = keyRegex.exec(brackets)) !== null) {
                keys.push(keyMatch[1]);
            }

            // Navigate through the nested structure
            for (const key of keys) {
                if (val === undefined || val === null) return '';

                if (typeof val !== 'object') return '';

                // Handle special indices
                if (key === '') {
                    // $var[] returns all values
                    return Object.values(val).join(';');
                } else if (key.startsWith('+')) {
                    // Positive index from start (+1 = first)
                    const idx = parseInt(key.substring(1)) - 1;
                    const values = Object.values(val);
                    if (idx >= 0 && idx < values.length) {
                        val = values[idx];
                    } else {
                        return '';
                    }
                } else if (key.startsWith('-')) {
                    // Negative index from end (-1 = last)
                    const idx = parseInt(key);
                    const values = Object.values(val);
                    if (idx < 0 && Math.abs(idx) <= values.length) {
                        val = values[values.length + idx];
                    } else {
                        return '';
                    }
                } else if (key.includes('..')) {
                    // Range: $var[+2..4] - values from index 2 to 4
                    const [startStr, endStr] = key.split('..');
                    const start = parseInt(startStr.replace('+', '')) - 1;
                    const end = parseInt(endStr) - 1;
                    const values = Object.values(val);
                    if (start >= 0 && end >= start && end < values.length) {
                        return values.slice(start, end + 1).join(';');
                    }
                    return '';
                } else {
                    // Regular key access
                    val = val[key];
                }
            }

            if (val === undefined) return '';
            if (typeof val === 'object') return JSON.stringify(val);
            return String(val);
        });

        // Handle simple $variable patterns (no brackets)
        str = str.replace(/\$(\w+)(?!\[)/g, (match, name) => {
            // Check local scopes first (innermost to outermost)
            for (let i = this.localScopes.length - 1; i >= 0; i--) {
                if (name in this.localScopes[i]) {
                    const val = this.localScopes[i][name];
                    if (typeof val === 'object') return JSON.stringify(val);
                    return String(val);
                }
            }
            // Then check global TinTin++ variables
            if (this.variables[name] !== undefined) {
                const val = this.variables[name];
                if (typeof val === 'object') return JSON.stringify(val);
                return String(val);  // Ensure string return for replace
            }
            // Finally check MIP variables
            if (this.mipVars[name] !== undefined) {
                return String(this.mipVars[name]);  // Ensure string return
            }
            return match;
        });

        return str;
    }

    // Set a simple variable (convenience method)
    setVariable(name, value) {
        this.variables[name] = value;
        // Fire VARIABLE_UPDATE event (but avoid infinite loops from event handlers)
        if (!this._firingVariableEvent) {
            this._firingVariableEvent = true;
            this.fireEvent('VARIABLE_UPDATE', name);
            this._firingVariableEvent = false;
        }
    }

    // Get a simple variable
    getVariable(name) {
        return this.variables[name];
    }

    // Set a nested variable value using bracket notation
    // e.g., setNestedVariable('hp', ['self'], 34) sets variables.hp.self = 34
    setNestedVariable(name, keys, value) {
        if (keys.length === 0) {
            this.setVariable(name, value);
            return;
        }

        // Ensure base variable exists and is an object
        if (this.variables[name] === undefined || typeof this.variables[name] !== 'object') {
            this.variables[name] = {};
        }

        let current = this.variables[name];
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (current[key] === undefined || typeof current[key] !== 'object') {
                current[key] = {};
            }
            current = current[key];
        }
        current[keys[keys.length - 1]] = value;

        // Fire VARIABLE_UPDATE event for the base variable
        if (!this._firingVariableEvent) {
            this._firingVariableEvent = true;
            this.fireEvent('VARIABLE_UPDATE', name);
            this._firingVariableEvent = false;
        }
    }

    // Get a nested variable value
    getNestedVariable(name, keys) {
        let val = this.variables[name];
        if (val === undefined) return undefined;

        for (const key of keys) {
            if (val === undefined || val === null || typeof val !== 'object') {
                return undefined;
            }
            val = val[key];
        }
        return val;
    }

    // Parse variable name with optional bracket keys
    // Returns { name: string, keys: string[] }
    parseVariableName(fullName) {
        const match = fullName.match(/^(\w+)((?:\[[^\]]*\])*)$/);
        if (!match) return { name: fullName, keys: [] };

        const name = match[1];
        const bracketStr = match[2] || '';
        const keys = [];
        const keyRegex = /\[([^\]]*)\]/g;
        let keyMatch;
        while ((keyMatch = keyRegex.exec(bracketStr)) !== null) {
            keys.push(keyMatch[1]);
        }
        return { name, keys };
    }

    // Convert TinTin++ color codes <xyz> to ANSI escape sequences
    // Reference: https://tintin.mudhalla.net/manual/colors.php
    parseTinTinColors(str) {
        if (!str) return str;

        // VT100 color mapping: 0=black, 1=red, 2=green, 3=yellow, 4=blue, 5=magenta, 6=cyan, 7=white, 8=default, 9=default
        // Note: 9 in TinTin++ means "light" for fg but practically means "default" for bg
        const fgColors = { '0': 30, '1': 31, '2': 32, '3': 33, '4': 34, '5': 35, '6': 36, '7': 37, '8': 39, '9': 39 };
        const bgColors = { '0': 40, '1': 41, '2': 42, '3': 43, '4': 44, '5': 45, '6': 46, '7': 47, '8': 49, '9': 49 };
        // Attributes: 0=reset, 1=bold, 2=dim, 4=underline, 5=blink, 7=reverse, 8=invisible
        const attrs = { '0': 0, '1': 1, '2': 2, '4': 4, '5': 5, '7': 7, '8': 8 };

        return str.replace(/<([a-fA-F0-9gG]{3,8})>/g, (match, code) => {
            // Handle 3-digit VT100 codes like <179> (attr, fg, bg)
            if (/^[0-9]{3}$/.test(code)) {
                const attr = code[0];
                const fg = code[1];
                const bg = code[2];
                const parts = [];

                if (attrs[attr] !== undefined) parts.push(attrs[attr]);
                if (fgColors[fg] !== undefined) parts.push(fgColors[fg]);
                if (bgColors[bg] !== undefined) parts.push(bgColors[bg]);

                if (parts.length > 0) {
                    return '\x1b[' + parts.join(';') + 'm';
                }
                return '';
            }

            // Handle 256-color foreground: <aaa> to <fff> (lowercase = fg)
            if (/^[a-f]{3}$/.test(code)) {
                const r = code.charCodeAt(0) - 97; // a=0, f=5
                const g = code.charCodeAt(1) - 97;
                const b = code.charCodeAt(2) - 97;
                const colorIndex = 16 + 36 * r + 6 * g + b;
                return `\x1b[38;5;${colorIndex}m`;
            }

            // Handle 256-color background: <AAA> to <FFF> (uppercase = bg)
            if (/^[A-F]{3}$/.test(code)) {
                const r = code.charCodeAt(0) - 65; // A=0, F=5
                const g = code.charCodeAt(1) - 65;
                const b = code.charCodeAt(2) - 65;
                const colorIndex = 16 + 36 * r + 6 * g + b;
                return `\x1b[48;5;${colorIndex}m`;
            }

            // Handle grayscale foreground: <g00> to <g23>
            if (/^g[0-2][0-9]$/.test(code)) {
                const level = parseInt(code.substring(1));
                if (level >= 0 && level <= 23) {
                    return `\x1b[38;5;${232 + level}m`;
                }
            }

            // Handle grayscale background: <G00> to <G23>
            if (/^G[0-2][0-9]$/.test(code)) {
                const level = parseInt(code.substring(1));
                if (level >= 0 && level <= 23) {
                    return `\x1b[48;5;${232 + level}m`;
                }
            }

            // Handle truecolor foreground: <Fxxx> (12-bit) or <Fxxxxxx> (24-bit)
            if (/^F[0-9a-fA-F]{3}$/.test(code)) {
                // 12-bit: expand each nibble to full byte
                const r = parseInt(code[1], 16) * 17;
                const g = parseInt(code[2], 16) * 17;
                const b = parseInt(code[3], 16) * 17;
                return `\x1b[38;2;${r};${g};${b}m`;
            }
            if (/^F[0-9a-fA-F]{6}$/.test(code)) {
                // 24-bit RGB
                const r = parseInt(code.substring(1, 3), 16);
                const g = parseInt(code.substring(3, 5), 16);
                const b = parseInt(code.substring(5, 7), 16);
                return `\x1b[38;2;${r};${g};${b}m`;
            }

            // Handle truecolor background: <Bxxx> (12-bit) or <Bxxxxxx> (24-bit)
            if (/^B[0-9a-fA-F]{3}$/.test(code)) {
                const r = parseInt(code[1], 16) * 17;
                const g = parseInt(code[2], 16) * 17;
                const b = parseInt(code[3], 16) * 17;
                return `\x1b[48;2;${r};${g};${b}m`;
            }
            if (/^B[0-9a-fA-F]{6}$/.test(code)) {
                const r = parseInt(code.substring(1, 3), 16);
                const g = parseInt(code.substring(3, 5), 16);
                const b = parseInt(code.substring(5, 7), 16);
                return `\x1b[48;2;${r};${g};${b}m`;
            }

            // Unknown code - return as-is
            return match;
        });
    }

    // Execute a command string (may contain multiple commands separated by ;)
    executeCommandString(cmdStr) {
        if (!cmdStr) return;

        // Substitute variables first
        cmdStr = this.substituteVariables(cmdStr);

        // Split by semicolons, respecting braces
        const commands = [];
        let current = '';
        let depth = 0;

        for (let i = 0; i < cmdStr.length; i++) {
            const char = cmdStr[i];
            if (char === '{') {
                depth++;
                current += char;
            } else if (char === '}') {
                depth--;
                current += char;
            } else if (char === ';' && depth === 0) {
                if (current.trim()) commands.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        if (current.trim()) commands.push(current.trim());

        // Execute each command
        commands.forEach(cmd => {
            if (cmd.startsWith('#')) {
                this.processClientCommand(cmd);
            } else {
                this.connection.sendCommand(cmd);
            }
        });
    }

    // #showme/#show {message} [row] - Display message and process through triggers
    cmdShowme(args, rest) {
        if (args.length < 1 && !rest) {
            this.appendOutput('Usage: #showme {message} [row]', 'error');
            return;
        }

        // Check if last arg is a row number (for split screen)
        let row = null;
        let messageArgs = [...args];
        if (args.length >= 2) {
            const lastArg = args[args.length - 1];
            const possibleRow = parseInt(lastArg);
            // If last arg is a number (positive or negative), treat as row
            if (!isNaN(possibleRow) && String(possibleRow) === lastArg) {
                row = possibleRow;
                messageArgs = args.slice(0, -1);
            }
        }

        // Join all message arguments (supports both braced and unbraced input)
        let message = messageArgs.join(' ') || rest;
        message = this.substituteVariables(message);
        message = this.parseTinTinColors(message);

        if (row !== null && (this.splitConfig.top > 0 || this.splitConfig.bottom > 0)) {
            // Display in split area (local only, no trigger processing)
            this.updateSplitRow(row, message);
        } else {
            // Send to server for trigger processing, then display result
            // This allows testing triggers with #showme
            if (this.connection && this.connection.isConnected()) {
                this.connection.send('test_line', { line: message });
            } else {
                // Fallback to local display if not connected
                this.appendOutput(message, 'system');
            }
        }
    }

    // #echo {message} - Display message locally (no trigger processing)
    cmdEcho(args, rest) {
        if (args.length < 1 && !rest) {
            this.appendOutput('Usage: #echo {message}', 'error');
            return;
        }
        let message = args.join(' ') || rest;
        message = this.substituteVariables(message);
        message = this.parseTinTinColors(message);
        this.appendOutput(message, 'system');
    }

    // #bell - Play alert sound
    cmdBell() {
        this.playBell();
        this.appendOutput('[BELL]', 'system');
    }

    // Play bell/alert sound
    playBell(soundType = null) {
        try {
            const sound = soundType || this.preferences.notificationSound || 'classic';
            const volume = (this.preferences.notificationVolume ?? 30) / 100;

            const audioContext = new (window.AudioContext || window.webkitAudioContext)();

            switch (sound) {
                case 'classic':
                    this.playTone(audioContext, 800, 'sine', volume, 150);
                    break;

                case 'ping':
                    // Higher, softer ping
                    this.playTone(audioContext, 1200, 'sine', volume * 0.7, 100);
                    break;

                case 'double':
                    // Two quick beeps
                    this.playTone(audioContext, 800, 'sine', volume, 80);
                    setTimeout(() => {
                        this.playTone(audioContext, 800, 'sine', volume, 80);
                    }, 120);
                    break;

                case 'chime':
                    // Pleasant multi-tone chime
                    this.playTone(audioContext, 523, 'sine', volume * 0.6, 150); // C5
                    setTimeout(() => this.playTone(audioContext, 659, 'sine', volume * 0.5, 150), 100); // E5
                    setTimeout(() => this.playTone(audioContext, 784, 'sine', volume * 0.4, 200), 200); // G5
                    break;

                case 'alert':
                    // More urgent sound
                    this.playTone(audioContext, 880, 'square', volume * 0.4, 100);
                    setTimeout(() => this.playTone(audioContext, 988, 'square', volume * 0.4, 100), 120);
                    break;

                case 'gentle':
                    // Soft low tone
                    this.playTone(audioContext, 440, 'sine', volume * 0.5, 200);
                    break;

                default:
                    this.playTone(audioContext, 800, 'sine', volume, 150);
            }
        } catch (e) {
            console.error('Failed to play bell:', e);
        }
    }

    // Helper to play a single tone
    playTone(audioContext, frequency, type, volume, duration) {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.frequency.value = frequency;
        oscillator.type = type;
        gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
        // Fade out to avoid click
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration / 1000);

        oscillator.start();
        setTimeout(() => {
            oscillator.stop();
        }, duration);
    }

    // #send {text} - Send raw text to MUD
    cmdSend(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #send {text}', 'error');
            return;
        }

        // Join all arguments (supports both #send {text} and #send text without braces)
        let text = args.join(' ');
        // Handle TinTin++ escape sequences: \; becomes ;
        text = text.replace(/\\;/g, ';');
        text = this.substituteVariables(text);
        // Use raw=true to bypass semicolon splitting (ANSI codes contain semicolons)
        this.connection.sendCommand(text, true);
    }

    // #loop {start} {end} {variable} {commands}
    // Reference: https://tintin.mudhalla.net/manual/loop.php
    cmdLoop(args, rest) {
        if (args.length < 4) {
            this.appendOutput('Usage: #loop {start} {end} {variable} {commands}', 'error');
            return;
        }

        const start = parseInt(this.substituteVariables(args[0]));
        const end = parseInt(this.substituteVariables(args[1]));
        const varName = args[2];
        const commands = args[3];

        if (isNaN(start) || isNaN(end)) {
            this.appendOutput('Loop start and end must be numbers', 'error');
            return;
        }

        // Limit iterations to prevent infinite loops
        const maxIterations = 1000;
        const step = start <= end ? 1 : -1;
        let iterations = 0;

        // Reset loop control flags
        this.loopBreak = false;
        this.loopContinue = false;

        for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
            if (++iterations > maxIterations) {
                this.appendOutput('Loop exceeded maximum iterations (1000)', 'error');
                break;
            }
            this.variables[varName] = String(i);
            this.executeCommandString(commands);

            // Check for #break
            if (this.loopBreak) {
                this.loopBreak = false;
                break;
            }
            // Check for #continue (just reset flag, loop continues normally)
            if (this.loopContinue) {
                this.loopContinue = false;
            }
        }
    }

    // #foreach {list} {variable} {commands}
    // Iterates over a list (semicolon-separated or brace-separated)
    // Reference: https://tintin.mudhalla.net/manual/foreach.php
    cmdForeach(args, rest) {
        if (args.length < 3) {
            this.appendOutput('Usage: #foreach {list} {variable} {commands}', 'error');
            return;
        }

        const listStr = this.substituteVariables(args[0]);
        const varName = args[1];
        const commands = args[2];

        // Parse the list - can be semicolon-separated or brace-separated
        let items = [];

        if (listStr.includes('{') && listStr.includes('}')) {
            // Brace-separated: {{bob}{tim}{kim}}
            const braceRegex = /\{([^{}]*)\}/g;
            let match;
            while ((match = braceRegex.exec(listStr)) !== null) {
                items.push(match[1]);
            }
        }

        // If no brace items found, try semicolon-separated
        if (items.length === 0) {
            items = listStr.split(';').map(s => s.trim()).filter(s => s.length > 0);
        }

        if (items.length === 0) {
            // Empty list, nothing to iterate
            return;
        }

        // Limit iterations to prevent infinite loops
        const maxIterations = 1000;
        let iterations = 0;

        // Reset loop control flags
        this.loopBreak = false;
        this.loopContinue = false;

        for (const item of items) {
            if (++iterations > maxIterations) {
                this.appendOutput('Foreach exceeded maximum iterations (1000)', 'error');
                break;
            }
            this.variables[varName] = String(item);  // Ensure string storage
            this.executeCommandString(commands);

            // Check for #break
            if (this.loopBreak) {
                this.loopBreak = false;
                break;
            }
            // Check for #continue (just reset flag, loop continues normally)
            if (this.loopContinue) {
                this.loopContinue = false;
            }
        }
    }

    // #list {variable} {option} [argument]
    // Manages list variables with TinTin++ compatible operations
    // Reference: https://tintin.mudhalla.net/manual/list.php
    cmdList(args, rest) {
        if (args.length < 2) {
            this.appendOutput('Usage: #list {variable} {option} [argument]', 'error');
            this.appendOutput('Options: add, clear, create, delete, find, get, insert, set, size, sort, reverse, shuffle', 'system');
            return;
        }

        const varName = args[0];
        const option = args[1].toLowerCase();

        // Helper: ensure variable is an array (stored as object for TinTin++ compatibility)
        const ensureList = () => {
            if (this.variables[varName] === undefined) {
                this.variables[varName] = {};
            } else if (typeof this.variables[varName] !== 'object') {
                // Convert simple value to single-element list
                this.variables[varName] = { 1: this.variables[varName] };
            }
            return this.variables[varName];
        };

        // Helper: convert list object to array (values only)
        const toArray = (obj) => {
            if (typeof obj !== 'object' || obj === null) return [];
            // Get keys sorted numerically
            const keys = Object.keys(obj).map(k => parseInt(k)).filter(k => !isNaN(k)).sort((a, b) => a - b);
            return keys.map(k => obj[k]);
        };

        // Helper: convert array back to 1-indexed object
        const fromArray = (arr) => {
            const obj = {};
            arr.forEach((val, idx) => {
                obj[idx + 1] = val;
            });
            return obj;
        };

        // Helper: resolve index (1-based, negative from end)
        const resolveIndex = (idx, len) => {
            let i = parseInt(idx);
            if (isNaN(i)) return -1;
            if (i > 0) return i - 1;  // Convert 1-based to 0-based
            if (i < 0) return len + i;  // Negative from end
            return -1;
        };

        switch (option) {
            case 'add': {
                // #list {var} add {item1} {item2} ...
                const list = ensureList();
                const arr = toArray(list);
                for (let i = 2; i < args.length; i++) {
                    const item = this.substituteVariables(args[i]);
                    // Items can be semicolon-separated
                    item.split(';').forEach(subItem => {
                        if (subItem.trim()) arr.push(subItem.trim());
                    });
                }
                this.variables[varName] = fromArray(arr);
                break;
            }

            case 'clear': {
                // #list {var} clear
                this.variables[varName] = {};
                break;
            }

            case 'create': {
                // #list {var} create {item1} {item2} ...
                const arr = [];
                for (let i = 2; i < args.length; i++) {
                    const item = this.substituteVariables(args[i]);
                    // Items can be semicolon-separated
                    item.split(';').forEach(subItem => {
                        if (subItem.trim()) arr.push(subItem.trim());
                    });
                }
                this.variables[varName] = fromArray(arr);
                break;
            }

            case 'delete': {
                // #list {var} delete {index}
                if (args.length < 3) {
                    this.appendOutput('Usage: #list {var} delete {index}', 'error');
                    return;
                }
                const list = ensureList();
                const arr = toArray(list);
                const idx = resolveIndex(args[2], arr.length);
                if (idx >= 0 && idx < arr.length) {
                    arr.splice(idx, 1);
                    this.variables[varName] = fromArray(arr);
                }
                break;
            }

            case 'find': {
                // #list {var} find {item} {result_var}
                if (args.length < 4) {
                    this.appendOutput('Usage: #list {var} find {item} {result_var}', 'error');
                    return;
                }
                const list = ensureList();
                const arr = toArray(list);
                const searchItem = this.substituteVariables(args[2]);
                const resultVar = args[3];
                const foundIdx = arr.findIndex(item => item === searchItem);
                // Return 1-based index, or 0 if not found
                this.variables[resultVar] = foundIdx >= 0 ? foundIdx + 1 : 0;
                break;
            }

            case 'get': {
                // #list {var} get {index} {result_var}
                if (args.length < 4) {
                    this.appendOutput('Usage: #list {var} get {index} {result_var}', 'error');
                    return;
                }
                const list = ensureList();
                const arr = toArray(list);
                const idx = resolveIndex(args[2], arr.length);
                const resultVar = args[3];
                if (idx >= 0 && idx < arr.length) {
                    this.variables[resultVar] = arr[idx];
                } else {
                    this.variables[resultVar] = '';
                }
                break;
            }

            case 'insert': {
                // #list {var} insert {index} {item}
                if (args.length < 4) {
                    this.appendOutput('Usage: #list {var} insert {index} {item}', 'error');
                    return;
                }
                const list = ensureList();
                const arr = toArray(list);
                let idx = resolveIndex(args[2], arr.length + 1);  // +1 allows inserting at end
                const item = this.substituteVariables(args[3]);
                if (idx < 0) idx = 0;
                if (idx > arr.length) idx = arr.length;
                arr.splice(idx, 0, item);
                this.variables[varName] = fromArray(arr);
                break;
            }

            case 'set': {
                // #list {var} set {index} {item}
                if (args.length < 4) {
                    this.appendOutput('Usage: #list {var} set {index} {item}', 'error');
                    return;
                }
                const list = ensureList();
                const arr = toArray(list);
                const idx = resolveIndex(args[2], arr.length);
                const item = this.substituteVariables(args[3]);
                if (idx >= 0 && idx < arr.length) {
                    arr[idx] = item;
                    this.variables[varName] = fromArray(arr);
                }
                break;
            }

            case 'size': {
                // #list {var} size {result_var}
                if (args.length < 3) {
                    this.appendOutput('Usage: #list {var} size {result_var}', 'error');
                    return;
                }
                const list = this.variables[varName];
                const resultVar = args[2];
                if (typeof list === 'object' && list !== null) {
                    this.variables[resultVar] = Object.keys(list).length;
                } else if (list !== undefined) {
                    this.variables[resultVar] = 1;
                } else {
                    this.variables[resultVar] = 0;
                }
                break;
            }

            case 'sort': {
                // #list {var} sort - Sort alphabetically
                const list = ensureList();
                const arr = toArray(list);
                arr.sort((a, b) => String(a).localeCompare(String(b)));
                this.variables[varName] = fromArray(arr);
                break;
            }

            case 'order': {
                // #list {var} order - Sort alphanumerically (numbers before letters)
                const list = ensureList();
                const arr = toArray(list);
                arr.sort((a, b) => {
                    const numA = parseFloat(a);
                    const numB = parseFloat(b);
                    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
                    if (!isNaN(numA)) return -1;
                    if (!isNaN(numB)) return 1;
                    return String(a).localeCompare(String(b));
                });
                this.variables[varName] = fromArray(arr);
                break;
            }

            case 'reverse': {
                // #list {var} reverse
                const list = ensureList();
                const arr = toArray(list);
                arr.reverse();
                this.variables[varName] = fromArray(arr);
                break;
            }

            case 'shuffle': {
                // #list {var} shuffle
                const list = ensureList();
                const arr = toArray(list);
                // Fisher-Yates shuffle
                for (let i = arr.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [arr[i], arr[j]] = [arr[j], arr[i]];
                }
                this.variables[varName] = fromArray(arr);
                break;
            }

            case 'collapse': {
                // #list {var} collapse {result_var} - Turn list into semicolon-separated string
                if (args.length < 3) {
                    this.appendOutput('Usage: #list {var} collapse {result_var}', 'error');
                    return;
                }
                const list = ensureList();
                const arr = toArray(list);
                const resultVar = args[2];
                this.variables[resultVar] = arr.join(';');
                break;
            }

            case 'explode': {
                // #list {var} explode {string_var} - Turn string into list
                if (args.length < 3) {
                    this.appendOutput('Usage: #list {var} explode {string_var}', 'error');
                    return;
                }
                const stringVal = this.substituteVariables('$' + args[2]);
                const arr = stringVal.split(';').map(s => s.trim()).filter(s => s.length > 0);
                this.variables[varName] = fromArray(arr);
                break;
            }

            case 'tokenize': {
                // #list {var} tokenize {string} - Turn string into character list
                if (args.length < 3) {
                    this.appendOutput('Usage: #list {var} tokenize {string}', 'error');
                    return;
                }
                const str = this.substituteVariables(args[2]);
                const arr = str.split('');
                this.variables[varName] = fromArray(arr);
                break;
            }

            default:
                this.appendOutput(`Unknown list option: ${option}`, 'error');
                this.appendOutput('Options: add, clear, create, delete, find, get, insert, set, size, sort, order, reverse, shuffle, collapse, explode, tokenize', 'system');
        }
    }

    // #prompt {text} {new text} {row} {col}
    // Captures prompts and displays them in the split screen status area
    // Reference: https://tintin.mudhalla.net/manual/prompt.php
    cmdPrompt(args) {
        if (args.length < 1) {
            // List existing prompts
            if (this.prompts.length === 0) {
                this.appendOutput('No prompts defined.', 'system');
            } else {
                this.appendOutput('Prompts:', 'system');
                this.prompts.forEach(p => {
                    const rowInfo = p.row !== undefined ? ` row:${p.row}` : '';
                    const colInfo = p.col !== undefined ? ` col:${p.col}` : '';
                    this.appendOutput(`  ${p.pattern} → ${p.replacement || '(original)'}${rowInfo}${colInfo}`, 'system');
                });
            }
            return;
        }

        const pattern = args[0];
        const replacement = args[1] || '';  // Empty means display original
        const row = args[2] !== undefined ? parseInt(args[2]) : -2;  // Default row -2
        const col = args[3] !== undefined ? parseInt(args[3]) : undefined;

        // Check if prompt already exists with same pattern
        const existing = this.prompts.findIndex(p => p.pattern === pattern);
        if (existing >= 0) {
            this.prompts[existing] = {
                ...this.prompts[existing],
                replacement,
                row: isNaN(row) ? -2 : row,
                col: col
            };
            this.appendOutput(`Prompt updated: ${pattern}`, 'system');
        } else {
            this.prompts.push({
                id: this.generateId(),
                pattern,
                matchType: 'tintin',
                replacement,
                row: isNaN(row) ? -2 : row,
                col: col,
                enabled: true
            });
            this.appendOutput(`Prompt created: ${pattern}`, 'system');
        }

        // Send prompts to server for processing (like triggers)
        this.savePrompts();
    }

    // #unprompt {pattern} - Remove a prompt
    cmdUnprompt(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #unprompt {pattern}', 'error');
            return;
        }

        const pattern = args[0];
        const index = this.prompts.findIndex(p => p.pattern === pattern);
        if (index >= 0) {
            this.prompts.splice(index, 1);
            this.appendOutput(`Prompt removed: ${pattern}`, 'system');
            this.savePrompts();
        } else {
            this.appendOutput(`Prompt not found: ${pattern}`, 'error');
        }
    }

    // Save prompts to server (similar to triggers)
    async savePrompts() {
        // For now, prompts are stored client-side only
        // Server-side processing would require updating server.js
        // Store in localStorage as a backup
        try {
            localStorage.setItem('wmt_prompts', JSON.stringify(this.prompts));
        } catch (e) {
            console.error('Failed to save prompts:', e);
        }

        // Also send to connection if available
        if (this.connection && this.connection.isConnected()) {
            this.connection.send('set_prompts', { prompts: this.prompts });
        }
    }

    // Load prompts from storage
    loadPrompts() {
        try {
            const stored = localStorage.getItem('wmt_prompts');
            if (stored) {
                this.prompts = JSON.parse(stored);
            }
        } catch (e) {
            console.error('Failed to load prompts:', e);
        }
    }

    // #pathdir {dir} {reversed dir} {coord}
    // Defines direction mappings for speedwalk
    // Reference: https://tintin.mudhalla.net/manual/pathdir.php
    cmdPathdir(args) {
        if (args.length < 1) {
            // List all pathdirs
            this.appendOutput('Pathdirs:', 'system');
            Object.entries(this.pathdirs).forEach(([dir, info]) => {
                this.appendOutput(`  ${dir} ↔ ${info.reverse} (coord: ${info.coord})`, 'system');
            });
            return;
        }

        if (args.length < 3) {
            this.appendOutput('Usage: #pathdir {dir} {reversed dir} {coord}', 'error');
            return;
        }

        const dir = args[0].toLowerCase();
        const reverse = args[1].toLowerCase();
        const coord = parseInt(args[2]);

        if (isNaN(coord)) {
            this.appendOutput('Coordinate must be a number', 'error');
            return;
        }

        this.pathdirs[dir] = { reverse, coord };
        this.appendOutput(`Pathdir set: ${dir} ↔ ${reverse} (coord: ${coord})`, 'system');
    }

    // #unpathdir {dir} - Remove a pathdir
    cmdUnpathdir(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #unpathdir {dir}', 'error');
            return;
        }

        const dir = args[0].toLowerCase();
        if (this.pathdirs[dir]) {
            delete this.pathdirs[dir];
            this.appendOutput(`Pathdir removed: ${dir}`, 'system');
        } else {
            this.appendOutput(`Pathdir not found: ${dir}`, 'error');
        }
    }

    // #config {option} {value} - Set configuration options
    // Reference: https://tintin.mudhalla.net/manual/config.php
    cmdConfig(args) {
        if (args.length < 1) {
            // Show current config
            this.appendOutput('Configuration:', 'system');
            this.appendOutput(`  SPEEDWALK: ${this.speedwalkEnabled ? 'ON' : 'OFF'}`, 'system');
            return;
        }

        const option = args[0].toUpperCase();
        const value = args.length > 1 ? args[1].toUpperCase() : null;

        switch (option) {
            case 'SPEEDWALK':
                if (value === 'ON' || value === '1' || value === 'TRUE') {
                    this.speedwalkEnabled = true;
                    this.appendOutput('Speedwalk enabled', 'system');
                } else if (value === 'OFF' || value === '0' || value === 'FALSE') {
                    this.speedwalkEnabled = false;
                    this.appendOutput('Speedwalk disabled', 'system');
                } else if (value === null) {
                    this.appendOutput(`SPEEDWALK: ${this.speedwalkEnabled ? 'ON' : 'OFF'}`, 'system');
                } else {
                    this.appendOutput('Usage: #config {SPEEDWALK} {ON|OFF}', 'error');
                }
                break;

            default:
                this.appendOutput(`Unknown config option: ${option}`, 'error');
                this.appendOutput('Available options: SPEEDWALK', 'system');
        }
    }

    // Expand speedwalk notation (e.g., "3n2e" -> "n;n;n;e;e")
    expandSpeedwalk(input) {
        if (!this.speedwalkEnabled) return null;

        // Check if this looks like a speedwalk command
        // Must contain only digits and valid direction letters
        const validDirs = Object.keys(this.pathdirs).sort((a, b) => b.length - a.length);
        const dirPattern = validDirs.map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

        // Pattern: optional digit(s) followed by direction, repeated
        const speedwalkRegex = new RegExp(`^(\\d*(${dirPattern}))+$`, 'i');

        if (!speedwalkRegex.test(input)) return null;

        // Parse and expand
        const commands = [];
        let remaining = input.toLowerCase();

        while (remaining.length > 0) {
            // Extract optional count
            const countMatch = remaining.match(/^(\d+)/);
            let count = 1;
            if (countMatch) {
                count = parseInt(countMatch[1]);
                remaining = remaining.substring(countMatch[0].length);
            }

            // Find the longest matching direction
            let foundDir = null;
            for (const dir of validDirs) {
                if (remaining.startsWith(dir)) {
                    foundDir = dir;
                    break;
                }
            }

            if (!foundDir) {
                // Not a valid speedwalk, return null
                return null;
            }

            // Add the direction 'count' times
            for (let i = 0; i < count; i++) {
                commands.push(foundDir);
            }

            remaining = remaining.substring(foundDir.length);
        }

        return commands.length > 0 ? commands.join(';') : null;
    }

    // #format {variable} {format} [args...] - Format a string (TinTin++ compatible)
    // Specifiers: %s string, %d int, %f float, %m math, %g grouping, %u upper, %l lower,
    // %n capitalize, %r reverse, %p strip spaces, %t time, %a/%c char, %A char value,
    // %x/%X hex, %D hex2dec, %L length, %T epoch, %U microseconds, %H hash, %M metric
    // Padding: %+9s (pre-pad), %-9s (post-pad), %.8s (max length)
    cmdFormat(args) {
        if (args.length < 2) {
            this.appendOutput('Usage: #format {variable} {format} [args...]', 'error');
            return;
        }

        const { name: varName, keys: varKeys } = this.parseVariableName(args[0]);
        let format = args[1];
        let argIndex = 2;

        // Helper to get next argument
        const getArg = () => {
            if (argIndex < args.length) {
                return this.substituteVariables(args[argIndex++]);
            }
            return '';
        };

        // Process format specifiers with optional padding: %+9s, %-9s, %.8s, %9s
        format = format.replace(/%([+\-]?)(\d*)(?:\.(\d+))?(\d+|[sdcfxXaAmMgulnrphDLTUH%])/g, (match, padDir, padWidth, maxLen, spec) => {
            // Handle %% escape
            if (spec === '%') return '%';

            // Handle positional args like %1, %2
            if (/^\d+$/.test(spec)) {
                const idx = parseInt(spec) + 1; // %1 = args[2]
                let val = args[idx] !== undefined ? this.substituteVariables(args[idx]) : '';
                return this.applyFormatPadding(val, padDir, padWidth, maxLen);
            }

            let val = getArg();
            let result;

            switch (spec) {
                case 's': // String
                    result = String(val);
                    break;
                case 'd': // Integer
                    result = String(parseInt(val) || 0);
                    break;
                case 'f': // Float
                    result = String(parseFloat(val) || 0);
                    break;
                case 'm': // Math expression
                    try {
                        result = String(this.evaluateMathExpression(val));
                    } catch (e) {
                        result = '0';
                    }
                    break;
                case 'g': // Thousand grouping (1234567 -> 1,234,567)
                    const num = parseFloat(val) || 0;
                    result = num.toLocaleString('en-US');
                    break;
                case 'u': // Uppercase
                    result = String(val).toUpperCase();
                    break;
                case 'l': // Lowercase
                    result = String(val).toLowerCase();
                    break;
                case 'n': // Capitalize first letter
                    result = String(val).charAt(0).toUpperCase() + String(val).slice(1).toLowerCase();
                    break;
                case 'r': // Reverse string
                    result = String(val).split('').reverse().join('');
                    break;
                case 'p': // Strip leading/trailing spaces
                    result = String(val).trim();
                    break;
                case 'h': // Header line (fill with dashes)
                    const hdrLen = parseInt(padWidth) || 78;
                    const hdrText = String(val);
                    if (hdrText) {
                        const side = Math.floor((hdrLen - hdrText.length - 2) / 2);
                        result = '-'.repeat(Math.max(0, side)) + ' ' + hdrText + ' ' + '-'.repeat(Math.max(0, side));
                    } else {
                        result = '-'.repeat(hdrLen);
                    }
                    break;
                case 'a': // Character from charset value (same as %c)
                case 'c': // Character from value
                    result = String.fromCharCode(parseInt(val) || 0);
                    break;
                case 'A': // Character's numeric value
                    result = String(val).charCodeAt(0) || 0;
                    break;
                case 'x': // Decimal to hex (lowercase)
                    result = (parseInt(val) || 0).toString(16);
                    break;
                case 'X': // Decimal to hex (uppercase)
                    result = (parseInt(val) || 0).toString(16).toUpperCase();
                    break;
                case 'D': // Hex to decimal
                    result = String(parseInt(val, 16) || 0);
                    break;
                case 'L': // String length
                    result = String(String(val).length);
                    break;
                case 'T': // Current epoch time (seconds)
                    result = String(Math.floor(Date.now() / 1000));
                    break;
                case 'U': // Current epoch time (microseconds)
                    result = String(Date.now() * 1000);
                    break;
                case 'H': // 64-bit hash of string
                    result = String(this.simpleHash(String(val)));
                    break;
                case 'M': // Metric format (1000 -> 1K, 1000000 -> 1M)
                    result = this.formatMetric(parseFloat(val) || 0);
                    break;
                case 't': // Time format (strftime-like)
                    result = this.formatTime(val);
                    break;
                default:
                    result = val;
            }

            return this.applyFormatPadding(String(result), padDir, padWidth, maxLen);
        });

        this.setNestedVariable(varName, varKeys, format);
        this.appendOutput(`#format: $${args[0]} = ${format}`, 'system');
    }

    // Apply padding to formatted value
    applyFormatPadding(val, padDir, padWidth, maxLen) {
        let result = val;

        // Apply max length truncation first
        if (maxLen) {
            result = result.substring(0, parseInt(maxLen));
        }

        // Apply padding
        if (padWidth) {
            const width = parseInt(padWidth);
            if (padDir === '-') {
                // Post-pad (left align)
                result = result.padEnd(width);
            } else {
                // Pre-pad (right align) - default or '+'
                result = result.padStart(width);
            }
        }

        return result;
    }

    // Simple hash function for %H
    simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }

    // Format number in metric notation for %M
    formatMetric(num) {
        const units = ['', 'K', 'M', 'G', 'T', 'P'];
        let unitIndex = 0;
        let value = Math.abs(num);

        while (value >= 1000 && unitIndex < units.length - 1) {
            value /= 1000;
            unitIndex++;
        }

        const formatted = value.toFixed(value < 10 && unitIndex > 0 ? 1 : 0);
        return (num < 0 ? '-' : '') + formatted + units[unitIndex];
    }

    // Format time for %t (simplified strftime)
    formatTime(formatStr) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');

        return formatStr
            .replace(/%Y/g, now.getFullYear())
            .replace(/%y/g, String(now.getFullYear()).slice(-2))
            .replace(/%m/g, pad(now.getMonth() + 1))
            .replace(/%d/g, pad(now.getDate()))
            .replace(/%H/g, pad(now.getHours()))
            .replace(/%M/g, pad(now.getMinutes()))
            .replace(/%S/g, pad(now.getSeconds()))
            .replace(/%I/g, pad(now.getHours() % 12 || 12))
            .replace(/%p/g, now.getHours() >= 12 ? 'PM' : 'AM')
            .replace(/%A/g, ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()])
            .replace(/%a/g, ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getDay()])
            .replace(/%B/g, ['January','February','March','April','May','June','July','August','September','October','November','December'][now.getMonth()])
            .replace(/%b/g, ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][now.getMonth()])
            .replace(/%j/g, String(Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000)).padStart(3, '0'))
            .replace(/%W/g, pad(Math.floor((now - new Date(now.getFullYear(), 0, 1)) / 604800000)))
            .replace(/%w/g, now.getDay())
            .replace(/%Z/g, Intl.DateTimeFormat().resolvedOptions().timeZone)
            .replace(/%%/g, '%');
    }

    // #replace {variable} {old} {new} - Replace text in variable
    // Supports nested variables: #replace {hp[label]} {HP} {Health}
    cmdReplace(args) {
        if (args.length < 3) {
            this.appendOutput('Usage: #replace {variable} {old} {new}', 'error');
            return;
        }

        const { name, keys } = this.parseVariableName(args[0]);
        const oldText = this.substituteVariables(args[1]);
        const newText = this.substituteVariables(args[2]);

        // Get the current value
        const currentVal = keys.length > 0
            ? this.getNestedVariable(name, keys)
            : this.variables[name];

        if (currentVal === undefined) {
            this.appendOutput(`Variable not found: $${args[0]}`, 'error');
            return;
        }

        const original = String(currentVal);
        const replaced = original.split(oldText).join(newText);
        this.setNestedVariable(name, keys, replaced);
        this.appendOutput(`#replace: $${args[0]} = ${replaced}`, 'system');
    }

    // #split {top} [bottom] - Create split screen areas
    cmdSplit(args) {
        let top = 0;
        let bottom = 0;

        if (args.length >= 1) {
            top = parseInt(args[0]) || 0;
        }
        if (args.length >= 2) {
            bottom = parseInt(args[1]) || 0;
        }

        // Limit to reasonable values
        top = Math.max(0, Math.min(top, 20));
        bottom = Math.max(0, Math.min(bottom, 20));

        this.splitConfig = { top, bottom };

        // Initialize row content arrays
        this.splitRows.top = Array(top).fill('');
        this.splitRows.bottom = Array(bottom).fill('');

        // Render the split areas
        this.renderSplit();

        if (top > 0 || bottom > 0) {
            this.appendOutput(`Split screen: ${top} top rows, ${bottom} bottom rows`, 'system');
        } else {
            this.appendOutput('Split screen disabled', 'system');
        }
    }

    // #unsplit - Remove split screen
    cmdUnsplit() {
        this.splitConfig = { top: 0, bottom: 0 };
        this.splitRows = { top: [], bottom: [] };
        this.renderSplit();
        this.appendOutput('Split screen removed', 'system');
    }

    // Render the split screen areas
    renderSplit() {
        const topArea = document.getElementById('split-top');
        const bottomArea = document.getElementById('split-bottom');

        if (!topArea || !bottomArea) return;

        // Top split area
        if (this.splitConfig.top > 0) {
            topArea.classList.add('active');
            topArea.innerHTML = '';
            for (let i = 0; i < this.splitConfig.top; i++) {
                const row = document.createElement('div');
                row.className = 'split-row';
                row.id = `split-row-top-${i}`;
                row.innerHTML = this.ansiToHtml(this.splitRows.top[i] || '');
                topArea.appendChild(row);
            }
        } else {
            topArea.classList.remove('active');
            topArea.innerHTML = '';
        }

        // Bottom split area
        if (this.splitConfig.bottom > 0) {
            bottomArea.classList.add('active');
            bottomArea.innerHTML = '';
            for (let i = 0; i < this.splitConfig.bottom; i++) {
                const row = document.createElement('div');
                row.className = 'split-row';
                row.id = `split-row-bottom-${i}`;
                row.innerHTML = this.ansiToHtml(this.splitRows.bottom[i] || '');
                bottomArea.appendChild(row);
            }
        } else {
            bottomArea.classList.remove('active');
            bottomArea.innerHTML = '';
        }
    }

    // Update a specific row in the split screen
    // Positive rows (1, 2, 3...) are in top area
    // Negative rows (-1, -2, -3...) are in bottom area (from bottom up)
    updateSplitRow(row, content) {
        if (row > 0 && row <= this.splitConfig.top) {
            // Top area (1-indexed)
            const index = row - 1;
            this.splitRows.top[index] = content;
            const rowEl = document.getElementById(`split-row-top-${index}`);
            if (rowEl) {
                rowEl.innerHTML = this.ansiToHtml(content);
            }
        } else if (row < 0 && Math.abs(row) <= this.splitConfig.bottom) {
            // Bottom area (negative, -1 is first bottom row)
            const index = Math.abs(row) - 1;
            this.splitRows.bottom[index] = content;
            const rowEl = document.getElementById(`split-row-bottom-${index}`);
            if (rowEl) {
                rowEl.innerHTML = this.ansiToHtml(content);
            }
        }
    }

    closeModal() {
        document.querySelectorAll('.modal-overlay').forEach(modal => {
            modal.classList.remove('open');
        });
        this.editingItem = null;
    }

    generateId() {
        return Math.random().toString(36).substr(2, 9);
    }

    // Parse commands separated by semicolons or newlines, respecting brace depth
    parseCommands(str) {
        const commands = [];
        let current = '';
        let braceDepth = 0;

        for (let i = 0; i < str.length; i++) {
            const char = str[i];
            if (char === '{') {
                braceDepth++;
                current += char;
            } else if (char === '}') {
                braceDepth--;
                current += char;
            } else if ((char === ';' || char === '\n' || char === '\r') && braceDepth === 0) {
                // Split on semicolons or newlines outside of braces
                if (current.trim()) commands.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        if (current.trim()) commands.push(current.trim());
        return commands;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    try {
        window.wmtClient = new WMTClient();
    } catch (e) {
        console.error('Client initialization failed:', e);
    }
});
