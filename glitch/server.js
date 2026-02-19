/**
 * WMT Client - WebSocket to TCP Proxy
 * Proxies WebSocket connections to 3k.org MUD
 *
 * Session Persistence: MUD connections persist when browser disconnects unexpectedly.
 * Reconnecting with the same token resumes the session and replays buffered output.
 */

const WebSocket = require('ws');
const net = require('net');
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const MUD_HOST = '3k.org';
const MUD_PORT = 3000;
const PORT = process.env.PORT || 3000;
const VERSION = '3.0.0'; // Bridge architecture for zero-downtime deploys
const ADMIN_KEY = process.env.ADMIN_KEY || null; // Admin key for broadcast endpoint
const BRIDGE_URL = process.env.BRIDGE_URL || null; // ws://localhost:4000 for bridge mode

// Session persistence configuration
const SESSION_BUFFER_MAX_LINES = 150;  // Max lines to buffer while browser disconnected (keep recent, drop old)
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;  // 15 minutes without browser = close MUD connection
const CHAT_BUFFER_MAX = 100;  // Max ChatMon messages to preserve across session resume

// Persistent sessions store: token -> session object
const sessions = new Map();

// User+character session tracking: "userId:characterId" -> token
// Used to close old sessions when same user+character connects from different device
const userCharacterSessions = new Map();

// Session event log buffer for debugging (circular buffer)
const SESSION_LOG_MAX = 500;
const sessionLogs = [];

// Log persistence tracking - index of next entry to flush to IONOS
let lastFlushedIndex = 0;
let flushInProgress = false;
const LOG_FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ==================== Bridge Mode ====================
// When BRIDGE_URL is set, MUD TCP connections go through bridge.js
// which holds them across server.js restarts (zero-downtime deploys).

const EventEmitter = require('events');
let bridgeWs = null;
let bridgeReconnectTimer = null;
const bridgeSockets = new Map(); // token -> BridgeSocket

/**
 * BridgeSocket — net.Socket-compatible wrapper that communicates through bridge.js.
 * Emits the same events (data, close, error, end) so the rest of server.js
 * doesn't need to know whether it's talking to a real socket or the bridge.
 */
class BridgeSocket extends EventEmitter {
  constructor(token) {
    super();
    this.token = token;
    this.destroyed = false;
    this.writable = false;
    bridgeSockets.set(token, this);
  }

  connect(port, host, callback) {
    if (callback) this._connectCallback = callback;
    this._host = host;
    this._port = port;
    if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
      // Try to resume an existing bridge connection first.
      // If the bridge has a live MUD TCP connection for this token
      // (from before server.js restarted), resume it seamlessly.
      // If not, bridge responds with error and we fall back to init.
      this._tryingResume = true;
      bridgeWs.send(JSON.stringify({ type: 'resume', token: this.token }));
    } else {
      // Bridge not connected — emit error
      process.nextTick(() => this.emit('error', new Error('Bridge not connected')));
    }
  }

  write(data) {
    if (this.destroyed || !this.writable || !bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) return false;
    bridgeWs.send(JSON.stringify({
      type: 'data',
      token: this.token,
      data: Buffer.from(data).toString('base64')
    }));
    return true;
  }

  end() {
    if (!this.destroyed && bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
      try { bridgeWs.send(JSON.stringify({ type: 'destroy', token: this.token })); } catch (e) {}
    }
    this.destroyed = true;
    this.writable = false;
    bridgeSockets.delete(this.token);
  }

  destroy() {
    this.end();
  }

  // Resume an existing MUD connection through the bridge (after server.js restart)
  resume() {
    if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
      bridgeWs.send(JSON.stringify({ type: 'resume', token: this.token }));
    }
  }
}

/**
 * Handle messages from bridge.js — route to the correct BridgeSocket
 */
function handleBridgeMessage(msg) {
  const bs = bridgeSockets.get(msg.token);
  if (!bs) return;

  switch (msg.type) {
    case 'connected':
      bs.resumed = bs._tryingResume; // true if this was a successful resume
      bs._tryingResume = false;
      bs.writable = true;
      bs.destroyed = false;
      if (bs._connectCallback) {
        bs._connectCallback();
        bs._connectCallback = null;
      }
      break;
    case 'data':
      bs.emit('data', Buffer.from(msg.data, 'base64'));
      break;
    case 'close':
      bs.destroyed = true;
      bs.writable = false;
      bs.emit('close');
      bridgeSockets.delete(msg.token);
      break;
    case 'error':
      if (bs._tryingResume) {
        // Resume failed — no existing connection in bridge. Fall back to init (new TCP connection).
        bs._tryingResume = false;
        bs.resumed = false;
        console.log(`[bridge] No existing connection for ${msg.token.substring(0, 8)}, creating new`);
        if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
          bridgeWs.send(JSON.stringify({ type: 'init', token: msg.token, host: bs._host, port: bs._port }));
        }
      } else {
        bs.emit('error', new Error(msg.message));
      }
      break;
    case 'end':
      bs.emit('end');
      break;
    case 'buffered':
      console.log(`[bridge] Resuming ${msg.token.substring(0, 8)}: ${msg.count} buffered chunks`);
      break;
  }
}

/**
 * Connect to bridge.js with auto-reconnect
 */
function connectToBridge() {
  if (!BRIDGE_URL) return;

  console.log(`[bridge] Connecting to ${BRIDGE_URL}...`);
  bridgeWs = new WebSocket(BRIDGE_URL);

  bridgeWs.on('open', () => {
    console.log('[bridge] Connected to bridge');
    if (bridgeReconnectTimer) {
      clearTimeout(bridgeReconnectTimer);
      bridgeReconnectTimer = null;
    }
  });

  bridgeWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleBridgeMessage(msg);
    } catch (e) {}
  });

  bridgeWs.on('close', () => {
    console.log('[bridge] Disconnected from bridge — reconnecting in 2s');
    bridgeWs = null;
    bridgeReconnectTimer = setTimeout(connectToBridge, 2000);
  });

  bridgeWs.on('error', (err) => {
    console.log('[bridge] Connection error:', err.message);
    // close event will fire after this, triggering reconnect
  });
}

// ==================== End Bridge Mode ====================

/**
 * Log a session event to both console and the in-memory buffer
 * Events are structured for easy analysis
 */
function logSessionEvent(type, data) {
  const event = {
    time: new Date().toISOString(),
    type: type,
    ...data
  };

  // Add to buffer (circular)
  sessionLogs.push(event);
  if (sessionLogs.length > SESSION_LOG_MAX) {
    sessionLogs.shift();
    // Adjust flush index since we dropped an entry from the front
    if (lastFlushedIndex > 0) {
      lastFlushedIndex--;
    }
    // Buffer wrapped — flush immediately so we don't lose entries
    if (!BRIDGE_URL) flushLogsToIONOS();
  }

  // Also log to console (goes to journalctl on Lightsail)
  const logParts = Object.entries(data).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`${type}: ${logParts}`);
}

// ==================== File-based Session Logging ====================
// Writes detailed JSONL logs per-character per-day for troubleshooting.
// Logs: input, MUD output, trigger matches, session events, settings.
// Files: /var/log/wmt/YYYY-MM-DD/CharacterName.jsonl

const LOG_DIR = '/var/log/wmt';
const LOG_RETENTION_DAYS = 3; // Keep logs on Lightsail for 3 days
const LOG_USER_ID = process.env.LOG_USER_ID || null; // If set, only log this user's sessions
const _logDirsCreated = new Set();

function writeSessionLog(session, type, data) {
  if (!session) return;
  // Only log for the configured user (if filter is set)
  if (LOG_USER_ID && String(session.userId) !== LOG_USER_ID) return;
  try {
    const date = new Date().toISOString().slice(0, 10);
    const charName = (session.characterName || session.characterId || 'unknown')
      .toString().replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(LOG_DIR, date);
    const filePath = path.join(dir, `${charName}.jsonl`);

    if (!_logDirsCreated.has(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        _logDirsCreated.add(dir);
      } catch (e) {
        console.error('Log dir create error:', dir, e.message);
        return; // Can't write without the directory
      }
    }

    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      ...data
    }) + '\n';

    fs.appendFile(filePath, entry, (err) => {
      if (err && !writeSessionLog._errLogged) {
        console.error('Log write error:', err.message);
        writeSessionLog._errLogged = true;
      }
    });
  } catch (e) {
    // Never let logging crash the server
  }
}

// Clean up old log directories on startup and every 6 hours
function cleanupOldLogs() {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const cutoff = Date.now() - (LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const entries = fs.readdirSync(LOG_DIR);
    for (const entry of entries) {
      // Directory names are YYYY-MM-DD
      const dateMatch = entry.match(/^(\d{4}-\d{2}-\d{2})$/);
      if (!dateMatch) continue;
      const dirDate = new Date(dateMatch[1] + 'T00:00:00Z').getTime();
      if (dirDate < cutoff) {
        const dirPath = path.join(LOG_DIR, entry);
        try {
          const files = fs.readdirSync(dirPath);
          for (const f of files) fs.unlinkSync(path.join(dirPath, f));
          fs.rmdirSync(dirPath);
          console.log(`Cleaned up old logs: ${entry}`);
        } catch (e) {
          console.error(`Failed to clean logs ${entry}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('Log cleanup error:', e.message);
  }
}

// Run cleanup on startup and every 6 hours
cleanupOldLogs();
setInterval(cleanupOldLogs, 6 * 60 * 60 * 1000);

/**
 * Flush unflushed session logs to IONOS for persistence
 * Fire-and-forget: doesn't block on failure, just logs to console
 */
async function flushLogsToIONOS() {
  if (!ADMIN_KEY || flushInProgress) return;

  // Grab entries that haven't been flushed yet
  const unflushed = sessionLogs.slice(lastFlushedIndex);
  if (unflushed.length === 0) return;

  flushInProgress = true;
  const flushCount = unflushed.length;

  try {
    const payload = JSON.stringify({ logs: unflushed });
    const url = new URL(`${PHP_LOGS_URL}?action=save`);

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Admin-Key': ADMIN_KEY
        },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });

      req.write(payload);
      req.end();
    });

    // Mark as flushed only on success
    lastFlushedIndex = sessionLogs.length;
    console.log(`LOG_FLUSH: sent ${flushCount} entries to IONOS`);
  } catch (e) {
    console.error('LOG_FLUSH_ERROR:', e.message);
  } finally {
    flushInProgress = false;
  }
}

/**
 * Send message to Discord webhook via IONOS proxy (fire and forget)
 * Routes through IONOS to avoid Cloudflare blocking proxy IPs
 * Used for server-side notifications when browser is disconnected
 */
function sendToDiscordWebhook(webhookUrl, message, username = 'WMT Client') {
  if (!webhookUrl || !ADMIN_KEY) return;

  // Validate webhook URL
  if (!webhookUrl.startsWith('https://discord.com/api/webhooks/') &&
      !webhookUrl.startsWith('https://discordapp.com/api/webhooks/')) {
    return;
  }

  // Sanitize message
  const sanitizedMessage = message
    .replace(/\x1b\[[0-9;]*m/g, '')  // Strip ANSI
    .replace(/@(everyone|here)/gi, '@\u200b$1')  // Escape @everyone/@here
    .replace(/<@[!&]?\d+>/g, '[mention]')  // Escape mentions
    .substring(0, 1997) + (message.length > 1997 ? '...' : '');

  // Route through IONOS proxy instead of directly to Discord
  const payload = JSON.stringify({
    webhook_url: webhookUrl,
    message: sanitizedMessage,
    username: username
  });

  try {
    const urlObj = new URL(PHP_DISCORD_PROXY_URL);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Admin-Key': ADMIN_KEY
      }
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', chunk => responseBody += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          // Log webhook errors to session log buffer for debugging
          sessionLogs.push({
            time: new Date().toISOString(),
            type: 'DISCORD_WEBHOOK_ERROR',
            statusCode: res.statusCode,
            response: responseBody.substring(0, 200),
            webhookSuffix: webhookUrl.slice(-15)
          });
          if (sessionLogs.length > SESSION_LOG_MAX) sessionLogs.shift();
          console.error('Discord webhook proxy error:', res.statusCode, responseBody);
        }
      });
    });

    req.on('error', (e) => {
      // Log network errors
      sessionLogs.push({
        time: new Date().toISOString(),
        type: 'DISCORD_WEBHOOK_ERROR',
        error: e.message,
        webhookSuffix: webhookUrl.slice(-15)
      });
      if (sessionLogs.length > SESSION_LOG_MAX) sessionLogs.shift();
      console.error('Discord webhook proxy error:', e.message);
    });

    req.write(payload);
    req.end();
  } catch (e) {
    console.error('Discord webhook proxy exception:', e.message);
  }
}

// PHP API URLs (survive server restart)
const PHP_API_URL = 'https://client.wemudtogether.com/api/preferences.php';
const PHP_SESSIONS_URL = 'https://client.wemudtogether.com/api/persistent_sessions.php';
const PHP_CHARACTERS_URL = 'https://client.wemudtogether.com/api/characters.php';
const PHP_DISCORD_PROXY_URL = 'https://client.wemudtogether.com/api/discord_proxy.php';
const PHP_LOGS_URL = 'https://client.wemudtogether.com/api/server_logs.php';

/**
 * Fetch Discord channel preferences from PHP backend
 * This ensures Discord prefs persist across server restarts
 * Called when creating/resuming sessions
 */
async function fetchDiscordPrefsFromPHP(userId, characterId, session) {
  if (!userId || !characterId || !ADMIN_KEY) {
    return;
  }

  const url = `${PHP_API_URL}?action=get_discord_prefs&user_id=${encodeURIComponent(userId)}&character_id=${encodeURIComponent(characterId)}`;
  const sessionToken = session.token; // Capture token for later verification

  try {
    const response = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'X-Admin-Key': ADMIN_KEY
        },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Invalid JSON: ${data.substring(0, 100)}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
    });

    // Verify session still exists (might have been closed during async fetch)
    if (!sessions.has(sessionToken)) {
      return;
    }

    if (response.success && response.channelPrefs) {
      // Only update if session still has empty prefs (browser might have sent them meanwhile)
      if (Object.keys(session.discordChannelPrefs).length === 0) {
        // Populate session with fetched prefs
        session.discordChannelPrefs = response.channelPrefs;
        session.discordUsername = response.discordUsername || 'WMT Client';

        // Count webhooks for logging
        let webhookCount = 0;
        for (const channel of Object.keys(response.channelPrefs)) {
          if (response.channelPrefs[channel]?.discord && response.channelPrefs[channel]?.webhookUrl) {
            webhookCount++;
          }
        }

        logSessionEvent('DISCORD_PREFS_FETCHED', {
          token: session.token.substring(0, 8),
          user: userId,
          char: session.characterName || characterId,
          webhookCount: webhookCount,
          totalChannels: Object.keys(response.channelPrefs).length,
          channels: Object.keys(response.channelPrefs).join(',')
        });
      }
    }
  } catch (e) {
    logSessionEvent('DISCORD_PREFS_FETCH_ERROR', {
      token: session.token.substring(0, 8),
      user: userId,
      char: session.characterName || characterId,
      error: e.message
    });
  }
}

/**
 * Persist all active sessions to PHP backend
 * Called on SIGTERM before server shutdown
 */
async function persistAllSessions() {
  if (!ADMIN_KEY) {
    logSessionEvent('PERSIST_SKIP', { reason: 'no admin key' });
    return;
  }

  const activeSessions = [];

  for (const [token, session] of sessions) {
    // Persist ALL sessions with active MUD connections
    if (session.mudSocket && !session.mudSocket.destroyed) {
      activeSessions.push({
        userId: session.userId,
        characterId: session.characterId,
        characterName: session.characterName,
        server: session.targetHost === '3scapes.org' ? '3s' : '3k',
        token: token,
        isWizard: session.isWizard || false,
        persistedAt: Date.now()
      });
    }
  }

  if (activeSessions.length === 0) {
    logSessionEvent('PERSIST_SKIP', { reason: 'no active sessions' });
    return;
  }

  logSessionEvent('PERSIST_START', {
    count: activeSessions.length,
    chars: activeSessions.map(s => s.characterName).join(',')
  });

  try {
    const payload = JSON.stringify({ sessions: activeSessions });
    const url = new URL(`${PHP_SESSIONS_URL}?action=save`);

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Admin-Key': ADMIN_KEY
        },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            logSessionEvent('PERSIST_SUCCESS', { count: activeSessions.length });
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });

      req.write(payload);
      req.end();
    });
  } catch (e) {
    logSessionEvent('PERSIST_ERROR', { error: e.message });
  }
}

/**
 * Fetch character password from PHP backend
 */
async function fetchCharacterPassword(userId, characterId) {
  if (!ADMIN_KEY) return null;

  const url = `${PHP_CHARACTERS_URL}?action=get_password_admin&user_id=${encodeURIComponent(userId)}&character_id=${encodeURIComponent(characterId)}`;

  try {
    const response = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 'X-Admin-Key': ADMIN_KEY },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
    });

    return response.password || null;
  } catch (e) {
    console.error(`Failed to fetch password for ${userId}/${characterId}:`, e.message);
    return null;
  }
}

/**
 * Fetch persistent sessions from PHP backend
 */
async function fetchPersistentSessions() {
  if (!ADMIN_KEY) return [];

  const url = `${PHP_SESSIONS_URL}?action=list`;

  try {
    const response = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 'X-Admin-Key': ADMIN_KEY },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
    });

    return response.sessions || [];
  } catch (e) {
    console.error('Failed to fetch persistent sessions:', e.message);
    return [];
  }
}

/**
 * Remove a persistent session from PHP backend after successful restore
 */
async function removePersistentSession(token) {
  if (!ADMIN_KEY) return;

  try {
    const payload = JSON.stringify({ token });
    const url = new URL(`${PHP_SESSIONS_URL}?action=remove`);

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Admin-Key': ADMIN_KEY
        },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve());
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  } catch (e) {
    console.error('Failed to remove persistent session:', e.message);
  }
}

/**
 * Clear all persistent sessions from PHP backend.
 * Called after restore completes to prevent stale sessions from lingering
 * across future restarts (guards against persist/restore race conditions).
 */
async function clearAllPersistentSessions() {
  if (!ADMIN_KEY) return;

  try {
    const url = new URL(`${PHP_SESSIONS_URL}?action=clear`);

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': 2,
          'X-Admin-Key': ADMIN_KEY
        },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve());
      });

      req.on('error', reject);
      req.write('{}');
      req.end();
    });
  } catch (e) {
    console.error('Failed to clear persistent sessions:', e.message);
  }
}

/**
 * Auto-login to MUD for a restored session
 * Returns true on success, false on failure
 */
function autoLoginToMud(session, password) {
  return new Promise((resolve) => {
    const serverName = session.targetHost === '3scapes.org' ? '3Scapes' : '3Kingdoms';
    const charName = session.characterName;
    const tokenShort = session.token.substring(0, 8);

    logSessionEvent('AUTOLOGIN_START', {
      token: tokenShort,
      char: charName,
      server: serverName,
      host: session.targetHost
    });

    session.mudSocket = BRIDGE_URL ? new BridgeSocket(session.token) : new net.Socket();
    let loginState = 'CONNECTING';
    let dataBuffer = '';
    let loginTimeout = null;

    // Set a timeout for the entire login process
    loginTimeout = setTimeout(() => {
      logSessionEvent('AUTOLOGIN_TIMEOUT', {
        token: tokenShort,
        char: charName,
        state: loginState,
        lastData: dataBuffer.substring(0, 200) // Log what MUD sent for debugging
      });
      if (session.mudSocket && !session.mudSocket.destroyed) {
        session.mudSocket.destroy();
      }
      resolve(false);
    }, 30000); // 30 second timeout

    const cleanup = () => {
      if (loginTimeout) {
        clearTimeout(loginTimeout);
        loginTimeout = null;
      }
    };

    session.mudSocket.connect(session.targetPort, session.targetHost, () => {
      logSessionEvent('AUTOLOGIN_CONNECTED', {
        token: tokenShort,
        char: charName,
        host: session.targetHost
      });
      loginState = 'WAITING_FOR_NAME_PROMPT';
    });

    session.mudSocket.on('data', (data) => {
      const { buffer: cleanData } = stripTelnetSequences(data);
      const text = cleanData.toString('utf8');
      dataBuffer += text;

      switch (loginState) {
        case 'WAITING_FOR_NAME_PROMPT':
          // Look for login prompt - both 3K and 3S have similar prompts
          if (dataBuffer.includes('Enter your character name') ||
              dataBuffer.includes('What is your name') ||
              dataBuffer.includes('Login:')) {
            logSessionEvent('AUTOLOGIN_SENDING_NAME', {
              token: tokenShort,
              char: charName
            });
            session.mudSocket.write(session.characterName + '\r\n');
            loginState = 'WAITING_FOR_PASSWORD_PROMPT';
            dataBuffer = '';
          }
          break;

        case 'WAITING_FOR_PASSWORD_PROMPT':
          if (dataBuffer.includes('Password:') || dataBuffer.includes('password:')) {
            logSessionEvent('AUTOLOGIN_SENDING_PASSWORD', {
              token: tokenShort,
              char: charName
            });
            session.mudSocket.write(password + '\r\n');
            loginState = 'WAITING_FOR_LOGIN_RESULT';
            dataBuffer = '';
          }
          break;

        case 'WAITING_FOR_LOGIN_RESULT':
          // Check for success indicators
          // MIP initialization is a strong indicator of successful login
          if (dataBuffer.includes('#K%') ||
              dataBuffer.includes('Last login:') ||
              dataBuffer.includes('Welcome back') ||
              dataBuffer.includes('You last quit from') ||
              dataBuffer.includes('welcomes you back from linkdeath') ||
              dataBuffer.includes('reconnects')) {
            logSessionEvent('AUTOLOGIN_SUCCESS', {
              token: tokenShort,
              char: charName,
              server: serverName
            });
            cleanup();
            loginState = 'LOGGED_IN';

            // Now set up normal data handler
            session.mudSocket.removeAllListeners('data');
            session.lineBuffer = '';
            session.currentAnsiState = '';

            session.mudSocket.on('data', (data) => {
              const { buffer: cleanData, hasGA } = stripTelnetSequences(data);
              const text = cleanData.toString('utf8');

              if (session.lineBufferTimeout) {
                clearTimeout(session.lineBufferTimeout);
                session.lineBufferTimeout = null;
              }

              const fullText = session.lineBuffer + text;
              const parts = fullText.split('\n');

              if (hasGA) {
                session.lineBuffer = '';
                parts.forEach(line => processLine(session, line));
                return;
              }

              if (!text.endsWith('\n') && parts.length > 0) {
                session.lineBuffer = parts.pop();
                if (session.lineBuffer) {
                  session.lineBufferTimeout = setTimeout(() => {
                    if (session.lineBuffer) {
                      processLine(session, session.lineBuffer);
                      session.lineBuffer = '';
                    }
                  }, 500);
                }
              } else {
                session.lineBuffer = '';
              }

              parts.forEach(line => processLine(session, line));
            });

            resolve(true);
          }

          // Check for failure indicators
          if (dataBuffer.includes('Unknown user') ||
              dataBuffer.includes('Bad password') ||
              dataBuffer.includes('Invalid password') ||
              dataBuffer.includes('Incorrect password') ||
              dataBuffer.includes('No such player') ||
              dataBuffer.includes('already logged in') ||
              dataBuffer.includes('attempting to login')) {
            // Extract the specific error for logging
            let reason = 'unknown';
            if (dataBuffer.includes('Unknown user') || dataBuffer.includes('No such player')) reason = 'unknown_user';
            else if (dataBuffer.includes('Bad password') || dataBuffer.includes('Invalid password') || dataBuffer.includes('Incorrect password')) reason = 'bad_password';
            else if (dataBuffer.includes('already logged in') || dataBuffer.includes('attempting to login')) reason = 'already_logged_in';

            logSessionEvent('AUTOLOGIN_REJECTED', {
              token: tokenShort,
              char: charName,
              reason: reason
            });
            cleanup();
            session.mudSocket.destroy();
            resolve(false);
          }
          break;
      }
    });

    session.mudSocket.on('close', () => {
      if (loginState !== 'LOGGED_IN') {
        logSessionEvent('AUTOLOGIN_CLOSED', {
          token: tokenShort,
          char: charName,
          state: loginState
        });
        cleanup();
        resolve(false);
      }
    });

    session.mudSocket.on('error', (err) => {
      logSessionEvent('AUTOLOGIN_ERROR', {
        token: tokenShort,
        char: charName,
        error: err.message
      });
      cleanup();
      resolve(false);
    });
  });
}

/**
 * Restore persistent sessions on startup
 */
async function restorePersistentSessions() {
  logSessionEvent('RESTORE_CHECK', { note: 'checking for sessions to restore' });

  const persistentSessions = await fetchPersistentSessions();

  if (persistentSessions.length === 0) {
    logSessionEvent('RESTORE_NONE', { note: 'no sessions to restore' });
    // Still clear the file — handles race where old server's persist
    // landed after the new server's fetch returned empty
    await clearAllPersistentSessions();
    return;
  }

  logSessionEvent('RESTORE_START', {
    count: persistentSessions.length,
    chars: persistentSessions.map(s => s.characterName).join(',')
  });

  for (const ps of persistentSessions) {
    logSessionEvent('RESTORE_SESSION', {
      token: ps.token.substring(0, 8),
      char: ps.characterName,
      server: ps.server
    });

    // Skip stale sessions from previous deploys (> 2 minutes old)
    if (ps.persistedAt && (Date.now() - ps.persistedAt > 120000)) {
      logSessionEvent('RESTORE_SKIP_STALE', {
        token: ps.token.substring(0, 8),
        char: ps.characterName,
        age: Math.round((Date.now() - ps.persistedAt) / 1000)
      });
      continue;
    }

    // Skip if this user+character already has an active session
    // (they reconnected on their own between persist and restore)
    const userCharKey = `${ps.userId}:${ps.characterId}`;
    const existingToken = userCharacterSessions.get(userCharKey);
    if (existingToken && sessions.has(existingToken)) {
      const existing = sessions.get(existingToken);
      if (existing.mudSocket && !existing.mudSocket.destroyed) {
        logSessionEvent('RESTORE_SKIP_ACTIVE', {
          token: ps.token.substring(0, 8),
          char: ps.characterName,
          existingToken: existingToken.substring(0, 8),
          note: 'user+char already has active MUD connection'
        });
        continue;
      }
    }

    // Create session object
    const session = createSession(ps.token);
    session.userId = ps.userId;
    session.characterId = ps.characterId;
    session.characterName = ps.characterName;
    session.isWizard = ps.isWizard || false;
    session.targetHost = ps.server === '3s' ? '3scapes.org' : '3k.org';
    session.targetPort = ps.server === '3s' ? 3200 : 3000;
    session.disconnectedAt = Date.now(); // No browser connected yet

    let success = false;

    if (BRIDGE_URL) {
      // Bridge mode: resume existing TCP connection (no re-login needed!)
      // The bridge held the MUD connection while we restarted.
      session.mudSocket = new BridgeSocket(ps.token);

      // Set up normal data handler
      session.lineBuffer = '';
      session.currentAnsiState = '';
      session.mudSocket.on('data', (data) => {
        const { buffer: cleanData, hasGA } = stripTelnetSequences(data);
        const text = cleanData.toString('utf8');

        if (session.lineBufferTimeout) {
          clearTimeout(session.lineBufferTimeout);
          session.lineBufferTimeout = null;
        }

        const fullText = session.lineBuffer + text;
        const parts = fullText.split('\n');

        if (hasGA) {
          session.lineBuffer = '';
          parts.forEach(line => processLine(session, line));
          return;
        }

        if (!text.endsWith('\n') && parts.length > 0) {
          session.lineBuffer = parts.pop();
          if (session.lineBuffer) {
            session.lineBufferTimeout = setTimeout(() => {
              if (session.lineBuffer) {
                processLine(session, session.lineBuffer);
                session.lineBuffer = '';
              }
            }, 500);
          }
        } else {
          session.lineBuffer = '';
        }

        parts.forEach(line => processLine(session, line));
      });

      session.mudSocket.on('close', () => {
        console.log('MUD connection closed (bridge)');
        if (!session.serverRestarting) {
          sendToClient(session, { type: 'system', message: 'Connection to MUD closed.' });
        }
        session.mudSocket = null;
        if (session.explicitDisconnect) closeSession(session, 'explicit disconnect');
      });

      session.mudSocket.on('error', (err) => {
        console.error('MUD socket error (bridge):', err.message);
        if (!session.serverRestarting) {
          sendToClient(session, { type: 'error', message: 'MUD connection error: ' + err.message });
        }
      });

      session.mudSocket.on('end', () => {
        console.log('MUD connection ended (bridge)');
        if (!session.serverRestarting) {
          sendToClient(session, { type: 'system', message: 'MUD has closed the connection (idle timeout or linkdead).' });
        }
        if (session.mudSocket) {
          session.mudSocket.destroy();
          session.mudSocket = null;
        }
      });

      // Tell bridge to resume — it will replay buffered data
      session.mudSocket.resume();
      success = true;

      logSessionEvent('RESTORE_BRIDGE_RESUME', {
        token: ps.token.substring(0, 8),
        char: ps.characterName
      });
    } else {
      // Direct mode: need to re-login to MUD
      const password = await fetchCharacterPassword(ps.userId, ps.characterId);
      if (!password) {
        logSessionEvent('RESTORE_NO_PASSWORD', {
          token: ps.token.substring(0, 8),
          char: ps.characterName
        });
        await removePersistentSession(ps.token);
        continue;
      }
      success = await autoLoginToMud(session, password);
    }

    if (success) {
      // Register the session
      sessions.set(ps.token, session);

      // Register in user+character tracking
      const userCharKey2 = `${ps.userId}:${ps.characterId}`;
      userCharacterSessions.set(userCharKey2, ps.token);

      // Fetch Discord prefs
      fetchDiscordPrefsFromPHP(ps.userId, ps.characterId, session);

      logSessionEvent('SESSION_RESTORED', {
        token: ps.token.substring(0, 8),
        user: ps.userId,
        char: ps.characterName,
        server: ps.server,
        mode: BRIDGE_URL ? 'bridge' : 'direct'
      });
    } else {
      logSessionEvent('RESTORE_FAILED', {
        token: ps.token.substring(0, 8),
        char: ps.characterName,
        server: ps.server
      });
    }

    // Remove from persistent storage regardless of success
    // (if failed, user will need to reconnect manually anyway)
    await removePersistentSession(ps.token);

    // Small delay between restores to avoid overwhelming the MUD
    if (!BRIDGE_URL) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Clear ALL persistent sessions after restore completes.
  // This prevents stale sessions from being picked up by future restarts
  // (e.g., if persist/restore raced during the previous deploy and a record lingered).
  await clearAllPersistentSessions();

  logSessionEvent('RESTORE_COMPLETE', { note: 'session restoration finished' });
}

// Telnet protocol constants
const TELNET = {
  IAC: 255,   // Interpret As Command
  DONT: 254,
  DO: 253,
  WONT: 252,
  WILL: 251,
  SB: 250,    // Subnegotiation Begin
  GA: 249,    // Go Ahead
  EL: 248,    // Erase Line
  EC: 247,    // Erase Character
  AYT: 246,   // Are You There
  AO: 245,    // Abort Output
  IP: 244,    // Interrupt Process
  BRK: 243,   // Break
  DM: 242,    // Data Mark
  NOP: 241,   // No Operation
  SE: 240,    // Subnegotiation End
};

/**
 * Strip telnet control sequences from buffer
 * Returns { buffer: cleaned text, hasGA: true if Go Ahead was seen }
 */
function stripTelnetSequences(buffer) {
  const result = [];
  let i = 0;
  let hasGA = false;

  while (i < buffer.length) {
    const byte = buffer[i];

    if (byte === TELNET.IAC) {
      if (i + 1 >= buffer.length) break;

      const cmd = buffer[i + 1];

      if (cmd === TELNET.IAC) {
        result.push(255);
        i += 2;
      } else if (cmd === TELNET.SB) {
        i += 2;
        while (i < buffer.length) {
          if (buffer[i] === TELNET.IAC && i + 1 < buffer.length && buffer[i + 1] === TELNET.SE) {
            i += 2;
            break;
          }
          i++;
        }
      } else if (cmd >= TELNET.WILL && cmd <= TELNET.DONT) {
        i += 3;
      } else if (cmd === TELNET.GA) {
        hasGA = true;
        i += 2;
      } else if (cmd >= TELNET.SE && cmd <= TELNET.GA) {
        i += 2;
      } else {
        i += 2;
      }
    } else {
      result.push(byte);
      i++;
    }
  }

  return { buffer: Buffer.from(result), hasGA };
}

/**
 * Strip ANSI escape codes from text
 */
function stripAnsi(str) {
  return str ? str.replace(/\x1b\[[0-9;]*m/g, '') : '';
}

/**
 * Convert MIP color codes to HTML spans
 */
function convertMipColors(text) {
  if (!text) return '';

  const colorMap = {
    'b': '#4488ff',  // blue
    'c': '#44dddd',  // cyan
    'g': '#44dd44',  // green
    'r': '#ff4444',  // red
    's': '#888888',  // gray (silver)
    'v': '#dd44dd',  // violet
    'w': '#ffffff',  // white
    'y': '#dddd44'   // yellow
  };

  let result = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] === '<' && i + 1 < text.length && colorMap[text[i + 1]]) {
      result += `<span style="color:${colorMap[text[i + 1]]}">`;
      i += 2;
    } else if (text[i] === '>') {
      result += '</span>';
      i += 1;
    } else {
      result += text[i];
      i += 1;
    }
  }

  return result;
}

/**
 * Parse guild line to extract variables
 */
function parseGuildVars(line1, line2) {
  const vars = {};
  const combined = (line1 || '') + ' ' + (line2 || '');
  const clean = combined.replace(/<[a-z]|>/gi, '');

  // Pattern: Name: [X/Y] or Name:[X/Y]
  const ratioPattern = /(\w+):\s*\[(\d+)\/(\d+)\]/gi;
  let match;
  while ((match = ratioPattern.exec(clean)) !== null) {
    const name = match[1].toLowerCase();
    vars[name + '_current'] = parseInt(match[2]) || 0;
    vars[name + '_max'] = parseInt(match[3]) || 0;
  }

  // Pattern: Name: [X%] or Name:[X%]
  const pctBracketPattern = /(\w+):\s*\[(\d+(?:\.\d+)?)%\]/gi;
  while ((match = pctBracketPattern.exec(clean)) !== null) {
    const name = match[1].toLowerCase();
    vars[name + '_pct'] = parseFloat(match[2]) || 0;
  }

  // Pattern: Name: X% (without brackets)
  const pctPattern = /(\w+):\s*(\d+(?:\.\d+)?)%/gi;
  while ((match = pctPattern.exec(clean)) !== null) {
    const name = match[1].toLowerCase();
    if (!(name + '_pct' in vars)) {
      vars[name + '_pct'] = parseFloat(match[2]) || 0;
    }
  }

  // Pattern: Name:[X] (single value in brackets)
  const singlePattern = /(\w+):\s*\[(\d+)\](?!\/)/gi;
  while ((match = singlePattern.exec(clean)) !== null) {
    const name = match[1].toLowerCase();
    vars[name] = parseInt(match[2]) || 0;
  }

  return vars;
}

// Periodic cleanup of stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (!session.ws && session.disconnectedAt) {
      // Skip timeout for wizard accounts (game devs who may idle for long periods)
      if (session.isWizard) {
        continue;
      }
      const elapsed = now - session.disconnectedAt;
      if (elapsed > SESSION_TIMEOUT_MS) {
        logSessionEvent('SESSION_TIMEOUT', {
          token: token.substring(0, 8),
          user: session.userId,
          char: session.characterName || session.characterId,
          disconnectedFor: Math.round(elapsed / 1000)
        });
        closeSession(session, 'timeout');
      }
    }
  }
}, 60000);

// Create HTTP server for health checks and admin endpoints
const server = http.createServer(async (req, res) => {
  // Enable CORS for admin endpoints
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url);

  if (parsedUrl.pathname === '/') {
    const activeSessions = Array.from(sessions.values()).filter(s => s.mudSocket && !s.mudSocket.destroyed).length;
    const connectedBrowsers = Array.from(sessions.values()).filter(s => s.ws).length;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h1>WMT WebSocket Proxy v${VERSION}</h1>
      <p>WebSocket server running for 3k.org MUD</p>
      <p>Active MUD sessions: ${activeSessions}</p>
      <p>Connected browsers: ${connectedBrowsers}</p>`);
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: VERSION,
      mud: `${MUD_HOST}:${MUD_PORT}`,
      activeSessions: sessions.size
    }));
  } else if (req.url === '/sessions' && req.method === 'GET') {
    // Admin endpoint to list active sessions
    const adminKey = req.headers['x-admin-key'];

    if (!ADMIN_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not configured (ADMIN_KEY not set)' }));
      return;
    }

    if (adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }

    // Build list of active sessions
    const activeSessions = [];
    for (const [token, session] of sessions) {
      const mudConnected = session.mudSocket && !session.mudSocket.destroyed;
      const browserConnected = session.ws && session.ws.readyState === WebSocket.OPEN;

      if (mudConnected || browserConnected) {
        activeSessions.push({
          userId: session.userId || null,
          characterName: session.characterName || null,
          server: session.targetHost === '3scapes.org' ? '3s' : '3k',
          mudConnected,
          browserConnected
        });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      sessions: activeSessions
    }));
  } else if (parsedUrl.pathname === '/logs' && req.method === 'GET') {
    // Admin endpoint to fetch session event logs for debugging
    const adminKey = req.headers['x-admin-key'];

    if (!ADMIN_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not configured (ADMIN_KEY not set)' }));
      return;
    }

    if (adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }

    const logsParams = new URLSearchParams(parsedUrl.query || '');
    const wantPersisted = logsParams.get('persisted') === 'true';
    const typeFilter = logsParams.get('type') || '';

    if (!wantPersisted) {
      // Default: in-memory only (fast, unchanged behavior)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        count: sessionLogs.length,
        maxSize: SESSION_LOG_MAX,
        logs: sessionLogs
      }));
    } else {
      // Fetch persisted logs from IONOS and merge with in-memory
      try {
        let fetchUrl = `${PHP_LOGS_URL}?action=list&limit=2000`;
        if (typeFilter) fetchUrl += `&type=${encodeURIComponent(typeFilter)}`;

        const persisted = await new Promise((resolve, reject) => {
          const reqPHP = https.get(fetchUrl, {
            headers: { 'X-Admin-Key': ADMIN_KEY },
            timeout: 5000
          }, (phpRes) => {
            let data = '';
            phpRes.on('data', chunk => data += chunk);
            phpRes.on('end', () => {
              if (phpRes.statusCode === 200) {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Invalid JSON from IONOS')); }
              } else {
                reject(new Error(`IONOS HTTP ${phpRes.statusCode}`));
              }
            });
          });
          reqPHP.on('error', reject);
          reqPHP.on('timeout', () => { reqPHP.destroy(); reject(new Error('IONOS timeout')); });
        });

        // Merge: persisted logs + in-memory (deduplicate by time+type)
        const persistedLogs = persisted.logs || [];
        const seen = new Set(persistedLogs.map(l => l.time + '|' + l.type));
        const uniqueMemory = sessionLogs.filter(l => !seen.has(l.time + '|' + l.type));
        let merged = [...persistedLogs, ...uniqueMemory];

        // Apply type filter to in-memory entries too
        if (typeFilter) {
          merged = merged.filter(l => l.type && l.type.startsWith(typeFilter));
        }

        // Sort by time
        merged.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          count: merged.length,
          persistedCount: persistedLogs.length,
          memoryCount: sessionLogs.length,
          logs: merged
        }));
      } catch (e) {
        // Fall back to in-memory on IONOS failure
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          count: sessionLogs.length,
          maxSize: SESSION_LOG_MAX,
          logs: sessionLogs,
          persistedError: e.message
        }));
      }
    }
  } else if (req.url === '/broadcast' && req.method === 'POST') {
    // Admin broadcast endpoint
    const adminKey = req.headers['x-admin-key'];

    if (!ADMIN_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Broadcast not configured (ADMIN_KEY not set)' }));
      return;
    }

    if (adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }

    // Read POST body
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 10000) {
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const message = data.message;

        if (!message || typeof message !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Message is required' }));
          return;
        }

        // Broadcast to all connected browsers
        let sentCount = 0;
        for (const [token, session] of sessions) {
          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            try {
              session.ws.send(JSON.stringify({
                type: 'broadcast',
                message: message,
                timestamp: Date.now()
              }));
              sentCount++;
            } catch (e) {
              console.error('Error sending broadcast to session:', e.message);
            }
          }
        }

        console.log(`Broadcast sent to ${sentCount} clients: ${message.substring(0, 50)}...`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          sentTo: sentCount,
          message: 'Broadcast sent'
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });
  } else if (parsedUrl.pathname === '/logs/files' && req.method === 'GET') {
    // List available session log files
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    try {
      const result = [];
      if (fs.existsSync(LOG_DIR)) {
        const dates = fs.readdirSync(LOG_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
        for (const date of dates) {
          const dirPath = path.join(LOG_DIR, date);
          const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')).sort();
          for (const file of files) {
            const stats = fs.statSync(path.join(dirPath, file));
            result.push({ date, file, size: stats.size });
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, files: result }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (parsedUrl.pathname === '/logs/view' && req.method === 'GET') {
    // View a session log file (supports ?date=YYYY-MM-DD&char=Name&tail=N&type=input)
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const params = new URLSearchParams(parsedUrl.query || '');
    const date = params.get('date') || new Date().toISOString().slice(0, 10);
    const char = params.get('char');
    const tail = parseInt(params.get('tail')) || 0;
    const typeFilter = params.get('type') || '';

    if (!char || !/^[a-zA-Z0-9_-]+$/.test(char) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid params. Need ?date=YYYY-MM-DD&char=Name' }));
      return;
    }

    const filePath = path.join(LOG_DIR, date, `${char}.jsonl`);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log file not found' }));
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      let lines = content.trim().split('\n').filter(Boolean);
      if (typeFilter) {
        lines = lines.filter(l => { try { return JSON.parse(l).type === typeFilter; } catch { return false; } });
      }
      if (tail > 0) {
        lines = lines.slice(-tail);
      }
      const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: entries.length, entries }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (parsedUrl.pathname === '/logs/sessions' && req.method === 'GET') {
    // List active sessions for the logged user
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const result = [];
    for (const [token, session] of sessions) {
      if (LOG_USER_ID && String(session.userId) !== LOG_USER_ID) continue;
      result.push({
        token: token.substring(0, 8) + '...',
        userId: session.userId,
        characterId: session.characterId,
        characterName: session.characterName || null,
        mudConnected: !!(session.mudSocket || session.bridgeSocket?.writable),
        wsConnected: !!session.ws,
        targetHost: session.targetHost,
        targetPort: session.targetPort,
        triggerCount: (session.triggers || []).length,
        aliasCount: (session.aliases || []).length,
        tickerCount: (session.tickers || []).length,
        variableCount: Object.keys(session.variables || {}).length,
        createdAt: session.createdAt || null,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, sessions: result }));

  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

console.log(`WMT WebSocket Proxy v${VERSION} starting...`);
console.log(`MUD Server: ${MUD_HOST}:${MUD_PORT}`);
if (BRIDGE_URL) console.log(`Bridge: ${BRIDGE_URL}`);

/**
 * Create a new session object with all required state
 */
function createSession(token) {
  return {
    token: token,
    ws: null,
    mudSocket: null,
    authenticated: false,
    explicitDisconnect: false,
    disconnectedAt: null,
    timeoutHandle: null,

    // Reconnect buffer
    buffer: [],
    bufferOverflow: false,

    // Target MUD server
    targetHost: MUD_HOST,
    targetPort: MUD_PORT,

    // Triggers and aliases
    triggers: [],
    aliases: [],

    // TCP line buffer
    lineBuffer: '',
    lineBufferTimeout: null,

    // ANSI color state
    currentAnsiState: '',

    // MIP state
    mipEnabled: false,
    mipId: null,
    mipDebug: false,
    mipBuffer: '',
    mipStats: {
      hp: { current: 0, max: 0, label: 'HP' },
      sp: { current: 0, max: 0, label: 'SP' },
      gp1: { current: 0, max: 0, label: 'GP1' },
      gp2: { current: 0, max: 0, label: 'GP2' },
      enemy: 0,
      enemyName: '',
      round: 0,
      room: '',
      exits: '',
      gline1: '',
      gline2: '',
      gline1Raw: '',
      gline2Raw: '',
      uptime: '',
      reboot: '',
      guildVars: {}
    },

    // Discord webhook settings (for server-side notifications when browser is closed)
    // Each channel can have its own webhook: { channelName: { discord: bool, webhookUrl: string } }
    discordUsername: 'WMT Client',
    discordChannelPrefs: {},

    // Server-side tickers
    tickers: [],           // Array of ticker objects
    tickerIntervals: {},   // Map of ticker id -> interval timer

    // ChatMon message buffer (persists across session resume)
    chatBuffer: []
  };
}

/**
 * Update session tickers - clears old intervals and starts new ones for enabled tickers
 */
function updateSessionTickers(session, tickers) {
  // Clear all existing intervals
  for (const id in session.tickerIntervals) {
    clearInterval(session.tickerIntervals[id]);
  }
  session.tickerIntervals = {};

  // Store the new tickers array
  session.tickers = tickers;

  // Start intervals for enabled tickers
  tickers.forEach(ticker => {
    if (ticker.enabled && ticker.interval > 0) {
      startTicker(session, ticker);
    }
  });

  console.log(`Tickers updated: ${tickers.filter(t => t.enabled).length} active out of ${tickers.length}`);
}

/**
 * Start a single ticker's interval
 */
function startTicker(session, ticker) {
  if (!ticker.id || !ticker.command || ticker.interval <= 0) return;

  // Clear existing interval if any
  if (session.tickerIntervals[ticker.id]) {
    clearInterval(session.tickerIntervals[ticker.id]);
  }

  const intervalMs = ticker.interval * 1000;

  session.tickerIntervals[ticker.id] = setInterval(() => {
    // Only execute if MUD is connected
    if (session.mudSocket && !session.mudSocket.destroyed) {
      // TinTin++: substitute variables at fire time (not creation time)
      let cmd = substituteUserVariables(ticker.command, session.variables || {}, session.functions || {});
      // Expand aliases before sending
      const expanded = expandCommandWithAliases(cmd, session.aliases || [], 0, session.variables || {}, session.functions || {}, session);
      expanded.forEach(cmd => {
        // Handle #N repeat pattern
        const repeatMatch = cmd.match(/^#(\d+)\s+(.+)$/);
        if (repeatMatch) {
          const count = Math.min(parseInt(repeatMatch[1]), 100);
          const repeatCmd = processEscapes(repeatMatch[2]);
          for (let i = 0; i < count; i++) {
            session.mudSocket.write(repeatCmd + '\r\n');
          }
        } else if (cmd.startsWith('#')) {
          // #var/#math already processed during expansion for sequential side effects
          sendToClient(session, { type: 'client_command', command: cmd });
        } else {
          session.mudSocket.write(processEscapes(cmd) + '\r\n');
        }
      });
    }
  }, intervalMs);
}

/**
 * Stop a single ticker's interval
 */
function stopTicker(session, tickerId) {
  if (session.tickerIntervals[tickerId]) {
    clearInterval(session.tickerIntervals[tickerId]);
    delete session.tickerIntervals[tickerId];
  }
}

/**
 * Clear all tickers for a session (called on disconnect)
 */
function clearAllTickers(session) {
  for (const id in session.tickerIntervals) {
    clearInterval(session.tickerIntervals[id]);
  }
  session.tickerIntervals = {};
}

/**
 * Send a message to the browser, or buffer it if disconnected
 * Buffer keeps the MOST RECENT lines - old lines are dropped when full
 */
function sendToClient(session, message) {
  // Buffer ChatMon messages for replay on session resume
  if (message.type === 'mip_chat' || message.type === 'trigger_chatmon') {
    session.chatBuffer.push(message);
    if (session.chatBuffer.length > CHAT_BUFFER_MAX) {
      session.chatBuffer.shift();
    }
  }

  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    try {
      session.ws.send(JSON.stringify(message));
    } catch (e) {
      console.error('Error sending to client:', e.message);
    }
  } else {
    // Buffer the message - keep most recent, drop oldest
    session.buffer.push(message);
    if (session.buffer.length > SESSION_BUFFER_MAX_LINES) {
      // Remove oldest lines, keep newest
      const dropped = session.buffer.length - SESSION_BUFFER_MAX_LINES;
      session.buffer = session.buffer.slice(dropped);
      if (!session.bufferOverflow) {
        session.bufferOverflow = true;  // Flag that some content was lost
      }
    }
  }
}

/**
 * Replay buffered messages to a newly connected client
 * Uses batching to avoid overwhelming the browser
 */
function replayBuffer(session) {
  if (session.buffer.length === 0) return;

  const ws = session.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const bufferCopy = [...session.buffer];
  const hadOverflow = session.bufferOverflow;
  session.buffer = [];
  session.bufferOverflow = false;

  console.log(`Replaying ${bufferCopy.length} buffered messages to client${hadOverflow ? ' (older content truncated)' : ''}`);

  ws.send(JSON.stringify({
    type: 'system',
    message: hadOverflow
      ? `--- Reconnected. Showing last ${bufferCopy.length} lines (older content truncated) ---`
      : `--- Reconnected. Replaying ${bufferCopy.length} buffered lines ---`
  }));

  // Send in batches with delays to let browser DOM breathe
  const BATCH_SIZE = 25;  // Smaller batches
  const BATCH_DELAY_MS = 50;  // 50ms between batches
  let index = 0;

  function sendBatch() {
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return;

    const end = Math.min(index + BATCH_SIZE, bufferCopy.length);
    for (let i = index; i < end; i++) {
      try {
        session.ws.send(JSON.stringify(bufferCopy[i]));
      } catch (e) {
        console.error('Error replaying buffer:', e.message);
        return;
      }
    }
    index = end;

    if (index < bufferCopy.length) {
      // More to send - wait before next batch to let client render
      setTimeout(sendBatch, BATCH_DELAY_MS);
    } else {
      // Done - send end marker after a brief pause
      setTimeout(() => {
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({
            type: 'system',
            message: '--- End of buffered content ---'
          }));
        }
      }, BATCH_DELAY_MS);
    }
  }

  sendBatch();
}

/**
 * Close a session completely
 */
function closeSession(session, reason) {
  // Guard against double-close (e.g., explicit disconnect + socket close event)
  if (session.closed) return;
  session.closed = true;

  const mudConnected = session.mudSocket && !session.mudSocket.destroyed;
  logSessionEvent('SESSION_CLOSE', {
    token: session.token.substring(0, 8),
    user: session.userId,
    char: session.characterName || session.characterId,
    reason: reason,
    mudWasConnected: mudConnected,
    wizard: session.isWizard
  });
  writeSessionLog(session, 'session', { event: 'close', reason });

  // Clear all tickers
  clearAllTickers(session);

  if (session.mudSocket && !session.mudSocket.destroyed) {
    // Graceful TCP close: end() sends FIN (like TinTin++'s shutdown(SHUT_RDWR))
    // then destroy() as safety net after 1 second
    const sock = session.mudSocket;
    try { sock.end(); } catch (e) {}
    setTimeout(() => {
      if (!sock.destroyed) sock.destroy();
    }, 1000);
  }
  if (session.timeoutHandle) {
    clearTimeout(session.timeoutHandle);
  }
  if (session.lineBufferTimeout) {
    clearTimeout(session.lineBufferTimeout);
  }

  // Clean up user+character tracking (only if this session is still the registered one)
  if (session.userId && session.characterId) {
    const userCharKey = `${session.userId}:${session.characterId}`;
    if (userCharacterSessions.get(userCharKey) === session.token) {
      userCharacterSessions.delete(userCharKey);
    }
  }

  sessions.delete(session.token);
}

/**
 * Parse MIP message and send updates to client
 */
function parseMipMessage(session, msgType, msgData) {
  let updated = false;
  const mipStats = session.mipStats;

  if (session.mipDebug) {
    sendToClient(session, {
      type: 'mip_debug',
      msgType: msgType,
      msgData: msgData
    });
  }

  switch (msgType) {
    case 'FFF':
      parseFFFStats(session, msgData);
      updated = true;
      break;

    case 'BAD':
      mipStats.room = msgData.trim().replace(/\s*\([^)]*\)?(~\d+)?\s*$/, '').trim();
      updated = true;
      break;

    case 'DDD':
      mipStats.exits = msgData.replace(/~/g, ', ');
      updated = true;
      break;

    case 'BBA':
      mipStats.gp1.label = msgData.trim() || 'GP1';
      updated = true;
      break;

    case 'BBB':
      mipStats.gp2.label = msgData.trim() || 'GP2';
      updated = true;
      break;

    case 'BBC':
      mipStats.hp.label = msgData.trim() || 'HP';
      updated = true;
      break;

    case 'BBD':
      mipStats.sp.label = msgData.trim() || 'SP';
      updated = true;
      break;

    case 'BAB': // Tells
      {
        const parts = msgData.split('~');

        // Filter out numeric-only BAB data (e.g. ~0~0) — MIP tell counter, not a real tell
        if (parts[0] === '' && parts.length >= 3 && /^\d+$/.test(parts[1]) && parts.slice(2).every(p => /^\d*$/.test(p))) {
          break;
        }

        let formatted;
        let channel = 'tell';
        let rawText = '';
        let isSoulEcho = false;
        if (parts[0] === '' && parts.length >= 3) {
          const sender = parts[1];
          const message = parts.slice(2).join('~');
          // [you]: lines are soul/emote echoes — show in chatmon but skip Discord
          if (sender.toLowerCase() === 'you') {
            isSoulEcho = true;
          }
          formatted = `<span style="color:#ff8844">[${sender}]:</span> ${convertMipColors(message)}`;
          rawText = `[${sender}]: ${stripAnsi(message)}`;
        } else if (parts[0] === 'x' && parts.length >= 3) {
          const recipient = parts[1];
          const message = parts.slice(2).join('~');
          formatted = `<span style="color:#88ff88">[To ${recipient}]:</span> ${convertMipColors(message)}`;
          rawText = `[To ${recipient}]: ${stripAnsi(message)}`;
        } else {
          formatted = convertMipColors(msgData);
          rawText = stripAnsi(msgData);
        }

        // Skip sending soul echoes ([you]:) to chatmon entirely —
        // the [To recipient]: line already covers it
        if (!isSoulEcho) {
          sendToClient(session, {
            type: 'mip_chat',
            chatType: 'tell',
            channel: channel,
            raw: msgData,
            rawText: rawText,
            message: formatted
          });

          // Server-side Discord notification (works even when browser is closed)
          if (rawText) {
            const channelPrefs = session.discordChannelPrefs['tell'] || session.discordChannelPrefs['Tell'];
            if (channelPrefs?.discord && channelPrefs?.webhookUrl) {
              logSessionEvent('DISCORD_SEND', {
                token: session.token.substring(0, 8),
                user: session.userId,
                char: session.characterName,
                channel: 'tell',
                messagePreview: rawText.substring(0, 50)
              });
              sendToDiscordWebhook(channelPrefs.webhookUrl, rawText, session.discordUsername);
            }
          }
        }
      }
      break;

    case 'CAA': // Chat channels
      {
        const parts = msgData.split('~');
        if (parts[0] === 'ptell' && (
          (msgData.includes('Divvy of') && msgData.includes('coins called by')) ||
          msgData.includes('divvy called by') ||
          msgData.includes('gold divvied, total')
        )) {
          break;
        }

        let formatted;
        let channel = 'chat';
        let rawText = '';
        if (parts.length >= 4) {
          channel = parts[0];
          const message = parts.slice(3).join('~');
          formatted = `<span style="color:#44dddd">[${channel}]</span> ${convertMipColors(message)}`;
          rawText = `[${channel}] ${stripAnsi(message)}`;
        } else if (parts.length >= 2) {
          channel = parts[0];
          const message = parts.slice(1).join('~');
          formatted = `<span style="color:#44dddd">[${channel}]</span> ${convertMipColors(message)}`;
          rawText = `[${channel}] ${stripAnsi(message)}`;
        } else {
          formatted = convertMipColors(msgData);
          rawText = stripAnsi(msgData);
        }
        sendToClient(session, {
          type: 'mip_chat',
          chatType: 'channel',
          channel: channel,
          raw: msgData,
          rawText: rawText,
          message: formatted
        });

        // Server-side Discord notification (works even when browser is closed)
        if (rawText && channel) {
          const channelPrefs = session.discordChannelPrefs[channel] || session.discordChannelPrefs[channel.toLowerCase()];
          if (channelPrefs?.discord && channelPrefs?.webhookUrl) {
            logSessionEvent('DISCORD_SEND', {
              token: session.token.substring(0, 8),
              user: session.userId,
              char: session.characterName,
              channel: channel,
              messagePreview: rawText.substring(0, 50)
            });
            sendToDiscordWebhook(channelPrefs.webhookUrl, rawText, session.discordUsername);
          }
        }
      }
      break;

    case 'AAC': // Reboot time
      {
        const match = msgData.match(/^([\d.]+)/);
        const decimalDays = match ? parseFloat(match[1]) : 0;
        if (decimalDays > 0) {
          const days = Math.floor(decimalDays);
          const hours = Math.round((decimalDays - days) * 24);
          mipStats.reboot = days > 0 ? `${days}d ${hours}h` : `${hours}h`;
        } else {
          mipStats.reboot = '';
        }
        updated = true;
      }
      break;

    case 'AAF': // Uptime
      {
        const match = msgData.match(/^([\d.]+)/);
        const decimalDays = match ? parseFloat(match[1]) : 0;
        if (decimalDays > 0) {
          const days = Math.floor(decimalDays);
          const hours = Math.floor((decimalDays - days) * 24);
          mipStats.uptime = days > 0 ? `${days}d ${hours}h` : `${hours}h`;
        } else {
          mipStats.uptime = '';
        }
        updated = true;
      }
      break;

    case 'BAE':
    case 'HAA':
    case 'HAB':
      break;
  }

  if (updated) {
    sendToClient(session, {
      type: 'mip_stats',
      stats: mipStats
    });
  }
}

/**
 * Parse FFF stats string
 */
function parseFFFStats(session, data) {
  const mipStats = session.mipStats;
  const parts = data.split('~');
  let i = 0;

  while (i < parts.length) {
    const flag = parts[i];

    if (flag.length === 1 && /[A-Z]/.test(flag)) {
      const value = parts[i + 1] || '';

      switch (flag) {
        case 'A': mipStats.hp.current = parseInt(value) || 0; break;
        case 'B': mipStats.hp.max = parseInt(value) || 0; break;
        case 'C': mipStats.sp.current = parseInt(value) || 0; break;
        case 'D': mipStats.sp.max = parseInt(value) || 0; break;
        case 'E': mipStats.gp1.current = parseInt(value) || 0; break;
        case 'F': mipStats.gp1.max = parseInt(value) || 0; break;
        case 'G': mipStats.gp2.current = parseInt(value) || 0; break;
        case 'H': mipStats.gp2.max = parseInt(value) || 0; break;
        case 'K': mipStats.enemyName = value.trim(); break;
        case 'L': mipStats.enemy = parseInt(value) || 0; break;
        case 'N': mipStats.round = parseInt(value) || 0; break;
        case 'I':
          mipStats.gline1Raw = value;
          mipStats.gline1 = convertMipColors(value);
          break;
        case 'J':
          mipStats.gline2Raw = value;
          mipStats.gline2 = convertMipColors(value);
          break;
      }
      i += 2;
    } else {
      i++;
    }
  }

  mipStats.guildVars = parseGuildVars(mipStats.gline1Raw, mipStats.gline2Raw);
}

/**
 * Process a single line from MUD
 */
function processLine(session, line) {
  // Strip carriage returns (MUD sends \r\n, we split on \n leaving \r)
  line = line.replace(/\r/g, '');
  if (line.trim() === '') return;

  // FIRST LINE OF DEFENSE: Gag MIP protocol lines
  if (/%\d{5}\d{3}[A-Z]{3}/.test(line)) {
    const mipMatch = line.match(/%(\d{5})(\d{3})([A-Z]{3})/);
    if (mipMatch && session.mipEnabled) {
      const len = parseInt(mipMatch[2], 10);
      const msgType = mipMatch[3];
      const dataStart = mipMatch.index + mipMatch[0].length;
      const msgData = line.substring(dataStart, dataStart + len);
      parseMipMessage(session, msgType, msgData);
    }
    return;
  }

  // Early MIP filter for before mipId is set
  if (!session.mipId) {
    const pureEarlyMipPattern = /^%?\d{5}\d{3}[A-Z]{3}/;
    if (pureEarlyMipPattern.test(line.trim())) {
      return;
    }

    const embeddedMipPattern = /%(\d{5})(\d{3})([A-Z]{3})/g;
    let strippedLine = line;
    let match;
    while ((match = embeddedMipPattern.exec(line)) !== null) {
      const mipLength = parseInt(match[2], 10);
      const fullMatch = match[0];
      const dataStart = match.index + fullMatch.length;
      const mipData = line.substring(dataStart, dataStart + mipLength);
      const toRemove = fullMatch + mipData;
      strippedLine = strippedLine.replace(toRemove, '');
    }
    if (strippedLine !== line) {
      line = strippedLine;
      if (!line.trim()) return;
    }

    const embeddedKPattern = /#K%(\d{5})(\d{3})([A-Z]{3})/g;
    while ((match = embeddedKPattern.exec(line)) !== null) {
      const mipLength = parseInt(match[2], 10);
      const fullMatch = match[0];
      const dataStart = match.index + fullMatch.length;
      const mipData = line.substring(dataStart, dataStart + mipLength);
      const toRemove = fullMatch + mipData;
      strippedLine = strippedLine.replace(toRemove, '');
    }
    if (strippedLine !== line) {
      line = strippedLine;
      if (!line.trim()) return;
    }
  }

  // MIP filtering when enabled
  if (session.mipEnabled && session.mipId) {
    if (session.mipBuffer) {
      line = session.mipBuffer + line;
      session.mipBuffer = '';
    }

    if (line.endsWith('#K%') || (line.includes('#K%') && line.indexOf('#K%') > line.length - 20)) {
      const mipStart = line.lastIndexOf('#K%');
      const beforeMip = line.substring(0, mipStart);
      if (beforeMip.trim()) {
        const processed = processTriggers(beforeMip, session.triggers, null, session.variables || {}, session.functions || {});
        if (!processed.gag) {
          sendToClient(session, {
            type: 'mud',
            line: processed.line,
            highlight: processed.highlight,
            sound: processed.sound
          });
        }
      }
      session.mipBuffer = line.substring(mipStart);
      return;
    }

    const mipPattern = new RegExp(`#K%${session.mipId}(\\d{3})(\\w{3})`);
    const match = line.match(mipPattern);
    if (match) {
      const mipLength = parseInt(match[1], 10);
      const msgType = match[2];
      const mipStart = match.index;
      const dataStart = mipStart + 3 + 5 + 3 + 3;
      const msgData = line.substring(dataStart, dataStart + mipLength);

      parseMipMessage(session, msgType, msgData);

      const beforeMip = line.substring(0, mipStart);
      const afterMip = line.substring(dataStart + mipLength);
      let displayText = beforeMip + afterMip;
      displayText = displayText.replace(/^\]\s*/, '');

      if (displayText) {
        const processed = processTriggers(displayText, session.triggers, null, session.variables || {}, session.functions || {});
        if (!processed.gag) {
          sendToClient(session, {
            type: 'mud',
            line: processed.line,
            highlight: processed.highlight,
            sound: processed.sound
          });
        }
      }
      return;
    }

    const altMipPattern = new RegExp(`%${session.mipId}(\\d{3})([A-Z]{3})`);
    const altMatch = line.match(altMipPattern);
    if (altMatch) {
      const mipLength = parseInt(altMatch[1], 10);
      const msgType = altMatch[2];
      const mipStart = altMatch.index;
      const dataStart = mipStart + 1 + 5 + 3 + 3;
      const msgData = line.substring(dataStart, dataStart + mipLength);

      parseMipMessage(session, msgType, msgData);

      const beforeMip = line.substring(0, mipStart);
      const afterMip = line.substring(dataStart + mipLength);
      const displayText = beforeMip + afterMip;

      if (displayText.trim()) {
        const processed = processTriggers(displayText, session.triggers, null, session.variables || {}, session.functions || {});
        if (!processed.gag) {
          sendToClient(session, {
            type: 'mud',
            line: processed.line,
            highlight: processed.highlight,
            sound: processed.sound
          });
        }
      }
      return;
    }

    const rawMipPattern = new RegExp(`^%?${session.mipId}\\d{3}[A-Z]{3}`);
    const genericMipPattern = /^%?\d{5}\d{3}[A-Z]{3}/;
    if (rawMipPattern.test(line) || genericMipPattern.test(line)) {
      return;
    }

    if (/~exa\s+#N\/\w+\s+#N\s*$/.test(line)) return;
    if (/^[a-z]+~[a-z]+\s+#N\/\w+\s+#N\s*$/.test(line)) return;
    if (/\s#N\/\w+\s+#N\s*$/.test(line) && line.includes('~')) return;
    if (/^[a-z]+\s+#N\s*$/.test(line) && line.length < 20) return;
    if (/^#N(\/\w+)?\s*(#N)?\s*$/.test(line)) return;
  }

  if (/%\d{5}\d{3}[A-Z]{3}/.test(line)) {
    return;
  }

  // ANSI color state tracking
  const ansiPattern = /\x1b\[([0-9;]+)m/g;
  const startsWithAnsi = /^\x1b\[/.test(line);

  if (!startsWithAnsi && session.currentAnsiState) {
    line = session.currentAnsiState + line;
  }

  let ansiMatch;
  let lastAnsiCode = '';
  while ((ansiMatch = ansiPattern.exec(line)) !== null) {
    const codes = ansiMatch[1];
    if (codes === '0' || codes === '') {
      session.currentAnsiState = '';
    } else {
      lastAnsiCode = ansiMatch[0];
    }
  }
  if (lastAnsiCode && !line.includes('\x1b[0m')) {
    session.currentAnsiState = lastAnsiCode;
  } else if (line.includes('\x1b[0m')) {
    session.currentAnsiState = '';
  }

  // Initialize loop tracker if needed
  if (!session.loopTracker) {
    session.loopTracker = {};
  }

  // Process triggers with loop detection
  const processed = processTriggers(line, session.triggers, session.loopTracker, session.variables || {}, session.functions || {});

  // Log trigger matches that produced commands or gags
  if (processed.commands.length > 0 || processed.gag) {
    writeSessionLog(session, 'trigger', {
      line: stripAnsi(line).substring(0, 200),
      gag: processed.gag,
      cmds: processed.commands.length > 0 ? processed.commands : undefined
    });
  }

  // Handle loop detection - notify client and disable the trigger
  if (processed.loopDetected) {
    const loopTrigger = processed.loopDetected;
    sendToClient(session, {
      type: 'system',
      message: `Loop detected! Trigger "${loopTrigger.name}" fired too many times and has been disabled.`
    });
    // Tell client to disable the trigger
    sendToClient(session, {
      type: 'disable_trigger',
      triggerId: loopTrigger.id
    });
  }

  if (!processed.gag) {
    sendToClient(session, {
      type: 'mud',
      line: processed.line,
      highlight: processed.highlight,
      sound: processed.sound
    });
  }

  // Execute trigger commands (with alias expansion)
  processed.commands.forEach(cmd => {
    if (cmd.startsWith('#')) {
      // Process #math/#var server-side for immediate variable updates
      serverProcessInlineCommand(cmd, session);
      sendToClient(session, {
        type: 'client_command',
        command: cmd
      });
    } else if (session.mudSocket && !session.mudSocket.destroyed) {
      // Expand aliases before sending to MUD
      const expanded = expandCommandWithAliases(cmd, session.aliases || [], 0, session.variables || {}, session.functions || {}, session);
      expanded.forEach(ec => {
        // Check for #N command pattern (e.g., #15 e) - repeat command N times
        const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
        if (repeatMatch) {
          const count = Math.min(parseInt(repeatMatch[1]), 100);
          const repeatCmd = processEscapes(repeatMatch[2]);
          for (let i = 0; i < count; i++) {
            session.mudSocket.write(repeatCmd + '\r\n');
          }
        } else if (ec.startsWith('#')) {
          // #var/#math already processed during expansion for sequential side effects
          sendToClient(session, { type: 'client_command', command: ec });
        } else {
          session.mudSocket.write(processEscapes(ec) + '\r\n');
        }
      });
    }
  });

  // Send Discord webhooks (with user variable substitution, routed through IONOS proxy)
  if (processed.discordWebhooks) {
    processed.discordWebhooks.forEach(webhook => {
      let finalMessage = substituteUserVariables(webhook.message, session.variables || {}, session.functions || {});
      sendToDiscordWebhook(webhook.webhookUrl, finalMessage, session.discordUsername);
    });
  }

  // Send ChatMon messages (with user variable substitution)
  if (processed.chatmonMessages) {
    processed.chatmonMessages.forEach(chat => {
      let finalMessage = substituteUserVariables(chat.message, session.variables || {}, session.functions || {});
      sendToClient(session, {
        type: 'trigger_chatmon',
        message: finalMessage,
        channel: chat.channel
      });
    });
  }
}

/**
 * Create and connect MUD socket for a session
 */
function connectToMud(session) {
  // Thorough cleanup of any existing connection state
  if (session.mudSocket) {
    // Remove all listeners before destroying to prevent spurious events
    session.mudSocket.removeAllListeners();
    if (!session.mudSocket.destroyed) {
      session.mudSocket.destroy();
    }
    session.mudSocket = null;
  }

  // Clear line buffer state from previous connection
  session.lineBuffer = '';
  if (session.lineBufferTimeout) {
    clearTimeout(session.lineBufferTimeout);
    session.lineBufferTimeout = null;
  }

  // Clear MIP state for fresh connection
  session.mipId = null;
  session.currentAnsiState = '';

  session.mudSocket = BRIDGE_URL ? new BridgeSocket(session.token) : new net.Socket();

  if (!BRIDGE_URL) {
    sendToClient(session, {
      type: 'system',
      message: `Connecting to ${session.targetHost}:${session.targetPort}...`
    });
  }

  session.mudSocket.connect(session.targetPort, session.targetHost, () => {
    const wasResumed = BRIDGE_URL && session.mudSocket.resumed;
    console.log(`${wasResumed ? 'Resumed' : 'Connected to'} MUD: ${session.targetHost}:${session.targetPort}${BRIDGE_URL ? ' (via bridge)' : ''}`);
    writeSessionLog(session, 'mud_connect', { host: session.targetHost, port: session.targetPort, resumed: wasResumed });

    if (!wasResumed) {
      // New connection — notify client
      sendToClient(session, {
        type: 'system',
        message: `Connected to ${session.targetHost}:${session.targetPort}!`
      });
      // Bridge mode: only send session_new for new sessions (bridgeMode init).
      // Session resumes already triggered onConnect via onSessionResumed(false) —
      // sending session_new again would cause duplicate char name → bad password.
      if (BRIDGE_URL && session._bridgeModeInit) {
        session._bridgeModeInit = false;
        sendToClient(session, { type: 'session_new' });
      }
    } else {
      // Bridge resume succeeded — existing MUD connection restored.
      // Old clients already ran onConnect (ignored bridgeMode flag), so suppress
      // the auto-login char name they'll send.
      if (session.characterName) {
        session._suppressAutoLogin = session.characterName.toLowerCase();
        session._suppressAutoLoginUntil = Date.now() + 5000;
      }
      // New clients were silent (bridgeMode). Send session_resumed so they
      // show "Session resumed" message, enable MIP, run startup script.
      sendToClient(session, { type: 'session_resumed', mudConnected: true, variables: session.variables || {} });
    }
  });

  session.mudSocket.on('data', (data) => {
    const { buffer: cleanData, hasGA } = stripTelnetSequences(data);
    const text = cleanData.toString('utf8');
    if (text.trim()) writeSessionLog(session, 'output', { text: text.substring(0, 4000) });

    if (session.lineBufferTimeout) {
      clearTimeout(session.lineBufferTimeout);
      session.lineBufferTimeout = null;
    }

    const fullText = session.lineBuffer + text;
    const parts = fullText.split('\n');

    if (hasGA) {
      session.lineBuffer = '';
      parts.forEach(line => processLine(session, line));
      return;
    }

    if (!text.endsWith('\n') && parts.length > 0) {
      session.lineBuffer = parts.pop();
      if (session.lineBuffer) {
        // Packet patch timeout - wait for more data before processing incomplete lines
        // Similar to TinTin++ #config {packet patch} - recommended 0.5-1.0 seconds
        // GA (Go Ahead) signal flushes immediately, so this only affects prompts on MUDs without GA
        session.lineBufferTimeout = setTimeout(() => {
          if (session.lineBuffer) {
            processLine(session, session.lineBuffer);
            session.lineBuffer = '';
          }
        }, 500);
      }
    } else {
      session.lineBuffer = '';
    }

    parts.forEach(line => processLine(session, line));
  });

  session.mudSocket.on('close', () => {
    console.log('MUD connection closed');
    writeSessionLog(session, 'mud_disconnect', {});
    // Don't send misleading messages during server restart — browser already got notified
    if (!session.serverRestarting) {
      sendToClient(session, {
        type: 'system',
        message: 'Connection to MUD closed.'
      });
    }
    // Don't delete session - user might want to reconnect
    // Just clean up the socket reference so reconnect works cleanly
    session.mudSocket = null;
    // If this was an explicit disconnect request, clean up the whole session
    if (session.explicitDisconnect) {
      closeSession(session, 'explicit disconnect');
    }
  });

  session.mudSocket.on('error', (err) => {
    console.error('MUD socket error:', err.message);
    if (!session.serverRestarting) {
      sendToClient(session, {
        type: 'error',
        message: 'MUD connection error: ' + err.message
      });
    }
  });

  // Handle remote close (MUD closes connection, e.g., idle timeout)
  session.mudSocket.on('end', () => {
    console.log('MUD connection ended (remote close)');
    // During server restart, browser already got the "Server restarting" message
    if (!session.serverRestarting) {
      sendToClient(session, {
        type: 'system',
        message: 'MUD has closed the connection (idle timeout or linkdead).'
      });
    }
    if (session.mudSocket) {
      session.mudSocket.destroy();
      session.mudSocket = null;
    }
  });
}

/**
 * Handle WebSocket connection
 */
wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection from:', req.socket.remoteAddress);

  let session = null;
  let authenticated = false;

  // Handle messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Auth must be first message
      if (!authenticated) {
        if (data.type === 'auth') {
          const token = data.token;
          const userId = data.userId;
          const characterId = data.characterId;
          const characterName = data.characterName || null;
          const isWizard = data.isWizard || false;

          if (!token || token.length !== 64) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid auth token' }));
            ws.close();
            return;
          }

          // Check for existing session with same user+character but different token
          // Instead of killing the old MUD connection, re-key the session to keep it alive
          if (userId && characterId) {
            const userCharKey = `${userId}:${characterId}`;
            const existingToken = userCharacterSessions.get(userCharKey);

            if (existingToken && existingToken !== token && sessions.has(existingToken)) {
              const oldSession = sessions.get(existingToken);
              const oldMudConnected = oldSession.mudSocket && !oldSession.mudSocket.destroyed && oldSession.mudSocket.writable;
              const disconnectDuration = oldSession.disconnectedAt ? Math.round((Date.now() - oldSession.disconnectedAt) / 1000) : 0;
              logSessionEvent('SESSION_REKEY', {
                user: userId,
                char: characterName || characterId,
                oldToken: existingToken.substring(0, 8),
                newToken: token.substring(0, 8),
                oldMudConnected: oldMudConnected,
                oldBrowserConnected: !!oldSession.ws,
                disconnectedFor: disconnectDuration,
                wizard: isWizard
              });

              // Notify old browser (if connected) that session was taken
              if (oldSession.ws && oldSession.ws.readyState === WebSocket.OPEN) {
                try {
                  oldSession.ws.send(JSON.stringify({
                    type: 'session_taken',
                    message: 'Session taken over by another device.'
                  }));
                  oldSession.ws.close();
                } catch (e) {}
              }

              // Re-key: move session from old token to new token, keeping MUD alive
              sessions.delete(existingToken);
              oldSession.token = token;
              oldSession.ws = ws;
              oldSession.disconnectedAt = null;
              oldSession.explicitDisconnect = false;
              oldSession.isWizard = isWizard;
              if (oldSession.timeoutHandle) {
                clearTimeout(oldSession.timeoutHandle);
                oldSession.timeoutHandle = null;
              }
              sessions.set(token, oldSession);
              userCharacterSessions.set(userCharKey, token);
              session = oldSession;

              logSessionEvent('SESSION_RESUME', {
                token: token.substring(0, 8),
                user: session.userId,
                char: session.characterName || session.characterId,
                mudConnected: oldMudConnected,
                disconnectedFor: disconnectDuration,
                wizard: session.isWizard,
                bufferSize: session.buffer.length,
                chatBuffer: session.chatBuffer.length,
                note: 'rekeyed from different token'
              });
              writeSessionLog(session, 'session', { event: 'resume', mudConnected: oldMudConnected, disconnectedFor: disconnectDuration });

              // If Discord prefs are empty, fetch from PHP backend
              if (Object.keys(session.discordChannelPrefs).length === 0) {
                fetchDiscordPrefsFromPHP(session.userId, session.characterId, session);
              }

              ws.send(JSON.stringify({
                type: 'session_resumed',
                mudConnected: oldMudConnected,
                variables: session.variables || {}
              }));

              // Clear buffer
              session.buffer = [];
              session.bufferOverflow = false;

              // Send current MIP stats if available
              if (session.mipStats.hp.max > 0) {
                ws.send(JSON.stringify({
                  type: 'mip_stats',
                  stats: session.mipStats
                }));
              }

              // Replay ChatMon buffer
              if (session.chatBuffer.length > 0) {
                console.log(`Replaying ${session.chatBuffer.length} ChatMon messages (rekey)`);
                for (const msg of session.chatBuffer) {
                  try {
                    ws.send(JSON.stringify(msg));
                  } catch (e) {
                    console.error('Error replaying chat buffer:', e.message);
                    break;
                  }
                }
              }

              authenticated = true;
              return;  // Skip normal session creation/resume
            }

            // Register this token for this user+character
            userCharacterSessions.set(userCharKey, token);
          }

          // Check for existing session with same token
          if (sessions.has(token)) {
            session = sessions.get(token);

            // Check if another browser is already connected
            if (session.ws && session.ws.readyState === WebSocket.OPEN) {
              logSessionEvent('SESSION_TAKEOVER', {
                token: token.substring(0, 8),
                user: session.userId,
                char: session.characterName || session.characterId,
                note: 'new browser taking over from existing browser'
              });
              try {
                // Send session_taken so old client knows not to reconnect
                session.ws.send(JSON.stringify({
                  type: 'session_taken',
                  message: 'Session taken over by another device.'
                }));
                session.ws.close();
              } catch (e) {}
            }

            // Attach new WebSocket
            session.ws = ws;
            session.disconnectedAt = null;
            session.explicitDisconnect = false;
            session.isWizard = isWizard;  // Update wizard status on reconnect
            if (session.timeoutHandle) {
              clearTimeout(session.timeoutHandle);
              session.timeoutHandle = null;
            }

            const mudConnected = session.mudSocket && !session.mudSocket.destroyed && session.mudSocket.writable;
            const disconnectDuration = session.disconnectedAt ? Math.round((Date.now() - session.disconnectedAt) / 1000) : 0;
            logSessionEvent('SESSION_RESUME', {
              token: token.substring(0, 8),
              user: session.userId,
              char: session.characterName || session.characterId,
              mudConnected: mudConnected,
              disconnectedFor: disconnectDuration,
              wizard: session.isWizard,
              bufferSize: session.buffer.length,
              chatBuffer: session.chatBuffer.length
            });
            writeSessionLog(session, 'session', { event: 'resume', mudConnected, disconnectedFor: disconnectDuration });

            // If Discord prefs are empty, fetch from PHP backend
            // This handles the case where server restarted while browser was disconnected
            if (Object.keys(session.discordChannelPrefs).length === 0) {
              fetchDiscordPrefsFromPHP(session.userId, session.characterId, session);
            }

            ws.send(JSON.stringify({
              type: 'session_resumed',
              mudConnected: mudConnected,
              variables: session.variables || {}
            }));

            // Clear buffer - user doesn't need history replay, just resume receiving new lines
            session.buffer = [];
            session.bufferOverflow = false;

            // Send current MIP stats if available
            if (session.mipStats.hp.max > 0) {
              ws.send(JSON.stringify({
                type: 'mip_stats',
                stats: session.mipStats
              }));
            }

            // Replay ChatMon buffer so chat history survives refresh
            if (session.chatBuffer.length > 0) {
              console.log(`Replaying ${session.chatBuffer.length} ChatMon messages`);
              for (const msg of session.chatBuffer) {
                try {
                  ws.send(JSON.stringify(msg));
                } catch (e) {
                  console.error('Error replaying chat buffer:', e.message);
                  break;
                }
              }
            }
          } else {
            // Create new session
            session = createSession(token);
            session.ws = ws;
            session.userId = userId;
            session.characterId = characterId;
            session.characterName = characterName;
            session.isWizard = isWizard;
            sessions.set(token, session);

            logSessionEvent('SESSION_NEW', {
              token: token.substring(0, 8),
              user: userId,
              char: characterName || characterId,
              wizard: isWizard
            });
            writeSessionLog(session, 'session', { event: 'new', user: userId, char: characterName || characterId });

            // Fetch Discord prefs from PHP backend (survives server restarts)
            // Do this async so we don't block the session creation
            fetchDiscordPrefsFromPHP(userId, characterId, session);

            if (BRIDGE_URL) {
              // Bridge mode: send session_new with bridgeMode flag so the client
              // sends triggers/aliases silently (no messages, no char name).
              // We defer connectToMud (via _pendingBridgeResume) until triggers
              // arrive, then try bridge resume.
              // After bridge responds: session_resumed (existing connection) or
              // session_new without bridgeMode (new connection, triggers login).
              // Old clients ignore bridgeMode flag and run full onConnect — the
              // server-side _suppressAutoLogin handles the char name for those.
              session._pendingBridgeResume = true;
              session._bridgeModeInit = true;  // Track that this was a bridgeMode new session
              ws.send(JSON.stringify({
                type: 'session_new',
                bridgeMode: true
              }));
            } else {
              ws.send(JSON.stringify({
                type: 'session_new'
              }));
            }
          }

          authenticated = true;
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Must authenticate first' }));
        }
        return;
      }

      // Handle authenticated messages
      switch (data.type) {
        case 'command':
          // Queue commands until aliases have synced from client (prevents
          // commands being sent raw to MUD before alias expansion is ready).
          if (!session._aliasesSynced) {
            if (!session._commandQueue) session._commandQueue = [];
            session._commandQueue.push(data);
            // Safety timeout: flush after 3s even if sync never arrives
            if (!session._syncTimeout) {
              session._syncTimeout = setTimeout(() => {
                session._aliasesSynced = true;
                if (session._commandQueue && session._commandQueue.length > 0) {
                  const queued = session._commandQueue;
                  session._commandQueue = [];
                  queued.forEach(qd => {
                    // Re-emit as command
                    ws.emit('message', JSON.stringify({ type: 'command', ...qd }));
                  });
                }
              }, 3000);
            }
            break;
          }
          // Suppress auto-login character name after bridge resume.
          // onConnect sends the name after 1.5s, but for resumed sessions
          // the MUD is already logged in — silently drop it.
          if (session._suppressAutoLogin && Date.now() < session._suppressAutoLoginUntil) {
            const cmdLower = (data.command || '').trim().toLowerCase();
            if (cmdLower === session._suppressAutoLogin) {
              console.log(`Suppressed auto-login for resumed bridge session: ${session.characterName}`);
              session._suppressAutoLogin = null;
              break;
            }
          }
          if (session.mudSocket && !session.mudSocket.destroyed) {
            writeSessionLog(session, 'input', { cmd: data.command || '' });
            // If raw flag is set, send as-is without semicolon splitting or alias processing
            // (used by #send for ANSI codes containing semicolons)
            if (data.raw) {
              session.mudSocket.write((data.command || '') + '\r\n');
            } else {
              // Recursively expand aliases and handle semicolons.
              // TinTin++ processes commands sequentially: #var/#math in an alias
              // body take effect immediately so later commands in the same body
              // see updated variables (e.g. "#var x 1;dostep$x").
              const ASYNC_READ_RE = /^#(?:class\s+\{[^}]*\}\s+\{read\}|read\b)/i;
              let hitAsyncRead = false;  // Once set, stop expanding — remaining go to client

              const expandCommand = (cmd, depth = 0) => {
                if (depth > 10) return [cmd];
                const trimmed = cmd.trim();
                if (!trimmed) return [];

                // After a #read/#class read, don't expand — return literal for client
                if (hitAsyncRead) return [trimmed];

                // For # commands: execute #var/#math inline for side effects,
                // then return the command for client forwarding
                if (trimmed.startsWith('#')) {
                  // Check if this is an async read — stop expanding after it
                  if (ASYNC_READ_RE.test(trimmed)) {
                    hitAsyncRead = true;
                  } else {
                    serverProcessInlineCommand(trimmed, session);
                  }
                  return [trimmed];
                }

                // Substitute $variables BEFORE alias pattern matching
                const substituted = substituteUserVariables(trimmed, session.variables || {}, session.functions || {});
                const expanded = processAliases(substituted, session.aliases, session.variables || {}, session.functions || {});
                if (expanded === substituted) {
                  return [substituted];
                }

                // Alias matched - split result and recursively expand each part
                const parts = parseCommands(expanded);
                const results = [];
                parts.forEach(part => {
                  results.push(...expandCommand(part, depth + 1));
                });
                return results;
              };

              // TinTin++ sequential execution: expand and execute each command
              // one at a time so that #var/#math side effects are visible to
              // subsequent commands in the same chain.
              // e.g. "#var x 1;dosomething$x" — $x must be 1 when dosomething expands.
              const executeOneCommand = (ec) => {
                // Detect #class {X} {read} {Y} or #read {Y} — async script loading
                const isAsyncRead = /^#(?:class\s+\{[^}]*\}\s+\{read\}|read\b)/i.test(ec);
                if (isAsyncRead) {
                  return 'async_read';
                }
                // Check for #N command pattern (e.g., #15 e) - repeat command N times
                const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
                if (repeatMatch) {
                  const count = Math.min(parseInt(repeatMatch[1]), 100);
                  const repeatCmd = processEscapes(repeatMatch[2]);
                  for (let i = 0; i < count; i++) {
                    session.mudSocket.write(repeatCmd + '\r\n');
                  }
                } else if (ec.startsWith('#')) {
                  // #var/#math already processed during expansion (for sequential side effects)
                  // Forward to client for #delay, #showme, etc.
                  sendToClient(session, { type: 'client_command', command: ec });
                } else {
                  session.mudSocket.write(processEscapes(ec) + '\r\n');
                }
                return 'ok';
              };

              // Split initial command by semicolons
              const commands = parseCommands(data.command || '');
              let didSomething = false;

              for (const c of commands) {
                // Expand this one command (alias resolution + variable sub)
                const expanded = expandCommand(c);
                for (let ci = 0; ci < expanded.length; ci++) {
                  const ec = expanded[ci];
                  didSomething = true;
                  const result = executeOneCommand(ec);
                  if (result === 'async_read') {
                    // Bundle this + remaining expanded + remaining top-level into one client_command
                    const remaining = [...expanded.slice(ci), ...commands.slice(commands.indexOf(c) + 1)].join(';');
                    sendToClient(session, { type: 'client_command', command: remaining });
                    didSomething = true;
                    // Break out of both loops
                    return;
                  }
                }
              }

              if (!didSomething) {
                session.mudSocket.write('\r\n');
              }
            }
          }
          break;

        case 'set_triggers':
          session.triggers = data.triggers || [];
          writeSessionLog(session, 'settings', { what: 'triggers', count: session.triggers.length });
          // Bridge mode: triggers arrived, now safe to resume bridge connection.
          // MUD data will flow through processLine with triggers ready.
          if (session._pendingBridgeResume) {
            session._pendingBridgeResume = false;
            connectToMud(session);
          }
          break;

        case 'set_aliases':
          session.aliases = data.aliases || [];
          writeSessionLog(session, 'settings', { what: 'aliases', count: session.aliases.length });
          // Mark synced and flush any queued commands
          if (!session._aliasesSynced) {
            session._aliasesSynced = true;
            if (session._syncTimeout) {
              clearTimeout(session._syncTimeout);
              session._syncTimeout = null;
            }
            if (session._commandQueue && session._commandQueue.length > 0) {
              const queued = session._commandQueue;
              session._commandQueue = [];
              queued.forEach(qd => {
                ws.emit('message', JSON.stringify({ type: 'command', ...qd }));
              });
            }
          }
          break;

        case 'set_tickers':
          // Update tickers and restart intervals
          updateSessionTickers(session, data.tickers || []);
          writeSessionLog(session, 'settings', { what: 'tickers', count: (data.tickers || []).length });
          break;

        case 'set_variables':
          // Merge client variables instead of wholesale replace.
          // Protect variables recently modified server-side (by #math/#var in
          // trigger/alias expansion) from being overwritten by stale client sync.
          {
            const incoming = data.variables || {};
            if (!session.variables) session.variables = {};
            const now = Date.now();
            const SERVER_VAR_PROTECT_MS = 2000; // 2s protection window
            for (const key of Object.keys(incoming)) {
              const serverMod = (session._varServerModified && session._varServerModified[key]) || 0;
              if (now - serverMod > SERVER_VAR_PROTECT_MS) {
                session.variables[key] = incoming[key];
              }
            }
            // Remove variables deleted client-side (not in incoming),
            // unless they were recently set server-side
            for (const key of Object.keys(session.variables)) {
              if (!(key in incoming)) {
                const serverMod = (session._varServerModified && session._varServerModified[key]) || 0;
                if (now - serverMod > SERVER_VAR_PROTECT_MS) {
                  delete session.variables[key];
                }
              }
            }
          }
          writeSessionLog(session, 'settings', { what: 'variables', count: Object.keys(session.variables).length });
          break;

        case 'set_functions':
          session.functions = data.functions || {};
          break;

        case 'set_mip':
          session.mipEnabled = data.enabled || false;
          session.mipId = data.mipId || null;
          session.mipDebug = data.debug || false;
          console.log(`MIP ${session.mipEnabled ? 'enabled' : 'disabled'}${session.mipId ? ' (ID: ' + session.mipId + ')' : ''}`);
          break;

        case 'set_discord_prefs':
          // Store Discord preferences for server-side notifications
          // Each channel can have its own webhook URL
          session.discordUsername = data.username || 'WMT Client';
          session.discordChannelPrefs = {};

          // Validate and store per-channel webhook URLs
          const channelPrefs = data.channelPrefs || {};
          let webhookCount = 0;
          for (const [channel, prefs] of Object.entries(channelPrefs)) {
            session.discordChannelPrefs[channel] = {
              sound: prefs.sound || false,
              hidden: prefs.hidden || false,
              discord: prefs.discord || false,
              webhookUrl: null
            };
            // Validate webhook URL if provided
            if (prefs.webhookUrl && prefs.discord) {
              if (prefs.webhookUrl.startsWith('https://discord.com/api/webhooks/') ||
                  prefs.webhookUrl.startsWith('https://discordapp.com/api/webhooks/')) {
                session.discordChannelPrefs[channel].webhookUrl = prefs.webhookUrl;
                webhookCount++;
              }
            }
          }
          logSessionEvent('DISCORD_PREFS_SET', {
            token: session.token.substring(0, 8),
            user: session.userId,
            char: session.characterName,
            webhookCount: webhookCount,
            totalChannels: Object.keys(session.discordChannelPrefs).length,
            channels: Object.keys(session.discordChannelPrefs).join(',')
          });
          break;

        case 'set_server':
          if (data.host && data.port) {
            const allowedServers = [
              { host: '3k.org', port: 3000 },
              { host: '3scapes.org', port: 3200 }
            ];
            const isAllowed = allowedServers.some(s => s.host === data.host && s.port === data.port);
            if (isAllowed) {
              session.targetHost = data.host;
              session.targetPort = data.port;
              console.log(`Target server set to ${session.targetHost}:${session.targetPort}`);
              // In bridge mode, defer connectToMud until triggers arrive
              // to prevent MUD data flowing before gags/triggers are loaded.
              if (BRIDGE_URL && session._pendingBridgeResume) {
                // Will be called from set_triggers handler
              } else if (BRIDGE_URL && session.mudSocket && !session.mudSocket.destroyed) {
                // Already connected via bridge resume — skip
              } else {
                connectToMud(session);
              }
            } else {
              console.log(`Rejected invalid server: ${data.host}:${data.port}`);
              ws.send(JSON.stringify({
                type: 'system',
                message: `Invalid server: ${data.host}:${data.port}`
              }));
            }
          }
          break;

        case 'keepalive':
          ws.send(JSON.stringify({ type: 'keepalive_ack' }));
          break;

        case 'health_check':
          // Respond immediately - proves connection is alive
          ws.send(JSON.stringify({ type: 'health_ok' }));
          break;

        case 'reconnect':
          console.log('Reconnect requested');
          connectToMud(session);
          break;

        case 'test_line':
          // Process text through triggers as if it came from MUD
          // Used by #showme to test trigger patterns
          if (data.line) {
            const processed = processTriggers(data.line, session.triggers, null, session.variables || {}, session.functions || {});

            // Send to client (even if gagged, for testing)
            sendToClient(session, {
              type: 'mud',
              line: processed.line,
              highlight: processed.highlight,
              sound: processed.sound,
              test: true  // Flag so client knows this is test output
            });

            // Execute any trigger commands (with alias expansion)
            processed.commands.forEach(cmd => {
              if (cmd.startsWith('#')) {
                serverProcessInlineCommand(cmd, session);
                sendToClient(session, {
                  type: 'client_command',
                  command: cmd
                });
              } else if (session.mudSocket && !session.mudSocket.destroyed) {
                // Expand aliases before sending to MUD
                const expanded = expandCommandWithAliases(cmd, session.aliases || [], 0, session.variables || {}, session.functions || {}, session);
                expanded.forEach(ec => {
                  const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
                  if (repeatMatch) {
                    const count = Math.min(parseInt(repeatMatch[1]), 100);
                    const repeatCmd = processEscapes(repeatMatch[2]);
                    for (let i = 0; i < count; i++) {
                      session.mudSocket.write(repeatCmd + '\r\n');
                    }
                  } else if (ec.startsWith('#')) {
                    // #var/#math already processed during expansion for sequential side effects
                    sendToClient(session, { type: 'client_command', command: ec });
                  } else {
                    session.mudSocket.write(processEscapes(ec) + '\r\n');
                  }
                });
              }
            });

            // Send Discord webhooks (with user variable substitution, routed through IONOS proxy)
            if (processed.discordWebhooks) {
              processed.discordWebhooks.forEach(webhook => {
                let finalMessage = substituteUserVariables(webhook.message, session.variables || {}, session.functions || {});
                sendToDiscordWebhook(webhook.webhookUrl, finalMessage, session.discordUsername);
              });
            }

            // Send ChatMon messages (with user variable substitution)
            if (processed.chatmonMessages) {
              processed.chatmonMessages.forEach(chat => {
                let finalMessage = substituteUserVariables(chat.message, session.variables || {}, session.functions || {});
                sendToClient(session, {
                  type: 'trigger_chatmon',
                  message: finalMessage,
                  channel: chat.channel
                });
              });
            }
          }
          break;

        case 'disconnect':
          // Explicit disconnect - close MUD connection
          logSessionEvent('SESSION_EXPLICIT_DISCONNECT', {
            token: session.token.substring(0, 8),
            user: session.userId,
            char: session.characterName || session.characterId
          });
          session.explicitDisconnect = true;
          closeSession(session, 'explicit disconnect');
          break;
      }
    } catch (e) {
      console.error('Error processing message:', e);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket closed');
    if (session) {
      if (session.explicitDisconnect) {
        // Already handled
        return;
      }

      // Unexpected disconnect - keep MUD connection alive
      session.ws = null;
      session.disconnectedAt = Date.now();

      const mudConnected = session.mudSocket && !session.mudSocket.destroyed;
      logSessionEvent('SESSION_BROWSER_DISCONNECT', {
        token: session.token.substring(0, 8),
        user: session.userId,
        char: session.characterName || session.characterId,
        mudConnected: mudConnected,
        wizard: session.isWizard,
        willTimeout: !session.isWizard
      });
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    if (session) {
      session.ws = null;
      session.disconnectedAt = Date.now();
    }
  });
});

/**
 * Convert TinTin++ pattern to JavaScript regex
 * Reference: https://tintin.mudhalla.net/manual/pcre.php
 *
 * All wildcards are GREEDY (capture as much as possible)
 * PCRE can be embedded with { } braces (converted to parentheses)
 */
function tinTinToRegex(pattern) {
  let result = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '\\' && i + 1 < pattern.length) {
      // Escape sequences
      const next = pattern[i + 1];
      if (next === '%') {
        result += '%';
        i += 2;
      } else if (next === '{' || next === '}') {
        // Escaped braces become literal
        result += '\\' + next;
        i += 2;
      } else {
        result += '\\' + next;
        i += 2;
      }
    } else if (char === '{') {
      // PCRE embedding: { } becomes ( ) with content passed through
      // Find matching closing brace
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
      // Convert to capturing group (or non-capturing if preceded by %!)
      result += '(' + pcreContent + ')';
      i = j;
    } else if (char === '%') {
      if (i + 1 < pattern.length) {
        let next = pattern[i + 1];
        let nonCapturing = false;

        // Check for non-capturing prefix %!
        if (next === '!' && i + 2 < pattern.length) {
          nonCapturing = true;
          next = pattern[i + 2];
          i += 1;

          // Special case: %!{ for non-capturing PCRE group
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

        // Range syntax: %+min..max[type] or %+min[type]
        if (next === '+' && i + 2 < pattern.length) {
          const rangeMatch = pattern.slice(i + 2).match(/^(\d+)(?:\.\.(\d+))?([dDwWsSaApPuU])?/);
          if (rangeMatch) {
            const min = rangeMatch[1];
            const max = rangeMatch[2] || '';
            const type = rangeMatch[3] || '.';
            const charClass = getCharClass(type);
            if (max) {
              result += `${groupStart}${charClass}{${min},${max}})`;
            } else {
              result += `${groupStart}${charClass}{${min},})`;
            }
            i += 2 + rangeMatch[0].length;
            continue;
          }
        }

        // TinTin++: wildcards are non-greedy when more pattern follows,
        // greedy only at end of pattern (matches tintin_regexp in regex.c)
        const advanceBy = nonCapturing ? 3 : 2;
        const atEnd = (i + advanceBy >= pattern.length);
        const lazy = atEnd ? '' : '?';

        if (next === '*') {
          result += groupStart + '.*' + lazy + ')';
          i += 2;
        } else if (next === '+') {
          result += groupStart + '.+' + lazy + ')';
          i += 2;
        } else if (next === '?') {
          result += groupStart + '.?)';
          i += 2;
        } else if (next === '.') {
          result += groupStart + '.)';
          i += 2;
        } else if (next === 'd') {
          result += groupStart + '[0-9]*' + lazy + ')';
          i += 2;
        } else if (next === 'D') {
          result += groupStart + '[^0-9]*' + lazy + ')';
          i += 2;
        } else if (next === 'w') {
          result += groupStart + '[A-Za-z0-9_]*' + lazy + ')';
          i += 2;
        } else if (next === 'W') {
          result += groupStart + '[^A-Za-z0-9_]*' + lazy + ')';
          i += 2;
        } else if (next === 's') {
          result += groupStart + '\\s*' + lazy + ')';
          i += 2;
        } else if (next === 'S') {
          result += groupStart + '\\S*' + lazy + ')';
          i += 2;
        } else if (next === 'a') {
          result += groupStart + '[\\s\\S]*' + lazy + ')';
          i += 2;
        } else if (next === 'A') {
          result += groupStart + '[\\r\\n]*' + lazy + ')';
          i += 2;
        } else if (next === 'c') {
          // ANSI color codes - always non-capturing
          result += '(?:\\x1b\\[[0-9;]*m)*';
          i += 2;
        } else if (next === 'p') {
          result += groupStart + '[\\x20-\\x7E]*' + lazy + ')';
          i += 2;
        } else if (next === 'P') {
          result += groupStart + '[^\\x20-\\x7E]*' + lazy + ')';
          i += 2;
        } else if (next === 'u') {
          result += groupStart + '.*' + lazy + ')';
          i += 2;
        } else if (next === 'U') {
          result += groupStart + '[\\x00-\\x7F]*' + lazy + ')';
          i += 2;
        } else if (next === 'i' || next === 'I') {
          // Case sensitivity modifiers - consumed but not converted
          // (matching is case-insensitive by default in our implementation)
          i += 2;
        } else if (next >= '0' && next <= '9') {
          // Numbered capture groups %0-%99
          let j = i + 1;
          while (j < pattern.length && pattern[j] >= '0' && pattern[j] <= '9') {
            j++;
          }
          const numAtEnd = (j >= pattern.length);
          result += '(.*' + (numAtEnd ? '' : '?') + ')';
          i = j;
        } else {
          // Unknown % sequence - treat as literal
          result += '%';
          i += 1;
        }
      } else {
        result += '%';
        i += 1;
      }
    } else if (char === '^' || char === '$') {
      // Anchors pass through
      result += char;
      i += 1;
    } else if ('[]())|+?*.\\'.includes(char)) {
      // Escape regex metacharacters (except { } which are handled above)
      result += '\\' + char;
      i += 1;
    } else {
      result += char;
      i += 1;
    }
  }

  return result;
}

function getCharClass(type) {
  switch (type) {
    case 'd': return '[0-9]';
    case 'D': return '[^0-9]';
    case 'w': return '[A-Za-z0-9_]';
    case 'W': return '[^A-Za-z0-9_]';
    case 's': return '\\s';
    case 'S': return '\\S';
    case 'a': return '[\\s\\S]';
    case 'A': return '[\\r\\n]';
    case 'p': return '[\\x20-\\x7E]';
    case 'P': return '[^\\x20-\\x7E]';
    case 'u': return '.';
    case 'U': return '[\\x00-\\x7F]';
    default: return '.';
  }
}

function replaceTinTinVars(command, matches) {
  let result = command;

  // Strip ANSI escape codes from captured values to prevent command corruption
  const stripAnsi = (str) => str ? str.replace(/\x1b\[[0-9;]*m/g, '') : '';

  // SUB_SEC: Escape special TinTin++ characters in captured values to prevent injection.
  // MUD text captured by %1-%99 could contain $, ;, @, \ which would cause
  // unintended variable substitution, command splitting, or function calls.
  // (TinTin++ source: trigger.c applies SUB_ARG|SUB_SEC to action body)
  const secEscape = (str) => str
    .replace(/\\/g, '\\\\')   // \ → \\ (must be first)
    .replace(/\$/g, '$$')     // $ → $$ (literal dollar escape)
    .replace(/;/g, '\\;')     // ; → \; (literal semicolon escape)
    .replace(/@/g, '\\@');    // @ → \@ (future-proof for @func{})

  // Handle %% literal escape: %% → placeholder, restore after substitution
  const PCT_PLACEHOLDER = '\x00PCT\x00';
  result = result.replace(/%%/g, PCT_PLACEHOLDER);

  if (matches && matches.length > 0) {
    for (let i = 0; i < matches.length && i < 100; i++) {
      const regex = new RegExp('%' + i + '(?![0-9])', 'g');
      const cleanValue = secEscape(stripAnsi(matches[i] || ''));
      result = result.replace(regex, cleanValue);
    }
  }

  result = result.replace(/%\d+/g, '');

  // Restore %% escapes → literal %
  result = result.replace(/\x00PCT\x00/g, '%');

  return result;
}

function parseCommands(input) {
  const commands = [];
  let current = '';
  let escaped = false;
  let braceDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      // TinTin++ tokenizer behavior: keep \X as two chars intact.
      // The only purpose of \ here is to prevent splitting on ;
      // processEscapes() handles the actual conversions later (SUB_ESC).
      current += '\\' + char;
      escaped = false;
    } else if (char === '\\') {
      // Don't add backslash yet - wait to see if next char is ; or \
      escaped = true;
    } else if (char === '{') {
      current += char;
      braceDepth++;
    } else if (char === '}') {
      current += char;
      braceDepth--;
    } else if ((char === ';' || char === '\n' || char === '\r') && braceDepth === 0) {
      // Split on semicolons or newlines outside of braces
      if (current.trim()) commands.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  // Trailing backslash with no next char - keep it
  if (escaped) current += '\\';
  if (current.trim()) commands.push(current.trim());
  return commands;
}

/**
 * TinTin++ SUB_ESC: Process escape sequences in text before sending to MUD.
 * Called at write_mud points — NOT during tokenization or alias matching.
 * Handles: \; \\ \n \t \r \a \b \e \xHH
 */
function processEscapes(str) {
  if (!str || !str.includes('\\')) return str;
  let result = '';
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\' && i + 1 < str.length) {
      const next = str[i + 1];
      switch (next) {
        case ';':  result += ';';    i++; break;
        case '\\': result += '\\';   i++; break;
        case 'n':  result += '\n';   i++; break;
        case 't':  result += '\t';   i++; break;
        case 'r':  result += '\r';   i++; break;
        case 'a':  result += '\x07'; i++; break;
        case 'b':  result += '\x08'; i++; break;
        case 'e':  result += '\x1b'; i++; break;
        case 'x':
          if (i + 3 < str.length) {
            const hex = str.substring(i + 2, i + 4);
            const code = parseInt(hex, 16);
            if (!isNaN(code)) {
              result += String.fromCharCode(code);
              i += 3;
            } else {
              result += '\\x'; i++;
            }
          } else {
            result += '\\x'; i++;
          }
          break;
        default:
          result += '\\' + next; i++;
          break;
      }
    } else {
      result += str[i];
    }
  }
  return result;
}

function processAliases(command, aliases, variables = {}, functions = {}) {
  // Sort by priority (lower fires first, default 5) — TinTin++ convention
  const sorted = [...aliases].sort((a, b) => (a.priority || 5) - (b.priority || 5));

  for (const alias of sorted) {
    if (!alias.enabled) continue;

    const matchType = alias.matchType || 'exact';
    let matched = false;
    let matches = [];
    let tintinRemaining = '';

    switch (matchType) {
      case 'regex':
        try {
          const regex = new RegExp(alias.pattern);
          const match = command.match(regex);
          if (match) {
            matched = true;
            matches = match;
          }
        } catch (e) {}
        break;

      case 'tintin':
        try {
          const regexPattern = tinTinToRegex(alias.pattern);
          // TinTin++ PCRE2_ANCHORED: match from start only (no end anchor)
          // Remaining text after match becomes additional args for %N
          const regex = new RegExp('^' + regexPattern);
          const match = command.match(regex);
          if (match) {
            matched = true;
            // TinTin++ behavior: %0 = full input, captures from regex,
            // then remaining text parsed as additional space-separated args
            const remaining = command.substring(match[0].length).trim();
            matches = [command]; // %0 = full command
            for (let ci = 1; ci < match.length; ci++) {
              matches.push(match[ci] || '');
            }
            if (remaining) {
              remaining.split(/\s+/).forEach(w => matches.push(w));
            }
            tintinRemaining = remaining;
          }
        } catch (e) {
          console.error('TinTin alias pattern error:', e.message);
        }
        break;

      case 'startsWith':
        if (command === alias.pattern || command.startsWith(alias.pattern + ' ')) {
          matched = true;
          const parts = command.split(' ');
          matches = [parts[0], ...parts.slice(1)];
        }
        break;

      case 'exact':
      default:
        const parts = command.split(' ');
        const cmd = parts[0];
        if (cmd === alias.pattern) {
          matched = true;
          matches = [cmd, ...parts.slice(1)];
        }
        break;
    }

    if (matched) {
      let replacement = alias.replacement;

      if (matchType === 'tintin') {
        // TinTin++ passthrough: if body has no %N tokens and there are extra args, append
        const hasPercentN = /%\d/.test(alias.replacement);
        replacement = replaceTinTinVars(replacement, matches);
        if (!hasPercentN && tintinRemaining) {
          replacement = replacement.trim() + ' ' + tintinRemaining;
        }
      } else if (matchType === 'regex') {
        matches.forEach((m, i) => {
          replacement = replacement.replace(new RegExp('\\$' + i, 'g'), m || '');
        });
        replacement = replacement.replace(/\$\d+/g, '');
      } else {
        const args = matches.slice(1).join(' ');
        // If replacement has no $* or $N placeholders and there are args,
        // append them automatically (TinTin++ behavior: #alias {info} {priest}
        // with "info general" sends "priest general")
        const hasPlaceholders = /\$[\d*]/.test(replacement);
        if (!hasPlaceholders && args) {
          replacement = replacement + ' ' + args;
        } else {
          replacement = replacement.replace(/\$\*/g, args);
          const argParts = args.split(/\s+/).filter(p => p);
          for (let i = 0; i < argParts.length; i++) {
            replacement = replacement.replace(new RegExp('\\$' + (i + 1), 'g'), argParts[i]);
          }
          replacement = replacement.replace(/\$\d+/g, '');
        }
      }

      return replacement.trim();
    }
  }
  return command;
}

/**
 * Recursively expand aliases in a command string
 * Returns an array of fully-expanded commands
 */
function expandCommandWithAliases(cmd, aliases, depth = 0, variables = {}, functions = {}, session = null, state = null) {
  if (depth > 10) return [cmd];
  const trimmed = cmd.trim();
  if (!trimmed) return [];
  if (!state) state = { hitAsyncRead: false };

  const ASYNC_READ_RE = /^#(?:class\s+\{[^}]*\}\s+\{read\}|read\b)/i;
  const initialParts = parseCommands(trimmed);
  const results = [];

  initialParts.forEach(part => {
    const partTrimmed = part.trim();

    // After a #read/#class read, don't expand — return literal for client
    if (state.hitAsyncRead) {
      results.push(partTrimmed);
      return;
    }

    // TinTin++ sequential execution: process #var/#math immediately so
    // later commands in the same chain see updated variables.
    if (partTrimmed.startsWith('#')) {
      if (ASYNC_READ_RE.test(partTrimmed)) {
        state.hitAsyncRead = true;
      } else if (session) {
        serverProcessInlineCommand(partTrimmed, session);
      }
      results.push(partTrimmed);
      return;
    }

    // Substitute $variables BEFORE alias pattern matching
    const substituted = substituteUserVariables(partTrimmed, variables, functions);
    const expanded = processAliases(substituted, aliases, variables, functions);
    if (expanded === substituted) {
      results.push(substituted);
    } else {
      const subParts = parseCommands(expanded);
      subParts.forEach(subPart => {
        results.push(...expandCommandWithAliases(subPart, aliases, depth + 1, variables, functions, session, state));
      });
    }
  });

  return results;
}

/**
 * Detect if a pattern uses TinTin++ syntax
 * Returns true if pattern contains % wildcards, anchors, or { } braces
 */
function isTinTinPattern(pattern) {
  // Check for % followed by wildcard chars or digits
  if (/%[*+?.dDwWsSaAcCpPuU0-9!]/.test(pattern)) return true;
  // Check for ^ anchor at start
  if (pattern.startsWith('^')) return true;
  // Check for $ anchor at end
  if (pattern.endsWith('$')) return true;
  // Check for { } PCRE embedding (not escaped)
  if (/(?<!\\)\{.*(?<!\\)\}/.test(pattern)) return true;
  return false;
}

function processTriggers(line, triggers, loopTracker = null, variables = {}, functions = {}) {
  const result = {
    line: line,
    gag: false,
    highlight: null,
    commands: [],
    sound: null,
    loopDetected: null  // Will contain trigger info if loop detected
  };

  const now = Date.now();
  const LOOP_WINDOW_MS = 2000;  // 2 second window
  const LOOP_THRESHOLD = 50;    // Max fires in window before considered a loop

  // Sort triggers by priority (lower = fires first, default 5)
  // TinTin++ processes actions in priority order, first command match wins
  const sorted = [...triggers].sort((a, b) => (a.priority || 5) - (b.priority || 5));

  // Track whether a command action has already fired (TinTin++: first match only)
  let commandFired = false;

  for (const trigger of sorted) {
    if (!trigger.enabled) continue;

    // Check for trigger loop if we have a tracker
    if (loopTracker && trigger.id) {
      const tracker = loopTracker[trigger.id];
      if (tracker) {
        // Clean old entries outside the window
        if (now - tracker.firstFire > LOOP_WINDOW_MS) {
          tracker.count = 0;
          tracker.firstFire = now;
        }
        // Check if this trigger is looping
        if (tracker.count >= LOOP_THRESHOLD) {
          // Skip this trigger - it's looping
          continue;
        }
      }
    }

    let matched = false;
    let matches = [];
    const pattern = trigger.pattern;

    // Strip ANSI codes for matching (MUD lines contain color codes that break patterns)
    // Keep original line for output (preserves colors)
    const matchLine = stripAnsi(line);

    // Auto-detect pattern type: TinTin++ syntax or simple contains
    const useTinTin = isTinTinPattern(pattern);

    if (useTinTin) {
      // TinTin++ pattern matching (case-sensitive by default)
      try {
        const regexPattern = tinTinToRegex(pattern);
        const regex = new RegExp(regexPattern);
        const match = matchLine.match(regex);
        if (match) {
          matched = true;
          matches = match;
        }
      } catch (e) {
        console.error('TinTin pattern error:', e.message);
      }
    } else {
      // Simple case-sensitive contains match
      matched = matchLine.includes(pattern);
    }

    if (matched && trigger.actions) {
      // Track this fire for loop detection
      if (loopTracker && trigger.id) {
        if (!loopTracker[trigger.id]) {
          loopTracker[trigger.id] = { count: 0, firstFire: now };
        }
        const tracker = loopTracker[trigger.id];
        // Reset if outside window
        if (now - tracker.firstFire > LOOP_WINDOW_MS) {
          tracker.count = 1;
          tracker.firstFire = now;
        } else {
          tracker.count++;
        }
        // Check if we just hit the threshold
        if (tracker.count === LOOP_THRESHOLD) {
          result.loopDetected = {
            id: trigger.id,
            name: trigger.name || trigger.pattern,
            pattern: trigger.pattern
          };
          // Skip executing this trigger's actions
          continue;
        }
      }

      for (const action of trigger.actions) {
        switch (action.type) {
          case 'gag':
            result.gag = true;
            break;
          case 'highlight':
            const fgColor = action.fgColor || action.color || null;
            const bgColor = action.bgColor || null;
            const blink = action.blink || false;
            const underline = action.underline || false;

            if (fgColor || bgColor || blink || underline) {
              let styleStr = '';
              if (fgColor) styleStr += `color:${fgColor};`;
              if (bgColor) styleStr += `background:${bgColor};`;
              if (underline) styleStr += `text-decoration:underline;`;
              if (blink) styleStr += `animation:blink 1s step-end infinite;`;

              let searchPattern;
              if (useTinTin) {
                const regexPattern = tinTinToRegex(pattern);
                searchPattern = new RegExp(`(${regexPattern})`, 'g');
              } else {
                const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                searchPattern = new RegExp(`(${escaped})`, 'g');
              }

              result.line = result.line.replace(searchPattern, `<hl style="${styleStr}">$1</hl>`);
            }
            break;
          case 'command':
            // TinTin++: only the first matching command action fires
            if (commandFired) break;
            let cmd = action.command || '';
            if (matches.length) {
              // Always use TinTin var substitution for captured groups
              cmd = replaceTinTinVars(cmd, matches);
            }
            // Use parseCommands to respect brace depth when splitting
            const cmds = parseCommands(cmd);
            result.commands.push(...cmds);
            commandFired = true;
            break;
          case 'sound':
            result.sound = action.sound || 'beep';
            break;
          case 'substitute':
            // TinTin++ two-pass substitution:
            // Pass 1 (SUB_ARG): replace %1-%99 with captured groups
            // Pass 2 (SUB_VAR): substitute $variables
            let replacement = action.replacement || '';
            if (matches.length) {
              replacement = replaceTinTinVars(replacement, matches);
            }
            replacement = substituteUserVariables(replacement, variables, functions);
            // Find and replace the matched portion (case-sensitive)
            if (useTinTin) {
              const regexPattern = tinTinToRegex(pattern);
              const searchPattern = new RegExp(regexPattern, 'g');
              result.line = result.line.replace(searchPattern, replacement);
            } else {
              // Simple contains - replace all occurrences (case-sensitive)
              const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const searchPattern = new RegExp(escaped, 'g');
              result.line = result.line.replace(searchPattern, replacement);
            }
            break;
          case 'discord':
            // Queue Discord webhook to be sent by caller (needs session for variable substitution)
            if (action.webhookUrl && action.message) {
              let message = action.message;
              if (matches.length) {
                message = replaceTinTinVars(message, matches);
              }
              if (!result.discordWebhooks) result.discordWebhooks = [];
              result.discordWebhooks.push({
                webhookUrl: action.webhookUrl,
                message: message
              });
            }
            break;
          case 'chatmon':
            // Queue ChatMon message to be sent to client (needs session for variable substitution)
            if (action.message) {
              let message = action.message;
              if (matches.length) {
                message = replaceTinTinVars(message, matches);
              }
              if (!result.chatmonMessages) result.chatmonMessages = [];
              result.chatmonMessages.push({
                message: message,
                channel: action.channel || 'trigger'
              });
            }
            break;
        }
      }
    }
  }

  return result;
}

/**
 * Substitute $varname references in a string with user variable values
 * Supports: ${var}, $var[key][subkey], $var
 */
function substituteUserVariables(message, variables, functions) {
  if (!message || !variables) return message;

  // Handle $$ escape → literal $
  const DOLLAR_PLACEHOLDER = '\x00DOLLAR\x00';
  message = message.replace(/\$\$/g, DOLLAR_PLACEHOLDER);

  // Handle @func{args} — resolve function calls (TinTin++ SUB_FUN)
  if (functions && message.includes('@')) {
    let maxIter = 10;
    while (maxIter-- > 0) {
      const funcMatch = message.match(/@(\w+)\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/);
      if (!funcMatch) break;
      const funcName = funcMatch[1].toLowerCase();
      const funcArgs = funcMatch[2];
      const func = functions[funcName];
      if (!func || !func.body) {
        // Unknown function — leave as-is to prevent infinite loop
        break;
      }
      const result = serverCallFunction(func.body, funcArgs, variables);
      message = message.replace(funcMatch[0], result);
    }
  }

  // Handle &variable[] for size (count of keys/elements)
  message = message.replace(/&(\w+)\[\]/g, (match, name) => {
    const val = variables[name];
    if (val === undefined) return '0';
    if (typeof val === 'object' && val !== null) {
      return Object.keys(val).length.toString();
    }
    return '1';
  });

  // Handle *variable[] for listing all keys
  message = message.replace(/\*(\w+)\[\]/g, (match, name) => {
    const val = variables[name];
    if (val === undefined) return '';
    if (typeof val === 'object' && val !== null) {
      return Object.keys(val).join(';');
    }
    return name;
  });

  // Handle ${var} and ${var[key][subkey]} brace-delimited
  message = message.replace(/\$\{(\w+)((?:\[[^\]]*\])*)\}/g, (match, name, brackets) => {
    let val = variables[name];
    if (val === undefined) return '';
    if (brackets) {
      const keys = [];
      const keyRegex = /\[([^\]]*)\]/g;
      let keyMatch;
      while ((keyMatch = keyRegex.exec(brackets)) !== null) {
        keys.push(keyMatch[1]);
      }
      for (const key of keys) {
        if (val === undefined || val === null || typeof val !== 'object') return '';
        val = val[key];
      }
    }
    if (val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  });

  // Handle $var[key][subkey]...
  message = message.replace(/\$(\w+)((?:\[[^\]]*\])+)/g, (match, name, brackets) => {
    let val = variables[name];
    if (val === undefined) return match;
    const keys = [];
    const keyRegex = /\[([^\]]*)\]/g;
    let keyMatch;
    while ((keyMatch = keyRegex.exec(brackets)) !== null) {
      keys.push(keyMatch[1]);
    }
    for (const key of keys) {
      if (val === undefined || val === null || typeof val !== 'object') return '';
      val = val[key];
    }
    if (val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  });

  // Handle simple $var
  message = message.replace(/\$(\w+)(?!\[)/g, (match, name) => {
    return variables[name] !== undefined ? String(variables[name]) : match;
  });

  // Restore $$ escapes → literal $
  message = message.replace(/\x00DOLLAR\x00/g, '$');

  return message;
}

/**
 * Server-side arithmetic evaluator for #math expressions.
 * Handles: + - * / % ** () and numeric literals.
 * TinTin++ #math returns integers (truncated).
 */
function serverEvalMath(expr) {
  const tokens = [];
  let i = 0;
  const s = expr.trim();

  // Tokenize
  while (i < s.length) {
    if (s[i] === ' ' || s[i] === '\t') { i++; continue; }
    if (s[i] === '(' || s[i] === ')') { tokens.push(s[i]); i++; continue; }
    if (s[i] === '*' && s[i + 1] === '*') { tokens.push('**'); i += 2; continue; }
    if ('+-*/%'.includes(s[i])) { tokens.push(s[i]); i++; continue; }
    if (/[0-9.]/.test(s[i])) {
      let num = '';
      while (i < s.length && /[0-9.]/.test(s[i])) { num += s[i]; i++; }
      const val = parseFloat(num);
      if (isNaN(val)) return null;
      tokens.push(val);
      continue;
    }
    // Unknown character — bail out
    return null;
  }

  if (tokens.length === 0) return null;

  let pos = 0;
  function peek() { return pos < tokens.length ? tokens[pos] : null; }
  function consume() { return tokens[pos++]; }

  function parseExpr() {
    let left = parseTerm();
    if (left === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parsePower();
    if (left === null) return null;
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = consume();
      const right = parsePower();
      if (right === null) return null;
      if (op === '*') left *= right;
      else if (op === '/') left = right !== 0 ? Math.trunc(left / right) : 0;
      else left = right !== 0 ? left % right : 0;
    }
    return left;
  }

  function parsePower() {
    let base = parseUnary();
    if (base === null) return null;
    if (peek() === '**') {
      consume();
      const exp = parsePower(); // right-associative
      if (exp === null) return null;
      base = Math.pow(base, exp);
    }
    return base;
  }

  function parseUnary() {
    if (peek() === '-') { consume(); const v = parseAtom(); return v === null ? null : -v; }
    if (peek() === '+') { consume(); return parseAtom(); }
    return parseAtom();
  }

  function parseAtom() {
    if (peek() === '(') {
      consume();
      const val = parseExpr();
      if (peek() === ')') consume();
      return val;
    }
    const tok = consume();
    if (typeof tok === 'number') return tok;
    return null;
  }

  try {
    const result = parseExpr();
    if (result === null || isNaN(result) || !isFinite(result)) return null;
    return Math.trunc(result);
  } catch {
    return null;
  }
}

/**
 * Process #math, #var, and #unvar commands server-side for immediate variable updates.
 * This keeps session.variables in sync during rapid trigger cascades without
 * waiting for the client round-trip.
 * The command is STILL sent to the client afterward — this just ensures the
 * server has the updated value immediately for the next alias/trigger expansion.
 */
/**
 * Parse brace-delimited arguments from a string.
 * e.g. '{result} {%d} {42}' → ['result', '%d', '42']
 * Also handles unbraced single-word arguments.
 */
function parseBracedArgs(str) {
  const args = [];
  let i = 0;
  while (i < str.length) {
    while (i < str.length && str[i] === ' ') i++;
    if (i >= str.length) break;
    if (str[i] === '{') {
      let depth = 1;
      let start = i + 1;
      i++;
      while (i < str.length && depth > 0) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}') depth--;
        i++;
      }
      args.push(str.slice(start, i - 1));
    } else {
      let start = i;
      while (i < str.length && str[i] !== ' ' && str[i] !== '{') i++;
      args.push(str.slice(start, i));
    }
  }
  return args;
}

/**
 * Server-side #format implementation (mirrors client-side cmdFormat).
 * Returns the formatted string result.
 */
function serverFormat(formatStr, args, variables, functions) {
  let argIndex = 0;
  const getArg = () => {
    if (argIndex < args.length) {
      return substituteUserVariables(args[argIndex++], variables, functions);
    }
    return '';
  };

  return formatStr.replace(/%([+\-]?)(\d*)(?:\.(\d+))?(\d+|[sdcfxXaAmMgGulnrphDLTtUH%])/g, (match, padDir, padWidth, maxLen, spec) => {
    if (spec === '%') return '%';

    // Handle positional args like %1, %2
    if (/^\d+$/.test(spec)) {
      const idx = parseInt(spec);
      let val = idx < args.length ? substituteUserVariables(args[idx], variables, functions) : '';
      return applyFormatPadding(val, padDir, padWidth, maxLen);
    }

    let val = getArg();
    let result;

    switch (spec) {
      case 's': result = String(val); break;
      case 'd':
        result = String(Math.trunc(serverEvalMath(String(val))) || 0);
        break;
      case 'f': result = String(parseFloat(val) || 0); break;
      case 'G':
      case 'g':
        result = (parseFloat(val) || 0).toLocaleString('en-US');
        break;
      case 'u': result = String(val).toUpperCase(); break;
      case 'l': result = String(val).toLowerCase(); break;
      case 'n': result = String(val).charAt(0).toUpperCase() + String(val).slice(1); break;
      case 'r': result = String(val).split('').reverse().join(''); break;
      case 'p': result = String(val).trim(); break;
      case 'L': result = String(String(val).replace(/\x1b\[[0-9;]*m/g, '').length); break;
      case 'M': result = serverFormatMetric(parseFloat(val) || 0); break;
      case 'T': result = String(Math.floor(Date.now() / 1000)); break;
      case 'U': result = String(Date.now() * 1000); break;
      case 'H': result = String(serverSimpleHash(String(val))); break;
      case 'D': result = String(parseInt(val, 16) || 0); break;
      case 'x': result = (parseInt(val) || 0).toString(16); break;
      case 'X': result = (parseInt(val) || 0).toString(16).toUpperCase(); break;
      case 'a': result = String.fromCharCode(parseInt(val) || 0); break;
      case 'A': result = String(String(val).charCodeAt(0) || 0); break;
      case 'c': result = String(val); break;
      case 'h': {
        const hdrLen = parseInt(padWidth) || 78;
        const hdrText = String(val);
        if (hdrText) {
          const side = Math.floor((hdrLen - hdrText.length - 2) / 2);
          result = '-'.repeat(Math.max(0, side)) + ' ' + hdrText + ' ' + '-'.repeat(Math.max(0, side));
        } else {
          result = '-'.repeat(hdrLen);
        }
        break;
      }
      case 'm': result = String(serverEvalMath(String(val)) || 0); break;
      case 't': {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        result = String(val)
          .replace(/%Y/g, now.getFullYear())
          .replace(/%y/g, String(now.getFullYear()).slice(-2))
          .replace(/%m/g, pad(now.getMonth() + 1))
          .replace(/%d/g, pad(now.getDate()))
          .replace(/%H/g, pad(now.getHours()))
          .replace(/%M/g, pad(now.getMinutes()))
          .replace(/%S/g, pad(now.getSeconds()))
          .replace(/%%/g, '%');
        break;
      }
      default: result = val;
    }
    return applyFormatPadding(String(result), padDir, padWidth, maxLen);
  });
}

function applyFormatPadding(val, padDir, padWidth, maxLen) {
  let result = val;
  if (maxLen) result = result.substring(0, parseInt(maxLen));
  if (padWidth) {
    const width = parseInt(padWidth);
    result = padDir === '-' ? result.padEnd(width) : result.padStart(width);
  }
  return result;
}

function serverFormatMetric(num) {
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

function serverSimpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function serverProcessInlineCommand(cmd, session) {
  if (!cmd || !session) return false;
  const trimmed = cmd.trim();

  // #math {varname} {expression}  or  #math varname expression
  const mathMatch = trimmed.match(/^#math\s+\{?(\w+)\}?\s+(.*)/i);
  if (mathMatch) {
    const varName = mathMatch[1];
    let expression = mathMatch[2].trim();
    // Strip outer braces if present
    if (expression.startsWith('{') && expression.endsWith('}')) {
      expression = expression.slice(1, -1);
    }
    // Substitute variables, then evaluate
    expression = substituteUserVariables(expression, session.variables || {}, session.functions || {});
    const result = serverEvalMath(expression);
    if (result !== null) {
      if (!session.variables) session.variables = {};
      session.variables[varName] = result;
      // Track server-side modification time to prevent stale client sync overwrite
      if (!session._varServerModified) session._varServerModified = {};
      session._varServerModified[varName] = Date.now();
    }
    return true;
  }

  // #var {varname} {value}  or  #var varname value  or  #variable ...
  const varMatch = trimmed.match(/^#(?:var|variable)\s+\{?(\w+)\}?\s+(.*)/i);
  if (varMatch) {
    const varName = varMatch[1];
    let value = varMatch[2].trim();
    // Strip outer braces if present
    if (value.startsWith('{') && value.endsWith('}')) {
      value = value.slice(1, -1);
    }
    // Substitute variables in value
    value = substituteUserVariables(value, session.variables || {}, session.functions || {});
    if (!session.variables) session.variables = {};
    session.variables[varName] = value;
    // Track server-side modification time to prevent stale client sync overwrite
    if (!session._varServerModified) session._varServerModified = {};
    session._varServerModified[varName] = Date.now();
    return true;
  }

  // #unvar {pattern}  or  #unvar pattern  or  #unvariable ...
  const unvarMatch = trimmed.match(/^#(?:unvar|unvariable)\s+\{?(\w+)\}?\s*$/i);
  if (unvarMatch) {
    const varName = unvarMatch[1];
    if (session.variables) {
      delete session.variables[varName];
    }
    // Track server-side modification time
    if (!session._varServerModified) session._varServerModified = {};
    session._varServerModified[varName] = Date.now();
    return true;
  }

  // #format {variable} {format} [args...]
  const formatMatch = trimmed.match(/^#format\s+(.*)/i);
  if (formatMatch) {
    const fargs = parseBracedArgs(formatMatch[1]);
    if (fargs.length >= 2) {
      const varName = fargs[0];
      const formatStr = fargs[1];
      const formatArgs = fargs.slice(2);
      const result = serverFormat(formatStr, formatArgs, session.variables || {}, session.functions || {});
      if (!session.variables) session.variables = {};
      session.variables[varName] = result;
      if (!session._varServerModified) session._varServerModified = {};
      session._varServerModified[varName] = Date.now();
    }
    return true;
  }

  // #cat {variable} {value1} [value2] ...
  const catMatch = trimmed.match(/^#cat\s+(.*)/i);
  if (catMatch) {
    const cargs = parseBracedArgs(catMatch[1]);
    if (cargs.length >= 2) {
      const varName = cargs[0];
      if (!session.variables) session.variables = {};
      let current = session.variables[varName] || '';
      for (let i = 1; i < cargs.length; i++) {
        const val = substituteUserVariables(cargs[i], session.variables, session.functions || {});
        current = String(current) + val;
      }
      session.variables[varName] = current;
      if (!session._varServerModified) session._varServerModified = {};
      session._varServerModified[varName] = Date.now();
    }
    return true;
  }

  // #replace {variable} {old} {new}
  const replaceMatch = trimmed.match(/^#replace\s+(.*)/i);
  if (replaceMatch) {
    const rargs = parseBracedArgs(replaceMatch[1]);
    if (rargs.length >= 3) {
      const varName = rargs[0];
      if (!session.variables) session.variables = {};
      const currentVal = session.variables[varName];
      if (currentVal !== undefined) {
        const oldText = substituteUserVariables(rargs[1], session.variables, session.functions || {});
        const newText = substituteUserVariables(rargs[2], session.variables, session.functions || {});
        session.variables[varName] = String(currentVal).split(oldText).join(newText);
        if (!session._varServerModified) session._varServerModified = {};
        session._varServerModified[varName] = Date.now();
      }
    }
    return true;
  }

  return false;
}

/**
 * Server-side function execution for @func{args} substitution.
 * Handles simple function bodies (#math, #var, #return, semicolons).
 * Returns the result string (from $result variable or empty).
 */
function serverCallFunction(body, argString, variables) {
  // Create a temporary variable scope
  const tempVars = Object.assign({}, variables);

  // Parse arguments (semicolon-separated, matching TinTin++)
  const funcArgs = argString ? argString.split(';').map(a => a.trim()) : [];

  // Build %N replacement map for the body
  const matches = [argString || ''];  // %0 = full arg string
  funcArgs.forEach(arg => matches.push(arg));  // %1, %2, etc.

  // Substitute %N in body
  let processedBody = replaceTinTinVars(body, matches);

  // Split body by semicolons
  const commands = parseCommands(processedBody);

  // Execute each command in the temp scope
  for (const cmd of commands) {
    const trimmed = cmd.trim();
    if (!trimmed) continue;

    // #return {value}
    const returnMatch = trimmed.match(/^#return\s+(.*)/i);
    if (returnMatch) {
      let val = returnMatch[1].trim();
      if (val.startsWith('{') && val.endsWith('}')) {
        val = val.slice(1, -1);
      }
      val = substituteUserVariables(val, tempVars);
      return val;
    }

    // #math {var} {expr}
    const mathMatch = trimmed.match(/^#math\s+\{?(\w+)\}?\s+(.*)/i);
    if (mathMatch) {
      const varName = mathMatch[1];
      let expression = mathMatch[2].trim();
      if (expression.startsWith('{') && expression.endsWith('}')) {
        expression = expression.slice(1, -1);
      }
      expression = substituteUserVariables(expression, tempVars);
      const result = serverEvalMath(expression);
      if (result !== null) tempVars[varName] = result;
      continue;
    }

    // #var {name} {value}
    const varMatch = trimmed.match(/^#(?:var|variable)\s+\{?(\w+)\}?\s+(.*)/i);
    if (varMatch) {
      let val = varMatch[2].trim();
      if (val.startsWith('{') && val.endsWith('}')) {
        val = val.slice(1, -1);
      }
      val = substituteUserVariables(val, tempVars);
      tempVars[varMatch[1]] = val;
      continue;
    }

    // Other commands not supported server-side — skip
  }

  // If no #return was called, check $result variable
  return tempVars['result'] !== undefined ? String(tempVars['result']) : '';
}

// Graceful shutdown: persist sessions, then close all MUD connections cleanly
async function gracefulShutdown(signal) {
  console.log(`${signal} received, persisting sessions and closing connections...`);

  // Notify browsers and mark sessions for restart
  for (const [token, session] of sessions) {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      try {
        if (BRIDGE_URL) {
          // Bridge mode: seamless restart, just show brief status update
          session.ws.send(JSON.stringify({
            type: 'system',
            subtype: 'status_only',
            message: 'WMT WebSocket updating...'
          }));
        } else {
          session.ws.send(JSON.stringify({
            type: 'system',
            message: 'Server restarting — reconnecting automatically...'
          }));
        }
      } catch (e) {}
    }
    session.serverRestarting = true;
  }

  if (!BRIDGE_URL) await flushLogsToIONOS();
  await persistAllSessions();

  // Flush again to capture PERSIST_SUCCESS/PERSIST_ERROR
  if (!BRIDGE_URL) await flushLogsToIONOS();

  if (BRIDGE_URL) {
    // Bridge mode: DON'T close MUD connections — bridge holds them!
    // Just disconnect from bridge cleanly so it starts buffering.
    console.log('Bridge mode: MUD connections preserved in bridge.js');
    if (bridgeWs) {
      try { bridgeWs.close(); } catch (e) {}
    }
    setTimeout(() => {
      console.log('Shutting down...');
      process.exit(0);
    }, 1000);
  } else {
    // Direct mode: close all MUD connections so the MUD knows they're gone
    // This makes characters go linkdead, allowing restore to reconnect them
    let closedCount = 0;
    for (const [token, session] of sessions) {
      if (session.mudSocket && !session.mudSocket.destroyed) {
        try {
          session.mudSocket.end();  // Send TCP FIN (clean close)
          closedCount++;
        } catch (e) {}
      }
    }
    console.log(`Closed ${closedCount} MUD connections`);

    // Give TCP FINs time to propagate before exiting
    setTimeout(() => {
      console.log('Shutting down...');
      process.exit(0);
    }, 2000);
  }
}

// SIGTERM handler - systemd sends this before killing the process
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Also handle SIGINT (Ctrl+C) for local development
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}${BRIDGE_URL ? ' (bridge mode: ' + BRIDGE_URL + ')' : ' (direct mode)'}`);

  // Connect to bridge if configured
  if (BRIDGE_URL) {
    connectToBridge();
  }

  // Periodically flush session logs to IONOS for persistence
  // Bridge mode (Lightsail) uses journalctl — no need to flush to IONOS
  if (!BRIDGE_URL) {
    setInterval(() => flushLogsToIONOS(), LOG_FLUSH_INTERVAL_MS);
  }

  // Restore persistent sessions after startup
  if (BRIDGE_URL) {
    // Bridge mode: wait for bridge connection, then restore (bridge has the TCP connections)
    setTimeout(async () => {
      await restorePersistentSessions();
    }, 3000);
  } else {
    // Direct mode: wait for old MUD connections to close, then re-login
    setTimeout(async () => {
      await restorePersistentSessions();
    }, 5000);

    // Second restore attempt at 30s for startup race condition
    setTimeout(async () => {
      await restorePersistentSessions();
    }, 30000);
  }
});
