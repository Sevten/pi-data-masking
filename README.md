# pi-data-masking

**A Pi extension designed around agent tool use: it masks sensitive data before it reaches the LLM, restores real values only at the tool-execution boundary, and re-masks sensitive tool results before they return to LLM context.**

## How it works

Pi agent sessions routinely send and receive sensitive data — internal domains, database credentials, API keys, internal IP addresses, phone numbers, and so on. This extension keeps real values local: the **LLM only ever sees format-preserving placeholders**, while the user and any tools the agent calls still operate on the real data.

- The **user** always sees real values
- The **LLM** sees randomly generated placeholders that preserve the original format (letter→letter, digit→digit, separators kept as-is). Unlike an obvious marker such as `[TOKEN_REDACTED]`, these still look like usable keys, URLs, and identifiers, which helps avoid the model declining a tool call or searching for a replacement value.
- **Tool calls** contain placeholders while the LLM plans them, then their arguments are unmasked back to real values immediately before execution
- **Tool results** are protected too: matching data from file reads, directory searches, authenticated websites, APIs, and other tools remains real for the user but is masked again before becoming LLM context
- Supports **literal exact match** and **regex fuzzy match** rules, freely mixed in one config
- Rules are deliberately flexible: use literal values, regular expressions, and capture groups to cover custom sensitive formats; an AI assistant can help write rules for your environment

## Built around tool use

`pi-data-masking` protects both sides of an agent tool call without asking the LLM to work around redaction markers:

1. Before a request reaches the LLM, matching values in user messages, prior context, and tool results are replaced with format-preserving placeholders.
2. The LLM can reason about and prepare a normal-looking tool call using those placeholders.
3. Immediately before the tool runs, placeholders in its arguments are restored to their real local values.
4. The user sees the real tool result. Before that result is included in later LLM context, matching sensitive values are masked again.

This is rule-based masking, not automatic PII detection: only values covered by a configured literal or regex rule are protected.

## Contents

1. [Install](#install)
2. [Config file](#config-file)
3. [Two-level config merge](#two-level-config-merge)
4. [Placeholder generation](#placeholder-generation)
5. [Regex fuzzy matching](#regex-fuzzy-matching)
6. [Data flow](#data-flow)
7. [Security boundaries](#security-boundaries)
8. [Stats panel](#stats-panel)
9. [Built-in commands](#built-in-commands)
10. [Config field reference](#config-field-reference)
11. [Limitations](#limitations)
12. [Testing rules with /masking-test](#testing-rules-with-masking-test)
13. [File overview](#file-overview)
14. [Development](#development)

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

Config changes **hot-reload** automatically — no restart needed, even when the config file is created after the session starts. Config files are validated on load: invalid rules (missing `id`/`real`/`pattern`, invalid regex, unknown `type`) are skipped with a warning notification instead of silently breaking the extension, and JSON parse errors are surfaced the same way.

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

### Two examples

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

Regex rules replace `real` with a `pattern` (see [Regex fuzzy matching](#regex-fuzzy-matching)); all kinds can be freely mixed — e.g. a domain rule for the host plus a regex rule for credentials inside a connection string. `masking.config.example.json` contains the full example.

### What the example config covers

The template ships with a ready-to-use starter set (16 rules) — each rule's `description` explains its purpose; **delete any rules you don't need** and replace the example values with your real ones:

| Category | Rules |
|----------|-------|
| Company identifiers | `company_root_domain` · `prod_api_key` · `employee_email_local_part` |
| Credentials & secrets | `db_conn_credentials` · `url_userinfo_credentials` · `generic_bearer_token` · `keyword_value_pairs` · `pem_private_key_block` |
| Platform access tokens | `github_pat` · `npm_token` · `huggingface_token` · `aws_access_key_id` · `slack_token` · `jwt_token` |
| Network & contact info | `private_ip_address` · `us_mobile_number` |

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

**IPv4 special case**: naive per-character replacement can't keep every octet within 0-255 (`172` could become `988`). When a real value is exactly a valid IPv4 address, each octet is generated independently within 0-255.

**Two trigger points:**

- **Literal rules**: the real value is known at config-load time, so the placeholder is generated **once** at session start (or config reload).
- **Regex rules**: the real value isn't known until a match occurs at runtime, so the placeholder is generated **lazily on first match** and reused for subsequent matches of the same value.

**Stability within a session**: the same real value always gets the same placeholder within a session. Hot reload, `/masking-reload`, and `/masking-toggle` never disturb existing mappings — only a brand-new session resets them. The regex-discovered mapping lives only in memory for the session and is never persisted to disk.

**Collision protection**: in rare cases (very short real values, limited character space) a generated placeholder may collide with one already in use. The extension keeps a "used" set seeded with every manual placeholder and every rule's real value, and automatically retries (up to 10 times) on collision — for both literal and regex-discovered placeholders — so each placeholder maps back to exactly one real value. If manually configured placeholders still clash (two rules sharing one placeholder, or a placeholder equal to another rule's real value), a warning is shown at load time.

**Manual override**: literal rules only. Set an explicit `placeholder` to skip auto-generation. Regex rules don't support manual placeholders — a single pattern can match many different real values, so a fixed placeholder wouldn't make sense.

**Connection strings**: if a literal rule's `real` is an entire known-scheme connection string (`postgresql://`, `mysql://`, ...), auto-generation keeps the scheme, port, and path, replacing only userinfo and host. The recommended approach is usually to split it into a domain rule for the host plus a regex + capture-group rule for credentials — see the `company_root_domain` + `db_conn_credentials` combination in `masking.config.example.json`.

---

## Regex fuzzy matching

Use this when a class of sensitive values has a fixed shape but unbounded specific values — internal IP addresses, phone numbers, arbitrary employee emails, tokens, etc. One rule covers the whole class instead of writing a literal rule per value.

```json
{ "id": "us_mobile_number", "type": "regex", "description": "US phone number", "pattern": "\\b(?:\\+?1[-. ]?)?\\(?[2-9]\\d{2}\\)?[-. ]?\\d{3}[-. ]?\\d{4}\\b" }
```

`pattern` is regex source with no delimiters (same as `new RegExp(pattern)`; backslashes need `\\` escaping in JSON).

### Capture groups: replace only what needs protecting

Wrap the part to replace in a capture group to keep the rest of the match as literal text:

```json
{ "id": "generic_bearer_token", "type": "regex", "description": "Generic Bearer token", "pattern": "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)", "flags": "i" }
```

Effect: `Authorization: Bearer abcDEF123456` → `Authorization: Bearer xyzGHI789012` — the prefix stays, only the token value is replaced, so the LLM can still recognize it as an auth header. Without a capture group, the whole match is replaced.

### Lookahead: keep adjacent rules from claiming each other's territory

A capture group only *replaces* the captured text, but the **whole match** is still registered as a claimed region. That's a problem when two rules sit right next to each other but each owns a different segment — e.g. masking an email's local part with one rule and its domain with another. If the local-part rule is written as `(local part)@domain`, the whole `local part@domain` gets claimed and the domain rule is skipped due to overlap.

The fix is a lookahead `(?=...)`, which only *checks* what follows without consuming it:

```json
{ "id": "employee_email_local_part", "type": "regex", "description": "Company email local part", "pattern": "[A-Za-z0-9._%+-]+(?=@company-internal\\.com)" }
```

This only matches the local part before `@company-internal.com`; the domain isn't part of the match, so it doesn't conflict with a separate `company_root_domain` rule — the two rules can be in either order with identical results.

### Greedy match to the "last occurrence": prefer `[^\s]+` over `.+`

Some patterns need to match up to the *last* occurrence of a delimiter — e.g. in `scheme://user:pass@host`, the password itself might contain `@`, so you need greedy backtracking to find the real separator:

```json
{ "id": "db_conn_credentials", "type": "regex", "description": "Username:password in a DB connection string", "pattern": "(?:postgresql|mysql|mariadb|redis|mongodb):\\/\\/([^\\s]+)@" }
```

`[^\s]+` (non-whitespace) is used instead of the broader `.+`: both backtrack to the last `@`, but `.+` can cross whitespace and newlines all the way to the *last `@` in the entire remaining text* — if an unrelated email appears later in the same message, `.+@` might swallow everything in between into the capture group. `[^\s]+` bounds the match to a single whitespace-free token.

### `flags`: each regex rule controls its own case sensitivity

If a regex rule provides `flags` (like `"flags": "i"` above), it fully controls case sensitivity etc., **independent of** the global `caseSensitive` option. If omitted, it falls back to the global `caseSensitive` setting. `g` and `d` are always appended internally — no need to add them manually.

### Priority when mixing literal and regex rules

Literal and regex rules share the same "list order = priority" mechanism: rules are tried top to bottom, and once a region is claimed by an earlier rule, later rules skip it. This means:

- If a broader rule should coexist with a more specific manual-placeholder rule for one particular value, **put the more specific rule first** so the broad rule doesn't claim it first.
- Among regex rules, more specific (narrower) patterns should come before broader ones.
- If two rules' matches are meant to sit adjacent but never overlap (e.g. email local part vs. domain), prefer a lookahead to fully isolate them — then rule order stops mattering.

### How `/masking-list` displays regex rules

Regex rules have no fixed placeholder to show (real values are only known at runtime), so `/masking-list` shows the pattern itself:

```
[regex] /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/  ——  Any IPv4 address
```

## Data flow

```
User input ──────────────────────────────► conversation (real values)
                                              │
                               [context] deep mask (in-memory copy)
                               [before_agent_start] masks the system prompt
                               [before_provider_request] final safety net
                               (catches content injected after context)
                                              ▼
                                   LLM (sees only placeholders)
                                              │
              ┌───────────────────────────────┤
              │                               │
       Text response                    Tool call (args with placeholders)
              │                               │
 [message_end] unmask            [tool_call] unmask args in place
              │                               │
              ▼                               ▼
 conversation (real values)          tool runs with real arguments
 user sees real values                       │
 stats panel shown                          ▼
                              external API response (real values)
                                              │
                                              ▼
                      stored in conversation (real); user sees it
                      next [context] masks it again for the LLM
```

---

## Security boundaries

Beyond the `context` hook, masking is enforced at two more outbound boundaries by default (no config needed):

- **System prompt** (`before_agent_start`): the fully assembled system prompt is masked before each turn. If a rule fires there, a one-time-per-session warning is shown so you can tell whether a rule is accidentally matching instructions or tool schemas.
- **Provider request** (`before_provider_request`): the final request payload (`messages`, `system`, `prompt`) is deep-masked right before it is sent, as a safety net for content that was injected after `context` — for example by another extension. If anything is caught at this boundary, a warning is shown (at most once per turn); these fallback hits are not added to the stats panel to avoid double-counting. Re-masking is idempotent: values already replaced by an earlier masking pass (placeholders recorded in the session's mapping) are recognized and left untouched, so a provider-boundary pass over already-masked content is a no-op — only genuinely unmasked values intercept here.

The `context` hook remains the primary masking boundary; `before_provider_request` is a defense-in-depth fallback, not a replacement — inbound unmasking for display (`message_end`) and tool execution (`tool_call`) still happens on the normalized message flow.

---

## Stats panel

After each AI turn, a panel below the editor shows this round's masking stats, auto-hiding after 20 seconds:

```
🔒 Masked 7 value(s)  ·  14:23:01
  Production API domain   api.c***×2
  Any IPv4 address        10.4***×3  192.1***×2
```

A single rule (especially a regex one) can hit several distinct real values in one turn; the panel lists each one's preview and count separately (up to 4 distinct values, with a "+N more" note beyond that). It shows only which rule fired and a real-value preview — **never the placeholder**.

**What's counted**: only mask (outbound) events — user-sent messages and tool results sent back to the LLM. Each `context` event only counts newly added messages, avoiding double-counting history across turns. Use `/masking-history` to review the full session history (last 30 entries).

---

## Built-in commands

| Command | Description |
|---------|-------------|
| `/masking-status` | Show current on/off state and rule count |
| `/masking-list` | List all rules (literal rules show their current placeholder, regex rules show their pattern); real values never shown |
| `/masking-history` | View this session's masking history (last 30 entries) |
| `/masking-toggle` | Temporarily toggle on/off (doesn't touch the config file, resets on restart) |
| `/masking-reload` | Manually reload the config file (reuses the current session key and dynamic regex map, placeholders stay stable) |
| `/masking-clear` | Close the currently displayed panels (report, history, rule list, test) |
| `/masking-test <text>` | Preview how a text snippet looks after all masking rules are applied — shows the masked output (what the LLM actually sees) in a widget, without affecting session state |

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

## Limitations

- **Not a PII detector.** This extension only masks what you've explicitly written a rule for (literal value or regex pattern). Anything not covered by a rule is sent to the LLM as plain text.
- **Obfuscation, not encryption.** The character-level replacement makes a value *look* real to the LLM; it is not cryptographically secure. The actual secret never leaves the machine, which is the real security boundary.
- **Literal matching is substring-based.** A literal `real` value is matched wherever it appears as a substring, with no word-boundary check. This is intentional (one root-domain rule covers all subdomains) but means a short or generic `real` can match inside unrelated text. Prefer regex rules with `\b` boundaries for short or common patterns.
- **Session-scoped only.** Placeholder mappings live only in memory for the current session; a new session means new placeholders for the same real values, by design.
- **Session files store real values.** `context`-event masking happens in memory and is never written to the on-disk session file (`~/.pi/sessions/`); session files contain real values, so manage their file permissions accordingly.
- **No masking of binary or non-string data.** `maskValue`/`unmaskValue` recurse through strings inside objects/arrays; binary payloads, base64 blobs that aren't matched by a rule, or non-JSON tool outputs aren't masked.
- **Provider-boundary coverage depends on the runtime.** The `before_provider_request` safety net masks the final request payload, but it only runs for providers that emit that hook — a custom provider or raw API path that bypasses it won't be covered.
- **Already-masked text is never re-masked.** `mask()` treats a region as already masked only when it lies **entirely inside** placeholder text recorded earlier in the session (this is what makes the provider-boundary fallback idempotent). A genuinely new sensitive value that merely contains an old placeholder as a prefix or substring is still masked in full — it is never allowed to hide inside an already-masked span. The converse edge exists: a new value that happens to be byte-identical to an existing placeholder is left as-is; placeholders are randomized per session and per value, so this collision is vanishingly rare. Likewise, when a broad shape rule claims a token that is adjacent to an already-masked placeholder (e.g. real text glued to a masked domain), the whole token is masked rather than only the new part — leak-safe, though the adjacent placeholder's own mapping is then absorbed into the new one.
- **Deep-copy cost on large payloads.** `maskValue`/`unmaskValue` rebuild objects/arrays while recursing, so very large tool outputs or messages are copied and scanned on each boundary crossing.

---

## Testing rules with /masking-test

To verify that a rule works without sending anything to the LLM:

```
/masking-test <text to preview>
```

The command applies all current masking rules to the text and shows what the LLM would receive:

```
🧪 Masking test  ·  21:09:00
─── Original
  My email is user@company-internal.com and my key is sk-prod-abc123456789
─── After masking (what LLM sees)  🔒 2 value(s) masked
  My email is user@northstar-systems.com and my key is sk-nqpz-mwx847312654
```

Behaviour notes:

- It runs on a **temporary isolated `Masker`** — session placeholder mappings are never modified.
- It **uses the current session key**, so output matches what a real conversation turn would produce (already-known regex values reuse their existing placeholders).
- It requires masking to be enabled; otherwise it asks you to re-enable first.

This is the recommended way to validate new rules before deploying a config change — no need to start a full conversation.

---

## File overview

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point: registers the `context` / `message_end` / `tool_call` / `before_agent_start` / `before_provider_request` hooks, session lifecycle, stats panel, and all `/masking-*` commands |
| `masker.ts` | Core masking engine — the `Masker` class, rule compilation, span-based mask/unmask, collision tracking for regex-discovered placeholders |
| `placeholder-gen.ts` | Format-preserving placeholder generation (HMAC-derived byte stream, connection-string and IPv4 special cases) |
| `config-loader.ts` | Loads, validates, and merges global + project config; fills auto placeholders; watches config paths for hot reload |
| `details.ts` | Shared per-rule/per-value stats accumulation used by the engine and the entry point |
| `tests/` | Unit tests (`node:test`) covering the masking engine, placeholder generation, and config loading |
| `masking.config.example.json` | Ready-to-use starter config (16 rules) covering company identifiers, credentials, platform tokens, and network/contact info; edit before use |

---

## Development

```bash
npm install
npm run check   # type-check everything (including tests)
npm test        # run the unit test suite (node:test)
```

CI (GitHub Actions, `.github/workflows/ci.yml`) runs `npm ci` + `npm run check` + `npm test` on every push and pull request.
