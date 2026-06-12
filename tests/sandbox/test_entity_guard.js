/**
 * entity_guard regression tests
 *
 * Verifies that admin-API edits to triggers/tickers/classes survive a
 * subsequent bulk_replace from a stale source (PHP push or WebSocket).
 * Built 2026-05-03 to lock in the cross-table guard mechanism so the
 * "I fixed it for you, then it got clobbered later" trust issue can't
 * come back.
 *
 * Scenarios per table:
 *   T1: stale-value clobber attempt → guard swaps in current value
 *   T2: caught-up bulk_replace → guard clears cleanly
 *   T3: bulk_replace OMITS the guarded id → guard re-inserts current row
 *       (the new-id-same-shape case from 2026-05-01)
 *
 * Run:    node test_entity_guard.js
 * Setup:  uses /admin/triggers-bulk + /admin/trigger HTTP endpoints
 *         on localhost:3000 (sandbox wmt-server). No WebSocket needed.
 */
const http = require('http');
const Database = require('/opt/wmt/node_modules/better-sqlite3');

const ADMIN_KEY = process.env.ADMIN_KEY || 'test-admin-key-12345';
const HOST = 'localhost';
const PORT = 3000;
const DB_PATH = '/opt/wmt/wmt.db';

let testsPassed = 0;
let testsFailed = 0;

function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: HOST, port: PORT, path, method,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': ADMIN_KEY,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function test(name, fn) {
  try {
    await fn();
    testsPassed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    testsFailed++;
    console.log(`  FAIL: ${name} — ${e.message}`);
  }
}

async function run() {
  const db = new Database(DB_PATH);
  // Allow FK violations during test (simpler than maintaining a fake char row)
  db.pragma('foreign_keys = OFF');

  const charId = 'eguard-test-' + Date.now();

  // Make sure character row exists (some hooks may consult it)
  db.prepare(`INSERT OR IGNORE INTO characters (id, user_id, name, server, sort_order, created_at)
              VALUES (?, ?, ?, ?, ?, datetime('now'))`)
    .run(charId, 'eguard-user', 'EGuardTest', '3k', 0);

  // Cleanup any prior state for safety
  db.prepare('DELETE FROM triggers WHERE character_id = ?').run(charId);
  db.prepare('DELETE FROM tickers  WHERE character_id = ?').run(charId);
  db.prepare('DELETE FROM entity_guard WHERE character_id = ?').run(charId);

  // ─── TRIGGERS ──────────────────────────────────────────────────────

  await test('T1 (triggers): admin patch survives stale bulk_replace', async () => {
    const triggerId = 'tg1_' + Date.now();
    // 1. Seed a trigger via PHP-style bulk push
    let r = await httpJson('POST', '/admin/triggers-bulk', {
      characterId: charId,
      triggers: [{
        id: triggerId, pattern: 'OLD_PATTERN', matchType: 'tintin',
        actions: [{ type: 'gag' }], priority: 5, enabled: true
      }]
    });
    assert(r.body.success, `bulk seed: ${JSON.stringify(r.body)}`);

    // 2. Admin patches it to a new value
    r = await httpJson('POST', '/admin/trigger', {
      characterId: charId, triggerId,
      pattern: 'NEW_PATTERN',
      actions: [{ type: 'highlight', fgColor: '#ff0000' }]
    });
    assert(r.body.success, `admin patch: ${JSON.stringify(r.body)}`);

    // 3. Verify DB has NEW
    let row = db.prepare('SELECT pattern FROM triggers WHERE id=?').get(triggerId);
    assert(row && row.pattern === 'NEW_PATTERN', `after admin: pattern=${row?.pattern}`);

    // 4. Stale bulk_replace pushes back OLD
    r = await httpJson('POST', '/admin/triggers-bulk', {
      characterId: charId,
      triggers: [{
        id: triggerId, pattern: 'OLD_PATTERN', matchType: 'tintin',
        actions: [{ type: 'gag' }], priority: 5, enabled: true
      }]
    });
    assert(r.body.success, `stale push: ${JSON.stringify(r.body)}`);

    // 5. Verify DB STILL has NEW (guard intervened)
    row = db.prepare('SELECT pattern FROM triggers WHERE id=?').get(triggerId);
    assert(row && row.pattern === 'NEW_PATTERN',
      `guard failed to protect — pattern=${row?.pattern} (expected NEW_PATTERN)`);
  });

  await test('T2 (triggers): caught-up bulk_replace clears guard', async () => {
    const triggerId = 'tg2_' + Date.now();
    await httpJson('POST', '/admin/triggers-bulk', {
      characterId: charId,
      triggers: [{ id: triggerId, pattern: 'A', matchType: 'tintin', actions: [{ type: 'gag' }], priority: 5, enabled: true }]
    });
    await httpJson('POST', '/admin/trigger', {
      characterId: charId, triggerId, pattern: 'B', actions: [{ type: 'gag' }]
    });

    // Guard now armed. Push the NEW value (catching up)
    await httpJson('POST', '/admin/triggers-bulk', {
      characterId: charId,
      triggers: [{ id: triggerId, pattern: 'B', matchType: 'tintin', actions: [{ type: 'gag' }], priority: 5, enabled: true }]
    });

    const guardCount = db.prepare(`SELECT COUNT(*) as c FROM entity_guard
      WHERE character_id=? AND table_name='triggers' AND item_id=?`).get(charId, triggerId).c;
    assert(guardCount === 0, `guard should be cleared after catch-up, found ${guardCount} rows`);
  });

  await test('T3 (triggers): bulk_replace OMITTING guarded id re-inserts row', async () => {
    const triggerId = 'tg3_' + Date.now();
    await httpJson('POST', '/admin/triggers-bulk', {
      characterId: charId,
      triggers: [{ id: triggerId, pattern: 'INITIAL', matchType: 'tintin', actions: [{ type: 'gag' }], priority: 5, enabled: true }]
    });
    await httpJson('POST', '/admin/trigger', {
      characterId: charId, triggerId, pattern: 'GUARDED', actions: [{ type: 'gag' }]
    });

    // Stale push omits the trigger entirely
    await httpJson('POST', '/admin/triggers-bulk', {
      characterId: charId, triggers: []
    });

    const row = db.prepare('SELECT pattern FROM triggers WHERE id=?').get(triggerId);
    assert(row && row.pattern === 'GUARDED',
      `guarded row should have been re-inserted, found ${row ? row.pattern : 'none'}`);
  });

  // ─── TICKERS (proves cross-table works through same generic mechanism) ──

  await test('T4 (tickers): admin patch survives stale bulk_replace (cross-table)', async () => {
    const tickerId = 'tk1_' + Date.now();
    await httpJson('POST', '/admin/tickers-bulk', {
      characterId: charId,
      tickers: [{ id: tickerId, name: 'orig', command: 'say old', interval: 60, enabled: true }]
    });
    await httpJson('POST', '/admin/ticker', {
      characterId: charId, tickerId, command: 'say new', interval: 30
    });

    // Stale push reverts
    await httpJson('POST', '/admin/tickers-bulk', {
      characterId: charId,
      tickers: [{ id: tickerId, name: 'orig', command: 'say old', interval: 60, enabled: true }]
    });

    const row = db.prepare('SELECT command, interval_seconds FROM tickers WHERE id=?').get(tickerId);
    assert(row && row.command === 'say new',
      `tickers guard failed: command=${row?.command}, interval=${row?.interval_seconds}`);
  });

  await test('T5 (tickers): bulk_replace OMITTING guarded ticker re-inserts', async () => {
    const tickerId = 'tk2_' + Date.now();
    await httpJson('POST', '/admin/tickers-bulk', {
      characterId: charId,
      tickers: [{ id: tickerId, name: 'orig', command: 'say first', interval: 60, enabled: true }]
    });
    await httpJson('POST', '/admin/ticker', {
      characterId: charId, tickerId, command: 'say guarded'
    });

    // Empty push
    await httpJson('POST', '/admin/tickers-bulk', { characterId: charId, tickers: [] });

    const row = db.prepare('SELECT command FROM tickers WHERE id=?').get(tickerId);
    assert(row && row.command === 'say guarded',
      `tickers re-insertion failed, found ${row ? row.command : 'none'}`);
  });

  // ─── Cleanup ───────────────────────────────────────────────────────
  db.prepare('DELETE FROM triggers WHERE character_id = ?').run(charId);
  db.prepare('DELETE FROM tickers  WHERE character_id = ?').run(charId);
  db.prepare('DELETE FROM entity_guard WHERE character_id = ?').run(charId);
  db.prepare('DELETE FROM characters WHERE id = ?').run(charId);
  db.close();

  console.log(`\n=== Results: ${testsPassed} passed, ${testsFailed} failed ===`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
