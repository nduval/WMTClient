/**
 * WMT Client - WebSocket to TCP Proxy for Glitch
 * Proxies WebSocket connections to 3k.org MUD
 */

const WebSocket = require('ws');
const net = require('net');
const http = require('http');

const MUD_HOST = '3k.org';
const MUD_PORT = 3000;
const PORT = process.env.PORT || 3000;

// Create HTTP server for health checks
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>WMT WebSocket Proxy</h1><p>WebSocket server running for 3k.org MUD</p>');
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', mud: `${MUD_HOST}:${MUD_PORT}` }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

console.log('WMT WebSocket Proxy starting...');
console.log(`MUD Server: ${MUD_HOST}:${MUD_PORT}`);

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection from:', req.socket.remoteAddress);

  let mudSocket = null;
  let triggers = [];
  let aliases = [];

  // Function to create and connect MUD socket with all handlers
  function connectToMud() {
    // Clean up existing socket if any
    if (mudSocket) {
      mudSocket.destroy();
      mudSocket = null;
    }

    ws.send(JSON.stringify({
      type: 'system',
      message: `Connecting to ${MUD_HOST}:${MUD_PORT}...`
    }));

    mudSocket = new net.Socket();

    mudSocket.connect(MUD_PORT, MUD_HOST, () => {
      console.log('Connected to MUD');
      ws.send(JSON.stringify({
        type: 'system',
        message: `Connected to ${MUD_HOST}:${MUD_PORT}!`
      }));
    });

    mudSocket.on('data', (data) => {
      const text = data.toString();
      const lines = text.split('\n');

      lines.forEach(line => {
        if (line.trim() === '') return;

        // Process triggers
        const processed = processTriggers(line, triggers);

        if (!processed.gag) {
          ws.send(JSON.stringify({
            type: 'mud',
            line: processed.line,
            highlight: processed.highlight,
            sound: processed.sound
          }));
        }

        // Execute trigger commands
        processed.commands.forEach(cmd => {
          if (mudSocket && !mudSocket.destroyed) {
            mudSocket.write(cmd + '\r\n');
          }
        });
      });
    });

    mudSocket.on('close', () => {
      console.log('MUD connection closed');
      ws.send(JSON.stringify({
        type: 'system',
        message: 'Connection to MUD closed.'
      }));
    });

    mudSocket.on('error', (err) => {
      console.error('MUD socket error:', err.message);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'MUD connection error: ' + err.message
      }));
    });
  }

  // Initial connection
  connectToMud();

  // Handle WebSocket messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'command':
          if (mudSocket && !mudSocket.destroyed) {
            const cmd = processAliases(data.command, aliases);
            // Handle multiple commands separated by ;
            const commands = parseCommands(cmd);
            commands.forEach(c => {
              if (c.trim()) {
                mudSocket.write(c.trim() + '\r\n');
              }
            });
          }
          break;

        case 'set_triggers':
          triggers = data.triggers || [];
          break;

        case 'set_aliases':
          aliases = data.aliases || [];
          break;

        case 'keepalive':
          ws.send(JSON.stringify({ type: 'keepalive_ack' }));
          break;

        case 'reconnect':
          console.log('Reconnect requested');
          connectToMud();
          break;
      }
    } catch (e) {
      console.error('Error processing message:', e);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket closed');
    if (mudSocket) {
      mudSocket.destroy();
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    if (mudSocket) {
      mudSocket.destroy();
    }
  });
});

function parseCommands(input) {
  const commands = [];
  let current = '';
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === ';') {
      commands.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) commands.push(current);
  return commands;
}

function processAliases(command, aliases) {
  const parts = command.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1).join(' ');

  for (const alias of aliases) {
    if (!alias.enabled) continue;
    if (cmd.toLowerCase() === alias.pattern.toLowerCase()) {
      let replacement = alias.replacement;
      replacement = replacement.replace(/\$\*/g, args);
      const argParts = args.split(/\s+/);
      for (let i = 0; i < argParts.length; i++) {
        replacement = replacement.replace(new RegExp('\\$' + (i + 1), 'g'), argParts[i]);
      }
      replacement = replacement.replace(/\$\d+/g, '');
      return replacement.trim();
    }
  }
  return command;
}

function processTriggers(line, triggers) {
  const result = {
    line: line,
    gag: false,
    highlight: null,
    commands: [],
    sound: null
  };

  for (const trigger of triggers) {
    if (!trigger.enabled) continue;

    let matched = false;
    let matches = [];

    switch (trigger.matchType) {
      case 'exact':
        matched = line.toLowerCase() === trigger.pattern.toLowerCase();
        break;
      case 'contains':
        matched = line.toLowerCase().includes(trigger.pattern.toLowerCase());
        break;
      case 'startsWith':
        matched = line.toLowerCase().startsWith(trigger.pattern.toLowerCase());
        break;
      case 'endsWith':
        matched = line.toLowerCase().endsWith(trigger.pattern.toLowerCase());
        break;
      case 'regex':
        try {
          const regex = new RegExp(trigger.pattern, 'i');
          const match = line.match(regex);
          if (match) {
            matched = true;
            matches = match;
          }
        } catch (e) {}
        break;
      default:
        matched = line.toLowerCase().includes(trigger.pattern.toLowerCase());
    }

    if (matched && trigger.actions) {
      for (const action of trigger.actions) {
        switch (action.type) {
          case 'gag':
            result.gag = true;
            break;
          case 'highlight':
            result.highlight = action.color || '#ffff00';
            break;
          case 'command':
            let cmd = action.command || '';
            if (matches.length) {
              matches.forEach((m, i) => {
                cmd = cmd.replace(new RegExp('\\$' + i, 'g'), m);
              });
            }
            result.commands.push(cmd);
            break;
          case 'sound':
            result.sound = action.sound || 'beep';
            break;
        }
      }
    }
  }

  return result;
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
