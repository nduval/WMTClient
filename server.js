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
 * Returns clean text buffer
 */
function stripTelnetSequences(buffer) {
  const result = [];
  let i = 0;

  while (i < buffer.length) {
    const byte = buffer[i];

    if (byte === TELNET.IAC) {
      // IAC - start of telnet command
      if (i + 1 >= buffer.length) break;

      const cmd = buffer[i + 1];

      if (cmd === TELNET.IAC) {
        // Escaped IAC (255 255) = literal 255
        result.push(255);
        i += 2;
      } else if (cmd === TELNET.SB) {
        // Subnegotiation - skip until IAC SE
        i += 2;
        while (i < buffer.length) {
          if (buffer[i] === TELNET.IAC && i + 1 < buffer.length && buffer[i + 1] === TELNET.SE) {
            i += 2;
            break;
          }
          i++;
        }
      } else if (cmd >= TELNET.WILL && cmd <= TELNET.DONT) {
        // WILL/WONT/DO/DONT + option byte
        i += 3;
      } else if (cmd >= TELNET.SE && cmd <= TELNET.GA) {
        // Single byte commands (GA, NOP, etc.)
        i += 2;
      } else {
        // Unknown command, skip IAC and command byte
        i += 2;
      }
    } else {
      // Regular character
      result.push(byte);
      i++;
    }
  }

  return Buffer.from(result);
}

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
      // Strip telnet control sequences before converting to text
      const cleanData = stripTelnetSequences(data);
      const text = cleanData.toString('utf8');
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
            const cmd = processAliases(data.command || '', aliases);
            // Handle multiple commands separated by ;
            const commands = parseCommands(cmd);
            commands.forEach(c => {
              // Send command (including empty ones - just sends \r\n for "press enter")
              mudSocket.write(c.trim() + '\r\n');
            });
            // If no commands parsed (empty input), still send a newline
            if (commands.length === 0) {
              mudSocket.write('\r\n');
            }
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

/**
 * Convert TinTin++ pattern to JavaScript regex
 * Full TinTin++ regexp support including:
 * %*, %+, %?, %., %d, %D, %w, %W, %s, %S, %a, %A, %c, %p, %P, %u, %U
 * %1-%99 capture groups, %!prefix for non-capturing, %i/%I for case
 * Range specifiers: %+1..5d (1-5 digits)
 */
function tinTinToRegex(pattern) {
  let result = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '\\' && i + 1 < pattern.length) {
      // Escape sequence
      const next = pattern[i + 1];
      if (next === '%') {
        // Literal percent
        result += '%';
        i += 2;
      } else {
        // Pass through other escapes (for PCRE codes like \d, \w, \s)
        result += '\\' + next;
        i += 2;
      }
    } else if (char === '%') {
      // TinTin++ wildcard
      if (i + 1 < pattern.length) {
        let next = pattern[i + 1];
        let nonCapturing = false;

        // Check for %! (non-capturing prefix)
        if (next === '!' && i + 2 < pattern.length) {
          nonCapturing = true;
          next = pattern[i + 2];
          i += 1; // Skip the !
        }

        const groupStart = nonCapturing ? '(?:' : '(';

        // Check for range specifier: %+1..5d or %+3s etc
        if (next === '+' && i + 2 < pattern.length) {
          const rangeMatch = pattern.slice(i + 2).match(/^(\d+)(?:\.\.(\d+))?([dDwWsSaApPuU])?/);
          if (rangeMatch) {
            const min = rangeMatch[1];
            const max = rangeMatch[2] || min;
            const type = rangeMatch[3] || '.';
            const charClass = getCharClass(type);
            result += `${groupStart}${charClass}{${min},${max}})`;
            i += 2 + rangeMatch[0].length;
            continue;
          }
        }

        if (next === '*') {
          // %* - Zero or more characters (non-greedy, no newlines)
          result += groupStart + '.*?)';
          i += 2;
        } else if (next === '+') {
          // %+ - One or more characters (non-greedy)
          result += groupStart + '.+?)';
          i += 2;
        } else if (next === '?') {
          // %? - Zero or one character
          result += groupStart + '.?)';
          i += 2;
        } else if (next === '.') {
          // %. - Exactly one character
          result += groupStart + '.)';
          i += 2;
        } else if (next === 'd') {
          // %d - Zero or more digits
          result += groupStart + '[0-9]*?)';
          i += 2;
        } else if (next === 'D') {
          // %D - Zero or more non-digits
          result += groupStart + '[^0-9]*?)';
          i += 2;
        } else if (next === 'w') {
          // %w - Zero or more word characters
          result += groupStart + '[A-Za-z0-9_]*?)';
          i += 2;
        } else if (next === 'W') {
          // %W - Zero or more non-word characters
          result += groupStart + '[^A-Za-z0-9_]*?)';
          i += 2;
        } else if (next === 's') {
          // %s - Zero or more whitespace
          result += groupStart + '\\s*?)';
          i += 2;
        } else if (next === 'S') {
          // %S - Zero or more non-whitespace
          result += groupStart + '\\S*?)';
          i += 2;
        } else if (next === 'a') {
          // %a - Zero or more characters including newlines
          result += groupStart + '[\\s\\S]*?)';
          i += 2;
        } else if (next === 'A') {
          // %A - Zero or more newlines
          result += groupStart + '[\\r\\n]*?)';
          i += 2;
        } else if (next === 'c') {
          // %c - Zero or more ANSI color codes (escape sequences)
          result += groupStart + '(?:\\x1b\\[[0-9;]*m)*?)';
          i += 2;
        } else if (next === 'p') {
          // %p - Zero or more printable characters
          result += groupStart + '[\\x20-\\x7E]*?)';
          i += 2;
        } else if (next === 'P') {
          // %P - Zero or more non-printable characters
          result += groupStart + '[^\\x20-\\x7E]*?)';
          i += 2;
        } else if (next === 'u') {
          // %u - Zero or more unicode (any char)
          result += groupStart + '.*?)';
          i += 2;
        } else if (next === 'U') {
          // %U - Zero or more non-unicode (ASCII only)
          result += groupStart + '[\\x00-\\x7F]*?)';
          i += 2;
        } else if (next === 'i' || next === 'I') {
          // %i / %I - Case sensitivity flags (handled at regex level, skip here)
          i += 2;
        } else if (next >= '0' && next <= '9') {
          // %1-%99 - Capture group reference (becomes a capture group)
          let j = i + 1;
          while (j < pattern.length && pattern[j] >= '0' && pattern[j] <= '9') {
            j++;
          }
          result += '(.+?)';
          i = j;
        } else {
          // Unknown % sequence, treat as literal
          result += '%';
          i += 1;
        }
      } else {
        // % at end of string
        result += '%';
        i += 1;
      }
    } else if (char === '^' || char === '$') {
      // Anchors - pass through
      result += char;
      i += 1;
    } else if ('[]{}()|+?*.\\'.includes(char)) {
      // Regex special characters - escape them
      result += '\\' + char;
      i += 1;
    } else {
      // Regular character
      result += char;
      i += 1;
    }
  }

  return result;
}

/**
 * Get character class for range specifiers
 */
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

/**
 * Replace TinTin++ variables (%0, %1, etc.) in a command string with matched values
 */
function replaceTinTinVars(command, matches) {
  let result = command;

  // Replace %0-%99 with matched groups
  // matches[0] = full match, matches[1] = first capture, etc.
  if (matches && matches.length > 0) {
    for (let i = 0; i < matches.length && i < 100; i++) {
      const regex = new RegExp('%' + i + '(?![0-9])', 'g');
      result = result.replace(regex, matches[i] || '');
    }
  }

  // Clean up any remaining unreplaced variables
  result = result.replace(/%\d+/g, '');

  return result;
}

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
        // TinTin++ style pattern matching
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
        // Match command that starts with pattern (word boundary)
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
        // Original behavior: match first word exactly
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
        // For TinTin++: %0 = full match, %1, %2, etc. = capture groups
        replacement = replaceTinTinVars(replacement, matches);
      } else if (matchType === 'regex') {
        // For regex, $0 = full match, $1, $2, etc. = capture groups
        matches.forEach((m, i) => {
          replacement = replacement.replace(new RegExp('\\$' + i, 'g'), m || '');
        });
        // Clean up unused variables
        replacement = replacement.replace(/\$\d+/g, '');
      } else {
        // For exact/startsWith: $* = all args, $1, $2 = individual args
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
      case 'tintin':
        // TinTin++ style pattern matching
        try {
          const regexPattern = tinTinToRegex(trigger.pattern);
          const regex = new RegExp(regexPattern, 'i');
          const match = line.match(regex);
          if (match) {
            matched = true;
            matches = match;
          }
        } catch (e) {
          console.error('TinTin pattern error:', e.message);
        }
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
              if (trigger.matchType === 'tintin') {
                // Use TinTin++ variable replacement (%0, %1, etc.)
                cmd = replaceTinTinVars(cmd, matches);
              } else {
                // Use JavaScript-style replacement ($0, $1, etc.)
                matches.forEach((m, i) => {
                  cmd = cmd.replace(new RegExp('\\$' + i, 'g'), m);
                });
              }
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
