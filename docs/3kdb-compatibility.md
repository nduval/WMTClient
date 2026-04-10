# 3kdb Package — Compatibility Analysis

**Generated**: 2026-03-20
**Source**: https://github.com/jmitchell33/3kdb (master branch)

## Summary

| Metric | Value |
|--------|-------|
| Total .tin files | 813 |
| Total lines | 70,056 |
| Fully supported files | 528 (65%) |
| Partially supported | 268 (33%) |
| Skipped (overlap/unsupported) | 15 (2%) |
| Empty | 2 |

## Importable Items (Package Scope)

Only `common/`, `common/guilds/`, `common/bot/`, and `modules/` are imported. `chars/` are per-player templates (not included).

| Type | common/ | guilds/ | bots/ | modules/ | **Total** |
|------|---------|---------|-------|----------|-----------|
| Actions | 214 | 306 | 97 | 526 | **1,143** |
| Aliases | 119 | 344 | 28 | 91 | **582** |
| Gags | 244 | 189 | 3 | 0 | **436** |
| Substitutes | 4 | 9 | 4 | 0 | **17** |
| Variables | 72 | 225 | 605 | 161 | **1,063** |
| Functions | 2 | 5 | 0 | 13 | **20** |
| Tickers | 1 | 0 | 2 | 0 | **3** |
| **Subtotal** | **656** | **1,078** | **739** | **791** | **3,264** |

Note: `chars/` has 248 actions, 1001 aliases, etc. — these are per-character and not included in the package.

## Classes (107 total)

The package preserves 3kdb's class structure with `3kdb/` prefix. Key classes:

**Core**: `default_actions`, `default_aliases`, `defaultsetup`, `heartbeat`, `general_gags`, `subs`, `common_room`, `common_strategy`, `common_corpse`, `common_hpbar`, `3kdb_library`, `3kdb_whitelist`

**Guilds** (22): `guild_actions`, `guild_aliases`, `guild_gags`, `guild_heartbeat`, `guild_hpbar`, `guild_miphp`, `guild_strategy`, `guild_tickers`, `guild_vars` — per guild

**Modules**: `deadman`, `damage_tracker`, `dmgtracker`, `worlddrops`, `colors`, `crafting`, `corpse_manager`, `item_tracker`

**Bots**: `bot`, `botcycle`, `botlist`, `xbot` — plus individual bot scripts

## Command Support Matrix

### Fully Supported (used in 3kdb)
| Command | Count | Notes |
|---------|-------|-------|
| `#var` | 7,636 | Most-used command |
| `#list` | 5,814 | Heavy use of nested lists |
| `#if`/`#elseif`/`#else` | 3,906 | All conditional forms |
| `#alias` | 2,422 | |
| `#class` | 2,166 | 107 unique classes |
| `#echo` | 2,035 | |
| `#action` | 1,891 | |
| `#math` | 1,076 | |
| `#gag` | 1,013 | |
| `#case`/`#switch`/`#default` | 975 | |
| `#format` | 807 | |
| `#delay` | 674 | |
| `#read` | 669 | Nested file loading |
| `#line` | 401 | `#line gag`, `#line ignore` |
| `#showme` | 333 | |
| `#replace` | 171 | |
| `#foreach` | 169 | |
| `#unvar` | 130 | |
| `#local` | 125 | |
| `#loop` | 115 | |
| `#sub`/`#substitute` | 179 | |
| `#return` | 82 | |
| `#ticker` | 69 | |
| `#cat` | 63 | |
| `#regexp` | 55 | |
| `#function` | 36 | |
| `#send` | 421 | MUD command sending |
| `#unaction` | 44 | |
| `#undelay` | 34 | |
| `#unticker` | 27 | |
| `#ungag` | 16 | |
| `#bell` | 6 | |
| `#kill` | 5 | |
| `#highlight` | 3 | |

### Partially Supported
| Command | Count | Issue |
|---------|-------|-------|
| `#draw` | 60 | Terminal drawing — SKIP |
| `#event` | 34 | Mouse/screen events — SKIP body, some events convertible |
| `#config` | 30 | Only `speedwalk` config supported |
| `#screen` | 7 | Not supported — SKIP |
| `#split` | 2 | Basic only |
| `#prompt` | 3 | Basic only |

### Unsupported (skip during conversion)
| Command | Count | Strategy |
|---------|-------|----------|
| `#map` | 416 | Skip — WMT has no mapper. Most are in `#if` guards or area scripts |
| `#macro` | 139 | Skip — keyboard macros, mostly numpad |
| `#script` | 24 | Skip — Python callouts (Discord, 3kpi) |
| `#path`/`#pathdir` | 60 | Skip — path walking, some in bot files |
| `#system` | 9 | Skip — external commands |
| `#unmacro` | 18 | Skip |
| `#session` | 6 | Skip — multi-session |
| `#info` | 8 | Skip |
| `#debug` | 3 | Skip |
| `#log` | 3 | Skip |
| `#buffer` | 5 | Skip |
| `#cursor` | 7 | Skip |
| `#port` | 2 | Skip |

### False Positives (`??` category)
Many `#xxx` matches are **MUD game commands** inside alias/action bodies, not TinTin++ commands:
- `#summons` (77), `#cast` (72), `#defend` (39), `#assist` (38) — guild combat commands
- `#always` (76) — MUD room flag
- `#n`, `#k`, `#sp` etc. — MUD shorthand for directions/skills
- These pass through to the MUD unchanged — no conversion needed

## Skip List (Files Excluded from Import)

| File | Reason |
|------|--------|
| `3k.tin` | Entry point, #macro, character selection |
| `common/draw.tin` | #draw terminal UI (536 lines) |
| `common/draw_mapFull.tin` | Full-screen map drawing |
| `common/macros.tin` | Keyboard macros |
| `common/events.tin` | Mouse events, screen resize |
| `modules/mip/*.tin` (6 files) | WMT has built-in MIP handling |
| `modules/map/*.tin` (4 files) | #map not supported |
| `scripts/*.py` (2 files) | #system not supported |

## Conversion Strategy

### Handling `#map` in Mixed Files
Many otherwise-importable files contain `#map` calls (e.g., `common/actions.tin` has 11). Strategy:
1. **Inside `#if` guards**: Skip the entire conditional block if it tests map state
2. **Standalone `#map` lines**: Skip line, add comment noting removal
3. **In alias bodies**: Convert alias but strip `#map` commands from the body

### Handling `#event`
- `common/events.tin` is fully skipped
- Individual `#event` calls in other files: skip during conversion

### Multi-line Brace Collapsing
3kdb uses multi-line brace formatting extensively:
```
#alias {name} {
    line1;
    line2;
}
```
The converter must collapse these into single-line form for WMT's JSON format.

### Variable Nesting
3kdb uses heavy nested variables (`$var[key][subkey]`). WMT supports this via `#list` and nested `$var[]` — should work without changes.

### `#show` vs `#showme`
`#show` appears 488 times — this is the TinTin++ abbreviated form of `#showme`. The converter should treat `#show` as `#showme`.

### `#act` vs `#action`
`#act` (437 uses) is abbreviated `#action`. Converter handles this.

### `#regex` vs `#regexp`
`#regex` (479 uses) is abbreviated `#regexp`. Converter handles this.

## Per-Guild File Structure

Each guild in `common/guilds/` follows a consistent pattern:
```
index.tin       — Loader (#reads all guild files, opens/closes class)
actions.tin     — Guild-specific triggers
aliases.tin     — Guild-specific commands
gags.tin        — Combat gag rules
heartbeat.tin   — Periodic checks
hpbar.tin       — HP display (some guilds)
miphp.tin       — MIP HP handling
strategy.tin    — Combat strategy
tickers.tin     — Periodic tickers
vars.tin        — Guild variables (some guilds)
```

Guilds: adventurer, angel, bard, bladesinger, breed, changeling, cyborg, elemental, eternal, fremen, gentech, jedi, juggernaut, knight, knights-zorb, mage, monk, necromancer, priest, psicorps, sii

## Bot Files

`common/bot/bots/` contains 157 bot scripts (area-specific automation). Each bot typically:
- Sets variables for area navigation (speedwalk paths)
- Defines triggers for combat/room detection
- Uses `#path` in some cases (will be stripped)

These are highly valuable for WMT users and should be importable as individual classes.

## Risk Assessment

| Risk | Level | Mitigation |
|------|-------|------------|
| Nested `$var[]` resolution | Low | WMT already supports this |
| `#list` heavy usage (5814) | Low | WMT has full `#list` support |
| `#format` directives | Medium | Verify all format specifiers are supported |
| `#map` in mixed files | Low | Line-level skip is safe |
| Large item count per class | Medium | Some classes may have 50+ items — test UI performance |
| `#echo` vs `#showme` | Low | Both work in WMT |
| `#line` modifiers | Low | `gag`, `ignore`, `quiet` all supported |

## Next Steps

1. Build converter (`convert_3kdb.js`) based on this analysis
2. Handle abbreviations: `#show`→`#showme`, `#act`→`#action`, `#regex`→`#regexp`, `#sub`→`#substitute`, `#var`→`#variable`
3. Test converted output with sandbox mock MUD
4. Build package API + client UI
