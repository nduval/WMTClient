/**
 * WMT Client - WebSocket Connection Handler
 * Supports session persistence - MUD connections survive browser disconnects
 */

class MudConnection {
    constructor(options = {}) {
        this.wsUrl = options.wsUrl || `ws://${window.location.hostname}:8080`;
        this.wsToken = options.wsToken || null;  // Session token for reconnection
        this.userId = options.userId || null;    // User ID for multi-device session management
        this.characterId = options.characterId || null;  // Character ID for multi-device session management
        this.characterName = options.characterName || null;  // Character name for admin display
        this.isWizard = options.isWizard || false;  // Wizard flag (no session timeout)
        // Packet patch preference sent in auth so server has it BEFORE opening MUD socket
        // (eliminates race where first bytes of MUD data use default instead of user's value)
        this.packetPatch = options.packetPatch ?? 1.0;
        this.socket = null;
        this.connected = false;
        this.authenticated = false;  // Have we completed auth handshake?
        this.sessionResumed = false; // Did we reconnect to existing session?
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
        this.keepAliveInterval = null;
        this.intentionalDisconnect = false;  // Track if disconnect was intentional
        // True once the MUD link has closed (linkdead / #end / menu disconnect / idle).
        // Gates auto-reconnect: a character the user let go linkdead must NOT be
        // auto-resurrected by a wmt-server restart — only a manual reconnect brings it
        // back. Cleared when the MUD link is (re)established or on user-initiated reconnect.
        this.mudLinkDead = false;
        // True only for the NEXT connect when it's an AUTOMATIC reconnect (onclose
        // path) rather than a user-initiated connect/reconnect. Sent in the auth
        // message so the server can refuse to auto-login a parked character on a
        // passive reconnect (SC4 server-side defense-in-depth). Reset after each auth.
        this._nextConnectIsAuto = false;

        // Callbacks
        this.onConnect = options.onConnect || (() => {});
        this.onDisconnect = options.onDisconnect || (() => {});
        this.onMessage = options.onMessage || (() => {});
        this.onError = options.onError || (() => {});
        this.onStatusChange = options.onStatusChange || (() => {});
        this.onSessionResumed = options.onSessionResumed || (() => {});  // Called when reconnecting to existing session
    }

    connect() {
        // Don't stack sockets: bail if already open OR a connect is already in
        // flight (CONNECTING). visibilitychange / health-check / online events can
        // each call connect()/reconnect() near-simultaneously; overlapping sockets
        // produce duplicate auth/login attempts.
        if (this.socket && (this.socket.readyState === WebSocket.OPEN ||
                            this.socket.readyState === WebSocket.CONNECTING)) {
            return;
        }

        this.onStatusChange('connecting');
        this.intentionalDisconnect = false;
        this.authenticated = false;
        this.sessionResumed = false;

        try {
            this.socket = new WebSocket(this.wsUrl);
        } catch (e) {
            this.onError('Failed to create WebSocket connection');
            this.onStatusChange('disconnected');
            return;
        }

        this.socket.onopen = () => {
            this.connected = true;
            this.reconnectAttempts = 0;
            this.onStatusChange('authenticating');

            // Send auth token as first message (includes user/character for multi-device management)
            if (this.wsToken) {
                this.socket.send(JSON.stringify({
                    type: 'auth',
                    token: this.wsToken,
                    userId: this.userId,
                    characterId: this.characterId,
                    characterName: this.characterName,
                    isWizard: this.isWizard,
                    packetPatch: this.packetPatch,
                    autoReconnect: this._nextConnectIsAuto
                }));
                this._nextConnectIsAuto = false;  // consumed; subsequent connects are user-initiated unless re-flagged
            } else {
                console.error('No WebSocket token available');
                this.onError('Authentication failed: no token');
                this.socket.close();
            }
        };

        this.socket.onclose = (event) => {
            this.connected = false;
            this.authenticated = false;
            this.stopKeepAlive();

            // Do NOT auto-reconnect a character whose MUD link was already dead when the
            // WS dropped — that would resurrect a char the user intentionally parked
            // (#end / disconnect / let go linkdead). Genuinely-active sessions (mudLinkDead
            // false) still auto-resume seamlessly across a server restart / WiFi blip.
            const willAutoReconnect = !this.intentionalDisconnect &&
                !this.mudLinkDead &&
                this.reconnectAttempts < this.maxReconnectAttempts;

            // Use 'reconnecting' status for auto-reconnects to suppress status bar flicker
            this.onStatusChange(willAutoReconnect ? 'reconnecting' : 'disconnected');
            this.onDisconnect(event);

            if (willAutoReconnect) {
                this.reconnectAttempts++;
                this._nextConnectIsAuto = true;  // the upcoming connect is automatic, not user-initiated
                setTimeout(() => this.connect(), this.reconnectDelay);
            }
        };

        this.socket.onerror = (error) => {
            this.onError('WebSocket error');
        };

        this.socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // Handle auth responses
                if (data.type === 'session_init') {
                    // Bridge mode: server needs triggers before deciding session type.
                    // Authenticate and send triggers, but don't fire onConnect/onSessionResumed yet.
                    // The real session_new or session_resumed will follow after bridge responds.
                    this.authenticated = true;
                    this.onStatusChange('connected');
                    this.startKeepAlive();
                    // Trigger sending of triggers/aliases by calling onSessionResumed path
                    // with a flag that prevents side effects
                    if (this.onSessionInit) this.onSessionInit();
                    return;
                }

                if (data.type === 'session_new') {
                    this.authenticated = true;
                    this.sessionResumed = false;
                    this.onStatusChange('connected');
                    this.onConnect(data.bridgeMode || false);
                    this.startKeepAlive();
                    return;
                }

                if (data.type === 'session_resumed') {
                    this.authenticated = true;
                    this.sessionResumed = false;
                    this.onStatusChange('connected');
                    this.onSessionResumed(data.mudConnected, data.variables);
                    this.startKeepAlive();
                    return;
                }

                // Session was taken by another device - don't reconnect
                if (data.type === 'session_taken') {
                    this.intentionalDisconnect = true;
                    this.reconnectAttempts = this.maxReconnectAttempts;
                    this.onMessage(data);
                    return;
                }

                this.onMessage(data);
            } catch (e) {
                console.error('Failed to parse message:', e);
            }
        };
    }

    // intentional=true means the PLAYER genuinely asked to disconnect (Disconnect
    // button / #end / #zap / idle deadman) → the server tears down the MUD session.
    // A bare disconnect() (no flag) is treated server-side as detach-only (drop just
    // this browser, keep the MUD/bot/session alive). See server.js 'disconnect'
    // handler + memory project_disconnect_detach_redesign.
    disconnect(intentional = false) {
        this.intentionalDisconnect = true;
        this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnection
        this.stopKeepAlive();

        // Send disconnect message to the server, flagged with intent.
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            try {
                this.socket.send(JSON.stringify({ type: 'disconnect', intentional: !!intentional }));
            } catch (e) {
                console.error('Failed to send disconnect:', e);
            }
            this.socket.close();
        }
    }

    send(type, data = {}) {
        if (!this.connected || !this.socket) {
            console.warn('Cannot send: not connected');
            return false;
        }

        try {
            this.socket.send(JSON.stringify({ type, ...data }));
            return true;
        } catch (e) {
            console.error('Failed to send:', e);
            return false;
        }
    }

    sendCommand(command, raw = false) {
        return this.send('command', { command, raw });
    }

    setTriggers(triggers) {
        return this.send('set_triggers', { triggers });
    }

    setAliases(aliases) {
        return this.send('set_aliases', { aliases });
    }

    setTickers(tickers) {
        return this.send('set_tickers', { tickers });
    }

    setVariables(variables) {
        return this.send('set_variables', { variables });
    }

    setFunctions(functions) {
        return this.send('set_functions', { functions });
    }

    setMip(enabled, mipId, debug = false) {
        return this.send('set_mip', { enabled, mipId, debug });
    }

    setServer(host, port) {
        return this.send('set_server', { host, port });
    }

    setDiscordPrefs(channelPrefs, username = 'WMT Client', iftttKey = '', suppressSelfAlerts = false, suppressAfkAlerts = false) {
        return this.send('set_discord_prefs', { channelPrefs, username, iftttKey, suppressSelfAlerts, suppressAfkAlerts });
    }

    reconnect() {
        // Reset all connection state. A user-initiated reconnect is explicit intent to
        // bring the character back, so clear the linkdead suppression flag and mark
        // the upcoming connect as user-initiated (not an automatic reconnect).
        this.mudLinkDead = false;
        this._nextConnectIsAuto = false;
        this.reconnectAttempts = 0;
        this.connected = false;
        this.authenticated = false;
        this.sessionResumed = false;
        this.stopKeepAlive();

        // Force close any existing socket, even if in weird state
        if (this.socket) {
            try {
                // Don't send disconnect message - just close
                this.socket.onclose = null;  // Prevent onclose handler from firing
                this.socket.onerror = null;
                this.socket.onmessage = null;
                this.socket.close();
            } catch (e) {
                console.error('Error closing socket:', e);
            }
            this.socket = null;
        }

        // Small delay then reconnect fresh
        setTimeout(() => this.connect(), 300);
    }

    requestReconnect() {
        return this.send('reconnect');
    }

    startKeepAlive() {
        this.stopKeepAlive();
        this.keepAliveInterval = setInterval(() => {
            this.send('keepalive');
        }, 30000);
    }

    stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
    }

    isConnected() {
        return this.connected;
    }
}

// Export for use
window.MudConnection = MudConnection;
