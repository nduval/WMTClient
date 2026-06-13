#!/usr/bin/env python3
"""
WMT Client Deployment Script
Deploys to Lightsail (SSH) and/or IONOS (SFTP)
"""

import os
import sys
import re
import subprocess
import argparse
import time
from pathlib import Path
from datetime import datetime, timezone

# Base directory
BASE_DIR = Path(__file__).parent

# Files/folders to deploy to IONOS (PHP client)
IONOS_DEPLOY_FILES = [
    '.htaccess',
    'index.php',
    'app.php',
    'characters.php',
    'guest.php',
    'admin.php',
    'report.php',
    'reset-password.php',
    'about.php',
    'solutions.php',
    'contact.php',
    'privacy.php',
    'terms.php',
    'robots.txt',
    'sitemap.xml',
    'composer.json',
    'api/',
    'assets/',
    'config/',
    'includes/',
    'tools/',
    'websocket/',
    'data/.htaccess',
    'data/users/.htaccess',
    'data/users/index.php',
    'data/users/backups/.htaccess',
    'data/users/backups/index.php',
    'data/logs/.htaccess',
    'data/logs/index.php',
    'data/bot_areas.json',
]

# Files to exclude from IONOS deploy
IONOS_EXCLUDE = [
    '.git/',
    '__pycache__/',
    '*.pyc',
]

def load_credentials():
    """Load credentials from files"""
    creds = {}

    # SFTP credentials
    sftp_file = BASE_DIR / 'sftp.txt'
    if sftp_file.exists():
        content = sftp_file.read_text().strip()
        # Parse: host <host> user <user> pass <pass>
        parts = content.split()
        for i, part in enumerate(parts):
            if part == 'host' and i + 1 < len(parts):
                creds['sftp_host'] = parts[i + 1]
            elif part == 'user' and i + 1 < len(parts):
                creds['sftp_user'] = parts[i + 1]
            elif part == 'pass' and i + 1 < len(parts):
                creds['sftp_pass'] = ' '.join(parts[i + 1:])
                break

    return creds

def deploy_lightsail(target='server', force_bridge=False):
    """Deploy to Lightsail via SSH"""
    ssh_key = Path.home() / '.ssh' / 'wmt-client-socket.pem'
    host = '3.14.128.194'
    ssh_cmd = f'ssh -i "{ssh_key}" -o StrictHostKeyChecking=no ubuntu@{host}'

    if target == 'bridge':
        print("\n=== Deploying bridge.js to Lightsail (SSH) ===")
        print("*** WARNING: Restarting bridge.js KILLS ALL active MUD connections! ***")
        print("*** Every connected user will experience linkdeath. ***")

        # Check how many active sessions bridge is holding
        check = subprocess.run(
            f'{ssh_cmd} "sudo journalctl -u wmt-bridge -n 1 --no-pager -o cat"',
            shell=True, capture_output=True, text=True
        )
        last_line = check.stdout.strip()
        if 'Sessions:' in last_line:
            print(f"*** Bridge status: {last_line.strip()} ***")

        # Require explicit --yes flag, no interactive prompt (Claude can't do interactive)
        if not force_bridge:
            print("\nAborted. To confirm, run:  python deploy.py bridge --yes")
            return False

        local_file = BASE_DIR / 'glitch' / 'bridge.js'
        if not local_file.exists():
            print("ERROR: glitch/bridge.js not found")
            return False
        result = subprocess.run(
            f'scp -i "{ssh_key}" "{local_file}" ubuntu@{host}:/tmp/bridge.js',
            shell=True, capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"SCP failed: {result.stderr}")
            return False
        result = subprocess.run(
            f'{ssh_cmd} "sudo cp /tmp/bridge.js /opt/wmt/bridge.js && sudo chown wmt:wmt /opt/wmt/bridge.js && sudo systemctl restart wmt-bridge"',
            shell=True, capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"Deploy failed: {result.stderr}")
            return False
        print("bridge.js deployed and service restarted.")
        return True

    # Default: deploy server.js
    print("\n=== Deploying server.js to Lightsail (SSH) ===")
    local_file = BASE_DIR / 'glitch' / 'server.js'
    if not local_file.exists():
        print("ERROR: glitch/server.js not found")
        return False
    result = subprocess.run(
        f'scp -i "{ssh_key}" "{local_file}" ubuntu@{host}:/tmp/server.js',
        shell=True, capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"SCP failed: {result.stderr}")
        return False
    result = subprocess.run(
        f'{ssh_cmd} "sudo cp /tmp/server.js /opt/wmt/server.js && sudo chown wmt:wmt /opt/wmt/server.js && sudo systemctl restart wmt-server"',
        shell=True, capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"Deploy failed: {result.stderr}")
        return False

    # Verify it started
    time.sleep(2)
    result = subprocess.run(
        f'{ssh_cmd} "systemctl is-active wmt-server"',
        shell=True, capture_output=True, text=True
    )
    status = result.stdout.strip()
    if status == 'active':
        print("server.js deployed and service running.")
    else:
        print(f"WARNING: Service status is '{status}' — check journalctl -u wmt-server")
    return True

def deploy_test_server():
    """Deploy server.js to the test sandbox. Returns True on success, False on failure."""
    print("\n=== Deploying server.js to test sandbox ===")
    ssh_key = Path.home() / '.ssh' / 'test-mud.pem'
    host = '18.225.235.28'

    if not ssh_key.exists():
        print("  ERROR: test-mud.pem not found")
        return False

    local_file = BASE_DIR / 'glitch' / 'server.js'
    if not local_file.exists():
        print("  ERROR: glitch/server.js not found")
        return False

    ssh_cmd = f'ssh -i "{ssh_key}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@{host}'

    result = subprocess.run(
        f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "{local_file}" ubuntu@{host}:/tmp/server.js',
        shell=True, capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"  SCP failed: {result.stderr.strip()}")
        return False

    # Push any repo-tracked test scripts so sandbox runs the version we
    # commit. Test files live in tests/sandbox/ and target /opt/wmt/tests/.
    test_dir = BASE_DIR / 'tests' / 'sandbox'
    if test_dir.exists():
        for tf in test_dir.glob('*.js'):
            r = subprocess.run(
                f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "{tf}" ubuntu@{host}:/tmp/{tf.name}',
                shell=True, capture_output=True, text=True
            )
            if r.returncode == 0:
                subprocess.run(
                    f'{ssh_cmd} "sudo cp /tmp/{tf.name} /opt/wmt/tests/{tf.name} && sudo chown wmt:wmt /opt/wmt/tests/{tf.name}"',
                    shell=True, capture_output=True, text=True
                )

    # Push client JS so the client-side vm tests (var_class_scope, reconnect_gate,
    # var_sync_flush) run against the version we're deploying. They read
    # /opt/wmt/assets/js/<file> when invoked with the gate's ws:// arg.
    for cf in ('app.js', 'connection.js'):
        local_cf = BASE_DIR / 'assets' / 'js' / cf
        if local_cf.exists():
            r = subprocess.run(
                f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "{local_cf}" ubuntu@{host}:/tmp/{cf}',
                shell=True, capture_output=True, text=True
            )
            if r.returncode == 0:
                subprocess.run(
                    f'{ssh_cmd} "sudo mkdir -p /opt/wmt/assets/js && sudo cp /tmp/{cf} /opt/wmt/assets/js/{cf}"',
                    shell=True, capture_output=True, text=True
                )

    # Push current bridge.js so the bridge-mode harness (test_bridge_rekey_resume)
    # runs against the version we ship. Safe: the sandbox wmt-server runs DIRECT
    # mode, so /opt/wmt/bridge.js is not used by the running sandbox service.
    _bridge_local = BASE_DIR / 'glitch' / 'bridge.js'
    if _bridge_local.exists():
        r = subprocess.run(
            f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "{_bridge_local}" ubuntu@{host}:/tmp/bridge.js',
            shell=True, capture_output=True, text=True
        )
        if r.returncode == 0:
            subprocess.run(
                f'{ssh_cmd} "sudo cp /tmp/bridge.js /opt/wmt/bridge.js && sudo chown wmt:wmt /opt/wmt/bridge.js"',
                shell=True, capture_output=True, text=True
            )

    # Stage the PHP auth stack so the PHP login suite (test_php_login.js) can boot
    # the REAL includes/+config/+api under `php -S` against a throwaway data dir.
    # Pushed to /opt/wmt/phpsrc. The admin key is stripped on the sandbox so the
    # suite uses the JSON user fallback (no prod DB / no secret left on the box).
    subprocess.run(f'{ssh_cmd} "rm -rf /tmp/phpsrc && mkdir -p /tmp/phpsrc"',
                   shell=True, capture_output=True, text=True)
    php_ok = True
    for d in ('includes', 'config', 'api'):
        ld = BASE_DIR / d
        if not ld.exists():
            continue
        r = subprocess.run(
            f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 -r "{ld}" ubuntu@{host}:/tmp/phpsrc/',
            shell=True, capture_output=True, text=True
        )
        if r.returncode != 0:
            php_ok = False
            print(f"  WARNING: PHP src push failed for {d}: {r.stderr.strip()}")
    if php_ok:
        subprocess.run(
            f'{ssh_cmd} "sudo rm -rf /opt/wmt/phpsrc && sudo mkdir -p /opt/wmt/phpsrc '
            f'&& sudo cp -r /tmp/phpsrc/* /opt/wmt/phpsrc/ '
            f'&& sudo rm -f /opt/wmt/phpsrc/config/render_admin_key.php '
            f'&& sudo chmod -R a+rX /opt/wmt/phpsrc"',
            shell=True, capture_output=True, text=True
        )

    # Copy + restart. As of 2026-05-25 the allowedServers allowlist lives in
    # /opt/wmt/config/allowed_servers.json (created once per box) rather than
    # being patched into server.js literally. See memory: config-driven-allowed-servers.
    patch_lines = [
        'sudo cp /tmp/server.js /opt/wmt/server.js',
        'sudo chown wmt:wmt /opt/wmt/server.js',
        'sudo systemctl restart wmt-server',
    ]
    patch_content = '#!/bin/bash\nset -e\n' + '\n'.join(patch_lines) + '\n'
    # Write the script locally, SCP it, run it
    patch_file = BASE_DIR / '.deploy_patch.sh'
    patch_file.write_text(patch_content, newline='\n')
    subprocess.run(
        f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "{patch_file}" ubuntu@{host}:/tmp/deploy_patch.sh',
        shell=True, capture_output=True, text=True
    )
    result = subprocess.run(
        f'{ssh_cmd} "bash /tmp/deploy_patch.sh"',
        shell=True, capture_output=True, text=True
    )
    patch_file.unlink(missing_ok=True)
    if result.returncode != 0:
        print(f"  Deploy failed: {result.stderr.strip()}")
        return False

    # Wait for service to start, then verify
    time.sleep(2)
    result = subprocess.run(
        f'{ssh_cmd} "systemctl is-active wmt-server"',
        shell=True, capture_output=True, text=True
    )
    status = result.stdout.strip()
    if status == 'active':
        print("  Test server deployed and running.")
        return True
    else:
        print(f"  WARNING: Service status is '{status}' — check journalctl -u wmt-server")
        return False


def run_test_suites():
    """Run all WMT test suites on sandbox. Returns (total_passed, total_failed, details)."""
    print("\n=== Running test suites on sandbox ===")
    ssh_key = Path.home() / '.ssh' / 'test-mud.pem'
    host = '18.225.235.28'
    ssh_cmd = f'ssh -i "{ssh_key}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@{host}'

    # Known test failures that are accepted and should not block deploy.
    KNOWN_FAILURES = 0

    suites = [
        ('Pipeline',     'test_wmt_client.js'),
        ('Aliases',      'test_alias_compare.js'),
        ('Triggers',     'test_trigger_compare.js'),
        ('DelayAnon',    'test_delay_anon.js'),
        ('EntityGuard',  'test_entity_guard.js'),
        ('BlockTrigger', 'test_block_trigger.js'),
        ('SelfAlerts',   'test_self_alerts.js'),
        ('VarSubst',     'test_var_substitution.js'),
        ('CharSync',     'test_character_sync.js'),
        ('SessionPersist', 'test_session_persist.js'),
        ('AutoLoginGate', 'test_autologin_gate.js'),
        # Client-side (vm-load app.js/connection.js from /opt/wmt/assets/js, synced above)
        ('VarSyncFlush',  'test_var_sync_flush.js'),
        ('VarClassScope', 'test_var_class_scope.js'),
        ('ReconnectGate', 'test_reconnect_gate.js'),
        # Bridge-mode harness — spawns its own bridge.js + wmt-server(BRIDGE_URL)
        # + mock session store; proves the stable-bridgeToken resume/rekey fix
        # (the 2026-06-02 deploy-lockout). The only suite that runs BRIDGE mode.
        ('BridgeRekeyResume', 'test_bridge_rekey_resume.js'),
        # Restore-vs-reconnect RACE (G2/002): a browser that reconnects with a drifted
        # token DURING the restore window must adopt the persisted stable bridgeToken
        # and RESUME the live socket, not fresh-login. The 2026-06-11 elminster boot.
        # Bridge-mode harness; restore deterministically delayed via BRIDGE_RESTORE_DELAY_MS.
        ('BridgeResumeRace', 'test_bridge_resume_race.js'),
        # Client-side: "already logged in and active" stops the auto-login loop +
        # connect() dedup (vm-loads app.js + connection.js). Guards #4 hardening.
        ('LoginConflict',  'test_login_conflict.js'),
        # Bridge orphan-reaper (#3, G4): reaps stranded sockets, spares claimed
        # ones, and never reaps during a server outage. Spawns its own bridge.js.
        ('BridgeOrphanReaper', 'test_bridge_orphan_reaper.js'),
        # Disconnect detach-only + server-side #end (mobile-suspend fixes): a bare
        # disconnect detaches one device & keeps MUD/bot alive; intentional + #end close.
        ('DisconnectDetach', 'test_disconnect_detach.js'),
        # Idle auto-#end guard: a ticker/trigger-driven #end is SUPPRESSED while the
        # player is actively typing (lastInputAt < grace) but FIRES once genuinely
        # idle — fixes the 2026-06-07 active-player auto-disconnect.
        ('IdleEndGuard', 'test_idle_end_guard.js'),
        # Multi-device coexistence: 2 devices share one session — both get output,
        # both can send, neither kicked, one MUD connection, detach-safe.
        ('MultiDevice', 'test_multidevice.js'),
        # PHP login flow: boots the real includes/+config/+api under `php -S`
        # (staged at /opt/wmt/phpsrc) — guards the double-login fix (single
        # session lifecycle) + login-stack smoke test. NOTE: PHP 8.3 masks the
        # prod-only multi-cookie race; this guards total breakage + clean cookie.
        ('PhpLogin', 'test_php_login.js'),
        # Guild-file editor: MIP download (CDF/CCF/CEF) → browser, and raw paced
        # 3ksendfile upload; round-trips a file with ;/#/$ to prove raw passthrough.
        # Needs the extended mock-mud.js (CDF/CCF/CEF + 3ksendfile + __setmip).
        ('FileTransfer', 'test_file_transfer.js'),
        # Tier B: a bridge-resumed auto-reconnect that lands at a name prompt RELINKS
        # (deploy/blip dropped a live char) instead of destroying the socket — the
        # mimic deploy-boot. Suppression still holds when no socket was held
        # (AutoLoginGate). See bug_resume_name_prompt_autologin_suppressed.
        ('TierBRelink', 'test_tierb_relink.js'),
        # Crash resilience (review C2 + local SQLite persist store): an induced
        # uncaughtException must persist live state SYNCHRONOUSLY to the local
        # store (snapshot disabled, remote untouched) and a fresh instance must
        # restore from local + resume the live bridge socket — a crash is a blip.
        ('CrashPersist', 'test_crash_persist.js'),
    ]

    total_passed = 0
    total_failed = 0
    details = []

    for label, script in suites:
        try:
            # sudo -n: tests like test_entity_guard.js need to read /opt/wmt/wmt.db
            # which is root-owned. -n fails fast if sudo would prompt (NOPASSWD
            # is configured for ubuntu on the sandbox).
            result = subprocess.run(
                f'{ssh_cmd} "cd /opt/wmt/tests && sudo -n node {script} ws://localhost:3000"',
                shell=True, capture_output=True, text=True, timeout=60
            )
        except subprocess.TimeoutExpired:
            details.append((label, script, 0, 0, 'TIMEOUT'))
            total_failed += 1
            continue

        output = result.stdout + result.stderr

        # Parse "Results: X passed, Y failed" or "=== Results: X passed, Y failed ==="
        match = re.search(r'(\d+)\s+passed,\s+(\d+)\s+failed', output)
        if match:
            passed = int(match.group(1))
            failed = int(match.group(2))
        elif result.returncode == 0:
            # No parseable results but exited OK — count as 1 pass
            passed = 1
            failed = 0
        else:
            # Can't parse and non-zero exit — count as failure
            passed = 0
            failed = 1

        total_passed += passed
        total_failed += failed
        status = 'PASS' if failed == 0 else 'FAIL'
        details.append((label, script, passed, failed, status))

    # Print summary table
    for label, script, passed, failed, status in details:
        icon = 'OK' if status == 'PASS' else ('FAIL' if status == 'FAIL' else '??')
        pad_label = f"{label} ({script}):".ljust(45)
        print(f"  {pad_label} {passed:>2} passed, {failed} failed  {icon}")

    total = total_passed + total_failed
    print(f"  {'':45} {'---':>10}")
    print(f"  {'Total:':45} {total_passed:>2}/{total} passed")

    # Subtract known/accepted failures so they don't block deploy
    unexpected_failures = max(0, total_failed - KNOWN_FAILURES)
    if total_failed > 0 and unexpected_failures == 0:
        print(f"\n  ({total_failed} known failure(s) — not blocking deploy)")

    return total_passed, unexpected_failures, details


def print_prod_db_health():
    """Print the latest production DB health block (written daily by
    /opt/wmt/db-stats.py via cron). Surfaced during the deploy test phase so DB
    health is reviewed at every deploy. Best-effort: never blocks a deploy."""
    ssh_key = Path.home() / '.ssh' / 'wmt-client-socket.pem'
    host = '3.14.128.194'
    try:
        result = subprocess.run(
            f'ssh -i "{ssh_key}" -o ConnectTimeout=15 ubuntu@{host} "cat /opt/wmt/db-stats/latest.txt 2>/dev/null"',
            shell=True, capture_output=True, text=True, timeout=30
        )
        out = (result.stdout or '').strip()
        print("\n=== Production database health ===")
        print(out if out else "  (no snapshot yet — db-stats cron has not run)")
    except Exception as e:
        print(f"\n=== Production database health ===\n  (unavailable: {e})")


def deploy_ionos(only_files=None):
    """Deploy PHP/JS/CSS client files to IONOS via SFTP (skips unchanged files).
    If only_files is given (list of repo-relative paths), upload exactly those
    instead of the whole IONOS_DEPLOY_FILES set — used by the smart `auto` target
    so a deploy pushes only what changed and never sweeps in untracked WIP."""
    print("\n=== Deploying to IONOS (SFTP) ===")

    try:
        import paramiko
    except ImportError:
        print("ERROR: paramiko not installed. Run: pip install paramiko")
        return False

    creds = load_credentials()
    if not all(k in creds for k in ['sftp_host', 'sftp_user', 'sftp_pass']):
        print("ERROR: Missing SFTP credentials in sftp.txt")
        return False

    remote_base = ''  # Root directory on IONOS (subdomain root is /client)

    try:
        # Connect
        print(f"Connecting to {creds['sftp_host']}...")
        transport = paramiko.Transport((creds['sftp_host'], 22))
        transport.connect(username=creds['sftp_user'], password=creds['sftp_pass'])
        sftp = paramiko.SFTPClient.from_transport(transport)

        # Ensure remote base exists (skip if root)
        if remote_base:
            try:
                sftp.stat(remote_base)
            except FileNotFoundError:
                sftp.mkdir(remote_base)

        uploaded = 0
        skipped = 0

        def should_exclude(path):
            path_str = str(path)
            for exc in IONOS_EXCLUDE:
                if exc.endswith('/'):
                    if exc[:-1] in path_str:
                        return True
                elif exc.startswith('*'):
                    if path_str.endswith(exc[1:]):
                        return True
                elif exc in path_str:
                    return True
            return False

        def needs_upload(local_full, remote_full):
            """Check if local file differs from remote (by size)"""
            try:
                remote_stat = sftp.stat(remote_full)
                local_size = local_full.stat().st_size
                return local_size != remote_stat.st_size
            except (FileNotFoundError, IOError):
                return True  # Remote doesn't exist, upload it

        def upload_path(local_path, remote_path):
            nonlocal uploaded, skipped

            if should_exclude(local_path):
                return

            local_full = BASE_DIR / local_path
            # Convert Windows backslashes to forward slashes for SFTP
            remote_path_unix = remote_path.replace('\\', '/')
            if remote_base:
                remote_full = f"{remote_base}/{remote_path_unix}"
            else:
                remote_full = remote_path_unix

            if local_full.is_file():
                # Skip unchanged files
                if not needs_upload(local_full, remote_full):
                    skipped += 1
                    return

                # Ensure parent directory exists
                remote_dir = '/'.join(remote_full.split('/')[:-1])
                if remote_dir:  # Only check/create if not in root
                    try:
                        sftp.stat(remote_dir)
                    except FileNotFoundError:
                        # Create parent directories
                        parts = remote_dir.split('/')
                        for i in range(1, len(parts) + 1):
                            path_to_check = '/'.join(parts[:i])
                            if path_to_check:  # Skip empty paths
                                try:
                                    sftp.stat(path_to_check)
                                except FileNotFoundError:
                                    sftp.mkdir(path_to_check)

                print(f"  Uploading {remote_path_unix}...")
                sftp.put(str(local_full), remote_full)
                uploaded += 1

            elif local_full.is_dir():
                # Create remote directory
                try:
                    sftp.stat(remote_full)
                except FileNotFoundError:
                    sftp.mkdir(remote_full)

                # Upload contents
                for item in local_full.iterdir():
                    rel_path = item.relative_to(BASE_DIR)
                    upload_path(str(rel_path), str(rel_path))

        # Upload the requested files, or the full deploy set (unchanged files skipped).
        items = only_files if only_files is not None else IONOS_DEPLOY_FILES
        for item in items:
            upload_path(item, item)

        sftp.close()
        transport.close()

        print(f"Uploaded {uploaded} files to IONOS ({skipped} unchanged, skipped).")
        return True

    except Exception as e:
        print(f"SFTP Error: {e}")
        return False

def git_commit_before_deploy():
    """Auto-commit tracked changes before deploying (for easy rollback)"""
    # Check for any staged or unstaged changes to tracked files
    result = subprocess.run(
        'git status --porcelain',
        shell=True, capture_output=True, text=True, cwd=str(BASE_DIR)
    )
    if result.returncode != 0:
        print("WARNING: git status failed, skipping auto-commit")
        return

    lines = result.stdout.strip().splitlines() if result.stdout.strip() else []
    # Filter to only tracked changes (M, D, R, etc. — skip ?? untracked)
    tracked_changes = [l for l in lines if not l.startswith('??')]
    if not tracked_changes:
        print("No tracked changes to commit.")
        return

    # Build a summary of what changed
    changed_files = []
    for line in tracked_changes:
        # Format: "XY filename" or "XY filename -> newname" (renames)
        # Skip 2-char status, strip whitespace (handles tabs/spaces)
        filepath = line[2:].lstrip().strip('"').split(' -> ')[-1].strip('"')
        changed_files.append(filepath)

    # Summarize by area
    areas = set()
    for f in changed_files:
        if 'server.js' in f or 'bridge.js' in f:
            areas.add('server')
        elif f.startswith('assets/js/'):
            areas.add('client JS')
        elif f.startswith('assets/css/'):
            areas.add('CSS')
        elif f.startswith('api/'):
            areas.add('API')
        elif f.startswith('includes/'):
            areas.add('includes')
        elif f.startswith('docs/'):
            areas.add('docs')
        elif f.endswith('.php'):
            areas.add('PHP')
        elif f.endswith('.py'):
            areas.add('tooling')
        elif f.endswith('.md'):
            areas.add('config')
        else:
            areas.add('other')

    area_str = ', '.join(sorted(areas))
    msg = f"Deploy: update {area_str}"

    print(f"\n=== Auto-commit before deploy ===")
    print(f"  Changed files: {', '.join(changed_files)}")
    print(f"  Commit message: {msg}")

    # Stage tracked changes only (no untracked files)
    subprocess.run('git add -u', shell=True, cwd=str(BASE_DIR))
    # Commit
    result = subprocess.run(
        ['git', 'commit', '-m', msg],
        capture_output=True, text=True, cwd=str(BASE_DIR)
    )
    if result.returncode == 0:
        print(f"  Committed successfully.")
    else:
        print(f"  Commit failed: {result.stderr.strip()}")


def log_deploy(target, commit_hash, success):
    """Append a line to the deploy log on Lightsail (always, even with no code changes)"""
    ssh_key = Path.home() / '.ssh' / 'wmt-client-socket.pem'
    host = '3.14.128.194'
    ssh_cmd = f'ssh -i "{ssh_key}" -o StrictHostKeyChecking=no ubuntu@{host}'
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    status = 'OK' if success else 'FAILED'
    entry = f'{ts} target={target} commit={commit_hash} status={status}'
    subprocess.run(
        f'{ssh_cmd} "echo \'{entry}\' | sudo tee -a /var/log/wmt/deploy.log > /dev/null"',
        shell=True, capture_output=True, text=True
    )
    print(f"  Deploy logged: {entry}")


DEPLOY_STATE_FILE = BASE_DIR / '.deploy_state.json'

def read_deploy_state():
    """Last commit successfully deployed by `auto`. None if unknown."""
    try:
        import json
        return json.loads(DEPLOY_STATE_FILE.read_text()).get('last_commit')
    except Exception:
        return None

def write_deploy_state(commit):
    try:
        import json
        DEPLOY_STATE_FILE.write_text(json.dumps({'last_commit': commit}, indent=2))
    except Exception as e:
        print(f"  WARNING: could not write {DEPLOY_STATE_FILE.name}: {e}")

def git_changed_files(baseline):
    """Tracked files changed since `baseline` — committed (baseline..HEAD) PLUS any
    uncommitted tracked changes (so --dry-run previews correctly before auto-commit).
    Returns a sorted list of forward-slash repo-relative paths, or None if baseline
    is unknown / git fails."""
    if not baseline:
        return None
    files = set()
    r = subprocess.run(f'git diff --name-only {baseline} HEAD',
                       shell=True, capture_output=True, text=True, cwd=str(BASE_DIR))
    if r.returncode != 0:
        return None
    files.update(l.strip() for l in r.stdout.splitlines() if l.strip())
    # Uncommitted tracked changes (staged + unstaged) vs HEAD
    r2 = subprocess.run('git diff --name-only HEAD',
                        shell=True, capture_output=True, text=True, cwd=str(BASE_DIR))
    if r2.returncode == 0:
        files.update(l.strip() for l in r2.stdout.splitlines() if l.strip())
    return sorted(files)

def is_ionos_path(f):
    """True if a repo-relative path belongs to the IONOS deploy set."""
    for entry in IONOS_DEPLOY_FILES:
        e = entry.replace('\\', '/')
        if e.endswith('/'):
            if f.startswith(e):
                return True
        elif f == e:
            return True
    return False


def main():
    parser = argparse.ArgumentParser(description='Deploy WMT Client')
    parser.add_argument('target', nargs='?', choices=['ionos', 'lightsail', 'bridge', 'test', 'all', 'auto'],
                       default='auto', help='Deployment target (default: auto — deploy only what changed)')
    parser.add_argument('--list', action='store_true', help='List files that would be deployed')
    parser.add_argument('--no-commit', action='store_true', help='Skip auto-commit before deploy')
    parser.add_argument('--yes', action='store_true', help='Confirm bridge deploy (required — bridge restart kills ALL MUD connections)')
    parser.add_argument('--force', action='store_true', help='Deploy to production even if sandbox tests fail')
    parser.add_argument('--dry-run', action='store_true', help='(auto) Show what would deploy without changing anything')

    args = parser.parse_args()

    if args.list:
        print("Files deployed to IONOS:")
        for f in IONOS_DEPLOY_FILES:
            print(f"  {f}")
        print("\nFiles deployed to Lightsail:")
        print("  server.js (lightsail target)")
        print("  bridge.js (bridge target)")
        return

    # --- Test-only target ---
    if args.target == 'test':
        if not deploy_test_server():
            print("\n=== Test deploy failed ===")
            sys.exit(1)
        passed, failed, details = run_test_suites()
        print_prod_db_health()
        if failed > 0:
            print(f"\n=== {failed} test(s) failed ===")
            sys.exit(1)
        else:
            print(f"\n=== All {passed} tests passed ===")
        return

    # Auto-commit tracked changes before deploying (never during a dry-run)
    if not args.no_commit and not args.dry_run:
        git_commit_before_deploy()

    # Get current commit hash for deploy log
    commit_result = subprocess.run(
        'git rev-parse --short HEAD', shell=True,
        capture_output=True, text=True, cwd=str(BASE_DIR)
    )
    commit_hash = commit_result.stdout.strip() if commit_result.returncode == 0 else 'unknown'

    success = True

    # --- All target: test-first pipeline ---
    if args.target == 'all':
        # Deploy to sandbox and run tests first
        test_ok = False
        if deploy_test_server():
            passed, failed, details = run_test_suites()
            print_prod_db_health()
            if failed == 0:
                test_ok = True
            else:
                print(f"\nWARNING: {failed} test(s) failed on sandbox.")
                if args.force:
                    print("  --force specified, proceeding to production anyway.")
                else:
                    print("  Aborting production deploy. Use --force to override.")
                    sys.exit(1)
        else:
            print("\nWARNING: Test sandbox deploy failed.")
            if args.force:
                print("  --force specified, proceeding to production anyway.")
            else:
                print("  Aborting production deploy. Use --force to override.")
                sys.exit(1)

        # Deploy to production
        if not deploy_lightsail('server'):
            success = False
        if not deploy_ionos():
            success = False

    elif args.target == 'lightsail':
        # Same test-gate as 'all' so a quick `lightsail` deploy can't bypass
        # regression checks. The April-May 2026 #delay regression shipped via
        # this code path because tests weren't run. Use --force to override.
        if deploy_test_server():
            passed, failed, details = run_test_suites()
            print_prod_db_health()
            if failed > 0:
                print(f"\nWARNING: {failed} test(s) failed on sandbox.")
                if args.force:
                    print("  --force specified, proceeding to production anyway.")
                else:
                    print("  Aborting production deploy. Use --force to override.")
                    sys.exit(1)
        else:
            print("\nWARNING: Test sandbox deploy failed.")
            if not args.force:
                print("  Aborting production deploy. Use --force to override.")
                sys.exit(1)
        if not deploy_lightsail('server'):
            success = False

    elif args.target == 'bridge':
        if not deploy_lightsail('bridge', force_bridge=args.yes):
            success = False

    elif args.target == 'ionos':
        if not deploy_ionos():
            success = False

    elif args.target == 'auto':
        baseline = read_deploy_state()
        changed = git_changed_files(baseline)
        print("\n=== Smart deploy (auto) ===")
        if changed is None:
            print("  No deploy baseline in .deploy_state.json — can't compute what's necessary.")
            print("  Bootstrap once: write the last-deployed commit hash to .deploy_state.json")
            print('  (e.g. {"last_commit": "<hash>"}), or run an explicit target this time.')
            sys.exit(1)

        server_changed = 'glitch/server.js' in changed
        bridge_changed = 'glitch/bridge.js' in changed
        ionos_files = [f for f in changed if is_ionos_path(f)]
        other = [f for f in changed
                 if not is_ionos_path(f) and f not in ('glitch/server.js', 'glitch/bridge.js')]

        print(f"  Baseline {baseline} -> HEAD {commit_hash}")
        if not changed:
            print("  No tracked changes since last deploy — nothing to do.")
            return
        print(f"  Changed ({len(changed)}): {', '.join(changed)}")
        print(f"  -> Lightsail (server.js / wmt-server restart): {'YES' if server_changed else 'no'}")
        print(f"  -> IONOS: {', '.join(ionos_files) if ionos_files else '(none)'}")
        if other:
            print(f"  -> Not deployed (tooling/tests/docs): {', '.join(other)}")
        if bridge_changed:
            print("  *** bridge.js changed — NOT auto-deployed (restart kills ALL MUD connections).")
            print("      Run `python deploy.py bridge --yes` manually if you really intend that. ***")

        if args.dry_run:
            print("  [dry-run] No changes made.")
            return

        if not server_changed and not ionos_files:
            print("  Nothing deployable changed (only tooling/tests/docs).")
            return

        # Server first (gated by the sandbox suite), then IONOS. Only restart
        # wmt-server when server.js actually changed — client-only deploys never
        # restart the proxy, so connected players are never disrupted.
        if server_changed:
            if deploy_test_server():
                passed, failed, details = run_test_suites()
                if failed > 0 and not args.force:
                    print(f"\nWARNING: {failed} sandbox test(s) failed. Aborting. Use --force to override.")
                    sys.exit(1)
            elif not args.force:
                print("\nWARNING: sandbox deploy failed. Aborting. Use --force to override.")
                sys.exit(1)
            if not deploy_lightsail('server'):
                success = False
        if ionos_files:
            if not deploy_ionos(only_files=ionos_files):
                success = False
        if success:
            write_deploy_state(commit_hash)

    # Log every deploy to Lightsail for audit trail
    log_deploy(args.target, commit_hash, success)

    if success:
        print("\n=== Deployment complete! ===")
    else:
        print("\n=== Deployment had errors ===")
        sys.exit(1)

if __name__ == '__main__':
    main()
