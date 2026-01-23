# WMT Client Changelog

All notable changes to the WMT (We MUD Together) Client are documented in this file.

---

## [2.3.0] - 2025-01-15

### Added
- **#substitute / #sub command** - Text replacement triggers
  - `#sub {pattern} {replacement}` - Replace matching text visually
  - `#unsub {pattern}` - Remove substitute
  - Supports TinTin++ patterns with `%1`-`%99` capture substitution
  - UI button and modal in Actions sidebar
  - "S" icon for substitute triggers in sidebar

### Fixed
- **Case sensitivity** - All pattern matching is now case-sensitive by default
  - Triggers, gags, highlights, substitutes all respect case
  - `#regexp` command is case-sensitive
  - `#if` pattern matching is case-sensitive
  - Use `%i` in patterns for case-insensitive matching

---

## [2.2.0] - 2025-01-14

### Added
- **#if command** - Full TinTin++ conditional support
  - String comparison with quotes: `#if {"$var" == "value"}`
  - Numeric comparison without quotes: `#if {$hp > 5000}`
  - All operators: `==`, `!=`, `===`, `!==`, `<`, `>`, `<=`, `>=`
  - Logical operators: `&&`/`and`, `||`/`or`, `^^`/`xor`, `!`/`not`
  - Regex pattern matching: `#if {"$class" == "{mage|wizard}"}`

- **#regexp / #regex command** - Pattern matching with captures
  - `#regexp {string} {pattern} {true_cmd} {false_cmd}`
  - Captures stored in `&0`-`&99` (different from `%0`-`%99` in #action)
  - Variable substitution in string argument (e.g., `$hpbar`)

### Changed
- **TinTin++ pattern system overhaul**
  - Removed matchType dropdown - patterns auto-detected
  - Plain text = "contains" match
  - Patterns with `%`, `^`, `$`, `{}` = TinTin++ regex
  - All wildcards now use greedy matching (`%*`, `%d`, `%w`, etc.)
  - PCRE embedding with `{a|b}` for alternation

---

## [2.1.0] - 2025-01-10

### Added
- **3K/3S Multi-Server Support**
  - Each character can be configured for 3Kingdoms or 3Scapes
  - Server toggle in character management UI
  - Whitelist security - only allowed servers can connect
  - Duplicate character names allowed across different servers

- **Character dropdown** in header for quick switching
- **Server uptime and reboot countdown** in header (from MIP AAC/AAF)

### Fixed
- Double connection bug when switching servers
- MIP detection for 3Scapes login messages

---

## [2.0.1] - 2025-01-05

### Fixed
- **Session persistence freezing** after reconnect
  - Buffer replay now uses batched sends with real delays
  - Prevents browser DOM lockup from rapid message flood

- **Mobile app hanging** after switching apps
  - Added visibility change detection to check WebSocket health
  - Auto-reconnect when returning to foreground with dead socket

- **Wake Lock event handler leak**
  - Fixed exponential growth of visibilitychange handlers
  - Was causing app freeze after multiple app switches

---

## [2.0.0] - 2025-01-01

### Added
- **Session Persistence** - MUD connections survive browser disconnects
  - Token-based session management
  - 150-line buffer for missed content
  - MIP stats restored on reconnect
  - 30-minute timeout for abandoned sessions
  - Explicit disconnect (button/tab close) vs unexpected (app switch/crash)

---

## [1.3.0] - 2024-12-20

### Added
- **MIP Conditions** - Trigger commands based on HP/SP/GP values
  - Create conditions like "if HP < 500, cast heal"
  - Sub-conditions with AND/OR logic
  - Cooldown to prevent spam
  - UI panel for condition management

- **ChatMon** - Floating/docked chat monitor window
  - Captures tells, says, chat channels
  - Can be popped out to separate window
  - Draggable and resizable

- **HP/SP/GP Status Bar** - Visual stat display from MIP data
  - Color-coded bars (HP red/green, SP blue, GP purple/cyan)
  - Enemy health bar during combat
  - Guild line display
  - Room name and exits

### Changed
- Renamed "Scripts" sidebar to "Actions"
- Renamed "Chat" to "ChatMon"

---

## [1.2.3] - 2024-12-15

### Fixed
- **Multi-line colored blocks** only showing color on first line
  - Now tracks ANSI state across lines
  - Properly handles MUD color blocks (e.g., yellow room descriptions)

---

## [1.2.2] - 2024-12-12

### Added
- **Telnet GA (Go Ahead) detection** for immediate prompt display
  - No more waiting for timeout on prompts
  - Proper telnet protocol support

---

## [1.2.0] - 2024-12-10

### Fixed
- **TCP Line Buffering** - Lines no longer break mid-text
  - Properly buffers until newline received
  - Handles TCP packet fragmentation correctly
  - 100ms timeout fallback for prompts without newlines

---

## [1.1.2] - 2024-12-05

### Fixed
- **MIP data leaking** to display as raw text
  - Filter now runs as first line of defense
  - Generic regex catches all MIP regardless of session ID
  - Properly gags orphaned MIP fragments

---

## [1.1.0] - 2024-12-01

### Added
- **TinTin++ Commands**
  - `#action` / `#unaction` - Triggers with pattern matching
  - `#alias` / `#unalias` - Command shortcuts
  - `#gag` / `#ungag` - Hide matching lines
  - `#highlight` / `#unhighlight` - Color matching text
  - `#var` / `#unvar` - Variables
  - `#math` - Arithmetic operations
  - `#loop` - Repeat commands
  - `#showme` / `#show` - Display text locally
  - `#bell` - Play alert sound
  - `#ticker` / `#unticker` - Repeating timers
  - `#delay` / `#undelay` - One-shot timers
  - `#class` - Group triggers/aliases
  - `#read` - Load script files
  - `#write` - Export to TinTin++ format
  - `#split` - Split screen regions (partial)

- **Pattern Matching**
  - `%*`, `%+`, `%?`, `%.` - Wildcards
  - `%d`, `%w`, `%s` - Type-specific matches
  - `%1`-`%99` - Capture groups
  - `^` / `$` - Anchors

- **Script File Support**
  - Upload `.tin` or `.txt` files
  - Export triggers/aliases to TinTin++ format

---

## [1.0.0] - 2024-11-15

### Added
- **Initial Release**
  - WebSocket-based MUD client for 3Kingdoms
  - User authentication and character profiles
  - Basic trigger and alias support
  - ANSI color rendering
  - Command history with up/down arrows
  - Mobile-responsive design
  - MIP protocol support for HP/SP display

---

## Version History Summary

| Version | Date | Highlights |
|---------|------|------------|
| 2.3.0 | 2025-01-15 | #substitute command, case sensitivity fix |
| 2.2.0 | 2025-01-14 | #if, #regexp, TinTin++ pattern overhaul |
| 2.1.0 | 2025-01-10 | 3K/3S multi-server, character dropdown |
| 2.0.1 | 2025-01-05 | Session persistence fixes, mobile stability |
| 2.0.0 | 2025-01-01 | Session persistence |
| 1.3.0 | 2024-12-20 | MIP conditions, ChatMon, HP bar |
| 1.2.3 | 2024-12-15 | Multi-line color fix |
| 1.2.2 | 2024-12-12 | Telnet GA support |
| 1.2.0 | 2024-12-10 | TCP line buffering |
| 1.1.2 | 2024-12-05 | MIP filtering fix |
| 1.1.0 | 2024-12-01 | TinTin++ commands |
| 1.0.0 | 2024-11-15 | Initial release |
