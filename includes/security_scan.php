<?php
/**
 * WMT Client - Apache Access Log Scanner
 *
 * Offline / on-demand analyzer that complements includes/security.php's
 * in-process inspector. Reads the Apache combined access log, matches
 * scanner-probe paths and scanner User-Agents using the same pattern tables
 * defined in security.php (single source of truth), and writes hits to
 * data/logs/security.csv with source=apache_log so they're distinguishable
 * from in-process events.
 *
 * Tracks state via data/logs/.security_scan_state.json — records the byte
 * offset and inode of the access log so subsequent runs only process new
 * lines. Detects log rotation via inode change and restarts from offset 0.
 *
 * Entry points:
 *   - tools/scan_access_log.php — CLI runner, suitable for cron
 *   - (future) admin page button via HTTP wrapper
 *
 * Apache log format on IONOS (custom — host inserted before referer):
 *   IP - - [date] "METHOD URI HTTP/1.1" STATUS BYTES HOST "REFERER" "UA" "?"
 */

require_once __DIR__ . '/security.php';

// Hosts we actually care about. Apache logs everything for the shared
// hosting account, including the unrelated stealth marketing site
// (3kbusinessservices.com). We only emit security events for WMT hosts
// to avoid noise from another property's scanner traffic.
const SECURITY_SCAN_WMT_HOSTS = [
    'client.wemudtogether.com',
    'wemudtogether.com',
    'www.wemudtogether.com',
];

function _securityScanStatePath(): string {
    return __DIR__ . '/../data/logs/.security_scan_state.json';
}

function _securityScanLogPath(): string {
    // htdocs/client/includes/security_scan.php → htdocs/logs/access.log.current
    return __DIR__ . '/../../logs/access.log.current';
}

/**
 * Parse a single Apache combined-log line (with the IONOS host extension).
 * Returns ['ip','date','method','uri','status','host','ua','referer'] or
 * null if the line doesn't parse.
 */
function parseApacheLogLine(string $line): ?array {
    // ^IP - - [date] "METHOD URI PROTO" STATUS BYTES HOST "REFERER" "UA" ".*?"$
    static $re = '#^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) ([^"]*?) [^"]*?" (\d+) \S+ (\S+) "([^"]*)" "([^"]*)"#';
    if (!preg_match($re, $line, $m)) return null;
    return [
        'ip'      => $m[1],
        'date'    => $m[2],
        'method'  => $m[3],
        'uri'     => $m[4],
        'status'  => (int)$m[5],
        'host'    => $m[6],
        'referer' => $m[7],
        'ua'      => $m[8],
    ];
}

/**
 * Analyze a parsed log entry against scanner pattern tables.
 * Returns ['event','severity','details'] for the first matched pattern,
 * or null if nothing matched.
 *
 * Hosts not in SECURITY_SCAN_WMT_HOSTS are skipped (return null).
 */
function analyzeApacheLogEntry(array $entry): ?array {
    // Filter to WMT hosts only
    if (!in_array($entry['host'], SECURITY_SCAN_WMT_HOSTS, true)) {
        return null;
    }

    // Scanner-probe paths
    foreach (SCANNER_PATH_PATTERNS as $pattern) {
        if (preg_match($pattern, $entry['uri'])) {
            return [
                'event'    => 'scanner_probe',
                'severity' => 'low',
                'details'  => [
                    'pattern' => $pattern,
                    'status'  => $entry['status'],
                ],
            ];
        }
    }

    // Scanner User-Agents
    foreach (SCANNER_UA_PATTERNS as $pattern) {
        if (preg_match($pattern, $entry['ua'])) {
            return [
                'event'    => 'scanner_ua',
                'severity' => 'medium',
                'details'  => [
                    'ua_match'   => $pattern,
                    'ua_preview' => substr($entry['ua'], 0, 100),
                    'status'     => $entry['status'],
                ],
            ];
        }
    }

    return null;
}

/**
 * Write a single matched apache log entry into security.csv with the same
 * shape as in-app events, using source=apache_log so they're distinguishable.
 * Bypasses securityLog() because that function uses the LIVE request context
 * ($_SERVER) — for replayed log lines we need to inject the historical fields.
 */
function _writeApacheLogHit(array $entry, array $analysis): void {
    $csvFile = __DIR__ . '/../data/logs/' . SECURITY_LOG_FILENAME;
    if (!file_exists($csvFile)) {
        @file_put_contents($csvFile, _securityCsvHeader() . "\n", LOCK_EX);
    }

    // Reconstruct timestamp in ISO format (apache uses dd/Mon/YYYY:HH:MM:SS ±zzzz)
    $ts = date('c');
    $parsed = DateTime::createFromFormat('d/M/Y:H:i:s O', $entry['date']);
    if ($parsed) $ts = $parsed->format('c');

    $details = array_merge($analysis['details'], [
        'source' => 'apache_log',
        'host'   => $entry['host'],
    ]);

    $row = [
        $ts,
        $analysis['event'],
        $analysis['severity'],
        $entry['ip'],
        $entry['method'],
        substr($entry['uri'], 0, 200),
        substr($entry['ua'], 0, 200),
        substr(json_encode($details, JSON_UNESCAPED_SLASHES), 0, 500),
    ];

    $line = implode(',', array_map(function($f) {
        $f = str_replace(["\n", "\r"], ' ', (string)$f);
        if (strpos($f, ',') !== false || strpos($f, '"') !== false) {
            $f = '"' . str_replace('"', '""', $f) . '"';
        }
        return $f;
    }, $row));

    @file_put_contents($csvFile, $line . "\n", FILE_APPEND | LOCK_EX);
}

/**
 * Scan the Apache access log for new entries matching scanner patterns.
 * Idempotent — uses a state file with byte offset + inode to only process
 * lines that haven't been seen before. Detects log rotation via inode change
 * and starts over from offset 0 in that case.
 *
 * Returns ['ok'=>bool, 'hits'=>int, 'lines_read'=>int, 'new_offset'=>int, 'message'=>string]
 */
function scanApacheAccessLog(?string $logPath = null, ?string $statePath = null): array {
    $logPath = $logPath ?? _securityScanLogPath();
    $statePath = $statePath ?? _securityScanStatePath();

    if (!file_exists($logPath)) {
        return ['ok' => false, 'hits' => 0, 'lines_read' => 0, 'new_offset' => 0, 'message' => "log not found: $logPath"];
    }
    if (!is_readable($logPath)) {
        return ['ok' => false, 'hits' => 0, 'lines_read' => 0, 'new_offset' => 0, 'message' => "log not readable: $logPath"];
    }

    // Load state
    $state = [];
    if (file_exists($statePath)) {
        $raw = @file_get_contents($statePath);
        $decoded = $raw ? json_decode($raw, true) : null;
        if (is_array($decoded)) $state = $decoded;
    }
    $lastOffset = (int)($state['last_offset'] ?? 0);
    $lastInode  = $state['log_inode'] ?? null;

    // Detect rotation
    $stat = @stat($logPath);
    if (!$stat) {
        return ['ok' => false, 'hits' => 0, 'lines_read' => 0, 'new_offset' => 0, 'message' => 'stat failed'];
    }
    $currentInode = $stat['ino'];
    $currentSize  = $stat['size'];

    $rotated = false;
    if ($lastInode !== null && $currentInode !== $lastInode) {
        $rotated = true;
        $lastOffset = 0;
    }
    if ($lastOffset > $currentSize) {
        // Log was truncated in place — start over
        $rotated = true;
        $lastOffset = 0;
    }

    $fp = @fopen($logPath, 'r');
    if (!$fp) {
        return ['ok' => false, 'hits' => 0, 'lines_read' => 0, 'new_offset' => 0, 'message' => 'fopen failed'];
    }
    if ($lastOffset > 0) {
        fseek($fp, $lastOffset);
    }

    $hits = 0;
    $linesRead = 0;
    while (($line = fgets($fp)) !== false) {
        $linesRead++;
        $entry = parseApacheLogLine($line);
        if (!$entry) continue;
        $analysis = analyzeApacheLogEntry($entry);
        if ($analysis) {
            _writeApacheLogHit($entry, $analysis);
            $hits++;
        }
    }
    $newOffset = ftell($fp);
    fclose($fp);

    // Save state
    $stateDir = dirname($statePath);
    if (!is_dir($stateDir)) @mkdir($stateDir, 0755, true);
    @file_put_contents($statePath, json_encode([
        'last_offset' => $newOffset,
        'log_inode'   => $currentInode,
        'last_run'    => date('c'),
        'last_hits'   => $hits,
        'last_lines'  => $linesRead,
    ]));

    return [
        'ok'         => true,
        'hits'       => $hits,
        'lines_read' => $linesRead,
        'new_offset' => $newOffset,
        'rotated'    => $rotated,
        'message'    => "scanned $linesRead lines, $hits hits" . ($rotated ? ' (rotation detected)' : ''),
    ];
}
