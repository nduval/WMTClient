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
const VERSION = '1.2.3'; // Added for deploy verification

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
 * GA (Go Ahead) signals end of output - used to flush line buffer for prompts
 */
function stripTelnetSequences(buffer) {
  const result = [];
  let i = 0;
  let hasGA = false;

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
      } else if (cmd === TELNET.GA) {
        // Go Ahead - signal that MUD is waiting for input
        hasGA = true;
        i += 2;
      } else if (cmd >= TELNET.SE && cmd <= TELNET.GA) {
        // Single byte commands (NOP, etc.)
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

  return { buffer: Buffer.from(result), hasGA };
}

// Create HTTP server for health checks
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h1>WMT WebSocket Proxy v${VERSION}</h1><p>WebSocket server running for 3k.org MUD</p>`);
  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: VERSION, mud: `${MUD_HOST}:${MUD_PORT}` }));
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

  // Target MUD server (can be changed by client via set_server message)
  let targetHost = MUD_HOST;
  let targetPort = MUD_PORT;

  // TCP line buffer - accumulate data until we see newlines
  let lineBuffer = '';
  let lineBufferTimeout = null;

  // ANSI color state - track current color to apply to continuation lines
  let currentAnsiState = '';

  // MIP (MUD Interface Protocol) state
  let mipEnabled = false;
  let mipId = null;
  let mipDebug = false;  // Echo raw MIP data to client
  let mipBuffer = '';    // Buffer for incomplete MIP lines (TCP fragmentation)
  let mipStats = {
    hp: { current: 0, max: 0, label: 'HP' },
    sp: { current: 0, max: 0, label: 'SP' },
    gp1: { current: 0, max: 0, label: 'GP1' },
    gp2: { current: 0, max: 0, label: 'GP2' },
    enemy: 0,
    enemyName: '',   // Attacker name from K code
    round: 0,
    room: '',
    exits: '',
    gline1: '',      // Primary guild line (raw HTML with colors)
    gline2: '',      // Secondary guild line (raw HTML with colors)
    gline1Raw: '',   // Raw guild line without color conversion (for debug/parsing)
    gline2Raw: '',   // Raw guild line without color conversion (for debug/parsing)
    uptime: '',      // Server uptime (AAF)
    reboot: '',      // Time until reboot (AAC)
    guildVars: {}    // Parsed guild variables (e.g., nukes_current, nukes_max, reset_pct)
  };

  // Parse guild line to extract variables
  // Patterns: "Name: [X/Y]" -> name_current, name_max
  //           "Name: [X%]" or "Name: X%" -> name_pct
  //           "Name:[X]" -> name
  function parseGuildVars(line1, line2) {
    const vars = {};
    const combined = (line1 || '') + ' ' + (line2 || '');

    // Strip MIP color codes for parsing
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
      // Don't overwrite if already set from bracket pattern
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

  // Parse MIP message and send updates to client
  function parseMipMessage(ws, msgType, msgData) {
    let updated = false;

    // If debug mode, send raw MIP data to client
    if (mipDebug) {
      ws.send(JSON.stringify({
        type: 'mip_debug',
        msgType: msgType,
        msgData: msgData
      }));
    }

    switch (msgType) {
      case 'FFF': // Combined stats data
        parseFFFStats(msgData);
        updated = true;
        break;

      case 'BAD': // Room description/name
        // Strip exits from room name - they come as "(e,w,s,n,omp,jump...)" at the end
        // Handle both closed parens and truncated/unclosed parens
        // Strip exits like "(nw,se)" and room IDs like "~1968" from room name
        mipStats.room = msgData.trim().replace(/\s*\([^)]*\)?(~\d+)?\s*$/, '').trim();
        updated = true;
        break;

      case 'DDD': // Room exits (tilde-separated)
        mipStats.exits = msgData.replace(/~/g, ', ');
        updated = true;
        break;

      case 'BBA': // GP1 label
        mipStats.gp1.label = msgData.trim() || 'GP1';
        updated = true;
        break;

      case 'BBB': // GP2 label
        mipStats.gp2.label = msgData.trim() || 'GP2';
        updated = true;
        break;

      case 'BBC': // HP label
        mipStats.hp.label = msgData.trim() || 'HP';
        updated = true;
        break;

      case 'BBD': // SP label
        mipStats.sp.label = msgData.trim() || 'SP';
        updated = true;
        break;

      case 'BAB': // 2-way comms (tells)
        // Format: ~sender~message (received) or x~recipient~message (sent)
        {
          const parts = msgData.split('~');
          let formatted;
          if (parts[0] === '' && parts.length >= 3) {
            // Received tell: ~Sender~message
            const sender = parts[1];
            const message = parts.slice(2).join('~');
            formatted = `<span style="color:#ff8844">[${sender}]:</span> ${convertMipColors(message)}`;
          } else if (parts[0] === 'x' && parts.length >= 3) {
            // Sent tell: x~Recipient~message
            const recipient = parts[1];
            const message = parts.slice(2).join('~');
            formatted = `<span style="color:#88ff88">[To ${recipient}]:</span> ${convertMipColors(message)}`;
          } else {
            // Unknown format, show as-is
            formatted = convertMipColors(msgData);
          }
          ws.send(JSON.stringify({
            type: 'mip_chat',
            chatType: 'tell',
            raw: msgData,
            message: formatted
          }));
        }
        break;

      case 'CAA': // Chat channel messages
        // Format: channel~group~sender~message (e.g., flapchat~Flappers~Beowulf~Beowulf flaps : meep)
        {
          const parts = msgData.split('~');

          // Skip party divvy messages (spam)
          if (parts[0] === 'ptell' && msgData.includes('Divvy of') && msgData.includes('coins called by')) {
            break;
          }

          let formatted;
          if (parts.length >= 4) {
            // Full format: channel~group~sender~message
            const channel = parts[0];
            // parts[1] is group/guild name, often redundant
            // parts[2] is sender name
            const message = parts.slice(3).join('~');
            formatted = `<span style="color:#44dddd">[${channel}]</span> ${convertMipColors(message)}`;
          } else if (parts.length >= 2) {
            // Simpler format: channel~message
            const channel = parts[0];
            const message = parts.slice(1).join('~');
            formatted = `<span style="color:#44dddd">[${channel}]</span> ${convertMipColors(message)}`;
          } else {
            // Unknown format
            formatted = convertMipColors(msgData);
          }
          ws.send(JSON.stringify({
            type: 'mip_chat',
            chatType: 'channel',
            raw: msgData,
            message: formatted
          }));
        }
        break;

      case 'AAC': // Reboot time (days until reboot, e.g., "4.5 days")
        {
          // Parse decimal days format like "4.5 days" or just "4.5"
          const match = msgData.match(/^([\d.]+)/);
          const decimalDays = match ? parseFloat(match[1]) : 0;
          if (decimalDays > 0) {
            const days = Math.floor(decimalDays);
            const hours = Math.round((decimalDays - days) * 24);
            if (days > 0) {
              mipStats.reboot = `${days}d ${hours}h`;
            } else {
              mipStats.reboot = `${hours}h`;
            }
          } else {
            mipStats.reboot = '';
          }
          updated = true;
        }
        break;

      case 'AAF': // Uptime (days since boot, e.g., "7.7 days")
        {
          // Parse decimal days format like "7.7 days" or just "7.7"
          const match = msgData.match(/^([\d.]+)/);
          const decimalDays = match ? parseFloat(match[1]) : 0;
          if (decimalDays > 0) {
            const days = Math.floor(decimalDays);
            const hours = Math.floor((decimalDays - days) * 24);
            if (days > 0) {
              mipStats.uptime = `${days}d ${hours}h`;
            } else {
              mipStats.uptime = `${hours}h`;
            }
          } else {
            mipStats.uptime = '';
          }
          updated = true;
        }
        break;

      // Other MIP types we recognize but don't display
      case 'BAE': // Mud lag
      case 'HAA': // Room items
      case 'HAB': // Item actions
        // Silently ignore these for now
        break;
    }

    if (updated) {
      ws.send(JSON.stringify({
        type: 'mip_stats',
        stats: mipStats
      }));
    }
  }

  // Parse FFF stats string: A~value~B~value~...
  // Guild lines (I, J) can contain complex strings with embedded ~, so we handle them specially
  function parseFFFStats(data) {
    // Split by ~ but track position for guild lines
    const parts = data.split('~');
    let i = 0;

    while (i < parts.length) {
      const flag = parts[i];

      // Check if this is a single-letter flag
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
            mipStats.gline1Raw = value;  // Store raw for debugging
            mipStats.gline1 = convertMipColors(value);
            break;
          case 'J':
            mipStats.gline2Raw = value;  // Store raw for debugging
            mipStats.gline2 = convertMipColors(value);
            break;
        }
        i += 2; // Skip flag and value
      } else {
        i++; // Skip empty or unknown parts
      }
    }

    // Parse guild lines to extract variables (e.g., nukes_current, reset_pct)
    mipStats.guildVars = parseGuildVars(mipStats.gline1Raw, mipStats.gline2Raw);
  }

  // Convert MIP color codes to HTML spans
  // MIP uses: <r (red), <g (green), <b (blue), <c (cyan), <y (yellow), <v (violet), <w (white), <s (gray), > (reset)
  function convertMipColors(text) {
    if (!text) return '';

    // Color map for MIP codes
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
        // MIP color code: <r, <g, etc.
        result += `<span style="color:${colorMap[text[i + 1]]}">`;
        i += 2;
      } else if (text[i] === '>') {
        // MIP reset code
        result += '</span>';
        i += 1;
      } else {
        result += text[i];
        i += 1;
      }
    }

    return result;
  }

  // Function to create and connect MUD socket with all handlers
  function connectToMud() {
    // Clean up existing socket if any
    if (mudSocket) {
      mudSocket.destroy();
      mudSocket = null;
    }

    ws.send(JSON.stringify({
      type: 'system',
      message: `Connecting to ${targetHost}:${targetPort}...`
    }));

    mudSocket = new net.Socket();

    mudSocket.connect(targetPort, targetHost, () => {
      console.log(`Connected to MUD: ${targetHost}:${targetPort}`);
      ws.send(JSON.stringify({
        type: 'system',
        message: `Connected to ${targetHost}:${targetPort}!`
      }));
    });

    // Function to process a single line (extracted for reuse with buffer flush)
    function processLine(line) {
        if (line.trim() === '') return;

        // FIRST LINE OF DEFENSE: Gag ANY line containing MIP protocol pattern
        // This runs before ALL other processing, no exceptions
        if (/%\d{5}\d{3}[A-Z]{3}/.test(line)) {
          // Try to parse it for stats if possible, then gag
          const mipMatch = line.match(/%(\d{5})(\d{3})([A-Z]{3})/);
          if (mipMatch && mipEnabled) {
            const len = parseInt(mipMatch[2], 10);
            const msgType = mipMatch[3];
            const dataStart = mipMatch.index + mipMatch[0].length;
            const msgData = line.substring(dataStart, dataStart + len);
            parseMipMessage(ws, msgType, msgData);
          }
          return; // Always gag the line
        }

        // Early MIP filter: catch obvious MIP protocol data even before mipId is set
        // This prevents leaks during the race condition window between MIP enable and set_mip
        // Pattern: %<5digits><3digits><3uppercase><data> or #K%<5digits>...
        if (!mipId) {
          // Check if line is ONLY MIP data (gag entirely)
          const pureEarlyMipPattern = /^%?\d{5}\d{3}[A-Z]{3}/;
          if (pureEarlyMipPattern.test(line.trim())) {
            return; // Gag raw MIP data
          }

          // Also strip embedded MIP data from lines
          // Match %<5digits><3digits><3uppercase><variable length data>
          // The length field tells us how many chars of data follow
          const embeddedMipPattern = /%(\d{5})(\d{3})([A-Z]{3})/g;
          let strippedLine = line;
          let match;
          while ((match = embeddedMipPattern.exec(line)) !== null) {
            const mipLength = parseInt(match[2], 10);
            const fullMatch = match[0];
            const dataStart = match.index + fullMatch.length;
            const mipData = line.substring(dataStart, dataStart + mipLength);
            // Remove the entire MIP sequence (pattern + data)
            const toRemove = fullMatch + mipData;
            strippedLine = strippedLine.replace(toRemove, '');
          }
          if (strippedLine !== line) {
            line = strippedLine;
            if (!line.trim()) return; // Nothing left after stripping MIP
          }

          // Also strip #K% format
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

        // Built-in MIP gag: filter out MIP protocol lines when MIP is enabled
        if (mipEnabled && mipId) {
          // Handle TCP fragmentation - if we have buffered data, prepend it
          if (mipBuffer) {
            line = mipBuffer + line;
            mipBuffer = '';
          }

          // Check if line ends with partial MIP marker (fragmented packet)
          // Buffer lines ending with #K% or #K%<partial>
          if (line.endsWith('#K%') || (line.includes('#K%') && line.indexOf('#K%') > line.length - 20)) {
            const mipStart = line.lastIndexOf('#K%');
            // Send the part before the MIP marker
            const beforeMip = line.substring(0, mipStart);
            if (beforeMip.trim()) {
              const processed = processTriggers(beforeMip, triggers);
              if (!processed.gag) {
                ws.send(JSON.stringify({
                  type: 'mud',
                  line: processed.line,
                  highlight: processed.highlight,
                  sound: processed.sound
                }));
              }
            }
            // Buffer the MIP part for next chunk
            mipBuffer = line.substring(mipStart);
            return;
          }

          // MIP lines start with #K% followed by the 5-digit session ID
          // Pattern: #K%<mipId><3-char-length><3-char-type><data>
          // Also handle lines that might have a leading "] " from the MUD
          const mipPattern = new RegExp(`#K%${mipId}(\\d{3})(\\w{3})`);
          const match = line.match(mipPattern);
          if (match) {
            const mipLength = parseInt(match[1], 10);
            const msgType = match[2];
            const mipStart = match.index;
            const dataStart = mipStart + 3 + 5 + 3 + 3; // #K%(3) + mipId(5) + length(3) + type(3) = 14
            const msgData = line.substring(dataStart, dataStart + mipLength);

            // Parse MIP data and send to client
            parseMipMessage(ws, msgType, msgData);

            // Get text before and after the MIP marker (don't trim - preserve flow)
            const beforeMip = line.substring(0, mipStart);
            const afterMip = line.substring(dataStart + mipLength);

            // Combine before and after text
            let displayText = beforeMip + afterMip;
            // Remove leading "] " if present (MUD artifact)
            displayText = displayText.replace(/^\]\s*/, '');

            // Send combined text if any
            if (displayText) {
              const processed = processTriggers(displayText, triggers);
              if (!processed.gag) {
                ws.send(JSON.stringify({
                  type: 'mud',
                  line: processed.line,
                  highlight: processed.highlight,
                  sound: processed.sound
                }));
              }
            }
            // Silently gag MIP protocol portion
            return;
          }

          // Also handle %<mipId> format (without #K prefix) embedded in text
          const altMipPattern = new RegExp(`%${mipId}(\\d{3})([A-Z]{3})`);
          const altMatch = line.match(altMipPattern);
          if (altMatch) {
            const mipLength = parseInt(altMatch[1], 10);
            const msgType = altMatch[2];
            const mipStart = altMatch.index;
            const dataStart = mipStart + 1 + 5 + 3 + 3; // %(1) + mipId(5) + length(3) + type(3) = 12
            const msgData = line.substring(dataStart, dataStart + mipLength);

            // Parse MIP data and send to client
            parseMipMessage(ws, msgType, msgData);

            // Get text before and after the MIP marker
            const beforeMip = line.substring(0, mipStart);
            const afterMip = line.substring(dataStart + mipLength);

            // Combine before and after text (no trim - preserve spacing)
            const displayText = beforeMip + afterMip;

            // Send combined text if any
            if (displayText.trim()) {
              const processed = processTriggers(displayText, triggers);
              if (!processed.gag) {
                ws.send(JSON.stringify({
                  type: 'mud',
                  line: processed.line,
                  highlight: processed.highlight,
                  sound: processed.sound
                }));
              }
            }
            return;
          }

          // Gag lines that are ONLY raw MIP data (no surrounding text)
          // Match both specific mipId and generic pattern (for race conditions)
          const rawMipPattern = new RegExp(`^%?${mipId}\\d{3}[A-Z]{3}`);
          const genericMipPattern = /^%?\d{5}\d{3}[A-Z]{3}/;
          if (rawMipPattern.test(line) || genericMipPattern.test(line)) {
            return;
          }

          // Gag orphaned MIP action data fragments (from HAB item actions)
          // These look like: "or~exa #N/search #N" or "noun~word~word~exa #N/search #N"
          // The pattern is: optional word fragments, ~, words, ending with "#N/command #N"
          if (/~exa\s+#N\/\w+\s+#N\s*$/.test(line)) {
            return;
          }
          // Also catch lines that are just: "word~exa #N/search #N"
          if (/^[a-z]+~[a-z]+\s+#N\/\w+\s+#N\s*$/.test(line)) {
            return;
          }
          // Catch MIP action patterns like "#N/search #N" at end of lines
          if (/\s#N\/\w+\s+#N\s*$/.test(line) && line.includes('~')) {
            return;
          }
          // Catch short orphaned fragments ending in #N (e.g., "earch #N" from split "#N/search #N")
          if (/^[a-z]+\s+#N\s*$/.test(line) && line.length < 20) {
            return;
          }
          // Catch fragments that are just "#N" or start with "#N"
          if (/^#N(\/\w+)?\s*(#N)?\s*$/.test(line)) {
            return;
          }
        }

        // Final safety net: gag any line containing MIP protocol data
        // Pattern: %<5digits><3digits><3uppercase> anywhere in line
        if (/%\d{5}\d{3}[A-Z]{3}/.test(line)) {
          return; // Gag entire line containing MIP data
        }

        // ANSI color state tracking for multi-line colored blocks
        // If line doesn't start with ANSI code but we have a current state, prepend it
        const ansiPattern = /\x1b\[([0-9;]+)m/g;
        const startsWithAnsi = /^\x1b\[/.test(line);

        if (!startsWithAnsi && currentAnsiState) {
          // Prepend current color state to continuation lines
          line = currentAnsiState + line;
        }

        // Extract all ANSI codes from line and track the final state
        let match;
        let lastAnsiCode = '';
        while ((match = ansiPattern.exec(line)) !== null) {
          const codes = match[1];
          // Check if this is a reset code (0 or empty)
          if (codes === '0' || codes === '') {
            currentAnsiState = '';
          } else {
            // Store this as the current state
            lastAnsiCode = match[0];
          }
        }
        // If we found non-reset ANSI codes, update state
        if (lastAnsiCode && !line.includes('\x1b[0m')) {
          // Line has color but no reset - color continues to next line
          currentAnsiState = lastAnsiCode;
        } else if (line.includes('\x1b[0m')) {
          // Line has reset - clear state
          currentAnsiState = '';
        }

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
          if (cmd.startsWith('#')) {
            // Client-side command - send back to client for execution
            ws.send(JSON.stringify({
              type: 'client_command',
              command: cmd
            }));
          } else if (mudSocket && !mudSocket.destroyed) {
            mudSocket.write(cmd + '\r\n');
          }
        });
    }

    mudSocket.on('data', (data) => {
      // Strip telnet control sequences before converting to text
      // Also detect GA (Go Ahead) which signals end of output/prompt
      const { buffer: cleanData, hasGA } = stripTelnetSequences(data);
      const text = cleanData.toString('utf8');

      // Clear any pending buffer flush timeout since we got new data
      if (lineBufferTimeout) {
        clearTimeout(lineBufferTimeout);
        lineBufferTimeout = null;
      }

      // Prepend any buffered data from previous chunk
      const fullText = lineBuffer + text;

      // Split on newlines
      const parts = fullText.split('\n');

      // If GA was received, flush everything immediately (it's a prompt)
      if (hasGA) {
        lineBuffer = '';
        parts.forEach(line => processLine(line));
        return;
      }

      // If the text didn't end with a newline, the last part is incomplete - buffer it
      if (!text.endsWith('\n') && parts.length > 0) {
        lineBuffer = parts.pop();
        // Set a timeout to flush the buffer (fallback for MUDs without GA)
        if (lineBuffer) {
          lineBufferTimeout = setTimeout(() => {
            if (lineBuffer) {
              processLine(lineBuffer);
              lineBuffer = '';
            }
          }, 100); // Flush after 100ms of no new data
        }
      } else {
        lineBuffer = '';
      }

      // Process complete lines
      parts.forEach(line => processLine(line));
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

  // Wait for client to send set_server before connecting
  // This avoids connecting to default server then reconnecting to the right one

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

        case 'set_mip':
          mipEnabled = data.enabled || false;
          mipId = data.mipId || null;
          mipDebug = data.debug || false;
          console.log(`MIP ${mipEnabled ? 'enabled' : 'disabled'}${mipId ? ' (ID: ' + mipId + ')' : ''}${mipDebug ? ' [DEBUG]' : ''}`);
          break;

        case 'set_server':
          // Allow client to specify target MUD server
          // Valid servers: 3k.org:3000 (default), 3scapes.org:3200
          if (data.host && data.port) {
            // Security: only allow known servers
            const allowedServers = [
              { host: '3k.org', port: 3000 },
              { host: '3scapes.org', port: 3200 }
            ];
            const isAllowed = allowedServers.some(s => s.host === data.host && s.port === data.port);
            if (isAllowed) {
              targetHost = data.host;
              targetPort = data.port;
              console.log(`Target server set to ${targetHost}:${targetPort}`);
              // If already connected, reconnect to new server
              if (mudSocket && !mudSocket.destroyed) {
                mudSocket.destroy();
              }
              connectToMud();
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
            // Apply inline highlighting to matched text
            const fgColor = action.fgColor || action.color || null;
            const bgColor = action.bgColor || null;

            if (fgColor || bgColor) {
              let styleStr = '';
              if (fgColor) styleStr += `color:${fgColor};`;
              if (bgColor) styleStr += `background:${bgColor};`;

              // Find what to highlight based on match type
              let searchPattern;
              if (trigger.matchType === 'regex') {
                searchPattern = new RegExp(`(${trigger.pattern})`, 'gi');
              } else if (trigger.matchType === 'tintin') {
                const regexPattern = tinTinToRegex(trigger.pattern);
                searchPattern = new RegExp(`(${regexPattern})`, 'gi');
              } else {
                // Escape special regex chars for literal match
                const escaped = trigger.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                searchPattern = new RegExp(`(${escaped})`, 'gi');
              }

              // Wrap matched text in styled span
              result.line = result.line.replace(searchPattern, `<hl style="${styleStr}">$1</hl>`);
            }
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
            // Split on semicolons to handle multiple commands
            const cmds = cmd.split(';').map(c => c.trim()).filter(c => c);
            result.commands.push(...cmds);
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
