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

let Database;
try { Database = require('better-sqlite3'); } catch (e) { Database = null; }

const MUD_HOST = '3k.org';
const MUD_PORT = 3000;
const PORT = process.env.PORT || 3000;
const VERSION = '3.0.0'; // Bridge architecture for zero-downtime deploys

// ─── SQLite Database (Phase 2 of resilience roadmap) ──────────
// Write-through persistent store. Memory stays the hot path — the DB
// is a durable mirror updated on every state change. Server restart
// reads from DB instead of relying on the SIGTERM persist chain.
//
// DB_ENABLED_USERS = null means all users. Set to a Set of user IDs
// to gate during rollout. Gate was removed 2026-04-12 after validation.
const DB_PATH = path.join(__dirname, 'wmt.db');
// DB is now active for ALL users. The gated rollout phase (nathan-only)
// completed successfully on 2026-04-12. All users seeded from IONOS JSON.
const DB_ENABLED_USERS = null; // null = all users

let wmtDb = null;
try {
  if (!Database) throw new Error('better-sqlite3 not installed');
  wmtDb = new Database(DB_PATH);
  wmtDb.pragma('journal_mode = WAL');
  wmtDb.pragma('foreign_keys = ON');
  // Stale-write guard for /admin/alias edits. Survives restarts so that a
  // browser reconnecting after a deploy can't clobber an admin fix with its
  // pre-deploy in-memory copy. See markAliasServerModified / applyAliasServerModifiedGuard.
  wmtDb.exec(`
    CREATE TABLE IF NOT EXISTS alias_guard (
      character_id TEXT NOT NULL,
      alias_id TEXT NOT NULL,
      previous TEXT,
      current TEXT,
      ts INTEGER NOT NULL,
      PRIMARY KEY (character_id, alias_id)
    )
  `);
  // Generic per-table stale-write guard. Same purpose as alias_guard but
  // keyed by table_name so triggers, tickers, classes, etc. share one
  // mechanism. previous_row / current_row are full-row JSON blobs; per-table
  // GUARD_EXTRACTORS pull the comparison key from them. current_row=null
  // marks a tombstone (admin deleted; client must observe deletion).
  wmtDb.exec(`
    CREATE TABLE IF NOT EXISTS entity_guard (
      character_id TEXT NOT NULL,
      table_name   TEXT NOT NULL,
      item_id      TEXT NOT NULL,
      previous_row TEXT,
      current_row  TEXT,
      ts           INTEGER NOT NULL,
      PRIMARY KEY (character_id, table_name, item_id)
    )
  `);
  // One-time idempotent migration: copy any live alias_guard rows into
  // entity_guard with table_name='aliases'. INSERT OR IGNORE means running
  // this twice is safe. Aliases continue using the original alias_guard
  // path for now; this populates entity_guard so future unification is a
  // routing change, not a data move.
  try {
    wmtDb.exec(`
      INSERT OR IGNORE INTO entity_guard
        (character_id, table_name, item_id, previous_row, current_row, ts)
      SELECT character_id, 'aliases', alias_id,
             CASE WHEN previous IS NULL THEN NULL ELSE json_object('replacement', previous) END,
             CASE WHEN current  IS NULL THEN NULL ELSE json_object('replacement', current)  END,
             ts
        FROM alias_guard
    `);
  } catch (e) {
    console.error('entity_guard migration from alias_guard failed:', e.message);
  }

  // Block-trigger schema additions: idempotent ADD COLUMN guarded by
  // PRAGMA table_info check (SQLite 3.35 lacks "IF NOT EXISTS" for columns).
  // When both block_start and block_end are non-null, the trigger buffers
  // multiple lines into one block and runs actions on the joined text.
  // Designed for cases like ring-identify where MUD wrap splits the
  // semantically-single output across packets.
  try {
    const triggerCols = new Set(wmtDb.prepare('PRAGMA table_info(triggers)').all().map(c => c.name));
    if (!triggerCols.has('block_start')) {
      wmtDb.exec('ALTER TABLE triggers ADD COLUMN block_start TEXT');
      console.log('triggers: added block_start column');
    }
    if (!triggerCols.has('block_end')) {
      wmtDb.exec('ALTER TABLE triggers ADD COLUMN block_end TEXT');
      console.log('triggers: added block_end column');
    }
  } catch (e) {
    console.error('block_trigger column migration failed:', e.message);
  }
  console.log('SQLite database connected:', DB_PATH);
} catch (e) {
  console.error('SQLite database failed to open:', e.message);
  // Non-fatal — server runs without DB, falls back to JSON persist
}

// ── 3K Map Database (read-only, separate file) ──────────────────────
const MAP_DB_PATH = path.join(__dirname, '3k_map.db');
const MAP_ENABLED_USERS = new Set(['bd035a266e8aa6c77e69d950ba0120c0']); // Nathan only during dev
let mapDb = null;
const mapStmts = {};
try {
  if (Database && require('fs').existsSync(MAP_DB_PATH)) {
    mapDb = new Database(MAP_DB_PATH, { readonly: true });
    mapStmts.getRoomByVnum = mapDb.prepare('SELECT vnum, name, area, terrain, description FROM rooms WHERE vnum = ?');
    mapStmts.getExitsByVnum = mapDb.prepare('SELECT to_vnum, direction, command, weight FROM exits WHERE from_vnum = ?');
    mapStmts.getRoomByName = mapDb.prepare('SELECT vnum, name, area, terrain FROM rooms WHERE name = ? COLLATE NOCASE');
    mapStmts.getRoomByNameArea = mapDb.prepare('SELECT vnum, name, area, terrain FROM rooms WHERE name = ? COLLATE NOCASE AND area = ? COLLATE NOCASE');
    mapStmts.getAreaRooms = mapDb.prepare('SELECT vnum, name, terrain FROM rooms WHERE area = ? COLLATE NOCASE');
    mapStmts.searchRooms = mapDb.prepare('SELECT vnum, name, area FROM rooms WHERE name LIKE ? COLLATE NOCASE LIMIT 20');
    mapStmts.searchLocations = mapDb.prepare('SELECT name, category, vnum, description FROM locations WHERE name LIKE ? COLLATE NOCASE LIMIT 20');
    mapStmts.getLocation = mapDb.prepare('SELECT name, category, vnum, description FROM locations WHERE name = ? COLLATE NOCASE');
    mapStmts.getAllAreas = mapDb.prepare('SELECT name, room_count FROM areas ORDER BY room_count DESC');
    mapStmts.getNeighborRooms = mapDb.prepare(`
      SELECT r.vnum, r.name, r.area, e.direction, e.command
      FROM exits e JOIN rooms r ON r.vnum = e.to_vnum
      WHERE e.from_vnum = ?
    `);
    const roomCount = mapDb.prepare('SELECT count(*) as c FROM rooms').get();
    console.log(`3K map database loaded: ${MAP_DB_PATH} (${roomCount.c} rooms)`);
  }
} catch (e) {
  console.error('Map database failed to load:', e.message);
}

// Prepared statements (created once, reused for performance)
const dbStmts = {};
if (wmtDb) {
  dbStmts.deleteTriggers = wmtDb.prepare('DELETE FROM triggers WHERE character_id = ?');
  dbStmts.insertTrigger = wmtDb.prepare(`
    INSERT INTO triggers (id, character_id, pattern, match_type, actions, priority, enabled, class_id, name, oneshot, block_start, block_end, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  dbStmts.deleteAliases = wmtDb.prepare('DELETE FROM aliases WHERE character_id = ?');
  dbStmts.insertAlias = wmtDb.prepare(`
    INSERT INTO aliases (id, character_id, pattern, replacement, match_type, priority, enabled, class_id, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  dbStmts.deleteClasses = wmtDb.prepare('DELETE FROM classes WHERE character_id = ?');
  dbStmts.insertClass = wmtDb.prepare(`
    INSERT INTO classes (id, character_id, name, enabled, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  dbStmts.upsertPreferences = wmtDb.prepare(`
    INSERT OR REPLACE INTO preferences (character_id, data) VALUES (?, ?)
  `);
  dbStmts.getPreferences = wmtDb.prepare('SELECT data FROM preferences WHERE character_id = ?');
  // Tickers
  dbStmts.deleteTickers = wmtDb.prepare('DELETE FROM tickers WHERE character_id = ?');
  dbStmts.insertTicker = wmtDb.prepare(`
    INSERT INTO tickers (id, character_id, name, command, interval_seconds, class_id, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  dbStmts.getTickers = wmtDb.prepare('SELECT * FROM tickers WHERE character_id = ?');
  // Read statements for DB-based restore
  dbStmts.getTriggers = wmtDb.prepare('SELECT * FROM triggers WHERE character_id = ?');
  dbStmts.getAliases = wmtDb.prepare('SELECT * FROM aliases WHERE character_id = ?');
  dbStmts.getClasses = wmtDb.prepare('SELECT * FROM classes WHERE character_id = ?');
  // ChatMon persistence
  dbStmts.insertChat = wmtDb.prepare(`
    INSERT INTO chat_messages (character_id, channel, sender, message, raw_data, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  dbStmts.getRecentChat = wmtDb.prepare(`
    SELECT raw_data FROM chat_messages
    WHERE character_id = ? ORDER BY id DESC LIMIT ?
  `);
  dbStmts.pruneOldChat = wmtDb.prepare(`
    DELETE FROM chat_messages WHERE created_at < datetime('now', '-30 days')
  `);
  // Scripts
  dbStmts.upsertScript = wmtDb.prepare(`
    INSERT OR REPLACE INTO scripts (character_id, filename, content, size, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);
  dbStmts.deleteScript = wmtDb.prepare('DELETE FROM scripts WHERE character_id = ? AND filename = ?');
  dbStmts.renameScript = wmtDb.prepare('UPDATE scripts SET filename = ? WHERE character_id = ? AND filename = ?');
  dbStmts.getScripts = wmtDb.prepare('SELECT filename, content, size FROM scripts WHERE character_id = ?');
}

/**
 * Load triggers from DB for a character. Returns array in the same
 * format the server uses in session.triggers.
 */
function dbLoadTriggers(characterId) {
  if (!wmtDb) return null;
  try {
    const rows = dbStmts.getTriggers.all(characterId);
    return rows.map(r => ({
      id: r.id,
      pattern: r.pattern,
      matchType: r.match_type,
      actions: JSON.parse(r.actions),
      priority: r.priority,
      enabled: r.enabled === 1,
      class: r.class_id,
      name: r.name,
      oneshot: r.oneshot === 1,
      blockStart: r.block_start || null,
      blockEnd: r.block_end || null
    }));
  } catch (e) {
    console.error('DB trigger load failed:', e.message);
    return null;
  }
}

/**
 * Load aliases from DB for a character.
 */
function dbLoadAliases(characterId) {
  if (!wmtDb) return null;
  try {
    const rows = dbStmts.getAliases.all(characterId);
    return rows.map(r => ({
      id: r.id,
      pattern: r.pattern,
      replacement: r.replacement,
      matchType: r.match_type,
      priority: r.priority,
      enabled: r.enabled === 1,
      class: r.class_id
    }));
  } catch (e) {
    console.error('DB alias load failed:', e.message);
    return null;
  }
}

/**
 * Write a change_log entry. Records old and new state for undo/audit.
 */
/**
 * Convert TinTin++ <NNN> color codes (and 256-color variants) to ANSI escape
 * sequences. Mirrors the client's parseTinTinColors so substitute replacements
 * containing things like `<139>chaos<088>` render with actual color rather than
 * showing the literal angle-bracket codes as text. Limited to the syntax forms
 * that show up in user content; the client has the full implementation for
 * anything fancier.
 */
function parseTinTinColorsServer(str) {
  if (!str) return str;
  const fgColors = { '0': 30, '1': 31, '2': 32, '3': 33, '4': 34, '5': 35, '6': 36, '7': 37, '9': 39 };
  const bgColors = { '0': 40, '1': 41, '2': 42, '3': 43, '4': 44, '5': 45, '6': 46, '7': 47, '9': 49 };
  const attrs    = { '0': 0,  '1': 1,  '2': 2,  '3': 3,  '4': 4,  '5': 5,  '7': 7  };
  return str.replace(/<([a-fA-F0-9gG]{3,8})>/g, (m, code) => {
    if (/^[0-9]{3}$/.test(code)) {
      const a = code[0], f = code[1], b = code[2];
      const parts = [];
      if (a !== '8' && attrs[a] !== undefined) parts.push(attrs[a]);
      if (f !== '8' && fgColors[f] !== undefined) parts.push(fgColors[f]);
      if (b !== '8' && bgColors[b] !== undefined) parts.push(bgColors[b]);
      return parts.length > 0 ? '\x1b[' + parts.join(';') + 'm' : '';
    }
    if (/^[a-f]{3}$/.test(code)) {
      const r = code.charCodeAt(0) - 97, g = code.charCodeAt(1) - 97, b = code.charCodeAt(2) - 97;
      return `\x1b[38;5;${16 + 36 * r + 6 * g + b}m`;
    }
    if (/^[A-F]{3}$/.test(code)) {
      const r = code.charCodeAt(0) - 65, g = code.charCodeAt(1) - 65, b = code.charCodeAt(2) - 65;
      return `\x1b[48;5;${16 + 36 * r + 6 * g + b}m`;
    }
    return m;
  });
}

/**
 * Iteratively decode HTML entities until the string stabilizes. Used to
 * undo accumulated `&amp;amp;...&amp;#039;` corruption from stale browser
 * data hitting bulk_replace. Idempotent — strings without entities pass
 * through unchanged.
 */
function decodeHtmlEntitiesIterative(s) {
  let prev, cur = s;
  for (let i = 0; i < 5000; i++) {
    prev = cur;
    cur = cur
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");
    if (cur === prev) return cur;
    if (cur.length > prev.length) return prev; // safety
  }
  return cur;
}

function dbLogChange(characterId, tableName, action, oldData, newData, source) {
  if (!wmtDb) return;
  try {
    wmtDb.prepare(`
      INSERT INTO change_log (character_id, table_name, action, old_data, new_data, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(characterId, tableName, action, oldData, newData, source || 'server_sync');
  } catch (e) {
    // Non-fatal — don't let change_log errors block saves
  }
}

/**
 * Write triggers to DB for a character. Atomic bulk replace inside a
 * transaction — either all triggers are written or none are.
 * Also logs the change for undo/audit.
 */
function dbSaveTriggers(characterId, triggers) {
  if (!wmtDb || !triggers) return;
  try {
    wmtDb.transaction(() => {
      // Capture old state for change_log before replacing
      const oldRows = dbStmts.getTriggers.all(characterId);
      const oldData = oldRows.length > 0 ? JSON.stringify(oldRows) : null;

      dbStmts.deleteTriggers.run(characterId);
      for (const t of triggers) {
        dbStmts.insertTrigger.run(
          t.id || null,
          characterId,
          t.pattern || '',
          t.matchType || 'tintin',
          JSON.stringify(t.actions || []),
          t.priority ?? 5,
          t.enabled !== false ? 1 : 0,
          t.class || null,
          t.name || null,
          t.oneshot ? 1 : 0,
          t.blockStart || null,
          t.blockEnd || null
        );
      }

      // Log the change (skip if no meaningful difference)
      if (oldRows.length !== triggers.length || oldData) {
        dbLogChange(characterId, 'triggers', 'bulk_replace', oldData, JSON.stringify(triggers), 'client_sync');
      }
    })();
  } catch (e) {
    console.error('DB trigger save failed:', e.message);
  }
}

/**
 * Write aliases to DB for a character. Same atomic bulk replace + change log.
 */
function dbSaveAliases(characterId, aliases) {
  if (!wmtDb || !aliases) return;
  try {
    wmtDb.transaction(() => {
      const oldRows = dbStmts.getAliases.all(characterId);
      const oldData = oldRows.length > 0 ? JSON.stringify(oldRows) : null;

      dbStmts.deleteAliases.run(characterId);
      for (const a of aliases) {
        dbStmts.insertAlias.run(
          a.id || null,
          characterId,
          a.pattern || '',
          a.replacement || '',
          a.matchType || 'exact',
          a.priority ?? 5,
          a.enabled !== false ? 1 : 0,
          a.class || null
        );
      }

      if (oldRows.length !== aliases.length || oldData) {
        dbLogChange(characterId, 'aliases', 'bulk_replace', oldData, JSON.stringify(aliases), 'client_sync');
      }
    })();
  } catch (e) {
    console.error('DB alias save failed:', e.message);
  }
}

function dbSaveTickers(characterId, tickers) {
  if (!wmtDb || !tickers) return;
  try {
    wmtDb.transaction(() => {
      const oldRows = dbStmts.getTickers.all(characterId);
      const oldData = oldRows.length > 0 ? JSON.stringify(oldRows) : null;
      dbStmts.deleteTickers.run(characterId);
      for (const t of tickers) {
        dbStmts.insertTicker.run(
          t.id || null,
          characterId,
          t.name || '',
          t.command || '',
          t.interval || 0,
          t.class || null,
          t.enabled !== false ? 1 : 0
        );
      }
      if (oldRows.length !== tickers.length || oldData) {
        dbLogChange(characterId, 'tickers', 'bulk_replace', oldData, JSON.stringify(tickers), 'client_sync');
      }
    })();
  } catch (e) {
    console.error('DB ticker save failed:', e.message);
  }
}

function dbSavePreferences(characterId, prefs) {
  if (!wmtDb || !prefs) return;
  try {
    wmtDb.transaction(() => {
      const oldRow = dbStmts.getPreferences.get(characterId);
      const oldData = oldRow ? oldRow.data : null;
      dbStmts.upsertPreferences.run(characterId, JSON.stringify(prefs));
      const newData = JSON.stringify(prefs);
      if (oldData !== newData) {
        dbLogChange(characterId, 'preferences', 'upsert', oldData, newData, 'client_sync');
      }
    })();
  } catch (e) {
    console.error('DB preferences save failed:', e.message);
  }
}

function dbLoadTickers(characterId) {
  if (!wmtDb) return null;
  try {
    const rows = dbStmts.getTickers.all(characterId);
    if (rows.length === 0) return null;
    return rows.map(r => ({
      id: r.id,
      name: r.name || '',
      command: r.command || '',
      interval: r.interval_seconds || 0,
      class: r.class_id || null,
      enabled: r.enabled === 1
    }));
  } catch (e) {
    console.error('DB ticker load failed:', e.message);
    return null;
  }
}

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

// Stale-write protection for aliases modified by the admin endpoint.
//
// Backed by the `alias_guard` DB table AND a hot in-memory mirror. DB
// persistence matters because every wmt-server restart lets a stale browser
// send a bulk_replace before the user can refresh — without persistence,
// all admin fixes evaporate at the next deploy. Burned by this 2026-04-27.
//
// Format: Map<characterId, Map<aliasId, { previous, current, ts }>>.
//
// Semantics on bulk_replace (per row):
//   incoming.replacement === rec.current   → client is in sync; CLEAR entry
//   incoming.replacement === rec.previous  → client is stale; OVERRIDE to current
//   anything else                          → deliberate edit; CLEAR entry
//
// Observation-based clearing (no time window) means the guard survives
// arbitrary delays between admin edit and the user's next refresh, which
// time-based expiry cannot.
const serverModifiedAliases = new Map();

if (wmtDb) {
  try {
    const rows = wmtDb.prepare('SELECT character_id, alias_id, previous, current, ts FROM alias_guard').all();
    for (const r of rows) {
      let perChar = serverModifiedAliases.get(r.character_id);
      if (!perChar) { perChar = new Map(); serverModifiedAliases.set(r.character_id, perChar); }
      perChar.set(r.alias_id, { previous: r.previous || '', current: r.current || '', ts: r.ts });
    }
    if (rows.length > 0) console.log(`alias_guard: loaded ${rows.length} live entries from DB`);
  } catch (e) {
    console.error('alias_guard load failed:', e.message);
  }
}

function markAliasServerModified(characterId, aliasId, previous, current) {
  if (!characterId || !aliasId) return;
  const ts = Date.now();
  let perChar = serverModifiedAliases.get(characterId);
  if (!perChar) { perChar = new Map(); serverModifiedAliases.set(characterId, perChar); }
  perChar.set(aliasId, { previous: previous || '', current: current || '', ts });
  if (wmtDb) {
    try {
      wmtDb.prepare(
        'INSERT OR REPLACE INTO alias_guard (character_id, alias_id, previous, current, ts) VALUES (?,?,?,?,?)'
      ).run(characterId, aliasId, previous || '', current || '', ts);
    } catch (e) {
      console.error('alias_guard upsert failed:', e.message);
    }
  }
}

/**
 * On WS auth completion, hydrate session.aliases/triggers/tickers from DB
 * and push the authoritative state to the browser. New clients use it to
 * replace their in-memory copies so subsequent bulk_replace messages are
 * idempotent. Old cached clients ignore the unknown message type — for
 * those, the persisted alias_guard still protects against stale clobbers.
 *
 * IMPORTANT: only includes a list in the push if DB actually has rows for
 * it. An empty list is indistinguishable from "DB never received a save"
 * (e.g. characters whose DB writes silently FK-failed because no row in
 * `characters` table). Sending [] would clobber the browser's correct
 * in-memory copy that was loaded via the JSON-fallback safety net. The
 * client only replaces fields that are present in the message.
 */
function loadAndPushAuthoritativeState(ws, session) {
  if (!session || !session.characterId || !wmtDb) return;
  try {
    const aliases = dbLoadAliases(session.characterId) || [];
    const triggers = dbLoadTriggers(session.characterId) || [];
    const tickers = dbLoadTickers(session.characterId) || [];
    if (aliases.length > 0) session.aliases = aliases;
    if (triggers.length > 0) session.triggers = triggers;
    if (tickers.length > 0) updateSessionTickers(session, tickers);
    if (ws && ws.readyState === 1) {
      const msg = { type: 'authoritative_state' };
      if (aliases.length > 0) msg.aliases = aliases;
      if (triggers.length > 0) msg.triggers = triggers;
      if (tickers.length > 0) msg.tickers = tickers;
      // If everything is empty, skip — let the client keep what it has
      // (probably loaded via the JSON safety net on this character).
      if (msg.aliases || msg.triggers || msg.tickers) {
        ws.send(JSON.stringify(msg));
      }
    }
  } catch (e) {
    console.error('loadAndPushAuthoritativeState failed:', e.message);
  }
}

function clearAliasGuard(characterId, aliasId) {
  const perChar = serverModifiedAliases.get(characterId);
  if (perChar) perChar.delete(aliasId);
  if (wmtDb) {
    try {
      wmtDb.prepare('DELETE FROM alias_guard WHERE character_id=? AND alias_id=?').run(characterId, aliasId);
    } catch (e) {
      console.error('alias_guard clear failed:', e.message);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// entity_guard — generic per-table version of alias_guard. Used for
// triggers / tickers / classes (and future tables). Aliases still use
// alias_guard above; the entity_guard table holds a copy of those rows
// for future unification but the alias bulk_replace path is unchanged.
//
// Shape: Map<characterId, Map<tableName, Map<itemId, { previousRow, currentRow, ts }>>>
//   previousRow / currentRow are full row objects (or null for tombstone).
//   Comparison happens via GUARD_EXTRACTORS — each table picks the fields
//   that meaningfully define "the row" for clobber-detection.
//
// Semantics on bulk_replace:
//   incoming row's extracted key === extract(currentRow)  → client caught up; clear
//   incoming row's extracted key === extract(previousRow) → client stale; swap to currentRow
//   incoming row missing entirely AND currentRow non-null → client trying to delete; re-insert currentRow
//   incoming row missing entirely AND currentRow IS null  → tombstone; client confirmed deletion; clear
//   anything else                                          → deliberate edit; accept and clear
const entityGuards = new Map();

const GUARD_EXTRACTORS = {
  aliases:  (row) => row && typeof row === 'object' ? (row.replacement || '') : '',
  triggers: (row) => row && typeof row === 'object' ? JSON.stringify({
    pattern:   row.pattern || '',
    matchType: row.matchType || row.match_type || '',
    actions:   row.actions || []
  }) : '',
  tickers:  (row) => row && typeof row === 'object' ? JSON.stringify({
    command:  row.command || '',
    interval: row.interval || row.interval_seconds || 0
  }) : '',
  classes:  (row) => row && typeof row === 'object' ? JSON.stringify({
    name:    row.name || '',
    enabled: !!(row.enabled === undefined ? true : row.enabled)
  }) : '',
};

if (wmtDb) {
  try {
    const rows = wmtDb.prepare('SELECT character_id, table_name, item_id, previous_row, current_row, ts FROM entity_guard').all();
    for (const r of rows) {
      let perChar = entityGuards.get(r.character_id);
      if (!perChar) { perChar = new Map(); entityGuards.set(r.character_id, perChar); }
      let perTable = perChar.get(r.table_name);
      if (!perTable) { perTable = new Map(); perChar.set(r.table_name, perTable); }
      let prev = null; let cur = null;
      try { if (r.previous_row) prev = JSON.parse(r.previous_row); } catch {}
      try { if (r.current_row)  cur  = JSON.parse(r.current_row);  } catch {}
      perTable.set(r.item_id, { previousRow: prev, currentRow: cur, ts: r.ts });
    }
    if (rows.length > 0) console.log(`entity_guard: loaded ${rows.length} live entries from DB`);
  } catch (e) {
    console.error('entity_guard load failed:', e.message);
  }
}

function markGuarded(table, charId, itemId, previousRow, currentRow) {
  if (!charId || !itemId) return;
  const ts = Date.now();
  let perChar = entityGuards.get(charId);
  if (!perChar) { perChar = new Map(); entityGuards.set(charId, perChar); }
  let perTable = perChar.get(table);
  if (!perTable) { perTable = new Map(); perChar.set(table, perTable); }
  perTable.set(itemId, { previousRow: previousRow || null, currentRow: currentRow || null, ts });
  if (wmtDb) {
    try {
      wmtDb.prepare(
        'INSERT OR REPLACE INTO entity_guard (character_id, table_name, item_id, previous_row, current_row, ts) VALUES (?,?,?,?,?,?)'
      ).run(
        charId, table, itemId,
        previousRow ? JSON.stringify(previousRow) : null,
        currentRow  ? JSON.stringify(currentRow)  : null,
        ts
      );
    } catch (e) {
      console.error(`entity_guard upsert failed (${table}):`, e.message);
    }
  }
}

function clearEntityGuard(table, charId, itemId) {
  const perTable = entityGuards.get(charId)?.get(table);
  if (perTable) perTable.delete(itemId);
  if (wmtDb) {
    try {
      wmtDb.prepare('DELETE FROM entity_guard WHERE character_id=? AND table_name=? AND item_id=?').run(charId, table, itemId);
    } catch (e) {
      console.error(`entity_guard clear failed (${table}):`, e.message);
    }
  }
}

function applyGuard(table, charId, incomingList) {
  const perTable = entityGuards.get(charId)?.get(table);
  if (!perTable || perTable.size === 0) {
    return { list: incomingList, overridden: 0, cleared: 0, reinserted: 0, tombstoned: 0 };
  }
  const extractor = GUARD_EXTRACTORS[table];
  if (!extractor) return { list: incomingList, overridden: 0, cleared: 0, reinserted: 0, tombstoned: 0 };

  let overridden = 0, cleared = 0, reinserted = 0, tombstoned = 0;
  // Build map of incoming by id (preserve original order via separate array)
  const incomingById = new Map();
  for (const item of incomingList) {
    if (item && item.id) incomingById.set(item.id, item);
  }

  // Walk guarded entries (snapshot keys to allow concurrent mutation during clearing)
  const guardedIds = Array.from(perTable.keys());
  for (const itemId of guardedIds) {
    const guard = perTable.get(itemId);
    if (!guard) continue;
    const { previousRow, currentRow } = guard;
    const incoming = incomingById.get(itemId);

    if (currentRow === null) {
      // Tombstone — admin deleted this row
      if (!incoming) {
        // Client also has it gone — observation matches; clear guard
        clearEntityGuard(table, charId, itemId);
        cleared++;
      } else {
        // Client still has it — drop it from the resulting list
        incomingById.delete(itemId);
        tombstoned++;
      }
      continue;
    }

    if (!incoming) {
      // Row missing from client list but admin's currentRow says it should exist.
      // Re-insert the canonical current row to preserve admin intent.
      incomingById.set(itemId, { id: itemId, ...currentRow });
      reinserted++;
      continue;
    }

    const incomingKey = extractor(incoming);
    const currentKey  = extractor(currentRow);
    const previousKey = previousRow ? extractor(previousRow) : null;

    if (incomingKey === currentKey) {
      // Client caught up to current — clear guard
      clearEntityGuard(table, charId, itemId);
      cleared++;
    } else if (previousKey !== null && incomingKey === previousKey && currentKey !== previousKey) {
      // Client still has stale value — substitute the authoritative current row
      incomingById.set(itemId, { ...incoming, ...currentRow, id: itemId });
      overridden++;
    } else {
      // Client has a different value (deliberate edit, or unrelated change) — accept and clear
      clearEntityGuard(table, charId, itemId);
      cleared++;
    }
  }

  // Rebuild list preserving original incoming order; drop tombstoned ids; append re-inserted
  const seenIds = new Set();
  const out = [];
  for (const item of incomingList) {
    if (!item || !item.id) { out.push(item); continue; }
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    const final = incomingById.get(item.id);
    if (final !== undefined) out.push(final);
    // (else: tombstoned, drop)
  }
  for (const [id, item] of incomingById) {
    if (!seenIds.has(id)) out.push(item);
  }

  return { list: out, overridden, cleared, reinserted, tombstoned };
}
// ────────────────────────────────────────────────────────────────────────

function applyAliasServerModifiedGuard(characterId, incoming) {
  const perChar = serverModifiedAliases.get(characterId);
  if (!perChar || perChar.size === 0) return { aliases: incoming, overridden: 0, cleared: 0 };
  let overridden = 0;
  let cleared = 0;
  const out = incoming.map(a => {
    if (!a || !a.id) return a;
    const rec = perChar.get(a.id);
    if (!rec) return a;
    if (a.replacement === rec.current) {
      // Client caught up — guard no longer needed
      clearAliasGuard(characterId, a.id);
      cleared++;
      return a;
    }
    if (a.replacement === rec.previous && rec.current !== rec.previous) {
      // Client is stale — swap in authoritative value
      overridden++;
      return { ...a, replacement: rec.current };
    }
    // Deliberate edit (or unrelated change) — accept and clear
    clearAliasGuard(characterId, a.id);
    cleared++;
    return a;
  });
  return { aliases: out, overridden, cleared };
}

// Session event log buffer for debugging (circular buffer)
const SESSION_LOG_MAX = 500;
const sessionLogs = [];

// Log persistence tracking - index of next entry to flush to IONOS
let lastFlushedIndex = 0;
let flushInProgress = false;
const LOG_FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ==================== IP Ban System ====================
const IP_BANS_FILE = path.join(__dirname, 'ip_bans.json');

// Load IP bans from disk
function loadIpBans() {
  try {
    if (fs.existsSync(IP_BANS_FILE)) {
      return JSON.parse(fs.readFileSync(IP_BANS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load IP bans:', e.message);
  }
  return [];
}

// Save IP bans to disk
function saveIpBans(bans) {
  try {
    fs.writeFileSync(IP_BANS_FILE, JSON.stringify(bans, null, 2));
    ipBans = bans;
    return true;
  } catch (e) {
    console.error('Failed to save IP bans:', e.message);
    return false;
  }
}

// Check if IP matches a CIDR range
function ipMatchesCidr(ip, cidr) {
  const parts = cidr.split('/');
  if (parts.length !== 2) return false;
  const subnetLong = ip2long(parts[0]);
  const ipLong = ip2long(ip);
  if (subnetLong === null || ipLong === null) return false;
  const bits = parseInt(parts[1], 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipLong & mask) === (subnetLong & mask);
}

// Convert dotted IP to 32-bit integer
function ip2long(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (let i = 0; i < 4; i++) {
    const n = parseInt(parts[i], 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    result = (result * 256) + n;
  }
  return result >>> 0;
}

// ASN cache: ip -> { asn, fetched_at }
const asnCache = new Map();
const ASN_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// Look up ASN for an IP (cached, async)
async function getIpAsn(ip) {
  const cached = asnCache.get(ip);
  if (cached && (Date.now() - cached.fetched_at) < ASN_CACHE_TTL) {
    return cached.asn;
  }
  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.get(`https://ipinfo.io/${ip}/json`, { timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    // org field is like "AS12345 Company Name"
    const asn = data.org ? data.org.split(' ')[0] : null;
    if (asn) {
      asnCache.set(ip, { asn, fetched_at: Date.now() });
    }
    return asn;
  } catch (e) {
    console.error('ASN lookup failed for', ip, e.message);
    return null;
  }
}

// Check if an IP is banned. Returns { banned: true, rule: {...} } or { banned: false }
async function checkIpBan(ip) {
  for (const ban of ipBans) {
    if (ban.type === 'ip' && ban.value === ip) {
      return { banned: true, rule: ban };
    }
    if (ban.type === 'cidr' && ipMatchesCidr(ip, ban.value)) {
      return { banned: true, rule: ban };
    }
  }
  // Only do ASN lookup if there are ASN bans configured
  const asnBans = ipBans.filter(b => b.type === 'asn');
  if (asnBans.length > 0) {
    const asn = await getIpAsn(ip);
    if (asn) {
      for (const ban of asnBans) {
        // Match "AS12345" case-insensitively
        if (ban.value.toUpperCase() === asn.toUpperCase()) {
          return { banned: true, rule: ban };
        }
      }
    }
  }
  return { banned: false };
}

let ipBans = loadIpBans();

// ─── Honeypot trip strings ───
// If a session's command exactly matches one of these strings, auto-ban the
// source IP and close the connection. Used to catch repeat griefers whose
// signature inputs (specific passwords, throwaway emails, etc.) are unique
// enough that legit users won't trip them. Currently seeded with the
// Yggdrasil/Dwolin attacker's char-creation password seen 2026-05-10.
//
// To add more without a deploy, write to /opt/wmt/honeypot_trips.json
// (one trip string per array element); reloaded on each command check.
let honeypotTrips = [
  'namida'  // attacker's reused password during repeated char creation
];
function loadHoneypotTrips() {
  try {
    const path = '/opt/wmt/honeypot_trips.json';
    if (fs.existsSync(path)) {
      const data = JSON.parse(fs.readFileSync(path, 'utf8'));
      if (Array.isArray(data)) honeypotTrips = data;
    }
  } catch (e) {
    console.error('Failed to load honeypot_trips.json:', e.message);
  }
}
loadHoneypotTrips();
// Re-read every 60s so admin edits to the file take effect without restart.
setInterval(loadHoneypotTrips, 60000);

function tripHoneypot(session, ws, cmd, reason) {
  const ip = session?.clientIp || '';
  if (!ip) return;
  // Skip if already banned (idempotent)
  for (const ban of ipBans) {
    if (ban.type === 'ip' && ban.value === ip) return;
  }
  const ban = {
    type: 'ip',
    value: ip,
    reason: `Honeypot trip: ${reason}`,
    banned_at: new Date().toISOString(),
    banned_by: 'honeypot'
  };
  ipBans.push(ban);
  saveIpBans(ipBans);
  logSessionEvent('IP_BAN_AUTO', {
    type: 'ip',
    value: ip,
    reason: ban.reason,
    matchedCmd: cmd,
    user: session.userId || null,
    char: session.characterName || null
  });
  // Close everything — MUD socket and WS — so the trip is visible to the user
  // and they don't think their last command worked.
  try { session.mudSocket?.destroy(); } catch (e) {}
  try { ws?.close(1008, 'Banned'); } catch (e) {}
}

// ==================== Bridge Mode ====================
// When BRIDGE_URL is set, MUD TCP connections go through bridge.js
// which holds them across server.js restarts (zero-downtime deploys).

const EventEmitter = require('events');
let bridgeWs = null;
let bridgeReconnectTimer = null;
// Tracks whether the one-time persistent-session restore has already run
// during this server lifetime. We trigger it from the bridge `open` handler
// instead of a fixed setTimeout so restore happens as soon as its real
// dependency (the bridge handshake) is satisfied, before browsers can
// reconnect and lose the race against the in-memory sessions map.
let bridgeRestoreDone = false;
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
    // Idempotent — calling end() twice should not double-emit close.
    if (this.destroyed) return;
    if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
      try { bridgeWs.send(JSON.stringify({ type: 'destroy', token: this.token })); } catch (e) {}
    }
    this.destroyed = true;
    this.writable = false;
    bridgeSockets.delete(this.token);
    // Mirror Node TCP socket convention: emit 'close' after destroy. Without
    // this, the connectToMud on('close') handler never fires, which means
    // closeSession() is never called for sessions that end via the bridge's
    // 'end' message (clean MUD-side close, e.g. user typed `quit`). The
    // result was missing 'disconnect' audit rows for clean quit/idle drops.
    // Use nextTick so the current call frame can finish before listeners run.
    process.nextTick(() => this.emit('close'));
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

  bridgeWs.on('open', async () => {
    console.log('[bridge] Connected to bridge');
    if (bridgeReconnectTimer) {
      clearTimeout(bridgeReconnectTimer);
      bridgeReconnectTimer = null;
    }

    // First-time bridge connection on this server startup → run persistent
    // session restore IMMEDIATELY, before any browser can reconnect and
    // race the in-memory sessions map. Without this, the auth handler sees
    // an empty map for tokens it should know about and fires SESSION_NEW
    // (`login` audit) instead of SESSION_RESUME (`reconnect` audit) for
    // every active user on every server restart. Pre-existing race fixed
    // 2026-04-11.
    if (!bridgeRestoreDone) {
      bridgeRestoreDone = true;
      try {
        await restorePersistentSessions();
      } catch (e) {
        console.error('[bridge] Restore on bridge open failed:', e.message);
      }
    }

    // After bridge reconnect (NOT initial startup), tell connected browsers
    // to re-establish MUD connections. Sessions lost their mudSocket when
    // bridge dropped (close handler above).
    let reconnectCount = 0;
    for (const [token, session] of sessions) {
      if (session.wsClients.size > 0 && !session.mudSocket && session.targetHost) {
        reconnectCount++;
        sendToClient(session, { type: 'mud_reconnect' });
      }
    }
    if (reconnectCount > 0) {
      console.log(`[bridge] Sent mud_reconnect to ${reconnectCount} connected browser(s)`);
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

    // Properly close all BridgeSockets so sessions know MUD is gone.
    // Without this, BridgeSockets become zombies (writable=true but can't write).
    const affectedTokens = [];
    for (const [token, bs] of bridgeSockets) {
      affectedTokens.push(token.substring(0, 8));
      bs.destroyed = true;
      bs.writable = false;
      bs.emit('close');
    }
    bridgeSockets.clear();
    if (affectedTokens.length > 0) {
      console.log(`[bridge] Closed ${affectedTokens.length} BridgeSockets: ${affectedTokens.join(', ')}`);
    }

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
const LOG_RETENTION_DAYS = 7; // Keep logs on Lightsail for 7 days
const LOG_USER_ID = process.env.LOG_USER_ID || null; // If set, only log this user's sessions
const _logDirsCreated = new Set();

const LOG_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB per rotation file
const LOG_MAX_ROTATIONS = 10; // Keep up to 10 rotated files per char per day (50 MB total)
const LOG_MAX_ROTATIONS_ADMIN = 50; // Nathan's account: 50 rotations (250 MB) for deeper debugging
const _logFileSizeCache = new Map(); // filePath -> { size, checkedAt }

// Resolve the best-known name for a session: if the sniffer has captured the
// real MUD character name from the login prompt, prefer that over the
// user-chosen WMT slot label. Falls back to characterId, then 'unknown'.
// Used for audit logs, per-character log filenames, and journalctl `char=`
// fields so the operator-facing record reflects MUD truth, not the user's
// editable slot label. NEW structured wmtSlot/mudChar fields stay distinct
// (so mismatches remain visible) — only the legacy single-name fields use
// this helper.
function effectiveCharName(session) {
  if (!session) return 'unknown';
  return session._actualMudChar || session.characterName || session.characterId || 'unknown';
}

// Returns true when a chat message originated from this session's character.
// Used to gate the suppressSelfAlerts preference for ChatMon ding/Discord/IFTTT.
// `msg.outbound` covers MIP "x~" tells (always-self by definition).
// `msg.sender` is parts[2] of CAA channel payloads or parts[1] of inbound BAB —
// case-insensitive comparison handles channel-vs-MUD casing differences
// (e.g. "Elminster" on mage vs "elminster" on ptell).
function isSelfAuthoredChat(session, msg) {
  if (!session || !msg) return false;
  if (msg.outbound) return true;
  if (!msg.sender) return false;
  const selfName = effectiveCharName(session);
  if (!selfName || selfName === 'unknown') return false;
  return String(msg.sender).toLowerCase() === String(selfName).toLowerCase();
}

function writeSessionLog(session, type, data) {
  if (!session) return;
  // Only log for the configured user (if filter is set)
  if (LOG_USER_ID && String(session.userId) !== LOG_USER_ID) return;
  try {
    const date = new Date().toISOString().slice(0, 10);
    const charName = effectiveCharName(session)
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

    // Size cap: check every 60s, rotate if over limit. Old behavior was
    // "stop writing" which silently lost all events for the rest of the day.
    // New behavior rotates the current file and starts fresh, keeping up to
    // LOG_MAX_ROTATIONS old copies so you can always look back.
    const cached = _logFileSizeCache.get(filePath);
    const now = Date.now();
    let currentSize = 0;
    if (cached && now - cached.checkedAt < 60000) {
      currentSize = cached.size;
    } else {
      try {
        const stat = fs.statSync(filePath);
        currentSize = stat.size;
        _logFileSizeCache.set(filePath, { size: currentSize, checkedAt: now });
      } catch (e) {
        _logFileSizeCache.set(filePath, { size: 0, checkedAt: now });
      }
    }
    if (currentSize >= LOG_MAX_FILE_SIZE) {
      try {
        const maxRot = (session.userId === 'bd035a266e8aa6c77e69d950ba0120c0')
          ? LOG_MAX_ROTATIONS_ADMIN : LOG_MAX_ROTATIONS;
        // Rotate: .4 → .5 (deleted), .3 → .4, .2 → .3, .1 → .2, current → .1
        for (let i = maxRot; i >= 1; i--) {
          const older = `${filePath}.${i}`;
          if (i === maxRot) {
            try { fs.unlinkSync(older); } catch (e) {}
          }
          if (i > 1) {
            const newer = `${filePath}.${i - 1}`;
            try { fs.renameSync(newer, older); } catch (e) {}
          } else {
            try { fs.renameSync(filePath, older); } catch (e) {}
          }
        }
        _logFileSizeCache.set(filePath, { size: 0, checkedAt: now });
      } catch (e) {
        // Rotation failed — continue writing to the existing file rather
        // than silently losing data.
      }
    }

    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      ...data
    }) + '\n';

    // Update cached size estimate
    if (cached) cached.size += entry.length;

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

// ==================== MUD Event Sniffer ====================
// Packet-level pattern matching on MUD output lines. Emits structured events
// for login prompts, name/password rejections, linkdeath state, relink,
// session takeover, etc. Events go to both the per-session JSONL log
// (writeSessionLog) and the structured journalctl/IONOS buffer
// (logSessionEvent). Patterns are anchored at start-of-line to minimize
// false positives against normal game text.
//
// All patterns below are harvested from real sessions — do not add speculative
// ones; add new patterns only after confirming the exact text from a live log.
const MUD_EVENT_PATTERNS = [
  // Login/name prompt
  { re: /^<Entering 3(?:Kingdoms|Scapes)\.\s*Enter your character name/, event: 'name_prompt_banner', atNamePrompt: true },
  { re: /^What is your name:/,                                            event: 'name_prompt',        atNamePrompt: true },
  { re: /^Password:\s*$/,                                                 event: 'password_prompt',    atNamePrompt: false },

  // Name prompt rejections (the StantonTheManton case)
  { re: /^That name is too long/,                                         event: 'name_too_long',      atNamePrompt: true },
  { re: /^Invalid character in position/,                                 event: 'name_invalid_char',  atNamePrompt: true },

  // State-of-account messages at login prompt
  { re: /^Your character is currently logged in and linkdead/,            event: 'linkdead_at_prompt' },
  { re: /^Your character is currently logged in and active/,              event: 'takeover_at_prompt' },

  // Successful relink — own-perspective message
  { re: /^3Kingdoms welcomes you back from linkdeath/,                    event: 'relink_complete', realm: '3k' },
  { re: /^3Scapes welcomes you back from linkdeath/,                      event: 'relink_complete', realm: '3s' },
  { re: /^You received tells while linkdead/,                             event: 'relink_tells_waiting' },

  // Auth failures
  { re: /^Incorrect password\./,                                          event: 'password_fail',      atNamePrompt: true },

  // Character creation flow markers (3K-specific). The first prompt fires
  // mid-creation; the welcome line fires when registration completes.
  // Used to (a) tag the session as "in creation" so the welcome doesn't
  // get treated as a normal login, (b) emit a `register` audit row.
  { re: /^Where did you hear about 3Kingdoms\?/,                          event: 'creation_prompt' },
  { re: /^3Kingdoms welcomes you!\s*$/,                                   event: 'welcome_fresh', realm: '3k' },

  // Successful quit — both 3K and 3S send the same humorous goodbye line
  // immediately before saving the character and closing the socket. This
  // is the ground-truth signal for "user voluntarily quit," distinct from
  // a linkdeath / browser-close / timeout (where this line is never sent).
  // Used to flip the audit-log close event from `disconnect` to `logout`.
  { re: /^There was this one time, at band camp\.\.\.$/,                  event: 'quit_complete' },
];

function detectMudEvents(session, rawLine) {
  if (!session || !rawLine) return;
  // Patterns are anchored at start of line and match plain text, so strip
  // ANSI once up front. Cheap on short lines; returns early on no match.
  const clean = stripAnsi(rawLine).trimEnd();
  if (!clean) return;

  for (const p of MUD_EVENT_PATTERNS) {
    if (p.re.test(clean)) {
      const payload = {
        token: session.token ? session.token.substring(0, 8) : null,
        user: session.userId || null,
        wmtSlot: session.characterName || null,
        mudChar: session._actualMudChar || null,
        event: p.event,
      };
      if (p.realm) payload.realm = p.realm;

      logSessionEvent('MUD_EVENT', payload);
      writeSessionLog(session, 'mud_event', { event: p.event, realm: p.realm || null, match: clean.substring(0, 120) });

      // State-machine side effect: track whether the MUD is currently
      // asking for a character name. Used by the input handler to
      // capture the real MUD character name (which may differ from the
      // WMT slot label).
      // password_fail means back to name prompt — clear _nameCaptured
      // BEFORE the atNamePrompt guard so the flag can be re-set.
      if (p.event === 'password_fail') {
        session._nameCaptured = false;
      }

      // Guard: don't re-set _atNamePrompt if a name was already captured
      // in this login cycle. Guest accounts (no password) hit this: the
      // banner line processes AFTER the user already typed their name,
      // re-setting the flag. Without a Password: prompt to clear it, the
      // next game command (like "jump") gets falsely captured as the
      // character name. The _nameCaptured flag is only cleared by
      // password_fail (retry) or a new session.
      if (p.atNamePrompt === true && !session._nameCaptured) {
        session._atNamePrompt = true;
      }
      if (p.atNamePrompt === false) session._atNamePrompt = false;

      // ─── Deferred login audit state machine ───
      // The login audit fires from the sniffer rather than from WMT auth
      // because we want to distinguish a fresh login from a return-from-
      // linkdeath. Both go through the same WMT auth flow; only the MUD
      // can tell us which it actually was.
      //
      // State flags on session:
      //   _loginAuditPending           — set in createSession, cleared on fire
      //   _loginAuditAtPasswordPrompt  — true between password_prompt event
      //                                  and the user typing the password
      //   _loginAuditPasswordEntered   — true after user types the password,
      //                                  watching for the FIRST real command
      //
      // Sequence:
      //   1. createSession sets _loginAuditPending = true
      //   2. password_prompt event → _loginAuditAtPasswordPrompt = true
      //   3. user types password → input handler moves us to
      //      _loginAuditPasswordEntered = true (skips the password itself)
      //   4. user types FIRST real command → input handler fires `login`
      //   5. relink_complete event preempts at any point → fire `reconnect`
      //   6. closeSession fallback: if _loginAuditPasswordEntered is still
      //      true at close, fire `login` (covers fast #end / idle close)
      //   7. password_fail clears both flags — back at name prompt
      if (p.event === 'password_prompt' && session._loginAuditPending) {
        session._loginAuditAtPasswordPrompt = true;
      }
      if (p.event === 'relink_complete' && session._loginAuditPending) {
        session._loginAuditPending = false;
        session._loginAuditAtPasswordPrompt = false;
        session._loginAuditPasswordEntered = false;
        // Audit-log activity name is 'reconnect' (return from linkdeath).
        // The internal sniffer pattern label stays 'relink_complete' for
        // journalctl/JSONL diagnostics — that's a more specific term for
        // the underlying MUD message — but the operator-facing audit log
        // uses the natural word.
        sendAuditLog('reconnect', session, session.clientIp);
      }
      if (p.event === 'password_fail') {
        session._loginAuditAtPasswordPrompt = false;
        session._loginAuditPasswordEntered = false;
        // Record the failed attempt. The sniffer has already captured the
        // typed name into _actualMudChar, so the audit row carries the
        // real MUD character the attempt was against. The session stays
        // open (MUD drops the TCP connection, WMT cleans up on timeout),
        // so we log this as its own row — separate from disconnect —
        // and suppress the later disconnect row in closeSession.
        session._loginFailedLogged = true;
        sendAuditLog('login_failed', session, session.clientIp);
      }
      // Quit detection: the band-camp goodbye line is the ground-truth
      // signal that the user voluntarily quit (vs linkdeath / fast close).
      // Just flag it on the session — closeSession will fire `logout`
      // instead of `disconnect` when this flag is set. We don't fire the
      // audit row here directly because the disconnect path is the right
      // place to emit it (avoids ordering issues with the close handler).
      if (p.event === 'quit_complete') {
        session._loginAuditQuit = true;
      }

      // ─── Character creation tracking (audit-log gap fix) ───
      // 3K's char creation flow doesn't use the literal "Password:" prompt
      // (it asks "Pick a password:" / "Confirm password:" instead), so the
      // existing login-audit state machine never advances and registrations
      // never appear in the audit CSV. We mark `_inCreationFlow` on a unique
      // creation-only prompt and emit a `register` row on the welcome line.
      // Confirmed gap 2026-05-10 (Yggdrasil/Dwolin attacker spam-creating
      // chars went undetected in the activity log for hours).
      if (p.event === 'creation_prompt') {
        session._inCreationFlow = true;
      }
      if (p.event === 'welcome_fresh' && session._inCreationFlow) {
        session._inCreationFlow = false;
        if (session._loginAuditPending) {
          session._loginAuditPending = false;
          session._loginAuditAtPasswordPrompt = false;
          session._loginAuditPasswordEntered = false;
          sendAuditLog('register', session, session.clientIp);
        }
      }

      // ─── Multi-device password leak suppression ───
      // Capture is driven by the EAGER `_eagerAtPasswordPrompt` flag (set
      // from data-handler chunk inspection — fires the moment "Password:"
      // appears, not when a complete line is parsed). The line-completion
      // event below only handles the cleanup path, because mock MUDs that
      // send "Password: " without immediate \r\n cause password_prompt to
      // fire LATE — after the password has already been transmitted —
      // and capturing on that delayed event would grab the wrong command.
      if (p.event === 'password_fail') {
        // Real password failure — retry incoming, clear cache so the next
        // password attempt can be captured fresh.
        session._suppressionPassword = null;
        session._suppressionExpiresAt = 0;
      }
      if (p.event === 'relink_complete') {
        // Linkdeath welcome — auth window done.
        session._suppressionPassword = null;
        session._suppressionExpiresAt = 0;
      }

      // One line can only be one event — stop scanning.
      return;
    }
  }
}

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

/**
 * Send message to IFTTT Maker webhook (fire and forget).
 * Posts directly to maker.ifttt.com — no proxy needed (IFTTT doesn't block AWS IPs).
 * Payload mirrors the legacy elmtell bash script: value1 = "<who> <where>:" prefix,
 * value2 = message body. Existing IFTTT applets keyed off value1/value2 keep working.
 */
function sendToIfttt(key, eventName, value1, value2, value3) {
  if (!key || !eventName) return;
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(key)) return;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(eventName)) return;

  const stripAndCap = (s, cap) => {
    if (s == null) return '';
    return String(s).replace(/\x1b\[[0-9;]*m/g, '').substring(0, cap);
  };
  const payload = JSON.stringify({
    value1: stripAndCap(value1, 500),
    value2: stripAndCap(value2, 1500),
    value3: stripAndCap(value3, 500)
  });

  try {
    const options = {
      hostname: 'maker.ifttt.com',
      port: 443,
      path: `/trigger/${encodeURIComponent(eventName)}/with/key/${encodeURIComponent(key)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 5000
    };
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          sessionLogs.push({
            time: new Date().toISOString(),
            type: 'IFTTT_WEBHOOK_ERROR',
            statusCode: res.statusCode,
            response: body.substring(0, 200),
            event: eventName
          });
          if (sessionLogs.length > SESSION_LOG_MAX) sessionLogs.shift();
        });
      } else {
        res.resume();
      }
    });
    req.on('error', (e) => {
      sessionLogs.push({
        time: new Date().toISOString(),
        type: 'IFTTT_WEBHOOK_ERROR',
        error: e.message,
        event: eventName
      });
      if (sessionLogs.length > SESSION_LOG_MAX) sessionLogs.shift();
    });
    req.on('timeout', () => req.destroy());
    req.write(payload);
    req.end();
  } catch (e) {
    console.error('IFTTT webhook exception:', e.message);
  }
}

// PHP API URLs (survive server restart)
const PHP_API_URL = 'https://client.wemudtogether.com/api/preferences.php';
const PHP_SESSIONS_URL = 'https://client.wemudtogether.com/api/persistent_sessions.php';
const PHP_CHARACTERS_URL = 'https://client.wemudtogether.com/api/characters.php';
const PHP_DISCORD_PROXY_URL = 'https://client.wemudtogether.com/api/discord_proxy.php';
const PHP_AUDIT_LOG_URL = 'https://client.wemudtogether.com/api/audit_log.php';

/**
 * Send audit log entry to IONOS (fire and forget)
 */
function sendAuditLog(activity, session, ip) {
  if (!ADMIN_KEY) return;
  const payload = JSON.stringify({
    activity,
    user_id: session.userId || '',
    character: effectiveCharName(session),
    realm: session.targetHost === '3scapes.org' ? '3s' : '3k',
    ip: ip || session.clientIp || ''
  });
  try {
    const urlObj = new URL(PHP_AUDIT_LOG_URL);
    const req = https.request({
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': ADMIN_KEY,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 3000
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(payload);
    req.end();
  } catch (e) {}
}
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
        if (typeof response.iftttKey === 'string' && /^[A-Za-z0-9_-]{10,64}$/.test(response.iftttKey)) {
          session.iftttKey = response.iftttKey;
        }

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
          char: effectiveCharName(session),
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
      char: effectiveCharName(session),
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
      // Serialize pending #delay timers so they survive restart.
      // Store the remaining time so we can recreate the setTimeout on
      // restore with the correct remaining duration.
      const serializedDelays = [];
      if (session._delays) {
        const now = Date.now();
        for (const [name, timer] of Object.entries(session._delays)) {
          // Node's setTimeout doesn't expose remaining time directly.
          // We stored the fire time when creating the delay.
          if (timer._wmt_fireAt && timer._wmt_command) {
            const remainingMs = Math.max(0, timer._wmt_fireAt - now);
            serializedDelays.push({
              name,
              command: timer._wmt_command,
              remainingMs
            });
          }
        }
      }

      activeSessions.push({
        userId: session.userId,
        characterId: session.characterId,
        characterName: session.characterName,
        server: session.targetHost === '3scapes.org' ? '3s' : '3k',
        token: token,
        bridgeToken: (session.mudSocket instanceof BridgeSocket) ? session.mudSocket.token : undefined,
        isWizard: session.isWizard || false,
        persistedAt: Date.now(),
        chatBuffer: session.chatBuffer || [],
        // Phase 1: persist session state for seamless restart
        variables: session.variables || {},
        delays: serializedDelays,
        actualMudChar: session._actualMudChar || null
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

  const payload = JSON.stringify({ sessions: activeSessions });
  const url = new URL(`${PHP_SESSIONS_URL}?action=save`);

  // Retry once on failure. Session persistence is the most critical
  // operation during shutdown — a transient HTTP error or PHP hiccup
  // must not silently drop every user's MUD connection.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
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
              logSessionEvent('PERSIST_SUCCESS', { count: activeSessions.length, attempt });
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
      break; // success — exit retry loop
    } catch (e) {
      if (attempt < 2) {
        logSessionEvent('PERSIST_RETRY', { error: e.message, attempt });
        await new Promise(r => setTimeout(r, 1000)); // 1s pause before retry
      } else {
        logSessionEvent('PERSIST_ERROR', { error: e.message, attempts: attempt });
      }
    }
  }
}

/**
 * Periodic session snapshot — lightweight persist that runs every 30s.
 * Saves variables, delays, and session identity so a failed SIGTERM
 * persist loses at most 30 seconds of state instead of everything.
 * Fire-and-forget: failures are logged but don't block or retry.
 */
async function persistSnapshot() {
  if (!ADMIN_KEY) return;

  const activeSessions = [];
  for (const [token, session] of sessions) {
    if (session.mudSocket && !session.mudSocket.destroyed) {
      const serializedDelays = [];
      if (session._delays) {
        const now = Date.now();
        for (const [name, timer] of Object.entries(session._delays)) {
          if (timer._wmt_fireAt && timer._wmt_command) {
            serializedDelays.push({
              name,
              command: timer._wmt_command,
              remainingMs: Math.max(0, timer._wmt_fireAt - now)
            });
          }
        }
      }

      activeSessions.push({
        userId: session.userId,
        characterId: session.characterId,
        characterName: session.characterName,
        server: session.targetHost === '3scapes.org' ? '3s' : '3k',
        token: token,
        bridgeToken: (session.mudSocket instanceof BridgeSocket) ? session.mudSocket.token : undefined,
        isWizard: session.isWizard || false,
        persistedAt: Date.now(),
        // Lightweight: no chatBuffer (too large for 30s snapshots)
        chatBuffer: [],
        variables: session.variables || {},
        delays: serializedDelays,
        actualMudChar: session._actualMudChar || null
      });
    }
  }

  if (activeSessions.length === 0) return;

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
          if (res.statusCode === 200) resolve();
          else reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(payload);
      req.end();
    });
  } catch (e) {
    // Fire-and-forget: log but don't retry. Next cycle will try again.
    console.error('Snapshot persist failed:', e.message);
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

              // Remove trailing empty string artifact from \n-terminated data.
              // "MIP_DATA\r\n".split('\n') → ["MIP_DATA\r", ""] — the empty string
              // is a split artifact, not real content. Without this, every gagged MIP
              // line leaks a blank line to the client.
              if (fullText.endsWith('\n') && parts.length > 0 && parts[parts.length - 1] === '') {
                parts.pop();
              }

              if (hasGA) {
                session.lineBuffer = '';
                flushPatchQueue(session);
                parts.forEach(line => processLine(session, line));
                return;
              }

              if (!text.endsWith('\n') && parts.length > 0) {
                session.lineBuffer = parts.pop();
                if (session.lineBuffer) {
                  // Single-timer fragment hold. Scales with packet_patch, min 500ms.
                  const holdMs = Math.max(500, session.packetPatchMs * 2);
                  session.lineBufferTimeout = setTimeout(() => {
                    if (session.lineBuffer) {
                      processLine(session, stripTrailingAnsi(session.lineBuffer));
                      session.lineBuffer = '';
                    }
                    session.lineBufferTimeout = null;
                  }, holdMs);
                }
              } else {
                session.lineBuffer = '';
              }

              queueLinesForProcessing(session, parts);
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
        // Still merge chatBuffer if the existing session lost it
        if (ps.chatBuffer && ps.chatBuffer.length > 0 && existing.chatBuffer.length === 0) {
          existing.chatBuffer = ps.chatBuffer;
        }
        logSessionEvent('RESTORE_SKIP_ACTIVE', {
          token: ps.token.substring(0, 8),
          char: ps.characterName,
          existingToken: existingToken.substring(0, 8),
          note: 'user+char already has active MUD connection'
        });
        continue;
      }
      // Browser already connected — don't overwrite the session. Creating a
      // new session object would orphan the browser's WebSocket, triggers,
      // aliases, and variables. The _pendingBridgeResume / connectToMud flow
      // will establish the MUD connection when set_triggers arrives.
      if (existing.ws) {
        // Merge chatBuffer from persistence — the new session has an empty
        // chatBuffer since the browser reconnected before restore ran.
        if (ps.chatBuffer && ps.chatBuffer.length > 0 && existing.chatBuffer.length === 0) {
          existing.chatBuffer = ps.chatBuffer;
          // Replay to the connected browser so ChatMon shows history
          for (const msg of ps.chatBuffer) {
            try {
              existing.ws.send(JSON.stringify(msg));
            } catch (e) { break; }
          }
        }
        logSessionEvent('RESTORE_SKIP_BROWSER', {
          token: ps.token.substring(0, 8),
          char: ps.characterName,
          existingToken: existingToken.substring(0, 8),
          note: 'browser already connected, merged chatBuffer'
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
    if (ps.chatBuffer && ps.chatBuffer.length > 0) {
      session.chatBuffer = ps.chatBuffer;
    }

    // Phase 1: restore persisted session state
    if (ps.variables && Object.keys(ps.variables).length > 0) {
      session.variables = ps.variables;
    }
    if (ps.actualMudChar) {
      session._actualMudChar = ps.actualMudChar;
    }

    // Load chat history from DB — authoritative source for chat.
    if (wmtDb && ps.characterId) {
      try {
        const chatRows = dbStmts.getRecentChat.all(ps.characterId, CHAT_BUFFER_MAX);
        if (chatRows.length > 0) {
          session.chatBuffer = chatRows.reverse().map(r => {
            try { return JSON.parse(r.raw_data); } catch (e) { return null; }
          }).filter(Boolean);
        }
      } catch (e) {}
    }

    // Pre-load triggers/aliases from DB so the session starts
    // with the correct set BEFORE the browser reconnects and syncs.
    if ((!DB_ENABLED_USERS || DB_ENABLED_USERS.has(ps.userId)) && ps.characterId) {
      const dbTriggers = dbLoadTriggers(ps.characterId);
      if (dbTriggers && dbTriggers.length > 0) {
        session.triggers = dbTriggers;
        logSessionEvent('RESTORE_DB_TRIGGERS', {
          token: ps.token.substring(0, 8),
          char: ps.characterName,
          count: dbTriggers.length
        });
      }
      const dbAliases = dbLoadAliases(ps.characterId);
      if (dbAliases && dbAliases.length > 0) {
        session.aliases = dbAliases;
        logSessionEvent('RESTORE_DB_ALIASES', {
          token: ps.token.substring(0, 8),
          char: ps.characterName,
          count: dbAliases.length
        });
      }
      const dbTickers = dbLoadTickers(ps.characterId);
      if (dbTickers && dbTickers.length > 0) {
        updateSessionTickers(session, dbTickers);
        logSessionEvent('RESTORE_DB_TICKERS', {
          token: ps.token.substring(0, 8),
          char: ps.characterName,
          count: dbTickers.length
        });
      }
    }

    // Recreate server-side #delay timers from serialized state.
    // If a timer's remaining time has elapsed (negative), fire it
    // immediately — the command should have run during the restart
    // window and we don't want to silently drop it.
    if (ps.delays && ps.delays.length > 0) {
      session._delays = {};
      for (const d of ps.delays) {
        const remainingMs = Math.max(0, d.remainingMs || 0);
        const fireDelay = remainingMs > 0 ? remainingMs : 50; // 50ms for "should have already fired"
        const timer = setTimeout(() => {
          delete session._delays[d.name];
          const expanded = expandCommandWithAliases(d.command, session.aliases || [], 0, session.variables || {}, session.functions || {}, session);
          expanded.forEach(ec => {
            const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
            if (repeatMatch) {
              executeRepeat(Math.min(parseInt(repeatMatch[1]), 100), repeatMatch[2], session);
            } else if (ec.startsWith('#')) {
              sendToClient(session, { type: 'client_command', command: ec });
            } else if (session.mudSocket && !session.mudSocket.destroyed) {
              session.mudSocket.write(processEscapes(ec) + '\r\n');
            }
          });
        }, fireDelay);
        timer._wmt_fireAt = Date.now() + fireDelay;
        timer._wmt_command = d.command;
        session._delays[d.name] = timer;
      }
      logSessionEvent('RESTORE_DELAYS', {
        token: ps.token.substring(0, 8),
        char: ps.characterName,
        count: ps.delays.length,
        names: ps.delays.map(d => d.name).join(',')
      });
    }

    let success = false;

    if (BRIDGE_URL) {
      // Bridge mode: resume existing TCP connection (no re-login needed!)
      // The bridge held the MUD connection while we restarted.
      // Use bridgeToken if available — session token may have been rekeyed
      // but bridge still knows the connection by the original token
      const bridgeResumeToken = ps.bridgeToken || ps.token;
      session.mudSocket = new BridgeSocket(bridgeResumeToken);

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

        // Remove trailing empty string artifact from \n-terminated data
        if (fullText.endsWith('\n') && parts.length > 0 && parts[parts.length - 1] === '') {
          parts.pop();
        }

        if (hasGA) {
          session.lineBuffer = '';
          flushPatchQueue(session);
          parts.forEach(line => processLine(session, line));
          return;
        }

        if (!text.endsWith('\n') && parts.length > 0) {
          session.lineBuffer = parts.pop();
          if (session.lineBuffer) {
            // Single-timer fragment hold. Scales with packet_patch, min 500ms.
            const holdMs = Math.max(500, session.packetPatchMs * 2);
            session.lineBufferTimeout = setTimeout(() => {
              if (session.lineBuffer) {
                processLine(session, stripTrailingAnsi(session.lineBuffer));
                session.lineBuffer = '';
              }
              session.lineBufferTimeout = null;
            }, holdMs);
          }
        } else {
          session.lineBuffer = '';
        }

        queueLinesForProcessing(session, parts);
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
 * Convert MIP color codes to HTML spans.
 * strictFollowChar: when true, only treat `<X` as a color code if the next
 * char is non-alphanumeric — needed for chat (user text like `<blah>`),
 * but must be false for server-formatted gline data where colored text
 * often starts with a letter (e.g. `<yCrane>`).
 */
function convertMipColors(text, strictFollowChar = true) {
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
  let spanDepth = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '<' && i + 1 < text.length && colorMap[text[i + 1]]) {
      if (!strictFollowChar) {
        result += `<span style="color:${colorMap[text[i + 1]]}">`;
        i += 2;
        spanDepth++;
        continue;
      }
      const after = i + 2 < text.length ? text[i + 2] : '';
      if (!after || /[^a-zA-Z0-9]/.test(after)) {
        result += `<span style="color:${colorMap[text[i + 1]]}">`;
        i += 2;
        spanDepth++;
        continue;
      }
    }

    // Literal `<`, `>`, `&` must be HTML-escaped so the browser renders
    // them as text instead of interpreting as tags.
    if (ch === '<') {
      result += '&lt;';
      i++;
    } else if (ch === '>') {
      if (spanDepth > 0) {
        result += '</span>';
        spanDepth--;
      } else {
        result += '&gt;';
      }
      i++;
    } else if (ch === '&') {
      result += '&amp;';
      i++;
    } else {
      result += ch;
      i++;
    }
  }

  // Close any unclosed color spans to keep the HTML balanced
  while (spanDepth > 0) {
    result += '</span>';
    spanDepth--;
  }

  // Linkify http(s) URLs. Match only outside HTML attributes (e.g. style="...")
  // by requiring the preceding char to not be a quote or `=`. target=_blank +
  // rel=noopener prevents the destination from touching the opener window.
  // Only http/https schemes — blocks javascript:, data:, etc.
  result = result.replace(
    /(^|[^"'=>])(https?:\/\/[^\s<>"']+)/g,
    (m, pre, url) => {
      // Trim trailing punctuation that's likely sentence-terminal, not URL
      const trail = url.match(/[),.!?;:]+$/);
      const clean = trail ? url.slice(0, -trail[0].length) : url;
      const suffix = trail ? trail[0] : '';
      return `${pre}<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${suffix}`;
    }
  );

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
    if (session.wsClients.size === 0 && session.disconnectedAt) {
      // Skip timeout for wizard accounts (game devs who may idle for long periods)
      if (session.isWizard) {
        continue;
      }
      const elapsed = now - session.disconnectedAt;
      if (elapsed > SESSION_TIMEOUT_MS) {
        logSessionEvent('SESSION_TIMEOUT', {
          token: token.substring(0, 8),
          user: session.userId,
          char: effectiveCharName(session),
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
      const browserConnected = session.wsClients.size > 0;

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
          if (session.wsClients.size > 0) {
            try {
              sendToClient(session, {
                type: 'broadcast',
                message: message,
                timestamp: Date.now()
              });
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
        wsConnected: session.wsClients.size > 0,
        wsClientCount: session.wsClients.size,
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

  } else if (parsedUrl.pathname === '/ip-bans' && req.method === 'GET') {
    // Admin: list IP bans
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, bans: ipBans }));

  } else if (parsedUrl.pathname === '/ip-bans' && req.method === 'POST') {
    // Admin: add IP ban
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const type = data.type; // 'ip', 'cidr', 'asn'
        const value = (data.value || '').trim();
        const reason = (data.reason || '').trim();

        if (!['ip', 'cidr', 'asn'].includes(type)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Type must be ip, cidr, or asn' }));
          return;
        }
        if (!value) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Value is required' }));
          return;
        }

        // Validate format
        if (type === 'cidr' && !value.includes('/')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'CIDR must include /prefix (e.g. 10.0.0.0/8)' }));
          return;
        }
        if (type === 'asn' && !value.toUpperCase().startsWith('AS')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'ASN must start with AS (e.g. AS12345)' }));
          return;
        }

        const ban = {
          type,
          value: type === 'asn' ? value.toUpperCase() : value,
          reason,
          banned_at: new Date().toISOString(),
          banned_by: 'admin'
        };

        const bans = loadIpBans();
        bans.push(ban);
        if (saveIpBans(bans)) {
          logSessionEvent('IP_BAN_ADDED', { type, value: ban.value, reason });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, ban, total: bans.length }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Failed to save' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });
    return; // Don't end response yet — waiting for body

  } else if (parsedUrl.pathname === '/ip-bans' && req.method === 'DELETE') {
    // Admin: remove IP ban by index or value
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const bans = loadIpBans();
        let removed = null;

        if (data.index !== undefined) {
          const idx = parseInt(data.index, 10);
          if (idx >= 0 && idx < bans.length) {
            removed = bans.splice(idx, 1)[0];
          }
        } else if (data.value) {
          const idx = bans.findIndex(b => b.value === data.value);
          if (idx >= 0) {
            removed = bans.splice(idx, 1)[0];
          }
        }

        if (removed) {
          saveIpBans(bans);
          logSessionEvent('IP_BAN_REMOVED', { type: removed.type, value: removed.value });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, removed, total: bans.length }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Ban not found' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });
    return;

  } else if (parsedUrl.pathname === '/admin/user' && req.method === 'GET') {
    // Authoritative read of a SINGLE user from the DB.
    // Lookup by id, username (case-insensitive), or email (case-insensitive).
    // Used by IONOS PHP (auth.php's findUserById/Username/Email) so login,
    // ban check, wizard check etc. read DB instead of users_index.json.
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    const params = new URLSearchParams(parsedUrl.query || '');
    const userId = params.get('id');
    const username = params.get('username');
    const email = params.get('email');
    if (!userId && !username && !email) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'id, username, or email required' }));
      return;
    }
    if (!wmtDb) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'DB not available' }));
      return;
    }
    try {
      let row = null;
      if (userId) {
        row = wmtDb.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      } else if (username) {
        row = wmtDb.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);
      } else if (email) {
        row = wmtDb.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)').get(email);
      }
      if (!row) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, user: null }));
        return;
      }
      const user = {
        id: row.id,
        username: row.username,
        email: row.email || '',
        password: row.password || '',
        isWizard: row.is_wizard === 1,
        banned: row.banned === 1,
        ban_reason: row.ban_reason || '',
        created_at: row.created_at || '',
        last_login: row.last_login || '',
        last_ip: row.last_ip || ''
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, user }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;

  } else if (parsedUrl.pathname === '/admin/users' && req.method === 'GET') {
    // Full user index from DB. Mirrors loadUsersIndex(). Used by admin
    // panels and code paths that iterate all users.
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    if (!wmtDb) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'DB not available' }));
      return;
    }
    try {
      const rows = wmtDb.prepare('SELECT * FROM users ORDER BY created_at').all();
      const users = rows.map(r => ({
        id: r.id,
        username: r.username,
        email: r.email || '',
        password: r.password || '',
        isWizard: r.is_wizard === 1,
        banned: r.banned === 1,
        ban_reason: r.ban_reason || '',
        created_at: r.created_at || '',
        last_login: r.last_login || '',
        last_ip: r.last_ip || ''
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, users }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;

  } else if (parsedUrl.pathname === '/admin/triggers' && req.method === 'GET') {
    // Authoritative read of triggers for a character. Used by IONOS PHP
    // (api/triggers.php?action=list) so the browser sees DB state on init.
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    const triggersParams = new URLSearchParams(parsedUrl.query || '');
    const characterId = triggersParams.get('characterId');
    if (!characterId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'characterId required' }));
      return;
    }
    if (!wmtDb) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'DB not available' }));
      return;
    }
    try {
      const triggers = dbLoadTriggers(characterId) || [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, triggers }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;

  } else if (parsedUrl.pathname === '/admin/classes' && req.method === 'GET') {
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    const classesParams = new URLSearchParams(parsedUrl.query || '');
    const characterId = classesParams.get('characterId');
    if (!characterId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'characterId required' }));
      return;
    }
    if (!wmtDb) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'DB not available' }));
      return;
    }
    try {
      const rows = dbStmts.getClasses.all(characterId);
      const classes = rows.map(r => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled === 1
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, classes }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;

  } else if (parsedUrl.pathname === '/admin/tickers' && req.method === 'GET') {
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    const tickersParams = new URLSearchParams(parsedUrl.query || '');
    const characterId = tickersParams.get('characterId');
    if (!characterId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'characterId required' }));
      return;
    }
    if (!wmtDb) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'DB not available' }));
      return;
    }
    try {
      const tickers = dbLoadTickers(characterId) || [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, tickers }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;

  } else if (parsedUrl.pathname === '/admin/preferences' && req.method === 'GET') {
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    const prefsParams = new URLSearchParams(parsedUrl.query || '');
    const characterId = prefsParams.get('characterId');
    if (!characterId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'characterId required' }));
      return;
    }
    if (!wmtDb) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'DB not available' }));
      return;
    }
    try {
      const row = dbStmts.getPreferences.get(characterId);
      let preferences = {};
      if (row && row.data) {
        try { preferences = JSON.parse(row.data); } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, preferences }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;

  } else if (parsedUrl.pathname === '/admin/aliases' && req.method === 'GET') {
    // Authoritative read of aliases for a character. Used by IONOS PHP
    // (api/aliases.php?action=list) so the browser sees DB state on page load
    // instead of the legacy aliases.json mirror — which is what made the
    // /admin/alias fix invisible across hard refreshes before this endpoint
    // existed.
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    const aliasesParams = new URLSearchParams(parsedUrl.query || '');
    const characterId = aliasesParams.get('characterId');
    if (!characterId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'characterId required' }));
      return;
    }
    if (!wmtDb) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'DB not available' }));
      return;
    }
    try {
      const rows = wmtDb.prepare(
        'SELECT id, pattern, replacement, match_type, priority, enabled, class_id FROM aliases WHERE character_id=? ORDER BY rowid'
      ).all(characterId);
      const aliases = rows.map(r => ({
        id: r.id,
        pattern: r.pattern,
        replacement: r.replacement,
        matchType: r.match_type || 'exact',
        priority: r.priority ?? 5,
        enabled: r.enabled === 1,
        class: r.class_id || null
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, aliases }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;

  } else if (parsedUrl.pathname === '/admin/alias' && req.method === 'POST') {
    // Admin: directly update one alias row in the DB and propagate to any
    // live session for that character. Solves the "I edit the DB, the user's
    // browser bulk_replace clobbers it 30s later" race that previously made
    // out-of-band fixes fragile. The stale-write guard keyed off
    // serverModifiedAliases takes care of the bulk_replace race.
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { characterId, aliasId, replacement } = data;
        if (!characterId || !aliasId || typeof replacement !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'characterId, aliasId, replacement required' }));
          return;
        }
        if (!wmtDb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'DB not available' }));
          return;
        }
        const before = wmtDb.prepare('SELECT * FROM aliases WHERE id=? AND character_id=?').get(aliasId, characterId);
        if (!before) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Alias not found for character' }));
          return;
        }
        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
        wmtDb.transaction(() => {
          wmtDb.prepare('UPDATE aliases SET replacement=?, updated_at=? WHERE id=? AND character_id=?')
            .run(replacement, now, aliasId, characterId);
          dbLogChange(
            characterId, 'aliases', 'update',
            JSON.stringify({ id: aliasId, replacement: before.replacement }),
            JSON.stringify({ id: aliasId, replacement }),
            'admin_api'
          );
        })();

        markAliasServerModified(characterId, aliasId, before.replacement, replacement);

        // Update in-memory aliases for any live session(s) on this character so
        // the next trigger/alias firing uses the new body without a refresh.
        let livePushed = 0;
        for (const [, session] of sessions) {
          if (session.characterId === characterId) {
            const arr = session.aliases || [];
            const idx = arr.findIndex(a => a && a.id === aliasId);
            if (idx >= 0) {
              arr[idx] = { ...arr[idx], replacement };
              session.aliases = arr;
              livePushed++;
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          aliasId, characterId,
          before: before.replacement,
          after: replacement,
          livePushed,
          updatedAt: now
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;

  } else if (parsedUrl.pathname === '/admin/trigger' && req.method === 'POST') {
    // Update one trigger row. Accepts partial update — pass only the fields
    // you want to change. characterId + triggerId required.
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 200000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { characterId, triggerId } = data;
        if (!characterId || !triggerId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'characterId, triggerId required' }));
          return;
        }
        if (!wmtDb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'DB not available' }));
          return;
        }
        const before = wmtDb.prepare('SELECT * FROM triggers WHERE id=? AND character_id=?').get(triggerId, characterId);
        if (!before) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Trigger not found for character' }));
          return;
        }
        const next = {
          pattern: data.pattern !== undefined ? data.pattern : before.pattern,
          match_type: data.matchType !== undefined ? data.matchType : before.match_type,
          actions: data.actions !== undefined ? JSON.stringify(data.actions) : before.actions,
          priority: data.priority !== undefined ? data.priority : before.priority,
          enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : before.enabled,
          class_id: data.class !== undefined ? (data.class || null) : before.class_id,
          name: data.name !== undefined ? data.name : before.name,
          oneshot: data.oneshot !== undefined ? (data.oneshot ? 1 : 0) : before.oneshot,
          block_start: data.blockStart !== undefined ? (data.blockStart || null) : (before.block_start || null),
          block_end:   data.blockEnd   !== undefined ? (data.blockEnd   || null) : (before.block_end   || null),
        };
        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
        wmtDb.transaction(() => {
          wmtDb.prepare(`UPDATE triggers SET pattern=?, match_type=?, actions=?, priority=?, enabled=?, class_id=?, name=?, oneshot=?, block_start=?, block_end=?, updated_at=? WHERE id=? AND character_id=?`)
            .run(next.pattern, next.match_type, next.actions, next.priority, next.enabled, next.class_id, next.name, next.oneshot, next.block_start, next.block_end, now, triggerId, characterId);
          dbLogChange(characterId, 'triggers', 'update',
            JSON.stringify(before), JSON.stringify({ id: triggerId, ...next }), 'admin_api');
        })();

        // Stale-write guard: record the before/after row so a subsequent
        // bulk_replace from the browser carrying the OLD trigger content
        // can't undo this admin edit. The guard clears once the browser
        // catches up (observation-based, not time-based).
        markGuarded('triggers', characterId, triggerId,
          {
            pattern: before.pattern,
            matchType: before.match_type,
            actions: (() => { try { return JSON.parse(before.actions); } catch { return []; } })(),
            priority: before.priority,
            enabled: before.enabled === 1,
            class: before.class_id,
            name: before.name,
            oneshot: before.oneshot === 1,
            blockStart: before.block_start || null,
            blockEnd:   before.block_end   || null,
          },
          {
            pattern: next.pattern,
            matchType: next.match_type,
            actions: (() => { try { return JSON.parse(next.actions); } catch { return []; } })(),
            priority: next.priority,
            enabled: next.enabled === 1,
            class: next.class_id,
            name: next.name,
            oneshot: next.oneshot === 1,
            blockStart: next.block_start,
            blockEnd:   next.block_end,
          }
        );

        // Update in-memory session.triggers for live sessions
        let livePushed = 0;
        for (const [, session] of sessions) {
          if (session.characterId === characterId) {
            const arr = session.triggers || [];
            const idx = arr.findIndex(t => t && t.id === triggerId);
            if (idx >= 0) {
              arr[idx] = {
                id: triggerId,
                pattern: next.pattern,
                matchType: next.match_type,
                actions: JSON.parse(next.actions),
                priority: next.priority,
                enabled: next.enabled === 1,
                class: next.class_id,
                name: next.name,
                oneshot: next.oneshot === 1,
                blockStart: next.block_start,
                blockEnd:   next.block_end,
              };
              session.triggers = arr;
              livePushed++;
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, triggerId, characterId, livePushed, updatedAt: now }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;

  } else if (parsedUrl.pathname === '/admin/class' && req.method === 'POST') {
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { characterId, classId } = data;
        if (!characterId || !classId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'characterId, classId required' }));
          return;
        }
        if (!wmtDb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'DB not available' }));
          return;
        }
        const before = wmtDb.prepare('SELECT * FROM classes WHERE id=? AND character_id=?').get(classId, characterId);
        if (!before) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Class not found for character' }));
          return;
        }
        const nextName = data.name !== undefined ? data.name : before.name;
        const nextEnabled = data.enabled !== undefined ? (data.enabled ? 1 : 0) : before.enabled;
        wmtDb.transaction(() => {
          wmtDb.prepare('UPDATE classes SET name=?, enabled=? WHERE id=? AND character_id=?')
            .run(nextName, nextEnabled, classId, characterId);
          dbLogChange(characterId, 'classes', 'update',
            JSON.stringify(before),
            JSON.stringify({ id: classId, name: nextName, enabled: nextEnabled === 1 }),
            'admin_api');
        })();

        // Stale-write guard for the class
        markGuarded('classes', characterId, classId,
          { name: before.name, enabled: before.enabled === 1 },
          { name: nextName,    enabled: nextEnabled === 1   }
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, classId, characterId }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;

  } else if (parsedUrl.pathname === '/admin/ticker' && req.method === 'POST') {
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { characterId, tickerId } = data;
        if (!characterId || !tickerId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'characterId, tickerId required' }));
          return;
        }
        if (!wmtDb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'DB not available' }));
          return;
        }
        const before = wmtDb.prepare('SELECT * FROM tickers WHERE id=? AND character_id=?').get(tickerId, characterId);
        if (!before) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Ticker not found for character' }));
          return;
        }
        const next = {
          name: data.name !== undefined ? data.name : before.name,
          command: data.command !== undefined ? data.command : before.command,
          interval_seconds: data.interval !== undefined ? data.interval : before.interval_seconds,
          class_id: data.class !== undefined ? (data.class || null) : before.class_id,
          enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : before.enabled,
        };
        wmtDb.transaction(() => {
          wmtDb.prepare('UPDATE tickers SET name=?, command=?, interval_seconds=?, class_id=?, enabled=? WHERE id=? AND character_id=?')
            .run(next.name, next.command, next.interval_seconds, next.class_id, next.enabled, tickerId, characterId);
          dbLogChange(characterId, 'tickers', 'update',
            JSON.stringify(before),
            JSON.stringify({ id: tickerId, ...next }),
            'admin_api');
        })();

        // Stale-write guard for the ticker
        markGuarded('tickers', characterId, tickerId,
          { command: before.command, interval: before.interval_seconds, name: before.name, enabled: before.enabled === 1, class: before.class_id },
          { command: next.command,   interval: next.interval_seconds,   name: next.name,   enabled: next.enabled === 1,   class: next.class_id   }
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, tickerId, characterId }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;

  } else if (parsedUrl.pathname === '/admin/preferences' && req.method === 'POST') {
    // Merge-update preferences blob. Body: { characterId, merge: {key: value, ...} }
    // OR { characterId, replace: {entire blob} }.
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { characterId, merge, replace } = data;
        if (!characterId || (!merge && !replace)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'characterId and (merge or replace) required' }));
          return;
        }
        if (!wmtDb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'DB not available' }));
          return;
        }
        const beforeRow = wmtDb.prepare('SELECT data FROM preferences WHERE character_id=?').get(characterId);
        let beforeBlob = {};
        try { beforeBlob = beforeRow ? JSON.parse(beforeRow.data || '{}') : {}; } catch {}
        const nextBlob = replace ? replace : { ...beforeBlob, ...merge };
        wmtDb.transaction(() => {
          wmtDb.prepare('INSERT OR REPLACE INTO preferences (character_id, data) VALUES (?, ?)')
            .run(characterId, JSON.stringify(nextBlob));
          dbLogChange(characterId, 'preferences', 'update',
            JSON.stringify(beforeBlob), JSON.stringify(nextBlob), 'admin_api');
        })();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, characterId, keysAfter: Object.keys(nextBlob).length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;

  } else if (parsedUrl.pathname === '/admin/user' && req.method === 'POST') {
    // Update one user record. Accepts partial update.
    // Body: { id, username?, email?, password?, isWizard?, banned?, ban_reason? }
    // Note: this is for ADMIN edits (ban/wizard toggle, manual fixes). Login-time
    // last_login updates still go through /account-sync as before.
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { id } = data;
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'id required' }));
          return;
        }
        if (!wmtDb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'DB not available' }));
          return;
        }
        const before = wmtDb.prepare('SELECT * FROM users WHERE id=?').get(id);
        if (!before) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'User not found' }));
          return;
        }
        const next = {
          username: data.username !== undefined ? data.username : before.username,
          email: data.email !== undefined ? data.email : before.email,
          password: data.password !== undefined ? data.password : before.password,
          is_wizard: data.isWizard !== undefined ? (data.isWizard ? 1 : 0) : before.is_wizard,
          banned: data.banned !== undefined ? (data.banned ? 1 : 0) : before.banned,
          ban_reason: data.ban_reason !== undefined ? data.ban_reason : before.ban_reason,
        };
        wmtDb.transaction(() => {
          wmtDb.prepare('UPDATE users SET username=?, email=?, password=?, is_wizard=?, banned=?, ban_reason=? WHERE id=?')
            .run(next.username, next.email, next.password, next.is_wizard, next.banned, next.ban_reason, id);
          // Use change_log even though character_id is null — table_name='users' makes it findable
          try {
            wmtDb.prepare(`INSERT INTO change_log (character_id, table_name, item_id, action, old_data, new_data, source, created_at) VALUES (?,?,?,?,?,?,?, datetime('now'))`)
              .run(null, 'users', id, 'update', JSON.stringify(before), JSON.stringify({ id, ...next }), 'admin_api');
          } catch {}
        })();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, id }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;

  } else if (parsedUrl.pathname === '/admin/aliases-bulk' && req.method === 'POST') {
    // Full-list bulk replace for aliases. Mirrors WS set_aliases / dbSaveAliases.
    // Used by PHP aliases.php save handlers so JSON-side writes also reach DB.
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5_000_000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { characterId, aliases } = data;
        if (!characterId || !Array.isArray(aliases)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'characterId and aliases[] required' }));
          return;
        }
        if (!wmtDb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'DB not available' }));
          return;
        }
        wmtDb.transaction(() => {
          const oldRows = dbStmts.getAliases.all(characterId);
          const oldData = oldRows.length > 0 ? JSON.stringify(oldRows) : null;
          dbStmts.deleteAliases.run(characterId);
          for (const a of aliases) {
            dbStmts.insertAlias.run(
              a.id || null, characterId,
              a.pattern || '', a.replacement || '',
              a.matchType || 'exact', a.priority ?? 5,
              a.enabled !== false ? 1 : 0, a.class || null
            );
          }
          dbLogChange(characterId, 'aliases', 'bulk_replace', oldData, JSON.stringify(aliases), 'php_save');
        })();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, characterId, count: aliases.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;

  } else if (parsedUrl.pathname === '/admin/triggers-bulk' && req.method === 'POST') {
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5_000_000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        let { characterId, triggers } = data;
        if (!characterId || !Array.isArray(triggers)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'characterId and triggers[] required' }));
          return;
        }
        if (!wmtDb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'DB not available' }));
          return;
        }
        // Stale-write guard for PHP-fed bulk pushes too — same DB, same risk
        const guardResult = applyGuard('triggers', characterId, triggers);
        if (guardResult.overridden || guardResult.cleared || guardResult.reinserted || guardResult.tombstoned) {
          console.log(`TRIGGER_GUARD(php_bulk) char=${characterId} overrode=${guardResult.overridden} cleared=${guardResult.cleared} reinserted=${guardResult.reinserted} tombstoned=${guardResult.tombstoned}`);
        }
        triggers = guardResult.list;
        wmtDb.transaction(() => {
          const oldRows = dbStmts.getTriggers.all(characterId);
          const oldData = oldRows.length > 0 ? JSON.stringify(oldRows) : null;
          dbStmts.deleteTriggers.run(characterId);
          for (const t of triggers) {
            dbStmts.insertTrigger.run(
              t.id || null, characterId,
              t.pattern || '', t.matchType || 'tintin',
              JSON.stringify(t.actions || []), t.priority ?? 5,
              t.enabled !== false ? 1 : 0, t.class || null,
              t.name || null, t.oneshot ? 1 : 0,
              t.blockStart || null, t.blockEnd || null
            );
          }
          dbLogChange(characterId, 'triggers', 'bulk_replace', oldData, JSON.stringify(triggers), 'php_save');
        })();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, characterId, count: triggers.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;

  } else if (parsedUrl.pathname === '/admin/tickers-bulk' && req.method === 'POST') {
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        let { characterId, tickers } = data;
        if (!characterId || !Array.isArray(tickers)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'characterId and tickers[] required' }));
          return;
        }
        if (!wmtDb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'DB not available' }));
          return;
        }
        const tkGuardResult = applyGuard('tickers', characterId, tickers);
        if (tkGuardResult.overridden || tkGuardResult.cleared || tkGuardResult.reinserted || tkGuardResult.tombstoned) {
          console.log(`TICKER_GUARD(php_bulk) char=${characterId} overrode=${tkGuardResult.overridden} cleared=${tkGuardResult.cleared} reinserted=${tkGuardResult.reinserted} tombstoned=${tkGuardResult.tombstoned}`);
        }
        tickers = tkGuardResult.list;
        wmtDb.transaction(() => {
          const oldRows = dbStmts.getTickers.all(characterId);
          const oldData = oldRows.length > 0 ? JSON.stringify(oldRows) : null;
          dbStmts.deleteTickers.run(characterId);
          for (const tk of tickers) {
            dbStmts.insertTicker.run(
              tk.id || null, characterId,
              tk.name || '', tk.command || '',
              tk.interval || 0, tk.class || null,
              tk.enabled !== false ? 1 : 0
            );
          }
          dbLogChange(characterId, 'tickers', 'bulk_replace', oldData, JSON.stringify(tickers), 'php_save');
        })();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, characterId, count: tickers.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;

  } else if (parsedUrl.pathname === '/admin/classes-bulk' && req.method === 'POST') {
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        let { characterId, classes } = data;
        if (!characterId || !Array.isArray(classes)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'characterId and classes[] required' }));
          return;
        }
        if (!wmtDb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'DB not available' }));
          return;
        }
        const clGuardResult = applyGuard('classes', characterId, classes);
        if (clGuardResult.overridden || clGuardResult.cleared || clGuardResult.reinserted || clGuardResult.tombstoned) {
          console.log(`CLASS_GUARD(php_bulk) char=${characterId} overrode=${clGuardResult.overridden} cleared=${clGuardResult.cleared} reinserted=${clGuardResult.reinserted} tombstoned=${clGuardResult.tombstoned}`);
        }
        classes = clGuardResult.list;
        wmtDb.transaction(() => {
          const oldRows = dbStmts.getClasses.all(characterId);
          const oldData = oldRows.length > 0 ? JSON.stringify(oldRows) : null;
          dbStmts.deleteClasses.run(characterId);
          const insStmt = wmtDb.prepare(`INSERT OR IGNORE INTO classes (id, character_id, name, enabled, created_at) VALUES (?, ?, ?, ?, datetime('now'))`);
          for (const cl of classes) {
            insStmt.run(cl.id || null, characterId, cl.name || '', cl.enabled !== false ? 1 : 0);
          }
          dbLogChange(characterId, 'classes', 'bulk_replace', oldData, JSON.stringify(classes), 'php_save');
        })();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, characterId, count: classes.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;

  } else if (parsedUrl.pathname === '/account-sync' && req.method === 'POST') {
    // Admin: sync account data from IONOS PHP to Lightsail DB.
    // Fire-and-forget from PHP — JSON stays primary, DB is the copy.
    // Back out plan: remove the PHP calls, DB stops updating, no impact.
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!wmtDb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'DB not available' }));
          return;
        }

        const action = data.action; // 'register', 'update', 'password_change', 'ban', 'login'
        const user = data.user;
        if (!user || !user.id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'user.id required' }));
          return;
        }

        switch (action) {
          case 'register':
            wmtDb.prepare(`
              INSERT OR IGNORE INTO users (id, username, email, password, is_wizard, created_at, last_login, last_ip)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(user.id, user.username, user.email || '', user.password || '', user.is_wizard ? 1 : 0, user.created_at || '', '', '');
            break;
          case 'update':
          case 'password_change':
            wmtDb.prepare(`
              UPDATE users SET username = ?, email = ?, password = ?, is_wizard = ?, last_login = ?, last_ip = ?
              WHERE id = ?
            `).run(user.username, user.email || '', user.password || '', user.is_wizard ? 1 : 0, user.last_login || '', user.last_ip || '', user.id);
            break;
          case 'ban':
            wmtDb.prepare('UPDATE users SET banned = ?, ban_reason = ? WHERE id = ?')
              .run(user.banned ? 1 : 0, user.ban_reason || '', user.id);
            break;
          case 'login':
            wmtDb.prepare('UPDATE users SET last_login = ?, last_ip = ? WHERE id = ?')
              .run(user.last_login || '', user.last_ip || '', user.id);
            break;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;

  } else if (parsedUrl.pathname === '/data-sync' && req.method === 'POST') {
    // Sync preferences/scripts from IONOS PHP to Lightsail DB.
    // Fire-and-forget from PHP — JSON/files stay primary, DB is the durable copy.
    const adminKey = req.headers['x-admin-key'];
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid admin key' }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 500000) req.destroy(); });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!wmtDb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'DB not available' }));
          return;
        }
        if (!data.character_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'character_id required' }));
          return;
        }

        switch (data.type) {
          case 'preferences':
            dbSavePreferences(data.character_id, data.data || {});
            break;
          case 'script':
            // Upsert a script file into DB
            if (!data.filename) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'filename required' }));
              return;
            }
            try {
              dbStmts.upsertScript.run(data.character_id, data.filename, data.content || '', data.content ? data.content.length : 0);
            } catch (e) {
              console.error('DB script save failed:', e.message);
            }
            break;
          case 'script_delete':
            if (!data.filename) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'filename required' }));
              return;
            }
            try {
              dbStmts.deleteScript.run(data.character_id, data.filename);
            } catch (e) {
              console.error('DB script delete failed:', e.message);
            }
            break;
          case 'script_rename':
            if (!data.old_filename || !data.new_filename) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'old_filename and new_filename required' }));
              return;
            }
            try {
              dbStmts.renameScript.run(data.new_filename, data.character_id, data.old_filename);
            } catch (e) {
              console.error('DB script rename failed:', e.message);
            }
            break;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;

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
    ws: null,  // Legacy — use wsClients Set for multi-device support
    wsClients: new Set(),  // All connected browser WebSockets
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
      roomVnum: 0,
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

    // IFTTT webhook key (per-user Maker key). Per-channel toggle lives in
    // discordChannelPrefs[channel].ifttt + optional .iftttEvent (defaults to "3K").
    iftttKey: '',

    // Server-side tickers
    tickers: [],           // Array of ticker objects
    tickerIntervals: {},   // Map of ticker id -> interval timer

    // ChatMon message buffer (persists across session resume)
    chatBuffer: [],

    // Packet patch: fixed-delay batching for complete lines (seconds, 0 = disabled)
    packetPatchMs: 1000,  // Default 1.0s
    patchQueue: [],
    patchTimeout: null,

    // Bot engine state
    bot: {
      active: false,
      paused: false,
      walking: false,
      inCombat: false,

      // Path
      path: [],
      step: 0,
      loop: false,

      // Mob targeting
      mobs: [],
      foundMob: null,

      // Player avoidance
      playerCheck: true,
      whitelist: [],

      // Timing
      killDelay: 500,
      moveDelay: 0,

      // Stats
      stats: { mobs: 0, startTime: null },

      // Room parsing state
      roomMobs: [],
      roomPlayers: [],

      // Saved aset state (restored on bot stop)
      savedAsets: null,

      // Stuck detection timer
      stuckTimer: null,

      // Kill delay timer
      killDelayTimer: null,

      // Bot name (for display)
      name: ''
    }
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
        // Handle #N repeat pattern: #34 {buy dagger;dismantle dagger}
        const repeatMatch = cmd.match(/^#(\d+)\s+(.+)$/);
        if (repeatMatch) {
          executeRepeat(Math.min(parseInt(repeatMatch[1]), 100), repeatMatch[2], session);
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

// ─── Bot Engine ──────────────────────────────────────────────

/**
 * Send bot status update to client
 */
function sendBotStatus(session) {
  const bot = session.bot;
  sendToClient(session, {
    type: 'bot_status',
    active: bot.active,
    paused: bot.paused,
    step: bot.step,
    totalSteps: bot.path.length,
    inCombat: bot.inCombat,
    stats: bot.stats,
    foundMob: bot.foundMob,
    name: bot.name
  });
}

/**
 * Start the bot with given configuration
 */
function botStart(session, config) {
  const bot = session.bot;

  if (!session.mudSocket || session.mudSocket.destroyed) {
    sendToClient(session, { type: 'bot_error', message: 'Not connected to MUD' });
    return;
  }

  // Parse path string into array of directions
  let path = config.path;
  if (typeof path === 'string') {
    path = path.split(/[;\s]+/).filter(d => d.length > 0);
  }
  if (!path || path.length === 0) {
    sendToClient(session, { type: 'bot_error', message: 'No path defined' });
    return;
  }

  bot.active = true;
  bot.paused = false;
  bot.walking = false;
  bot.inCombat = false;
  bot.path = path;
  bot.step = config.startStep || 0;
  bot.loop = config.loop || false;
  bot.mobs = config.mobs || [];
  bot.foundMob = null;
  bot.playerCheck = config.playerCheck !== false;
  bot.whitelist = (config.whitelist || []).map(n => n.toLowerCase());
  bot.killDelay = Math.max(0, Math.min(10000, (config.killDelay || 0.5) * 1000));
  bot.moveDelay = Math.max(0, Math.min(5000, (config.moveDelay || 0) * 1000));
  bot.stats = { mobs: 0, startTime: Date.now() };
  bot.roomMobs = [];
  bot.roomPlayers = [];
  bot.name = config.name || 'Custom Bot';

  // Send aset commands to configure room parsing markers
  const asetCmds = [
    'aset look_monster_pref -M-_',
    'aset look_player -P-_',
    'aset room_short_pref -R-_',
    'aset room_short_suff _-R-',
    'aset room_exits_pref -X-_',
    'aset room_exits_suff _-X-'
  ];
  asetCmds.forEach(cmd => {
    session.mudSocket.write(cmd + '\r\n');
  });

  // Start stuck detection timer
  botStartStuckTimer(session);

  console.log(`Bot started: "${bot.name}" path=${bot.path.length} steps, mobs=${bot.mobs.length}`);
  sendBotStatus(session);

  // Send first move after a short delay for aset commands to process
  setTimeout(() => {
    if (bot.active && !bot.paused) {
      botSendGlance(session);
    }
  }, 500);
}

/**
 * Stop the bot
 */
function botStop(session) {
  const bot = session.bot;
  const wasActive = bot.active;

  // Clear timers
  if (bot.stuckTimer) {
    clearInterval(bot.stuckTimer);
    bot.stuckTimer = null;
  }
  if (bot.killDelayTimer) {
    clearTimeout(bot.killDelayTimer);
    bot.killDelayTimer = null;
  }

  const stats = { ...bot.stats };
  if (stats.startTime) {
    stats.elapsed = Date.now() - stats.startTime;
  }

  bot.active = false;
  bot.paused = false;
  bot.walking = false;
  bot.inCombat = false;
  bot.foundMob = null;
  bot.roomMobs = [];
  bot.roomPlayers = [];

  if (wasActive) {
    // Restore aset defaults
    if (session.mudSocket && !session.mudSocket.destroyed) {
      const resetCmds = [
        'aset look_monster_pref',
        'aset look_player',
        'aset room_short_pref',
        'aset room_short_suff',
        'aset room_exits_pref',
        'aset room_exits_suff'
      ];
      resetCmds.forEach(cmd => {
        session.mudSocket.write(cmd + '\r\n');
      });
    }
    console.log(`Bot stopped: "${bot.name}" killed=${stats.mobs}`);
    sendToClient(session, { type: 'bot_complete', stats: stats });
  }

  sendBotStatus(session);
}

/**
 * Pause the bot (preserves position)
 */
function botPause(session) {
  const bot = session.bot;
  if (!bot.active) return;
  bot.paused = true;
  console.log(`Bot paused at step ${bot.step}/${bot.path.length}`);
  sendBotStatus(session);
}

/**
 * Resume the bot from paused state
 */
function botResume(session) {
  const bot = session.bot;
  if (!bot.active || !bot.paused) return;
  bot.paused = false;
  console.log(`Bot resumed at step ${bot.step}/${bot.path.length}`);
  sendBotStatus(session);
  // Re-scan current room
  botSendGlance(session);
}

/**
 * Send glance command to scan room
 */
function botSendGlance(session) {
  if (session.mudSocket && !session.mudSocket.destroyed) {
    session.mudSocket.write('glance\r\n');
  }
}

/**
 * Advance to next step in the bot path and move
 */
function botAdvanceStep(session) {
  const bot = session.bot;
  if (!bot.active || bot.paused) return;

  bot.step++;

  if (bot.step >= bot.path.length) {
    if (bot.loop) {
      bot.step = 0;
      console.log(`Bot looping path from start`);
    } else {
      // Path complete
      botStop(session);
      return;
    }
  }

  bot.walking = true;
  bot.roomMobs = [];
  bot.roomPlayers = [];
  bot.foundMob = null;

  const direction = bot.path[bot.step];
  const delay = bot.moveDelay || 0;

  const doMove = () => {
    if (!bot.active || bot.paused) return;
    if (session.mudSocket && !session.mudSocket.destroyed) {
      session.mudSocket.write(direction + '\r\n');
    }
    sendBotStatus(session);
  };

  if (delay > 0) {
    setTimeout(doMove, delay);
  } else {
    doMove();
  }
}

/**
 * Process a line of MUD output for bot markers.
 * Called from processLine ONLY when bot is active.
 * Returns true if the line was a bot marker (should be gagged from display).
 */
function botProcessLine(session, strippedLine) {
  const bot = session.bot;
  if (!bot.active) return false;

  // Room short marker: -R-_..._-R-
  if (strippedLine.startsWith('-R-_') && strippedLine.endsWith('_-R-')) {
    // New room detected — clear room state
    bot.roomMobs = [];
    bot.roomPlayers = [];
    bot.foundMob = null;
    bot.walking = false;
    bot.inCombat = false;
    return true;
  }

  // Mob marker: -M-_...
  if (strippedLine.startsWith('-M-_')) {
    const mobName = strippedLine.substring(4).trim();
    bot.roomMobs.push(mobName);

    // Check if this mob matches any target pattern
    for (const mob of bot.mobs) {
      if (mobName.toLowerCase().includes(mob.pattern.toLowerCase())) {
        bot.foundMob = mob.target || mob.pattern;
        break;
      }
    }
    return true;
  }

  // Player marker: -P-_...
  if (strippedLine.startsWith('-P-_')) {
    const playerName = strippedLine.substring(4).trim();
    bot.roomPlayers.push(playerName);
    return true;
  }

  // Exit marker: -X-_..._-X- — always the LAST line of room display.
  // Use it as the room-complete signal to determine bot action.
  if (strippedLine.startsWith('-X-_')) {
    setImmediate(() => botDetermineAction(session));
    return true;
  }

  // Fallback prompt detection (> at start of line)
  if (/^>\s*$/.test(strippedLine)) {
    botDetermineAction(session);
    return false; // Don't gag the prompt
  }

  // Kill detection: "dealt the killing blow"
  if (bot.inCombat && strippedLine.includes('dealt the killing blow')) {
    bot.inCombat = false;
    bot.stats.mobs++;
    sendBotStatus(session);

    // After kill, wait killDelay then re-scan room
    if (bot.killDelayTimer) clearTimeout(bot.killDelayTimer);
    bot.killDelayTimer = setTimeout(() => {
      bot.killDelayTimer = null;
      if (bot.active && !bot.paused) {
        botSendGlance(session);
      }
    }, bot.killDelay);
    return false; // Don't gag the kill message
  }

  return false;
}

/**
 * Decide what the bot should do based on room state.
 * Called when prompt is received (room fully loaded).
 */
function botDetermineAction(session) {
  const bot = session.bot;
  if (!bot.active || bot.paused || bot.inCombat) return;

  // Check for non-whitelisted players
  if (bot.playerCheck && bot.roomPlayers.length > 0) {
    const dangerousPlayers = bot.roomPlayers.filter(
      p => !bot.whitelist.includes(p.toLowerCase())
    );
    if (dangerousPlayers.length > 0) {
      // Skip room — player present
      console.log(`Bot: skipping room (players: ${dangerousPlayers.join(', ')})`);
      botAdvanceStep(session);
      return;
    }
  }

  // Check for target mob
  if (bot.foundMob) {
    bot.inCombat = true;
    if (session.mudSocket && !session.mudSocket.destroyed) {
      session.mudSocket.write('kill ' + bot.foundMob + '\r\n');
    }
    sendBotStatus(session);
    return;
  }

  // No mob found, advance to next step
  botAdvanceStep(session);
}

/**
 * Start stuck detection timer
 */
function botStartStuckTimer(session) {
  const bot = session.bot;
  if (bot.stuckTimer) {
    clearInterval(bot.stuckTimer);
  }
  bot.stuckTimer = setInterval(() => {
    if (bot.active && !bot.paused && !bot.walking && !bot.inCombat) {
      // Might be stuck — re-scan
      botSendGlance(session);
    }
  }, 5000);
}

/**
 * Update bot configuration while running
 */
function botUpdateConfig(session, config) {
  const bot = session.bot;
  if (config.killDelay !== undefined) {
    bot.killDelay = Math.max(0, Math.min(10000, config.killDelay * 1000));
  }
  if (config.moveDelay !== undefined) {
    bot.moveDelay = Math.max(0, Math.min(5000, config.moveDelay * 1000));
  }
  if (config.playerCheck !== undefined) {
    bot.playerCheck = config.playerCheck;
  }
  if (config.whitelist !== undefined) {
    bot.whitelist = config.whitelist.map(n => n.toLowerCase());
  }
  if (config.loop !== undefined) {
    bot.loop = config.loop;
  }
  sendBotStatus(session);
}

// ─── End Bot Engine ──────────────────────────────────────────

/**
 * Send a message to the browser, or buffer it if disconnected
 * Buffer keeps the MOST RECENT lines - old lines are dropped when full
 */
/**
 * Broadcast chat replay to all connected browsers WITHOUT re-buffering or re-inserting.
 * Using sendToClient() for replay would push each message back into chatBuffer and
 * write it to the DB again, causing the history to multiply on every reconnect.
 */
function broadcastChatReplay(session, message) {
  const jsonMsg = JSON.stringify(message);
  for (const clientWs of session.wsClients) {
    if (clientWs.readyState === WebSocket.OPEN) {
      try { clientWs.send(jsonMsg); } catch (e) {
        session.wsClients.delete(clientWs);
      }
    }
  }
}

function sendToClient(session, message, targetWs) {
  // client_command messages cause the browser to execute code (e.g. #send, #delay,
  // #class read) which sends commands back to the server. On multi-device sessions,
  // broadcasting to ALL browsers would cause double-execution. Send to only ONE:
  // the originating ws (if provided via targetWs or session._cmdTargetWs), or
  // the first active ws as fallback.
  if (message.type === 'client_command') {
    const jsonMsg = JSON.stringify(message);
    const preferred = targetWs || session._cmdTargetWs;
    if (preferred && preferred.readyState === WebSocket.OPEN) {
      try { preferred.send(jsonMsg); return; } catch (e) {
        session.wsClients.delete(preferred);
      }
    }
    // Fallback: first active ws
    for (const clientWs of session.wsClients) {
      if (clientWs.readyState === WebSocket.OPEN) {
        try { clientWs.send(jsonMsg); return; } catch (e) {
          session.wsClients.delete(clientWs);
        }
      }
    }
    // No connected browsers — buffer
    session.buffer.push(message);
    if (session.buffer.length > SESSION_BUFFER_MAX_LINES) {
      const dropped = session.buffer.length - SESSION_BUFFER_MAX_LINES;
      session.buffer = session.buffer.slice(dropped);
      if (!session.bufferOverflow) session.bufferOverflow = true;
    }
    return;
  }

  // Buffer ChatMon messages for replay on session resume
  if (message.type === 'mip_chat' || message.type === 'trigger_chatmon') {
    session.chatBuffer.push(message);
    if (session.chatBuffer.length > CHAT_BUFFER_MAX) {
      session.chatBuffer.shift();
    }
    // Persist to DB for long-term chat history
    if (wmtDb && session.characterId) {
      try {
        const channel = message.channel || '';
        const sender = message.sender || '';
        const text = message.text || message.message || '';
        dbStmts.insertChat.run(session.characterId, channel, sender, text, JSON.stringify(message));
      } catch (e) {
        // Non-fatal — don't let chat logging break the message flow
      }
    }
  }

  // Broadcast to ALL connected browsers (multi-device support).
  // If no browsers are connected, buffer for replay on reconnect.
  const jsonMsg = JSON.stringify(message);
  let sent = false;
  for (const clientWs of session.wsClients) {
    if (clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.send(jsonMsg);
        sent = true;
      } catch (e) {
        // Individual client send failure — remove stale WS
        session.wsClients.delete(clientWs);
      }
    } else {
      session.wsClients.delete(clientWs);
    }
  }
  if (!sent) {
    // No connected browsers — buffer the message
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
  if (session.wsClients.size === 0) return;

  const bufferCopy = [...session.buffer];
  const hadOverflow = session.bufferOverflow;
  session.buffer = [];
  session.bufferOverflow = false;

  console.log(`Replaying ${bufferCopy.length} buffered messages to ${session.wsClients.size} client(s)${hadOverflow ? ' (older content truncated)' : ''}`);

  sendToClient(session, {
    type: 'system',
    message: hadOverflow
      ? `--- Reconnected. Showing last ${bufferCopy.length} lines (older content truncated) ---`
      : `--- Reconnected. Replaying ${bufferCopy.length} buffered lines ---`
  });

  // Send in batches with delays to let browser DOM breathe
  const BATCH_SIZE = 25;
  const BATCH_DELAY_MS = 50;
  let index = 0;

  function sendBatch() {
    if (session.wsClients.size === 0) return;

    const end = Math.min(index + BATCH_SIZE, bufferCopy.length);
    for (let i = index; i < end; i++) {
      try {
        sendToClient(session, bufferCopy[i]);
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
        sendToClient(session, {
          type: 'system',
          message: '--- End of buffered content ---'
        });
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
    char: effectiveCharName(session),
    reason: reason,
    mudWasConnected: mudConnected,
    wizard: session.isWizard
  });
  writeSessionLog(session, 'session', { event: 'close', reason });

  // Login audit fallback: if the session got past the password prompt
  // (user successfully entered their password) but closed before they
  // typed any real command (fast #end, immediate browser close, idle-
  // then-timeout), fire the deferred login audit BEFORE the disconnect
  // audit so the row pair stays consistent. The _loginAuditPasswordEntered
  // gate makes sure we don't fire login for sessions that disconnected
  // mid-auth (never successfully entered a password).
  if (session._loginAuditPending && session._loginAuditPasswordEntered) {
    session._loginAuditPending = false;
    sendAuditLog('login', session, session.clientIp);
  }
  // Capture whether the session ever authenticated BEFORE clearing flags.
  // _loginAuditPending starts true at createSession and is cleared only
  // when a login or reconnect audit row fires. If it's still true here,
  // the user never got past the auth flow (or got kicked at password).
  const neverAuthenticated = session._loginAuditPending === true;
  // Always clear deferred-audit state — close event is about to fire anyway.
  session._loginAuditPending = false;
  session._loginAuditAtPasswordPrompt = false;
  session._loginAuditPasswordEntered = false;

  // Voluntary quit (sniffer detected the MUD's "band camp" goodbye line)
  // gets `logout`. A session that never authenticated gets NO disconnect
  // row — either login_failed already captured the failed attempt, or
  // nothing meaningful happened (user opened the app and closed it before
  // typing a name/password). Anything else — linkdeath, fast close,
  // browser close, idle timeout post-login — gets `disconnect`.
  if (session._loginAuditQuit) {
    session._loginAuditQuit = false;
    sendAuditLog('logout', session);
  } else if (!neverAuthenticated) {
    sendAuditLog('disconnect', session);
  }

  // Clear all pending #delay timers
  if (session._delays) {
    for (const name in session._delays) {
      clearTimeout(session._delays[name]);
    }
    session._delays = {};
  }

  // Clear all tickers
  clearAllTickers(session);

  // Stop bot if active
  if (session.bot && session.bot.active) {
    if (session.bot.stuckTimer) clearInterval(session.bot.stuckTimer);
    if (session.bot.killDelayTimer) clearTimeout(session.bot.killDelayTimer);
    session.bot.stuckTimer = null;
    session.bot.killDelayTimer = null;
    session.bot.active = false;
  }

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
 * Send map context to client when room changes.
 * Includes current room info + neighbors from map DB.
 */
function sendMapContext(session, vnum) {
  if (!mapDb) return;
  try {
    const room = mapStmts.getRoomByVnum.get(vnum);
    if (!room) return; // Vnum not in map DB

    // Don't resend if we're still in the same room
    if (session._lastMapVnum === vnum) return;
    session._lastMapVnum = vnum;

    const allNeighbors = mapStmts.getNeighborRooms.all(vnum);
    const allExits = mapStmts.getExitsByVnum.all(vnum);

    // Filter to only exits MIP confirms exist (strips mapper artifacts)
    const mipExitSet = new Set(
      (session.mipStats.exits || '').split(/,\s*/).map(e => e.trim().toLowerCase()).filter(Boolean)
    );
    const neighbors = allNeighbors.filter(n => mipExitSet.has(n.direction));
    const exits = allExits.filter(e => mipExitSet.has(e.direction));

    sendToClient(session, {
      type: 'map_context',
      room: {
        vnum: room.vnum,
        name: room.name,
        area: room.area,
        terrain: room.terrain
      },
      exits: exits.map(e => ({
        direction: e.direction,
        command: e.command,
        toVnum: e.to_vnum,
        weight: e.weight
      })),
      neighbors: neighbors.map(n => ({
        vnum: n.vnum,
        name: n.name,
        area: n.area,
        direction: n.direction,
        command: n.command
      }))
    });
  } catch (e) {
    // Non-fatal — map is informational
  }
}

/**
 * Name-based map lookup fallback when MIP doesn't send vnums.
 * Uses room name + exits to disambiguate.
 */
function sendMapContextByName(session, roomName, exitsStr) {
  if (!mapDb || !roomName) return;
  try {
    const candidates = mapStmts.getRoomByName.all(roomName);
    if (candidates.length === 0) return;

    let match = candidates[0]; // Default to first match
    if (candidates.length > 1 && exitsStr) {
      // Disambiguate by exit count/directions
      const mipExits = exitsStr.split(/,\s*/).sort().join(',');
      for (const c of candidates) {
        const dbExits = mapStmts.getExitsByVnum.all(c.vnum);
        const dbExitStr = dbExits.map(e => e.direction).sort().join(',');
        if (dbExitStr === mipExits) {
          match = c;
          break;
        }
      }
    }

    sendMapContext(session, match.vnum);
  } catch (e) {
    // Non-fatal
  }
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

    case 'BAD': {
      const rawRoom = msgData.trim();
      // Extract room vnum if present (MIP appends ~12345 to room name)
      const vnumMatch = rawRoom.match(/~(\d+)\s*$/);
      if (vnumMatch) {
        mipStats.roomVnum = parseInt(vnumMatch[1], 10);
      }
      mipStats.room = rawRoom.replace(/\s*\([^)]*\)?(~\d+)?\s*$/, '').trim();
      updated = true;
      // Debug: log raw BAD data for map development (Nathan only, temporary)
      if (session && MAP_ENABLED_USERS.has(session.userId)) {
        console.log(`[MAP-DEBUG] BAD raw="${rawRoom}" vnum=${mipStats.roomVnum} room="${mipStats.room}"`);
      }
      // Don't send map context here — DDD (exits) arrives after BAD.
      // If we send here, mipStats.exits still has the PREVIOUS room's exits.
      // Map context is triggered from DDD instead.
      break;
    }

    case 'DDD':
      mipStats.exits = msgData.replace(/~/g, ', ');
      updated = true;
      // Now both room name (from BAD) and exits (from DDD) are current.
      // Send map context with accurate exit filtering.
      if (mapDb && session && MAP_ENABLED_USERS.has(session.userId)) {
        if (mipStats.roomVnum) {
          sendMapContext(session, mipStats.roomVnum);
        } else {
          sendMapContextByName(session, mipStats.room, mipStats.exits);
        }
      }
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
        let isSentByUser = false;
        let isAfkReply = false;
        let babSender = '';
        if (parts[0] === '' && parts.length >= 3) {
          const sender = parts[1];
          babSender = sender;
          const message = parts.slice(2).join('~');
          // [you]: lines are soul/emote echoes — show in chatmon but skip Discord
          if (sender.toLowerCase() === 'you') {
            isSoulEcho = true;
          }
          // AFK auto-reply: when the user souls/tells someone who's AFK, the
          // MUD auto-replies with "[Sender]: is afk: <reason>". These aren't
          // real interactions — the AFK person didn't actually do anything —
          // so the suppressAfkAlerts preference can hide them from ChatMon
          // alerts (still shown in the chat panel). 2026-05-07.
          if (/^is afk:/i.test(stripAnsi(message).trim())) {
            isAfkReply = true;
          }
          formatted = `<span style="color:#ff8844">[${sender}]:</span> ${convertMipColors(message)}`;
          rawText = `[${sender}]: ${stripAnsi(message)}`;
        } else if (parts[0] === 'x' && parts.length >= 3) {
          const recipient = parts[1];
          const message = parts.slice(2).join('~');
          formatted = `<span style="color:#88ff88">[To ${recipient}]:</span> ${convertMipColors(message)}`;
          rawText = `[To ${recipient}]: ${stripAnsi(message)}`;
          isSentByUser = true;
        } else {
          formatted = convertMipColors(msgData);
          rawText = stripAnsi(msgData);
        }

        // Skip sending soul echoes ([you]:) to chatmon entirely —
        // the [To recipient]: line already covers it
        if (!isSoulEcho) {
          // Buffer the BAB message — the next line in the TCP chunk tells us
          // if this is a soul ("From afar, ...") or a regular tell.
          // processLine flushes this buffer before processing the next line.
          session._pendingBab = {
            formatted, rawText, raw: msgData,
            outbound: isSentByUser || undefined,
            sender: babSender,
            isAfkReply: isAfkReply || undefined
          };
          // Fallback: if no more lines arrive, flush as tell after 100ms
          if (session._pendingBabTimeout) clearTimeout(session._pendingBabTimeout);
          session._pendingBabTimeout = setTimeout(() => {
            if (session._pendingBab) {
              flushPendingBab(session, 'tell');
            }
          }, 100);
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
        // MIP CAA payload format: channel~ChannelDisplay~Speaker~MessageBody
        // parts[2] is the speaker name when present, otherwise empty.
        let sender = '';
        if (parts.length >= 4) {
          channel = parts[0];
          sender = parts[2] || '';
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
        const selfAuthored = isSelfAuthoredChat(session, { sender });
        const suppressAlert = !!(session.suppressSelfAlerts && selfAuthored);
        sendToClient(session, {
          type: 'mip_chat',
          chatType: 'channel',
          channel: channel,
          raw: msgData,
          rawText: rawText,
          message: formatted,
          sender: sender,
          suppressAlert: suppressAlert
        });

        // Server-side Discord notification (works even when browser is closed)
        if (rawText && channel && !suppressAlert) {
          const channelPrefs = session.discordChannelPrefs[channel] || session.discordChannelPrefs[channel.toLowerCase()];
          if (channelPrefs?.discord && channelPrefs?.webhookUrl) {
            logSessionEvent('DISCORD_SEND', {
              token: session.token.substring(0, 8),
              user: session.userId,
              char: effectiveCharName(session),
              channel: channel,
              messagePreview: rawText.substring(0, 50)
            });
            // Use captured MIP sender for the Discord display name when available.
            const discordName = sender || session.discordUsername;
            sendToDiscordWebhook(channelPrefs.webhookUrl, rawText, discordName);
          }
          if (channelPrefs?.ifttt && session.iftttKey) {
            const eventName = channelPrefs.iftttEvent || '3K';
            // Three structured values for the IFTTT applet to compose:
            //   value1 = speaker, value2 = channel/type, value3 = message body.
            const speaker = sender || effectiveCharName(session);
            const stripped = rawText.replace(/^\[[^\]]+\]\s*/, '');
            const colonIdx = stripped.indexOf(':');
            const body = colonIdx >= 0 ? stripped.slice(colonIdx + 1).trim() : stripped;
            sendToIfttt(session.iftttKey, eventName, speaker, channel, body);
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
          mipStats.gline1 = convertMipColors(value.replace(/;/g, ' '), false);
          break;
        case 'J':
          mipStats.gline2Raw = value;
          mipStats.gline2 = convertMipColors(value.replace(/;/g, ' '), false);
          break;
      }
      i += 2;
    } else {
      i++;
    }
  }

  mipStats.guildVars = parseGuildVars(mipStats.gline1Raw, mipStats.gline2Raw);

  // Bot: detect combat state via MIP round changes
  if (session.bot && session.bot.active) {
    if (mipStats.round > 0 && !session.bot.inCombat) {
      session.bot.inCombat = true;
      sendBotStatus(session);
    } else if (mipStats.round === 0 && session.bot.inCombat) {
      // Combat ended (mob died or fled) — handled by kill detection
    }
  }
}

/**
 * Process complete lines immediately.
 *
 * Historical note: this used to batch lines for `packetPatchMs` ms before processing,
 * intended to give "whole combat round appears at once" smoothness. In practice it
 * just added 1s of unconditional latency to every bot action (GA isn't reliably sent
 * by 3K, and `prompt off` kills it entirely). The only part of packet_patch that
 * actually matters is FRAGMENT REASSEMBLY (in the data handler's line buffer), which
 * is unaffected by this function. Complete lines always process immediately now.
 */
function queueLinesForProcessing(session, parts) {
  parts.forEach(line => processLine(session, line));
}

/**
 * Legacy flush hook — kept as a no-op so existing GA handling in data handlers still
 * compiles. There's nothing to flush anymore since queueLinesForProcessing doesn't batch.
 */
function flushPatchQueue(session) {
  // no-op
}

/**
 * Strip incomplete ANSI escape sequence from end of a fragment.
 * Called before flushing a held fragment that timed out waiting for continuation.
 * e.g., "You grant the blessing of \x1b[34;1" → "You grant the blessing of "
 */
function stripTrailingAnsi(text) {
  // Match an incomplete ANSI sequence at the end: ESC, or ESC[, or ESC[digits/semicolons (no closing 'm')
  return text.replace(/\x1b\[[0-9;]*$|\x1b$/, '');
}

/**
 * Flush a buffered BAB message as either 'tell' or 'soul' channel.
 * Called from processLine when we can inspect the next line for "From afar".
 */
function flushPendingBab(session, channel) {
  const bab = session._pendingBab;
  if (!bab) return;
  session._pendingBab = null;
  if (session._pendingBabTimeout) {
    clearTimeout(session._pendingBabTimeout);
    session._pendingBabTimeout = null;
  }

  // Self-authored = outbound tell/soul, or (theoretically) inbound where sender == self.
  // Real inbound self-tells are filtered as soul echoes earlier, but the helper handles both.
  const selfAuthored = isSelfAuthoredChat(session, { outbound: bab.outbound, sender: bab.sender });
  // suppressAfkAlerts: MUD's "[Sender]: is afk: <reason>" auto-reply when the
  // user souls/tells someone who's AFK. The AFK person didn't actually do
  // anything — no need to ding/Discord/IFTTT — but the message still appears
  // in the chat panel.
  const suppressAlert = !!(
    (session.suppressSelfAlerts && selfAuthored) ||
    (session.suppressAfkAlerts && bab.isAfkReply)
  );

  sendToClient(session, {
    type: 'mip_chat',
    chatType: channel === 'soul' ? 'soul' : 'tell',
    channel: channel,
    raw: bab.raw,
    rawText: bab.rawText,
    message: bab.formatted,
    outbound: bab.outbound,
    sender: bab.sender || '',
    suppressAlert: suppressAlert
  });

  // Server-side Discord notification — gate on self-authored when the user opted in.
  if (bab.rawText && !suppressAlert) {
    const channelPrefs = session.discordChannelPrefs[channel] || session.discordChannelPrefs['tell'];
    if (channelPrefs?.discord && channelPrefs?.webhookUrl) {
      logSessionEvent('DISCORD_SEND', {
        token: session.token.substring(0, 8),
        user: session.userId,
        char: effectiveCharName(session),
        channel: channel,
        messagePreview: bab.rawText.substring(0, 50)
      });
      sendToDiscordWebhook(channelPrefs.webhookUrl, bab.rawText, session.discordUsername);
    }
    // Skip outbound tells/souls — no point waking the phone for messages YOU sent.
    if (channelPrefs?.ifttt && session.iftttKey && !bab.outbound) {
      const eventName = channelPrefs.iftttEvent || '3K';
      // bab.rawText format is "[Sender]: message body". Three structured values:
      //   value1 = speaker, value2 = type ('tell' / 'soul'), value3 = message body.
      const m = bab.rawText.match(/^\[([^\]]+)\]:\s*(.*)$/);
      const speaker = m ? m[1] : effectiveCharName(session);
      const body = m ? m[2] : bab.rawText;
      sendToIfttt(session.iftttKey, eventName, speaker, channel, body);
    }
  }
}

/**
 * Process a single line from MUD
 */
// ────────────────────────────────────────────────────────────────────────
// Block triggers — buffer multi-line MUD output that's semantically one
// thing (e.g. ring identify) so triggers can match patterns spanning
// MUD-side line wraps. A trigger with both `blockStart` and `blockEnd`
// regexes becomes a block trigger: its `actions` run on the joined buffer
// when the end pattern is observed, then the (possibly modified) buffered
// lines are flushed to the client. Lines outside any block flow normally.
//
// Per-session state lives in session.activeBlocks: Map<triggerId, {lines, startedAt}>.
// Stale buffers (no end within BLOCK_TIMEOUT_MS) flush as-is on the next
// line arrival, so memory can't grow unbounded.
const BLOCK_TIMEOUT_MS = 5000;

function compileBlockRegex(pattern, useTinTin) {
  if (!pattern) return null;
  try {
    if (useTinTin) {
      // ~ prefix: strip and treat the rest as raw PCRE (matches the
      // existing ~ semantics in tinTinToRegex / processTriggers).
      if (pattern.startsWith('~')) {
        let rx = pattern.substring(1);
        // {} → () for capture groups, same as elsewhere
        rx = rx.replace(/\{/g, '(').replace(/\}/g, ')');
        return new RegExp(rx);
      }
      return new RegExp(tinTinToRegex(pattern));
    }
    return new RegExp(pattern);
  } catch (e) {
    console.warn(`block regex compile failed: ${pattern} — ${e.message}`);
    return null;
  }
}

function flushBlockTriggerBuffer(session, trigger, buffered) {
  // Apply each highlight action to the joined block. Other action types
  // (command, gag, etc.) are intentionally NOT applied here — block
  // triggers in this iteration are scoped to highlight only. Adding
  // command/gag for blocks would require deciding where the side-effect
  // happens (per-line? once for whole block?) and isn't needed for the
  // ring-identify case driving this build.
  let joined = buffered.join('\n');
  const matchRegex = compileBlockRegex(trigger.pattern, true);

  if (matchRegex) {
    for (const action of (trigger.actions || [])) {
      if (action.type !== 'highlight') continue;
      const fgColor = action.fgColor || action.color || null;
      const bgColor = action.bgColor || null;
      const blink = action.blink || false;
      const underline = action.underline || false;
      let styleStr = '';
      if (fgColor) styleStr += `color:${fgColor};`;
      if (bgColor) styleStr += `background:${bgColor};`;
      if (underline) styleStr += `text-decoration:underline;`;
      if (blink) styleStr += `animation:blink 1s step-end infinite;`;
      if (!styleStr) continue;

      // Wrap each match. If the match contains a newline (because the
      // capture spans the joined block's line break), split the wrap so
      // each output line carries its own balanced <hl>...</hl> — otherwise
      // a tag opened on line N and closed on line N+1 produces broken
      // markup once the joined text is split back into separate `mud`
      // messages.
      const globalRegex = new RegExp(matchRegex.source, matchRegex.flags.includes('g') ? matchRegex.flags : matchRegex.flags + 'g');
      joined = joined.replace(globalRegex, (match) => {
        if (match.includes('\n')) {
          return match.split('\n')
            .map(part => part ? `<hl style="${styleStr}">${part}</hl>` : '')
            .join('\n');
        }
        return `<hl style="${styleStr}">${match}</hl>`;
      });
    }
  }

  const finalLines = joined.split('\n');
  for (const ln of finalLines) {
    sendToClient(session, { type: 'mud', line: ln });
  }
}

// Returns true if the line was buffered (caller should NOT also send to client).
// Returns false if no block trigger consumed the line (caller sends as normal).
function processBlockTriggers(session, line) {
  if (!session.triggers || session.triggers.length === 0) return false;
  if (!session.activeBlocks) session.activeBlocks = new Map();

  // Force-flush any stale buffers before processing (timeout safety).
  const now = Date.now();
  for (const [tid, block] of Array.from(session.activeBlocks.entries())) {
    if (now - block.startedAt > BLOCK_TIMEOUT_MS) {
      // Flush as-is, no actions applied (we never saw the end marker).
      for (const ln of block.lines) {
        sendToClient(session, { type: 'mud', line: ln });
      }
      session.activeBlocks.delete(tid);
    }
  }

  let consumed = false;
  for (const trigger of session.triggers) {
    if (!trigger || trigger.enabled === false) continue;
    if (!trigger.blockStart || !trigger.blockEnd) continue;

    const startRx = compileBlockRegex(trigger.blockStart, true);
    const endRx   = compileBlockRegex(trigger.blockEnd,   true);
    if (!startRx || !endRx) continue;

    const block = session.activeBlocks.get(trigger.id);
    if (block) {
      // Active — append and check for end.
      block.lines.push(line);
      consumed = true;
      if (endRx.test(line)) {
        flushBlockTriggerBuffer(session, trigger, block.lines);
        session.activeBlocks.delete(trigger.id);
      }
    } else if (startRx.test(line)) {
      // Activate. If end matches the same line, flush immediately (1-line block).
      if (endRx.test(line)) {
        flushBlockTriggerBuffer(session, trigger, [line]);
      } else {
        session.activeBlocks.set(trigger.id, { lines: [line], startedAt: now });
      }
      consumed = true;
    }
  }

  return consumed;
}
// ────────────────────────────────────────────────────────────────────────

function processLine(session, line) {
  // Strip carriage returns (MUD sends \r\n, we split on \n leaving \r)
  line = line.replace(/\r/g, '');

  // MUD event sniffer — emit structured events for login/logout/linkdeath.
  // Runs BEFORE MIP filtering since login-prompt text never contains MIP.
  // Pattern matching is line-start anchored so false positives are unlikely.
  detectMudEvents(session, line);

  // Flush any pending BAB tell/soul — the MUD sends the MIP BAB message
  // on one line, then the ANSI text on the next. If the ANSI text starts
  // with "From afar", it's a soul; otherwise it's a regular tell.
  if (session._pendingBab) {
    const stripped = stripAnsi(line).trim();
    if (/^From afar,/i.test(stripped)) {
      flushPendingBab(session, 'soul');
    } else {
      flushPendingBab(session, 'tell');
    }
  }

  // Collapse consecutive empty lines — allow up to 2, drop the rest
  // Use stripAnsi() because MUD often sends ANSI-only lines (e.g. \x1b[0m) that are visually empty
  if (stripAnsi(line).trim() === '') {
    session._consecutiveEmptyLines = (session._consecutiveEmptyLines || 0) + 1;
    if (session._consecutiveEmptyLines > 2) return;
  } else {
    session._consecutiveEmptyLines = 0;
  }

  // FIRST LINE OF DEFENSE: Gag MIP protocol lines
  // MUD init can send multiple MIP messages concatenated in one TCP chunk:
  //   #K%59828039BAD...#K%59828007DDDjump#K%59828095FFFA~2705~...
  // Must loop through ALL matches, not just the first.
  if (/%\d{5}\d{3}[A-Z]{3}/.test(line)) {
    if (session.mipEnabled) {
      const mipRegex = /%(\d{5})(\d{3})([A-Z]{3})/g;
      let mipMatch;
      while ((mipMatch = mipRegex.exec(line)) !== null) {
        const len = parseInt(mipMatch[2], 10);
        const msgType = mipMatch[3];
        const dataStart = mipMatch.index + mipMatch[0].length;
        const msgData = line.substring(dataStart, dataStart + len);
        parseMipMessage(session, msgType, msgData);
        // Advance past the data portion so we don't re-match inside it
        mipRegex.lastIndex = dataStart + len;
      }
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

    // MIP FFF data fragments leaked from TCP-split MIP messages.
    // Vitals payloads look like "C~2838~N~18~L~55~E~1823~G~99" (leading letter)
    // or "7~G~99" (leading digit) or "~A~100" (leading tilde). Match any combo.
    const strippedMip = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (/^[A-Z\d]*(?:~[A-Z]~[\d]*)+$/.test(strippedMip)) return;
  }

  if (/%\d{5}\d{3}[A-Z]{3}/.test(line)) {
    return;
  }

  // ANSI color: each line is independent. We do NOT carry the last ANSI code
  // from one line to the next. Previously the server tracked
  // session.currentAnsiState and prepended it to lines that didn't start with
  // their own ANSI prefix; that mimicked a literal TUI terminal but caused
  // cross-line color bleeds when the MUD (or a trigger highlight) emitted
  // codes without an explicit \x1b[0m reset. Reported 2026-04-28: 14 lines
  // of unintended red after a single un-reset line. Modern MUD content sends
  // fresh ANSI per line, so dropping the carry-over fixes the bleed without
  // breaking anything legitimate. Field still exists for compatibility but
  // is always cleared.
  session.currentAnsiState = '';

  // Bot marker processing — check BEFORE triggers so markers are gagged cleanly
  if (session.bot && session.bot.active) {
    const botStripped = stripAnsi(line).trim();
    if (botProcessLine(session, botStripped)) {
      // Line was a bot marker — gag it from display entirely
      return;
    }
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

  // Handle slow regex (ReDoS protection) - disable the trigger
  if (processed.slowRegex) {
    const slow = processed.slowRegex;
    console.warn(`SLOW_REGEX user=${session.userId} char=${session.characterName} trigger=${slow.id} pattern=${slow.pattern.substring(0, 80)} elapsed=${slow.elapsedMs}ms`);
    sendToClient(session, {
      type: 'system',
      message: `Slow regex detected! Trigger "${slow.name}" took ${slow.elapsedMs}ms to match and has been disabled.`
    });
    sendToClient(session, {
      type: 'disable_trigger',
      triggerId: slow.id
    });
  }

  // Log all output (sent and gagged) for debugging
  const strippedOut = stripAnsi(line);
  if (strippedOut.length > 0) {
    writeSessionLog(session, processed.gag ? 'gag' : 'output', {
      line: strippedOut.substring(0, 500),
      ws: strippedOut.trim() === '' ? `ws:${strippedOut.length}` : undefined
    });
  } else {
    writeSessionLog(session, 'output', { line: '', ws: 'empty' });
  }

  if (!processed.gag) {
    // Route through block-trigger buffering first. If a block trigger
    // is active or starts/ends here, it owns the line and will flush
    // when ready (or on timeout). Otherwise send normally.
    const buffered = processBlockTriggers(session, processed.line);
    if (!buffered) {
      sendToClient(session, {
        type: 'mud',
        line: processed.line,
        highlight: processed.highlight,
        sound: processed.sound
      });
    }
  }

  // Remove oneshot triggers that fired
  if (processed.firedOneshots.length > 0) {
    session.triggers = (session.triggers || []).filter(t => !processed.firedOneshots.includes(t.id));
    // Notify client to remove them too
    processed.firedOneshots.forEach(id => {
      sendToClient(session, { type: 'remove_trigger', triggerId: id });
    });
  }

  // Execute trigger commands (with alias expansion)
  processed.commands.forEach(cmd => {
    if (cmd.startsWith('#')) {
      // Process #math/#var server-side for immediate variable updates
      const handled = serverProcessInlineCommand(cmd, session);
      if (!handled) {
        // Not a server-handled command — substitute and forward to client
        // (e.g. #showme, #show, #bell, etc.)
        const substitutedCmd = substituteUserVariables(cmd, session.variables || {}, session.functions || {});
        sendToClient(session, {
          type: 'client_command',
          command: substitutedCmd
        });
      }
      // If handled (#math/#var/#format/#cat/#replace): var_update already pushed to client.
      // Do NOT forward as client_command to avoid double-execution.
    } else if (session.mudSocket && !session.mudSocket.destroyed) {
      // Expand aliases before sending to MUD
      const expanded = expandCommandWithAliases(cmd, session.aliases || [], 0, session.variables || {}, session.functions || {}, session);
      expanded.forEach(ec => {
        // Check for #N command pattern: #34 {buy dagger;dismantle dagger}
        const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
        if (repeatMatch) {
          executeRepeat(Math.min(parseInt(repeatMatch[1]), 100), repeatMatch[2], session);
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
    const bridgeResumed = BRIDGE_URL && session.mudSocket.resumed;
    // bridgeResumed only means "bridge had a TCP socket" — it does NOT mean
    // the MUD is logged in. If the previous session got kicked back to the
    // name prompt, mudChar is null and we should treat this like a fresh
    // connect (run auto-login, defer MIP) rather than a clean resume
    // (suppress auto-login, fire MIP immediately). Without this gate, MIP
    // handshake bytes ('3klient 12345~~PortalWMT1.0.0') hit the MUD's name
    // prompt as junk and we get "Invalid character in position N" spam.
    // Confirmed bug 2026-05-06 with beowulf at name prompt.
    const mudLoggedIn = !!session._actualMudChar;
    const wasResumed = bridgeResumed && mudLoggedIn;
    console.log(`${wasResumed ? 'Resumed' : 'Connected to'} MUD: ${session.targetHost}:${session.targetPort}${BRIDGE_URL ? ' (via bridge)' : ''}${bridgeResumed && !mudLoggedIn ? ' [bridge had socket but MUD at name prompt — fresh login flow]' : ''}`);
    writeSessionLog(session, 'mud_connect', { host: session.targetHost, port: session.targetPort, resumed: wasResumed, bridgeResumed: bridgeResumed, mudLoggedIn: mudLoggedIn });
    logSessionEvent('MUD_LINK_GAINED', {
      token: session.token ? session.token.substring(0, 8) : null,
      user: session.userId,
      wmtSlot: session.characterName,
      mudChar: session._actualMudChar || null,
      host: session.targetHost,
      port: session.targetPort,
      resumed: wasResumed,
      bridgeResumed: bridgeResumed
    });

    if (!wasResumed) {
      // New connection — notify client
      sendToClient(session, {
        type: 'system',
        message: `Connected to ${session.targetHost}:${session.targetPort}!`
      });
      // Bridge mode: dispatch session_new in two cases —
      //   1. Fresh bridgeMode auth (session._bridgeModeInit). The browser
      //      ran the silent bridgeMode init, expects session_new for the
      //      onConnect (char name + password) flow.
      //   2. Bridge had a TCP socket but MUD was at name prompt (bridgeResumed
      //      && !mudLoggedIn). The browser is waiting for session_new or
      //      session_resumed; we route it through the auto-login path so the
      //      char name actually gets typed instead of MIP handshake hitting
      //      the name prompt as junk (the original beowulf bug, 2026-05-06).
      // Suppression: comment elsewhere warned about double-send if a client
      // already ran onConnect — that scenario is gated by _bridgeModeInit
      // being true on the FIRST connect, false after. For (2), the browser
      // never ran onConnect for this session yet (silent bridgeMode init).
      if (BRIDGE_URL && (session._bridgeModeInit || (bridgeResumed && !mudLoggedIn))) {
        session._bridgeModeInit = false;
        sendToClient(session, { type: 'session_new' });
        // Replay chat history from DB so ChatMon has previous messages
        if (session.chatBuffer.length > 0) {
          broadcastChatReplay(session, { type: 'chat_clear' });
          for (const msg of session.chatBuffer) {
            broadcastChatReplay(session, msg);
          }
        }
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
      // Replay chat history so ChatMon has previous messages
      if (session.chatBuffer.length > 0) {
        broadcastChatReplay(session, { type: 'chat_clear' });
        for (const msg of session.chatBuffer) {
          broadcastChatReplay(session, msg);
        }
      }
    }
  });

  session.mudSocket.on('data', (data) => {
    const { buffer: cleanData, hasGA } = stripTelnetSequences(data);
    const text = cleanData.toString('utf8');
    if (text.trim()) writeSessionLog(session, 'output', { text: text.substring(0, 4000) });

    // Eager prompt detection — set state flags directly from the raw data
    // chunk before line-buffering. The MUD's name and password prompts have
    // no trailing newline, so they sit in lineBuffer until the buffer
    // timeout fires (~2s with packet patch). That's slower than auto-login
    // (~1.5s), so without this fast-path, auto-logged-in characters race
    // the sniffer and miss MUD_CHAR_RESOLVED / `identified` audit rows.
    // The full sniffer pass still runs from processLine for the
    // journalctl event — flag setting is idempotent.
    if (text.includes('Enter your character name') && !session._nameCaptured) {
      session._atNamePrompt = true;
    }
    if (text.includes('Password:') && session._loginAuditPending) {
      session._loginAuditAtPasswordPrompt = true;
    }
    // Separate eager flag for password-leak suppression (multi-device race).
    // Unlike _loginAuditAtPasswordPrompt this is NOT gated on the audit
    // state, so it fires for linkdeath relink prompts too. Cleared in the
    // command handler when the first command after the prompt arrives.
    if (text.includes('Password:')) {
      session._eagerAtPasswordPrompt = true;
    }

    if (session.lineBufferTimeout) {
      clearTimeout(session.lineBufferTimeout);
      session.lineBufferTimeout = null;
    }

    const fullText = session.lineBuffer + text;
    const parts = fullText.split('\n');

    // Remove trailing empty string artifact from \n-terminated data
    if (fullText.endsWith('\n') && parts.length > 0 && parts[parts.length - 1] === '') {
      parts.pop();
    }

    if (hasGA) {
      session.lineBuffer = '';
      flushPatchQueue(session);
      parts.forEach(line => processLine(session, line));
      return;
    }

    if (!text.endsWith('\n') && parts.length > 0) {
      session.lineBuffer = parts.pop();
      if (session.lineBuffer) {
        // Single-timer fragment hold. Scales with packet_patch, min 500ms.
        const holdMs = Math.max(500, session.packetPatchMs * 2);
        session.lineBufferTimeout = setTimeout(() => {
          if (session.lineBuffer) {
            processLine(session, stripTrailingAnsi(session.lineBuffer));
            session.lineBuffer = '';
          }
          session.lineBufferTimeout = null;
        }, holdMs);
      }
    } else {
      session.lineBuffer = '';
    }

    queueLinesForProcessing(session, parts);
  });

  session.mudSocket.on('close', () => {
    console.log('MUD connection closed');
    writeSessionLog(session, 'mud_disconnect', {});
    logSessionEvent('MUD_LINK_LOST', {
      token: session.token ? session.token.substring(0, 8) : null,
      user: session.userId,
      wmtSlot: session.characterName,
      mudChar: session._actualMudChar || null,
      explicitDisconnect: !!session.explicitDisconnect
    });
    // Reset password-suppression state — a new MUD connection will go
    // through fresh auth and may legitimately need to capture again.
    session._eagerAtPasswordPrompt = false;
    session._suppressionPassword = null;
    session._suppressionExpiresAt = 0;
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
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  console.log('New WebSocket connection from:', clientIp);

  let session = null;
  let authenticated = false;

  // Handle messages
  ws.on('message', async (message) => {
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
          // Packet patch preference from auth message — applied to the session
          // BEFORE connectToMud can be called, so the first bytes of MUD data
          // use the user's setting, not the 250ms default.
          const authPacketPatchMs = data.packetPatch != null
            ? Math.max(0, Math.min(2000, Math.round(parseFloat(data.packetPatch) * 1000)))
            : null;

          if (!token || token.length !== 64) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid auth token' }));
            ws.close();
            return;
          }

          // Check IP ban
          const banCheck = await checkIpBan(clientIp);
          if (banCheck.banned) {
            logSessionEvent('IP_BANNED_CONNECTION', {
              ip: clientIp,
              user: userId,
              char: characterName || characterId,
              banType: banCheck.rule.type,
              banValue: banCheck.rule.value,
              banReason: banCheck.rule.reason || ''
            });
            ws.send(JSON.stringify({
              type: 'system',
              message: 'This IP has been suspended. Please reach out to Elminster for details.'
            }));
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
                oldBrowserConnected: oldSession.wsClients.size > 0,
                disconnectedFor: disconnectDuration,
                wizard: isWizard
              });

              // Multi-device rekey: add new WS to the set, keep existing ones
              // (they'll be on the old token's connection but still receive broadcasts)

              // Re-key: move session from old token to new token, keeping MUD alive
              sessions.delete(existingToken);
              oldSession.token = token;
              oldSession.ws = ws;  // Legacy compat
              oldSession.wsClients.add(ws);
              oldSession.disconnectedAt = null;
              oldSession.explicitDisconnect = false;
              oldSession.isWizard = isWizard;
              oldSession.clientIp = clientIp;
              if (authPacketPatchMs !== null) oldSession.packetPatchMs = authPacketPatchMs;
              // No audit event here — this is a browser-side rekey while
              // the MUD connection stays alive on the bridge. The audit log
              // tracks MUD-level player activity (login / disconnect), not
              // browser session machinery. See journalctl for SESSION_REKEY.
              //
              // Only clear _bridgeModeInit when MUD is actually alive — if the
              // bridge has no live socket (oldMudConnected=false), the next MUD
              // connect will be FRESH and we need session_new dispatched so the
              // browser auto-logs in. Beowulf hit this on 2026-05-03 deploy and
              // sat at the name prompt because rekey clobbered the flag.
              if (oldMudConnected) {
                oldSession._bridgeModeInit = false;  // Clear stale flag
              }
              oldSession._pendingBridgeResume = false;
              if (oldSession.timeoutHandle) {
                clearTimeout(oldSession.timeoutHandle);
                oldSession.timeoutHandle = null;
              }
              sessions.set(token, oldSession);
              userCharacterSessions.set(userCharKey, token);
              session = oldSession;

              // BridgeSocket keeps its original token for bridge communication.
              // The bridge doesn't need to know about session token changes —
              // it just needs a stable identifier for the TCP connection.
              // bridgeSockets map stays keyed by the original bridge-side token,
              // and persist/restore uses session.mudSocket.token (bridgeToken)
              // to reconnect to the right bridge connection.

              logSessionEvent('SESSION_RESUME', {
                token: token.substring(0, 8),
                user: session.userId,
                char: effectiveCharName(session),
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

              // CRITICAL: send authoritative_state BEFORE session_resumed.
              // Client's onSessionResumed handler fires sendFilteredTriggersAndAliases
              // which sends the browser's in-memory copy via WS. If the browser
              // has stale data from before, that stale data clobbers DB. Sending
              // authoritative_state first means the client replaces its in-memory
              // copy with DB state BEFORE the resumed handler fires the sync.
              loadAndPushAuthoritativeState(ws, session);

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

              // Replay ChatMon buffer (clear first so reconnect doesn't duplicate)
              if (session.chatBuffer.length > 0) {
                try { ws.send(JSON.stringify({ type: 'chat_clear' })); } catch (e) {}
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

            // Multi-device: add this browser to the session instead of
            // taking over. All connected browsers see the same output.
            // Log if this is an additional device (not the first).
            if (session.wsClients.size > 0) {
              logSessionEvent('SESSION_MULTI_DEVICE', {
                token: token.substring(0, 8),
                user: session.userId,
                char: effectiveCharName(session),
                devices: session.wsClients.size + 1
              });
            }

            // Attach new WebSocket (multi-device: add to Set, keep others)
            session.ws = ws;  // Legacy compat — points to most recent
            session.wsClients.add(ws);
            session.disconnectedAt = null;
            session.explicitDisconnect = false;
            session.isWizard = isWizard;  // Update wizard status on reconnect
            session.clientIp = clientIp;
            if (authPacketPatchMs !== null) session.packetPatchMs = authPacketPatchMs;
            // No audit event here — browser is reattaching to a session
            // whose MUD socket never broke from the MUD's perspective.
            // The audit log only tracks real MUD-level player activity
            // (login when a new MUD socket opens, disconnect when one
            // actually closes). See journalctl SESSION_RESUME for the
            // browser-side reattach event.
            //
            // Only clear _bridgeModeInit when MUD is actually alive — same
            // reasoning as the rekey path above. If the bridge socket is dead,
            // the next MUD connect is fresh and needs session_new for browser
            // auto-login.
            const sessionMudAlive = session.mudSocket && !session.mudSocket.destroyed;
            if (sessionMudAlive) {
              session._bridgeModeInit = false;  // Clear stale flag — prevents duplicate session_new
            }
            session._pendingBridgeResume = false;
            if (session.timeoutHandle) {
              clearTimeout(session.timeoutHandle);
              session.timeoutHandle = null;
            }

            // Match disconnect check (line 3539): !destroyed only, no .writable
            // BridgeSocket.writable starts false until bridge responds, but the
            // connection IS alive if the socket exists and isn't destroyed.
            const mudConnected = session.mudSocket && !session.mudSocket.destroyed;
            if (mudConnected && !session.mudSocket.writable) {
              console.log(`[bridge] Resume: mudSocket exists but writable=false for ${token.substring(0, 8)} — reporting connected anyway`);
            }
            const disconnectDuration = session.disconnectedAt ? Math.round((Date.now() - session.disconnectedAt) / 1000) : 0;
            logSessionEvent('SESSION_RESUME', {
              token: token.substring(0, 8),
              user: session.userId,
              char: effectiveCharName(session),
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

            // Send authoritative_state BEFORE session_resumed (see comment in REKEY branch)
            loadAndPushAuthoritativeState(ws, session);

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
            // Clear first so reconnect after deploy doesn't duplicate
            if (session.chatBuffer.length > 0) {
              try { ws.send(JSON.stringify({ type: 'chat_clear' })); } catch (e) {}
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

            // Send current bot status if bot is active
            if (session.bot && session.bot.active) {
              sendBotStatus(session);
            }
          } else {
            // Create new session
            session = createSession(token);
            session.ws = ws;  // Legacy compat
            session.wsClients.add(ws);
            session.userId = userId;
            session.characterId = characterId;
            session.characterName = characterName;
            session.isWizard = isWizard;
            session.clientIp = clientIp;
            if (authPacketPatchMs !== null) session.packetPatchMs = authPacketPatchMs;
            sessions.set(token, session);
            // Defer the login audit until set_server fires. At this moment
            // session.targetHost is still the default MUD_HOST (3k.org), so
            // firing here would log the wrong realm for any 3scapes user.
            // The set_server handler updates targetHost and then fires the
            // audit with the correct realm. Restored sessions never go
            // through this path, so they don't fire the login audit a
            // second time.
            session._loginAuditPending = true;

            logSessionEvent('SESSION_NEW', {
              token: token.substring(0, 8),
              user: userId,
              char: characterName || characterId,
              wizard: isWizard,
              ip: clientIp
            });
            writeSessionLog(session, 'session', { event: 'new', user: userId, char: characterName || characterId });

            // Load chat history from DB so ChatMon has previous messages
            // even on a fresh session (not just on server-restart restore)
            if (wmtDb && characterId) {
              try {
                const chatRows = dbStmts.getRecentChat.all(characterId, CHAT_BUFFER_MAX);
                if (chatRows.length > 0) {
                  session.chatBuffer = chatRows.reverse().map(r => {
                    try { return JSON.parse(r.raw_data); } catch (e) { return null; }
                  }).filter(Boolean);
                }
              } catch (e) {}
            }

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
              // Send authoritative_state BEFORE session_new (see REKEY comment)
              loadAndPushAuthoritativeState(ws, session);
              ws.send(JSON.stringify({
                type: 'session_new',
                bridgeMode: true
              }));
            } else {
              loadAndPushAuthoritativeState(ws, session);
              ws.send(JSON.stringify({
                type: 'session_new'
              }));
              // Replay chat history from DB so ChatMon has previous messages
              if (session.chatBuffer.length > 0) {
                try { ws.send(JSON.stringify({ type: 'chat_clear' })); } catch (e) {}
                for (const msg of session.chatBuffer) {
                  try { ws.send(JSON.stringify(msg)); } catch (e) { break; }
                }
              }
            }
          }

          // authoritative_state was already sent BEFORE session_resumed/new
          // in each auth branch above (so the client's onSessionResumed handler
          // sees fresh data when it fires sendFilteredTriggersAndAliases).
          authenticated = true;
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Must authenticate first' }));
        }
        return;
      }

      // Handle authenticated messages
      switch (data.type) {
        case 'command':
          // Honeypot trip: if the command exactly matches a configured trip
          // string, auto-ban the source IP and tear down the connection.
          // Trips are seeded with attacker signatures (e.g., the Yggdrasil/
          // Dwolin attacker's char-creation password "namida"). Exact match
          // on the whole command (not substring) so legit users typing a
          // similar word in chat don't trip — chat goes through as
          // `say <word>`, not `<word>` alone.
          if (data.command && honeypotTrips.length > 0) {
            const cmd = String(data.command).trim();
            if (cmd && honeypotTrips.includes(cmd)) {
              tripHoneypot(session, ws, cmd, `matched "${cmd}"`);
              return;
            }
          }

          // Guest-mode name-prompt restriction: when a guest session is at
          // the MUD's name prompt, the only allowed name is "guest". Any
          // other typed name gets dropped before reaching the MUD. Without
          // this, attackers can use guest mode to type real player names +
          // password guesses, which the MUD validates and sends "Someone is
          // attempting to login to your character." notifications to the
          // real player — a direct harassment vector. Confirmed Nathan-
          // reported 2026-05-10.
          //
          // Allow: empty input (just enter — re-prompts the banner), "guest"
          // (case-insensitive). Drop everything else with a system message.
          // Once "guest" goes through, _atNamePrompt clears and subsequent
          // commands flow normally.
          if (session.userId && String(session.userId).startsWith('guest_') && session._atNamePrompt) {
            const cmd = String(data.command || '').trim();
            if (cmd && cmd.toLowerCase() !== 'guest') {
              sendToClient(session, {
                type: 'system',
                message: 'Guest sessions can only log in as the "guest" character.'
              });
              logSessionEvent('GUEST_NAME_BLOCKED', {
                token: session.token ? session.token.substring(0, 8) : null,
                user: session.userId,
                ip: session.clientIp || null,
                attemptedName: cmd
              });
              break;
            }
          }

          // Multi-device password leak suppression: when "Password:" was
          // recently seen in MUD output (eager flag set in the data handler),
          // capture the FIRST command that arrives as the password and arm a
          // 5-second window during which any duplicate send (from a second
          // browser racing with the first) gets dropped before reaching the
          // MUD. Without this, the second browser's auto-send arrives after
          // login completes and the MUD echoes the password back as an
          // unrecognized command — leaking the password to channels/logs.
          // Confirmed Nathan-reported 2026-05-06.
          {
            const cmd = data.command || '';
            if (session._eagerAtPasswordPrompt && cmd) {
              session._suppressionPassword = cmd;
              session._suppressionExpiresAt = Date.now() + 5000;
              session._eagerAtPasswordPrompt = false;
              // Allow this first send through to the MUD normally.
            } else if (session._suppressionPassword &&
                       cmd === session._suppressionPassword &&
                       Date.now() < session._suppressionExpiresAt) {
              // Duplicate password send from a second browser racing with
              // the first. Drop it silently — do NOT forward to MUD or write
              // to the input log.
              console.log(`SUPPRESSED duplicate password send (multi-device race) for token=${session.token ? session.token.substring(0, 8) : '?'}`);
              break;
            }
          }
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

            // Deferred login audit state machine — see detectMudEvents
            // comment block for the full sequence. Two phases here:
            //   Phase 1: at password prompt → this input IS the password,
            //            consume it and watch for the next.
            //   Phase 2: password entered, this is the user's FIRST real
            //            command after auth → fire login.
            // Relink scenarios are preempted by relink_complete in the
            // sniffer, which fires reconnect and clears both flags.
            if (session._loginAuditPending && data.command && String(data.command).trim()) {
              if (session._loginAuditAtPasswordPrompt) {
                // Phase 1: this is the password itself. Skip it, advance.
                session._loginAuditAtPasswordPrompt = false;
                session._loginAuditPasswordEntered = true;
              } else if (session._loginAuditPasswordEntered) {
                // Phase 2: first command after the password — fire login.
                session._loginAuditPending = false;
                session._loginAuditPasswordEntered = false;
                sendAuditLog('login', session, session.clientIp);
              }
            }

            // MUD character name capture: if the MUD is currently at the
            // name prompt (detected by detectMudEvents), the next typed
            // command is the real MUD character name. This is the only
            // reliable way to learn the actual character — the WMT slot
            // label is user-chosen and may differ (see the StantonTheManton
            // incident, Apr 2026).
            if (session._atNamePrompt && data.command && !data.raw) {
              const candidate = String(data.command).trim().toLowerCase();
              if (/^[a-z]{2,12}$/.test(candidate)) {
                const previous = session._actualMudChar;
                session._actualMudChar = candidate;
                session._atNamePrompt = false;
                session._nameCaptured = true;
                if (previous !== candidate) {
                  logSessionEvent('MUD_CHAR_RESOLVED', {
                    token: session.token ? session.token.substring(0, 8) : null,
                    user: session.userId,
                    wmtSlot: session.characterName,
                    mudChar: candidate,
                    previous: previous || null
                  });
                  writeSessionLog(session, 'mud_event', { event: 'char_resolved', mudChar: candidate, previous: previous || null });
                  // Audit-log the resolved identity ONLY when the real MUD
                  // character differs from the WMT slot label. When they
                  // match (the normal case — Hot=hot, Chomp=chomp), the
                  // identified row would be redundant noise. When they
                  // mismatch (StantonTheManton=bendover, guest=realname),
                  // the row carries actual information: it tells the
                  // wizard "the WMT slot label is misleading, the real
                  // MUD character for this session is X." So an
                  // `identified` row in the audit log is itself a flag.
                  const wmtSlotLower = (session.characterName || '').toLowerCase();
                  if (candidate !== wmtSlotLower) {
                    sendAuditLog('identified', session, session.clientIp);
                  }
                }
              }
            }

            // Track originating ws so client_command messages route back to the
            // browser that typed this command (prevents double-execution on multi-device)
            session._cmdTargetWs = ws;

            // If raw flag is set, send as-is without semicolon splitting or alias processing
            // (used by #send for ANSI codes containing semicolons)
            if (data.raw) {
              session.mudSocket.write((data.command || '') + '\r\n');
            } else if (!(data.command || '').trim()) {
              // Empty or whitespace-only: send directly to MUD (board editors,
              // "press enter to continue", blank lines in pasted text)
              session.mudSocket.write((data.command || '') + '\r\n');
            } else {
              // Recursively expand aliases and handle semicolons.
              // TinTin++ processes commands sequentially: #var/#math in an alias
              // body take effect immediately so later commands in the same body
              // see updated variables (e.g. "#var x 1;dostep$x").
              const ASYNC_READ_RE = /^#(?:class\s+\{[^}]*\}\s+\{read\}|read\b)/i;
              // Definition verbs whose body args must be stored verbatim. Substituting
              // would freeze $var references at definition time, breaking aliases like
              // "#alias {mfill} {... $manacur < $manamax ...}" — the body would get
              // hardcoded with current values. Loaded-from-#read scripts already bypass
              // this substitution path; this list extends the same protection to live
              // command-line definitions.
              const DEFINITION_VERB_RE = /^#(?:alias|action|sub|substitute|gag|highlight|ticker|t|function)\b/i;
              let hitAsyncRead = false;  // Once set, stop expanding — remaining go to client

              const expandCommand = (cmd, depth = 0) => {
                if (depth > 10) return [cmd];
                const trimmed = cmd.trim();
                if (!trimmed) return [];

                // After a #read/#class read, don't expand — return literal for client
                if (hitAsyncRead) return [trimmed];

                // For # commands: execute #var/#math inline for side effects,
                // then substitute $variables before returning to client
                if (trimmed.startsWith('#')) {
                  // Check if this is an async read — stop expanding after it
                  if (ASYNC_READ_RE.test(trimmed)) {
                    hitAsyncRead = true;
                  } else {
                    const handled = serverProcessInlineCommand(trimmed, session);
                    if (handled) {
                      // Server already processed this command (#math/#var/#format/#cat/#replace)
                      // and pushed var_update to client. Do NOT forward as client_command or the
                      // client will double-execute with post-substitution values, corrupting
                      // step counters and other sequential variables.
                      return [];
                    }
                  }
                  // Substitute $vars and @funcs AFTER inline processing
                  // so freshly-set vars are visible (e.g. #var {x} {42};#showme {$x})
                  // Exception: definition verbs (#alias, #action, etc.) — their body
                  // arg must remain verbatim so $var references resolve at fire time.
                  if (DEFINITION_VERB_RE.test(trimmed)) {
                    return [trimmed];
                  }
                  return [substituteUserVariables(trimmed, session.variables || {}, session.functions || {})];
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
                // Check for #N command pattern: #34 {buy dagger;dismantle dagger}
                const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
                if (repeatMatch) {
                  executeRepeat(Math.min(parseInt(repeatMatch[1]), 100), repeatMatch[2], session);
                } else if (ec.startsWith('#')) {
                  // #var/#math already processed during expansion (for sequential side effects)
                  // Forward to client for #delay, #showme, etc.
                  sendToClient(session, { type: 'client_command', command: ec });
                } else {
                  // Detect 'quit' command — flag as intentional disconnect so
                  // client doesn't auto-reconnect after MUD closes connection.
                  // NOTE: this is text-pattern detection on user INPUT, which
                  // is fragile (aliases, typos, shorthand). The audit-log
                  // logout/disconnect distinction is driven by the SNIFFER
                  // catching the MUD's goodbye packet — see the
                  // mud_quit_complete pattern in MUD_EVENT_PATTERNS. This
                  // input-side detection only handles the auto-reconnect
                  // suppression, not the audit classification.
                  if (ec.trim().toLowerCase() === 'quit') {
                    session.explicitDisconnect = true;
                    sendToClient(session, { type: 'quit_detected' });
                    logSessionEvent('MUD_QUIT', {
                      token: session.token ? session.token.substring(0, 8) : null,
                      user: session.userId,
                      wmtSlot: session.characterName,
                      mudChar: session._actualMudChar || null
                    });
                    writeSessionLog(session, 'mud_event', { event: 'quit' });
                  }
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
          // ReDoS protection: drop triggers with pathologically long patterns.
          // 500 chars is far beyond any reasonable trigger and caps the worst case
          // for regex compilation/matching cost.
          let incomingTriggers = (data.triggers || []).filter(t => {
            if (t && typeof t.pattern === 'string' && t.pattern.length > 500) {
              console.warn(`DROPPED_LONG_TRIGGER user=${session.userId} char=${session.characterName} length=${t.pattern.length}`);
              return false;
            }
            return true;
          }).map(t => {
            // Defensive: if a stale browser sends a name with accumulated
            // HTML entity escapes (the old sanitize() bug), decode them here
            // so the corruption can't re-pollute DB on bulk_replace. See
            // 2026-04-28 incident — `Galan&amp;amp;...amp;#039;s voice...`.
            if (t && typeof t.name === 'string' && /&(?:amp|lt|gt|quot|apos|#039|#39);/.test(t.name)) {
              t = { ...t, name: decodeHtmlEntitiesIterative(t.name) };
            }
            return t;
          });
          // Stale-write guard: if /admin/trigger recently patched a trigger
          // and this bulk_replace from the browser carries the old content,
          // swap in the authoritative current value. See entity_guard above.
          if (session.characterId) {
            const guardResult = applyGuard('triggers', session.characterId, incomingTriggers);
            if (guardResult.overridden || guardResult.cleared || guardResult.reinserted || guardResult.tombstoned) {
              console.log(`TRIGGER_GUARD char=${session.characterId} overrode=${guardResult.overridden} cleared=${guardResult.cleared} reinserted=${guardResult.reinserted} tombstoned=${guardResult.tombstoned}`);
              writeSessionLog(session, 'trigger_guard', { overridden: guardResult.overridden, cleared: guardResult.cleared, reinserted: guardResult.reinserted, tombstoned: guardResult.tombstoned });
            }
            incomingTriggers = guardResult.list;
          }
          session.triggers = incomingTriggers;
          writeSessionLog(session, 'settings', { what: 'triggers', count: session.triggers.length });
          // DB dual-write (gated by user during rollout)
          if ((!DB_ENABLED_USERS || DB_ENABLED_USERS.has(session.userId)) && session.characterId) {
            dbSaveTriggers(session.characterId, session.triggers);
          }
          // Bridge mode: triggers arrived, now safe to resume bridge connection.
          // MUD data will flow through processLine with triggers ready.
          if (session._pendingBridgeResume) {
            session._pendingBridgeResume = false;
            connectToMud(session);
          }
          break;

        case 'set_aliases':
          // ReDoS protection: drop aliases with pathologically long patterns
          let incomingAliases = (data.aliases || []).filter(a => {
            if (a && typeof a.pattern === 'string' && a.pattern.length > 500) {
              console.warn(`DROPPED_LONG_ALIAS user=${session.userId} char=${session.characterName} length=${a.pattern.length}`);
              return false;
            }
            return true;
          });
          // Stale-write guard: if a recent admin/server edit is still within the
          // protection window and the client is sending the OLD value, swap in
          // the server-authoritative value before persisting. See definition of
          // serverModifiedAliases above for rationale.
          if (session.characterId) {
            const guarded = applyAliasServerModifiedGuard(session.characterId, incomingAliases);
            if (guarded.overridden > 0 || guarded.cleared > 0) {
              console.log(`ALIAS_GUARD char=${session.characterId} overrode=${guarded.overridden} cleared=${guarded.cleared}`);
              writeSessionLog(session, 'alias_guard', { overridden: guarded.overridden, cleared: guarded.cleared });
            }
            incomingAliases = guarded.aliases;
          }
          session.aliases = incomingAliases;
          writeSessionLog(session, 'settings', { what: 'aliases', count: session.aliases.length });
          // DB dual-write (gated by user during rollout)
          if ((!DB_ENABLED_USERS || DB_ENABLED_USERS.has(session.userId)) && session.characterId) {
            dbSaveAliases(session.characterId, session.aliases);
          }
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
          {
            let incomingTickers = data.tickers || [];
            // Stale-write guard for /admin/ticker edits
            if (session.characterId) {
              const guardResult = applyGuard('tickers', session.characterId, incomingTickers);
              if (guardResult.overridden || guardResult.cleared || guardResult.reinserted || guardResult.tombstoned) {
                console.log(`TICKER_GUARD char=${session.characterId} overrode=${guardResult.overridden} cleared=${guardResult.cleared} reinserted=${guardResult.reinserted} tombstoned=${guardResult.tombstoned}`);
                writeSessionLog(session, 'ticker_guard', { overridden: guardResult.overridden, cleared: guardResult.cleared, reinserted: guardResult.reinserted, tombstoned: guardResult.tombstoned });
              }
              incomingTickers = guardResult.list;
            }
            updateSessionTickers(session, incomingTickers);
            writeSessionLog(session, 'settings', { what: 'tickers', count: incomingTickers.length });
            if ((!DB_ENABLED_USERS || DB_ENABLED_USERS.has(session.userId)) && session.characterId) {
              dbSaveTickers(session.characterId, incomingTickers);
            }
          }
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

        case 'set_packet_patch':
          // Packet patch delay in seconds (0 = disabled)
          session.packetPatchMs = Math.max(0, Math.min(2000, Math.round((parseFloat(data.value) || 0) * 1000)));
          console.log(`Packet patch: ${session.packetPatchMs}ms`);
          break;

        case 'set_discord_prefs':
          // Store Discord preferences for server-side notifications
          // Each channel can have its own webhook URL
          session.discordUsername = data.username || 'WMT Client';
          session.discordChannelPrefs = {};
          // Global ChatMon "no alerts from self" preference. Default false preserves
          // existing behavior; opt-in flag suppresses ding + Discord + IFTTT for
          // chat messages where the sender is this session's character.
          session.suppressSelfAlerts = !!data.suppressSelfAlerts;
          // Suppress alerts on the MUD's AFK auto-reply (`[Sender]: is afk: ...`).
          session.suppressAfkAlerts = !!data.suppressAfkAlerts;

          // IFTTT key is per-user (single Maker key, used across channels).
          // Validate shape: alphanumeric + underscore + hyphen, 10-64 chars. Empty clears it.
          if (typeof data.iftttKey === 'string') {
            const k = data.iftttKey.trim();
            session.iftttKey = (k === '' || /^[A-Za-z0-9_-]{10,64}$/.test(k)) ? k : '';
          }

          // Validate and store per-channel webhook URLs
          const channelPrefs = data.channelPrefs || {};
          let webhookCount = 0;
          let iftttChannelCount = 0;
          for (const [channel, prefs] of Object.entries(channelPrefs)) {
            session.discordChannelPrefs[channel] = {
              sound: prefs.sound || false,
              hidden: prefs.hidden || false,
              discord: prefs.discord || false,
              webhookUrl: null,
              ifttt: prefs.ifttt || false,
              iftttEvent: ''
            };
            // Validate webhook URL if provided
            if (prefs.webhookUrl && prefs.discord) {
              if (prefs.webhookUrl.startsWith('https://discord.com/api/webhooks/') ||
                  prefs.webhookUrl.startsWith('https://discordapp.com/api/webhooks/')) {
                session.discordChannelPrefs[channel].webhookUrl = prefs.webhookUrl;
                webhookCount++;
              }
            }
            // Validate IFTTT event name override if provided (default applied at send time)
            if (typeof prefs.iftttEvent === 'string') {
              const ev = prefs.iftttEvent.trim();
              if (ev === '' || /^[A-Za-z0-9_-]{1,64}$/.test(ev)) {
                session.discordChannelPrefs[channel].iftttEvent = ev;
              }
            }
            if (prefs.ifttt) iftttChannelCount++;
          }
          logSessionEvent('DISCORD_PREFS_SET', {
            token: session.token.substring(0, 8),
            user: session.userId,
            char: effectiveCharName(session),
            webhookCount: webhookCount,
            iftttKey: session.iftttKey ? 'set' : 'unset',
            iftttChannels: iftttChannelCount,
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
              // Login audit is NOT fired here. We defer it until the MUD
              // sniffer can tell us whether this is a fresh login or a
              // return from linkdeath — see the password_prompt timer +
              // relink_complete handler in detectMudEvents().
              // In bridge mode, defer connectToMud until triggers arrive
              // to prevent MUD data flowing before gags/triggers are loaded.
              if (BRIDGE_URL && session._pendingBridgeResume) {
                // Will be called from set_triggers handler
              } else if (BRIDGE_URL && session.mudSocket && !session.mudSocket.destroyed && session.mudSocket.writable) {
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
          // Used by #showme to test trigger patterns.
          // Response goes to the ORIGINATING device only (not broadcast)
          // to prevent N-device amplification where each device's #showme
          // sends test_line and the result broadcasts to all N devices.
          if (data.line) {
            const processed = processTriggers(data.line, session.triggers, null, session.variables || {}, session.functions || {});

            // Handle slow regex (ReDoS protection) — disable the trigger
            if (processed.slowRegex) {
              const slow = processed.slowRegex;
              console.warn(`SLOW_REGEX user=${session.userId} char=${session.characterName} trigger=${slow.id} pattern=${slow.pattern.substring(0, 80)} elapsed=${slow.elapsedMs}ms`);
              sendToClient(session, {
                type: 'system',
                message: `Slow regex detected! Trigger "${slow.name}" took ${slow.elapsedMs}ms to match and has been disabled.`
              });
              sendToClient(session, { type: 'disable_trigger', triggerId: slow.id });
            }

            // Send to originating client only (not broadcast)
            try {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'mud',
                  line: processed.line,
                  highlight: processed.highlight,
                  sound: processed.sound,
                  test: true
                }));
              }
            } catch (e) {}

            // Execute any trigger commands (with alias expansion)
            processed.commands.forEach(cmd => {
              if (cmd.startsWith('#')) {
                const handled = serverProcessInlineCommand(cmd, session);
                if (!handled) {
                  const substitutedCmd = substituteUserVariables(cmd, session.variables || {}, session.functions || {});
                  sendToClient(session, {
                    type: 'client_command',
                    command: substitutedCmd
                  });
                }
              } else if (session.mudSocket && !session.mudSocket.destroyed) {
                // Expand aliases before sending to MUD
                const expanded = expandCommandWithAliases(cmd, session.aliases || [], 0, session.variables || {}, session.functions || {}, session);
                expanded.forEach(ec => {
                  const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
                  if (repeatMatch) {
                    executeRepeat(Math.min(parseInt(repeatMatch[1]), 100), repeatMatch[2], session);
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

        // ─── Bot control messages ──────────────────
        case 'bot_start':
          botStart(session, data);
          break;

        case 'bot_stop':
          botStop(session);
          break;

        case 'bot_pause':
          botPause(session);
          break;

        case 'bot_resume':
          botResume(session);
          break;

        case 'bot_config':
          botUpdateConfig(session, data);
          break;

        case 'bot_status_request':
          sendBotStatus(session);
          break;

        case 'disconnect':
          // Explicit disconnect - close MUD connection
          logSessionEvent('SESSION_EXPLICIT_DISCONNECT', {
            token: session.token.substring(0, 8),
            user: session.userId,
            char: effectiveCharName(session)
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
        return;
      }

      // Remove this WS from the multi-device set
      session.wsClients.delete(ws);
      // Update legacy ws pointer
      if (session.ws === ws) {
        // Point to another connected client if any, otherwise null
        session.ws = null;
        for (const other of session.wsClients) {
          if (other.readyState === WebSocket.OPEN) {
            session.ws = other;
            break;
          }
        }
      }

      // Only log disconnect + start timeout if ALL browsers are gone
      if (session.wsClients.size === 0) {
        session.disconnectedAt = Date.now();

        const mudConnected = session.mudSocket && !session.mudSocket.destroyed;
        logSessionEvent('SESSION_BROWSER_DISCONNECT', {
          token: session.token.substring(0, 8),
          user: session.userId,
          char: effectiveCharName(session),
          mudConnected: mudConnected,
          wizard: session.isWizard,
          willTimeout: !session.isWizard,
          note: 'last browser disconnected'
        });
      } else {
        logSessionEvent('SESSION_DEVICE_LEFT', {
          token: session.token.substring(0, 8),
          char: effectiveCharName(session),
          remaining: session.wsClients.size
        });
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    if (session) {
      session.wsClients.delete(ws);
      if (session.ws === ws) session.ws = null;
      if (session.wsClients.size === 0) {
        session.disconnectedAt = Date.now();
      }
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
 * Execute a #N repeat command: #34 {buy dagger;dismantle dagger}
 * Strips outer braces, parses semicolons, sends each sub-command N times.
 */
function executeRepeat(count, body, session) {
  // Strip outer braces: {buy dagger;dismantle dagger} → buy dagger;dismantle dagger
  let cmd = body;
  if (cmd.startsWith('{') && cmd.endsWith('}')) {
    cmd = cmd.slice(1, -1);
  }
  const subCmds = parseCommands(cmd);
  for (let i = 0; i < count; i++) {
    subCmds.forEach(sc => {
      session.mudSocket.write(processEscapes(sc) + '\r\n');
    });
  }
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
        case ' ':  result += ' ';    i++; break;
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
        const handled = serverProcessInlineCommand(partTrimmed, session);
        if (handled) {
          // Server already processed this command (#math/#var/#format/#cat/#replace)
          // and pushed var_update to client. Do NOT forward as client_command or the
          // client will double-execute with post-substitution values, corrupting
          // step counters and other sequential variables.
          return;
        }
      }
      // Substitute $variables and @functions in # commands before sending to client
      // (e.g. #showme {attacking $target} → #showme {attacking goblin})
      // Must happen AFTER serverProcessInlineCommand so freshly-set vars are available
      // Exception: definition verbs (#alias, #action, etc.) — their body arg must
      // remain verbatim so $var references resolve at fire time, not at definition.
      // Same regex as in expandCommand above.
      const DEF_VERB_RE = /^#(?:alias|action|sub|substitute|gag|highlight|ticker|t|function)\b/i;
      if (DEF_VERB_RE.test(partTrimmed)) {
        results.push(partTrimmed);
        return;
      }
      const substitutedCmd = substituteUserVariables(partTrimmed, variables, functions);
      results.push(substitutedCmd);
      return;
    }

    // Substitute $variables BEFORE alias pattern matching
    const substituted = substituteUserVariables(partTrimmed, variables, functions);
    const expanded = processAliases(substituted, aliases, variables, functions);
    if (expanded === substituted) {
      results.push(substituted);
    } else {
      // Log alias expansion for debugging bot/trigger issues
      if (session) {
        writeSessionLog(session, 'alias_expand', {
          raw: partTrimmed.substring(0, 80),
          sub: substituted.substring(0, 80),
          exp: expanded.substring(0, 200)
        });
      }
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
  // ~ prefix = raw PCRE regex mode
  if (pattern.startsWith('~')) return true;
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
    loopDetected: null,  // Will contain trigger info if loop detected
    slowRegex: null,     // Will contain trigger info if regex took too long (ReDoS protection)
    firedOneshots: []    // Oneshot trigger IDs that fired and should be removed
  };

  const now = Date.now();
  const LOOP_WINDOW_MS = 2000;  // 2 second window
  const LOOP_THRESHOLD = 50;    // Max fires in window before considered a loop
  const REGEX_SLOW_MS = 50;     // Disable a trigger if its regex takes >50ms to match

  // Sort triggers by priority (lower = fires first, default 5)
  // TinTin++ processes actions in priority order, first command match wins
  const sorted = [...triggers].sort((a, b) => (a.priority || 5) - (b.priority || 5));

  // Track whether a command action has already fired (TinTin++: first trigger's commands win)
  let commandFired = false;
  let commandFiredByTrigger = null;  // Which trigger fired first (allow multiple actions within it)

  for (const trigger of sorted) {
    if (!trigger.enabled) continue;
    // Block triggers (have both blockStart and blockEnd) are handled
    // by processBlockTriggers, not the per-line pipeline. Skip them
    // here so their actions don't fire on each individual line.
    if (trigger.blockStart && trigger.blockEnd) continue;

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

    // Handle ~ prefix (raw PCRE regex mode: {capture} → (capture), no % wildcard processing)
    const isTildeRegex = pattern.startsWith('~');
    let cachedRegexStr = null;
    if (isTildeRegex) {
      // Strip ~ and convert {} → () for capture groups, pass everything else through raw
      cachedRegexStr = pattern.slice(1).replace(/(?<!\\)\{([^}]*)\}/g, '($1)');
    }

    // Auto-detect pattern type: TinTin++ syntax or simple contains
    const useTinTin = isTildeRegex || isTinTinPattern(pattern);

    if (useTinTin) {
      // TinTin++ pattern matching (case-sensitive by default)
      try {
        const regexPattern = cachedRegexStr || tinTinToRegex(pattern);
        const regex = new RegExp(regexPattern);
        const regexStart = Date.now();
        const match = matchLine.match(regex);
        const regexElapsed = Date.now() - regexStart;
        // ReDoS protection: if a regex takes too long, flag for disable
        if (regexElapsed > REGEX_SLOW_MS) {
          result.slowRegex = {
            id: trigger.id,
            name: trigger.name || pattern,
            pattern: pattern,
            elapsedMs: regexElapsed
          };
          continue; // Skip this trigger's actions
        }
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
      // Track this fire for loop detection (only for triggers that execute commands —
      // gags, highlights, and substitutes are passive and can't cause loops)
      const hasCommands = trigger.actions.some(a => a.type === 'command');
      if (hasCommands && loopTracker && trigger.id) {
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
                const regexPattern = cachedRegexStr || tinTinToRegex(pattern);
                searchPattern = new RegExp(`(${regexPattern})`, 'g');
              } else {
                const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                searchPattern = new RegExp(`(${escaped})`, 'g');
              }

              result.line = result.line.replace(searchPattern, `<hl style="${styleStr}">$1</hl>`);
            }
            break;
          case 'command':
            // TinTin++: first matching TRIGGER's commands win (across triggers).
            // But multiple command actions within a single trigger all execute
            // (WMT UI allows multiple "Send command" actions per trigger).
            if (commandFired && commandFiredByTrigger !== trigger) break;
            let cmd = action.command || '';
            if (matches.length) {
              // Always use TinTin var substitution for captured groups
              cmd = replaceTinTinVars(cmd, matches);
            }
            // Use parseCommands to respect brace depth when splitting
            const cmds = parseCommands(cmd);
            result.commands.push(...cmds);
            commandFired = true;
            commandFiredByTrigger = trigger;
            break;
          case 'sound':
            result.sound = action.sound || 'beep';
            break;
          case 'substitute':
            // TinTin++ two-pass substitution:
            // Pass 1 (SUB_ARG): replace %1-%99 with captured groups
            // Pass 2 (SUB_VAR): substitute $variables
            // Pass 3 (color codes): convert <NNN>/<aaa>/<AAA> to ANSI escapes
            // so highlights like `<139>chaos<088>` render as actual color
            // rather than literal angle-bracket text.
            let replacement = action.replacement || '';
            if (matches.length) {
              replacement = replaceTinTinVars(replacement, matches);
            }
            replacement = substituteUserVariables(replacement, variables, functions);
            replacement = parseTinTinColorsServer(replacement);
            // Find and replace the matched portion (case-sensitive)
            if (useTinTin) {
              const regexPattern = cachedRegexStr || tinTinToRegex(pattern);
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

      // Track oneshot triggers that fired for removal
      if (trigger.oneshot && trigger.id) {
        result.firedOneshots.push(trigger.id);
      }
    }
  }

  // Process #line gag commands — scan and remove from commands, set gag flag
  result.commands = result.commands.filter(cmd => {
    if (/^#line\s+gag\s*$/i.test(cmd.trim())) {
      result.gag = true;
      return false;
    }
    return true;
  });

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

  // Index lookup for $var[key] — supports TinTin++-style indexing:
  //   $var[]       → all values joined by ;
  //   $var[+N]     → 1-based index from start (+1 = first item)
  //   $var[-N]     → 1-based index from end (-1 = last item)
  //   $var[+S..E]  → range of values from S to E (joined by ;)
  //   $var[key]    → literal key (object property lookup)
  // Mirrors the client-side substituteVariables logic for parity. Without
  // this, server-side trigger/alias expansion couldn't index into list
  // variables created by #list, so things like {findtv}'s
  // $tvpath[+$tvpathnum] returned empty. Fixed 2026-05-08.
  function lookupBracketKey(val, key) {
    if (typeof val !== 'object' || val === null) return undefined;
    if (key === '') return Object.values(val).join(';');
    // Range check FIRST — `+2..4` matches both `startsWith('+')` and
    // `includes('..')`, so order matters or the range branch is dead.
    if (key.includes('..')) {
      const [s, e] = key.split('..');
      const start = parseInt(s.replace('+', '')) - 1;
      const end = parseInt(e) - 1;
      const values = Object.values(val);
      return (start >= 0 && end >= start && end < values.length)
        ? values.slice(start, end + 1).join(';')
        : '';
    }
    if (key.startsWith('+')) {
      const idx = parseInt(key.substring(1)) - 1;
      const values = Object.values(val);
      return (idx >= 0 && idx < values.length) ? values[idx] : '';
    }
    if (/^-\d+$/.test(key)) {
      const idx = parseInt(key);
      const values = Object.values(val);
      return (Math.abs(idx) <= values.length) ? values[values.length + idx] : '';
    }
    return val[key];
  }
  // Resolve any $var or ${var} inside a bracket key BEFORE applying lookup.
  // This is what makes $tvpath[+$tvpathnum] work in non-brace form.
  function resolveBracketKey(rawKey) {
    let k = rawKey;
    let iter = 5;
    while (iter-- > 0) {
      const before = k;
      k = k.replace(/\$\{(\w+)\}/g, (m, name) => (variables[name] !== undefined ? String(variables[name]) : m));
      k = k.replace(/\$(\w+)/g, (m, name) => (variables[name] !== undefined ? String(variables[name]) : m));
      if (k === before) break;
    }
    return k;
  }

  // Handle ${var} and ${var[key][subkey]} brace-delimited
  // Resolve inside-out so ${bot[steps][${bot[step]}]} works
  {
    let maxNest = 10;
    while (maxNest-- > 0) {
      let changed = false;
      message = message.replace(/\$\{([^{}]*)\}/g, (match, content) => {
        const m = content.match(/^(\w+)((?:\[[^\]]*\])*)$/);
        if (!m) return match;
        const name = m[1];
        const brackets = m[2];
        let val = variables[name];
        if (val === undefined) return '';
        if (brackets) {
          const keys = [];
          const keyRegex = /\[([^\]]*)\]/g;
          let keyMatch;
          while ((keyMatch = keyRegex.exec(brackets)) !== null) {
            keys.push(keyMatch[1]);
          }
          for (const rawKey of keys) {
            if (val === undefined || val === null || typeof val !== 'object') return '';
            const key = resolveBracketKey(rawKey);
            const next = lookupBracketKey(val, key);
            if (next === '' && (key === '' || key.startsWith('+') || /^-\d+$/.test(key) || key.includes('..'))) {
              return next; // index forms always return final string
            }
            val = next;
          }
        }
        if (val === undefined) return '';
        changed = true;
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      });
      if (!changed) break;
    }
  }

  // Handle $var[key][subkey]... (non-brace form). Same indexing semantics
  // as the brace form above, plus nested-var resolution in the bracket key
  // (so $list[+$idx] works without forcing the user to type ${list[+${idx}]}).
  message = message.replace(/\$(\w+)((?:\[[^\]]*\])+)/g, (match, name, brackets) => {
    let val = variables[name];
    if (val === undefined) return match;
    const keys = [];
    const keyRegex = /\[([^\]]*)\]/g;
    let keyMatch;
    while ((keyMatch = keyRegex.exec(brackets)) !== null) {
      keys.push(keyMatch[1]);
    }
    for (const rawKey of keys) {
      if (val === undefined || val === null || typeof val !== 'object') return '';
      const key = resolveBracketKey(rawKey);
      const next = lookupBracketKey(val, key);
      if (next === '' && (key === '' || key.startsWith('+') || /^-\d+$/.test(key) || key.includes('..'))) {
        return next; // index forms always return final string
      }
      val = next;
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

// ─── TinTin++ expression evaluator (ported from client app.js) ───
// Used by server-side #if condition evaluation. Must stay in sync with the
// client mathexp / tintoi / tincmp / tineval functions so that #if evaluates
// the same on both sides.

function tintoi(str) {
  if (typeof str === 'number') return str;
  if (!str || str.length === 0) return 0;
  if (str.includes(':')) {
    const parts = str.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }
  const n = Number(str);
  return isNaN(n) ? 0 : n;
}

function tincmp(left, right) {
  if (left.type === 'string' && right.type === 'string') {
    return left.str < right.str ? -1 : left.str > right.str ? 1 : 0;
  }
  if (left.type === 'number' && right.type === 'number') {
    return left.val - right.val;
  }
  return 0;
}

function tineval(left, right) {
  if (left.type === 'string' && right.type === 'string') {
    try {
      const pattern = right.str
        .replace(/([.+^${}()|[\]\\])/g, '\\$1')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      const regex = new RegExp('^' + pattern + '$');
      return regex.test(left.str) ? 1 : 0;
    } catch (e) {
      return left.str === right.str ? 1 : 0;
    }
  }
  if (left.type === 'number' && right.type === 'number') {
    return left.val === right.val ? 1 : 0;
  }
  return 0;
}

function mathexpTokenize(str) {
  const nodes = [];
  let i = 0;
  let level = 0;
  let expectValue = true;
  let hasFloat = false;

  while (i < str.length) {
    if (str[i] === ' ' || str[i] === '\t') { i++; continue; }

    if (expectValue) {
      if ((str[i] >= '0' && str[i] <= '9') || (str[i] === '.' && i + 1 < str.length && str[i + 1] >= '0' && str[i + 1] <= '9')) {
        let numStr = '';
        let hasDot = false;
        while (i < str.length && ((str[i] >= '0' && str[i] <= '9') || (str[i] === '.' && !hasDot))) {
          if (str[i] === '.') { hasDot = true; hasFloat = true; }
          numStr += str[i];
          i++;
        }
        nodes.push({ type: 'number', level, priority: 14, val: Number(numStr), str: numStr });
        expectValue = false;
        continue;
      }
      if (str[i] === '"') {
        i++;
        let s = '';
        while (i < str.length && str[i] !== '"') {
          if (str[i] === '\\' && i + 1 < str.length) { s += str[i + 1]; i += 2; }
          else { s += str[i]; i++; }
        }
        if (i < str.length) i++;
        nodes.push({ type: 'string', level, priority: 14, val: tintoi(s), str: s });
        expectValue = false;
        continue;
      }
      if (str[i] === '{') {
        i++;
        let s = '';
        let depth = 1;
        while (i < str.length && depth > 0) {
          if (str[i] === '{') depth++;
          else if (str[i] === '}') { depth--; if (depth === 0) break; }
          s += str[i];
          i++;
        }
        if (i < str.length) i++;
        nodes.push({ type: 'string', level, priority: 14, val: tintoi(s), str: s });
        expectValue = false;
        continue;
      }
      if (str[i] === '(') {
        level++;
        nodes.push({ type: 'paren', level, priority: 0, val: 0, str: '(' });
        i++;
        continue;
      }
      if (str[i] === '!') {
        nodes.push({ type: 'number', level, priority: 14, val: 0, str: '0' });
        nodes.push({ type: 'operator', level, priority: 6, val: 0, str: '==' });
        i++;
        continue;
      }
      if (str[i] === '-') {
        nodes.push({ type: 'number', level, priority: 14, val: -1, str: '-1' });
        nodes.push({ type: 'operator', level, priority: 2, val: 0, str: '*' });
        i++;
        continue;
      }
      if (str[i] === '~') {
        nodes.push({ type: 'number', level, priority: 14, val: -1, str: '-1' });
        nodes.push({ type: 'operator', level, priority: 3, val: 0, str: '-' });
        i++;
        continue;
      }
      if (str[i] === '+') { i++; continue; }
      if (str[i] === '$') return false;
      i++;
    } else {
      if (str[i] === ')') {
        nodes.push({ type: 'paren', level, priority: 0, val: 0, str: ')' });
        level--;
        i++;
        continue;
      }
      if (i + 1 < str.length) {
        const two = str[i] + str[i + 1];
        if (i + 2 < str.length) {
          const three = str[i] + str[i + 1] + str[i + 2];
          if (three === '===' || three === '!==') {
            nodes.push({ type: 'operator', level, priority: 6, val: 0, str: three });
            i += 3; expectValue = true; continue;
          }
        }
        if (two === '**') { nodes.push({ type: 'operator', level, priority: 2, val: 0, str: '**' }); i += 2; expectValue = true; continue; }
        if (two === '//') { nodes.push({ type: 'operator', level, priority: 2, val: 0, str: '//' }); i += 2; expectValue = true; continue; }
        if (two === '<<') { nodes.push({ type: 'operator', level, priority: 4, val: 0, str: '<<' }); i += 2; expectValue = true; continue; }
        if (two === '>>') { nodes.push({ type: 'operator', level, priority: 4, val: 0, str: '>>' }); i += 2; expectValue = true; continue; }
        if (two === '<=') { nodes.push({ type: 'operator', level, priority: 5, val: 0, str: '<=' }); i += 2; expectValue = true; continue; }
        if (two === '>=') { nodes.push({ type: 'operator', level, priority: 5, val: 0, str: '>=' }); i += 2; expectValue = true; continue; }
        if (two === '==') { nodes.push({ type: 'operator', level, priority: 6, val: 0, str: '==' }); i += 2; expectValue = true; continue; }
        if (two === '!=') { nodes.push({ type: 'operator', level, priority: 6, val: 0, str: '!=' }); i += 2; expectValue = true; continue; }
        if (two === '&&') { nodes.push({ type: 'operator', level, priority: 10, val: 0, str: '&&' }); i += 2; expectValue = true; continue; }
        if (two === '||') { nodes.push({ type: 'operator', level, priority: 12, val: 0, str: '||' }); i += 2; expectValue = true; continue; }
        if (two === '^^') { nodes.push({ type: 'operator', level, priority: 11, val: 0, str: '^^' }); i += 2; expectValue = true; continue; }
      }
      if (str[i] === '*') { nodes.push({ type: 'operator', level, priority: 2, val: 0, str: '*' }); i++; expectValue = true; continue; }
      if (str[i] === '/') { nodes.push({ type: 'operator', level, priority: 2, val: 0, str: '/' }); i++; expectValue = true; continue; }
      if (str[i] === '%') { nodes.push({ type: 'operator', level, priority: 2, val: 0, str: '%' }); i++; expectValue = true; continue; }
      if (str[i] === '+') { nodes.push({ type: 'operator', level, priority: 3, val: 0, str: '+' }); i++; expectValue = true; continue; }
      if (str[i] === '-') { nodes.push({ type: 'operator', level, priority: 3, val: 0, str: '-' }); i++; expectValue = true; continue; }
      if (str[i] === '<') { nodes.push({ type: 'operator', level, priority: 5, val: 0, str: '<' }); i++; expectValue = true; continue; }
      if (str[i] === '>') { nodes.push({ type: 'operator', level, priority: 5, val: 0, str: '>' }); i++; expectValue = true; continue; }
      if (str[i] === '&') { nodes.push({ type: 'operator', level, priority: 7, val: 0, str: '&' }); i++; expectValue = true; continue; }
      if (str[i] === '^') { nodes.push({ type: 'operator', level, priority: 8, val: 0, str: '^' }); i++; expectValue = true; continue; }
      if (str[i] === '|') { nodes.push({ type: 'operator', level, priority: 9, val: 0, str: '|' }); i++; expectValue = true; continue; }
      if (str[i] === '?') { nodes.push({ type: 'operator', level, priority: 13, val: 0, str: '?' }); i++; expectValue = true; continue; }
      if (str[i] === ':') { nodes.push({ type: 'operator', level, priority: 13, val: 0, str: ':' }); i++; expectValue = true; continue; }
      if ((str[i] === 'd' || str[i] === 'D') && i + 1 < str.length && str[i + 1] >= '0' && str[i + 1] <= '9') {
        nodes.push({ type: 'operator', level, priority: 1, val: 0, str: 'd' });
        i++; expectValue = true; continue;
      }
      const siChar = str[i];
      if ('KMGTmunp'.includes(siChar) && nodes.length > 0 && nodes[nodes.length - 1].type === 'number') {
        const prev = nodes[nodes.length - 1];
        const siMap = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12 };
        if (siMap[siChar]) {
          prev.val *= siMap[siChar];
          i++;
          continue;
        }
      }
      i++;
    }
  }

  if (nodes.length === 0) return false;
  nodes.hasFloat = hasFloat;
  return nodes;
}

let _mathexpFloat = false;

function mathexpCompute(nodes, idx) {
  const op = nodes[idx];
  const left = nodes[idx - 1];
  const right = nodes[idx + 1];
  if (!left || !right) return;

  let result = { type: 'number', level: op.level, priority: 14, val: 0, str: '' };
  const lv = left.val;
  const rv = right.val;

  switch (op.str) {
    case '+':
      if (left.type === 'string' || right.type === 'string') {
        result.type = 'string';
        result.str = (left.type === 'string' ? left.str : String(left.val)) +
                     (right.type === 'string' ? right.str : String(right.val));
        result.val = tintoi(result.str);
      } else {
        result.val = lv + rv;
      }
      break;
    case '-': result.val = lv - rv; break;
    case '*': result.val = lv * rv; break;
    case '/': result.val = rv !== 0 ? (_mathexpFloat ? lv / rv : Math.trunc(lv / rv)) : 0; break;
    case '%': result.val = rv !== 0 ? (_mathexpFloat ? lv % rv : Math.trunc(lv) % Math.trunc(rv)) : 0; break;
    case '**': result.val = Math.pow(lv, rv); break;
    case '//': result.val = rv !== 0 ? Math.pow(lv, 1 / rv) : 0; break;
    case '<<': result.val = Math.trunc(lv) << Math.trunc(rv); break;
    case '>>': result.val = Math.trunc(lv) >> Math.trunc(rv); break;
    case '<': result.val = tincmp(left, right) < 0 ? 1 : 0; break;
    case '>': result.val = tincmp(left, right) > 0 ? 1 : 0; break;
    case '<=': result.val = tincmp(left, right) <= 0 ? 1 : 0; break;
    case '>=': result.val = tincmp(left, right) >= 0 ? 1 : 0; break;
    case '==': result.val = tineval(left, right) ? 1 : 0; break;
    case '!=': result.val = tineval(left, right) ? 0 : 1; break;
    case '===': result.val = tincmp(left, right) === 0 ? 1 : 0; break;
    case '!==': result.val = tincmp(left, right) !== 0 ? 1 : 0; break;
    case '&': result.val = Math.trunc(lv) & Math.trunc(rv); break;
    case '^': result.val = Math.trunc(lv) ^ Math.trunc(rv); break;
    case '|': result.val = Math.trunc(lv) | Math.trunc(rv); break;
    case '&&': result.val = (lv !== 0 && rv !== 0) ? 1 : 0; break;
    case '||': result.val = (lv !== 0 || rv !== 0) ? 1 : 0; break;
    case '^^': result.val = ((lv !== 0) !== (rv !== 0)) ? 1 : 0; break;
    case 'd': {
      let total = 0;
      const count = Math.max(1, Math.trunc(lv));
      const sides = Math.max(1, Math.trunc(rv));
      for (let r = 0; r < count; r++) {
        total += Math.floor(Math.random() * sides) + 1;
      }
      result.val = total;
      break;
    }
    case '?': {
      let colonIdx = -1;
      for (let j = idx + 2; j < nodes.length; j++) {
        if (nodes[j].type === 'operator' && nodes[j].str === ':' && nodes[j].level === op.level) {
          colonIdx = j;
          break;
        }
      }
      if (colonIdx !== -1 && colonIdx + 1 < nodes.length) {
        const falseNode = nodes[colonIdx + 1];
        if (lv !== 0) result = { ...right, level: op.level, priority: 14 };
        else result = { ...falseNode, level: op.level, priority: 14 };
        nodes.splice(colonIdx, 2);
      } else {
        result = lv !== 0 ? { ...right, level: op.level, priority: 14 } : { type: 'number', level: op.level, priority: 14, val: 0, str: '' };
      }
      break;
    }
    case ':': result = { ...right, level: op.level, priority: 14 }; break;
  }

  nodes.splice(idx - 1, 3, result);
}

function mathexpLevel(nodes, startIdx, endIdx) {
  for (let pri = 0; pri <= 13; pri++) {
    let j = startIdx;
    while (j <= endIdx && j < nodes.length) {
      const node = nodes[j];
      if (node.type === 'operator' && node.priority === pri) {
        mathexpCompute(nodes, j);
        endIdx -= 2;
      } else {
        j++;
      }
    }
  }
}

function mathexp(str) {
  if (!str || typeof str !== 'string') {
    return { val: 0, str: '', type: 'number' };
  }
  const nodes = mathexpTokenize(str.trim());
  if (!nodes || nodes.length === 0) {
    return { val: 0, str: '', type: 'number' };
  }
  _mathexpFloat = nodes.hasFloat || false;

  let maxLevel = 0;
  for (const n of nodes) {
    if (n.level > maxLevel) maxLevel = n.level;
  }

  for (let lev = maxLevel; lev >= 0; lev--) {
    let start = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].type === 'paren' && nodes[i].str === '(' && nodes[i].level === lev) {
        start = i;
      } else if (nodes[i].type === 'paren' && nodes[i].str === ')' && nodes[i].level === lev) {
        if (start !== -1) {
          mathexpLevel(nodes, start + 1, i - 1);
          let openIdx = -1, closeIdx = -1;
          for (let k = 0; k < nodes.length; k++) {
            if (nodes[k].type === 'paren' && nodes[k].str === '(' && nodes[k].level === lev) openIdx = k;
            if (nodes[k].type === 'paren' && nodes[k].str === ')' && nodes[k].level === lev) { closeIdx = k; break; }
          }
          if (openIdx !== -1 && closeIdx !== -1) {
            nodes.splice(closeIdx, 1);
            nodes.splice(openIdx, 1);
          }
          start = -1;
          i = -1;
        }
      }
    }
    let rangeStart = -1, rangeEnd = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].level === lev) {
        if (rangeStart === -1) rangeStart = i;
        rangeEnd = i;
      }
    }
    if (rangeStart !== -1) {
      mathexpLevel(nodes, rangeStart, rangeEnd);
    }
  }

  if (nodes.length > 0) return nodes[0];
  return { val: 0, str: '', type: 'number' };
}

function evaluateCondition(condition) {
  if (!condition) return false;
  const cond = condition
    .replace(/\band\b/gi, '&&')
    .replace(/\bor\b/gi, '||')
    .replace(/\bxor\b/gi, '^^')
    .replace(/\bnot\b/gi, '!');
  const result = mathexp(cond);
  return result.type === 'string' ? result.str.length > 0 : result.val !== 0;
}

// Port of client parseIfChain: splits an #if body into
// [{condition, commands}, ...] handling positional else and #elseif/#else.
function parseIfChain(str) {
  const parts = [];
  let current = { condition: null, commands: null };
  let depth = 0;
  let buffer = '';
  let state = 'condition';

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '{') {
      if (depth === 0) {
        if (state === 'between') {
          current.condition = '1';
          state = 'commands';
        }
        depth++;
        continue;
      }
      depth++;
      buffer += char;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        if (state === 'condition') {
          current.condition = buffer.trim();
          buffer = '';
          state = 'commands';
        } else if (state === 'commands') {
          current.commands = buffer.trim();
          parts.push(current);
          current = { condition: null, commands: null };
          buffer = '';
          state = 'between';
        }
        continue;
      }
      buffer += char;
    } else if (depth > 0) {
      buffer += char;
    } else if (state === 'between') {
      const remaining = str.substring(i).trim();
      if (remaining.startsWith('#elseif') || remaining.startsWith('#elif')) {
        const match = remaining.match(/^#(?:elseif|elif)\s*/);
        if (match) {
          i += match[0].length - 1;
          state = 'condition';
        }
      } else if (remaining.startsWith('#else')) {
        const match = remaining.match(/^#else\s*/);
        if (match) {
          i += match[0].length - 1;
          current.condition = '1';
          state = 'commands';
        }
      }
    }
  }
  return parts;
}

// Server-side inline command processing
// Canonical command registry: assets/js/app.js COMMAND_REGISTRY
// Commands with serverInline: true are handled here:
//   #math, #var/#variable, #unvar/#unvariable, #format, #cat, #replace,
//   #line oneshot, #line gag, #if
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
      // Push change to client so it stays in sync (prevents stale sync overwrite after 2s window)
      sendToClient(session, { type: 'var_update', variables: { [varName]: result } });
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
    // Push change to client so it stays in sync
    sendToClient(session, { type: 'var_update', variables: { [varName]: value } });
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
    // Push deletion to client
    sendToClient(session, { type: 'var_update', deleted: [varName] });
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
      sendToClient(session, { type: 'var_update', variables: { [varName]: result } });
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
      sendToClient(session, { type: 'var_update', variables: { [varName]: current } });
    }
    return true;
  }

  // #line oneshot #action {pattern} {commands} [priority]
  // Also handles: #line oneshot #act, #line oneshot #gag, #line oneshot #highlight
  const lineOneshotMatch = trimmed.match(/^#line\s+oneshot\s+#(action|act|gag|highlight|high)\s+(.*)/i);
  if (lineOneshotMatch) {
    const triggerType = lineOneshotMatch[1].toLowerCase();
    const triggerArgs = parseBracedArgs(lineOneshotMatch[2]);
    if (triggerArgs.length >= 1) {
      const pattern = triggerArgs[0];
      const id = 'oneshot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const actions = [];

      if (triggerType === 'gag') {
        actions.push({ type: 'gag' });
      } else if (triggerType === 'highlight' || triggerType === 'high') {
        // #line oneshot #highlight {pattern} {color}
        const color = triggerArgs[1] || '';
        actions.push({ type: 'highlight', fgColor: color });
      } else {
        // #action/#act: second arg is command body
        const command = triggerArgs[1] || '';
        actions.push({ type: 'command', command: command });
      }

      const priority = triggerArgs[2] ? parseInt(triggerArgs[2]) || 5 : 5;

      const trigger = {
        id,
        name: `[oneshot] ${pattern.substring(0, 30)}`,
        pattern,
        matchType: isTinTinPattern(pattern) ? 'tintin' : 'substring',
        actions,
        priority,
        enabled: true,
        oneshot: true,
        class: null
      };

      if (!session.triggers) session.triggers = [];
      session.triggers.push(trigger);
    }
    return true;
  }

  // #line gag (standalone, outside of trigger context — handled in processTriggers for trigger context)
  if (/^#line\s+gag\s*$/i.test(trimmed)) {
    // When used from a command (not trigger), this is a no-op since there's no "current line"
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
        sendToClient(session, { type: 'var_update', variables: { [varName]: session.variables[varName] } });
      }
    }
    return true;
  }

  // #if {condition} {true_cmds} [{else_cmds}]
  //   or  #if {cond} {true} [#elseif {cond} {cmds}] [#else {cmds}]
  //
  // Why server-side: #if branches often contain #var/#math for server-owned
  // variables. If #if is evaluated on the client, inner #var updates lose the
  // sync race against `_varServerModified`-protected server values (every
  // HP-tick #math refreshes the 2s window). Evaluating #if on the server lets
  // inner #var/#math execute inline via serverProcessInlineCommand.
  const ifMatch = trimmed.match(/^#if\s+(.*)$/is);
  if (ifMatch) {
    const chain = parseIfChain(ifMatch[1]);
    if (chain.length === 0) return true; // malformed — swallow

    if (!session._ifDepth) session._ifDepth = 0;
    if (session._ifDepth > 20) {
      session._ifDepth = 0;
      return true;
    }
    session._ifDepth++;

    try {
      const isBotIf = chain.some(p => /walk$|step\d|puppybot|smurfbot|zellbot|celbot|spiritbot|chessbot|alphabot|rimbot|zombiebot/.test(p.commands));
      const botTrace = [];
      let matched = false;
      for (const part of chain) {
        const substituted = substituteUserVariables(part.condition, session.variables || {}, session.functions || {});
        const result = evaluateCondition(substituted);
        if (isBotIf) {
          botTrace.push({ cond: part.condition, sub: substituted, result, cmds: part.commands });
        }
        if (result) {
          matched = true;
          // Run the branch through the same pipeline the trigger dispatcher uses:
          // expandCommandWithAliases calls serverProcessInlineCommand for inline
          // server-handled # commands (recursing into nested #if), substitutes
          // vars in other # commands, and alias-expands plain commands.
          const expanded = expandCommandWithAliases(part.commands, session.aliases || [], 0, session.variables || {}, session.functions || {}, session);
          // DEBUG: log bot-related #if expansions
          if (/walk$|step\d/.test(part.commands)) {
            console.log(`[IF_DBG] char=${session.characterName||'?'} branch=${part.commands} expanded=${expanded.length} cmds=${JSON.stringify(expanded.slice(0,8))} mudOK=${!!(session.mudSocket && !session.mudSocket.destroyed)} depth=${session._ifDepth}`);
          }
          expanded.forEach(ec => {
            const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
            if (repeatMatch) {
              executeRepeat(Math.min(parseInt(repeatMatch[1]), 100), repeatMatch[2], session);
            } else if (ec.startsWith('#')) {
              sendToClient(session, { type: 'client_command', command: ec });
            } else if (session.mudSocket && !session.mudSocket.destroyed) {
              session.mudSocket.write(processEscapes(ec) + '\r\n');
            }
          });
          break;
        }
      }
      if (isBotIf && !matched) {
        const v = session.variables || {};
        const mod = session._varServerModified || {};
        const now = Date.now();
        const relevant = ['puppybot','smurfbot','zellbot','celbot','spiritbot','chessbot','alphabot','rimbot','zombiebot','botting','puppystepnumber','zellstepnumber','smurfstepnumber'];
        const vars = {};
        relevant.forEach(k => {
          if (k in v || k in mod) vars[k] = `${v[k]===undefined?'<unset>':JSON.stringify(v[k])}${mod[k]?`(${Math.round((now-mod[k])/1000)}s)`:''}`;
        });
        console.log(`[IF_FALSE] char=${session.characterName||'?'} trace=${JSON.stringify(botTrace)} vars=${JSON.stringify(vars)} depth=${session._ifDepth}`);
      }
    } catch (ifErr) {
      console.error(`[IF_ERR] char=${session.characterName||'?'} err=${ifErr.message} stack=${(ifErr.stack||'').substring(0,500)}`);
    } finally {
      session._ifDepth--;
    }
    return true;
  }

  // #regex {string} {pattern} {true_cmds} [false_cmds]
  // Also matches #regexp. Server-side regex matching with &N capture substitution.
  // Without this server-side, HP/mana/stat extraction triggers silently buffer
  // to the client when no browser is connected, leaving variables stale.
  const regexCmdMatch = trimmed.match(/^#regexp?\s+(.*)/is);
  if (regexCmdMatch) {
    const rargs = parseBracedArgs(regexCmdMatch[1]);
    if (rargs.length >= 3) {
      const rawString = rargs[0];
      const expression = rargs[1];
      const trueCmd = rargs[2];
      const falseCmd = rargs[3] || '';

      // Substitute variables in the string to match against
      const matchString = substituteUserVariables(rawString, session.variables || {}, session.functions || {});

      try {
        const regexPattern = tinTinToRegex(expression);
        const regex = new RegExp(regexPattern);
        const match = matchString.match(regex);

        let branchCmd = '';
        if (match) {
          // Substitute &0, &1, ... &99 with captured groups
          branchCmd = trueCmd;
          for (let ri = 0; ri < match.length && ri < 100; ri++) {
            branchCmd = branchCmd.replace(new RegExp('&' + ri + '(?![0-9])', 'g'), match[ri] || '');
          }
          // Clean up unreplaced &N references
          branchCmd = branchCmd.replace(/&\d+/g, '');
        } else if (falseCmd) {
          branchCmd = falseCmd;
        }

        if (branchCmd) {
          // Run through the same pipeline as #if branches
          const expanded = expandCommandWithAliases(branchCmd, session.aliases || [], 0, session.variables || {}, session.functions || {}, session);
          expanded.forEach(ec => {
            const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
            if (repeatMatch) {
              executeRepeat(Math.min(parseInt(repeatMatch[1]), 100), repeatMatch[2], session);
            } else if (ec.startsWith('#')) {
              sendToClient(session, { type: 'client_command', command: ec });
            } else if (session.mudSocket && !session.mudSocket.destroyed) {
              session.mudSocket.write(processEscapes(ec) + '\r\n');
            }
          });
        }
      } catch (e) {
        // Bad regex — swallow silently (matches client behavior)
      }

      return true;
    }
  }

  // #delay {seconds} {command}            (anonymous — TinTin++ standard)
  // #delay {name}    {command} {seconds}  (named — cancellable via #undelay)
  //
  // Server-side delayed execution. The command fires through the full
  // expansion pipeline (alias expansion, #var/#math/#if server-side)
  // after the specified delay. Unlike the client-side #delay (which
  // uses browser setTimeout and dies when the phone screen sleeps),
  // server-side delays survive browser disconnect — critical for bots
  // that use #delay in their stepping chains.
  //
  // Variables in the command are substituted at FIRE time (not schedule
  // time), matching TinTin++ behavior. The seconds arg is substituted
  // immediately (we need its numeric value for setTimeout).
  //
  // Anonymous form is critical for triggers like the ring-skill ones that
  // chain `#sub {x} {...}; #delay {2} {#unsub {x}}; #sub {y} {...}; #delay {2} {#unsub {y}}`
  // — if both got the same name "2", each new schedule clears the prior
  // timer and the un-subs leak forever. Anonymous delays get unique
  // counter-based names so they coexist.
  const delayMatch = trimmed.match(/^#delay\s+(.*)/i);
  if (delayMatch) {
    const dargs = parseBracedArgs(delayMatch[1]);
    if (dargs.length >= 2) {
      let name, command, rawSeconds;
      if (dargs.length === 2) {
        // Anonymous: {seconds} {command}
        rawSeconds = dargs[0];
        command = dargs[1];
        if (!session._delayCounter) session._delayCounter = 0;
        // Timestamp prefix avoids collision with anonymous timers restored
        // from persistence after a server restart (their counter resets to 0).
        name = '__anon_' + Date.now() + '_' + (++session._delayCounter);
      } else {
        // Named: {name} {command} {seconds}
        name = dargs[0];
        command = dargs[1];
        rawSeconds = dargs[2];
      }
      const subSeconds = substituteUserVariables(rawSeconds, session.variables || {}, session.functions || {});
      let seconds = parseFloat(subSeconds);
      if (isNaN(seconds) || seconds < 0) seconds = 1;
      // 24-hour cap. Original 300s cap (from 2026-04-11 when server-side #delay
      // was first implemented) silently clamped legit cooldown timers — Nathan's
      // {Smurfs} 1-hour reminder was firing at 5 minutes. 86400s covers any
      // practical bot reminder while still bounding setTimeout memory.
      seconds = Math.min(seconds, 86400);

      if (!session._delays) session._delays = {};
      if (session._delays[name]) {
        clearTimeout(session._delays[name]);
      }

      const delayMs = seconds * 1000;
      const timer = setTimeout(() => {
        delete session._delays[name];
        const expanded = expandCommandWithAliases(command, session.aliases || [], 0, session.variables || {}, session.functions || {}, session);
        expanded.forEach(ec => {
          const repeatMatch = ec.match(/^#(\d+)\s+(.+)$/);
          if (repeatMatch) {
            executeRepeat(Math.min(parseInt(repeatMatch[1]), 100), repeatMatch[2], session);
          } else if (ec.startsWith('#')) {
            sendToClient(session, { type: 'client_command', command: ec });
          } else if (session.mudSocket && !session.mudSocket.destroyed) {
            session.mudSocket.write(processEscapes(ec) + '\r\n');
          }
        });
      }, delayMs);
      // Attach metadata for serialization during persist. Node's
      // setTimeout doesn't expose remaining time, so we store the
      // absolute fire time and the original command.
      timer._wmt_fireAt = Date.now() + delayMs;
      timer._wmt_command = command;
      session._delays[name] = timer;

      return true;
    }
  }

  // #undelay {name}
  const undelayMatch = trimmed.match(/^#undelay\s+(.*)/i);
  if (undelayMatch) {
    const uargs = parseBracedArgs(undelayMatch[1]);
    const name = uargs[0] || undelayMatch[1].trim();
    if (session._delays && session._delays[name]) {
      clearTimeout(session._delays[name]);
      delete session._delays[name];
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
    if (session.wsClients.size > 0) {
      try {
        if (BRIDGE_URL) {
          sendToClient(session, {
            type: 'system',
            subtype: 'status_only',
            message: 'WMT WebSocket updating...'
          });
        } else {
          sendToClient(session, {
            type: 'system',
            message: 'Server restarting — reconnecting automatically...'
          });
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
    // Close SQLite database cleanly
    if (wmtDb) {
      try { wmtDb.close(); console.log('SQLite database closed.'); } catch (e) {}
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

  // Prune old chat messages once on startup (30-day retention)
  if (wmtDb) {
    try { dbStmts.pruneOldChat.run(); } catch (e) {}
  }

  // Periodic session snapshot — every 30s, persist variables + delays
  // so a failed SIGTERM loses at most 30 seconds of state. The full
  // SIGTERM persist (with chatBuffer) still runs on shutdown; this is
  // the safety net. Starts after a 10s delay to let initial restore
  // and browser reconnects settle.
  setTimeout(() => {
    setInterval(() => persistSnapshot(), 30000);
  }, 10000);

  // Restore persistent sessions after startup
  if (BRIDGE_URL) {
    // Bridge mode: triggered from the bridge `open` handler in connectToBridge()
    // (gated by bridgeRestoreDone) so restore runs as soon as the bridge handshake
    // completes — well before any browser can race the in-memory sessions map.
    // No setTimeout here.
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
