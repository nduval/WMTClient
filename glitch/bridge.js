/**
 * WMT MUD Bridge — Persistent TCP Relay
 *
 * Holds MUD TCP connections while server.js restarts.
 * server.js connects here via WebSocket on localhost:4000.
 *
 * Protocol (server.js → bridge):
 *   { type: 'init', token, host, port }     — Open new MUD TCP connection
 *   { type: 'data', token, data }           — Send data to MUD (base64-encoded)
 *   { type: 'resume', token }               — Re-attach to existing MUD connection
 *   { type: 'destroy', token }              — Close MUD connection
 *   { type: 'rekey', oldToken, newToken }   — Remap connection to new token
 *
 * Protocol (bridge → server.js):
 *   { type: 'connected', token }            — MUD TCP connected
 *   { type: 'data', token, data }           — Data from MUD (base64-encoded)
 *   { type: 'close', token }                — MUD TCP closed
 *   { type: 'error', token, message }       — MUD TCP error
 *   { type: 'end', token }                  — MUD sent FIN (remote close)
 *   { type: 'buffered', token, count }      — Buffered lines count on resume
 */

const net = require('net');
const WebSocket = require('ws');

const PORT = parseInt(process.env.BRIDGE_PORT) || 4000;
const MAX_BUFFER_LINES = 500;
const VERSION = '1.1.0';
// Orphan reaper (G4, see docs/connection-issues/005): close a MUD socket whose
// server.js owner has stayed detached longer than REAP_GRACE_MS — but ONLY while a
// server IS connected. A full server restart/outage must NEVER trip it (the whole
// point of the bridge is to preserve sockets across that), so the reaper no-ops
// when no server is connected. Env-tunable so tests can use a short grace.
const REAP_GRACE_MS = parseInt(process.env.BRIDGE_REAP_MS) || 90000;
const REAP_CHECK_MS = parseInt(process.env.BRIDGE_REAP_CHECK_MS) || 30000;

// Active MUD connections keyed by session token
const mudConnections = new Map();

// When the most recent server.js connected. The reaper waits a full grace after a
// (re)connect before reaping anything, so a server that just reconnected (after a
// restart/outage) has time to resume its sessions before any orphan is closed —
// otherwise the reaper could kill a valid session in the gap before its resume.
let lastServerConnectAt = 0;

const wss = new WebSocket.Server({ port: PORT });

console.log(`[bridge] v${VERSION} listening on port ${PORT}`);

wss.on('connection', (ws) => {
  lastServerConnectAt = Date.now();
  console.log('[bridge] server.js connected');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    const { type, token } = msg;
    if (!token) return;

    switch (type) {
      case 'init': {
        // Close existing connection for this token if any
        const existing = mudConnections.get(token);
        if (existing) {
          existing.serverWs = null;
          if (existing.socket && !existing.socket.destroyed) {
            existing.socket.destroy();
          }
          mudConnections.delete(token);
        }

        const host = msg.host || '3k.org';
        const port = msg.port || 3000;

        const entry = {
          token,
          host,
          port,
          socket: null,
          serverWs: ws,
          buffer: [],       // Buffered raw data while server.js is disconnected
          connected: false,
          detachedAt: null  // set when serverWs goes null; drives the orphan reaper
        };

        const socket = new net.Socket();
        entry.socket = socket;
        mudConnections.set(token, entry);

        socket.connect(port, host, () => {
          console.log(`[bridge] MUD connected: ${host}:${port} (${entry.token.substring(0, 8)})`);
          entry.connected = true;
          sendToServer(entry, { type: 'connected', token: entry.token });
        });

        socket.on('data', (data) => {
          if (entry.serverWs && entry.serverWs.readyState === WebSocket.OPEN) {
            // Relay directly to server.js (use entry.token — may have been rekeyed)
            sendToServer(entry, {
              type: 'data',
              token: entry.token,
              data: data.toString('base64')
            });
          } else {
            // server.js is disconnected — buffer the raw data
            entry.buffer.push(data.toString('base64'));
            // Trim buffer if too large (drop oldest)
            while (entry.buffer.length > MAX_BUFFER_LINES) {
              entry.buffer.shift();
            }
          }
        });

        socket.on('close', () => {
          console.log(`[bridge] MUD closed (${entry.token.substring(0, 8)})`);
          entry.connected = false;
          sendToServer(entry, { type: 'close', token: entry.token });
          mudConnections.delete(entry.token);
        });

        socket.on('error', (err) => {
          console.log(`[bridge] MUD error (${entry.token.substring(0, 8)}): ${err.message}`);
          sendToServer(entry, { type: 'error', token: entry.token, message: err.message });
        });

        socket.on('end', () => {
          console.log(`[bridge] MUD end (${entry.token.substring(0, 8)})`);
          sendToServer(entry, { type: 'end', token: entry.token });
        });

        break;
      }

      case 'data': {
        // Send data from server.js to MUD
        const entry = mudConnections.get(token);
        if (entry && entry.socket && !entry.socket.destroyed) {
          const buf = Buffer.from(msg.data, 'base64');
          entry.socket.write(buf);
        }
        break;
      }

      case 'resume': {
        // server.js reconnecting to an existing MUD connection
        const entry = mudConnections.get(token);
        if (!entry) {
          // No such connection — tell server.js
          safeSend(ws, JSON.stringify({ type: 'error', token, message: 'No active MUD connection for token' }));
          return;
        }

        console.log(`[bridge] Resume (${token.substring(0, 8)}), buffered: ${entry.buffer.length}`);
        entry.serverWs = ws;
        entry.detachedAt = null;   // re-claimed by a server → not an orphan

        // Replay buffered data
        if (entry.buffer.length > 0) {
          safeSend(ws, JSON.stringify({
            type: 'buffered',
            token,
            count: entry.buffer.length
          }));
          for (const chunk of entry.buffer) {
            safeSend(ws, JSON.stringify({
              type: 'data',
              token,
              data: chunk
            }));
          }
          entry.buffer = [];
        }

        // Confirm connection is still alive
        if (entry.connected) {
          safeSend(ws, JSON.stringify({ type: 'connected', token }));
        }
        break;
      }

      case 'rekey': {
        // Remap connection from old token to new token (after session rekey)
        const oldToken = msg.oldToken;
        const newToken = msg.newToken;
        if (oldToken && newToken) {
          const entry = mudConnections.get(oldToken);
          if (entry) {
            mudConnections.delete(oldToken);
            entry.token = newToken;
            mudConnections.set(newToken, entry);
            console.log(`[bridge] Rekeyed (${oldToken.substring(0, 8)} -> ${newToken.substring(0, 8)})`);
          }
        }
        break;
      }

      case 'destroy': {
        // Explicit close of MUD connection
        const entry = mudConnections.get(token);
        if (entry) {
          if (entry.socket && !entry.socket.destroyed) {
            entry.socket.end(); // Clean TCP close
          }
          mudConnections.delete(token);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log('[bridge] server.js disconnected — buffering MUD data');
    // Detach this ws from all entries that pointed to it
    for (const [, entry] of mudConnections) {
      if (entry.serverWs === ws) {
        entry.serverWs = null;
        entry.detachedAt = Date.now();   // start the orphan-reap clock
      }
    }
  });

  ws.on('error', (err) => {
    console.log('[bridge] server.js ws error:', err.message);
  });
});

// Health check HTTP server on same port won't work since wss owns it.
// Instead, add a simple HTTP upgrade rejection for non-WS requests.
wss.on('headers', (headers) => {
  headers.push(`X-Bridge-Version: ${VERSION}`);
  headers.push(`X-Bridge-Sessions: ${mudConnections.size}`);
});

function sendToServer(entry, msg) {
  if (entry.serverWs && entry.serverWs.readyState === WebSocket.OPEN) {
    safeSend(entry.serverWs, JSON.stringify(msg));
  }
}

function safeSend(ws, data) {
  try {
    ws.send(data);
  } catch (e) {
    // Ignore send errors
  }
}

// Graceful shutdown — close all MUD connections
process.on('SIGTERM', () => {
  console.log('[bridge] SIGTERM received — closing all connections');
  for (const [, entry] of mudConnections) {
    if (entry.socket && !entry.socket.destroyed) {
      entry.socket.end();
    }
  }
  wss.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[bridge] SIGINT received');
  process.exit(0);
});

// Status logging
setInterval(() => {
  const active = Array.from(mudConnections.values()).filter(e => e.connected).length;
  const buffering = Array.from(mudConnections.values()).filter(e => !e.serverWs && e.connected).length;
  if (active > 0 || buffering > 0) {
    console.log(`[bridge] Sessions: ${active} active, ${buffering} buffering`);
  }
}, 60000);

// Orphan reaper (G4). Closes a MUD socket that no server has re-claimed within
// REAP_GRACE_MS — the stranded-socket case that kept a character "logged in and
// active" and locked the user out (2026-06-02). CRITICAL GUARD: only runs while a
// server is connected (wss.clients.size > 0). During a server restart/outage every
// entry is briefly detached but NO server is connected, so nothing is reaped — the
// bridge still preserves all sockets across the gap, and the server re-claims them
// (clearing detachedAt) the instant it reconnects.
setInterval(() => {
  if (wss.clients.size === 0) return;            // server down → preserve everything
  const now = Date.now();
  if (now - lastServerConnectAt < REAP_GRACE_MS) return;  // let a just-(re)connected server resume first
  for (const [token, entry] of mudConnections) {
    const detached = !entry.serverWs || entry.serverWs.readyState !== WebSocket.OPEN;
    if (detached && entry.detachedAt && (now - entry.detachedAt) > REAP_GRACE_MS) {
      const ageS = Math.round((now - entry.detachedAt) / 1000);
      console.log(`[bridge] Reaping orphan (${token.substring(0, 8)}): no server re-claimed it for ${ageS}s`);
      try { if (entry.socket && !entry.socket.destroyed) entry.socket.destroy(); } catch (e) {}
      mudConnections.delete(token);
    }
  }
}, REAP_CHECK_MS);
