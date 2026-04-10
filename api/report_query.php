<?php
/**
 * Report query endpoint — server-side filtering and pagination for audit log.
 * Returns JSON. Requires report user session auth.
 */
require_once __DIR__ . '/../includes/auth.php';
require_once __DIR__ . '/../includes/functions.php';

initSession();

$REPORT_USERS = ['nathan', 'amy', 'adalius'];
if (!isLoggedIn() || !in_array(getCurrentUsername(), $REPORT_USERS)) {
    http_response_code(403);
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'error' => 'Forbidden']);
    exit;
}

header('Content-Type: application/json');

// Parse query params
$search = strtolower(trim($_GET['search'] ?? ''));
$activity = strtolower(trim($_GET['activity'] ?? ''));
$realm = strtoupper(trim($_GET['realm'] ?? ''));
$days = (int)($_GET['days'] ?? 0);
$page = max(1, (int)($_GET['page'] ?? 1));
$perPage = min(500, max(10, (int)($_GET['per_page'] ?? 100)));
$sortCol = $_GET['sort'] ?? 'timestamp';
$sortDir = strtolower($_GET['dir'] ?? 'desc');

$csvFile = __DIR__ . '/../data/logs/login_audit.csv';
$allRows = [];
$headers = [];

if (file_exists($csvFile)) {
    $lines = file($csvFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (count($lines) > 0) {
        $headers = str_getcsv(array_shift($lines));
        foreach ($lines as $line) {
            $row = str_getcsv($line);
            if (count($row) === count($headers)) {
                $allRows[] = array_combine($headers, $row);
            }
        }
    }
}

// Filter
$cutoff = $days > 0 ? date('c', time() - $days * 86400) : '';
$filtered = [];
foreach ($allRows as $row) {
    if ($activity && strtolower($row['activity'] ?? 'login') !== $activity) continue;
    if ($realm && strtoupper($row['realm'] ?? '') !== $realm) continue;
    if ($cutoff && ($row['timestamp'] ?? '') < $cutoff) continue;
    if ($search) {
        $haystack = strtolower(implode(' ', $row));
        if (strpos($haystack, $search) === false) continue;
    }
    $filtered[] = $row;
}

$totalFiltered = count($filtered);
$totalAll = count($allRows);

// Sort
$validCols = array_flip($headers);
if (!isset($validCols[$sortCol])) $sortCol = 'timestamp';
usort($filtered, function($a, $b) use ($sortCol, $sortDir) {
    $cmp = strcmp($a[$sortCol] ?? '', $b[$sortCol] ?? '');
    return $sortDir === 'asc' ? $cmp : -$cmp;
});

// Paginate
$totalPages = max(1, ceil($totalFiltered / $perPage));
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
    'total_pages' => $totalPages
]);
