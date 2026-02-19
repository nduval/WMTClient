#!/usr/bin/env python3
"""
WMT Client Deployment Script
Deploys to Lightsail (SSH) and/or IONOS (SFTP)
"""

import os
import sys
import subprocess
import argparse
from pathlib import Path

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

def deploy_lightsail(target='server'):
    """Deploy to Lightsail via SSH"""
    ssh_key = Path.home() / '.ssh' / 'wmt-client-socket.pem'
    host = '3.14.128.194'
    ssh_cmd = f'ssh -i "{ssh_key}" -o StrictHostKeyChecking=no ubuntu@{host}'

    if target == 'bridge':
        print("\n=== Deploying bridge.js to Lightsail (SSH) ===")
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
    import time
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
        filepath = line[3:].strip().strip('"').split(' -> ')[-1].strip('"')
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


def main():
    parser = argparse.ArgumentParser(description='Deploy WMT Client')
    parser.add_argument('target', nargs='?', choices=['ionos', 'lightsail', 'bridge', 'all'],
                       default='all', help='Deployment target (default: all)')
    parser.add_argument('--list', action='store_true', help='List files that would be deployed')
    parser.add_argument('--no-commit', action='store_true', help='Skip auto-commit before deploy')

    args = parser.parse_args()

    if args.list:
        print("Files deployed to IONOS:")
        for f in IONOS_DEPLOY_FILES:
            print(f"  {f}")
        print("\nFiles deployed to Lightsail:")
        print("  server.js (lightsail target)")
        print("  bridge.js (bridge target)")
        return

    # Auto-commit tracked changes before deploying
    if not args.no_commit:
        git_commit_before_deploy()

    success = True

    if args.target in ['lightsail', 'all']:
        if not deploy_lightsail('server'):
            success = False

    if args.target == 'bridge':
        if not deploy_lightsail('bridge'):
            success = False

    if args.target in ['ionos', 'all']:
        if not deploy_ionos():
            success = False

    if success:
        print("\n=== Deployment complete! ===")
    else:
        print("\n=== Deployment had errors ===")
        sys.exit(1)

if __name__ == '__main__':
    main()
