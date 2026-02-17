# TinTin++ Reference

This document covers TinTin++ pattern matching and command syntax supported by the WMT client.

## Overview

This client supports TinTin++ style scripting:
- Pattern matching: `%*`, `%d`, `%w`, `%1`-`%99`, etc.
- Commands: `#action`, `#alias`, `#gag`, `#highlight`, `#var`, `#math`, `#if`, `#loop`, `#foreach`, `#list`, `#showme`, `#bell`, `#split`, `#ticker`, `#delay`, `#class`, `#read`, `#write`, `#regexp`, `#prompt`, `#break`, `#continue`
- Nested variables: `$hp[max]`, `$stats[str][base]`
- Speedwalk: `3n2e` expands to `n;n;n;e;e`
- Script files: `.tin` format supported

## Pattern Reference

Reference: https://tintin.mudhalla.net/manual/pcre.php

### Pattern Auto-Detection
Patterns are automatically detected as TinTin++ regex if they contain:
- `%` followed by wildcards (`*`, `+`, `?`, `.`) or type codes (`d`, `w`, `s`, etc.)
- `%1` through `%99` numbered capture groups
- `^` anchor at start or `$` anchor at end
- `{ }` braces for PCRE embedding

Plain text patterns use simple "contains" matching.

### Wildcards (All Capturing, All Greedy)

| Pattern | Regex | Meaning |
|---------|-------|---------|
| `%1`-`%99` | `(.*)` | Numbered capture group |
| `%*` | `(.*)` | Zero or more chars (excl. newlines) |
| `%+` | `(.+)` | One or more chars |
| `%?` | `(.?)` | Zero or one char |
| `%.` | `(.)` | Exactly one char |
| `%d` | `([0-9]*)` | Zero or more digits |
| `%D` | `([^0-9]*)` | Zero or more non-digits |
| `%w` | `([A-Za-z0-9_]*)` | Zero or more word chars |
| `%W` | `([^A-Za-z0-9_]*)` | Zero or more non-word chars |
| `%s` | `(\\s*)` | Zero or more whitespace |
| `%S` | `(\\S*)` | Zero or more non-whitespace |
| `%a` | `([\\s\\S]*)` | Zero or more chars (incl. newlines) |
| `%A` | `([\\r\\n]*)` | Zero or more newlines only |
| `%c` | `(?:\\x1b\\[[0-9;]*m)*` | Zero or more ANSI color codes |
| `%p` | `([\\x20-\\x7E]*)` | Zero or more printable ASCII |
| `%P` | `([^\\x20-\\x7E]*)` | Zero or more non-printable |
| `%u` | `(.*)` | Unicode - same as %* |
| `%U` | `([\\x00-\\x7F]*)` | ASCII only (0x00-0x7F) |

### Anchors

| Pattern | Meaning |
|---------|---------|
| `^` | Match start of line |
| `$` | Match end of line |

### Modifiers

| Pattern | Meaning |
|---------|---------|
| `%i` | Case insensitive from this point |
| `%I` | Case sensitive from this point (default) |

### Non-Capturing Variants

| Pattern | Regex | Meaning |
|---------|-------|---------|
| `%!*` | `(?:.*)` | Non-capturing zero or more |
| `%!d` | `(?:[0-9]*)` | Non-capturing digits |
| `%!{regex}` | `(?:regex)` | Non-capturing PCRE group |

### PCRE Embedding

| Pattern | Regex | Example |
|---------|-------|---------|
| `{regex}` | `(regex)` | `{hit\|miss}` matches "hit" or "miss" |
| `{a\|b\|c}` | `(a\|b\|c)` | Alternation |
| `%!{regex}` | `(?:regex)` | Non-capturing group |

### Range Syntax

Format: `%+min..max[type]` or `%+min[type]`

| Pattern | Regex | Meaning |
|---------|-------|---------|
| `%+1d` | `([0-9]{1,})` | One or more digits |
| `%+3..5d` | `([0-9]{3,5})` | 3 to 5 digits |
| `%+2w` | `([A-Za-z0-9_]{2,})` | 2+ word chars |

### Variable Substitution

| Context | Syntax | Storage | Example |
|---------|--------|---------|---------|
| `#action` command | `%0`-`%99` | In trigger action | `#act {^%1 says '%2'} {reply %1 I heard %2}` |
| `#regexp` command | `&0`-`&99` | Temporary | `#regexp {hello world} {%1 %2} {#show &1 &2}` |

- `%0` / `&0` = entire matched string
- `%1` / `&1` = first capture group, etc.
- ANSI codes are stripped from captured values before substitution

### Brace-Delimited Variables (v2.6.8+)

Use `${varname}` to disambiguate when `$varname` is followed by `[` which would otherwise be parsed as a nested key access.

| Syntax | Meaning | Example |
|--------|---------|---------|
| `$var` | Simple variable | `$hpmax` → `1832` |
| `${var}` | Disambiguated variable | `${hpmax}[text]` → `1832[text]` |

Without braces, `$hpmax[<088>$hpchange<269>]` would be misread as nested key `$hpmax["<088>..."]`. With braces, `${hpmax}` resolves first, leaving `[...]` as literal text.

### Implementation Notes

1. **All wildcards are GREEDY** - they capture as much as possible
2. **Case insensitive by default** - all pattern matching ignores case unless `%I` is used
3. **ANSI stripping** - captured values have color codes removed to prevent command corruption
4. **Special chars escaped** - `[ ] { } ( ) | + ? * . \\` are treated as literals unless in `{ }` braces

---

## Command Reference

### #if Command

Reference: https://tintin.mudhalla.net/manual/if.php

**Syntax:**
```
#if {condition} {true_commands} {false_commands}
```

**String vs Numeric Comparison:**
- **Quoted = String**: `#if {"$health" == "bad"} {#show See a doctor}`
- **Unquoted = Numeric**: `#if {$hpcur > 5000} {#show Healthy!}`

**Comparison Operators:**

| Operator | Meaning | Notes |
|----------|---------|-------|
| `==` | Equal | Can use regex with strings: `"$var" == "{yes\|no}"` |
| `!=` | Not equal | Can use regex with strings |
| `===` | Strict equal | Never uses regex |
| `!==` | Strict not equal | Never uses regex |
| `<` | Less than | Numeric or alphabetic |
| `>` | Greater than | Numeric or alphabetic |
| `<=` | Less than or equal | Numeric or alphabetic |
| `>=` | Greater than or equal | Numeric or alphabetic |

**Logical Operators:**

| Operator | Meaning | Example |
|----------|---------|---------|
| `&&` or `and` | Logical AND | `$hp > 100 && $sp > 50` |
| `\|\|` or `or` | Logical OR | `$hp < 100 \|\| $sp < 50` |
| `^^` or `xor` | Logical XOR | True if exactly one is true |
| `!` or `not` | Logical NOT | `!$dead` |

**Regex Pattern Matching:**
```
#if {"$class" == "{mage|wizard|sorcerer}"} {#show You cast spells!}
```

**Positional Else (3-arg form):**
```
#if {"$enemy" == "none"} {#var combat off} {#var combat on}
```
The third brace group is an implicit else — runs when the condition is false.

**#elseif / #else Chains:**
```
#if {$hp < 100} {#show Critical!} #elseif {$hp < 500} {#show Low} #else {#show OK}
```

**Nested #if:**
```
#if {$hp < 100} {#show Critical!} {#if {$hp < 500} {#show Low} {#show OK}}
```

**Implementation Notes:**
- `parseIfChain()` in app.js parses all forms (positional else, #elseif, #else)
- Implicit else detected when `{` appears in `between` state without `#else` keyword
- Else conditions use `'1'` internally (not `'true'` — mathexp can't tokenize bare words)
- `evaluateCondition()` calls `substituteVariables()` then `mathexp()` on the condition
- mathexp returns `{val, str, type}` — truthy check: strings by length, numbers by non-zero

### #foreach Command (v2.6.3+)

Iterates over a list of items, executing commands for each.

**Syntax:**
```
#foreach {list} {variable} {commands}
```

**Examples:**
```
#foreach {a;b;c} {item} {say $item}
#foreach {$mylist[%*]} {x} {#showme Item: $x}
#foreach {north;south;east;west} {dir} {look $dir}
```

**Notes:**
- List items are separated by semicolons
- The variable is set to each item in turn
- Commands can use `#break` to exit early or `#continue` to skip to next item
- Works with list variables: `#foreach {$mylist[%*]} {x} {...}`

### #list Command (v2.6.3+)

Manages list variables with TinTin++ compatible operations.

Reference: https://tintin.mudhalla.net/manual/list.php

**Syntax:**
```
#list {variable} {option} [arguments]
```

**Options:**

| Option | Usage | Description |
|--------|-------|-------------|
| `add` | `#list {var} add {item}` | Add item(s) to end of list |
| `clear` | `#list {var} clear` | Remove all items |
| `create` | `#list {var} create {a;b;c}` | Create list from items |
| `delete` | `#list {var} delete {index}` | Remove item at index |
| `find` | `#list {var} find {item} {result}` | Find item, store index in result |
| `get` | `#list {var} get {index} {result}` | Get item at index, store in result |
| `insert` | `#list {var} insert {index} {item}` | Insert item at index |
| `set` | `#list {var} set {index} {value}` | Set item at index |
| `size` | `#list {var} size {result}` | Store list size in result |
| `sort` | `#list {var} sort` | Sort alphabetically |
| `reverse` | `#list {var} reverse` | Reverse order |
| `shuffle` | `#list {var} shuffle` | Randomize order |

**Examples:**
```
#list targets create {orc;goblin;troll}
#list targets add {dragon}
#list targets get {1} {first}
#showme First target: $first
#list targets size {count}
#showme Total targets: $count
```

**Accessing List Items:**
```
$mylist[1]    - First item (1-indexed)
$mylist[-1]   - Last item
$mylist[%*]   - All items (for #foreach)
```

### #break and #continue (v2.6.3+)

Loop control statements for `#loop` and `#foreach`.

**#break** - Exit the loop immediately:
```
#loop {1} {10} {i} {
    #if {$i == 5} {#break};
    say $i
}
```

**#continue** - Skip to next iteration:
```
#foreach {1;2;3;4;5} {n} {
    #if {$n == 3} {#continue};
    say $n
}
```

### Nested Variables (v2.6.3+)

Variables can have nested keys for structured data.

**Syntax:**
```
#var {name[key]} {value}
#var {name[key][subkey]} {value}
```

**Examples:**
```
#var hp[current] 500
#var hp[max] 1000
#var stats[str][base] 18
#var stats[str][bonus] 2

#showme HP: $hp[current]/$hp[max]
#math stats[str][total] {$stats[str][base] + $stats[str][bonus]}
```

**Notes:**
- Keys can be any string
- Nested depth is unlimited
- Lists use numeric keys: `$mylist[1]`, `$mylist[2]`
- Access all list items with `$var[%*]` for #foreach

### #prompt Command (v2.6.3+)

Captures and optionally modifies the MUD prompt line.

Reference: https://tintin.mudhalla.net/manual/prompt.php

**Syntax:**
```
#prompt {pattern} {replacement} {row}
```

**Parameters:**
- `pattern` - TinTin++ pattern to match prompt
- `replacement` - Optional replacement text (use `{}` for none)
- `row` - Display row: `-1` for top split, `-2` for bottom split

**Examples:**
```
#prompt {HP: %1/%2 SP: %3/%4} {} {-2}
#prompt {^%*$} {[PROMPT] %0} {-1}
```

**Notes:**
- Prompts are lines that don't end with newline (detected via telnet GA)
- Row `-2` is typically used for status display at screen bottom
- Captured values available as `%1`, `%2`, etc.

### #function Command (v2.6.4+)

User-defined functions that can be called inline with `@name{args}` syntax.

Reference: https://tintin.mudhalla.net/manual/function.php

**Syntax:**
```
#function {name} {body}
@name{arg1;arg2}
```

**Examples:**
```
#function {double} {#math result {%1 * 2}}
#showme The double of 5 is @double{5}

#function {rnd} {#math result {1 d (%2 - %1 + 1) + %1 - 1}}
#showme Random 1-100: @rnd{1;100}

#function {gettime} {#format result {%t} {%H:%M}}
#showme Current time: @gettime{}
```

**Inside functions:**
- `%0` = all arguments as a string
- `%1`, `%2`, etc. = individual arguments (semicolon-separated)
- `#return {value}` or set `$result` to return a value
- `#local {var} {val}` for scoped variables

### #local Command (v2.6.4+)

Creates variables scoped to the current function or alias execution.

**Syntax:**
```
#local {name} {value}
#unlocal {name}
```

**Example:**
```
#alias {swap} {#local x %0;#replace x {e} {u};#showme $x}
```

**Notes:**
- Local variables shadow global variables of the same name
- Automatically cleaned up when function/alias completes
- Useful to avoid polluting global namespace

### #switch / #case / #default (v2.6.4+)

Cleaner alternative to chained `#if` / `#elseif` statements.

**Syntax:**
```
#switch {value} {#case {v1} {cmd1};#case {v2} {cmd2};#default {cmd}}
```

**Example:**
```
#switch {$direction} {
    #case {north} {#showme Going up!};
    #case {south} {#showme Going down!};
    #default {#showme Going somewhere!}
}

#switch {1d4} {#case 1 cackle;#case 2 smile;#default giggle}
```

### #event Command (v2.6.4+)

Hook into session lifecycle events to run commands automatically.

**Syntax:**
```
#event {event_name} {commands}
#unevent {event_name}
```

**Supported Events:**

| Event | When Fired | Argument |
|-------|------------|----------|
| `SESSION_CONNECTED` | WebSocket connects | - |
| `SESSION_DISCONNECTED` | WebSocket disconnects | - |
| `SESSION_RESUMED` | Session resumed after reconnect | - |
| `VARIABLE_UPDATE` | Any variable is changed | Variable name |
| `CLASS_ACTIVATED` | Class is enabled | Class name |
| `CLASS_DEACTIVATED` | Class is disabled | Class name |

**Examples:**
```
#event {SESSION_CONNECTED} {#showme Connected!;look}
#event {SESSION_DISCONNECTED} {#showme Lost connection!}
#event {VARIABLE_UPDATE} {#if {"%1" == "hp"} {#showme HP changed!}}
#event {CLASS_ACTIVATED} {#showme Class %1 enabled}
```

### Speedwalk (v2.6.3+)

Condensed movement commands that expand to multiple directions.

**Enable:**
```
#config {SPEEDWALK} {ON}
```

**Syntax:**
```
[count]direction[count]direction...
```

**Examples:**
```
3n2e     → n;n;n;e;e
2n3e2s   → n;n;e;e;e;s;s
nnnee    → n;n;n;e;e
```

**Supported Directions:**
- `n`, `e`, `s`, `w` - Cardinal directions
- `u`, `d` - Up, down
- `ne`, `nw`, `se`, `sw` - Diagonals (if supported by MUD)

**Notes:**
- Only works when speedwalk is enabled
- Commands are sent with configurable delay between each
- Disable with `#config {SPEEDWALK} {OFF}`
