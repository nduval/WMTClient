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
        this.socket = null;
        this.connected = false;
        this.authenticated = false;  // Have we completed auth handshake?
        this.sessionResumed = false; // Did we reconnect to existing session?
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
        this.keepAliveInterval = null;
        this.intentionalDisconnect = false;  // Track if disconnect was intentional

        // Callbacks
        this.onConnect = options.onConnect || (() => {});
        this.onDisconnect = options.onDisconnect || (() => {});
        this.onMessage = options.onMessage || (() => {});
        this.onError = options.onError || (() => {});
        this.onStatusChange = options.onStatusChange || (() => {});
        this.onSessionResumed = options.onSessionResumed || (() => {});  // Called when reconnecting to existing session
    }

    connect() {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
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
                    isWizard: this.isWizard
                }));
            } else {
                console.error('No WebSocket token available');
                this.onError('Authentication failed: no token');
                this.socket.close();
            }
        };

        this.socket.onclose = (event) => {
            this.connected = false;
            this.authenticated = false;
            this.onStatusChange('disconnected');
            this.stopKeepAlive();
            this.onDisconnect(event);

            // Only attempt reconnect if not intentional
            if (!this.intentionalDisconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
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
                if (data.type === 'session_new') {
                    this.authenticated = true;
                    this.sessionResumed = false;
                    this.onStatusChange('connected');
                    this.onConnect();
                    this.startKeepAlive();
                    return;
                }

                if (data.type === 'session_resumed') {
                    this.authenticated = true;
                    this.sessionResumed = false;
                    this.onStatusChange('connected');
                    this.onSessionResumed(data.mudConnected);
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

    disconnect() {
        this.intentionalDisconnect = true;
        this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnection
        this.stopKeepAlive();

        // Send explicit disconnect message to close MUD connection on server
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            try {
                this.socket.send(JSON.stringify({ type: 'disconnect' }));
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

    setMip(enabled, mipId, debug = false) {
        return this.send('set_mip', { enabled, mipId, debug });
    }

    setServer(host, port) {
        return this.send('set_server', { host, port });
    }

    setDiscordPrefs(channelPrefs, username = 'WMT Client') {
        return this.send('set_discord_prefs', { channelPrefs, username });
    }

    reconnect() {
        // Reset all connection state
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
