# pi-data-masking

**Pi extension for securing LLM interactions by automatically masking sensitive data on input and unmasking it for users and tools on output.**

## Purpose

Pi agent sessions routinely send and receive sensitive data — internal domains, database credentials, API keys, internal IP addresses, phone numbers, and so on — both in what the user types and in what tools return (file contents, API responses, command output). This extension protects that data from ever reaching the LLM provider: real values stay local, and only fake-but-structurally-identical values are sent upstream, while the user and any tools the agent calls still operate on the real data the whole time.

## How it works

Automatic **mask / unmask** at every data boundary between the user, the LLM, and external tools/APIs:

- The **user** always sees real values
- The **LLM** only ever sees randomly generated placeholders, format-preserving so it can't tell they're fake
- **Tool calls** are unmasked back to real values right before execution
- Supports **literal exact match** and **regex fuzzy match** rules, freely mixed in one config

Concretely, masking happens by replacing each character of a sensitive value with another random character of the same type (letter→letter, digit→digit, separators kept as-is) — not by swapping it for an obvious marker like `[TOKEN_REDACTED]`.

## Why these choices

**1. Character-level replacement instead of obvious placeholders.** An obviously-fake token like `[TOKEN_REDACTED]` reads as a signal to the model that something is missing or off-limits — it can make the model hesitate, ask the user to confirm, or skip a tool call it would otherwise run normally, none of which is the goal here. A format-preserving fake value looks like an ordinary parameter, so the model just proceeds with the task as if it had the real value; the real value is restored right before any tool actually executes, so the tool itself never sees anything but the truth.

**2. Regex rules cover a whole class of values, each occurrence keeping its own stable fake value.** A single regex rule (e.g. "any IP", "any phone number") can match many distinct real values across a conversation. Each distinct value gets its own placeholder, generated on first sight and reused afterward, so a response that mentions three different IPs comes back with three different (but each internally consistent) fake IPs — and every one of them can be mapped back to its real value with full precision when the response is unmasked.

**3. Auto-generated or manually specified placeholders, your choice.** Most rules can just omit `placeholder` (or set it to `"auto"`) and get a random format-preserving value for free. When a more controlled, "realistic-looking" fake is preferred — e.g. swapping a real root domain for a deliberately chosen fake one — set `placeholder` explicitly and it's used as-is. Regex rules always auto-generate (a single pattern can match unlimited distinct values, so a fixed placeholder isn't meaningful there).

---

## Contents

1. [Install](#install)
2. [Config file](#config-file)
3. [Two-level config merge](#two-level-config-merge)
4. [Placeholder generation](#placeholder-generation)
5. [Regex fuzzy matching](#regex-fuzzy-matching)
6. [Data flow](#data-flow)
7. [Stats panel](#stats-panel)
8. [Built-in commands](#built-in-commands)
9. [Config field reference](#config-field-reference)
10. [Notes](#notes)
11. [Limitations](#limitations)
12. [File overview](#file-overview)

---

## Install

```bash
# Install the extension from npm
pi install npm:@sevten/pi-data-masking

# Create a local config from the example, then fill in the real values to protect
mkdir -p ~/.pi/agent/pi-data-masking
cp ~/.pi/agent/npm/node_modules/@sevten/pi-data-masking/masking.config.example.json ~/.pi/agent/pi-data-masking/masking.config.json
nano ~/.pi/agent/pi-data-masking/masking.config.json

# Optional: a project-specific config
mkdir -p /your/project/.pi/pi-data-masking
cp ~/.pi/agent/pi-data-masking/masking.config.json /your/project/.pi/pi-data-masking/masking.config.json
```

Config changes **hot-reload** automatically — no restart needed.

---

## Config file

| Path | Description |
|------|-------------|
| `~/.pi/agent/pi-data-masking/masking.config.json` | Global config, applies to all projects |
| `<project root>/.pi/pi-data-masking/masking.config.json` | Project-level config, applies only to that project |

The package template lives inside the installed npm package at `~/.pi/agent/npm/node_modules/@sevten/pi-data-masking/masking.config.example.json`. Treat that as read-only package content; put your edited config in one of the paths above.

Each rule has an optional `type` field:

| `type` | Meaning |
|--------|---------|
| omitted or `"literal"` | Literal exact match: `real` is a fixed string, compared char-for-char |
| `"regex"` | Regex fuzzy match: `pattern` can hit many different real values |

### Three examples

**1. Auto-generated placeholder (literal, most common)** — just `id`, `real`, `description`:

```json
{
  "id": "prod_api_key",
  "description": "Production API key",
  "real": "sk-prod-abc123456789"
}
```

**2. Manual placeholder (literal)** — for a controllable, realistic-looking fake value instead of random characters. A common case is picking a plausible replacement root domain:

```json
{
  "id": "company_root_domain",
  "description": "Company root domain",
  "real": "company-internal.com",
  "placeholder": "northstar-systems.com"
}
```

**3. Regex fuzzy match** — `pattern` instead of `real`; one rule covers a whole class of values (phone numbers, credentials inside connection strings, ...), and each distinct value gets its own stable placeholder:

```json
{
  "id": "us_mobile_number",
  "type": "regex",
  "description": "US phone number",
  "pattern": "\\b(?:\\+?1[-. ]?)?\\(?[2-9]\\d{2}\\)?[-. ]?\\d{3}[-. ]?\\d{4}\\b"
}
```

All three kinds can be freely mixed and combined (e.g. a domain rule for the host plus a regex rule for credentials inside a connection string). See `masking.config.example.json` for the full example.

---

## Two-level config merge

```
final config = merge(global config, project config)
```

| Field | Merge behavior |
|-------|-----------------|
| `rules` | project rules first (matched first), global rules appended after |
| `options` | project fields override global fields with the same name |
| `enabled` | project value wins if explicitly set, otherwise falls back to global |

Example: global `rules = [A, B, C]`, project `rules = [X, Y]` → merged `[X, Y, A, B, C]`.

---

## Placeholder generation

**Core algorithm (shared by literal and regex rules)**: derive a deterministic byte stream from HMAC(sessionKey, real value), then do **format-preserving replacement** — the placeholder matches the real value's format exactly, so the LLM can't tell it's fake from formatting alone.

| Character type | Replacement |
|-----------------|-------------|
| Uppercase | → random uppercase |
| Lowercase | → random lowercase |
| Digit | → random digit |
| Other (`-` `_` `@` `.` `:` `/` etc.) | → kept as-is |

**Examples:**

```
real:        sk-prod-abc123456789
placeholder: sk-nqpz-mwx847312654   ← prefix and format preserved

real:        api.company-internal.com
placeholder: kpz.xm7rqn-bfwtpj.com  ← hierarchy and TLD preserved

real:        postgresql://admin:MyS3cr3tP@ssw0rd@db.company.com:5432/prod
placeholder: postgresql://bxkzp:NqW8vxLm@kpRwqn@wn.xm7rqnj.com:5432/prod
             ↑ scheme/port/path kept; userinfo and host replaced

real:        172.16.254.1
placeholder: 233.84.19.207          ← each octet independently valid (0-255)
```

**IPv4 special case**: naive per-character replacement can't guarantee every octet stays within 0-255 — `172` could become `988`, which isn't a valid IP segment. When a real value is exactly a valid IPv4 address, the extension instead generates each octet independently within 0-255, so the placeholder is always syntactically valid.

**Two trigger points:**

- **Literal rules**: the real value is known at config-load time, so the placeholder is generated **once** at session start (or config reload).
- **Regex rules**: the real value isn't known until a match occurs at runtime, so the placeholder is generated **lazily on first match** and reused for subsequent matches of the same value — equally stable as literal rules in practice.

**Stability within a session**: the same real value (whether from a literal rule or a regex match) always gets the same placeholder within a session. Hot reload, `/masking-reload`, and `/masking-toggle` never disturb existing mappings — only a brand-new session resets them.

**Collision protection**: in rare cases (very short real values, limited character space) a generated placeholder may collide with one already in use. The extension keeps a "used" set and automatically retries (up to 10 times) on collision, so each placeholder maps back to exactly one real value.

**Manual override**: literal rules only. Set an explicit `placeholder` to skip auto-generation. Regex rules don't support manual placeholders — a single pattern can match many different real values, so a fixed placeholder wouldn't make sense.

---

## Regex fuzzy matching

Use this when a class of sensitive values has a fixed shape but unbounded specific values — internal IP addresses, phone numbers, arbitrary employee emails, tokens, etc. One rule covers the whole class instead of writing a literal rule per value.

### Basic usage

```json
{
  "id": "us_mobile_number",
  "type": "regex",
  "description": "US phone number",
  "pattern": "\\b(?:\\+?1[-. ]?)?\\(?[2-9]\\d{2}\\)?[-. ]?\\d{3}[-. ]?\\d{4}\\b"
}
```

`pattern` is regex source with no delimiters (same as `new RegExp(pattern)`; backslashes need `\\` escaping in JSON).

### Capture groups: replace only what needs protecting

Wrap the part to replace in a capture group to keep the rest of the match as literal text:

```json
{
  "id": "generic_bearer_token",
  "type": "regex",
  "description": "Generic Bearer token",
  "pattern": "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)",
  "flags": "i"
}
```

Effect: `Authorization: Bearer abcDEF123456` → `Authorization: Bearer xyzGHI789012` — the `Authorization: Bearer ` prefix stays, only the token value is replaced, so the LLM can still recognize it as an auth header. Without a capture group (e.g. the phone number example), the whole match is replaced.

### Lookahead: keep adjacent rules from claiming each other's territory

A capture group only *replaces* the captured text, but the **whole match** is still registered as a claimed region (to stop the same rule, or others, from reprocessing it). That's a problem when two rules sit right next to each other but each owns a different segment — e.g. masking an email's local part with one rule and its domain with another. If the local-part rule is written as `(local part)@domain`, the whole `local part@domain` gets claimed, and the domain rule is skipped due to overlap.

The fix is a lookahead `(?=...)`, which only *checks* what follows without consuming it:

```json
{
  "id": "employee_email_local_part",
  "type": "regex",
  "description": "Company email local part",
  "pattern": "[A-Za-z0-9._%+-]+(?=@company-internal\\.com)"
}
```

This only matches the local part before `@company-internal.com`; the domain isn't part of the match at all, so it doesn't conflict with a separate `company_root_domain` rule — the two rules can be in either order with identical results.

### Greedy match to the "last occurrence": prefer `[^\s]+` over `.+`

Some patterns need to match up to the *last* occurrence of a delimiter — e.g. in `scheme://user:pass@host`, the password itself might contain `@`, so you need greedy backtracking to find the real separator:

```json
{
  "id": "db_conn_credentials",
  "type": "regex",
  "description": "Username:password in a DB connection string",
  "pattern": "(?:postgresql|mysql|mariadb|redis|mongodb):\\/\\/([^\\s]+)@"
}
```

`[^\s]+` (non-whitespace) is used here instead of the broader `.+`: both backtrack to the last `@`, but `.+` can cross whitespace and newlines all the way to the *last `@` in the entire remaining text* — if an unrelated email address appears later in the same message, `.+@` might swallow everything in between into the capture group. `[^\s]+` bounds the match to a single whitespace-free token, correctly handling `@` in the password without bleeding into unrelated content.

### `flags`: each regex rule controls its own case sensitivity

If a regex rule provides `flags` (like `"flags": "i"` above), it fully controls case sensitivity etc., **independent of** the global `caseSensitive` option. If omitted, it falls back to the global `caseSensitive` setting. `g` and `d` are always appended internally — no need to add them manually.

### Priority when mixing literal and regex rules

Literal and regex rules share the same "list order = priority" mechanism: rules are tried top to bottom, and once a region is claimed by an earlier rule, later rules skip it. This means:

- If a broader rule should coexist with a more specific manual-placeholder rule for one particular value, **put the more specific rule first** so the broad rule doesn't claim it first.
- Among regex rules, more specific (narrower) patterns should come before broader ones, so a broad pattern doesn't "eat" text a narrower rule needs.
- If two rules' matches are meant to sit adjacent but never overlap (e.g. email local part vs. domain), prefer a lookahead to fully isolate them — then rule order stops mattering.

### How `/masking-list` displays regex rules

Regex rules have no fixed placeholder to show (real values are only known at runtime), so `/masking-list` shows the pattern itself:

```
[regex] /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/  ——  Any IPv4 address
```

### Known limitation

Regex-generated placeholders still go through the format-preserving algorithm (IPv4 addresses get special handling — see [Placeholder generation](#placeholder-generation)). For other value types there's a small theoretical chance of collision with another rule's literal value or placeholder — collision retry covers this, but it's still good practice to keep patterns precise (`\b` boundaries, `[^\s]+` over `.+`) to reduce accidental matches.

---

## Data flow

```
User input ──────────────────────────────────────► conversation (real values)
                                                         │
                                          [context] deep mask (in-memory copy)
                                          literal + regex rules handled uniformly
                                          regex matches generate/reuse placeholders
                                                         │
                                                         ▼
                                              LLM (sees only placeholders)
                                                         │
                         ┌───────────────────────────────┤
                         │                               │
                  Text response (placeholders)    Tool call (args with placeholders)
                         │                               │
            [message_end] unmask              [tool_call] unmask args in place
                         │                               │
            ▼ stored in conversation (real)   ▼ tool runs with real arguments
            user sees real values                        │
            stats panel shown                    external API response (real values)
                                                         │
                                              stored in conversation (real)
                                              user sees the real response
                                                         │
                                          next [context] masks it again
                                          LLM sees the masked API response
```

---

## Stats panel

After each AI turn, a panel below the editor shows this round's masking stats, auto-hiding after 20 seconds:

```
🔒 Masked 7 value(s)  ·  14:23:01
  Production API domain   api.c***×2
  Any IPv4 address        10.4***×3  192.1***×2
```

A single rule (especially a regex one) can hit several distinct real values in one turn; the panel lists each one's preview and count separately (up to 4 distinct values, with a "+N more" note beyond that) rather than collapsing into one total.

**What's counted**: only mask (outbound) events — sensitive values intercepted before reaching the LLM. This covers both:
- User-sent messages
- Tool results sent back to the LLM across multi-turn tool calls

Each `context` event only counts newly added messages, avoiding double-counting history across turns.

**The panel only shows which rule fired and a real-value preview** — never the placeholder, since the user doesn't need to know what the fake value is.

Use `/masking-history` to review the full masking history for this session at any time.

---

## Built-in commands

| Command | Description |
|---------|-------------|
| `/masking-status` | Show current on/off state and rule count |
| `/masking-list` | List all rules (literal rules show their current placeholder, regex rules show their pattern); real values never shown |
| `/masking-history` | View this session's masking history (last 30 entries) |
| `/masking-toggle` | Temporarily toggle on/off (doesn't touch the config file, resets on restart) |
| `/masking-reload` | Manually reload the config file (reuses the current session key and dynamic regex map, placeholders stay stable) |
| `/masking-clear` | Close the currently displayed panel |

---

## Config field reference

**Literal rule fields (`type` omitted or `"literal"`):**

| Field | Type | Required | Description |
|-------|------|----------|--------------|
| `id` | string | ✅ | Unique rule id, used for debugging and as a fallback label when `description` is absent |
| `description` | string | — | Describes what this rule protects, shown in the panel and `/masking-list` |
| `type` | `"literal"` | — | Can be omitted; defaults to literal |
| `real` | string | ✅ | The exact real value to replace |
| `placeholder` | string | — | Omit or `"auto"` to auto-generate; set explicitly to use as-is (manual wins) |

**Regex rule fields (`type: "regex"`):**

| Field | Type | Required | Description |
|-------|------|----------|--------------|
| `id` | string | ✅ | Unique rule id |
| `description` | string | — | Describes what this rule protects |
| `type` | `"regex"` | ✅ | Must be explicitly `"regex"` |
| `pattern` | string | ✅ | Regex source (no delimiters); a match is treated as sensitive. With capture groups, only the captured part is replaced |
| `flags` | string | — | Optional; omit to follow global `caseSensitive`, set to take full control (overrides global). No need to include the global-match flag manually |

> Regex rules don't support `real` / `placeholder` — the real value is only known at runtime, so the placeholder can only be generated then too.

**`options` fields:**

| Field | Type | Default | Description |
|-------|------|---------|--------------|
| `caseSensitive` | boolean | `true` | Case sensitivity for literal matching and for regex rules without their own `flags` |
| `showStatusBar` | boolean | `true` | Whether to keep showing masking status in the bottom status bar |

---

## Notes

**Rule order**

All rules (literal + regex) are matched top to bottom; once a region is claimed, later rules skip it. Overlapping or nested rules must put the **more specific / longer one first**:

- A broad email-domain rule placed before a specific email's manual-placeholder rule will claim the domain part first, causing the more specific rule to be skipped due to overlap.
- The more robust fix for this kind of order sensitivity is a [lookahead](#regex-fuzzy-matching), so the two rules each claim only their own slice of text and never overlap — order then stops mattering. `employee_email_local_part` (username) and `company_root_domain` (domain) in `masking.config.example.json` are written this way: independent and order-insensitive. For the same reason, splitting a connection string into "domain rule for the host" + "regex rule for credentials" (rather than one literal rule for the whole string) also doesn't require worrying about which comes first.

**Connection string auto-generation behavior**

For known schemes (`postgresql://`, `mysql://`, ...), if an entire connection string happens to be the `real` value of a **literal** rule (an exact match of the whole string), auto-generation keeps the scheme, port, and path, replacing only userinfo and host. The more recommended approach, though, is not to treat the whole connection string as one literal value — split it into a domain rule for the host (which also covers every other place that domain appears) plus a regex + capture-group rule for credentials (which also covers any other connection string using the same scheme, without needing one rule per literal connection string). See the `company_root_domain` + `db_conn_credentials` combination in `masking.config.example.json`.

**Dynamic placeholder map lifecycle**

The regex-discovered value-to-placeholder map only lives in memory, tied to the session lifecycle: created at session start, reused across hot reloads / `/masking-reload` / `/masking-toggle` (keeping placeholders stable), and discarded when the session ends (or a new one starts) — it's never persisted to disk.

**Session files**

`context`-event masking happens in memory and is never written to the on-disk session file (`~/.pi/sessions/`). Session files store real values, so manage their file permissions accordingly.

---

## Limitations

- **Not a PII detector.** This extension only masks what you've explicitly written a rule for (literal value or regex pattern). It does not scan for or recognize sensitive data on its own — anything not covered by a rule is sent to the LLM as plain text.
- **Obfuscation, not encryption.** The character-level replacement makes a value *look* real to the LLM; it is not cryptographically secure and isn't intended to protect against an adversary who can see both the placeholder and the algorithm. The actual secret never leaves the machine, which is the real security boundary — the format-preserving disguise exists purely so the LLM doesn't treat the value as obviously fake.
- **Literal matching is substring-based.** A literal `real` value is matched wherever it appears as a substring, with no word-boundary check. This is intentional (it's what lets one root-domain rule cover all subdomains, for example) but means a short or generic `real` value can match inside unrelated text. Prefer regex rules with `\b` boundaries for short or common patterns.
- **Session-scoped only.** Placeholder mappings (especially regex-discovered ones) live only in memory for the current session. A new session means new placeholders for the same real values — there's no cross-session placeholder consistency, by design (see [Dynamic placeholder map lifecycle](#notes)).
- **No masking of binary or non-string data.** `maskValue`/`unmaskValue` recurse through strings inside objects/arrays; binary payloads, base64 blobs that aren't matched by a rule, or non-JSON tool outputs aren't masked.
- **Single Pi session boundary.** Masking is enforced at the `context`/`message_end`/`tool_call` hook points for this extension's own scope. If another extension or a raw API path bypasses these hooks, masking won't apply there.

---

## File overview

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point: registers the `context` / `message_end` / `tool_call` hooks, session lifecycle, stats panel, and all `/masking-*` commands |
| `masker.ts` | Core masking engine — the `Masker` class, rule compilation, span-based mask/unmask, collision tracking for regex-discovered placeholders |
| `placeholder-gen.ts` | Format-preserving placeholder generation (HMAC-derived byte stream, connection-string and IPv4 special cases) |
| `config-loader.ts` | Loads and merges global + project config, fills auto placeholders for literal rules, watches config files for hot reload |
| `masking.config.example.json` | Example/template config showing literal and regex rules of every kind described in this README |
