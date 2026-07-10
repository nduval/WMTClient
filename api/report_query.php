<?php
/**
 * Report query endpoint — server-side filtering and pagination for audit log.
 * Returns JSON. Requires report user session auth.
 * Shared load/filter/sort logic lives in includes/report_lib.php.
 */
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/functions.php';
require_once __DIR__ . '/../includes/report_lib.php';

initSession();

if (!isReportUser()) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'error' => 'Forbidden']);
    exit;
}

header('Content-Type: application/json');

// Parse query params
$page = max(1, (int)($_GET['page'] ?? 1));
$perPage = min(500, max(10, (int)($_GET['per_page'] ?? 100)));
$sortCol = $_GET['sort'] ?? 'timestamp';
$sortDir = strtolower($_GET['dir'] ?? 'desc');

$loaded = reportLoadAuditRows();
$headers = $loaded['headers'];
// Geo backfill BEFORE filtering so searching "Houston" also finds rows whose
// geo was blank at write time but is known in the cache now.
$allRows = reportGeoBackfill($loaded['rows']);

// Distinct activity types actually present — drives the page's filter
// dropdown, so new event types (login_failed, register, ...) can't silently
// fall outside the filter list again.
$activityCounts = [];
foreach ($allRows as $r) {
    $a = strtolower($r['activity'] ?? 'login');
    $activityCounts[$a] = ($activityCounts[$a] ?? 0) + 1;
}
ksort($activityCounts);

$filtered = reportFilterAuditRows($allRows, [
    'search' => $_GET['search'] ?? '',
    'activity' => $_GET['activity'] ?? '',
    'realm' => $_GET['realm'] ?? '',
    'days' => $_GET['days'] ?? 0,
]);

$totalFiltered = count($filtered);
$totalAll = count($allRows);

// Sort (whitelist to real columns)
if (!in_array($sortCol, $headers, true)) $sortCol = 'timestamp';
$filtered = reportSortAuditRows($filtered, $sortCol, $sortDir);

// Paginate
$totalPages = max(1, (int)ceil($totalFiltered / $perPage));
$page = min($page, $totalPages);
$offset = ($page - 1) * $perPage;
$pageRows = array_slice($filtered, $offset, $perPage);

echo json_encode([
    'success' => true,
    'rows' => $pageRows,
    'total' => $totalAll,
    'filtered' => $totalFiltered,
    'page' => $page,
    'per_page' => $perPage,
    'total_pages' => $totalPages,
    'activities' => $activityCounts,
]);
