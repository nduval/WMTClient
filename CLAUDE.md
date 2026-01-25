# WMT Client - Project Notes

## IMPORTANT: Always Deploy

**After making ANY code changes, run `python deploy.py all` immediately.** Do not wait for the user to ask. This deploys to both IONOS (PHP/JS/CSS) and Render (WebSocket proxy). It's safe to run even if only one side changed.

---

## IMPORTANT: Git Security

**NEVER commit sensitive files to git.** The following are in `.gitignore` for a reason:
- `config/sendgrid.php` - Contains API keys
- `sftp.txt`, `ssh_user.txt`, `priv_key.txt`, `github_token.txt` - Credentials

Before running `git add -A` or committing, verify no secrets are being staged.

---

## IMPORTANT: Maintaining Documentation

**After solving any significant bug or discovering important technical details, update the appropriate file:**
- General bugs/fixes → `.claude/docs/troubleshooting.md`
- TinTin++ commands/patterns → `.claude/docs/tintin-reference.md`
- Protocol details (MIP, TCP, ANSI) → `.claude/docs/protocols.md`
- Architecture changes → `.claude/docs/architecture.md`

---

## Detailed Documentation

This file has been split into topic-specific files in `.claude/docs/`:

| File | Contents |
|------|----------|
| `tintin-reference.md` | TinTin++ patterns, wildcards, all command references |
| `troubleshooting.md` | Common issues and solutions |
| `protocols.md` | MIP, TCP packet handling, ANSI colors, telnet |
| `architecture.md` | Session persistence, triggers, multi-server, mobile UI |

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

### Render (WebSocket Proxy)
- **Command**: `python deploy.py render`
- Deploys `server.js` via GitHub push
- **Build Filter**: Render only rebuilds when `server.js` or `package.json` change (configured in Render dashboard "Included Paths")

### Deploy Both
- **Command**: `python deploy.py all` (default, always safe to run)

---

## Architecture Overview

- **Frontend**: PHP on IONOS (index.php, app.php, etc.)
- **WebSocket Proxy**: Node.js on Render (server.js) - connects browser to MUD
- **MUD Servers**:
  - 3Kingdoms: 3k.org:3000 (default)
  - 3Scapes: 3scapes.org:3200

**Key architectural decisions:**
- **Triggers run server-side** - survives browser disconnects, critical for mobile
- **Session persistence** - MUD connections survive app switches, network blips
- **Token-based auth** - 256-bit random tokens tie browser to MUD session

See `.claude/docs/architecture.md` for detailed documentation.

---

## Key Directories

| Path | Purpose |
|------|---------|
| `assets/js/app.js` | Main client JavaScript |
| `assets/css/style.css` | All styling |
| `glitch/server.js` | WebSocket proxy (deployed to Render) |
| `includes/` | PHP helpers (auth, functions, settings) |
| `api/` | PHP API endpoints |
| `config/config.php` | App configuration |

---

## TinTin++ Support Summary

**Fully Supported:** `#action`, `#alias`, `#var`, `#math`, `#if`, `#delay`, `#ticker`, `#gag`, `#highlight`, `#showme`, `#bell`, `#loop`, `#foreach`, `#list`, `#function`, `#local`, `#switch`, `#event`, speedwalk

**Partially Supported:** `#split` (no row positioning), `#prompt` (basic), `#config` (speedwalk only)

**Not Supported:** `#system` (security), multi-session, terminal manipulation

See `.claude/docs/tintin-reference.md` for complete pattern and command reference.

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

See `.claude/docs/troubleshooting.md` for detailed solutions.
