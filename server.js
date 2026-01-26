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

const MUD_HOST = '3k.org';
const MUD_PORT = 3000;
const PORT = process.env.PORT || 3000;
const VERSION = '2.6.6'; // Trigger loop detection
const ADMIN_KEY = process.env.ADMIN_KEY || null; // Admin key for broadcast endpoint

// Session persistence configuration
const SESSION_BUFFER_MAX_LINES = 150;  // Max lines to buffer while browser disconnected (keep recent, drop old)
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;  // 15 minutes without browser = close MUD connection

// Persistent sessions store: token -> session object
const sessions = new Map();

// User+character session tracking: "userId:characterId" -> token
// Used to close old sessions when same user+character connects from different device
const userCharacterSessions = new Map();

/**
 * Send message to Discord webhook (fire and forget)
 * Used for server-side notifications when browser is disconnected
 */
function sendToDiscordWebhook(webhookUrl, message, username = 'WMT Client') {
  if (!webhookUrl) return;

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

  const payload = JSON.stringify({
    content: sanitizedMessage,
    username: username
  });

  try {
    const urlObj = new URL(webhookUrl);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 204 && res.statusCode !== 200) {
        console.error('Discord webhook error:', res.statusCode);
      }
    });

    req.on('error', (e) => {
      console.error('Discord webhook error:', e.message);
    });

    req.write(payload);
    req.end();
  } catch (e) {
    console.error('Discord webhook exception:', e.message);
  }
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
        console.log(`Session timeout for token ${token.substring(0, 8)}... (${Math.round(elapsed / 1000)}s without browser)`);
        closeSession(session, 'timeout');
      }
    }
  }
}, 60000);

// Create HTTP server for health checks and admin endpoints
const server = http.createServer((req, res) => {
  // Enable CORS for admin endpoints
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/') {
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
  } else if (req.url === '/discord-webhook' && req.method === 'POST') {
    // Discord webhook proxy - forwards messages to Discord safely
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 10000) {
        req.destroy();
      }
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { webhookUrl, message, username } = data;

        // Validate webhook URL is actually Discord
        if (!webhookUrl ||
            (!webhookUrl.startsWith('https://discord.com/api/webhooks/') &&
             !webhookUrl.startsWith('https://discordapp.com/api/webhooks/'))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid Discord webhook URL' }));
          return;
        }

        if (!message || typeof message !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Message is required' }));
          return;
        }

        // Sanitize message for Discord
        const sanitizedMessage = message
          // Already stripped ANSI on client, but double-check
          .replace(/\x1b\[[0-9;]*m/g, '')
          // Escape @everyone and @here
          .replace(/@(everyone|here)/gi, '@\u200b$1')
          // Escape user/role mentions
          .replace(/<@[!&]?\d+>/g, '[mention]')
          // Truncate to Discord limit
          .substring(0, 1997) + (message.length > 1997 ? '...' : '');

        // Forward to Discord
        const https = require('https');
        const discordPayload = JSON.stringify({
          content: sanitizedMessage,
          username: username || 'WMT Client'
        });

        const urlObj = new URL(webhookUrl);
        const options = {
          hostname: urlObj.hostname,
          port: 443,
          path: urlObj.pathname + urlObj.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(discordPayload)
          }
        };

        const discordReq = https.request(options, (discordRes) => {
          if (discordRes.statusCode === 204 || discordRes.statusCode === 200) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } else {
            let responseBody = '';
            discordRes.on('data', chunk => responseBody += chunk);
            discordRes.on('end', () => {
              console.error('Discord webhook error:', discordRes.statusCode, responseBody);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: `Discord returned ${discordRes.statusCode}` }));
            });
          }
        });

        discordReq.on('error', (e) => {
          console.error('Discord webhook request error:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Failed to reach Discord' }));
        });

        discordReq.write(discordPayload);
        discordReq.end();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

console.log('WMT WebSocket Proxy starting...');
console.log(`MUD Server: ${MUD_HOST}:${MUD_PORT}`);

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
    tickerIntervals: {}    // Map of ticker id -> interval timer
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
      // Expand aliases before sending
      const expanded = expandCommandWithAliases(ticker.command, session.aliases || []);
      expanded.forEach(cmd => {
        // Handle #N repeat pattern
        const repeatMatch = cmd.match(/^#(\d+)\s+(.+)$/);
        if (repeatMatch) {
          const count = Math.min(parseInt(repeatMatch[1]), 100);
          const repeatCmd = repeatMatch[2];
          for (let i = 0; i < count; i++) {
            session.mudSocket.write(repeatCmd + '\r\n');
          }
        } else if (cmd.startsWith('#')) {
          // Client-side command from alias expansion - send back to client
          sendToClient(session, { type: 'client_command', command: cmd });
        } else {
          session.mudSocket.write(cmd + '\r\n');
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
  console.log(`Closing session ${session.token.substring(0, 8)}...: ${reason}`);

  // Clear all tickers
  clearAllTickers(session);

  if (session.mudSocket && !session.mudSocket.destroyed) {
    session.mudSocket.destroy();
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
        let formatted;
        let channel = 'tell';
        let rawText = '';
        if (parts[0] === '' && parts.length >= 3) {
          const sender = parts[1];
          const message = parts.slice(2).join('~');
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
            sendToDiscordWebhook(channelPrefs.webhookUrl, rawText, session.discordUsername);
          }
        }
      }
      break;

    case 'CAA': // Chat channels
      {
        const parts = msgData.split('~');
        if (parts[0] === 'ptell' && msgData.includes('Divvy of') && msgData.includes('coins called by')) {
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
        const processed = processTriggers(beforeMip, session.triggers);
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
        const processed = processTriggers(displayText, session.triggers);
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
        const processed = processTriggers(displayText, session.triggers);
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
  const processed = processTriggers(line, session.triggers, session.loopTracker);

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
      sendToClient(session, {
        type: 'client_command',
        command: cmd
      });
    } else if (session.mudSocket && !session.mudSocket.destroyed) {
      // Expand aliases before sending to MUD
      const expanded = expandCommandWithAliases(cmd, session.aliases || []);
      expanded.forEach(ec => {
        // Check for #N command pattern (e.g., #15 e) - repeat command N times
        const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
        if (repeatMatch) {
          const count = Math.min(parseInt(repeatMatch[1]), 100);
          const repeatCmd = repeatMatch[2];
          for (let i = 0; i < count; i++) {
            session.mudSocket.write(repeatCmd + '\r\n');
          }
        } else if (ec.startsWith('#')) {
          // Client-side command from alias expansion - send back to client
          sendToClient(session, { type: 'client_command', command: ec });
        } else {
          session.mudSocket.write(ec + '\r\n');
        }
      });
    }
  });

  // Send Discord webhooks (with user variable substitution)
  if (processed.discordWebhooks) {
    processed.discordWebhooks.forEach(webhook => {
      sendDiscordWebhook(webhook.webhookUrl, webhook.message, session.variables || {});
    });
  }

  // Send ChatMon messages (with user variable substitution)
  if (processed.chatmonMessages) {
    processed.chatmonMessages.forEach(chat => {
      // Substitute user variables ($varname)
      let finalMessage = chat.message.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, varName) => {
        const vars = session.variables || {};
        return vars[varName] !== undefined ? String(vars[varName]) : match;
      });
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

  sendToClient(session, {
    type: 'system',
    message: `Connecting to ${session.targetHost}:${session.targetPort}...`
  });

  session.mudSocket = new net.Socket();

  session.mudSocket.connect(session.targetPort, session.targetHost, () => {
    console.log(`Connected to MUD: ${session.targetHost}:${session.targetPort}`);
    sendToClient(session, {
      type: 'system',
      message: `Connected to ${session.targetHost}:${session.targetPort}!`
    });
  });

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
    sendToClient(session, {
      type: 'system',
      message: 'Connection to MUD closed.'
    });
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
    sendToClient(session, {
      type: 'error',
      message: 'MUD connection error: ' + err.message
    });
  });

  // Handle remote close (MUD closes connection, e.g., idle timeout)
  session.mudSocket.on('end', () => {
    console.log('MUD connection ended (remote close)');
    sendToClient(session, {
      type: 'system',
      message: 'MUD has closed the connection (idle timeout or linkdead).'
    });
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
          // This handles the case where user logs in from a different device/browser
          if (userId && characterId) {
            const userCharKey = `${userId}:${characterId}`;
            const existingToken = userCharacterSessions.get(userCharKey);

            if (existingToken && existingToken !== token && sessions.has(existingToken)) {
              const oldSession = sessions.get(existingToken);
              console.log(`Closing old session for user ${userId} character ${characterId} (different device)`);

              // Notify old client and close its MUD connection
              if (oldSession.ws && oldSession.ws.readyState === WebSocket.OPEN) {
                try {
                  oldSession.ws.send(JSON.stringify({
                    type: 'session_taken',
                    message: 'Session taken over by another device.'
                  }));
                  oldSession.ws.close();
                } catch (e) {}
              }

              // Close the old MUD connection
              closeSession(oldSession, 'replaced by new device');
            }

            // Register this token for this user+character
            userCharacterSessions.set(userCharKey, token);
          }

          // Check for existing session with same token
          if (sessions.has(token)) {
            session = sessions.get(token);

            // Check if another browser is already connected
            if (session.ws && session.ws.readyState === WebSocket.OPEN) {
              console.log(`Taking over session ${token.substring(0, 8)}... from another browser`);
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
            console.log(`Resumed session ${token.substring(0, 8)}... (MUD ${mudConnected ? 'connected' : 'disconnected'})`);

            ws.send(JSON.stringify({
              type: 'session_resumed',
              mudConnected: mudConnected
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
          } else {
            // Create new session
            session = createSession(token);
            session.ws = ws;
            session.userId = userId;
            session.characterId = characterId;
            session.characterName = characterName;
            session.isWizard = isWizard;
            sessions.set(token, session);

            console.log(`New session ${token.substring(0, 8)}... (user: ${userId}, char: ${characterName || characterId}, wizard: ${isWizard})`);

            ws.send(JSON.stringify({
              type: 'session_new'
            }));
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
          if (session.mudSocket && !session.mudSocket.destroyed) {
            // If raw flag is set, send as-is without semicolon splitting or alias processing
            // (used by #send for ANSI codes containing semicolons)
            if (data.raw) {
              session.mudSocket.write((data.command || '') + '\r\n');
            } else {
              // Recursively expand aliases and handle semicolons
              // expandCommand handles a single command, recursively expanding aliases
              const expandCommand = (cmd, depth = 0) => {
                if (depth > 10) return [cmd];  // Prevent infinite loops
                const trimmed = cmd.trim();
                if (!trimmed) return [];

                const expanded = processAliases(trimmed, session.aliases);
                if (expanded === trimmed) {
                  // No alias matched, return as-is
                  return [trimmed];
                }

                // Alias matched - the result might contain semicolons
                // Split and recursively expand each part
                const parts = parseCommands(expanded);
                const results = [];
                parts.forEach(part => {
                  results.push(...expandCommand(part, depth + 1));
                });
                return results;
              };

              // Split initial command by semicolons, expand each part
              const commands = parseCommands(data.command || '');
              const allExpanded = [];
              commands.forEach(c => {
                allExpanded.push(...expandCommand(c));
              });

              // Send all expanded commands to MUD (or back to client for # commands)
              allExpanded.forEach(ec => {
                // Check for #N command pattern (e.g., #15 e) - repeat command N times
                const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
                if (repeatMatch) {
                  const count = Math.min(parseInt(repeatMatch[1]), 100); // Cap at 100 for safety
                  const repeatCmd = repeatMatch[2];
                  for (let i = 0; i < count; i++) {
                    session.mudSocket.write(repeatCmd + '\r\n');
                  }
                } else if (ec.startsWith('#')) {
                  // Client-side command (like #delay, #showme, etc.) - send back to client
                  sendToClient(session, { type: 'client_command', command: ec });
                } else {
                  session.mudSocket.write(ec + '\r\n');
                }
              });

              if (allExpanded.length === 0) {
                session.mudSocket.write('\r\n');
              }
            }
          }
          break;

        case 'set_triggers':
          session.triggers = data.triggers || [];
          break;

        case 'set_aliases':
          session.aliases = data.aliases || [];
          break;

        case 'set_tickers':
          // Update tickers and restart intervals
          updateSessionTickers(session, data.tickers || []);
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
          console.log(`Discord prefs updated: ${webhookCount} channel(s) with webhooks, ${Object.keys(session.discordChannelPrefs).length} total channels`);
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
              connectToMud(session);
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
            const processed = processTriggers(data.line, session.triggers);

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
                sendToClient(session, {
                  type: 'client_command',
                  command: cmd
                });
              } else if (session.mudSocket && !session.mudSocket.destroyed) {
                // Expand aliases before sending to MUD
                const expanded = expandCommandWithAliases(cmd, session.aliases || []);
                expanded.forEach(ec => {
                  const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
                  if (repeatMatch) {
                    const count = Math.min(parseInt(repeatMatch[1]), 100);
                    const repeatCmd = repeatMatch[2];
                    for (let i = 0; i < count; i++) {
                      session.mudSocket.write(repeatCmd + '\r\n');
                    }
                  } else if (ec.startsWith('#')) {
                    // Client-side command from alias expansion - send back to client
                    sendToClient(session, { type: 'client_command', command: ec });
                  } else {
                    session.mudSocket.write(ec + '\r\n');
                  }
                });
              }
            });

            // Send Discord webhooks (with user variable substitution)
            if (processed.discordWebhooks) {
              processed.discordWebhooks.forEach(webhook => {
                sendDiscordWebhook(webhook.webhookUrl, webhook.message, session.variables || {});
              });
            }

            // Send ChatMon messages (with user variable substitution)
            if (processed.chatmonMessages) {
              processed.chatmonMessages.forEach(chat => {
                let finalMessage = chat.message.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, varName) => {
                  const vars = session.variables || {};
                  return vars[varName] !== undefined ? String(vars[varName]) : match;
                });
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
          console.log('Explicit disconnect requested');
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

      if (session.mudSocket && !session.mudSocket.destroyed) {
        console.log(`Browser disconnected, keeping MUD session for ${session.token.substring(0, 8)}...`);
      }
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

        // All wildcards use GREEDY matching (no ? after quantifier)
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
        } else if (next === 'c') {
          // ANSI color codes - always non-capturing
          result += '(?:\\x1b\\[[0-9;]*m)*';
          i += 2;
        } else if (next === 'p') {
          result += groupStart + '[\\x20-\\x7E]*)';
          i += 2;
        } else if (next === 'P') {
          result += groupStart + '[^\\x20-\\x7E]*)';
          i += 2;
        } else if (next === 'u') {
          result += groupStart + '.*)';
          i += 2;
        } else if (next === 'U') {
          result += groupStart + '[\\x00-\\x7F]*)';
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
          // Use greedy match
          result += '(.*)';
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

  if (matches && matches.length > 0) {
    for (let i = 0; i < matches.length && i < 100; i++) {
      const regex = new RegExp('%' + i + '(?![0-9])', 'g');
      const cleanValue = stripAnsi(matches[i] || '');
      result = result.replace(regex, cleanValue);
    }
  }

  result = result.replace(/%\d+/g, '');
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
      current += char;
      escaped = false;
    } else if (char === '\\') {
      current += char;
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
  if (current.trim()) commands.push(current.trim());
  return commands;
}

function processAliases(command, aliases) {
  for (const alias of aliases) {
    if (!alias.enabled) continue;

    const matchType = alias.matchType || 'exact';
    let matched = false;
    let matches = [];

    switch (matchType) {
      case 'regex':
        try {
          const regex = new RegExp(alias.pattern, 'i');
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
          const regex = new RegExp('^' + regexPattern + '$', 'i');
          const match = command.match(regex);
          if (match) {
            matched = true;
            matches = match;
          }
        } catch (e) {
          console.error('TinTin alias pattern error:', e.message);
        }
        break;

      case 'startsWith':
        const startsPattern = alias.pattern.toLowerCase();
        const cmdLower = command.toLowerCase();
        if (cmdLower === startsPattern || cmdLower.startsWith(startsPattern + ' ')) {
          matched = true;
          const parts = command.split(' ');
          matches = [parts[0], ...parts.slice(1)];
        }
        break;

      case 'exact':
      default:
        const parts = command.split(' ');
        const cmd = parts[0];
        if (cmd.toLowerCase() === alias.pattern.toLowerCase()) {
          matched = true;
          matches = [cmd, ...parts.slice(1)];
        }
        break;
    }

    if (matched) {
      let replacement = alias.replacement;

      if (matchType === 'tintin') {
        replacement = replaceTinTinVars(replacement, matches);
      } else if (matchType === 'regex') {
        matches.forEach((m, i) => {
          replacement = replacement.replace(new RegExp('\\$' + i, 'g'), m || '');
        });
        replacement = replacement.replace(/\$\d+/g, '');
      } else {
        const args = matches.slice(1).join(' ');
        replacement = replacement.replace(/\$\*/g, args);
        const argParts = args.split(/\s+/).filter(p => p);
        for (let i = 0; i < argParts.length; i++) {
          replacement = replacement.replace(new RegExp('\\$' + (i + 1), 'g'), argParts[i]);
        }
        replacement = replacement.replace(/\$\d+/g, '');
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
function expandCommandWithAliases(cmd, aliases, depth = 0) {
  if (depth > 10) return [cmd];  // Prevent infinite loops
  const trimmed = cmd.trim();
  if (!trimmed) return [];

  // First split by semicolons/newlines at the top level
  const initialParts = parseCommands(trimmed);
  const results = [];

  initialParts.forEach(part => {
    const expanded = processAliases(part, aliases);
    if (expanded === part) {
      // No alias matched, return this part as-is
      results.push(part);
    } else {
      // Alias matched - the result might contain more semicolons
      // Split and recursively expand each part
      const subParts = parseCommands(expanded);
      subParts.forEach(subPart => {
        results.push(...expandCommandWithAliases(subPart, aliases, depth + 1));
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

function processTriggers(line, triggers, loopTracker = null) {
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

  for (const trigger of triggers) {
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

    // Auto-detect pattern type: TinTin++ syntax or simple contains
    const useTinTin = isTinTinPattern(pattern);

    if (useTinTin) {
      // TinTin++ pattern matching (case-sensitive by default)
      try {
        const regexPattern = tinTinToRegex(pattern);
        const regex = new RegExp(regexPattern);
        const match = line.match(regex);
        if (match) {
          matched = true;
          matches = match;
        }
      } catch (e) {
        console.error('TinTin pattern error:', e.message);
      }
    } else {
      // Simple case-sensitive contains match
      matched = line.includes(pattern);
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
            let cmd = action.command || '';
            if (matches.length) {
              // Always use TinTin var substitution for captured groups
              cmd = replaceTinTinVars(cmd, matches);
            }
            // Use parseCommands to respect brace depth when splitting
            const cmds = parseCommands(cmd);
            result.commands.push(...cmds);
            break;
          case 'sound':
            result.sound = action.sound || 'beep';
            break;
          case 'substitute':
            // Replace matched text with replacement string
            let replacement = action.replacement || '';
            if (matches.length) {
              replacement = replaceTinTinVars(replacement, matches);
            }
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
 * Send a message to a Discord webhook
 * @param {string} webhookUrl - The Discord webhook URL
 * @param {string} message - The message to send
 * @param {Object} variables - User variables for $var substitution
 */
function sendDiscordWebhook(webhookUrl, message, variables = {}) {
  // Validate webhook URL - only allow Discord webhook URLs
  const discordPattern = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/;
  if (!discordPattern.test(webhookUrl)) {
    console.error('Invalid Discord webhook URL:', webhookUrl);
    return;
  }

  // Substitute user variables ($varname)
  let finalMessage = message.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, varName) => {
    return variables[varName] !== undefined ? String(variables[varName]) : match;
  });

  // Prepare the payload
  const payload = JSON.stringify({ content: finalMessage });

  const url = new URL(webhookUrl);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const req = https.request(options, (res) => {
    if (res.statusCode === 204 || res.statusCode === 200) {
      console.log('Discord webhook sent successfully');
    } else {
      console.error('Discord webhook error:', res.statusCode);
    }
  });

  req.on('error', (e) => {
    console.error('Discord webhook request failed:', e.message);
  });

  req.write(payload);
  req.end();
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
