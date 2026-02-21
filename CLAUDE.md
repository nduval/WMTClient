# WMT Client - Project Notes

## IMPORTANT: Always Deploy

**After making ANY code changes, run `python deploy.py all` immediately.** Do not wait for the user to ask. This deploys to both IONOS (PHP/JS/CSS) and Lightsail (WebSocket proxy). It's safe to run even if only one side changed.

The deploy script **auto-commits tracked changes** before deploying (for easy rollback). Use `--no-commit` to skip. Only tracked files are staged (`git add -u`) — untracked files are never committed automatically.

**NEVER restart `wmt-bridge`.** Bridge.js holds the raw TCP connections to the MUD for every user. Restarting it causes instant linkdeath for ALL connected players. `deploy.py all` and `deploy.py lightsail` are safe — they only restart `wmt-server` while bridge preserves connections. Do not run `deploy.py bridge`, `systemctl restart wmt-bridge`, or any command that stops/restarts the bridge service unless the user explicitly asks for it.

---

## IMPORTANT: Git Security

**NEVER commit sensitive files to git.** The following are in `.gitignore` for a reason:
- `config/sendgrid.php` - Contains API keys
- `sftp.txt`, `ssh_user.txt`, `priv_key.txt`, `github_token.txt` - Credentials

Before running `git add -A` or committing, verify no secrets are being staged.

---

## IMPORTANT: Protected Functionality (DO NOT BREAK)

**Before modifying `server.js` or `app.js`, read `memory/regression-checklist.md` for the full list.** These behaviors have been tested and confirmed working. Any change that touches these areas MUST be verified against the checklist.

**Stable baseline tag: `stable-secbot-v1`** — Use `git diff stable-secbot-v1` to review what changed since last known-good state.

Critical behaviors (summary — see checklist for details):
1. **Sequential #var/#math in alias chains** — `serverProcessInlineCommand()` runs DURING `expandCommandWithAliases`, not after. `#var x 1;dostep$x` must see updated `$x`.
2. **Variable sync race protection** — `set_variables` handler merges with 2s timestamp window. Server-modified vars (`_varServerModified`) are NOT overwritten by stale client sync.
3. **#class {name} {read}** loads ALL items — update paths in `cmdAlias`/`cmdGag`/`cmdHighlight`/`cmdSubstitute`/`cmdTicker` reassign `class` when `currentScriptClass` is set.
4. **Bulk loading defers saves** — `_bulkLoading` flag prevents 450+ HTTP requests during `#read`.
5. **`!command` passes through to MUD** — NOT intercepted. 3K uses `!` for background execution.
6. **Trigger execution sends movement** — `expandCommandWithAliases` in trigger forEach fully expands alias chains (secwalk→secstepN→direction+kill) in one synchronous pass.

**When in doubt, deploy and test `secon` on Beowulf. If the bot steps through rooms correctly, the core pipeline is intact.**

---

## IMPORTANT: Maintaining Documentation

**After solving any significant bug or discovering important technical details, update the appropriate file:**
- General bugs/fixes → `docs/claude-reference/troubleshooting.md`
- TinTin++ commands/patterns → `docs/claude-reference/tintin-reference.md`
- Protocol details (MIP, TCP, ANSI) → `docs/claude-reference/protocols.md`
- Architecture changes → `docs/claude-reference/architecture.md`

These files are NOT auto-loaded to save context. Read them on-demand when working on related topics.

---

## Detailed Documentation

Detailed docs are in `docs/claude-reference/` (NOT auto-loaded to save context):

| File | Contents |
|------|----------|
| `tintin-reference.md` | TinTin++ patterns, wildcards, all command references |
| `troubleshooting.md` | Common issues and solutions |
| `protocols.md` | MIP, TCP packet handling, ANSI colors, telnet |
| `architecture.md` | Session persistence, triggers, multi-server, mobile UI |

Read these files when working on related topics.

---

## Development Environments

| Environment | Path | Notes |
|-------------|------|-------|
| **Windows** | `D:/GitHub/client` | Primary, uses Git Bash |
| **Mac Mini** | `~/github/client` | Secondary, SSH accessible |

**SSH to Mac Mini:**
```bash
ssh nathan@192.168.86.55 -i ~/.ssh/id_rsa
```

**SSH to MUD Box (AWS EC2):**
```bash
ssh ec2-user@52.5.228.15 -i ~/.ssh/id_rsa
```
- TinTin++ scripts: `~/elminster/*.tin`

**Sync between environments:**
```bash
python .claude/sync.py status   # Check both
python .claude/sync.py push     # Push local changes via git
python .claude/sync.py pull     # Pull remote changes via git
```

---

## Deployment

### IONOS (PHP Client)
- **URL**: https://client.wemudtogether.com/app.php
- **Command**: `python deploy.py ionos`
- Deploys PHP, JS, CSS via SFTP

### Lightsail (WebSocket Proxy)
- **Command**: `python deploy.py lightsail`
- Deploys `server.js` via SSH to AWS Lightsail
- **Bridge deploy** (rare): `python deploy.py bridge` — restarts bridge.js (breaks MUD connections)

### Deploy Both
- **Command**: `python deploy.py all` (default, always safe to run)
- Deploys server.js to Lightsail + PHP/JS/CSS to IONOS

---

## Architecture Overview

- **Frontend**: PHP on IONOS (index.php, app.php, etc.)
- **WebSocket Proxy**: Node.js on AWS Lightsail (server.js + bridge.js) - connects browser to MUD
- **MUD Servers**:
  - 3Kingdoms: 3k.org:3000 (default)
  - 3Scapes: 3scapes.org:3200

**Key architectural decisions:**
- **Triggers run server-side** - survives browser disconnects, critical for mobile
- **Session persistence** - MUD connections survive app switches, network blips
- **Token-based auth** - 256-bit random tokens tie browser to MUD session

See `docs/claude-reference/architecture.md` for detailed documentation.

---

## Key Directories

| Path | Purpose |
|------|---------|
| `assets/js/app.js` | Main client JavaScript |
| `assets/css/style.css` | All styling |
| `glitch/server.js` | WebSocket proxy (deployed to Lightsail) |
| `includes/` | PHP helpers (auth, functions, settings) |
| `api/` | PHP API endpoints |
| `config/config.php` | App configuration |

---

## TinTin++ Support Summary

**Fully Supported:** `#action`, `#alias`, `#var`, `#math`, `#if`, `#delay`, `#ticker`, `#gag`, `#highlight`, `#showme`, `#bell`, `#loop`, `#foreach`, `#list`, `#function`, `#local`, `#switch`, `#event`, speedwalk

**Partially Supported:** `#split` (no row positioning), `#prompt` (basic), `#config` (speedwalk only)

**Not Supported:** `#system` (security), multi-session, terminal manipulation

See `docs/claude-reference/tintin-reference.md` for complete pattern and command reference.

---

## Storage Limits

- 25 MB total per user
- 250 files max per user

---

## Quick Troubleshooting

| Issue | Quick Fix |
|-------|-----------|
| MIP data showing raw | Check MIP filter is FIRST in data handler |
| Lines breaking mid-text | TCP buffering issue, check `lineBuffer` |
| HP bars not updating | Client name must start with "Portal" |
| Mobile freezing | Check for duplicate event listeners |
| Login loops | Cookie path mismatch, check auth logs |

See `docs/claude-reference/troubleshooting.md` for detailed solutions.
