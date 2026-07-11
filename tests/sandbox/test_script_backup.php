<?php
/**
 * CLI test for backupScriptFile() + isBackupArtifact() (2026-07-11).
 * Synthetic files in a unique temp dir; no session/DB needed.
 * Verifies: rotation shift, .1 = latest prior, cap at N, daily/weekly snapshot,
 * backup-artifact detection (and that user-named .bak files are NOT matched),
 * and that backups are excluded from the storage count.
 * Runs in the deploy gate (deploy.py runs *.php suites with `php`) and manually.
 */
error_reporting(E_ALL & ~E_DEPRECATED);

// Locate functions.php: gate stages it at /opt/wmt/phpsrc; /tmp for manual runs.
$fn = null;
foreach (['/opt/wmt/phpsrc/includes/functions.php', '/tmp/functions.php',
          __DIR__ . '/../../includes/functions.php'] as $cand) {
    if (is_file($cand)) { $fn = $cand; break; }
}
if (!$fn) { fwrite(STDERR, "functions.php not found\n"); echo "\nResults: 0 passed, 1 failed\n"; exit(1); }
require $fn;

$base = sys_get_temp_dir() . '/sbt_' . getmypid();
@mkdir("$base/data/users/u1/scripts", 0777, true);

$pass = 0; $fail = 0;
function t($n, $c) { global $pass, $fail; if ($c) { $pass++; echo "  PASS: $n\n"; } else { $fail++; echo "  FAIL: $n\n"; } }

$dir = "$base/data/users/u1/scripts";
$f = "$dir/hp.tin";

// ── isBackupArtifact ──
t('T1: .1 numeric rotation is a backup artifact', isBackupArtifact('hp.tin.1'));
t('T2: .10 is a backup artifact', isBackupArtifact('hp.tin.10'));
t('T3: .daily.YYYY-MM-DD is a backup artifact', isBackupArtifact('hp.tin.daily.2026-07-11'));
t('T4: .weekly.YYYY-Www is a backup artifact', isBackupArtifact('hp.tin.weekly.2026-W28'));
t('T5: .tmp.* is a backup artifact', isBackupArtifact('aliases.json.tmp.abc123'));
t('T6: live hp.tin is NOT a backup artifact', !isBackupArtifact('hp.tin'));
t('T7: user-named hp.tin.bak-summonsfix is NOT a backup artifact', !isBackupArtifact('hp.tin.bak-summonsfix'));

// ── rotation: write v1, back up, write v2, back up, ... ──
file_put_contents($f, 'v1');
backupScriptFile($f);                       // file exists → .1 = v1 (copy of current)
t('T8: first backup made .1 = current content', is_file("$f.1") && file_get_contents("$f.1") === 'v1');
file_put_contents($f, 'v2');
backupScriptFile($f);                       // .2 = old .1 (v1), .1 = v2
t('T9: rotation shifted (.2=v1, .1=v2)', file_get_contents("$f.2") === 'v1' && file_get_contents("$f.1") === 'v2');
file_put_contents($f, 'v3'); backupScriptFile($f);
t('T10: .1 always most recent prior (.1=v3)', file_get_contents("$f.1") === 'v3');

// cap at 10 rotations: .1..10 exist, .11 never does
for ($i = 4; $i <= 15; $i++) { file_put_contents($f, "v$i"); backupScriptFile($f); }
t('T11: rotations capped at 10 (.10 exists, .11 does not)', is_file("$f.10") && !is_file("$f.11"));

// daily + weekly snapshots exist
$today = date('Y-m-d'); $week = date('o-\WW');
t('T12: daily snapshot created', is_file("$f.daily.$today"));
t('T13: weekly snapshot created (ISO year label)', is_file("$f.weekly.$week"));

// weekly not self-pruned on creation (the finding-7 regression)
t('T14: weekly snapshot survived its own creation (not pruned)', is_file("$f.weekly.$week"));

// ── storage accounting excludes backups ──
// Only hp.tin counts; the ~20+ backup siblings do not.
$count = getDirectoryFileCount("$base/data/users/u1");
t('T15: storage file count excludes backups (only hp.tin counts = 1)', $count === 1);

// first-save no-op: a fresh file has no prior to back up
$g = "$dir/new.tin";
backupScriptFile($g);   // file doesn't exist yet
t('T16: backup on absent file is a no-op (no .1 created)', !is_file("$g.1"));

echo "\nResults: $pass passed, $fail failed\n";
exit($fail ? 1 : 0);
