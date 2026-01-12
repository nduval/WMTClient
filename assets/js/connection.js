/**
 * WMT Client - WebSocket Connection Handler
 */

class MudConnection {
    constructor(options = {}) {
        this.wsUrl = options.wsUrl || `ws://${window.location.hostname}:8080`;
        this.socket = null;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
        this.keepAliveInterval = null;

        // Callbacks
        this.onConnect = options.onConnect || (() => {});
        this.onDisconnect = options.onDisconnect || (() => {});
        this.onMessage = options.onMessage || (() => {});
        this.onError = options.onError || (() => {});
        this.onStatusChange = options.onStatusChange || (() => {});
    }

    connect() {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            return;
        }

        this.onStatusChange('connecting');

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
            this.onStatusChange('connected');
            this.onConnect();
            this.startKeepAlive();
        };

        this.socket.onclose = (event) => {
            this.connected = false;
            this.onStatusChange('disconnected');
            this.stopKeepAlive();
            this.onDisconnect(event);

            // Attempt reconnect
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
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
                this.onMessage(data);
            } catch (e) {
                console.error('Failed to parse message:', e);
            }
        };
    }

    disconnect() {
        this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnection
        this.stopKeepAlive();
        if (this.socket) {
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

    sendCommand(command) {
        return this.send('command', { command });
    }

    setTriggers(triggers) {
        return this.send('set_triggers', { triggers });
    }

    setAliases(aliases) {
        return this.send('set_aliases', { aliases });
    }

    setMip(enabled, mipId, debug = false) {
        return this.send('set_mip', { enabled, mipId, debug });
    }

    setServer(host, port) {
        return this.send('set_server', { host, port });
    }

    reconnect() {
        this.reconnectAttempts = 0;
        this.disconnect();
        setTimeout(() => this.connect(), 500);
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
