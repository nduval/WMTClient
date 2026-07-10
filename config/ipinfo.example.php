<?php
/**
 * ipinfo.io API token — copy to config/ipinfo.php (gitignored) and fill in.
 * Free signup at https://ipinfo.io/signup gives 50k req/month; without a
 * token the audit geo lookups run unauthenticated (~1k/day) and rely on
 * the per-IP cache (geoLookupCached) to stay under the limit.
 */
define('IPINFO_TOKEN', 'YOUR_TOKEN_HERE');
