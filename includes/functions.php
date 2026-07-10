<?php
/**
 * WMT Client Helper Functions
 */

require_once __DIR__ . '/../config/config.php';

/**
 * GET data from Lightsail wmt-server (authoritative DB read). Returns the
 * decoded JSON body on 200/success, null on any error. The caller decides
 * whether a null response should fall back, surface a 503, or whatever —
 * there is no JSON fallback here by design now that DB is source of truth.
 *
 * Path is the endpoint path (e.g. "/admin/triggers"); characterId is appended
 * as a query param.
 */
function fetchFromLightsail(string $path, string $characterId): ?array {
    $adminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;
    if (!$adminKey) return null;
    $url = 'https://ws.wemudtogether.com' . $path . '?characterId=' . urlencode($characterId);
    $ctx = stream_context_create([
        'http' => [
            'method' => 'GET',
            'header' => "X-Admin-Key: $adminKey\r\n",
            'timeout' => 5,
            'ignore_errors' => true
        ],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]
    ]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) return null;
    $data = json_decode($body, true);
    if (!is_array($data) || empty($data['success'])) return null;
    return $data;
}

/**
 * POST data to a Lightsail wmt-server admin endpoint. Mirror of
 * fetchFromLightsail() for write paths. Returns the decoded JSON body on
 * success, null on any error.
 *
 * Used to keep the Lightsail DB in sync with IONOS JSON writes (e.g.
 * createCharacter writes the JSON file on IONOS AND posts to
 * /admin/character so the DB row is created at the same time).
 *
 * Non-fatal on network failure — caller decides whether to retry, log, or
 * just shrug. The IONOS-side write is always the authoritative one for the
 * user's UI; this is the sync best-effort.
 */
function pushToLightsail(string $path, array $payload): ?array {
    $adminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;
    if (!$adminKey) return null;
    $url = 'https://ws.wemudtogether.com' . $path;
    $body = json_encode($payload);
    $ctx = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "X-Admin-Key: $adminKey\r\nContent-Type: application/json\r\n",
            'content' => $body,
            'timeout' => 5,
            'ignore_errors' => true
        ],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]
    ]);
    $resp = @file_get_contents($url, false, $ctx);
    if ($resp === false) return null;
    $data = json_decode($resp, true);
    if (!is_array($data) || empty($data['success'])) return null;
    return $data;
}

/**
 * Fetch the current IP ban list from Lightsail and check whether the given
 * IP is banned. Returns ['banned' => bool, 'reason' => string|null]. Network
 * failures fall through to ['banned' => false] — open by default so a
 * Lightsail outage doesn't lock everyone out of registration.
 *
 * Used by api/auth.php register flow (added 2026-05-10) so a banned griefer
 * can't just create another WMT account from the same IP after his existing
 * IPs are banned. Honest about scope: he can still rotate VPN. This is a
 * speed bump, not a wall.
 */
function isIpBanned(string $ip): array {
    $adminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;
    if (!$adminKey || empty($ip)) return ['banned' => false, 'reason' => null];

    $url = 'https://ws.wemudtogether.com/ip-bans';
    $ctx = stream_context_create([
        'http' => [
            'method' => 'GET',
            'header' => "X-Admin-Key: $adminKey\r\n",
            'timeout' => 3,
            'ignore_errors' => true
        ],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]
    ]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) return ['banned' => false, 'reason' => null];
    $data = json_decode($body, true);
    if (!is_array($data) || empty($data['success']) || !isset($data['bans'])) {
        return ['banned' => false, 'reason' => null];
    }

    foreach ($data['bans'] as $ban) {
        $type = $ban['type'] ?? '';
        $value = $ban['value'] ?? '';
        if ($type === 'ip' && $value === $ip) {
            return ['banned' => true, 'reason' => $ban['reason'] ?? 'Banned by admin'];
        }
        if ($type === 'cidr' && ipInCidr($ip, $value)) {
            return ['banned' => true, 'reason' => $ban['reason'] ?? 'Banned by admin (CIDR)'];
        }
        // ASN bans need an ipinfo lookup — skip in PHP path to avoid the
        // extra network hop. Lightsail's WS auth still enforces ASN bans
        // when the user tries to actually connect.
    }
    return ['banned' => false, 'reason' => null];
}

/**
 * Per-/24 registration rate limit.
 *
 * Returns ['allowed' => bool, 'reason' => string|null]. Counts the number
 * of registrations from the IP's /24 subnet within the last 24 hours; if
 * the count meets or exceeds REG_LIMIT_PER_24H, blocks the registration.
 *
 * Storage: data/logs/registration_attempts.json. The file is a flat list of
 * `{ip, ts}` entries; old entries (> 24h) are pruned on every check so the
 * file doesn't grow unbounded. Concurrent writes are guarded with flock so
 * two simultaneous registrations can't both pass the check by reading stale
 * state.
 *
 * Recurring abuse pattern (Yggdrasil/Dwolin attacker, 2026-05): comes back
 * monthly and creates 3+ throwaway WMT accounts from the same VPN range
 * within minutes. This rate limit caps that to 2 per /24 per 24h. Legit
 * household/family signups still pass since they happen rarely; if it ever
 * blocks a real user they'll know to wait or contact admin.
 */
const REG_LIMIT_PER_24H = 2;
const REG_WINDOW_SECONDS = 86400;

function checkRegistrationRateLimit(string $ip): array {
    if (empty($ip)) return ['allowed' => true, 'reason' => null];
    if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        // IPv6 or malformed — skip rate limit (don't block legit users
        // on networks we don't have /24 logic for).
        return ['allowed' => true, 'reason' => null];
    }

    $logDir = __DIR__ . '/../data/logs';
    @mkdir($logDir, 0755, true);
    $path = $logDir . '/registration_attempts.json';

    // Compute /24 of the requesting IP.
    $ipLong = ip2long($ip);
    if ($ipLong === false) return ['allowed' => true, 'reason' => null];
    $subnet24 = long2ip($ipLong & 0xFFFFFF00);

    $now = time();
    $cutoff = $now - REG_WINDOW_SECONDS;

    // Open the file with an exclusive lock so the read-prune-check-write
    // sequence is atomic. The window is short; contention should be near-
    // zero in practice.
    $fp = @fopen($path, 'c+');
    if (!$fp) {
        // Filesystem error — fail open, log, but don't block legit users.
        @error_log("checkRegistrationRateLimit: cannot open $path");
        return ['allowed' => true, 'reason' => null];
    }

    try {
        if (!flock($fp, LOCK_EX)) {
            fclose($fp);
            return ['allowed' => true, 'reason' => null];
        }
        $raw = stream_get_contents($fp);
        $entries = $raw ? json_decode($raw, true) : [];
        if (!is_array($entries)) $entries = [];

        // Prune entries older than the window.
        $entries = array_values(array_filter($entries, function($e) use ($cutoff) {
            return is_array($e) && isset($e['ts']) && $e['ts'] >= $cutoff;
        }));

        // Count entries from the same /24.
        $matches = 0;
        foreach ($entries as $e) {
            if (!isset($e['ip'])) continue;
            $entryLong = ip2long($e['ip']);
            if ($entryLong === false) continue;
            $entrySubnet = long2ip($entryLong & 0xFFFFFF00);
            if ($entrySubnet === $subnet24) $matches++;
        }

        if ($matches >= REG_LIMIT_PER_24H) {
            // Don't append — they're being blocked, not registered.
            // Write back the pruned list so old entries don't accumulate.
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, json_encode($entries));
            flock($fp, LOCK_UN);
            fclose($fp);
            return [
                'allowed' => false,
                'reason' => "Registration limit reached for this network ($matches in last 24h)"
            ];
        }

        // Append this attempt and write back.
        $entries[] = ['ip' => $ip, 'ts' => $now];
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($entries));
        flock($fp, LOCK_UN);
        fclose($fp);
        return ['allowed' => true, 'reason' => null];
    } catch (\Throwable $e) {
        @error_log("checkRegistrationRateLimit: " . $e->getMessage());
        @flock($fp, LOCK_UN);
        @fclose($fp);
        return ['allowed' => true, 'reason' => null];
    }
}

/**
 * Test if an IPv4 falls inside a CIDR range (e.g., "10.0.0.0/8").
 * Returns false on parse error rather than throwing.
 */
function ipInCidr(string $ip, string $cidr): bool {
    if (strpos($cidr, '/') === false) return false;
    list($subnet, $bits) = explode('/', $cidr, 2);
    $bits = (int)$bits;
    if ($bits < 0 || $bits > 32) return false;
    $ipLong = ip2long($ip);
    $subnetLong = ip2long($subnet);
    if ($ipLong === false || $subnetLong === false) return false;
    if ($bits === 0) return true;
    $mask = (-1 << (32 - $bits)) & 0xFFFFFFFF;
    return ($ipLong & $mask) === ($subnetLong & $mask);
}

/**
 * POST a full-list bulk replace to a Lightsail admin endpoint.
 * Used by PHP save handlers so writes reach DB even if the user's WS is
 * disconnected at save time. Returns true on 2xx success, false otherwise.
 * Fire-and-forget tone: short timeout, errors logged but not surfaced.
 */
function pushBulkToLightsail(string $endpoint, string $listKey, string $characterId, array $list): bool {
    $adminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;
    if (!$adminKey) return false;
    $url = 'https://ws.wemudtogether.com' . $endpoint;
    $payload = json_encode(['characterId' => $characterId, $listKey => $list]);
    $ctx = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\nX-Admin-Key: $adminKey\r\n",
            'content' => $payload,
            'timeout' => 5,
            'ignore_errors' => true
        ],
        'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]
    ]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) {
        @error_log("pushBulkToLightsail: HTTP failed for $endpoint cid=$characterId");
        return false;
    }
    $data = json_decode($body, true);
    if (!is_array($data) || empty($data['success'])) {
        @error_log("pushBulkToLightsail: non-success for $endpoint cid=$characterId body=" . substr($body, 0, 200));
        return false;
    }
    return true;
}

/**
 * Authoritative single-user read with JSON-divergence safety net.
 * Tries Lightsail DB via GET /admin/user. If DB has no record (or is unreachable)
 * AND the JSON users_index has a matching user, returns the JSON record.
 * `lookupKind` is 'id', 'username', or 'email'. `lookupValue` is the value to match.
 * Returns null if neither DB nor JSON has the user.
 */
function userWithJsonFallback(string $lookupKind, string $lookupValue): ?array {
    $resp = fetchFromLightsail('/admin/user', ''); // path; we'll override the URL below
    // fetchFromLightsail builds ?characterId=. We need ?id|username|email=. Inline the call.
    $adminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;
    $dbUser = null;
    if ($adminKey) {
        $url = 'https://ws.wemudtogether.com/admin/user?' . urlencode($lookupKind) . '=' . urlencode($lookupValue);
        $ctx = stream_context_create([
            'http' => ['method' => 'GET', 'header' => "X-Admin-Key: $adminKey\r\n", 'timeout' => 5, 'ignore_errors' => true],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]
        ]);
        $body = @file_get_contents($url, false, $ctx);
        if ($body !== false) {
            $data = json_decode($body, true);
            if (is_array($data) && !empty($data['success'])) {
                $dbUser = $data['user'] ?? null;
            }
        }
    }
    if ($dbUser !== null) return $dbUser;

    // Fall back to JSON users_index
    $usersPath = USERS_PATH . '/users_index.json';
    if (!file_exists($usersPath)) return null;
    $users = loadJsonFile($usersPath);
    if (!is_array($users)) return null;
    $needle = strtolower($lookupValue);
    foreach ($users as $u) {
        if (!is_array($u)) continue;
        $hit = false;
        if ($lookupKind === 'id' && ($u['id'] ?? '') === $lookupValue) $hit = true;
        elseif ($lookupKind === 'username' && strtolower($u['username'] ?? '') === $needle) $hit = true;
        elseif ($lookupKind === 'email' && strtolower($u['email'] ?? '') === $needle) $hit = true;
        if ($hit) {
            @error_log("userWithJsonFallback: JSON fallback for $lookupKind=$lookupValue");
            return $u;
        }
    }
    return null;
}

/**
 * Authoritative full users index with JSON safety net.
 */
function usersIndexWithJsonFallback(): array {
    $adminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;
    $dbUsers = null;
    if ($adminKey) {
        $url = 'https://ws.wemudtogether.com/admin/users';
        $ctx = stream_context_create([
            'http' => ['method' => 'GET', 'header' => "X-Admin-Key: $adminKey\r\n", 'timeout' => 5, 'ignore_errors' => true],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]
        ]);
        $body = @file_get_contents($url, false, $ctx);
        if ($body !== false) {
            $data = json_decode($body, true);
            if (is_array($data) && !empty($data['success']) && is_array($data['users'] ?? null)) {
                $dbUsers = $data['users'];
            }
        }
    }
    // Always also load JSON index — we'll merge so JSON-only entries (DB drift) survive.
    $usersPath = USERS_PATH . '/users_index.json';
    $jsonUsers = file_exists($usersPath) ? loadJsonFile($usersPath) : [];
    $jsonUsers = is_array($jsonUsers) ? $jsonUsers : [];

    if ($dbUsers === null) {
        // DB unreachable — JSON only
        return $jsonUsers;
    }
    // Merge: DB authoritative for users that exist in DB, JSON-only users get included too.
    $byId = [];
    foreach ($dbUsers as $u) {
        if (is_array($u) && isset($u['id'])) $byId[$u['id']] = $u;
    }
    foreach ($jsonUsers as $u) {
        if (is_array($u) && isset($u['id']) && !isset($byId[$u['id']])) {
            @error_log('usersIndexWithJsonFallback: JSON-only user ' . $u['id']);
            $byId[$u['id']] = $u;
        }
    }
    return array_values($byId);
}

/**
 * DB-only list read for the migrated tables (triggers/aliases/tickers/classes).
 *
 * Returns the list on success (possibly empty — an empty DB IS the truth),
 * or null when Lightsail is unreachable so callers can 503 cleanly instead
 * of silently diverging.
 *
 * HISTORY: this replaced listWithJsonFallback on 2026-07-10 when the JSON
 * dual-store was retired. The fallback dated from the 2026-04-27 read-path
 * switchover that shipped before auditing DB completeness; a full divergence
 * audit (all 235 char dirs vs DB) ran clean on 2026-07-10 — every JSON-only
 * item was backfilled into the DB first (Remiel + 3 stray tickers), and the
 * remaining JSON-vs-DB drift was verified stale-JSON (in-game deletions that
 * correctly never wrote back to JSON). See project_database_migration.md.
 */
function dbList(string $endpoint, string $listKey, string $characterId): ?array {
    $resp = fetchFromLightsail($endpoint, $characterId);
    if ($resp === null) return null;
    return (isset($resp[$listKey]) && is_array($resp[$listKey])) ? $resp[$listKey] : [];
}

/**
 * Sync data (preferences, scripts) to Lightsail DB.
 * Fire-and-forget: short timeout, ignore failures.
 */
function syncDataToDb(array $payload): void {
    $adminKey = defined('RENDER_ADMIN_KEY') ? RENDER_ADMIN_KEY : null;
    if (!$adminKey) return;

    $url = 'https://ws.wemudtogether.com/data-sync';
    $body = json_encode($payload);

    $ctx = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\nX-Admin-Key: $adminKey\r\n",
            'content' => $body,
            'timeout' => 3,
            'ignore_errors' => true
        ],
        'ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true
        ]
    ]);

    @file_get_contents($url, false, $ctx);
}

/**
 * Append a line to the login audit CSV.
 * If IP geo data isn't provided, does an inline lookup (adds ~100ms).
 */
function auditLog(string $activity, string $account, string $character, string $realm, string $ip, string $country = '', string $city = '', string $asn = ''): void {
    $logDir = __DIR__ . '/../data/logs';
    if (!is_dir($logDir)) @mkdir($logDir, 0755, true);
    $csvFile = $logDir . '/login_audit.csv';
    $expectedHeader = "timestamp,activity,account,character,realm,ip,country,city,asn";
    if (!file_exists($csvFile)) {
        @file_put_contents($csvFile, $expectedHeader . "\n", LOCK_EX);
    }
    // (The pre-activity-column header migration that used to run here completed
    // 2026-04-08; removed 2026-07-09 — it re-read the header on every event and
    // leaked the file handle.)

    // Enrich IP if geo data not provided — cached per IP so we don't hammer ipinfo's
    // rate-limited free tier (and skip the up-to-2s blocking lookup on repeat IPs).
    if ($ip && !$country && !$asn) {
        $geo = geoLookupCached($ip);
        $country = $geo['country']; $city = $geo['city']; $asn = $geo['asn'];
    }

    // fputcsv, not string-concat: a comma/quote/newline in any field (ASN org
    // names like "Amazon.com, Inc.") would otherwise shift the columns, and the
    // report reader silently DROPS rows whose column count doesn't match.
    $fh = @fopen($csvFile, 'a');
    if ($fh) {
        @flock($fh, LOCK_EX);
        fputcsv($fh, [date('c'), $activity, $account, $character, strtoupper($realm), $ip, $country, $city, $asn]);
        @flock($fh, LOCK_UN);
        fclose($fh);
    }

    // Keep the audit CSV bounded — report_query.php loads the WHOLE file each request.
    // Self-limited to once per day via a marker, so this is a cheap no-op almost always.
    auditPruneOncePerDay($csvFile);
    // Heavier server logs (auth.log/security.csv/security_scan.log) — pruned WEEKLY,
    // marker-gated, so this is a cheap no-op on all but the first call each week.
    pruneServerLogsWeekly();
}

/**
 * IP geo lookup with a per-IP file cache (data/logs/geo_cache.json).
 *
 * auditLog enriches geo on EVERY event (login/reconnect/disconnect); without a cache
 * that's a blocking ipinfo.io call per event, re-querying the same IPs and blowing
 * through ipinfo's unauthenticated rate limit (~1k/day) — which is exactly why recent
 * audit rows had blank country/city/asn. Cache SUCCESSFUL lookups for 30 days; do NOT
 * cache failures (a rate-limited blank should retry next time, not stick for 30 days).
 */
function geoLookupCached(string $ip): array {
    $empty = ['country' => '', 'city' => '', 'asn' => ''];
    if (!$ip) return $empty;
    $cacheFile = __DIR__ . '/../data/logs/geo_cache.json';
    $ttl = 30 * 86400;
    $now = time();
    $cache = [];
    if (is_file($cacheFile)) {
        $raw = @file_get_contents($cacheFile);
        if ($raw) { $d = json_decode($raw, true); if (is_array($d)) $cache = $d; }
    }
    if (isset($cache[$ip]) && is_array($cache[$ip]) && ($now - ($cache[$ip]['ts'] ?? 0)) < $ttl) {
        return ['country' => $cache[$ip]['country'] ?? '', 'city' => $cache[$ip]['city'] ?? '', 'asn' => $cache[$ip]['asn'] ?? ''];
    }
    // Cache miss → live lookup (2s timeout, non-fatal). Authenticated when
    // config/ipinfo.php provides a token (50k/mo vs ~1k/day unauthenticated;
    // the standard endpoint's shape — country/city/org — is unchanged by it).
    $tokenFile = __DIR__ . '/../config/ipinfo.php';
    if (is_file($tokenFile)) require_once $tokenFile;
    $tok = (defined('IPINFO_TOKEN') && IPINFO_TOKEN && IPINFO_TOKEN !== 'YOUR_TOKEN_HERE')
        ? '?token=' . rawurlencode(IPINFO_TOKEN) : '';
    $ctx = stream_context_create(['http' => ['timeout' => 2]]);
    $ipData = @file_get_contents("https://ipinfo.io/{$ip}/json{$tok}", false, $ctx);
    $geo = $empty;
    if ($ipData) {
        $info = json_decode($ipData, true);
        if (is_array($info) && (isset($info['country']) || isset($info['org']))) {
            $geo = [
                'country' => $info['country'] ?? '',
                'city' => str_replace(',', ' ', $info['city'] ?? ''),
                'asn' => str_replace(',', ' ', $info['org'] ?? ''),
            ];
        }
    }
    if ($geo['country'] !== '' || $geo['asn'] !== '') {   // persist successes only
        $cache[$ip] = $geo + ['ts' => $now];
        foreach ($cache as $k => $v) { if (($now - ($v['ts'] ?? 0)) > $ttl) unset($cache[$k]); }
        if (count($cache) > 5000) {
            uasort($cache, function ($a, $b) { return ($a['ts'] ?? 0) <=> ($b['ts'] ?? 0); });
            $cache = array_slice($cache, -5000, null, true);
        }
        @file_put_contents($cacheFile, json_encode($cache), LOCK_EX);
    }
    return $geo;
}

/**
 * Trim the audit CSV to a retention window, at most once per calendar day (a marker file
 * claims the day). report_query.php reads the whole file, so this bounds it without cron
 * (IONOS shared hosting gives us none). Atomic swap via a temp file + rename.
 */
function auditPruneOncePerDay(string $csvFile): void {
    $marker = dirname($csvFile) . '/.audit_prune_day';
    $today = date('Y-m-d');
    if (@file_get_contents($marker) === $today) return;   // already handled today
    @file_put_contents($marker, $today, LOCK_EX);          // claim the day first (avoid a herd)

    $retentionDays = 180;                                  // ~6 months; tune here
    $cutoffTs = time() - $retentionDays * 86400;
    $lines = @file($csvFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!$lines || count($lines) < 2) return;

    $kept = [$lines[0]];                                   // header
    for ($i = 1, $n = count($lines); $i < $n; $i++) {
        $comma = strpos($lines[$i], ',');
        $ts = $comma === false ? $lines[$i] : substr($lines[$i], 0, $comma);
        $t = strtotime($ts);
        if ($t === false || $t >= $cutoffTs) $kept[] = $lines[$i];   // keep recent (and unparseable, to be safe)
    }
    if (count($kept) < count($lines)) {                    // rewrite only if rows were dropped
        $tmp = $csvFile . '.tmp';
        if (@file_put_contents($tmp, implode("\n", $kept) . "\n", LOCK_EX) !== false) {
            @rename($tmp, $csvFile);
        } else {
            @unlink($tmp);
        }
    }
}

/**
 * Extract a unix timestamp from a log line. Two formats handled:
 *  - CSV row: first field is an ISO timestamp.
 *  - Bracket log: line begins "[<timestamp>] ...".
 * Returns null when there's no parseable timestamp (caller keeps such lines).
 */
function logLineTimestamp(string $line, bool $csv) {
    if ($csv) {
        $comma = strpos($line, ',');
        $ts = $comma === false ? $line : substr($line, 0, $comma);
    } else {
        if ($line === '' || $line[0] !== '[') return null;
        $close = strpos($line, ']');
        if ($close === false) return null;
        $ts = substr($line, 1, $close - 1);
    }
    $t = strtotime($ts);
    return $t === false ? null : $t;
}

/**
 * Trim a log file to a retention window by STREAMING (line-by-line read → temp file →
 * atomic rename). Streaming keeps memory flat — auth.log runs ~50MB / 400k+ lines, so a
 * file()-into-array prune would risk the PHP memory limit. Lines with no parseable
 * timestamp are kept (don't drop continuation rows); a CSV keeps its header.
 */
function pruneLogByAgeStream(string $file, int $retentionDays, bool $csv): void {
    if (!is_file($file)) return;
    $cutoffTs = time() - $retentionDays * 86400;
    $in = @fopen($file, 'r'); if (!$in) return;
    $tmp = $file . '.tmp';
    $out = @fopen($tmp, 'w'); if (!$out) { fclose($in); return; }
    $dropped = false; $first = true;
    while (($line = fgets($in)) !== false) {
        if ($csv && $first) { fwrite($out, $line); $first = false; continue; }   // keep header
        $first = false;
        if (trim($line) === '') continue;
        $ts = logLineTimestamp(rtrim($line, "\r\n"), $csv);
        if ($ts === null || $ts >= $cutoffTs) fwrite($out, $line);
        else $dropped = true;
    }
    fclose($in); fclose($out);
    if ($dropped) @rename($tmp, $file); else @unlink($tmp);
}

/**
 * Prune the heavy server logs once per ISO week (marker-gated). No cron on IONOS shared
 * hosting, so this piggybacks on auditLog (a frequently-hit path); the marker makes it a
 * no-op on all but the first call each week. Retention per file below — tune here.
 */
function pruneServerLogsWeekly(): void {
    $dir = __DIR__ . '/../data/logs';
    $marker = $dir . '/.logs_prune_week';
    $week = date('o-W');                                   // ISO-8601 year + week number
    if (@file_get_contents($marker) === $week) return;
    @file_put_contents($marker, $week, LOCK_EX);           // claim the week first (avoid a herd)

    pruneLogByAgeStream($dir . '/auth.log', 30, false);            // very verbose; 30 days
    pruneLogByAgeStream($dir . '/security.csv', 90, true);         // security events; 90 days
    pruneLogByAgeStream($dir . '/security_scan.log', 30, false);   // scan heartbeat; 30 days
}

/**
 * Generate a unique ID
 */
function generateId(): string {
    return bin2hex(random_bytes(16));
}

/**
 * Generate CSRF token
 */
function generateCsrfToken(): string {
    if (!isset($_SESSION[CSRF_TOKEN_NAME])) {
        $_SESSION[CSRF_TOKEN_NAME] = bin2hex(random_bytes(32));
    }
    return $_SESSION[CSRF_TOKEN_NAME];
}

/**
 * Validate CSRF token
 */
function validateCsrfToken(?string $token): bool {
    if (!$token || !isset($_SESSION[CSRF_TOKEN_NAME])) {
        return false;
    }
    return hash_equals($_SESSION[CSRF_TOKEN_NAME], $token);
}

/**
 * Sanitize input string
 */
function sanitize(string $input): string {
    return htmlspecialchars(trim($input), ENT_QUOTES, 'UTF-8');
}

/**
 * Send JSON response
 */
function jsonResponse(array $data, int $statusCode = 200): void {
    http_response_code($statusCode);
    header('Content-Type: application/json');
    header('Cache-Control: no-cache, no-store, must-revalidate');
    echo json_encode($data);
    exit;
}

/**
 * Send error response
 */
function errorResponse(string $message, int $statusCode = 400): void {
    jsonResponse(['success' => false, 'error' => $message], $statusCode);
}

/**
 * Send success response
 */
function successResponse(array $data = []): void {
    jsonResponse(array_merge(['success' => true], $data));
}

/**
 * Get user data directory path
 */
function getUserDataPath(string $userId): string {
    return USERS_PATH . '/' . $userId;
}

/**
 * Calculate total size of a directory recursively
 */
function getDirectorySize(string $path): int {
    $size = 0;
    if (!is_dir($path)) {
        return 0;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, RecursiveDirectoryIterator::SKIP_DOTS)
    );

    foreach ($iterator as $file) {
        if ($file->isFile()) {
            $size += $file->getSize();
        }
    }

    return $size;
}

/**
 * Count total files in a directory recursively
 */
function getDirectoryFileCount(string $path): int {
    $count = 0;
    if (!is_dir($path)) {
        return 0;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, RecursiveDirectoryIterator::SKIP_DOTS)
    );

    foreach ($iterator as $file) {
        if ($file->isFile()) {
            $count++;
        }
    }

    return $count;
}

/**
 * Check if user can store additional data
 * Returns array with 'allowed' bool and 'error' message if not allowed
 */
function checkUserStorageLimits(string $userId, int $additionalBytes = 0, int $additionalFiles = 0): array {
    $userPath = getUserDataPath($userId);

    $currentSize = getDirectorySize($userPath);
    $currentFiles = getDirectoryFileCount($userPath);

    if ($currentSize + $additionalBytes > MAX_USER_STORAGE) {
        $maxMB = round(MAX_USER_STORAGE / 1024 / 1024);
        $usedMB = round($currentSize / 1024 / 1024, 2);
        return [
            'allowed' => false,
            'error' => "Storage limit exceeded. Using {$usedMB}MB of {$maxMB}MB allowed."
        ];
    }

    if ($currentFiles + $additionalFiles > MAX_USER_FILES) {
        return [
            'allowed' => false,
            'error' => "File limit exceeded. You have {$currentFiles} of " . MAX_USER_FILES . " files allowed."
        ];
    }

    return ['allowed' => true];
}

/**
 * Get user storage stats
 */
function getUserStorageStats(string $userId): array {
    $userPath = getUserDataPath($userId);
    $currentSize = getDirectorySize($userPath);
    $currentFiles = getDirectoryFileCount($userPath);

    return [
        'used_bytes' => $currentSize,
        'used_mb' => round($currentSize / 1024 / 1024, 2),
        'max_mb' => round(MAX_USER_STORAGE / 1024 / 1024),
        'files' => $currentFiles,
        'max_files' => MAX_USER_FILES,
        'percent_used' => round(($currentSize / MAX_USER_STORAGE) * 100, 1)
    ];
}

/**
 * Load JSON file
 */
function loadJsonFile(string $path): array {
    if (!file_exists($path)) {
        return [];
    }
    $content = file_get_contents($path);
    $data = json_decode($content, true);
    return is_array($data) ? $data : [];
}

/**
 * Save JSON file atomically (write to temp, then rename)
 * This prevents partial/corrupted writes
 */
function saveJsonFile(string $path, array $data, int $rotations = 0): bool {
    $dir = dirname($path);
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }

    // Auto-protect trigger and alias files — user's most valuable data.
    // Three tiers of backup:
    //   1. Per-save rotation (.1 through .10) — 10 revisions for rapid
    //      recovery when a bad save happens during debugging/panic.
    //   2. Daily snapshot (.daily.YYYY-MM-DD) — one per day, keep 14.
    //      Created on the first save of each calendar day. Rotation
    //      never touches these.
    //   3. Weekly snapshot (.weekly.YYYY-WNN) — one per week, keep 8.
    //      Two months of weekly recovery points.
    //
    // Total storage per character: ~1MB. Automatic, transparent.
    $basename = basename($path);
    $isProtected = in_array($basename, ['triggers.json', 'aliases.json']);

    if ($isProtected && $rotations === 0) {
        $rotations = 10;
    }

    // Daily + weekly snapshots for protected files
    if ($isProtected && file_exists($path)) {
        $today = date('Y-m-d');
        $dailyPath = "$path.daily.$today";
        if (!file_exists($dailyPath)) {
            @copy($path, $dailyPath);
            // Prune daily snapshots older than 14 days
            foreach (glob("$path.daily.*") as $old) {
                $dateStr = substr($old, strrpos($old, '.daily.') + 7);
                if ($dateStr < date('Y-m-d', strtotime('-14 days'))) {
                    @unlink($old);
                }
            }
        }

        $week = date('Y-\WW');
        $weeklyPath = "$path.weekly.$week";
        if (!file_exists($weeklyPath)) {
            @copy($path, $weeklyPath);
            // Prune weekly snapshots older than 8 weeks
            foreach (glob("$path.weekly.*") as $old) {
                $weekStr = substr($old, strrpos($old, '.weekly.') + 8);
                if ($weekStr < date('Y-\WW', strtotime('-8 weeks'))) {
                    @unlink($old);
                }
            }
        }
    }

    $json = json_encode($data, JSON_PRETTY_PRINT);
    if ($json === false) {
        error_log("saveJsonFile: Failed to encode JSON for $path");
        return false;
    }

    // Write to temp file first
    $tempPath = $path . '.tmp.' . uniqid();
    if (file_put_contents($tempPath, $json) === false) {
        error_log("saveJsonFile: Failed to write temp file $tempPath");
        return false;
    }

    // Verify the temp file is valid JSON before replacing
    $verify = json_decode(file_get_contents($tempPath), true);
    if ($verify === null && json_last_error() !== JSON_ERROR_NONE) {
        error_log("saveJsonFile: Temp file validation failed for $path");
        @unlink($tempPath);
        return false;
    }

    // Rotate previous versions before overwriting. Keeps $rotations
    // backup copies so user data (triggers, aliases) can be recovered
    // if a bad save overwrites the current file.
    if ($rotations > 0 && file_exists($path)) {
        for ($i = $rotations; $i >= 1; $i--) {
            $older = "$path.$i";
            if ($i === $rotations) {
                @unlink($older);
            }
            if ($i > 1) {
                $newer = "$path." . ($i - 1);
                if (file_exists($newer)) @rename($newer, $older);
            } else {
                @copy($path, $older);
            }
        }
    }

    // Atomic rename (on Windows, need to delete first)
    if (PHP_OS_FAMILY === 'Windows' && file_exists($path)) {
        @unlink($path);
    }

    if (!rename($tempPath, $path)) {
        error_log("saveJsonFile: Failed to rename temp to $path");
        @unlink($tempPath);
        return false;
    }

    return true;
}

/**
 * Get user's profile file path
 */
function getProfilePath(string $userId): string {
    return getUserDataPath($userId) . '/profile.json';
}

/**
 * Update a single field in a user's profile.json
 */
function updateUserProfileField(string $userId, string $field, $value): bool {
    $path = getProfilePath($userId);
    $profile = loadJsonFile($path);
    if (empty($profile)) return false;
    $profile[$field] = $value;
    return saveJsonFile($path, $profile);
}

/**
 * Get user's characters list file path
 */
function getCharactersListPath(string $userId): string {
    return getUserDataPath($userId) . '/characters.json';
}

/**
 * Get character data directory path
 */
function getCharacterDataPath(string $userId, string $characterId): string {
    return getUserDataPath($userId) . '/characters/' . $characterId;
}

/**
 * Get character's triggers file path
 */
function getTriggersPath(string $userId, string $characterId): string {
    return getCharacterDataPath($userId, $characterId) . '/triggers.json';
}

/**
 * Get character's aliases file path
 */
function getAliasesPath(string $userId, string $characterId): string {
    return getCharacterDataPath($userId, $characterId) . '/aliases.json';
}

/**
 * Get character's tickers file path
 */
function getTickersPath(string $userId, string $characterId): string {
    return getCharacterDataPath($userId, $characterId) . '/tickers.json';
}

/**
 * Get character's preferences file path
 */
function getPreferencesPath(string $userId, string $characterId): string {
    return getCharacterDataPath($userId, $characterId) . '/preferences.json';
}

/**
 * Get character's MIP conditions file path
 */
function getMipConditionsPath(string $userId, string $characterId): string {
    return getCharacterDataPath($userId, $characterId) . '/mip_conditions.json';
}

/**
 * Initialize user data directory with default files
 * Stores password hash in profile for recovery purposes
 */
function initializeUserData(string $userId, string $username, string $passwordHash = '', string $email = '', string $ip = ''): void {
    $userPath = getUserDataPath($userId);

    if (!is_dir($userPath)) {
        mkdir($userPath, 0755, true);
    }

    // Create characters directory
    $charsDir = $userPath . '/characters';
    if (!is_dir($charsDir)) {
        mkdir($charsDir, 0755, true);
    }

    // Default profile (includes password hash for recovery)
    $profile = [
        'id' => $userId,
        'username' => $username,
        'created_at' => date('c')
    ];
    if ($passwordHash) {
        $profile['password_hash'] = $passwordHash;
    }
    if ($email) {
        $profile['email'] = $email;
    }
    if ($ip) {
        $profile['registered_ip'] = $ip;
        $profile['last_ip'] = $ip;
    }
    saveJsonFile(getProfilePath($userId), $profile);

    // Empty characters list
    saveJsonFile(getCharactersListPath($userId), []);
}

/**
 * Character index — global lookup table at data/character_index.json
 * Maps every character to its userId for quick admin/debug lookups.
 * Auto-maintained by create/rename/delete operations.
 */
function getCharacterIndexPath(): string {
    return DATA_PATH . '/character_index.json';
}

function updateCharacterIndex(string $userId, string $characterId, string $characterName, string $server = '3k'): void {
    $indexPath = getCharacterIndexPath();
    $index = loadJsonFile($indexPath);
    // Remove any existing entry for this charId
    $index = array_filter($index, function($e) use ($characterId) {
        return $e['characterId'] !== $characterId;
    });
    // Add updated entry
    $index[] = [
        'userId' => $userId,
        'characterId' => $characterId,
        'name' => $characterName,
        'server' => $server,
        'updatedAt' => date('c')
    ];
    saveJsonFile($indexPath, array_values($index));
}

function removeFromCharacterIndex(string $characterId): void {
    $indexPath = getCharacterIndexPath();
    $index = loadJsonFile($indexPath);
    $index = array_filter($index, function($e) use ($characterId) {
        return $e['characterId'] !== $characterId;
    });
    saveJsonFile($indexPath, array_values($index));
}

/**
 * Create a new character for a user
 */
function createCharacter(string $userId, string $characterName, string $server = '3k'): array {
    $characterId = generateId();
    $charPath = getCharacterDataPath($userId, $characterId);

    if (!is_dir($charPath)) {
        mkdir($charPath, 0755, true);
    }

    $character = [
        'id' => $characterId,
        'name' => $characterName,
        'label' => '',
        'password' => '',
        'server' => $server,
        'created_at' => date('c')
    ];

    // Add to characters list
    $characters = loadJsonFile(getCharactersListPath($userId));
    $characters[] = $character;
    saveJsonFile(getCharactersListPath($userId), $characters);

    // (No JSON data files to initialize — triggers/aliases/tickers/classes/
    // preferences live in the Lightsail DB only since 2026-07-10. A new char
    // simply has zero rows until its first save; the client applies defaults.)

    // Update global character index
    updateCharacterIndex($userId, $characterId, $characterName, $server);

    // Push to Lightsail DB so the characters table is kept in sync with the
    // IONOS JSON write. Non-fatal on failure — IONOS is the user-facing
    // source of truth, this is the sync to the runtime DB.
    // See memory/bug_characters_not_synced_to_lightsail_db.md (2026-05-25).
    pushToLightsail('/admin/character', [
        'id' => $characterId,
        'user_id' => $userId,
        'name' => $characterName,
        'label' => '',
        'server' => $server,
        'password' => '',
        'sort_order' => 0,
        'created_at' => $character['created_at']
    ]);

    return $character;
}

/**
 * Get all characters for a user
 */
function getCharacters(string $userId): array {
    return loadJsonFile(getCharactersListPath($userId));
}

/**
 * Get a specific character
 */
function getCharacter(string $userId, string $characterId): ?array {
    $characters = getCharacters($userId);
    foreach ($characters as $char) {
        if ($char['id'] === $characterId) {
            return $char;
        }
    }
    return null;
}

/**
 * Reorder characters based on array of IDs
 */
function reorderCharacters(string $userId, array $orderedIds): bool {
    $characters = getCharacters($userId);

    // Build a map of id => character for quick lookup
    $charMap = [];
    foreach ($characters as $char) {
        $charMap[$char['id']] = $char;
    }

    // Validate all IDs exist
    foreach ($orderedIds as $id) {
        if (!isset($charMap[$id])) {
            return false; // Invalid ID in order list
        }
    }

    // Rebuild array in new order
    $newOrder = [];
    foreach ($orderedIds as $id) {
        $newOrder[] = $charMap[$id];
        unset($charMap[$id]);
    }

    // Append any characters not in the order list (shouldn't happen, but safety)
    foreach ($charMap as $char) {
        $newOrder[] = $char;
    }

    $result = saveJsonFile(getCharactersListPath($userId), $newOrder);

    // Sync sort_order to Lightsail DB for each character.  N HTTP calls for
    // N characters — acceptable for typical N (1-20).  Each call is INSERT
    // OR REPLACE so it's idempotent and safe.
    if ($result) {
        foreach ($newOrder as $idx => $char) {
            pushToLightsail('/admin/character', [
                'id' => $char['id'],
                'user_id' => $userId,
                'name' => $char['name'],
                'label' => $char['label'] ?? '',
                'server' => $char['server'] ?? '3k',
                'sort_order' => $idx
            ]);
        }
    }

    return $result;
}

/**
 * Delete a character
 */
function deleteCharacter(string $userId, string $characterId): bool {
    $characters = getCharacters($userId);
    $newCharacters = array_filter($characters, function($c) use ($characterId) {
        return $c['id'] !== $characterId;
    });

    if (count($newCharacters) === count($characters)) {
        return false; // Character not found
    }

    saveJsonFile(getCharactersListPath($userId), array_values($newCharacters));

    // Delete character data directory
    $charPath = getCharacterDataPath($userId, $characterId);
    if (is_dir($charPath)) {
        $files = glob($charPath . '/*');
        foreach ($files as $file) {
            unlink($file);
        }
        rmdir($charPath);
    }

    // Remove from global character index
    removeFromCharacterIndex($characterId);

    // Cascade-delete the character + all related rows from the Lightsail DB.
    // Without this, the character row plus its aliases/triggers/classes/
    // tickers/preferences orphan in the DB forever.
    pushToLightsail('/admin/character/delete', [
        'characterId' => $characterId
    ]);

    return true;
}

/**
 * Rename a character
 */
function renameCharacter(string $userId, string $characterId, string $newName): bool {
    $characters = getCharacters($userId);
    $found = false;
    $server = '3k';

    foreach ($characters as &$char) {
        if ($char['id'] === $characterId) {
            $char['name'] = $newName;
            $server = $char['server'] ?? '3k';
            $found = true;
            break;
        }
    }

    if (!$found) {
        return false;
    }

    $result = saveJsonFile(getCharactersListPath($userId), $characters);

    // Update global character index with new name
    if ($result) {
        updateCharacterIndex($userId, $characterId, $newName, $server);
        // Sync to Lightsail DB so the characters table reflects the new name.
        // /admin/character is INSERT OR REPLACE so it handles update fine.
        pushToLightsail('/admin/character', [
            'id' => $characterId,
            'user_id' => $userId,
            'name' => $newName,
            'server' => $server
        ]);
    }

    return $result;
}

/**
 * Duplicate a character profile (copies triggers, aliases, tickers, preferences)
 */
function duplicateCharacter(string $userId, string $sourceId, string $label = ''): ?array {
    $source = getCharacter($userId, $sourceId);
    if (!$source) return null;

    $newId = generateId();
    $newPath = getCharacterDataPath($userId, $newId);

    if (!is_dir($newPath)) {
        mkdir($newPath, 0755, true);
    }

    $newChar = [
        'id' => $newId,
        'name' => $source['name'],
        'label' => $label,
        'password' => $source['password'] ?? '',
        'server' => $source['server'] ?? '3k',
        'created_at' => date('c')
    ];

    // Add to characters list
    $characters = loadJsonFile(getCharactersListPath($userId));
    $characters[] = $newChar;
    saveJsonFile(getCharactersListPath($userId), $characters);

    // Create the new character's DB row FIRST — every DB write below (triggers,
    // aliases, tickers, classes, preferences) FK-references the characters table.
    // duplicateCharacter historically skipped this (createCharacter does it), so
    // duplicated chars had NO DB row → every DB save silently FK-failed → the char
    // lived permanently on the JSON fallback. See createCharacter +
    // memory/bug_characters_not_synced_to_lightsail_db.md.
    pushToLightsail('/admin/character', [
        'id' => $newId,
        'user_id' => $userId,
        'name' => $source['name'],
        'label' => $label,
        'server' => $source['server'] ?? '3k',
        'password' => $source['password'] ?? '',
        'sort_order' => 0,
        'created_at' => $newChar['created_at']
    ]);

    // Copy data from source.
    $sourcePath = getCharacterDataPath($userId, $sourceId);

    // (mip_conditions is no longer a separate file — it lives in the preferences
    // blob, which the prefs DB sync further below copies to the new char.)

    // triggers/aliases/tickers/classes live in the DB only (JSON dual-store
    // retired 2026-07-10). Copy = DB read → fresh ids → DB push for the new char.
    //
    // CRITICAL: every id in these tables is GLOBALLY unique (the primary key is the
    // bare id, not (character_id,id)). Copying a row with the SOURCE's id collides:
    // aliases/triggers/tickers-bulk use plain INSERT → "UNIQUE constraint failed" →
    // the whole transaction rolls back (0 rows); classes-bulk uses INSERT OR IGNORE
    // → the row is silently dropped. So we MUST mint fresh ids on copy. Class
    // membership is by class_id, so regenerate class ids FIRST, map old→new, then
    // remap each item's `class` reference (the wire field that carries class_id).

    // 1) classes first — fresh ids + old→new map for remapping below.
    $srcClasses = dbList('/admin/classes', 'classes', $sourceId) ?? [];
    $classMap = [];
    $newClasses = [];
    foreach ($srcClasses as $cl) {
        if (!is_array($cl)) continue;
        $oldId = $cl['id'] ?? null;
        $cl['id'] = generateId();
        if ($oldId !== null) $classMap[$oldId] = $cl['id'];
        $newClasses[] = $cl;
    }
    if (count($newClasses) > 0) {
        if (!pushBulkToLightsail('/admin/classes-bulk', 'classes', $newId, $newClasses)) {
            @error_log("duplicateCharacter: classes push failed for new char $newId");
        }
    }

    // 2) triggers/aliases/tickers — fresh item ids + remapped class refs.
    $itemTypes = [
        'triggers' => ['/admin/triggers', '/admin/triggers-bulk'],
        'aliases'  => ['/admin/aliases',  '/admin/aliases-bulk'],
        'tickers'  => ['/admin/tickers',  '/admin/tickers-bulk'],
    ];
    foreach ($itemTypes as $listKey => $p) {
        list($getEndpoint, $bulkEndpoint) = $p;
        $list = dbList($getEndpoint, $listKey, $sourceId) ?? [];
        foreach ($list as &$item) {
            if (!is_array($item)) continue;
            $item['id'] = generateId();
            if (isset($item['class']) && $item['class'] !== null && isset($classMap[$item['class']])) {
                $item['class'] = $classMap[$item['class']];
            }
        }
        unset($item);
        if (count($list) > 0) {
            if (!pushBulkToLightsail($bulkEndpoint, $listKey, $newId, $list)) {
                @error_log("duplicateCharacter: $listKey push failed for new char $newId");
            }
        }
    }

    // Preferences are DB-only (single source of truth) — copy the source char's
    // prefs blob from the DB into the new char's DB (its FK row now exists above).
    $srcPrefsResp = fetchFromLightsail('/admin/preferences', $sourceId);
    $srcPrefs = ($srcPrefsResp && isset($srcPrefsResp['preferences']) && is_array($srcPrefsResp['preferences'])) ? $srcPrefsResp['preferences'] : [];
    if (!empty($srcPrefs)) {
        syncDataToDb(['type' => 'preferences', 'character_id' => $newId, 'data' => $srcPrefs]);
    }

    // Copy scripts directory if it exists
    $scriptsDir = $sourcePath . '/scripts';
    if (is_dir($scriptsDir)) {
        $newScriptsDir = $newPath . '/scripts';
        mkdir($newScriptsDir, 0755, true);
        foreach (glob($scriptsDir . '/*') as $script) {
            copy($script, $newScriptsDir . '/' . basename($script));
        }
    }

    // Update global character index
    updateCharacterIndex($userId, $newId, $source['name'], $source['server'] ?? '3k');

    return $newChar;
}

/**
 * Update character profile label (e.g. "Mage", "Jedi")
 */
function updateCharacterLabel(string $userId, string $characterId, string $label): bool {
    $characters = getCharacters($userId);
    $found = false;
    $charData = null;

    foreach ($characters as &$char) {
        if ($char['id'] === $characterId) {
            $char['label'] = $label;
            $found = true;
            $charData = $char;
            break;
        }
    }

    if (!$found) {
        return false;
    }

    $result = saveJsonFile(getCharactersListPath($userId), $characters);
    if ($result && $charData) {
        pushToLightsail('/admin/character', [
            'id' => $characterId,
            'user_id' => $userId,
            'name' => $charData['name'],
            'label' => $label,
            'server' => $charData['server'] ?? '3k'
        ]);
    }
    return $result;
}

/**
 * Update character password
 */
function updateCharacterPassword(string $userId, string $characterId, string $password): bool {
    $characters = getCharacters($userId);
    $found = false;
    $charData = null;

    foreach ($characters as &$char) {
        if ($char['id'] === $characterId) {
            $char['password'] = $password;
            $found = true;
            $charData = $char;
            break;
        }
    }

    if (!$found) {
        return false;
    }

    $result = saveJsonFile(getCharactersListPath($userId), $characters);
    if ($result && $charData) {
        pushToLightsail('/admin/character', [
            'id' => $characterId,
            'user_id' => $userId,
            'name' => $charData['name'],
            'password' => $password,
            'server' => $charData['server'] ?? '3k'
        ]);
    }
    return $result;
}

/**
 * Get character password
 */
function getCharacterPassword(string $userId, string $characterId): string {
    $character = getCharacter($userId, $characterId);
    return $character['password'] ?? '';
}

/**
 * Check if character has wizard status (unlimited session timeout)
 */
function isCharacterWizard(string $userId, string $characterId): bool {
    $character = getCharacter($userId, $characterId);
    return $character['isWizard'] ?? false;
}

/**
 * Set wizard status for a character
 * Note: This only sets the flag - caller should verify account-level wizard status first
 */
function setCharacterWizard(string $userId, string $characterId, bool $isWizard): bool {
    $characters = getCharacters($userId);
    $found = false;

    foreach ($characters as &$char) {
        if ($char['id'] === $characterId) {
            $char['isWizard'] = $isWizard;
            $found = true;
            break;
        }
    }

    if (!$found) {
        return false;
    }

    return saveJsonFile(getCharactersListPath($userId), $characters);
}

/**
 * Update character server (3k or 3s)
 */
function updateCharacterServer(string $userId, string $characterId, string $server): bool {
    // Validate server value
    if (!in_array($server, ['3k', '3s'])) {
        return false;
    }

    $characters = getCharacters($userId);
    $found = false;
    $charData = null;

    foreach ($characters as &$char) {
        if ($char['id'] === $characterId) {
            $char['server'] = $server;
            $found = true;
            $charData = $char;
            break;
        }
    }

    if (!$found) {
        return false;
    }

    $result = saveJsonFile(getCharactersListPath($userId), $characters);
    if ($result && $charData) {
        pushToLightsail('/admin/character', [
            'id' => $characterId,
            'user_id' => $userId,
            'name' => $charData['name'],
            'server' => $server
        ]);
    }
    return $result;
}

/**
 * Get character server (defaults to '3k')
 */
function getCharacterServer(string $userId, string $characterId): string {
    $character = getCharacter($userId, $characterId);
    return $character['server'] ?? '3k';
}

/**
 * Convert ANSI codes to HTML
 */
function ansiToHtml(string $text): string {
    $ansiColors = [
        '0' => '</span>',
        '1' => '<span style="font-weight:bold">',
        '4' => '<span style="text-decoration:underline">',
        '30' => '<span style="color:#000000">',
        '31' => '<span style="color:#cc0000">',
        '32' => '<span style="color:#00cc00">',
        '33' => '<span style="color:#cccc00">',
        '34' => '<span style="color:#0000cc">',
        '35' => '<span style="color:#cc00cc">',
        '36' => '<span style="color:#00cccc">',
        '37' => '<span style="color:#cccccc">',
        '90' => '<span style="color:#666666">',
        '91' => '<span style="color:#ff0000">',
        '92' => '<span style="color:#00ff00">',
        '93' => '<span style="color:#ffff00">',
        '94' => '<span style="color:#0000ff">',
        '95' => '<span style="color:#ff00ff">',
        '96' => '<span style="color:#00ffff">',
        '97' => '<span style="color:#ffffff">',
        '40' => '<span style="background-color:#000000">',
        '41' => '<span style="background-color:#cc0000">',
        '42' => '<span style="background-color:#00cc00">',
        '43' => '<span style="background-color:#cccc00">',
        '44' => '<span style="background-color:#0000cc">',
        '45' => '<span style="background-color:#cc00cc">',
        '46' => '<span style="background-color:#00cccc">',
        '47' => '<span style="background-color:#cccccc">'
    ];

    // Match ANSI escape sequences
    $pattern = '/\x1b\[([0-9;]+)m/';

    $result = preg_replace_callback($pattern, function($matches) use ($ansiColors) {
        $codes = explode(';', $matches[1]);
        $html = '';
        foreach ($codes as $code) {
            if (isset($ansiColors[$code])) {
                $html .= $ansiColors[$code];
            }
        }
        return $html;
    }, $text);

    return $result;
}

/**
 * Require authentication
 */
function requireAuth(): void {
    // Debug logging
    $logFile = __DIR__ . '/../data/logs/auth.log';
    $timestamp = date('Y-m-d H:i:s');
    $uri = $_SERVER['REQUEST_URI'] ?? 'unknown';
    $sessionCookie = $_COOKIE[SESSION_NAME] ?? 'NOT SET';
    @file_put_contents($logFile, "[$timestamp] requireAuth called: uri=$uri, cookie=$sessionCookie\n", FILE_APPEND | LOCK_EX);

    // Single source of truth for session setup (custom save path, strict mode, 7-day
    // gc, cookie params) lives in initSession(). Call it instead of a divergent inline
    // copy that previously did NOT set the custom save path / strict mode — every API
    // endpoint and app.php already call initSession() before requireAuth(), so this is
    // normally a no-op, but it guarantees the SAME session config on every code path.
    if (function_exists('initSession')) {
        initSession();
    } elseif (session_status() === PHP_SESSION_NONE) {
        // Defensive fallback (auth.php is always loaded before requireAuth in practice).
        session_name(SESSION_NAME);
        session_start();
    }

    $sessionId = session_id();
    $userId = $_SESSION['user_id'] ?? 'NOT SET';
    @file_put_contents($logFile, "[$timestamp] requireAuth session: id=$sessionId, user_id=$userId\n", FILE_APPEND | LOCK_EX);

    if (!isset($_SESSION['user_id'])) {
        @file_put_contents($logFile, "[$timestamp] requireAuth DENIED: no user_id in session\n", FILE_APPEND | LOCK_EX);
        if (strpos($_SERVER['REQUEST_URI'], '/api/') !== false) {
            // Mirror unauth API hits to the security log so brute-force /
            // scanner traffic against authenticated endpoints is visible
            // alongside scanner_probe / traversal_attempt events.
            if (function_exists('securityLog')) {
                securityLog('unauth_api_hit', [
                    'reason' => isset($_COOKIE[SESSION_NAME]) ? 'expired_or_invalid_session' : 'no_session_cookie',
                ], 'low');
            }
            errorResponse('Authentication required', 401);
        } else {
            header('Location: index.php');
            exit;
        }
    }

    // Check if user is banned (catches mid-session bans)
    if (isUserBanned($_SESSION['user_id'])) {
        @file_put_contents($logFile, "[$timestamp] requireAuth DENIED (banned): user_id={$_SESSION['user_id']}\n", FILE_APPEND | LOCK_EX);
        session_destroy();
        if (strpos($_SERVER['REQUEST_URI'], '/api/') !== false) {
            errorResponse('This account has been suspended.', 403);
        } else {
            header('Location: index.php');
            exit;
        }
    }
}

/**
 * Get current user ID
 */
function getCurrentUserId(): ?string {
    return $_SESSION['user_id'] ?? null;
}

/**
 * Get current username
 */
function getCurrentUsername(): ?string {
    return $_SESSION['username'] ?? null;
}

/**
 * Privileged-user gates — the ONE place these username lists live.
 * They used to be copy-pasted per page (admin.php, admin_proxy.php,
 * report.php, report_query.php, report_export.php), which meant adding
 * a viewer required editing several files or someone got partial access.
 */
function adminUsernames(): array {
    return ['nathan'];
}

function reportUsernames(): array {
    return ['nathan', 'amy', 'adalius'];
}

function isAdminUser(): bool {
    return isLoggedIn() && in_array(getCurrentUsername(), adminUsernames());
}

function isReportUser(): bool {
    return isLoggedIn() && in_array(getCurrentUsername(), reportUsernames());
}

/**
 * Get current character ID
 * Prefers request param (tab-specific) over session (shared across tabs)
 * to prevent cross-character data contamination in multi-tab usage.
 */
function getCurrentCharacterId(): ?string {
    $requestCharId = $_GET['character_id'] ?? null;
    if ($requestCharId && preg_match('/^[a-f0-9]{32,64}$/', $requestCharId)) {
        $userId = getCurrentUserId();
        if ($userId) {
            $charPath = getCharacterDataPath($userId, $requestCharId);
            if (is_dir($charPath)) {
                return $requestCharId;
            }
        }
    }
    return $_SESSION['character_id'] ?? null;
}

/**
 * Get current character name
 */
function getCurrentCharacterName(): ?string {
    return $_SESSION['character_name'] ?? null;
}

/**
 * Set current character in session
 */
function setCurrentCharacter(string $characterId, string $characterName, string $server = '3k'): void {
    $_SESSION['character_id'] = $characterId;
    $_SESSION['character_name'] = $characterName;
    $_SESSION['character_server'] = $server;
}

/**
 * Get current character server
 */
function getCurrentCharacterServer(): string {
    return $_SESSION['character_server'] ?? '3k';
}

/**
 * Clear current character from session
 */
function clearCurrentCharacter(): void {
    unset($_SESSION['character_id']);
    unset($_SESSION['character_name']);
    unset($_SESSION['character_server']);
}

/**
 * Check if a character is selected
 */
function hasCharacterSelected(): bool {
    return isset($_SESSION['character_id']) && !empty($_SESSION['character_id']);
}

/**
 * Require a character to be selected.
 * API endpoints get a JSON error; page loads get a redirect.
 */
function requireCharacter(): void {
    if (!hasCharacterSelected()) {
        if (strpos($_SERVER['REQUEST_URI'] ?? '', '/api/') !== false) {
            header('Content-Type: application/json');
            http_response_code(401);
            echo json_encode(['success' => false, 'error' => 'No character selected']);
            exit;
        }
        header('Location: characters.php');
        exit;
    }
}

/**
 * Check if the current session is a guest
 */
function isGuest(): bool {
    return !empty($_SESSION['is_guest']);
}

/**
 * Block write operations for guest sessions
 */
function denyGuest(): void {
    if (isGuest()) {
        errorResponse('Guest accounts cannot save data', 403);
    }
}

// ─── Bot helpers ────────────────────────────────────────────

/**
 * Get path to character's bots file
 */
function getBotsPath(string $userId, string $characterId): string {
    return getCharacterDataPath($userId, $characterId) . '/bots.json';
}
