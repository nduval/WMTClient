<?php
/**
 * WMT Client - shared login-audit report logic.
 *
 * Used by report.php (UI shell), api/report_query.php (JSON), and
 * api/report_export.php (CSV download) so filtering/sorting can't drift
 * between the page and the export. Extracted 2026-07-09 during the
 * report.php review.
 */

function reportAuditCsvPath(): string {
    return __DIR__ . '/../data/logs/login_audit.csv';
}

/**
 * Stream the audit CSV into rows keyed by header. fgetcsv handles quoted
 * fields, so rows written by fputcsv (commas in ASN org names etc.) parse
 * correctly; malformed rows (wrong column count) are skipped as before.
 */
function reportLoadAuditRows(): array {
    $headers = [];
    $rows = [];
    $csvFile = reportAuditCsvPath();
    if (is_file($csvFile) && ($fh = @fopen($csvFile, 'r'))) {
        $headers = fgetcsv($fh) ?: [];
        $n = count($headers);
        if ($n > 0) {
            while (($row = fgetcsv($fh)) !== false) {
                if (count($row) === $n) {
                    $rows[] = array_combine($headers, $row);
                }
            }
        }
        fclose($fh);
    }
    return ['headers' => $headers, 'rows' => $rows];
}

/**
 * Display-time geo repair: rows whose ipinfo lookup failed at write time
 * (rate limit / timeout → blank country+city+asn) get filled from the geo
 * cache — the same IP usually resolved successfully on a later event, but
 * the blank row itself was never touched again. Read-only: the CSV keeps
 * its historical bytes.
 */
function reportGeoBackfill(array $rows): array {
    $cacheFile = __DIR__ . '/../data/logs/geo_cache.json';
    $cache = [];
    if (is_file($cacheFile)) {
        $d = json_decode(@file_get_contents($cacheFile) ?: '', true);
        if (is_array($d)) $cache = $d;
    }
    if (!$cache) return $rows;
    foreach ($rows as &$r) {
        $ip = $r['ip'] ?? '';
        if ($ip !== '' && ($r['country'] ?? '') === '' && ($r['asn'] ?? '') === '' && isset($cache[$ip]) && is_array($cache[$ip])) {
            $r['country'] = $cache[$ip]['country'] ?? '';
            $r['city'] = $cache[$ip]['city'] ?? '';
            $r['asn'] = $cache[$ip]['asn'] ?? '';
        }
    }
    unset($r);
    return $rows;
}

/**
 * Apply the report filters. $f keys: search, activity, realm, days
 * (all optional; empty string / 0 = no filter).
 */
function reportFilterAuditRows(array $rows, array $f): array {
    $search = strtolower(trim($f['search'] ?? ''));
    $activity = strtolower(trim($f['activity'] ?? ''));
    $realm = strtoupper(trim($f['realm'] ?? ''));
    $days = (int)($f['days'] ?? 0);
    $cutoff = $days > 0 ? date('c', time() - $days * 86400) : '';

    $out = [];
    foreach ($rows as $row) {
        if ($activity && strtolower($row['activity'] ?? 'login') !== $activity) continue;
        if ($realm && strtoupper($row['realm'] ?? '') !== $realm) continue;
        if ($cutoff && ($row['timestamp'] ?? '') < $cutoff) continue;
        if ($search) {
            $haystack = strtolower(implode(' ', $row));
            if (strpos($haystack, $search) === false) continue;
        }
        $out[] = $row;
    }
    return $out;
}

/**
 * Sort rows on a column. IPs compare as packed addresses (inet_pton) so
 * 9.x sorts before 100.x and IPv6 is handled; everything else is a plain
 * string compare (ISO timestamps sort correctly that way).
 */
function reportSortAuditRows(array $rows, string $col, string $dir): array {
    $desc = strtolower($dir) !== 'asc';
    usort($rows, function ($a, $b) use ($col, $desc) {
        $av = $a[$col] ?? '';
        $bv = $b[$col] ?? '';
        if ($col === 'ip') {
            $ak = @inet_pton($av);
            $bk = @inet_pton($bv);
            if ($ak !== false && $bk !== false) { $av = $ak; $bv = $bk; }
        }
        $cmp = strcmp($av, $bv);
        return $desc ? -$cmp : $cmp;
    });
    return $rows;
}
