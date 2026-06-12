/**
 * Guild-file transfer round-trip test (2026-06-08).
 * See memory: reference_mip_file_transfer.md.
 *
 * Direct-mode (uses the running sandbox wmt-server on :3000 + mock-mud:4000).
 * Requires the extended mock-mud.js (CDF/CCF/CEF download, 3ksendfile…EOF upload,
 * __setmip) deployed to the sandbox.
 *
 *   T0  download: `info -c -r defense` → client receives a `mud_file` message.
 *   T1  upload contentA (with leading spaces, empty lines, a `;` line, a line
 *       STARTING with `#`, and a `$var`) → re-download → byte-IDENTICAL. Proves
 *       the upload goes RAW (no `;`-split, no `#`-command interception, no `$var`
 *       substitution) and whitespace is preserved both ways.
 *   T2  upload a different contentB → re-download → identical (proves real write).
 *
 * Run: node test_file_transfer.js ws://localhost:3000
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const URL = process.argv[2] || 'ws://localhost:3000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS: ' + n); };
const bad = (n, m) => { fail++; console.log('  FAIL: ' + n + (m ? ' — ' + m : '')); };
async function waitFor(pred, ms = 7000, step = 120) { const s = Date.now(); while (Date.now() - s < ms) { if (pred()) return true; await sleep(step); } return false; }
function connect() { return new Promise((res, rej) => { const ws = new WebSocket(URL); const msgs = []; ws.on('message', r => { try { msgs.push(JSON.parse(r.toString())); } catch (e) {} }); ws.on('open', () => res({ ws, msgs, send: (type, d = {}) => ws.send(JSON.stringify({ type, ...d })) })); ws.on('error', rej); setTimeout(() => rej(new Error('connect timeout')), 5000); }); }
const lastFile = (msgs) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].type === 'mud_file') return msgs[i]; return null; };

const TOKEN = crypto.randomBytes(32).toString('hex');
const USER = 'filexfer-user', CHAR = 'filexfer-char', MIPID = '45765';

async function roundTrip(c, content) {
  const nUp = c.msgs.length;
  c.send('mud_send_file', { filename: 'defense.txt', content });
  await waitFor(() => c.msgs.slice(nUp).some(m => m.type === 'mud_file_uploaded'), 9000);
  const acked = c.msgs.slice(nUp).some(m => m.type === 'mud_file_uploaded');
  const n2 = c.msgs.length;
  c.send('command', { command: 'info -c -r defense' });
  await waitFor(() => lastFile(c.msgs.slice(n2)), 7000);
  return { acked, file: lastFile(c.msgs.slice(n2)) };
}

async function main() {
  console.log('=== FileTransfer ===');
  let c;
  try {
    c = await connect();
    c.send('auth', { token: TOKEN, userId: USER, characterId: CHAR, characterName: 'FileRunner', packetPatch: 0, isWizard: true });
    await sleep(600);
    c.send('set_server', { host: 'localhost', port: 4000 });
    await sleep(400);
    c.send('set_aliases', { aliases: [] }); c.send('set_triggers', { triggers: [] }); c.send('set_variables', { variables: {} }); c.send('set_functions', { functions: {} });
    await sleep(1500);
    c.send('command', { command: 'FileRunner' }); await sleep(500);
    c.send('command', { command: 'password' }); await sleep(1200);
    // Enable MIP on both sides (server matches #K%<id> frames; mock emits them).
    c.send('set_mip', { enabled: true, mipId: MIPID }); await sleep(200);
    c.send('command', { command: `__setmip ${MIPID}` }); await sleep(500);

    // T0: download path works
    const n0 = c.msgs.length;
    c.send('command', { command: 'info -c -r defense' });
    await waitFor(() => lastFile(c.msgs.slice(n0)), 7000);
    const f0 = lastFile(c.msgs.slice(n0));
    if (f0 && f0.filename === 'defense.txt' && typeof f0.content === 'string') ok('T0: download delivered a mud_file (defense.txt)');
    else bad('T0: download', f0 ? 'unexpected shape' : 'no mud_file received — check MIP enable / mock CDF-CCF-CEF');

    // T1: upload tricky content → re-download identical
    const contentA = [
      '',
      ':::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::',
      '  @yellow:THE MAGE GUILD@ : @higreen:Defense@',
      ':::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::',
      '',
      '#a line starting with hash must NOT be eaten as a command',
      ' a ; b ; c  — semicolons must NOT split into separate commands',
      ' price is $gold and $hp must stay literal',
      '   leading + trailing spaces kept   ',
      '',
      ' Updated by elminster on 06/08/2026',
    ].join('\n');
    const r1 = await roundTrip(c, contentA);
    if (r1.acked) ok('T1a: upload acked (mud_file_uploaded)'); else bad('T1a: upload ack', 'no ack');
    if (r1.file && r1.file.content === contentA) ok('T1b: re-download == upload (raw passthrough + whitespace fidelity)');
    else bad('T1b: round-trip identical', r1.file ? `MISMATCH:\n--- got ---\n${r1.file.content}\n--- want ---\n${contentA}` : 'no mud_file on re-download');

    // T2: a different content proves it's really writing, not echoing T1
    const contentB = ['', ' second edit B', ' x;y;z and #b and $z', ''].join('\n');
    const r2 = await roundTrip(c, contentB);
    if (r2.file && r2.file.content === contentB) ok('T2: second distinct round-trip identical');
    else bad('T2: second round-trip', r2.file ? `MISMATCH:\n${r2.file.content}` : 'no mud_file');

  } catch (e) {
    bad('harness', e.message);
  } finally {
    try { if (c) c.ws.close(); } catch (e) {}
    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
    process.exit(fail > 0 ? 1 : 0);
  }
}
main();
