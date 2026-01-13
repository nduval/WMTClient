/**
 * WMT Client - Main Application
 */

class WMTClient {
    constructor() {
        this.connection = null;
        this.commandHistory = [];
        this.historyIndex = -1;
        this.maxHistorySize = 100;
        this.triggers = [];
        this.aliases = [];
        this.classes = [];
        this.preferences = {};
        this.currentPanel = null;
        this.editingItem = null;
        this.characterPassword = '';
        this.passwordSent = false;

        // Tickers and delays (client-side only)
        this.tickers = {};  // {name: {command, interval, timerId}}
        this.delays = {};   // {name: {command, timerId}}

        // Variables for #var/#unvar (TinTin++ style)
        this.variables = {};

        // MIP (MUD Interface Protocol) state
        this.mipEnabled = false;
        this.mipStarted = false;  // Tracks if MIP has been started this session
        this.mipId = null;
        this.mipVersion = '1.0.0';
        this.mipDebug = false;

        // Smart auto-scroll state
        this.userScrolledUp = false;  // Tracks if user manually scrolled up

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

        // Split screen configuration (TinTin++ #split)
        this.splitConfig = { top: 0, bottom: 0 };
        this.splitRows = { top: [], bottom: [] };

        // Chat window state
        this.chatWindowOpen = false;
        this.chatWindowMode = 'floating'; // 'docked', 'floating', 'popout'
        this.chatPopoutWindow = null;
        this.chatDragOffset = { x: 0, y: 0 };
        this.chatIsDragging = false;

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
            }

            // Load character password for auto-login
            const pwRes = await fetch('api/characters.php?action=get_password');
            const pwData = await pwRes.json();
            if (pwData.success && pwData.password) {
                this.characterPassword = pwData.password;
            }

            // Load MIP conditions
            await this.loadMipConditions();
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

    // Send filtered triggers and aliases to server
    sendFilteredTriggersAndAliases() {
        this.connection.setTriggers(this.getFilteredTriggers());
        this.connection.setAliases(this.getFilteredAliases());
    }

    setupConnection() {
        // Use configured WebSocket URL or fall back to default
        const wsUrl = window.WMT_CONFIG?.wsUrl || `ws://${window.location.hostname}:8080`;

        this.connection = new MudConnection({
            wsUrl: wsUrl,
            onConnect: () => this.onConnect(),
            onDisconnect: () => this.onDisconnect(),
            onMessage: (data) => this.onMessage(data),
            onError: (error) => this.onError(error),
            onStatusChange: (status) => this.updateConnectionStatus(status)
        });

        this.connection.connect();
    }

    onConnect() {
        this.appendOutput('Connected to WebSocket server.', 'system');
        this.passwordSent = false; // Reset for new connection
        this.mipStarted = false; // Reset MIP flag

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

    onDisconnect() {
        this.appendOutput('Disconnected from server.', 'system');
        this.mipReady = false;  // Reset so conditions don't fire on stale data after reconnect
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
                if (!this.mipStarted && this.preferences.mipEnabled !== false && data.line) {
                    // Linkdeath recovery - character is already in world, use shorter delay
                    if (data.line.includes('welcomes you back from linkdeath')) {
                        this.mipStarted = true;
                        setTimeout(() => {
                            this.enableMip();
                        }, 1000);
                    }
                    // Fresh login - wait until player leaves the stasis room (has "jump" exit)
                    // Exclude linkdeath messages that also contain welcome text
                    // Support both 3Kingdoms and 3Scapes
                    else if (!data.line.includes('linkdeath') &&
                             (data.line.includes('3Kingdoms welcomes you') ||
                              data.line.includes('entering 3Kingdoms') ||
                              data.line.includes('3Scapes welcomes you') ||
                              data.line.includes('entering 3Scapes'))) {
                        this.mipStarted = true;
                        this.mipPendingRealRoom = true;  // Wait for real room before enabling MIP
                    }
                }

                // Detect when player leaves the stasis room (fresh login only)
                // Stasis room only has "jump" exit - real rooms have other exits
                if (this.mipPendingRealRoom && !this.mipEnabled && data.line) {
                    // Detect the jump message or exits that aren't just "jump"
                    if (data.line.includes('you leap out of the Entrance room')) {
                        this.mipPendingRealRoom = false;
                        setTimeout(() => {
                            this.enableMip();
                        }, 500);
                    } else {
                        // Look for exits line that's NOT just "jump"
                        const exitsMatch = data.line.match(/Obvious exits?:\s*(.+)/i);
                        if (exitsMatch) {
                            const exits = exitsMatch[1].trim().toLowerCase();
                            // If exits are anything other than just "jump", we're in a real room
                            if (exits && exits !== 'jump' && exits !== 'jump.') {
                                this.mipPendingRealRoom = false;
                                setTimeout(() => {
                                    this.enableMip();
                                }, 500);
                            }
                        }
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

            case 'keepalive_ack':
                // Keepalive acknowledged
                break;

            case 'client_command':
                // Execute client-side # command from trigger
                if (data.command && data.command.startsWith('#')) {
                    this.processClientCommand(data.command);
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
                    this.appendChatMessage(data.message, data.chatType);
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

        // Guild lines
        const gline1 = document.getElementById('mip-gline1');
        const gline2 = document.getElementById('mip-gline2');
        if (gline1) gline1.innerHTML = stats.gline1 || '';
        if (gline2) gline2.innerHTML = stats.gline2 || '';

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

        // Populate dropdown
        baseOptions.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            varSelect.appendChild(option);
        });

        // Set default variable selection
        varSelect.value = defaultVar;

        // Clear any pending sub-conditions
        this.pendingSubConditions = [];
        this.renderSubConditions();

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
                        <button onclick="wmtClient.toggleMipCondition('${c.id}')">${c.enabled ? 'On' : 'Off'}</button>
                        <button class="delete" onclick="wmtClient.deleteMipCondition('${c.id}')">X</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    addMipCondition() {
        const variable = document.getElementById('mip-cond-variable').value;
        const operator = document.getElementById('mip-cond-operator').value;
        const value = document.getElementById('mip-cond-value').value;
        const command = document.getElementById('mip-cond-command').value.trim();

        if (!command) {
            this.appendOutput('Please enter a command to execute.', 'error');
            return;
        }

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
        this.saveMipConditions();

        // Clear inputs
        document.getElementById('mip-cond-command').value = '';
        this.pendingSubConditions = [];
        this.renderSubConditions();

        // Re-render
        if (this.currentConditionStat) {
            this.renderMipConditions(this.currentConditionStat);
        }

        // Build condition description for output
        let condDesc = `${variable} ${operator} ${value}`;
        if (condition.subConditions.length > 0) {
            condDesc += ' ' + condition.subConditions.map(s => `${s.logic} ${s.variable} ${s.operator} ${s.value}`).join(' ');
        }
        this.appendOutput(`Added condition: ${condDesc} -> ${command}`, 'system');
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
            this.setChatMode(this.chatWindowMode);
            document.getElementById('chat-toggle-btn')?.classList.add('active');
            this.clearChatNotification();
            // Focus chat input
            document.getElementById('chat-input')?.focus();
        } else {
            chatWindow.classList.add('hidden');
            document.querySelector('.terminal-area')?.classList.remove('chat-docked');
            document.getElementById('chat-toggle-btn')?.classList.remove('active');
        }
    }

    setChatMode(mode) {
        const chatWindow = document.getElementById('chat-window');
        const terminalArea = document.querySelector('.terminal-area');
        if (!chatWindow) return;

        // Remove all mode classes
        chatWindow.classList.remove('docked', 'floating');
        terminalArea?.classList.remove('chat-docked');

        // Update button states
        document.getElementById('chat-dock-btn')?.classList.remove('active');
        document.getElementById('chat-float-btn')?.classList.remove('active');

        this.chatWindowMode = mode;

        if (mode === 'docked') {
            chatWindow.classList.add('docked');
            terminalArea?.classList.add('chat-docked');
            document.getElementById('chat-dock-btn')?.classList.add('active');
            // Reset position for docked mode
            chatWindow.style.top = '';
            chatWindow.style.left = '';
        } else if (mode === 'floating') {
            chatWindow.classList.add('floating');
            document.getElementById('chat-float-btn')?.classList.add('active');
        }
    }

    appendChatMessage(message, chatType = 'channel') {
        // Append to chat window
        const chatOutput = document.getElementById('chat-output');
        if (chatOutput) {
            const line = document.createElement('div');
            line.className = `chat-line ${chatType}`;
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
        document.querySelector('.terminal-area')?.classList.remove('chat-docked');
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
        this.appendOutput('Error: ' + error, 'error');
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

        // Smart auto-scroll: scroll to bottom if enabled AND user hasn't scrolled up
        if (this.preferences.scrollOnOutput !== false && !this.userScrolledUp) {
            output.scrollTop = output.scrollHeight;
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

        const ansiColors = {
            '0': '</span>',
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

        return text.replace(/\x1b\[([0-9;]+)m/g, (match, codes) => {
            return codes.split(';').map(code => ansiColors[code] || '').join('');
        });
    }

    playSound(sound) {
        // Simple beep implementation
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            oscillator.frequency.value = 800;
            oscillator.type = 'sine';
            gainNode.gain.value = 0.1;

            oscillator.start();
            setTimeout(() => {
                oscillator.stop();
                audioContext.close();
            }, 100);
        } catch (e) {
            console.log('Could not play sound');
        }
    }

    bindEvents() {
        // Command input
        const input = document.getElementById('command-input');
        const sendBtn = document.getElementById('send-btn');
        const output = document.getElementById('mud-output');

        if (input) {
            input.addEventListener('keydown', (e) => this.handleInputKeydown(e));
        }

        if (sendBtn) {
            sendBtn.addEventListener('click', () => this.sendCommand());
        }

        // Smart auto-scroll: detect when user scrolls up manually
        if (output) {
            output.addEventListener('scroll', () => {
                // Check if user is near the bottom (within 50px)
                const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 50;
                this.userScrolledUp = !atBottom;
            });

            // Click anywhere on output to focus command input
            output.addEventListener('click', (e) => {
                // Don't focus if user is selecting text
                const selection = window.getSelection();
                if (selection && selection.toString().length > 0) return;

                // Focus the command input
                document.getElementById('command-input')?.focus();
            });
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
        document.getElementById('chat-dock-btn')?.addEventListener('click', () => this.setChatMode('docked'));
        document.getElementById('chat-float-btn')?.addEventListener('click', () => this.setChatMode('floating'));
        document.getElementById('chat-popout-btn')?.addEventListener('click', () => this.popOutChatWindow());
        document.getElementById('chat-close-btn')?.addEventListener('click', () => this.toggleChatWindow());
        document.getElementById('chat-send-btn')?.addEventListener('click', () => this.sendChatCommand());
        document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.sendChatCommand();
        });

        // Clear notification when chat input is focused
        document.getElementById('chat-input')?.addEventListener('focus', () => {
            this.clearChatNotification();
        });

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

        // MIP is now controlled via Settings panel, auto-enabled on connect

        // Scripts sidebar
        document.getElementById('scripts-sidebar-close')?.addEventListener('click', () => this.closeScriptsSidebar());
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

        // Match type help toggles
        document.getElementById('trigger-match-type')?.addEventListener('change', (e) => {
            const regexHelp = document.getElementById('trigger-regex-help');
            const tintinHelp = document.getElementById('trigger-tintin-help');
            if (regexHelp) regexHelp.style.display = e.target.value === 'regex' ? 'block' : 'none';
            if (tintinHelp) tintinHelp.style.display = e.target.value === 'tintin' ? 'block' : 'none';
        });

        document.getElementById('alias-match-type')?.addEventListener('change', () => {
            this.updateAliasHelp();
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

        // Add to history (only non-empty commands)
        if (command.trim()) {
            this.commandHistory.unshift(command);
            if (this.commandHistory.length > this.maxHistorySize) {
                this.commandHistory.pop();
            }
        }
        this.historyIndex = -1;

        // Echo command if enabled (show empty as just ">")
        if (this.preferences.echoCommands !== false) {
            this.appendOutput('> ' + command, 'command');
        }

        // Check for client-side # commands
        if (command.startsWith('#')) {
            this.processClientCommand(command);
        } else {
            // Send to server (empty commands are allowed - e.g., "press enter to continue")
            this.connection.sendCommand(command);
        }

        // Scroll to bottom and resume auto-scroll when sending a command
        this.userScrolledUp = false;
        const output = document.getElementById('mud-output');
        if (output) {
            output.scrollTop = output.scrollHeight;
        }

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

        const newIndex = this.historyIndex + direction;

        if (newIndex < -1) return;
        if (newIndex >= this.commandHistory.length) return;

        this.historyIndex = newIndex;

        if (this.historyIndex === -1) {
            input.value = '';
        } else {
            input.value = this.commandHistory[this.historyIndex];
        }

        // Move cursor to end
        input.setSelectionRange(input.value.length, input.value.length);
    }

    reconnect() {
        this.appendOutput('Attempting to reconnect...', 'system');
        // Reset flags so credentials will be sent again
        this.passwordSent = false;
        this.mipStarted = false;
        this.pendingReconnect = true;  // Flag to trigger credential send on reconnect
        this.connection.requestReconnect();
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

        // Add buttons at top
        html += `
            <div class="sidebar-add-buttons">
                <button class="btn btn-sm btn-secondary" onclick="wmtClient.openTriggerModal()">+ Trigger</button>
                <button class="btn btn-sm btn-secondary" onclick="wmtClient.openAliasModal()">+ Alias</button>
                <button class="btn btn-sm btn-secondary" onclick="wmtClient.openGagModal()">+ Gag</button>
                <button class="btn btn-sm btn-secondary" onclick="wmtClient.openHighlightModal()">+ Highlight</button>
            </div>
        `;

        // Render each class
        this.classes.forEach(cls => {
            const classTrigs = this.triggers.filter(t => t.class === cls.id);
            const classAliases = this.aliases.filter(a => a.class === cls.id);
            const itemCount = classTrigs.length + classAliases.length;
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
                        ${this.renderClassItems(classTrigs, classAliases)}
                    </div>
                </div>
            `;
        });

        // Render unassigned items
        const unassignedTrigs = this.triggers.filter(t => !t.class);
        const unassignedAliases = this.aliases.filter(a => !a.class);

        if (unassignedTrigs.length > 0 || unassignedAliases.length > 0) {
            html += `
                <div class="unassigned-section">
                    <div class="unassigned-header">Unassigned (${unassignedTrigs.length + unassignedAliases.length})</div>
                    ${this.renderClassItems(unassignedTrigs, unassignedAliases)}
                </div>
            `;
        }

        // Empty state
        if (this.classes.length === 0 && unassignedTrigs.length === 0 && unassignedAliases.length === 0) {
            html += `
                <div class="empty-state" style="padding: 20px;">
                    <p>No scripts yet.</p>
                    <p style="font-size: 0.85em;">Create triggers and aliases to automate your MUD experience.</p>
                </div>
            `;
        }

        content.innerHTML = html;
    }

    renderClassItems(triggers, aliases) {
        let html = '';

        triggers.forEach(t => {
            const isEnabled = t.enabled !== false;
            // Determine trigger type for icon
            const triggerType = this.getTriggerType(t);
            const iconMap = { gag: 'G', highlight: 'H', trigger: 'T' };
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

        return html;
    }

    // Determine the type of trigger for icon display
    getTriggerType(trigger) {
        if (!trigger.actions || trigger.actions.length === 0) return 'trigger';

        // Check what actions the trigger has
        const hasGag = trigger.actions.some(a => a.type === 'gag');
        const hasHighlight = trigger.actions.some(a => a.type === 'highlight');
        const hasCommand = trigger.actions.some(a => a.type === 'command');

        // If only gag action, it's a gag
        if (hasGag && !hasHighlight && !hasCommand) return 'gag';
        // If only highlight action, it's a highlight
        if (hasHighlight && !hasGag && !hasCommand) return 'highlight';
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
        document.getElementById('trigger-match-type').value = trigger?.matchType || 'contains';

        // Populate class dropdown
        const classSelect = document.getElementById('trigger-class');
        if (classSelect) {
            classSelect.innerHTML = this.renderClassOptions(trigger?.class);
        }

        // Show/hide pattern help based on match type
        const regexHelp = document.getElementById('trigger-regex-help');
        const tintinHelp = document.getElementById('trigger-tintin-help');
        if (regexHelp) regexHelp.style.display = (trigger?.matchType === 'regex') ? 'block' : 'none';
        if (tintinHelp) tintinHelp.style.display = (trigger?.matchType === 'tintin') ? 'block' : 'none';

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
        div.innerHTML = `
            <select class="action-type">
                <option value="command" ${action?.type === 'command' ? 'selected' : ''}>Send Command</option>
                <option value="highlight" ${action?.type === 'highlight' ? 'selected' : ''}>Highlight</option>
                <option value="gag" ${action?.type === 'gag' ? 'selected' : ''}>Gag (Hide)</option>
                <option value="sound" ${action?.type === 'sound' ? 'selected' : ''}>Play Sound</option>
            </select>
            <input type="text" class="action-value" placeholder="Value" value="${this.escapeHtml(action?.command || action?.color || '')}">
            <button type="button" class="btn btn-sm btn-danger remove-action">X</button>
        `;

        div.querySelector('.remove-action').addEventListener('click', () => div.remove());
        container.appendChild(div);
    }

    async saveTrigger() {
        const name = document.getElementById('trigger-name').value.trim();
        const pattern = document.getElementById('trigger-pattern').value.trim();
        const matchType = document.getElementById('trigger-match-type').value;
        const classId = document.getElementById('trigger-class')?.value || null;

        if (!pattern) {
            alert('Pattern is required');
            return;
        }

        // Validate regex if regex mode
        if (matchType === 'regex') {
            try {
                new RegExp(pattern);
            } catch (e) {
                alert('Invalid regular expression: ' + e.message);
                return;
            }
        }

        const actions = [];
        document.querySelectorAll('#trigger-actions .action-item').forEach(item => {
            const type = item.querySelector('.action-type').value;
            const value = item.querySelector('.action-value').value;

            const action = { type };
            if (type === 'command') action.command = value;
            if (type === 'highlight') action.color = value || '#ffff00';
            if (type === 'sound') action.sound = value || 'beep';

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
        document.getElementById('alias-match-type').value = alias?.matchType || 'exact';
        document.getElementById('alias-replacement').value = alias?.replacement || '';

        // Populate class dropdown
        const classSelect = document.getElementById('alias-class');
        if (classSelect) {
            classSelect.innerHTML = this.renderClassOptions(alias?.class);
        }

        // Update help text visibility
        this.updateAliasHelp();

        modal.classList.add('open');
    }

    updateAliasHelp() {
        const matchType = document.getElementById('alias-match-type')?.value;
        const simpleHelp = document.getElementById('alias-help-simple');
        const tintinHelp = document.getElementById('alias-help-tintin');
        const regexHelp = document.getElementById('alias-help-regex');

        if (simpleHelp) simpleHelp.style.display = 'none';
        if (tintinHelp) tintinHelp.style.display = 'none';
        if (regexHelp) regexHelp.style.display = 'none';

        if (matchType === 'regex') {
            if (regexHelp) regexHelp.style.display = 'block';
        } else if (matchType === 'tintin') {
            if (tintinHelp) tintinHelp.style.display = 'block';
        } else {
            if (simpleHelp) simpleHelp.style.display = 'block';
        }
    }

    // Open gag modal
    openGagModal(editIndex = null) {
        const modal = document.getElementById('gag-modal');
        if (!modal) return;

        this.editingGagIndex = editIndex;
        const existing = editIndex !== null ? this.triggers[editIndex] : null;

        // Populate form
        document.getElementById('gag-pattern').value = existing?.pattern || '';
        document.getElementById('gag-match-type').value = existing?.matchType || 'contains';

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
        const pattern = document.getElementById('gag-pattern').value.trim();
        const matchType = document.getElementById('gag-match-type').value;
        const classId = document.getElementById('gag-class')?.value || null;

        if (!pattern) {
            alert('Pattern is required');
            return;
        }

        if (this.editingGagIndex !== null) {
            // Update existing
            const trigger = this.triggers[this.editingGagIndex];
            trigger.pattern = pattern;
            trigger.matchType = matchType;
            trigger.name = `Gag: ${pattern.substring(0, 20)}`;
            trigger.class = classId || null;
            this.appendOutput(`Gag updated: ${pattern}`, 'system');
        } else {
            // Create new gag trigger
            const trigger = {
                id: this.generateId(),
                name: `Gag: ${pattern.substring(0, 20)}`,
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
        document.getElementById('highlight-match-type').value = existing?.matchType || 'contains';

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
        const matchType = document.getElementById('highlight-match-type').value;
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

    // Open ticker modal
    openTickerModal() {
        const modal = document.getElementById('ticker-modal');
        if (!modal) return;

        // Reset form
        document.getElementById('ticker-name').value = '';
        document.getElementById('ticker-command').value = '';
        document.getElementById('ticker-interval').value = '60';

        modal.classList.add('open');
    }

    // Save ticker from modal
    saveTicker() {
        const name = document.getElementById('ticker-name').value.trim();
        const command = document.getElementById('ticker-command').value.trim();
        const interval = parseFloat(document.getElementById('ticker-interval').value);

        if (!name) {
            alert('Name is required');
            return;
        }
        if (!command) {
            alert('Command is required');
            return;
        }
        if (isNaN(interval) || interval <= 0) {
            alert('Interval must be a positive number');
            return;
        }

        // Create ticker using existing command
        this.cmdTicker([name, command, interval.toString()]);
        this.closeModal();
    }

    async saveAlias() {
        const pattern = document.getElementById('alias-pattern').value.trim();
        const matchType = document.getElementById('alias-match-type').value;
        const replacement = document.getElementById('alias-replacement').value.trim();
        const classId = document.getElementById('alias-class')?.value || null;

        if (!pattern || !replacement) {
            alert('Pattern and replacement are required');
            return;
        }

        // Validate regex if regex mode
        if (matchType === 'regex') {
            try {
                new RegExp(pattern);
            } catch (e) {
                alert('Invalid regular expression: ' + e.message);
                return;
            }
        }

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
                    <input type="range" id="pref-font-size" min="10" max="24" value="${prefs.fontSize || 14}">
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
                <div class="settings-toggle">
                    <span class="settings-toggle-label">Retain Last Command</span>
                    <label class="settings-toggle-switch">
                        <input type="checkbox" id="pref-retain" ${prefs.retainLastCommand ? 'checked' : ''}>
                        <span class="settings-toggle-slider"></span>
                    </label>
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
            </div>

            <div class="settings-sticky-footer">
                <button class="btn btn-primary" id="save-settings-btn">
                    Save Settings
                </button>
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

        // Save settings
        document.getElementById('save-settings-btn')?.addEventListener('click', () => this.savePreferences());

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

    async savePreferences() {
        const saveBtn = document.getElementById('save-settings-btn');
        const originalText = saveBtn?.textContent;

        this.preferences = {
            fontFamily: document.getElementById('pref-font-family').value,
            fontSize: parseInt(document.getElementById('pref-font-size').value),
            textColor: document.getElementById('pref-text-color').value,
            backgroundColor: document.getElementById('pref-bg-color').value,
            echoCommands: document.getElementById('pref-echo').checked,
            scrollOnOutput: document.getElementById('pref-scroll').checked,
            retainLastCommand: document.getElementById('pref-retain').checked,
            mipEnabled: document.getElementById('pref-mip-enabled').checked,
            mipHpBar: document.getElementById('pref-mip-hpbar').checked,
            mipShowStatBars: document.getElementById('pref-mip-statbars')?.checked ?? true,
            mipShowGuild: document.getElementById('pref-mip-guild')?.checked ?? true,
            mipShowRoom: document.getElementById('pref-mip-room')?.checked ?? true,
            mipShowExits: document.getElementById('pref-mip-exits')?.checked ?? true,
            mipDebug: document.getElementById('pref-mip-debug')?.checked || false
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

            default:
                this.appendOutput(`Unknown command: #${cmdName}`, 'error');
        }
    }

    // #alias {pattern} {replacement}
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
        const replacement = args[1];

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
            // List triggers
            if (this.triggers.length === 0) {
                this.appendOutput('No triggers/actions defined.', 'system');
            } else {
                this.appendOutput('Triggers/Actions:', 'system');
                this.triggers.forEach(t => {
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
    cmdTicker(args) {
        if (args.length < 3) {
            // List tickers
            const names = Object.keys(this.tickers);
            if (names.length === 0) {
                this.appendOutput('No tickers running.', 'system');
            } else {
                this.appendOutput('Active tickers:', 'system');
                names.forEach(name => {
                    const t = this.tickers[name];
                    this.appendOutput(`  ${name}: ${t.command} (every ${t.interval}s)`, 'system');
                });
            }
            return;
        }

        const name = args[0];
        const command = args[1];
        const interval = parseFloat(args[2]);

        if (isNaN(interval) || interval < 0.1) {
            this.appendOutput('Interval must be at least 0.1 seconds', 'error');
            return;
        }

        // Stop existing ticker with same name
        if (this.tickers[name]) {
            clearInterval(this.tickers[name].timerId);
        }

        const timerId = setInterval(() => {
            this.connection.sendCommand(command);
        }, interval * 1000);

        this.tickers[name] = { command, interval, timerId };
        this.appendOutput(`Ticker started: ${name} (${command} every ${interval}s)`, 'system');
    }

    // #unticker {name}
    cmdUnticker(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #unticker {name}', 'error');
            return;
        }

        const name = args[0];
        if (this.tickers[name]) {
            clearInterval(this.tickers[name].timerId);
            delete this.tickers[name];
            this.appendOutput(`Ticker stopped: ${name}`, 'system');
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
            name = 'delay_' + Date.now();
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
            this.connection.sendCommand(command);
            delete this.delays[name];
        }, seconds * 1000);

        this.delays[name] = { command, timerId };
        this.appendOutput(`Delay set: ${command} in ${seconds}s`, 'system');
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
                if (cls) cls.enabled = enabled;
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
        this.appendOutput('  #unvar {name}       - Remove variable', 'system');
        this.appendOutput('  #math {var} {expr}  - Calculate and store result', 'system');
        this.appendOutput('  #format {var} {fmt} - Format string (like printf)', 'system');
        this.appendOutput('  #replace {var} {old} {new} - Replace text in variable', 'system');
        this.appendOutput('', 'system');
        this.appendOutput('Control Flow:', 'system');
        this.appendOutput('  #if {cond} {cmds}   - Conditional execution', 'system');
        this.appendOutput('  #loop {s} {e} {v} {cmds} - Loop from start to end', 'system');
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
        this.appendOutput('Other:', 'system');
        this.appendOutput('  #info [type]        - Show counts', 'system');
        this.appendOutput('  #nop {comment}      - Comment (ignored)', 'system');
        this.appendOutput('  #help               - Show this help', 'system');
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
        // Check for gag or highlight actions
        const hasGag = trigger.actions?.some(a => a.type === 'gag');
        const highlight = trigger.actions?.find(a => a.type === 'highlight');
        const command = trigger.actions?.find(a => a.type === 'command');

        if (hasGag && !command) {
            return `#gag {${trigger.pattern}}\n`;
        }
        if (highlight && !command && !hasGag) {
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

    // #var {name} {value} - Set a variable
    cmdVar(args) {
        if (args.length < 1) {
            // List all variables
            const vars = Object.keys(this.variables);
            if (vars.length === 0) {
                this.appendOutput('No variables defined.', 'system');
            } else {
                this.appendOutput('Variables:', 'system');
                vars.forEach(name => {
                    this.appendOutput(`  $${name} = ${this.variables[name]}`, 'system');
                });
            }
            return;
        }

        const name = args[0];
        if (args.length < 2) {
            // Show single variable
            if (this.variables[name] !== undefined) {
                this.appendOutput(`$${name} = ${this.variables[name]}`, 'system');
            } else {
                this.appendOutput(`Variable not found: $${name}`, 'error');
            }
            return;
        }

        const value = args[1];
        this.variables[name] = value;
        this.appendOutput(`Variable set: $${name} = ${value}`, 'system');
    }

    // #unvar {name} - Remove a variable
    cmdUnvar(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #unvar {name}', 'error');
            return;
        }

        const name = args[0];
        if (this.variables[name] !== undefined) {
            delete this.variables[name];
            this.appendOutput(`Variable removed: $${name}`, 'system');
        } else {
            this.appendOutput(`Variable not found: $${name}`, 'error');
        }
    }

    // #math {variable} {expression} - Calculate and store result
    cmdMath(args) {
        if (args.length < 2) {
            this.appendOutput('Usage: #math {variable} {expression}', 'error');
            return;
        }

        const varName = args[0];
        let expression = args[1];

        // Substitute variables in expression
        expression = this.substituteVariables(expression);

        try {
            // Safe math evaluation - only allow numbers and math operators
            // Remove anything that isn't a number, operator, parentheses, or space
            const safeExpr = expression.replace(/[^0-9+\-*/%().:\s]/g, '');

            // Handle TinTin++ style dice: 1d6, 2d10, etc
            const diceExpr = safeExpr.replace(/(\d+)d(\d+)/g, (match, count, sides) => {
                let total = 0;
                for (let i = 0; i < parseInt(count); i++) {
                    total += Math.floor(Math.random() * parseInt(sides)) + 1;
                }
                return total.toString();
            });

            // eslint-disable-next-line no-eval
            const result = eval(diceExpr);
            this.variables[varName] = result;
            this.appendOutput(`#math: $${varName} = ${result}`, 'system');
        } catch (e) {
            this.appendOutput(`Math error: ${e.message}`, 'error');
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

    // Evaluate a TinTin++ style condition
    evaluateCondition(condition) {
        if (!condition) return false;

        // Substitute variables
        let cond = this.substituteVariables(condition);

        // Handle TinTin++ comparison operators
        // == != < > <= >= are standard
        // Also handle string comparison
        try {
            // Replace TinTin++ operators with JS equivalents
            cond = cond.replace(/\band\b/gi, '&&');
            cond = cond.replace(/\bor\b/gi, '||');
            cond = cond.replace(/\bnot\b/gi, '!');

            // Safe evaluation - only allow comparison operations
            // eslint-disable-next-line no-eval
            return !!eval(cond);
        } catch (e) {
            // If eval fails, try string comparison
            const match = cond.match(/^["']?(.+?)["']?\s*(==|!=|<|>|<=|>=)\s*["']?(.+?)["']?$/);
            if (match) {
                const [, left, op, right] = match;
                const lnum = parseFloat(left);
                const rnum = parseFloat(right);
                const isNumeric = !isNaN(lnum) && !isNaN(rnum);

                switch (op) {
                    case '==': return isNumeric ? lnum === rnum : left === right;
                    case '!=': return isNumeric ? lnum !== rnum : left !== right;
                    case '<': return isNumeric ? lnum < rnum : left < right;
                    case '>': return isNumeric ? lnum > rnum : left > right;
                    case '<=': return isNumeric ? lnum <= rnum : left <= right;
                    case '>=': return isNumeric ? lnum >= rnum : left >= right;
                }
            }
            return false;
        }
    }

    // Substitute $variables in a string
    substituteVariables(str) {
        if (!str) return str;
        return str.replace(/\$(\w+)/g, (match, name) => {
            // Check TinTin++ variables first, then MIP variables
            if (this.variables[name] !== undefined) {
                return this.variables[name];
            }
            if (this.mipVars[name] !== undefined) {
                return this.mipVars[name];
            }
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

    // #showme/#show {message} [row] - Display message locally (or in split row)
    cmdShowme(args, rest) {
        if (args.length < 1 && !rest) {
            this.appendOutput('Usage: #showme {message} [row]', 'error');
            return;
        }

        let message = args[0] || rest;
        message = this.substituteVariables(message);

        // Check for row parameter (2nd arg or negative number in message)
        let row = null;
        if (args.length >= 2) {
            row = parseInt(args[1]);
        }

        if (row !== null && !isNaN(row) && (this.splitConfig.top > 0 || this.splitConfig.bottom > 0)) {
            // Display in split area
            this.updateSplitRow(row, message);
        } else {
            // Normal display in main output
            this.appendOutput(message, 'system');
        }
    }

    // #echo {message} - Display message locally (same as showme)
    cmdEcho(args, rest) {
        this.cmdShowme(args, rest);
    }

    // #bell - Play alert sound
    cmdBell() {
        this.playBell();
        this.appendOutput('[BELL]', 'system');
    }

    // Play bell/alert sound
    playBell() {
        try {
            // Create a simple beep using Web Audio API
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            oscillator.frequency.value = 800; // Hz
            oscillator.type = 'sine';
            gainNode.gain.value = 0.3;

            oscillator.start();
            setTimeout(() => {
                oscillator.stop();
                audioContext.close();
            }, 150);
        } catch (e) {
            console.error('Failed to play bell:', e);
        }
    }

    // #send {text} - Send raw text to MUD
    cmdSend(args) {
        if (args.length < 1) {
            this.appendOutput('Usage: #send {text}', 'error');
            return;
        }

        let text = args[0];
        text = this.substituteVariables(text);
        this.connection.sendCommand(text);
    }

    // #loop {start} {end} {variable} {commands}
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

        for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
            if (++iterations > maxIterations) {
                this.appendOutput('Loop exceeded maximum iterations (1000)', 'error');
                break;
            }
            this.variables[varName] = i;
            this.executeCommandString(commands);
        }
    }

    // #format {variable} {format} [args...] - Format a string
    cmdFormat(args) {
        if (args.length < 2) {
            this.appendOutput('Usage: #format {variable} {format} [args...]', 'error');
            return;
        }

        const varName = args[0];
        let format = args[1];

        // TinTin++ format specifiers: %s (string), %d (number), %c (char), etc.
        // Also supports %1, %2, etc. for positional args
        let argIndex = 2;
        format = format.replace(/%(\d+|[sdcfx%])/g, (match, spec) => {
            if (spec === '%') return '%';
            if (/^\d+$/.test(spec)) {
                const idx = parseInt(spec) + 1; // %1 = args[2]
                return args[idx] !== undefined ? this.substituteVariables(args[idx]) : match;
            }
            if (argIndex < args.length) {
                const val = this.substituteVariables(args[argIndex++]);
                switch (spec) {
                    case 'd': return parseInt(val) || 0;
                    case 'f': return parseFloat(val) || 0;
                    case 'x': return (parseInt(val) || 0).toString(16);
                    case 'c': return String.fromCharCode(parseInt(val) || 0);
                    case 's':
                    default: return val;
                }
            }
            return match;
        });

        this.variables[varName] = this.substituteVariables(format);
        this.appendOutput(`#format: $${varName} = ${this.variables[varName]}`, 'system');
    }

    // #replace {variable} {old} {new} - Replace text in variable
    cmdReplace(args) {
        if (args.length < 3) {
            this.appendOutput('Usage: #replace {variable} {old} {new}', 'error');
            return;
        }

        const varName = args[0];
        const oldText = this.substituteVariables(args[1]);
        const newText = this.substituteVariables(args[2]);

        if (this.variables[varName] === undefined) {
            this.appendOutput(`Variable not found: $${varName}`, 'error');
            return;
        }

        const original = this.variables[varName].toString();
        this.variables[varName] = original.split(oldText).join(newText);
        this.appendOutput(`#replace: $${varName} = ${this.variables[varName]}`, 'system');
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
