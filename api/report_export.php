<?php
/**
 * Export login audit CSV — report users only.
 * Accepts the same filter params as report_query.php (search / activity /
 * realm / days / sort / dir) so the download matches what's on screen;
 * with no params it exports everything, geo-backfilled and re-escaped.
 */
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/functions.php';
require_once __DIR__ . '/../includes/report_lib.php';

initSession();

if (!isReportUser()) {
    http_response_code(403);
    exit('Forbidden');
}

$loaded = reportLoadAuditRows();
$headers = $loaded['headers'];
if (!$headers) {
    http_response_code(404);
    exit('No data');
}

$rows = reportGeoBackfill($loaded['rows']);
$rows = reportFilterAuditRows($rows, [
    'search' => $_GET['search'] ?? '',
    'activity' => $_GET['activity'] ?? '',
    'realm' => $_GET['realm'] ?? '',
    'days' => $_GET['days'] ?? 0,
]);

$sortCol = $_GET['sort'] ?? 'timestamp';
$sortDir = strtolower($_GET['dir'] ?? 'desc');
if (!in_array($sortCol, $headers, true)) $sortCol = 'timestamp';
$rows = reportSortAuditRows($rows, $sortCol, $sortDir);

header('Content-Type: text/csv');
header('Content-Disposition: attachment; filename="login_audit_' . date('Y-m-d') . '.csv"');

$out = fopen('php://output', 'w');
fputcsv($out, $headers);
foreach ($rows as $r) {
    $line = [];
    foreach ($headers as $h) $line[] = $r[$h] ?? '';
    fputcsv($out, $line);
}
fclose($out);
