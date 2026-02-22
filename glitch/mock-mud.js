/**
 * Mock MUD Server for WMT Client Testing
 *
 * A simple TCP server that emulates enough of 3Kingdoms to test
 * the WMT client pipeline: ANSI output, MIP data, trigger-worthy
 * text, login sequence, and command responses.
 *
 * Usage:
 *   node mock-mud.js [port]       (default: 4000)
 *
 * Special commands (sent by test client):
 *   __emit <text>       - Server emits raw text to the connection (for trigger testing)
 *   __mip <type> <data> - Server sends MIP-formatted data
 *   __ansi <text>       - Server sends text wrapped in ANSI color codes
 *   __flood <n>         - Server sends n lines rapidly (for buffer/performance testing)
 *   __disconnect        - Server closes the connection (for reconnect testing)
 *   __lag <ms>          - Simulate lag before responding to next command
 *   __help              - List available test commands
 *
 * Regular commands get echoed back with a simple response, so triggers can fire.
 */

const net = require('net');

const PORT = parseInt(process.argv[2]) || 4000;
const ANSI = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    bold: '\x1b[1m',
};

// Simulated room data
const ROOMS = {
    start: {
        name: 'Town Square',
        desc: 'You are standing in the center of a bustling town square. A fountain gurgles nearby.',
        exits: 'north, south, east, west',
        north: 'market',
        south: 'gate',
        east: 'tavern',
        west: 'temple',
    },
    market: {
        name: 'Market Street',
        desc: 'Merchants hawk their wares along the crowded street.',
        exits: 'south, north',
        south: 'start',
        north: 'market',
    },
    gate: {
        name: 'City Gate',
        desc: 'Massive iron gates stand open, guards eyeing travelers.',
        exits: 'north, south',
        north: 'start',
        south: 'wilderness',
    },
    tavern: {
        name: 'The Rusty Dagger Tavern',
        desc: 'A smoky room filled with the sounds of laughter and clinking mugs.',
        exits: 'west',
        west: 'start',
    },
    temple: {
        name: 'Temple of Light',
        desc: 'Soft golden light fills this serene sanctuary.',
        exits: 'east',
        east: 'start',
    },
    wilderness: {
        name: 'Wilderness Path',
        desc: 'A narrow dirt path winds through dense forest. You hear rustling in the undergrowth.',
        exits: 'north',
        north: 'gate',
        monsters: ['a snarling wolf', 'a giant spider', 'a goblin scout'],
    },
};

// MIP protocol helpers
function mipData(type, data) {
    // MIP format: \x03type\x04data\x03\x04
    return `\x03${type}\x04${data}\x03\x04`;
}

function hpBar(hp, maxHp, sp, maxSp, gp, maxGp) {
    return mipData('V', `hp=${hp},maxhp=${maxHp},sp=${sp},maxsp=${maxSp},gp=${gp},maxgp=${maxGp}`);
}

class MockMudSession {
    constructor(socket) {
        this.socket = socket;
        this.loggedIn = false;
        this.name = null;
        this.room = 'start';
        this.hp = 500;
        this.maxHp = 500;
        this.sp = 300;
        this.maxSp = 300;
        this.gp = 200;
        this.maxGp = 200;
        this.lagMs = 0;
        this.inCombat = false;
        this.lineBuffer = '';

        this.sendLogin();

        socket.on('data', (data) => {
            // TCP can deliver partial lines — buffer them
            this.lineBuffer += data.toString();
            let lines = this.lineBuffer.split('\n');
            this.lineBuffer = lines.pop(); // keep incomplete last line
            for (const line of lines) {
                const cmd = line.replace(/\r/g, '').trim();
                if (cmd) this.handleCommand(cmd);
            }
        });
    }

    send(text) {
        if (!this.socket.destroyed) {
            this.socket.write(text);
        }
    }

    sendLine(text) {
        this.send(text + '\r\n');
    }

    sendLogin() {
        this.sendLine('');
        this.sendLine(`${ANSI.bold}${ANSI.cyan}=======================================`);
        this.sendLine(`  Welcome to Mock MUD (WMT Test Server)`);
        this.sendLine(`=======================================${ANSI.reset}`);
        this.sendLine('');
        this.send('Enter your name: ');
    }

    handleCommand(input) {
        // Handle with optional lag
        const process = () => {
            if (!this.loggedIn) {
                this.handleLogin(input);
                return;
            }

            // Check for test commands
            if (input.startsWith('__')) {
                this.handleTestCommand(input);
                return;
            }

            // Check for MIP client identification
            if (input.startsWith('3klient ')) {
                const parts = input.split(' ');
                const idAndClient = parts[1] || '';
                const [mipId, clientName] = idAndClient.split('~~');
                if (clientName && clientName.startsWith('Portal')) {
                    this.send(mipData('E', mipId));
                    this.sendLine(`${ANSI.green}MIP enabled (ID: ${mipId})${ANSI.reset}`);
                }
                return;
            }

            // Handle LINEFEED/HAA silently
            if (input.startsWith('3klient ')) return;

            this.handleGameCommand(input);
        };

        if (this.lagMs > 0) {
            const lag = this.lagMs;
            this.lagMs = 0; // one-shot
            setTimeout(process, lag);
        } else {
            process();
        }
    }

    handleLogin(input) {
        if (!this.name) {
            this.name = input;
            this.send('Password: ');
            return;
        }

        // Accept any password
        this.loggedIn = true;
        this.sendLine('');
        this.sendLine(`${ANSI.green}Welcome back, ${this.name}! You were last seen 2 hours ago.${ANSI.reset}`);
        this.sendLine(`${ANSI.cyan}[${this.name} reconnects]${ANSI.reset}`);
        this.sendLine('');
        this.sendHpBar();
        this.showRoom();
    }

    handleTestCommand(input) {
        const parts = input.split(' ');
        const cmd = parts[0];

        switch (cmd) {
            case '__emit':
                // Send raw text (for trigger testing)
                this.sendLine(parts.slice(1).join(' '));
                break;

            case '__mip':
                // Send MIP data: __mip V hp=500,maxhp=500,...
                this.send(mipData(parts[1] || 'V', parts.slice(2).join(' ')));
                break;

            case '__ansi': {
                // Send text with random ANSI colors
                const colors = [ANSI.red, ANSI.green, ANSI.yellow, ANSI.blue, ANSI.magenta, ANSI.cyan];
                const text = parts.slice(1).join(' ');
                const color = colors[Math.floor(Math.random() * colors.length)];
                this.sendLine(`${color}${text}${ANSI.reset}`);
                break;
            }

            case '__flood': {
                // Send n lines rapidly
                const count = parseInt(parts[1]) || 100;
                for (let i = 0; i < count; i++) {
                    this.sendLine(`Flood line ${i + 1} of ${count}: ${ANSI.yellow}Lorem ipsum dolor sit amet${ANSI.reset}`);
                }
                this.sendLine(`${ANSI.green}--- Flood complete: ${count} lines ---${ANSI.reset}`);
                break;
            }

            case '__disconnect':
                this.sendLine('*** Connection closing ***');
                this.socket.end();
                break;

            case '__lag':
                this.lagMs = parseInt(parts[1]) || 1000;
                this.sendLine(`${ANSI.yellow}[Test] Next command will be delayed ${this.lagMs}ms${ANSI.reset}`);
                break;

            case '__combat': {
                // Start a simulated combat sequence (trigger testing)
                const monster = parts.slice(1).join(' ') || 'a training dummy';
                this.inCombat = true;
                this.sendLine(`${ANSI.red}You attack ${monster}!${ANSI.reset}`);
                this.combatLoop(monster, 3);
                break;
            }

            case '__channel': {
                // Simulate a channel message: __channel <channel> <sender> <message>
                const channel = parts[1] || 'shout';
                const sender = parts[2] || 'TestPlayer';
                const msg = parts.slice(3).join(' ') || 'Hello, world!';
                if (channel === 'tell') {
                    this.sendLine(`${ANSI.magenta}[${sender}]: ${msg}${ANSI.reset}`);
                } else {
                    this.sendLine(`${ANSI.cyan}[${channel}] ${sender}: ${msg}${ANSI.reset}`);
                }
                break;
            }

            case '__help':
                this.sendLine(`${ANSI.bold}Test Commands:${ANSI.reset}`);
                this.sendLine('  __emit <text>            - Send raw text (trigger testing)');
                this.sendLine('  __mip <type> <data>      - Send MIP-formatted data');
                this.sendLine('  __ansi <text>             - Send colored text');
                this.sendLine('  __flood <n>              - Send n lines rapidly');
                this.sendLine('  __disconnect             - Close connection');
                this.sendLine('  __lag <ms>               - Delay next response');
                this.sendLine('  __combat <monster>       - Simulate combat rounds');
                this.sendLine('  __channel <ch> <who> <msg> - Simulate channel message');
                this.sendLine('  __help                   - This help');
                break;

            default:
                this.sendLine(`${ANSI.red}Unknown test command: ${cmd}${ANSI.reset}`);
        }
    }

    combatLoop(monster, rounds) {
        if (rounds <= 0 || !this.inCombat) {
            this.sendLine(`${ANSI.green}${monster} falls to the ground, defeated!${ANSI.reset}`);
            this.sendLine(`You receive 1500 experience.`);
            this.inCombat = false;
            this.sendHpBar();
            return;
        }

        const damage = Math.floor(Math.random() * 50) + 10;
        const monsterDamage = Math.floor(Math.random() * 30) + 5;
        this.hp = Math.max(0, this.hp - monsterDamage);

        this.sendLine(`${ANSI.red}You hit ${monster} for ${damage} damage.${ANSI.reset}`);
        this.sendLine(`${ANSI.yellow}${monster} hits you for ${monsterDamage} damage.${ANSI.reset}`);
        this.sendHpBar();

        setTimeout(() => this.combatLoop(monster, rounds - 1), 1500);
    }

    handleGameCommand(input) {
        const parts = input.split(' ');
        const cmd = parts[0].toLowerCase();

        switch (cmd) {
            case 'look':
            case 'l':
                this.showRoom();
                break;

            case 'north': case 'n':
            case 'south': case 's':
            case 'east': case 'e':
            case 'west': case 'w':
                this.move(cmd.charAt(0) === 'n' ? 'north' : cmd.charAt(0) === 's' ? 'south' : cmd.charAt(0) === 'e' ? 'east' : 'west');
                break;

            case 'kill':
            case 'attack': {
                const target = parts.slice(1).join(' ') || 'nothing';
                const room = ROOMS[this.room];
                if (room.monsters && room.monsters.length > 0) {
                    this.inCombat = true;
                    const monster = room.monsters[0];
                    this.sendLine(`${ANSI.red}You attack ${monster}!${ANSI.reset}`);
                    this.combatLoop(monster, 3);
                } else {
                    this.sendLine(`There is no "${target}" here to attack.`);
                }
                break;
            }

            case 'say':
                this.sendLine(`You say: ${parts.slice(1).join(' ')}`);
                break;

            case 'who':
            case 'wh':
                this.sendLine(`${ANSI.bold}Players Online:${ANSI.reset}`);
                this.sendLine(`  ${ANSI.cyan}${this.name}${ANSI.reset} - Town Square`);
                this.sendLine(`  ${ANSI.cyan}TestBot${ANSI.reset} - Wilderness Path`);
                this.sendLine(`${ANSI.bold}2 players online.${ANSI.reset}`);
                break;

            case 'score':
            case 'sc':
                this.sendLine(`${ANSI.bold}Score for ${this.name}:${ANSI.reset}`);
                this.sendLine(`  HP: ${this.hp}/${this.maxHp}  SP: ${this.sp}/${this.maxSp}  GP: ${this.gp}/${this.maxGp}`);
                this.sendLine(`  Level: 19  Class: Mage  Race: Human`);
                this.sendHpBar();
                break;

            case 'quit':
                this.sendLine('Goodbye!');
                this.socket.end();
                break;

            case 'afk':
                this.sendLine(`${ANSI.yellow}You go AFK: ${parts.slice(1).join(' ') || 'away'}${ANSI.reset}`);
                break;

            default:
                // Echo back unknown commands (useful for testing command passthrough)
                this.sendLine(`What? "${input}"`);
                break;
        }
    }

    move(direction) {
        const room = ROOMS[this.room];
        const dest = room[direction];
        if (!dest || !ROOMS[dest]) {
            this.sendLine(`You cannot go ${direction}.`);
            return;
        }
        this.room = dest;
        this.sendLine(`You move ${direction}.`);
        this.showRoom();
    }

    showRoom() {
        const room = ROOMS[this.room];
        this.sendLine(`${ANSI.bold}${ANSI.green}${room.name}${ANSI.reset}`);
        this.sendLine(room.desc);
        if (room.monsters) {
            for (const m of room.monsters) {
                this.sendLine(`  ${ANSI.red}${m} is here.${ANSI.reset}`);
            }
        }
        this.sendLine(`${ANSI.cyan}Obvious exits: ${room.exits}${ANSI.reset}`);
        this.sendHpBar();
    }

    sendHpBar() {
        this.send(hpBar(this.hp, this.maxHp, this.sp, this.maxSp, this.gp, this.maxGp));
    }
}

const server = net.createServer((socket) => {
    const addr = socket.remoteAddress;
    console.log(`[${new Date().toISOString()}] Connection from ${addr}`);
    const session = new MockMudSession(socket);

    socket.on('close', () => {
        console.log(`[${new Date().toISOString()}] Disconnected: ${session.name || addr}`);
    });

    socket.on('error', (err) => {
        console.log(`[${new Date().toISOString()}] Socket error: ${err.message}`);
    });
});

server.listen(PORT, () => {
    console.log(`Mock MUD server listening on port ${PORT}`);
    console.log(`Connect with: telnet localhost ${PORT}`);
});
