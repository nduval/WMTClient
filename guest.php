<?php
/**
 * WMT Client - Guest Login
 * Sets up a guest session and redirects to app.php
 * Guest accounts connect as "guest" with no password on the MUD.
 */

require_once __DIR__ . '/includes/auth.php';

initSession();

$server = isset($_GET['server']) ? $_GET['server'] : '3k';
if ($server !== '3k' && $server !== '3s') {
    $server = '3k';
}

// Set up guest session - use a unique guest ID per session to avoid conflicts
$guestId = 'guest_' . bin2hex(random_bytes(8));

$_SESSION['user_id'] = $guestId;
$_SESSION['username'] = 'guest';
$_SESSION['character_id'] = 'guest';
$_SESSION['character_name'] = 'guest';
$_SESSION['character_server'] = $server;
$_SESSION['is_guest'] = true;

header('Location: app.php');
exit;
