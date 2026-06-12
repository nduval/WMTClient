/**
 * /admin/character endpoint regression test
 *
 * Verifies the IONOS-to-Lightsail character sync path added 2026-05-25
 * to close the long-standing gap where new characters appeared in the
 * WMT UI (IONOS JSON) but never landed in the Lightsail DB.
 *
 * Scenarios:
 *   T1: POST creates a new row with all expected fields
 *   T2: POST again with same id updates the row (INSERT OR REPLACE)
 *   T3: change_log entries are written for both create and update
 *   T4: missing required fields (id, user_id, name) → 400
 *   T5: bad admin key → 403
 *   T6: /admin/character/delete cascades to all related tables
 *   T7: delete with no characterId → 400
 *   T8: delete of non-existent character → 200 with all-zero counts
 *
 * Run:    node test_character_sync.js
 * Setup:  uses /admin/character HTTP endpoint on localhost:3000.
 */
const http = require('http');
const Database = require('/opt/wmt/node_modules/better-sqlite3');

const ADMIN_KEY = process.env.ADMIN_KEY || 'test-admin-key-12345';
const HOST = 'localhost';
const PORT = 3000;
const DB_PATH = '/opt/wmt/wmt.db';

let testsPassed = 0;
let testsFailed = 0;

function httpJson(method, path, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      'X-Admin-Key': opts.adminKey !== undefined ? opts.adminKey : ADMIN_KEY,
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    };
    const req = http.request({ host: HOST, port: PORT, path, method, headers }, res => {
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

  const userId = 'charsync-user-' + Date.now();
  const charId = 'charsync-test-' + Date.now();

  // Sandbox enforces FK constraints (production disables them). Seed the
  // user row first so characters.user_id FK is satisfied.
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, password, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(userId, userId, userId + '@test.local', 'test');

  // Cleanup any prior state for safety
  db.prepare('DELETE FROM characters WHERE id = ?').run(charId);
  db.prepare('DELETE FROM change_log WHERE item_id = ?').run(charId);

  await test('T1: POST creates new character row with all fields', async () => {
    const r = await httpJson('POST', '/admin/character', {
      id: charId,
      user_id: userId,
      name: 'lestat',
      label: 'Lestat the Necromancer',
      server: '3k.org',
      password: 'secret',
      sort_order: 2,
      created_at: '2026-05-25T19:00:00Z'
    });
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert(r.body.success, `success=${r.body.success}`);
    assert(r.body.created === true, `expected created=true, got ${r.body.created}`);

    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(charId);
    assert(row, 'row not found after POST');
    assert(row.user_id === userId, `user_id=${row.user_id}`);
    assert(row.name === 'lestat', `name=${row.name}`);
    assert(row.label === 'Lestat the Necromancer', `label=${row.label}`);
    assert(row.server === '3k.org', `server=${row.server}`);
    assert(row.password === 'secret', `password=${row.password}`);
    assert(row.sort_order === 2, `sort_order=${row.sort_order}`);
    assert(row.created_at === '2026-05-25T19:00:00Z', `created_at=${row.created_at}`);
  });

  await test('T2: POST again with same id updates the row', async () => {
    const r = await httpJson('POST', '/admin/character', {
      id: charId,
      user_id: userId,
      name: 'lestat',
      label: 'Lestat the Vampire',  // changed
      server: '3k.org'
    });
    assert(r.status === 200, `status=${r.status}`);
    assert(r.body.success, 'success');
    assert(r.body.created === false, `expected created=false on update, got ${r.body.created}`);

    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(charId);
    assert(row.label === 'Lestat the Vampire', `label not updated: ${row.label}`);
    // password preserved (not in payload, should keep prior value)
    assert(row.password === 'secret', `password lost on update: ${row.password}`);
    assert(row.sort_order === 2, `sort_order lost on update: ${row.sort_order}`);
  });

  await test('T3: change_log entries recorded for create and update', async () => {
    const logs = db.prepare(
      `SELECT action, source FROM change_log WHERE item_id = ? AND table_name = 'characters' ORDER BY id ASC`
    ).all(charId);
    assert(logs.length >= 2, `expected >=2 log entries, got ${logs.length}`);
    assert(logs[0].action === 'create', `first log action=${logs[0].action}`);
    assert(logs[1].action === 'update', `second log action=${logs[1].action}`);
    assert(logs[0].source === 'admin_api', `source=${logs[0].source}`);
  });

  await test('T4: missing required fields returns 400', async () => {
    let r = await httpJson('POST', '/admin/character', { user_id: userId, name: 'x' });
    assert(r.status === 400, `missing id: status=${r.status}`);

    r = await httpJson('POST', '/admin/character', { id: 'x', name: 'x' });
    assert(r.status === 400, `missing user_id: status=${r.status}`);

    r = await httpJson('POST', '/admin/character', { id: 'x', user_id: 'x' });
    assert(r.status === 400, `missing name: status=${r.status}`);
  });

  await test('T5: bad admin key returns 403', async () => {
    const r = await httpJson('POST', '/admin/character', {
      id: 'should-not-create-' + Date.now(),
      user_id: userId,
      name: 'rejected'
    }, { adminKey: 'bogus-key' });
    assert(r.status === 403, `status=${r.status} body=${JSON.stringify(r.body)}`);
  });

  await test('T6: /admin/character/delete cascades to all related tables', async () => {
    // Seed related rows for the test character
    const aliasId = 'a_' + Date.now();
    const trigId = 't_' + Date.now();
    const classId = 'c_' + Date.now();
    const tickerId = 'tk_' + Date.now();
    db.prepare(
      `INSERT INTO aliases (id, character_id, pattern, replacement, match_type, priority, enabled) VALUES (?,?,?,?,?,?,?)`
    ).run(aliasId, charId, 'aaa', 'bbb', 'exact', 5, 1);
    db.prepare(
      `INSERT INTO triggers (id, character_id, pattern, match_type, actions, priority, enabled) VALUES (?,?,?,?,?,?,?)`
    ).run(trigId, charId, 'xx', 'tintin', '[]', 5, 1);
    db.prepare(
      `INSERT INTO classes (id, character_id, name, enabled) VALUES (?,?,?,?)`
    ).run(classId, charId, 'TestClass', 1);
    db.prepare(
      `INSERT INTO tickers (id, character_id, name, command, interval_seconds, enabled) VALUES (?,?,?,?,?,?)`
    ).run(tickerId, charId, 'tk', 'say hi', 5, 1);
    db.prepare(
      `INSERT OR REPLACE INTO preferences (character_id, data) VALUES (?, ?)`
    ).run(charId, '{}');

    // Confirm seeded
    assert(db.prepare('SELECT COUNT(*) c FROM aliases WHERE character_id=?').get(charId).c === 1, 'pre: aliases not seeded');
    assert(db.prepare('SELECT COUNT(*) c FROM triggers WHERE character_id=?').get(charId).c === 1, 'pre: triggers not seeded');
    assert(db.prepare('SELECT COUNT(*) c FROM classes WHERE character_id=?').get(charId).c === 1, 'pre: classes not seeded');
    assert(db.prepare('SELECT COUNT(*) c FROM tickers WHERE character_id=?').get(charId).c === 1, 'pre: tickers not seeded');
    assert(db.prepare('SELECT COUNT(*) c FROM preferences WHERE character_id=?').get(charId).c === 1, 'pre: preferences not seeded');

    const r = await httpJson('POST', '/admin/character/delete', { characterId: charId });
    assert(r.status === 200, `status=${r.status} body=${JSON.stringify(r.body)}`);
    assert(r.body.success, 'success');
    assert(r.body.deleted.characters === 1, `expected 1 char deleted, got ${r.body.deleted.characters}`);
    assert(r.body.deleted.aliases === 1, `expected 1 alias deleted, got ${r.body.deleted.aliases}`);
    assert(r.body.deleted.triggers === 1, `expected 1 trigger deleted, got ${r.body.deleted.triggers}`);
    assert(r.body.deleted.classes === 1, `expected 1 class deleted, got ${r.body.deleted.classes}`);
    assert(r.body.deleted.tickers === 1, `expected 1 ticker deleted, got ${r.body.deleted.tickers}`);
    assert(r.body.deleted.preferences === 1, `expected 1 pref deleted, got ${r.body.deleted.preferences}`);

    // Confirm DB really cleared
    assert(db.prepare('SELECT COUNT(*) c FROM aliases WHERE character_id=?').get(charId).c === 0, 'post: aliases still present');
    assert(db.prepare('SELECT COUNT(*) c FROM triggers WHERE character_id=?').get(charId).c === 0, 'post: triggers still present');
    assert(db.prepare('SELECT COUNT(*) c FROM classes WHERE character_id=?').get(charId).c === 0, 'post: classes still present');
    assert(db.prepare('SELECT COUNT(*) c FROM tickers WHERE character_id=?').get(charId).c === 0, 'post: tickers still present');
    assert(db.prepare('SELECT COUNT(*) c FROM preferences WHERE character_id=?').get(charId).c === 0, 'post: preferences still present');
    assert(db.prepare('SELECT COUNT(*) c FROM characters WHERE id=?').get(charId).c === 0, 'post: character still present');
  });

  await test('T7: delete with no characterId returns 400', async () => {
    const r = await httpJson('POST', '/admin/character/delete', {});
    assert(r.status === 400, `status=${r.status}`);
  });

  await test('T8: delete of non-existent character returns 200 with zero counts', async () => {
    const r = await httpJson('POST', '/admin/character/delete', { characterId: 'does-not-exist-' + Date.now() });
    assert(r.status === 200, `status=${r.status}`);
    assert(r.body.success, 'success');
    assert(r.body.deleted.characters === 0, `expected 0 deleted, got ${r.body.deleted.characters}`);
  });

  // Cleanup
  db.prepare('DELETE FROM characters WHERE id = ?').run(charId);
  db.prepare('DELETE FROM change_log WHERE item_id = ?').run(charId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  db.close();

  console.log(`\n=== Results: ${testsPassed} passed, ${testsFailed} failed ===`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
