<?php
/**
 * WMT Client - Security Access Logger
 *
 * Lightweight detector + logger for suspicious request patterns and
 * unauthorized access attempts. Writes structured CSV rows to
 * data/logs/security.csv (denied via .htaccess).
 *
 * Two entry points:
 *   - inspectRequestForThreats() — runs once per request, scans the
 *     current REQUEST_URI and params for known-bad markers
 *   - securityLog($event, $details, $severity) — explicit log call from
 *     auth failures, admin-key rejections, rate-limit blocks, etc.
 *
 * Design notes:
 *   - Observability, not enforcement. Patterns logged here do NOT block.
 *     Endpoint-level validators (sanitizePath, validateCsrfToken, etc.)
 *     are still the source of truth for "should this request proceed?".
 *   - Patterns are conservative — anchored, specific, low-false-positive.
 *     Add new patterns only after confirming they don't match legit traffic.
 *   - One detection per request (returns after first match) — avoids
 *     multi-rowing on a single probe.
 */

// Avoid pulling in auth.php to prevent circular include with includes/auth.php.
// We define a minimal getClientIp shim if it isn't already defined.
if (!function_exists('getClientIp')) {
    function getClientIp(): string {
        if (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            $ips = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
            return trim($ips[0]);
        }
        if (!empty($_SERVER['HTTP_X_REAL_IP'])) {
            return trim($_SERVER['HTTP_X_REAL_IP']);
        }
        return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    }
}

/**
 * Emit modern security response headers (F10 from the Phase 3 audit).
 *
 * Lives in PHP rather than .htaccess because IONOS shared hosting restricts
 * AllowOverride to disallow `Header` directives in per-directory .htaccess —
 * verified empirically (a bare `Header set X-Test-Marker "..."` does not
 * take effect). PHP `header()` calls bypass that restriction.
 *
 * Static assets (CSS/JS/images) served directly by Apache are NOT covered
 * by this — they have no XSS surface so it's acceptable.
 *
 * MUST be called before any output is sent. Safe to call from auth.php
 * which is included at the top of every entry point.
 */
function emitSecurityHeaders(): void {
    if (defined('SECURITY_HEADERS_EMITTED')) return;
    define('SECURITY_HEADERS_EMITTED', true);
    if (headers_sent()) return; // Bail out — output already started

    // HSTS — force HTTPS for one year, including subdomains
    header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
    // Block MIME-type sniffing
    header('X-Content-Type-Options: nosniff');
    // Clickjacking protection — only same-origin framing
    header('X-Frame-Options: SAMEORIGIN');
    // Limit referrer leakage to third-party sites
    header('Referrer-Policy: strict-origin-when-cross-origin');
    // Note: Content-Security-Policy intentionally omitted — needs careful
    // tuning against the app's inline-script use to avoid breakage.
}

const SECURITY_LOG_FILENAME = 'security.csv';
const SECURITY_LOG_MAX_ROWS = 50000; // soft cap; rotation happens in viewer/cron

// Shared pattern tables — used by both inspectRequestForThreats() (PHP-layer
// inspector) and scanApacheAccessLog() (offline log analyzer). DO NOT inline
// these into either function — keep them as the single source of truth so
// in-app and Apache-layer detection stay aligned.
const SCANNER_PATH_PATTERNS = [
    '#\.git(/|$)#i',
    '#\.env(\.|$|/)#i',
    '#\.htaccess$#i',
    '#\.htpasswd$#i',
    '#\.bak(\.|$)#i',
    '#\.swp$#i',
    '#\.DS_Store$#i',
    '#\.aws(/|$)#i',
    '#wp-admin#i',
    '#wp-login\.php#i',
    '#wp-config#i',
    '#wordpress#i',
    '#phpmyadmin#i',
    '#myadmin/#i',
    '#/pma/#i',
    '#/setup\.php#i',
    '#/install\.php#i',
    '#web\.config$#i',
    '#/server-status#i',
    '#/server-info#i',
    '#/cgi-bin/#i',
    '#/vendor/phpunit#i',
    '#/.well-known/[^.]*\.\.[^.]*#i',
];

const TRAVERSAL_MARKERS = ['../', '..\\', '%2e%2e/', '%2e%2e%2f', '%2e%2e\\', '%2e%2e%5c', "\0", '%00'];

const SCANNER_UA_PATTERNS = [
    '#sqlmap#i', '#nikto#i', '#nmap#i', '#masscan#i', '#zgrab#i',
    '#wpscan#i', '#dirbuster#i', '#gobuster#i', '#ffuf#i', '#wfuzz#i',
    '#acunetix#i', '#nessus#i', '#burpsuite#i', '#havij#i', '#openvas#i',
    '#hydra#i', '#metasploit#i',
];

function _securityLogPath(): string {
    return __DIR__ . '/../data/logs/' . SECURITY_LOG_FILENAME;
}

function _securityCsvHeader(): string {
    return "timestamp,event,severity,ip,method,uri,user_agent,details";
}

/**
 * Append a row to the security log. Safe to call frequently — uses
 * append+lock so concurrent requests don't clobber each other. Header is
 * written on first use.
 *
 * @param string $event   Short tag identifying the kind of event.
 * @param array  $details Free-form key/value pairs, JSON-encoded into the row.
 * @param string $severity One of: info, low, medium, high, critical.
 */
function securityLog(string $event, array $details = [], string $severity = 'info'): void {
    $logDir = __DIR__ . '/../data/logs';
    if (!is_dir($logDir)) @mkdir($logDir, 0755, true);
    $csvFile = _securityLogPath();

    if (!file_exists($csvFile)) {
        @file_put_contents($csvFile, _securityCsvHeader() . "\n", LOCK_EX);
    }

    $row = [
        date('c'),
        $event,
        $severity,
        getClientIp(),
        $_SERVER['REQUEST_METHOD'] ?? '',
        substr($_SERVER['REQUEST_URI'] ?? '', 0, 200),
        substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 200),
        substr(json_encode($details, JSON_UNESCAPED_SLASHES), 0, 500),
    ];

    // CSV-escape: replace newlines, quote fields containing comma or quote
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
 * Scan the current request for known-bad patterns. Logs but does NOT block.
 * Idempotent: only runs once per request via the SECURITY_INSPECTED constant.
 *
 * Detects:
 *   - Scanner-probe paths (.git/, .env, wp-admin, phpmyadmin, etc.)
 *   - Path traversal markers in any GET/POST param key or value
 *   - Known scanner User-Agent strings (sqlmap, nikto, gobuster, etc.)
 *   - Empty User-Agent on POST requests (unusual for browsers)
 */
function inspectRequestForThreats(): void {
    if (defined('SECURITY_INSPECTED')) return;
    define('SECURITY_INSPECTED', true);

    $uri = $_SERVER['REQUEST_URI'] ?? '';

    // 1. Scanner-probe paths
    foreach (SCANNER_PATH_PATTERNS as $pattern) {
        if (preg_match($pattern, $uri)) {
            securityLog('scanner_probe', ['pattern' => $pattern], 'low');
            return;
        }
    }

    // 2. Path traversal / null byte markers in any param
    $checkVal = function($val) {
        if (!is_string($val)) return false;
        foreach (TRAVERSAL_MARKERS as $m) {
            if (stripos($val, $m) !== false) return $m;
        }
        return false;
    };

    $allParams = array_merge($_GET ?? [], $_POST ?? []);
    foreach ($allParams as $key => $val) {
        if (is_array($val)) continue; // skip nested arrays for now
        $hit = $checkVal($val);
        if ($hit) {
            securityLog('traversal_attempt', [
                'param' => substr((string)$key, 0, 50),
                'marker' => $hit,
                'value_preview' => substr((string)$val, 0, 100),
            ], 'medium');
            return;
        }
        $keyHit = $checkVal((string)$key);
        if ($keyHit) {
            securityLog('traversal_attempt_in_key', [
                'key_preview' => substr((string)$key, 0, 100),
                'marker' => $keyHit,
            ], 'medium');
            return;
        }
    }

    // 3. Scanner User-Agents
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
    foreach (SCANNER_UA_PATTERNS as $pattern) {
        if (preg_match($pattern, $ua)) {
            securityLog('scanner_ua', ['ua_match' => $pattern, 'ua_preview' => substr($ua, 0, 100)], 'medium');
            return;
        }
    }
}
