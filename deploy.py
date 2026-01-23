#!/usr/bin/env python3
"""
WMT Client Deployment Script
Deploys to Render (GitHub) and/or IONOS (SFTP)
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

    # GitHub token
    token_file = BASE_DIR / 'github_token.txt'
    if token_file.exists():
        creds['github_token'] = token_file.read_text().strip()

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

def deploy_render(message=None):
    """Deploy to Render via GitHub push"""
    print("\n=== Deploying to Render (GitHub) ===")

    os.chdir(BASE_DIR)

    # Copy latest server.js from glitch/ to root if it exists
    glitch_server = BASE_DIR / 'glitch' / 'server.js'
    root_server = BASE_DIR / 'server.js'
    if glitch_server.exists():
        print("Copying glitch/server.js to root...")
        root_server.write_text(glitch_server.read_text())

    # Stage files first
    subprocess.run(['git', 'add', 'server.js', 'package.json'], check=True)

    # Check for staged changes
    result = subprocess.run(['git', 'diff', '--cached', '--quiet', 'server.js', 'package.json'],
                          capture_output=True)

    if result.returncode == 0:
        print("No changes to deploy to Render.")
        return True

    commit_msg = message or "Update WebSocket proxy"
    commit_msg += "\n\nCo-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

    result = subprocess.run(['git', 'commit', '-m', commit_msg], capture_output=True, text=True)
    if result.returncode != 0:
        if 'nothing to commit' in result.stdout or 'nothing to commit' in result.stderr:
            print("No changes to commit.")
            return True
        print(f"Commit failed: {result.stderr}")
        return False

    print(f"Committed: {commit_msg.split(chr(10))[0]}")

    # Push
    result = subprocess.run(['git', 'push', 'origin', 'main'], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Push failed: {result.stderr}")
        return False

    print("Pushed to GitHub. Render will auto-deploy.")
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

def main():
    parser = argparse.ArgumentParser(description='Deploy WMT Client')
    parser.add_argument('target', nargs='?', choices=['render', 'ionos', 'all'],
                       default='all', help='Deployment target (default: all)')
    parser.add_argument('-m', '--message', help='Commit message for Render deploy')
    parser.add_argument('--list', action='store_true', help='List files that would be deployed')

    args = parser.parse_args()

    if args.list:
        print("Files deployed to IONOS:")
        for f in IONOS_DEPLOY_FILES:
            print(f"  {f}")
        print("\nFiles deployed to Render:")
        print("  server.js")
        print("  package.json")
        return

    success = True

    if args.target in ['render', 'all']:
        if not deploy_render(args.message):
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
