<?php
/**
 * DiscordWebhookUrl — pure PHP CLI suite for includes/discord_webhook.php.
 *
 * Why: 2026-10-13 mimic's 21 forum-channel webhooks (…/<token>?thread_id=<post>)
 * were silently blanked by api/preferences.php's save validator while the live
 * server kept posting from memory. This pins the accepted forms, the rejected
 * forms, and the "rejected must never mean cleared" contract the save path relies on.
 *
 * Run (sandbox gate): cd /opt/wmt/tests && sudo -n php test_discord_webhook_url.php
 */

$fn = null;
foreach (['/opt/wmt/phpsrc/includes/discord_webhook.php', '/tmp/phpsrc/includes/discord_webhook.php',
          __DIR__ . '/../../includes/discord_webhook.php'] as $cand) {
    if (file_exists($cand)) { $fn = $cand; break; }
}
if (!$fn) { fwrite(STDERR, "discord_webhook.php not found\n"); echo "\nResults: 0 passed, 1 failed\n"; exit(1); }
require $fn;

echo "=== DiscordWebhookUrl ===\n";
$pass = 0; $fail = 0;
function t($n, $c) { global $pass, $fail; if ($c) { $pass++; echo "  PASS: $n\n"; } else { $fail++; echo "  FAIL: $n\n"; } }

$tok  = str_repeat('Ab_-9', 13) . 'xyz';                       // 68 chars of [A-Za-z0-9_-]
$base = 'https://discord.com/api/webhooks/1484361602240348250/' . $tok;
$app  = 'https://discordapp.com/api/webhooks/1144009533073657987/' . $tok;

// --- accepted ---
$r = wmtValidateDiscordWebhookUrl($base);
t('T1 plain discord.com URL accepted, unchanged', $r['ok'] && $r['url'] === $base);
$r = wmtValidateDiscordWebhookUrl($app);
t('T2 plain discordapp.com URL accepted', $r['ok'] && $r['url'] === $app);
$r = wmtValidateDiscordWebhookUrl($base . '?thread_id=1427000000000000001');
t('T3 forum form ?thread_id=<post id> accepted (the 2026-10-13 case)', $r['ok'] && $r['url'] === $base . '?thread_id=1427000000000000001');
$r = wmtValidateDiscordWebhookUrl("  $base\n");
t('T4 surrounding ASCII whitespace trimmed', $r['ok'] && $r['url'] === $base);
$r = wmtValidateDiscordWebhookUrl($base . "\xC2\xA0");
t('T5 trailing NBSP stripped (chat-app paste)', $r['ok'] && $r['url'] === $base);
$r = wmtValidateDiscordWebhookUrl("\xEF\xBB\xBF" . $base . "\xE2\x80\x8B");
t('T6 BOM + zero-width space stripped', $r['ok'] && $r['url'] === $base);
$r = wmtValidateDiscordWebhookUrl('');
t('T7 empty string = clear (ok, url empty)', $r['ok'] && $r['url'] === '');
$r = wmtValidateDiscordWebhookUrl('   ');
t('T8 whitespace-only = clear', $r['ok'] && $r['url'] === '');
$r = wmtValidateDiscordWebhookUrl(null);
t('T9 non-string = clear, no warning', $r['ok'] && $r['url'] === '');

// --- rejected (ok=false; caller keeps the stored URL) ---
foreach ([
    'T10 ?wait=true query'           => $base . '?wait=true',
    'T11 thread_id non-numeric'      => $base . '?thread_id=abc',
    'T12 extra query after thread'   => $base . '?thread_id=1&wait=true',
    'T13 trailing slash'             => $base . '/',
    'T14 /github suffix'             => $base . '/github',
    'T15 trailing period'            => $base . '.',
    'T16 token with dot'             => str_replace($tok, substr($tok, 0, 30) . '.' . substr($tok, 31), $base),
    'T17 ptb.discord.com host'       => str_replace('https://discord.com', 'https://ptb.discord.com', $base),
    'T18 http (not https)'           => str_replace('https://', 'http://', $base),
    'T19 angle-bracket wrapped'      => '<' . $base . '>',
    'T20 not a webhook at all'       => 'https://example.com/hook',
] as $name => $u) {
    $r = wmtValidateDiscordWebhookUrl($u);
    t("$name rejected", !$r['ok']);
}

// --- normaliser is idempotent and never invents content ---
t('T21 normalise idempotent', wmtNormalizeDiscordWebhookUrl(wmtNormalizeDiscordWebhookUrl(" $base ")) === $base);
t('T22 invalid UTF-8 does not crash and is rejected', !wmtValidateDiscordWebhookUrl($base . "\xFF")['ok']);

echo "\nResults: $pass passed, $fail failed\n";
exit($fail > 0 ? 1 : 0);
