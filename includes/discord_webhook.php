<?php
/**
 * Discord webhook URL validation — the ONE definition the save path uses.
 *
 * NOT site-wide included (functions.php stays untouched); required by
 * api/preferences.php and by tests/sandbox/test_discord_webhook_url.php.
 *
 * Accepted:  https://discord.com/api/webhooks/<id>/<token>
 *            https://discordapp.com/api/webhooks/<id>/<token>
 *            either of the above + ?thread_id=<post id>   (forum-channel posts)
 *
 * 2026-10-13: the old pattern required the URL to END at the token. A user
 * entered forum-channel webhooks (…/<token>?thread_id=<post id>) on 21 channels;
 * the save validator silently stored '' for each one while the live wmt-server
 * (prefix check only) kept posting from memory, so it "initially worked" and
 * died on the next reload. See memory/bug_discord_webhook_threadid_silently_blanked.md.
 */

function wmtDiscordWebhookPattern(): string {
    return '#^https://(discord\.com|discordapp\.com)/api/webhooks/[0-9]+/[A-Za-z0-9_-]+(\?thread_id=[0-9]+)?$#';
}

/**
 * Trim ASCII whitespace plus the invisible characters that ride along with a
 * copy/paste out of chat apps (NBSP, zero-width space/joiners, BOM).
 */
function wmtNormalizeDiscordWebhookUrl($url): string {
    if (!is_string($url)) return '';
    $u = trim($url);
    $stripped = preg_replace('/[\x{00A0}\x{200B}\x{200C}\x{200D}\x{FEFF}]+/u', '', $u);
    if ($stripped !== null) $u = $stripped;   // null = invalid UTF-8; keep as-is, regex will reject
    return trim($u);
}

/**
 * @return array{ok: bool, url: string}  ok=true with url='' means "cleared";
 *         ok=false means REJECTED — the caller must NOT store '' over an
 *         existing URL; keep the stored one and report the rejection.
 */
function wmtValidateDiscordWebhookUrl($url): array {
    $u = wmtNormalizeDiscordWebhookUrl($url);
    if ($u === '') return ['ok' => true, 'url' => ''];
    return ['ok' => (bool)preg_match(wmtDiscordWebhookPattern(), $u), 'url' => $u];
}
