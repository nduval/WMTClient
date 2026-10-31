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

# ── Deploy status log + hard command timeouts ────────────────────────────────
# deploy_status.log is OVERWRITTEN at the start of every run and appended to as
# the deploy progresses, so an outside observer can always see the current step
# (the last line) and spot a stall:   tail deploy_status.log
# run_cmd() wraps every subprocess with a hard timeout: on 2026-07-08 a
# mid-deploy ssh stalled silently (TCP established, so ConnectTimeout never
# fired) and hung the run for 10+ minutes with zero output. A stalled command
# now fails its step loudly (rc=124) and the stall is visible in the log.
STATUS_FILE = BASE_DIR / 'deploy_status.log'

# --reuse-gate (2026-10-14): a FULL green gate is recorded here with a sha256 over
# every file the gate exercises. A later deploy with --reuse-gate [MINUTES] skips
# the sandbox staging + suite run when the record is full, young enough, and the
# fingerprint still matches byte-for-byte. Born from running `deploy.py test`
# (12 min) and then `deploy.py all` re-running the identical 44 suites.
GATE_PASS_FILE = BASE_DIR / '.gate_pass.json'
REUSE_GATE_MINUTES = 0          # set from --reuse-gate; 0 = never reuse
_REUSE_DECISION = None          # memoised reusable_gate() result (None | False | record)
_status_t0 = time.time()

def dstatus(msg):
    """Append a timestamped progress line to deploy_status.log (best-effort)."""
    try:
        with open(STATUS_FILE, 'a', encoding='utf-8') as f:
            f.write(f"+{time.time() - _status_t0:7.1f}s  {msg}\n")
    except OSError:
        pass

def dstatus_reset(header):
    """Start a fresh status log for this run (overwrites the previous run's)."""
    global _status_t0
    _status_t0 = time.time()
    try:
        ts = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%SZ')
        STATUS_FILE.write_text(f"deploy started {ts} — {header}\n", encoding='utf-8')
    except OSError:
        pass

def _timeout_autopsy():
    """Record ssh/scp process state + TCP connection states to the deploy hosts
    BEFORE the tree-kill. Both 2026-07-08 silent hangs were killed without
    capturing this, so the underlying stall cause is UNPROVEN (correlation:
    both were Claude-launched detached background runs; hundreds of interactive
    runs never hung). A recurrence must leave evidence, not another theory."""
    try:
        t = subprocess.run('tasklist /FI "IMAGENAME eq ssh.exe" & tasklist /FI "IMAGENAME eq scp.exe"',
                           shell=True, capture_output=True, text=True, timeout=15)
        for row in (t.stdout or '').splitlines():
            if 'ssh.exe' in row or 'scp.exe' in row:
                dstatus(f"AUTOPSY proc: {row.strip()}")
        n = subprocess.run('netstat -ano', shell=True, capture_output=True, text=True, timeout=15)
        for row in (n.stdout or '').splitlines():
            if '18.225.235.28' in row or '3.14.128.194' in row:
                dstatus(f"AUTOPSY tcp: {row.strip()}")
    except Exception as e:
        try:
            dstatus(f"AUTOPSY failed: {e}")
        except Exception:
            pass


def run_cmd(cmd, timeout=180, **kw):
    """subprocess.run-alike with a hard timeout that kills the CHILD TREE.

    Plain subprocess.run(timeout=) is NOT enough on Windows with shell=True:
    on expiry Python kills only the shell wrapper, then blocks forever draining
    output pipes still held open by the orphaned ssh/scp grandchild. That is
    how the 2026-07-08 overnight run froze for ~21 hours with the timeout never
    appearing to fire. taskkill /T takes the grandchildren with it, releasing
    the pipes so the timeout path actually completes and logs.
    On expiry: logs to the status file and returns rc=124 (coreutils style)."""
    if kw.pop('capture_output', False):
        kw['stdout'] = subprocess.PIPE
        kw['stderr'] = subprocess.PIPE
    p = subprocess.Popen(cmd, **kw)
    try:
        out, err = p.communicate(timeout=timeout)
        return subprocess.CompletedProcess(cmd, p.returncode, stdout=out, stderr=err)
    except subprocess.TimeoutExpired:
        _timeout_autopsy()
        subprocess.run(f'taskkill /F /T /PID {p.pid}', shell=True, capture_output=True)
        try:
            out, err = p.communicate(timeout=10)
        except Exception:
            out, err = ('', '')
        snippet = cmd if isinstance(cmd, str) else ' '.join(map(str, cmd))
        dstatus(f"TIMEOUT after {timeout}s: {snippet[:160]}")
        print(f"  TIMEOUT after {timeout}s: {snippet[:160]}")
        return subprocess.CompletedProcess(cmd, 124, stdout=out or '', stderr=(err or '') + f'\ntimeout after {timeout}s')

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
    'manifest.json',
    'robots.txt',
    'sitemap.xml',
    'composer.json',
    'api/',
    'assets/',
    'config/',
    'includes/',
    'tools/',
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
    ssh_cmd = f'ssh -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 ubuntu@{host}'

    if target == 'bridge':
        print("\n=== Deploying bridge.js to Lightsail (SSH) ===")
        print("*** WARNING: Restarting bridge.js KILLS ALL active MUD connections! ***")
        print("*** Every connected user will experience linkdeath. ***")

        # Check how many active sessions bridge is holding
        check = run_cmd(
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
        result = run_cmd(
            f'scp -i "{ssh_key}" "{local_file}" ubuntu@{host}:/tmp/bridge.js',
            shell=True, capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"SCP failed: {result.stderr}")
            return False
        result = run_cmd(
            f'{ssh_cmd} "sudo cp /tmp/bridge.js /opt/wmt/bridge.js && sudo chown wmt:wmt /opt/wmt/bridge.js && sudo systemctl restart wmt-bridge"',
            shell=True, capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"Deploy failed: {result.stderr}")
            return False
        print("bridge.js deployed and service restarted.")
        return True

    # Default: deploy server.js (+ its local modules). server.js requires ./maplib,
    # so both must land before the restart or the service crash-loops on a missing module.
    print("\n=== Deploying server.js to Lightsail (SSH) ===")
    dstatus("prod: pushing server.js + modules")
    local_file = BASE_DIR / 'glitch' / 'server.js'
    if not local_file.exists():
        print("ERROR: glitch/server.js not found")
        return False
    server_modules = ['server.js', 'maplib.js', 'map_overrides.json']   # local files that ship with server.js
    for m in server_modules:
        mp = BASE_DIR / 'glitch' / m
        if not mp.exists():
            print(f"ERROR: glitch/{m} not found")
            return False
        result = run_cmd(
            f'scp -i "{ssh_key}" "{mp}" ubuntu@{host}:/tmp/{m}',
            shell=True, capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"SCP failed ({m}): {result.stderr}")
            return False
    cp_cmds = ' && '.join(f'sudo cp /tmp/{m} /opt/wmt/{m} && sudo chown wmt:wmt /opt/wmt/{m}' for m in server_modules)
    dstatus("prod: installing + restarting wmt-server")
    result = run_cmd(
        f'{ssh_cmd} "{cp_cmds} && sudo systemctl restart wmt-server"',
        shell=True, capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"Deploy failed: {result.stderr}")
        return False

    # Verify it started
    time.sleep(2)
    result = run_cmd(
        f'{ssh_cmd} "systemctl is-active wmt-server"',
        shell=True, capture_output=True, text=True
    )
    status = result.stdout.strip()
    dstatus(f"prod: wmt-server {status}")
    if status == 'active':
        print("server.js deployed and service running.")
    else:
        print(f"WARNING: Service status is '{status}' — check journalctl -u wmt-server")
    return True

def gate_fingerprint():
    """sha256 over everything a gate run exercises: server.js and its sandbox
    companions, every IONOS-deployable file, the test suites, and deploy.py itself.
    Keyed on CONTENT, not the commit — deploy.py ships the working tree, so any edit
    after a green gate must invalidate it."""
    import hashlib
    h = hashlib.sha256()
    rels = {'glitch/server.js', 'glitch/bridge.js', 'glitch/mock-mud.js', 'glitch/maplib.js',
            'glitch/map_overrides.json', 'deploy.py'}
    rels |= set(IONOS_DEPLOY_FILES)
    files = []
    for rel in sorted(rels):
        p = BASE_DIR / rel
        if p.is_file():
            files.append(p)
        elif p.is_dir():
            files.extend(sorted(q for q in p.rglob('*') if q.is_file()))
    files.extend(sorted(q for q in (BASE_DIR / 'tests' / 'sandbox').glob('*') if q.is_file()))
    for p in sorted(set(files)):
        h.update(str(p.relative_to(BASE_DIR)).replace('\\', '/').encode()); h.update(b'\0')
        h.update(p.read_bytes()); h.update(b'\0')
    return h.hexdigest()


def record_gate_pass(passed):
    """Remember a FULL green gate (subset passes are never recorded)."""
    import json
    try:
        GATE_PASS_FILE.write_text(json.dumps({
            'fingerprint': gate_fingerprint(),
            'ts': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'passed': passed,
        }, indent=2))
        print(f"  (green gate recorded for --reuse-gate: {GATE_PASS_FILE.name})")
    except Exception as e:
        print(f"  (could not record gate pass: {e})")


def reusable_gate():
    """The recorded FULL green gate if --reuse-gate was given, it is within the
    window, and the fingerprint still matches — else None (prints why, once)."""
    global _REUSE_DECISION
    if not REUSE_GATE_MINUTES:
        return None
    if _REUSE_DECISION is not None:
        return _REUSE_DECISION or None
    import json
    why = None
    rec = None
    try:
        rec = json.loads(GATE_PASS_FILE.read_text())
    except Exception:
        why = "no recorded green gate"
    if rec is not None:
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(rec['ts'])).total_seconds() / 60
        except Exception:
            age = None
        if age is None:
            why = "recorded gate has no readable timestamp"
        elif age > REUSE_GATE_MINUTES:
            why = f"last green gate is {age:.0f} min old (window {REUSE_GATE_MINUTES} min)"
        elif rec.get('fingerprint') != gate_fingerprint():
            why = "files changed since the last green gate"
        else:
            rec['age_min'] = age
    if why:
        print(f"  --reuse-gate: {why} — running the gate.")
        _REUSE_DECISION = False
        return None
    _REUSE_DECISION = rec
    return rec


def deploy_test_server(restart_server=True):
    """Deploy server.js to the test sandbox. Returns True on success, False on failure.
    restart_server=False (client/PHP-only gate): stage the suite inputs (test files,
    app.js/connection.js, phpsrc) but do NOT push the working-tree server.js or
    restart wmt-server with it — for a client/PHP change server.js is unchanged, so
    the sandbox's existing build is the right thing to test against. Decouples the
    PHP/client gate from server.js WIP / a wmt-server-won't-boot condition (review F2)."""
    rec = reusable_gate()
    if rec:
        print(f"\n=== Sandbox staging skipped — --reuse-gate: green gate {rec['age_min']:.0f} min ago on identical files ===")
        return True
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

    ssh_cmd = f'ssh -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=10 ubuntu@{host}'

    dstatus("sandbox: pushing server.js")
    result = run_cmd(
        f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=10 "{local_file}" ubuntu@{host}:/tmp/server.js',
        shell=True, capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"  SCP failed: {result.stderr.strip()}")
        return False

    # server.js requires ./maplib — push it too (and it's require()d by test_map_reckon.js).
    dstatus("sandbox: pushing maplib.js + map_overrides.json")
    _maplib_local = BASE_DIR / 'glitch' / 'maplib.js'
    if _maplib_local.exists():
        r = run_cmd(
            f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=10 "{_maplib_local}" ubuntu@{host}:/tmp/maplib.js',
            shell=True, capture_output=True, text=True
        )
        if r.returncode != 0:
            print(f"  SCP failed (maplib.js): {r.stderr.strip()}")
            return False
    else:
        print("  ERROR: glitch/maplib.js not found")
        return False

    # Push map_overrides.json (server reads it at load for WMT map corrections)
    _ovr_local = BASE_DIR / 'glitch' / 'map_overrides.json'
    if _ovr_local.exists():
        run_cmd(
            f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=10 "{_ovr_local}" ubuntu@{host}:/tmp/map_overrides.json',
            shell=True, capture_output=True, text=True
        )

    # Push any repo-tracked test scripts so sandbox runs the version we
    # commit. Test files live in tests/sandbox/ and target /opt/wmt/tests/.
    test_dir = BASE_DIR / 'tests' / 'sandbox'
    if test_dir.exists():
        _test_files = sorted(list(test_dir.glob('*.js')) + list(test_dir.glob('*.php')))
        for tf in _test_files:
            dstatus(f"sandbox: pushing test {tf.name}")
            r = run_cmd(
                f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=10 "{tf}" ubuntu@{host}:/tmp/{tf.name}',
                shell=True, capture_output=True, text=True
            )
            if r.returncode == 0:
                run_cmd(
                    f'{ssh_cmd} "sudo cp /tmp/{tf.name} /opt/wmt/tests/{tf.name} && sudo chown wmt:wmt /opt/wmt/tests/{tf.name}"',
                    shell=True, capture_output=True, text=True
                )

    # Push client JS so the client-side vm tests (var_class_scope, reconnect_gate,
    # var_sync_flush) run against the version we're deploying. They read
    # /opt/wmt/assets/js/<file> when invoked with the gate's ws:// arg.
    for cf in ('app.js', 'connection.js'):
        local_cf = BASE_DIR / 'assets' / 'js' / cf
        if local_cf.exists():
            dstatus(f"sandbox: pushing client {cf}")
            r = run_cmd(
                f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=10 "{local_cf}" ubuntu@{host}:/tmp/{cf}',
                shell=True, capture_output=True, text=True
            )
            if r.returncode == 0:
                run_cmd(
                    f'{ssh_cmd} "sudo mkdir -p /opt/wmt/assets/js && sudo cp /tmp/{cf} /opt/wmt/assets/js/{cf}"',
                    shell=True, capture_output=True, text=True
                )

    # Push current bridge.js so the bridge-mode harness (test_bridge_rekey_resume)
    # runs against the version we ship. Safe: the sandbox wmt-server runs DIRECT
    # mode, so /opt/wmt/bridge.js is not used by the running sandbox service.
    _bridge_local = BASE_DIR / 'glitch' / 'bridge.js'
    if _bridge_local.exists():
        dstatus("sandbox: pushing bridge.js")
        r = run_cmd(
            f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=10 "{_bridge_local}" ubuntu@{host}:/tmp/bridge.js',
            shell=True, capture_output=True, text=True
        )
        if r.returncode == 0:
            run_cmd(
                f'{ssh_cmd} "sudo cp /tmp/bridge.js /opt/wmt/bridge.js && sudo chown wmt:wmt /opt/wmt/bridge.js"',
                shell=True, capture_output=True, text=True
            )

    # Push mock-mud.js and restart the mock. Suites drive it via __ test
    # commands, so a stale mock silently breaks new suites: EspCapture
    # 2026-08-02 failed because the sandbox mock (Jun 9) predated __emitline —
    # its red "Unknown test command" reply is itself MUD output that perturbs
    # line-observing features. Sandbox-only restart; no live players.
    _mock_local = BASE_DIR / 'glitch' / 'mock-mud.js'
    if _mock_local.exists():
        dstatus("sandbox: pushing mock-mud.js")
        r = run_cmd(
            f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=10 "{_mock_local}" ubuntu@{host}:/tmp/mock-mud.js',
            shell=True, capture_output=True, text=True
        )
        if r.returncode == 0:
            run_cmd(
                f'{ssh_cmd} "sudo cp /tmp/mock-mud.js /opt/wmt/mock-mud.js && sudo chown wmt:wmt /opt/wmt/mock-mud.js && sudo systemctl restart mock-mud"',
                shell=True, capture_output=True, text=True
            )

    # Stage the PHP auth stack so the PHP login suite (test_php_login.js) can boot
    # the REAL includes/+config/+api under `php -S` against a throwaway data dir.
    # Pushed to /opt/wmt/phpsrc. The admin key is stripped on the sandbox so the
    # suite uses the JSON user fallback (no prod DB / no secret left on the box).
    dstatus("sandbox: staging phpsrc (includes/config/api)")
    # sudo rm: the PhpLogin suite runs as root and leaves root-owned files in
    # /tmp/phpsrc — a plain rm then fails and every later scp hits Permission
    # denied, so the gate silently tests STALE php (bit us 2026-07-10).
    run_cmd(f'{ssh_cmd} "sudo rm -rf /tmp/phpsrc && mkdir -p /tmp/phpsrc"',
                   shell=True, capture_output=True, text=True)
    php_ok = True
    for d in ('includes', 'config', 'api'):
        ld = BASE_DIR / d
        if not ld.exists():
            continue
        r = run_cmd(
            f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=10 -r "{ld}" ubuntu@{host}:/tmp/phpsrc/',
            shell=True, capture_output=True, text=True
        )
        if r.returncode != 0:
            php_ok = False
            print(f"  WARNING: PHP src push failed for {d}: {r.stderr.strip()}")
    if php_ok:
        run_cmd(
            f'{ssh_cmd} "sudo rm -rf /opt/wmt/phpsrc && sudo mkdir -p /opt/wmt/phpsrc '
            f'&& sudo cp -r /tmp/phpsrc/* /opt/wmt/phpsrc/ '
            f'&& sudo rm -f /opt/wmt/phpsrc/config/render_admin_key.php '
            f'/opt/wmt/phpsrc/config/ipinfo.php /opt/wmt/phpsrc/config/sendgrid.php '
            f'&& sudo chmod -R a+rX /opt/wmt/phpsrc"',
            shell=True, capture_output=True, text=True
        )

    # Client/PHP-only gate: inputs are staged above; do NOT deploy the
    # working-tree server.js or restart with it (review F2 — a broken/WIP
    # server.js must not block an unrelated PHP hotfix). The 3 client-VM suites
    # that open a real WS just need SOME running wmt-server; use the sandbox's
    # existing build (its server.js == the last server deploy, i.e. what's on
    # prod for an unchanged-server.js deploy). PHP suites need no server at all.
    if not restart_server:
        status = run_cmd(f'{ssh_cmd} "systemctl is-active wmt-server"',
                         shell=True, capture_output=True, text=True).stdout.strip()
        if status != 'active':
            # Not running — restart the EXISTING sandbox binary (no push).
            run_cmd(f'{ssh_cmd} "sudo systemctl restart wmt-server"',
                    shell=True, capture_output=True, text=True)
            time.sleep(2)
            status = run_cmd(f'{ssh_cmd} "systemctl is-active wmt-server"',
                             shell=True, capture_output=True, text=True).stdout.strip()
        if status == 'active':
            print("  Sandbox staged (server.js NOT redeployed — using existing build).")
            return True
        print(f"  WARNING: sandbox wmt-server is '{status}' and no server.js change to deploy.")
        print("  Run a server-side deploy to repair the sandbox, or --force to skip the gate.")
        return False

    # Copy + restart. As of 2026-05-25 the allowedServers allowlist lives in
    # /opt/wmt/config/allowed_servers.json (created once per box) rather than
    # being patched into server.js literally. See memory: config-driven-allowed-servers.
    patch_lines = [
        'sudo cp /tmp/server.js /opt/wmt/server.js',
        'sudo chown wmt:wmt /opt/wmt/server.js',
        'sudo cp /tmp/maplib.js /opt/wmt/maplib.js',
        'sudo chown wmt:wmt /opt/wmt/maplib.js',
        '[ -f /tmp/map_overrides.json ] && sudo cp /tmp/map_overrides.json /opt/wmt/map_overrides.json && sudo chown wmt:wmt /opt/wmt/map_overrides.json || true',
        'sudo systemctl restart wmt-server',
    ]
    dstatus("sandbox: installing + restarting wmt-server")
    patch_content = '#!/bin/bash\nset -e\n' + '\n'.join(patch_lines) + '\n'
    # Write the script locally, SCP it, run it
    patch_file = BASE_DIR / '.deploy_patch.sh'
    patch_file.write_text(patch_content, newline='\n')
    run_cmd(
        f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=10 "{patch_file}" ubuntu@{host}:/tmp/deploy_patch.sh',
        shell=True, capture_output=True, text=True
    )
    result = run_cmd(
        f'{ssh_cmd} "bash /tmp/deploy_patch.sh"',
        shell=True, capture_output=True, text=True
    )
    patch_file.unlink(missing_ok=True)
    if result.returncode != 0:
        print(f"  Deploy failed: {result.stderr.strip()}")
        return False

    # Wait for service to start, then verify
    time.sleep(2)
    result = run_cmd(
        f'{ssh_cmd} "systemctl is-active wmt-server"',
        shell=True, capture_output=True, text=True
    )
    status = result.stdout.strip()
    dstatus(f"sandbox: wmt-server {status}")
    if status == 'active':
        print("  Test server deployed and running.")
        return True
    else:
        print(f"  WARNING: Service status is '{status}' — check journalctl -u wmt-server")
        return False


# Suites that exercise the CLIENT bundle (vm-load assets/js/app.js|connection.js).
# Relevant to an app.js/connection.js change.
CLIENT_SUITE_SCRIPTS = {
    'test_var_sync_flush.js', 'test_var_class_scope.js', 'test_reconnect_gate.js',
    'test_login_conflict.js', 'test_resume_startup_guard.js',
    'test_typed_var_routing.js',
}
# Suites that exercise PHP (PhpLogin boots php -S over includes/+config/+api;
# ScriptBackup is a pure PHP CLI test of functions.php). Relevant to a PHP change.
PHP_SUITE_SCRIPTS = {'test_php_login.js', 'test_script_backup.php', 'test_discord_webhook_url.php'}


def relevant_test_scripts(files):
    """Which suite scripts to run for a set of changed IONOS files. PHP files
    (api/, includes/, config/, *.php) pull the PHP suites; app.js/connection.js
    pulls the client-VM suites. CSS/docs/images pull nothing. Server suites are
    NOT included here — a server.js change runs the FULL gate separately."""
    scripts = set()
    php_changed = any(
        f.startswith(('api/', 'includes/', 'config/')) or f.endswith('.php')
        for f in files
    )
    client_changed = any(
        f in ('assets/js/app.js', 'assets/js/connection.js') for f in files
    )
    if php_changed:
        scripts |= PHP_SUITE_SCRIPTS
    if client_changed:
        scripts |= CLIENT_SUITE_SCRIPTS
    return scripts


def run_test_suites(only_scripts=None):
    """Run WMT test suites on sandbox. Returns (total_passed, total_failed, details).
    only_scripts: if given (a set of script filenames), run just those — the
    relevant-subset gate for a client/PHP-only deploy (full gate otherwise)."""
    rec = reusable_gate()
    if rec:
        print(f"\n=== Gate reused — {rec['passed']} tests passed {rec['age_min']:.0f} min ago on byte-identical files (--reuse-gate) ===")
        dstatus(f"gate: reused green pass from {rec['ts']} ({rec['passed']} passed)")
        return rec['passed'], 0, []
    print("\n=== Running test suites on sandbox ===")
    ssh_key = Path.home() / '.ssh' / 'test-mud.pem'
    host = '18.225.235.28'
    ssh_cmd = f'ssh -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ConnectTimeout=10 ubuntu@{host}'

    # Accepted known-failing suites, by LABEL — a failure in one of these does not
    # block deploy. Per-SUITE, not a global count (review F6): a global allowance
    # would let a subset run's budget silently absorb an UNRELATED real failure
    # (e.g. a 2-suite PHP subset where both fail nets to "0 unexpected"). Empty =
    # every failure blocks (current state).
    KNOWN_FAILING_SUITES = set()   # e.g. {'SomeFlakySuite'}

    suites = [
        ('Pipeline',     'test_wmt_client.js'),
        ('Aliases',      'test_alias_compare.js'),
        ('Triggers',     'test_trigger_compare.js'),
        ('DelayAnon',    'test_delay_anon.js'),
        ('EntityGuard',  'test_entity_guard.js'),
        # SLOW_REGEX must not disable a trigger on ONE slow sample (GC/CPU blip);
        # 3 strikes in 60s still disables (2026-08-30 combat-trigger kill).
        ('SlowRegexGuard', 'test_slow_regex_guard.js'),
        # Server-side #show/#showme is trigger-checked (tt++ do_showme) — proves a trigger's
        # #show still advances a bot chain with NO browser attached (the 2026-10-13 celbot
        # stall), fires exactly once when a browser IS attached, keeps the split-row form
        # browser-side, keeps the typed test_line path, and survives a self-recursive #show.
        ('ShowmeServerTriggers', 'test_showme_server_triggers.js'),
        ('BlockTrigger', 'test_block_trigger.js'),
        ('SelfAlerts',   'test_self_alerts.js'),
        # ESP (jedi telepathy) is plain game text the MUD left out of MIP;
        # the server observes "<Name> thinks . o O ( ... )" blocks (multi-line,
        # `)`-terminated) and synthesizes mip_chat on the 'esp' channel.
        ('EspCapture',   'test_esp_capture.js'),
        # ChatMon replay skips hidden ("silenced") channels so a busy silenced
        # channel can't eat the 100-message window (elminster 2026-07-09: 74/100
        # replayed lines were silenced atalk). Live capture stays unfiltered;
        # no-prefs sessions fall back to the old unfiltered replay.
        ('ChatReplayHidden', 'test_chat_replay_hidden.js'),
        ('VarSubst',     'test_var_substitution.js'),
        ('CharSync',     'test_character_sync.js'),
        ('SessionPersist', 'test_session_persist.js'),
        ('AutoLoginGate', 'test_autologin_gate.js'),
        # Client-side (vm-load app.js/connection.js from /opt/wmt/assets/js, synced above)
        ('VarSyncFlush',  'test_var_sync_flush.js'),
        # Resume-startup #var guard: a device resuming a LIVE session re-ran
        # startup.tin and force-reset the bot's state variables (the phone-hop
        # bot-killer, elminster 2026-07-10). #var is init-if-absent during
        # _resumeInitRead; normal force-set semantics everywhere else.
        ('ResumeStartupGuard', 'test_resume_startup_guard.js'),
        # Phase 3 Step 3: typed #var/#math/#unvar route to the server (single
        # owner); client store is a view. Asserts the routing predicate, every
        # local-fallback exclusion, the non-substitution contract (no stale $x
        # baked into routed chains), and view/echo application.
        ('TypedVarRouting', 'test_typed_var_routing.js'),
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
        # Multi-device entity merge guard: a second device's smaller full-state
        # set_triggers/aliases/tickers push must not delete entities the bot
        # device created (the 2026-07-21 "bot dies ~105s after mobile launch"
        # clobber). Baseline = ids the device itself pushed; first push deletes
        # nothing; content-duplicates don't double-register. Negative-controlled.
        ('MultiDeviceEntitySync', 'test_multidevice_entity_sync.js'),
        # Resume-echo clobber (2026-09-12): a device resuming gets its full state
        # replayed via authoritative_state and echoes it back, which used to poison
        # its merge baseline so a later bare push "deleted" another device's bot
        # entities (elminster 986→125, no ENTITY_MERGE). Fix: echo guard keeps
        # echoed entities out of the device's authored-baseline. Negative-controlled
        # (red on pre-fix server.js).
        ('ResumeEchoClobber', 'test_resume_echo_clobber.js'),
        # Explicit entity deletes (2026-10-14): a resumed browser could never
        # delete-by-omission anything it didn't author (echo guard) → UI deletes
        # came back. set_* pushes carry `removed: [ids]`; honoured regardless of
        # authorship. Negative-controlled (T2-T4 red on pre-fix server.js).
        ('ExplicitEntityDelete', 'test_explicit_entity_delete.js'),
        # PHP login flow: boots the real includes/+config/+api under `php -S`
        # (staged at /opt/wmt/phpsrc) — guards the double-login fix (single
        # session lifecycle) + login-stack smoke test. NOTE: PHP 8.3 masks the
        # prod-only multi-cookie race; this guards total breakage + clean cookie.
        ('PhpLogin', 'test_php_login.js'),
        # PHP CLI suite (run with `php`, not node): script-file backup rotation +
        # backup-artifact detection + storage-count exclusion. Guards the
        # 'twist stone' version-history feature and the quota-wedge fix.
        ('ScriptBackup', 'test_script_backup.php'),
        # Pure PHP CLI test of includes/discord_webhook.php: accepted forms (incl.
        # forum ?thread_id=), refused forms, and "refused ≠ cleared" (2026-10-13:
        # 21 of mimic's forum webhooks were silently blanked by the old regex).
        ('DiscordWebhookUrl', 'test_discord_webhook_url.php'),
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
        # MIP-at-name-prompt guard: while the MUD socket is at a name prompt, the
        # server must DROP '3klient ...' MIP-registration commands (a resume racing
        # a fresh login otherwise fires them into the prompt → "Invalid character
        # in position N" → broken login). elminster 2026-06-14. Negative-controlled.
        ('MipNamePromptGuard', 'test_mip_nameprompt_guard.js'),
        # Server-side #event dispatch (RECEIVED INPUT) — Phase 1 of the single-owner
        # variable model. Proves the server fires input-reset events on its own side so
        # $idle resets where the ticker lives (was: reset ran only in the browser and lost
        # to the server's ticker → $idle off by tens of minutes). Negative-controlled.
        ('InputEventDispatch', 'test_input_event_dispatch.js'),
        # Server-side variable/command engine parity — Phase 2 of the single-owner model.
        # Grows one case per closed gap (indexed var writes now; ticker-authoring/#list next)
        # so heal-class trigger bodies run fully server-side against one authoritative store.
        ('ServerVarEngine', 'test_server_var_engine.js'),
        # Incremental variable sync (review F2 / Phase 3 step 1): var_ops {set,del}
        # applies per-key server-side and CANNOT clobber/delete server-authored
        # state the client didn't touch — the legacy full-store 2s-merge-cliff fix.
        ('VarOps', 'test_var_ops.js'),
        # Map dead-reckoning (glitch/maplib.js): proves ID-less uniform-grid areas
        # (Mahjongg/Aegis) track by the direction moved, that `look` HOLDS position
        # (no orange↔green bounce), + blocked/cold-start/ambiguous/boundary cases.
        # Synthetic grids always run; also walks the real 3k_map.db if present.
        ('MapReckon', 'test_map_reckon.js'),
        # Map sweep: walks EVERY area in the real 3k_map.db through the reckon brain (cold-start +
        # fast burst) and asserts the hard invariant MUD-wide — NEVER confidently in the wrong room
        # (0 drift) + burst-from-anchor ends exact. Skips cleanly if the map db isn't on the box.
        ('MapSweep', 'map_sweep.js'),
        # Map layout sweep: for EVERY area, proves the CLIENT floor-layout invariant — floor identity
        # is the directed compass component (so an entry vestibule stays its own small map and you
        # TRANSITION across a seam), and the floor's rooms ALWAYS fully position via undirected
        # placement from the anchor. Catches the 2026-06-22 "footer says 38 rooms but only 1–3 drawn"
        # bug (asymmetric seams like Celestial `light` in / `sw` out) MUD-wide. Skips if no map db.
        ('MapLayoutSweep', 'map_layout_sweep.js'),
        # Named/one-way/vertical exit TRACKING: walks Celestial's Aeonos floor (enter/out/swim/up +
        # the map_overrides one-way swim 53915->53587) through the real reckon brain and asserts the
        # map follows every transition — incl. Nathan's "up from the Depths brings you back". Guards
        # the transition model for sections connected by non-compass exits. Skips if no map db.
        ('NamedExitTracking', 'test_named_exit_tracking.js'),
    ]

    # Relevant-subset gate: run only the suites for what changed (client/PHP-only
    # deploy). None = full gate (server.js changed, or an explicit full run).
    if only_scripts is not None:
        # DRIFT GUARD (review F1): the subset sets (PHP_/CLIENT_SUITE_SCRIPTS) are
        # a hand-maintained parallel registry. If a suite is renamed in `suites`
        # without updating them, the filter silently shrinks — worst case to empty,
        # which must NOT read as a clean pass and deploy ungated. Any requested
        # script not in the live suites list = drift → abort loudly (failed>0).
        all_scripts = {s[1] for s in suites}
        missing = set(only_scripts) - all_scripts
        if missing:
            print(f"  ERROR: requested suite(s) not in the gate list — registry DRIFT: {sorted(missing)}")
            print("  Fix PHP_SUITE_SCRIPTS / CLIENT_SUITE_SCRIPTS or the suites list. Refusing to gate.")
            return 0, len(missing), []
        suites = [s for s in suites if s[1] in only_scripts]
        print(f"  (relevant subset: {len(suites)} suite(s) for the changed files)")
        if not suites:
            # only_scripts non-empty (callers guard with `if subset:`) yet nothing
            # matched despite passing the drift check — impossible; fail closed.
            print("  ERROR: subset filtered to zero suites — refusing to pass.")
            return 0, 1, []

    total_passed = 0
    total_failed = 0
    details = []
    failure_output = {}   # label -> captured stdout+stderr, so a failure is never lost

    for idx, (label, script) in enumerate(suites, 1):
        dstatus(f"gate: {label} [{idx}/{len(suites)}]")
        # sudo -n: tests like test_entity_guard.js need to read /opt/wmt/wmt.db
        # which is root-owned. -n fails fast if sudo would prompt (NOPASSWD
        # is configured for ubuntu on the sandbox).
        # run_cmd tree-kills on timeout (rc=124) — a wedged ssh can't deadlock
        # the gate the way the 2026-07-08 overnight run did.
        # PHP CLI suites run with `php` (no ws arg); Node suites with `node <ws>`.
        if script.endswith('.php'):
            _cmd = f'cd /opt/wmt/tests && sudo -n php {script}'
        else:
            _cmd = f'cd /opt/wmt/tests && sudo -n node {script} ws://localhost:3000'
        result = run_cmd(
            f'{ssh_cmd} "{_cmd}"',
            shell=True, capture_output=True, text=True, timeout=60
        )
        if result.returncode == 124:
            details.append((label, script, 0, 0, 'TIMEOUT'))
            failure_output[label] = (result.stdout or '') + '\n(timed out after 60s)'
            total_failed += 1
            continue

        output = result.stdout + result.stderr

        # Parse "Results: X passed, Y failed" or "=== Results: X passed, Y failed ==="
        match = re.search(r'(\d+)\s+passed,\s+(\d+)\s+failed', output)
        if match:
            passed = int(match.group(1))
            failed = int(match.group(2))
        else:
            # No 'X passed, Y failed' line — the suite did NOT report, even on a
            # 0 exit. This must NOT count as a pass (review F7c): a harness that
            # dies early or prints nothing would silently green the gate — and in
            # a 1-2 suite subset that could be the ENTIRE gate. Fail closed. (Every
            # current suite emits the line, so this only fires on a broken suite.)
            passed = 0
            failed = 1
            failure_output[label] = output + f"\n(no parseable 'X passed, Y failed' line; exit={result.returncode})"

        total_passed += passed
        total_failed += failed
        status = 'PASS' if failed == 0 else 'FAIL'
        details.append((label, script, passed, failed, status))
        if failed > 0:
            failure_output[label] = output   # keep the actual assertion text for diagnosis

    # Print summary table
    for label, script, passed, failed, status in details:
        icon = 'OK' if status == 'PASS' else ('FAIL' if status == 'FAIL' else '??')
        pad_label = f"{label} ({script}):".ljust(45)
        print(f"  {pad_label} {passed:>2} passed, {failed} failed  {icon}")

    # Dump the full output of any failing suite so a failure is fully diagnosable from a
    # single run — no need to re-run hoping to re-capture it. (A failure must never be lost.)
    for label, script, passed, failed, status in details:
        if status != 'PASS' and label in failure_output:
            print(f"\n----- FAILURE OUTPUT: {label} ({script}) -----")
            print(failure_output[label].strip()[-4000:])
            print(f"----- end {label} -----")

    total = total_passed + total_failed
    print(f"  {'':45} {'---':>10}")
    print(f"  {'Total:':45} {total_passed:>2}/{total} passed")

    dstatus(f"gate: done — {total_passed} passed, {total_failed} failed")

    # Block on failures EXCEPT those in known-failing suites (per-suite — review F6).
    unexpected_failures = sum(f for (label, script, p, f, st) in details
                              if f > 0 and label not in KNOWN_FAILING_SUITES)
    if total_failed > 0 and unexpected_failures == 0:
        print(f"\n  ({total_failed} failure(s), all in known-failing suites — not blocking deploy)")

    if only_scripts is None and total_failed == 0 and total_passed > 0:
        record_gate_pass(total_passed)

    return total_passed, unexpected_failures, details


def print_prod_db_health():
    """Print the latest production DB health block (written daily by
    /opt/wmt/db-stats.py via cron). Surfaced during the deploy test phase so DB
    health is reviewed at every deploy. Best-effort: never blocks a deploy."""
    ssh_key = Path.home() / '.ssh' / 'wmt-client-socket.pem'
    host = '3.14.128.194'
    try:
        result = run_cmd(
            f'ssh -i "{ssh_key}" -o ConnectTimeout=15 ubuntu@{host} "cat /opt/wmt/db-stats/latest.txt 2>/dev/null"',
            shell=True, capture_output=True, text=True, timeout=30
        )
        out = (result.stdout or '').strip()
        print("\n=== Production database health ===")
        print(out if out else "  (no snapshot yet — db-stats cron has not run)")
    except Exception as e:
        print(f"\n=== Production database health ===\n  (unavailable: {e})")


def php_lint_changed(php_files):
    """`php -l` every changed PHP file on the sandbox (review F3). The PHP suites
    (PhpLogin/ScriptBackup) exercise only the login chain + functions.php backup —
    most api/ endpoints and root pages are gated-but-unexercised, and deploy.py
    ran NO parse check at all, so a syntax error in e.g. preferences.php shipped
    to prod uncaught (a fatal in a site-wide include = full outage). This gives
    every changed PHP file at least a parse check. Returns True if all parse.
    scp's each file to a flat temp name (avoids basename collisions across dirs)."""
    if not php_files:
        return True
    ssh_key = Path.home() / '.ssh' / 'test-mud.pem'
    host = '18.225.235.28'
    ssh_cmd = f'ssh -i "{ssh_key}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@{host}'
    print("\n=== php -l (parse check) on changed PHP ===")
    ok = True
    for f in php_files:
        local = BASE_DIR / f
        if not local.exists():
            continue
        tmp = '/tmp/_lint_' + f.replace('/', '_').replace('\\', '_')
        scp = run_cmd(
            f'scp -i "{ssh_key}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "{local}" ubuntu@{host}:{tmp}',
            shell=True, capture_output=True, text=True, timeout=30)
        if scp.returncode != 0:
            print(f"  {f}: scp failed — cannot lint"); ok = False; continue
        r = run_cmd(f'{ssh_cmd} "php -l {tmp} && rm -f {tmp}"', shell=True, capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            print(f"  {f}: OK")
        else:
            print(f"  {f}: PARSE ERROR")
            print("   " + (r.stdout + r.stderr).strip()[-400:])
            ok = False
    return ok


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
        dstatus("ionos: connecting (sftp)")
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
                dstatus(f"ionos: uploading {remote_path_unix}")
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
        dstatus(f"ionos: done — {uploaded} uploaded, {skipped} skipped")
        return True

    except Exception as e:
        print(f"SFTP Error: {e}")
        dstatus(f"FAILED: ionos sftp: {e}")
        return False

def git_commit_before_deploy():
    """Auto-commit tracked changes before deploying (for easy rollback)"""
    # Check for any staged or unstaged changes to tracked files
    result = run_cmd(
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
    dstatus("git: auto-commit")
    run_cmd('git add -u', shell=True, cwd=str(BASE_DIR))
    # Commit
    result = run_cmd(
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
    ssh_cmd = f'ssh -i "{ssh_key}" -o StrictHostKeyChecking=no -o ServerAliveInterval=15 -o ServerAliveCountMax=4 ubuntu@{host}'
    ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    status = 'OK' if success else 'FAILED'
    entry = f'{ts} target={target} commit={commit_hash} status={status}'
    run_cmd(
        f'{ssh_cmd} "echo \'{entry}\' | sudo tee -a /var/log/wmt/deploy.log > /dev/null"',
        shell=True, capture_output=True, text=True
    )
    print(f"  Deploy logged: {entry}")


DEPLOY_STATE_FILE = BASE_DIR / '.deploy_state.json'

def read_deploy_state():
    """Per-side deploy baselines: {'server_commit', 'ionos_commit', 'last_commit'}.
    `server_commit` / `ionos_commit` = last commit whose server.js / IONOS files are
    known to be on prod; `last_commit` is the legacy single key (fallback for both).
    Returns {} if unknown."""
    try:
        import json
        return json.loads(DEPLOY_STATE_FILE.read_text())
    except Exception:
        return {}

def deploy_baseline(side):
    """Baseline commit for one side ('server' | 'ionos'); None if unknown."""
    st = read_deploy_state()
    return st.get(f'{side}_commit') or st.get('last_commit')

def write_deploy_state(commit, sides=('server', 'ionos')):
    """Advance the baseline for the given sides only. 2026-10-31 scar: the explicit
    `ionos`/`all`/`lightsail` targets never wrote the baseline, so `auto` later saw a
    weeks-old baseline, thought server.js had changed, and restarted wmt-server on
    live players for a manifest.json change. A partial target advances ONLY its own
    side so an undeployed server.js change can never be hidden by an IONOS deploy."""
    try:
        import json
        st = read_deploy_state()
        for side in sides:
            st[f'{side}_commit'] = commit
        if st.get('server_commit') == st.get('ionos_commit') == commit:
            st['last_commit'] = commit
        DEPLOY_STATE_FILE.write_text(json.dumps(st, indent=2))
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
    r = run_cmd(f'git diff --name-only {baseline} HEAD',
                       shell=True, capture_output=True, text=True, cwd=str(BASE_DIR))
    if r.returncode != 0:
        return None
    files.update(l.strip() for l in r.stdout.splitlines() if l.strip())
    # Uncommitted tracked changes (staged + unstaged) vs HEAD
    r2 = run_cmd('git diff --name-only HEAD',
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
    parser.add_argument('--reuse-gate', nargs='?', const=30, default=0, type=int, metavar='MINUTES',
                       help='Skip the sandbox gate if a FULL gate passed on byte-identical files within '
                            'MINUTES (30 if omitted). For `deploy.py test` green → `deploy.py all --reuse-gate`.')

    args = parser.parse_args()
    global REUSE_GATE_MINUTES
    REUSE_GATE_MINUTES = max(0, args.reuse_gate or 0)
    dstatus_reset(f"target={args.target}"
                  + (f' --reuse-gate {REUSE_GATE_MINUTES}' if REUSE_GATE_MINUTES else '')
                  + (' --force' if args.force else '')
                  + (' --dry-run' if args.dry_run else ''))

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
            dstatus("FAILED: sandbox deploy")
            sys.exit(1)
        passed, failed, details = run_test_suites()
        print_prod_db_health()
        if failed > 0:
            print(f"\n=== {failed} test(s) failed ===")
            dstatus(f"FAILED: {failed} test(s) failed")
            sys.exit(1)
        else:
            print(f"\n=== All {passed} tests passed ===")
            dstatus(f"DONE: all {passed} tests passed")
        return

    # Auto-commit tracked changes before deploying (never during a dry-run)
    if not args.no_commit and not args.dry_run:
        git_commit_before_deploy()

    # Get current commit hash for deploy log
    commit_result = run_cmd(
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
                    dstatus("FAILED: gate blocked production deploy")
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
        if success:
            write_deploy_state(commit_hash)   # both sides now at HEAD

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
                    dstatus("FAILED: gate blocked production deploy")
                    sys.exit(1)
        else:
            print("\nWARNING: Test sandbox deploy failed.")
            if not args.force:
                print("  Aborting production deploy. Use --force to override.")
                dstatus("FAILED: sandbox deploy blocked production deploy")
                sys.exit(1)
        if not deploy_lightsail('server'):
            success = False
        if success:
            write_deploy_state(commit_hash, sides=('server',))

    elif args.target == 'bridge':
        if not deploy_lightsail('bridge', force_bridge=args.yes):
            success = False

    elif args.target == 'ionos':
        if args.dry_run:
            print("  [dry-run] `ionos` would stage the sandbox, gate PHP+client suites, then deploy all IONOS files. No changes made.")
            return
        # Explicit IONOS deploy pushes all PHP + client files → gate both suite
        # sets first (unless --force). Closes the ungated-PHP-deploy hole.
        subset = PHP_SUITE_SCRIPTS | CLIENT_SUITE_SCRIPTS
        print(f"\n=== Gating IONOS deploy ({len(subset)} PHP + client suites) ===")
        if deploy_test_server(restart_server=False):
            passed, failed, details = run_test_suites(only_scripts=subset)
            if failed > 0 and not args.force:
                print(f"\nWARNING: {failed} sandbox test(s) failed. Aborting. Use --force to override.")
                dstatus("FAILED: subset gate blocked IONOS deploy")
                sys.exit(1)
        elif not args.force:
            print("\nWARNING: sandbox deploy failed. Aborting. Use --force to override.")
            dstatus("FAILED: sandbox deploy blocked IONOS deploy")
            sys.exit(1)
        if not deploy_ionos():
            success = False
        if success:
            write_deploy_state(commit_hash, sides=('ionos',))

    elif args.target == 'auto':
        # Each side diffs against ITS OWN baseline (see write_deploy_state).
        srv_baseline = deploy_baseline('server')
        ion_baseline = deploy_baseline('ionos')
        baseline = srv_baseline if srv_baseline == ion_baseline else f"server={srv_baseline} ionos={ion_baseline}"
        changed_server = git_changed_files(srv_baseline)
        changed_ionos = git_changed_files(ion_baseline)
        changed = None if (changed_server is None or changed_ionos is None) else sorted(set(changed_server) | set(changed_ionos))
        print("\n=== Smart deploy (auto) ===")
        if changed is None:
            print("  No deploy baseline in .deploy_state.json — can't compute what's necessary.")
            print("  Bootstrap once: write the last-deployed commit hash to .deploy_state.json")
            print('  (e.g. {"last_commit": "<hash>"}), or run an explicit target this time.')
            sys.exit(1)

        server_changed = 'glitch/server.js' in changed_server
        bridge_changed = 'glitch/bridge.js' in changed_server
        ionos_files = [f for f in changed_ionos if is_ionos_path(f)]
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
                    dstatus("FAILED: gate blocked production deploy")
                    sys.exit(1)
            elif not args.force:
                print("\nWARNING: sandbox deploy failed. Aborting. Use --force to override.")
                dstatus("FAILED: sandbox deploy blocked production deploy")
                sys.exit(1)
            if not deploy_lightsail('server'):
                success = False
        elif ionos_files:
            # Client/PHP-only deploy: server.js unchanged so the full gate above
            # is skipped, but PHP/app.js still reaches prod. Gate the RELEVANT
            # subset (PhpLogin/ScriptBackup for PHP, client-VM suites for app.js)
            # + `php -l` EVERY changed PHP file (most api/ endpoints aren't
            # exercised by the suites — the lint at least catches parse errors).
            php_changed = [f for f in ionos_files
                           if f.startswith(('api/', 'includes/', 'config/')) or f.endswith('.php')]
            # F4: surface IONOS files reaching prod with NO suite AND no lint
            # (css, images, .htaccess — .htaccess is outage-class). Make it a
            # visible decision, not silence.
            ungated = [f for f in ionos_files
                       if f not in php_changed
                       and f not in ('assets/js/app.js', 'assets/js/connection.js')]
            if ungated:
                print(f"  ⚠ UNGATED → prod (no suite/lint covers these): {', '.join(ungated)}")
            subset = relevant_test_scripts(ionos_files)
            if subset:
                print(f"\n=== Gating client/PHP change ({len(subset)} relevant suite(s)) ===")
                if deploy_test_server(restart_server=False):
                    passed, failed, details = run_test_suites(only_scripts=subset)
                    if failed > 0 and not args.force:
                        print(f"\nWARNING: {failed} sandbox test(s) failed. Aborting. Use --force to override.")
                        dstatus("FAILED: subset gate blocked IONOS deploy")
                        sys.exit(1)
                elif not args.force:
                    print("\nWARNING: sandbox deploy failed. Aborting. Use --force to override.")
                    dstatus("FAILED: sandbox deploy blocked IONOS deploy")
                    sys.exit(1)
            if php_changed and not php_lint_changed(php_changed) and not args.force:
                print("\nWARNING: PHP parse error above. Aborting. Use --force to override.")
                dstatus("FAILED: php -l blocked IONOS deploy")
                sys.exit(1)
        if ionos_files:
            if not deploy_ionos(only_files=ionos_files):
                success = False
        if success:
            write_deploy_state(commit_hash)

    # Log every deploy to Lightsail for audit trail
    log_deploy(args.target, commit_hash, success)

    if success:
        print("\n=== Deployment complete! ===")
        dstatus("DONE: deployment complete")
    else:
        print("\n=== Deployment had errors ===")
        dstatus("FAILED: deployment had errors")
        sys.exit(1)

if __name__ == '__main__':
    main()
