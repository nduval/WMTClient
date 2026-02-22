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
    'index.php',
    'app.php',
    'characters.php',
    'guest.php',
    'admin.php',
    'reset-password.php',
    'composer.json',
    'api/',
    'assets/',
    'config/',
    'includes/',
    'websocket/',
    'data/.htaccess',
    'data/users/.htaccess',
    'data/users/index.php',
    'data/users/backups/.htaccess',
    'data/users/backups/index.php',
    'data/logs/.htaccess',
    'data/logs/index.php',
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

    # Copy, patch allowedServers to include localhost:4000 (mock MUD), restart
    # Write a patch script remotely to avoid Windows/SSH quoting issues
    patch_lines = [
        'sudo cp /tmp/server.js /opt/wmt/server.js',
        "sudo sed -i \"s|{ host: '3k.org', port: 3000 }|{ host: '3k.org', port: 3000 }, { host: 'localhost', port: 4000 }|\" /opt/wmt/server.js",
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

    suites = [
        ('Pipeline',  'test_wmt_client.js'),
        ('Aliases',   'test_alias_compare.js'),
        ('Triggers',  'test_trigger_compare.js'),
    ]

    total_passed = 0
    total_failed = 0
    details = []

    for label, script in suites:
        try:
            result = subprocess.run(
                f'{ssh_cmd} "cd /opt/wmt/tests && node {script} ws://localhost:3000"',
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

    return total_passed, total_failed, details


def deploy_ionos():
    """Deploy PHP client to IONOS via SFTP"""
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

        def upload_path(local_path, remote_path):
            nonlocal uploaded

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

        # Upload each deploy file/folder
        for item in IONOS_DEPLOY_FILES:
            upload_path(item, item)

        sftp.close()
        transport.close()

        print(f"Uploaded {uploaded} files to IONOS.")
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


def main():
    parser = argparse.ArgumentParser(description='Deploy WMT Client')
    parser.add_argument('target', nargs='?', choices=['ionos', 'lightsail', 'bridge', 'test', 'all'],
                       default='all', help='Deployment target (default: all)')
    parser.add_argument('--list', action='store_true', help='List files that would be deployed')
    parser.add_argument('--no-commit', action='store_true', help='Skip auto-commit before deploy')
    parser.add_argument('--yes', action='store_true', help='Confirm bridge deploy (required — bridge restart kills ALL MUD connections)')
    parser.add_argument('--force', action='store_true', help='Deploy to production even if sandbox tests fail')

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
        if failed > 0:
            print(f"\n=== {failed} test(s) failed ===")
            sys.exit(1)
        else:
            print(f"\n=== All {passed} tests passed ===")
        return

    # Auto-commit tracked changes before deploying
    if not args.no_commit:
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
            if failed == 0:
                test_ok = True
            else:
                print(f"\n\u26a0 {failed} test(s) failed on sandbox.")
                if args.force:
                    print("  --force specified, proceeding to production anyway.")
                else:
                    print("  Aborting production deploy. Use --force to override.")
                    sys.exit(1)
        else:
            print("\n\u26a0 Test sandbox deploy failed.")
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
        if not deploy_lightsail('server'):
            success = False
        deploy_test_server()  # Keep sandbox in sync (non-blocking)

    elif args.target == 'bridge':
        if not deploy_lightsail('bridge', force_bridge=args.yes):
            success = False

    elif args.target == 'ionos':
        if not deploy_ionos():
            success = False

    # Log every deploy to Lightsail for audit trail
    log_deploy(args.target, commit_hash, success)

    if success:
        print("\n=== Deployment complete! ===")
    else:
        print("\n=== Deployment had errors ===")
        sys.exit(1)

if __name__ == '__main__':
    main()
