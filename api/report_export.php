<?php
/**
 * Export login audit CSV — admin only
 */
require_once __DIR__ . '/../includes/auth.php';

initSession();

$REPORT_USERS = ['nathan', 'amy', 'adalius'];
if (!isLoggedIn() || !in_array(getCurrentUsername(), $REPORT_USERS)) {
    http_response_code(403);
    exit('Forbidden');
}

$csvFile = __DIR__ . '/../data/logs/login_audit.csv';
if (!file_exists($csvFile)) {
    http_response_code(404);
    exit('No data');
}

header('Content-Type: text/csv');
header('Content-Disposition: attachment; filename="login_audit_' . date('Y-m-d') . '.csv"');
readfile($csvFile);
