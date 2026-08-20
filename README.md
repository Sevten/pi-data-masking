# pi-data-masking

**A Pi extension designed around agent tool use: it masks sensitive data before it reaches the LLM, restores real values only at the tool-execution boundary, and re-masks sensitive tool results before they return to LLM context.**

## How it works

Pi agent sessions routinely send and receive sensitive data — internal domains, database credentials, API keys, and so on. For values covered by configured rules, this extension keeps the real values local and sends format-preserving placeholders to the LLM, while the main conversation and tools operate on the real data.

- The **main conversation** shows real values; `/masking-history` can intentionally switch between the local and model-input views.
- The **LLM** sees placeholders that preserve the original format (letter→letter, digit→digit, separators kept) — keeping keys and URLs structurally plausible helps reduce avoidable tool-call refusals and replacement hunting.
- **Tool calls** carry placeholders while the LLM plans them; their arguments are unmasked back to real values immediately before execution.
- **Tool results** are re-masked before returning to LLM context: matching data from file reads, web fetches, and other tools stays real for you but is replaced before reaching the model.
- **Literal** and **regex** rules mix freely in one config; capture groups and lookaheads cover custom formats.

Round-trip: user message or tool result → masked before the request → LLM reasons and plans tool calls with placeholders → arguments unmasked at the tool boundary → tool runs on real values → result re-masked before the next request.

---

## Known limitations and pitfalls (read this first)

Masking protects the **outbound** path only: rule-matching values become placeholders before reaching the LLM and are restored again for you and for tool execution. It is **not** a PII detector and **not** encryption. Live testing (v0.3.0) surfaced the failure modes below; the full scenario catalog with worked examples lives in [`docs/pitfalls.md`](docs/pitfalls.md).

### Capability boundaries

- **Not a PII detector.** Only values covered by a configured literal or regex rule are protected.
- **Obfuscation, not encryption.** Placeholders make a value *look* real; the security boundary is that a rule-matched value is replaced before it leaves the machine.
- **No masking of binary or non-string data.** Binary payloads, base64 blobs that aren't matched by a rule, and non-JSON tool outputs aren't scanned.
- **Provider-boundary coverage depends on the runtime.** The `before_provider_request` safety net only runs for providers that emit that hook.
- **Session files store real values** (by default under `~/.pi/agent/sessions/`) — manage their file permissions accordingly. `persistHistory` metadata is stored in the same Pi session JSONL.

### Known failure modes

The normal conversation shows real values; the history viewer can display either representation for auditing. Failures fall into two classes: **model output quality** and **protection gaps** (a secret still reaches the model).

**Model output quality** — the model reasons on corrupted premises:

| Scenario | What goes wrong | What you can do |
|---|---|---|
| **Semantic claims about a masked value** — "`123456` is a weak password" | The claim becomes a false premise ("`834919` is a weak password") the model reasons on — confused or self-correcting output. | Do **not** mask low-entropy values — the loader warns for literals < 8 chars and patterns matching ≤ 6 chars. |
| **Structural claims about a masked value** — "the key starting with `sk-`" | The claim survives, but the masked value no longer starts with `sk-` — a visible contradiction. | Add `preserveStructure` (`keepPrefix`, `keepIPv4Octets`). Claims about body fragments ("the `mxr` part") have no solution: keep the fragment (leaks it) or break the claim. |
| **Over-masking by a key-name-driven regex** — matching "sensitive keyword = value" assignments | Code, comments, and filenames get masked too (template history: `keyword_value_pairs` and its scoped successor `env_secret_values` both hit `KEY = Buffer.from`, `// Key: 32 hex chars`, `reg_key = HKDF-SHA256(` — while missing `DJANGO_SECRET_KEY=...`). | Mask by **value structure** (prefixes like `ghp_`, `AKIA`, `eyJ`, PEM blocks) or by **exact literal** for values you know — the example config ships no key-name-driven rule. |
| **Coincidental restore** — the model's output happens to equal a known placeholder | The real value appears where the model never meant it; more likely with low-entropy (6-digit) placeholders. | Exclude low-entropy rules; cannot be eliminated completely. |
| **Transforming a placeholder** — arithmetic, concatenation, or hashing | Results are computed on fake characters and can never be unmasked. | Pass placeholders **verbatim** to tools; enable `systemPromptGuidance`. |
| **Judging by masked values** — AI work reasons about a placeholder as if it were the real value | AI-generated assertions/tests can be based on the placeholder's appearance (happened live in 0.3.0 testing), even though files written through the tool boundary are restored. | Review AI-generated logic; enable `options.systemPromptGuidance`; `keepPrefix` makes prefix-based reasoning reliable. |

**Protection gaps** — a secret still reaches the model:

| Scenario | What goes wrong | What you can do |
|---|---|---|
| **First-seen trade-off** — you later send a value the model invented earlier | It reaches the provider unmasked (first-seen is forever, literal rules included). | Negligible for high-entropy secrets; keep low-entropy values out of rules anyway. |
| **Values not covered by any rule** | Sent as plaintext — masking is rule-based, not PII detection. | Review your rules against the data you handle (see Capability boundaries). |
| **Provider without the safety-net hook / binary data** | `before_provider_request` doesn't run, or non-string payloads aren't scanned. | Use providers that emit the hook; keep secrets out of binary blobs (see Capability boundaries). |

### Rule design checklist

Following this avoids most of the failures above:

1. **Literal first — the default choice.** Know the exact value? Use a literal fixed-string rule. It replaces every substring occurrence, so choose a sufficiently specific value. Regex is only for value *classes* you can't enumerate (tokens, phone numbers, ...) — and those rules must be written narrowly (see 3).
2. **Never mask low-entropy values** — 4-digit codes, short passwords, common words (the loader warns; they cause contradictions and coincidental restores).
3. **Constrain regex**: word boundaries (`\b`), lookaheads (`(?=...)`), and capture groups that replace only the secret part — never an unconstrained `key = value` pattern.
4. **Preserve structure** where the conversation describes the value (`preserveStructure.keepPrefix` / `keepIPv4Octets`).
5. **Test every rule with `/masking-test`** before relying on it.
6. **Enable `options.systemPromptGuidance`** if your model transforms or reuses placeholders.

### Technical edges

- **Literal matching is substring-based.** One root-domain rule covers all subdomains, but a short `real` can match inside unrelated text — prefer regex rules with `\b` boundaries for short or common patterns.
- **Session-scoped, not process-scoped.** With `persistHistory: true`, the session key is stored as Pi session metadata and restored when the same conversation is reopened, so placeholders survive Pi restarts. A genuinely new conversation receives a new key and therefore new placeholders.
- **Already-masked text is never re-masked.** `mask()` treats a region as already masked only when it lies **entirely inside** placeholder text recorded earlier in the session (this keeps the provider-boundary fallback idempotent). A new sensitive value merely containing an old placeholder as prefix/substring is still masked in full; a value byte-identical to an existing placeholder is left as-is (vanishingly rare — placeholders are randomized per session and per value); a broad shape rule claiming a token adjacent to a masked placeholder absorbs the whole token — leak-safe either way.
- **Deep-copy cost on large payloads.** `maskValue`/`unmaskValue` rebuild objects/arrays while recursing, so very large tool outputs or messages are copied and scanned on each boundary crossing.

## Contents

1. [Known limitations and pitfalls (read this first)](#known-limitations-and-pitfalls-read-this-first)
2. [Install](#install)
3. [Config file](#config-file)
4. [Two-level config merge](#two-level-config-merge)
5. [Placeholder generation](#placeholder-generation)
6. [Regex fuzzy matching](#regex-fuzzy-matching)
7. [Provenance: first-seen is forever](#provenance-first-seen-is-forever)
8. [Data flow](#data-flow)
9. [Security boundaries](#security-boundaries)
10. [History viewer](#history-viewer)
11. [Built-in commands](#built-in-commands)
12. [Config field reference](#config-field-reference)
13. [Testing rules with /masking-test](#testing-rules-with-masking-test)
14. [File overview](#file-overview)
15. [Development](#development)

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

Config changes **hot-reload** automatically — no restart needed. Config files are validated on load: invalid rules (missing `id`/`real`/`pattern`, invalid regex, unknown `type`) are skipped with a warning notification instead of breaking the extension.

---

## Config file

| Path | Description |
|------|-------------|
| `~/.pi/agent/pi-data-masking/masking.config.json` | Global config, applies to all projects |
| `<project root>/.pi/pi-data-masking/masking.config.json` | Project-level config, applies only to that project |

The package template lives inside the installed npm package at `~/.pi/agent/npm/node_modules/@sevten/pi-data-masking/masking.config.example.json`. Treat that as read-only package content; put your edited config in one of the paths above.

`/masking-toggle` stores its user-level on/off choice separately in `~/.pi/agent/pi-data-masking/toggle-state.json`. This override applies to new sessions and all projects, while leaving rule files unchanged. To return to the `enabled` value from the config files, delete that state file and restart Pi.

Each rule has an optional `type` field:

| `type` | Meaning |
|--------|---------|
| omitted or `"literal"` | Literal fixed-string matching: every occurrence of `real` is replaced, including substring occurrences |
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

Regex rules replace `real` with a `pattern` (see [Regex fuzzy matching](#regex-fuzzy-matching)); literal and regex rules mix freely — `masking.config.example.json` contains the full example.

### What the example config covers

The template ships with a ready-to-use starter set (15 rules) — each rule's `description` explains its purpose; **delete any rules you don't need** and replace the example values with your real ones:

| Category | Rules |
|----------|-------|
| Company identifiers | `company_root_domain` · `prod_api_key` · `employee_email_local_part` |
| Credentials & secrets | `db_conn_credentials` · `url_userinfo_credentials` · `generic_bearer_token` · `pem_private_key_block` |
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
| config-file `enabled` | project value wins if explicitly set, otherwise falls back to global |
| effective enabled state | a saved `/masking-toggle` value overrides both config files until `toggle-state.json` is removed |

Example: global `rules = [A, B, C]`, project `rules = [X, Y]` → merged `[X, Y, A, B, C]`.

---

## Placeholder generation

**Core algorithm (shared by literal and regex rules)**: derive a deterministic byte stream from HMAC(sessionKey, real value), then do **format-preserving replacement**. Generic values retain character classes and separators; IPv4 addresses and recognized connection strings use specialized structural handling.

| Character type | Replacement |
|-----------------|-------------|
| Uppercase | → random uppercase |
| Lowercase | → random lowercase |
| Digit | → random digit |
| Other (`-` `_` `@` `.` `:` `/` etc.) | → kept as-is |

**Examples:**

```
real:        sk-prod-abc123456789
placeholder: sk-nqpz-mwx847312654   ← sk- kept by keepPrefix; remaining shape preserved

real:        api.company-internal.com
placeholder: kpz.xm7rqn-bfwtpj.rkt  ← dot layout and segment lengths preserved; TLD text is replaced

real:        postgresql://admin:MyS3cr3tP@ssw0rd@db.company.com:5432/prod
placeholder: postgresql://bxkzp:NqW8vxLm@kpRwqn@wn.xm7rqnj.rkt:5432/prod
             ↑ scheme/port/path kept; userinfo and the entire host replaced

real:        172.16.254.1
placeholder: 233.84.19.207          ← each octet independently valid (0-255)
```

**IPv4 special case**: naive per-character replacement can't keep every octet within 0-255 (`172` could become `988`). When a real value is exactly a valid IPv4 address, each octet is generated independently within 0-255.

**Structure preservation (`preserveStructure`)**: masking changes a value's properties, so claims about them ("starts with `sk-`", "on the `192.168.` subnet") become false in the LLM's view. A rule can keep the least sensitive, most-asserted parts — category markers / scaffolding, never the secret entropy:

```json
{ "id": "prod_api_key", "real": "sk-prod-abc123456789", "preserveStructure": { "keepPrefix": true } }
{ "id": "internal_ip", "type": "regex", "pattern": "\\b(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})\\b", "preserveStructure": { "keepIPv4Octets": 2 } }
```

- `keepPrefix: true` keeps the first segment up to the first separator (`sk-prod-abc123456789` → `sk-` + randomized body); a number caps how many characters of that segment are kept. Single-segment values fall back to full randomization so the placeholder never equals the real value.
- `keepIPv4Octets: 2` keeps the leading octets of an exact IPv4 value (`192.168.10.7` → e.g. `192.168.83.214`), recommended for private ranges where the network prefix is not the secret. At least one octet is always randomized.
- Connection strings keep their scheme, port, and path. Generic domains keep separators and segment lengths but replace the TLD text; use a manual literal placeholder when a particular replacement domain/TLD matters.

**Two trigger points:**

- **Literal rules**: the real value is known at config-load time, so the placeholder is generated **once** at session start (and refreshed automatically after a config change).
- **Regex rules**: the real value isn't known until a match occurs at runtime, so the placeholder is generated **lazily on first match** and reused for subsequent matches of the same value.

**Stability within a session**: the same real value always gets the same placeholder within a session. Automatic config refreshes and `/masking-toggle` reuse the current key and dynamic map. With `persistHistory: true`, reopening that Pi conversation restores its key and rebuilds dynamic mappings and first-seen provenance by replaying the active branch locally. A brand-new conversation starts with a new key. With persistence disabled, restarting Pi cannot guarantee the previous placeholders.

**Collision protection**: in rare cases (very short real values, limited character space) a generated placeholder may collide with one already in use. A "used" set (seeded with every manual placeholder and rule real value) makes the generator retry up to 10 times on collision, for literal and regex placeholders alike — each placeholder maps back to exactly one real value. Manual placeholders that still clash (two rules sharing one, or a placeholder equal to another rule's real value) trigger a load-time warning.

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

A capture group only *replaces* the captured text, but the **whole match** is registered as a claimed region — so a local-part rule written as `(local part)@domain` claims the whole `local part@domain` and blocks a separate domain rule.

The fix is a lookahead `(?=...)`, which only *checks* what follows without consuming it:

```json
{ "id": "employee_email_local_part", "type": "regex", "description": "Company email local part", "pattern": "[A-Za-z0-9._%+-]+(?=@company-internal\\.com)" }
```

This matches only the local part before `@company-internal.com`; the domain isn't consumed, so the two rules don't conflict regardless of order.

### Greedy match to the "last occurrence": prefer `[^\s]+` over `.+`

Some patterns need to match up to the *last* occurrence of a delimiter — e.g. in `scheme://user:pass@host`, the password itself might contain `@`, so you need greedy backtracking to find the real separator:

```json
{ "id": "db_conn_credentials", "type": "regex", "description": "Username:password in a DB connection string", "pattern": "(?:postgresql|mysql|mariadb|redis|mongodb):\\/\\/([^\\s]+)@" }
```

`[^\s]+` bounds the match to a single whitespace-free token; the broader `.+` would cross whitespace and newlines to the *last* `@` in the remaining text, swallowing unrelated content (e.g. a later email address) into the capture group.

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
 user sees real values                     ▼
                              external API response (real values)
                                              │
                                              ▼
                      stored in conversation (real); user sees it
                      next [context] masks it again for the LLM
```

When history persistence is enabled, the `context` hook also records only the changed string positions and masked replacements as a non-LLM custom session entry. On `session_start`, the extension restores the active branch, reuses its saved session key, and rebuilds dynamic/provenance state locally before handling another request.

---

## Provenance: first-seen is forever

Masking decisions are made per value, based on where the value **first appeared** in the session:

- **User messages and tool results** are the only sources that register values for masking. Once registered, a value is masked in every message role — including assistant history — so a restored echo of your secret never leaks back into LLM context.
- A value that **first appears in LLM output** is treated as *LLM-invented*: it is never masked for the whole session, even if you later send the same string. The LLM already knows the value (it generated it), and masking it would change the representation of its own messages mid-session — breaking the consistency of its reasoning and the provider's prefix cache.
- **Tool results** always register, regardless of what the LLM happened to say earlier: real data from files/APIs is a legitimate secret source even if the same string coincidentally appeared in the model's output first.

Consequences to be aware of:

- **Placeholders are deterministic** (`HMAC(sessionKey, real)`), so the same real value always maps to the same placeholder — user view and LLM view stay internally consistent, and round-trips (user asks → masked → LLM answers → unmasked) restore correctly.
- **Audit from the history viewer.** `/masking-history` highlights protected user/tool-side values and restored assistant echoes without adding an automatic panel to the main workspace.
- **Accepted trade-off**: if the LLM happens to output the exact string you later send, your message reaches the provider unmasked — negligible for high-entropy secrets; low-entropy values shouldn't be masked at all (see below).

### Rule design: mask only high-entropy, semantically transparent values

Masking short/common values causes more problems than it solves:

- **Semantic contradictions**: format-preserving placeholders keep the shape but not the meaning — `"123456 is a weak password"` becomes `"834919 is a weak password"`, a false premise the model then reasons on.
- **Coincidental restores**: short placeholders (e.g. 6-digit numbers) are likely to be hit accidentally by ordinary LLM output, restoring the secret into unrelated text.
- Low-entropy values are guessable anyway, so the marginal security gain of masking them is near zero.

The actionable checklist lives in [Known limitations and pitfalls](#rule-design-checklist).

---

## Security boundaries

Beyond the `context` hook, masking is enforced at two more outbound boundaries by default (no config needed):

- **System prompt** (`before_agent_start`): the fully assembled system prompt is masked before each agent run. A rule firing here shows a one-time-per-session warning (a rule is probably matching instructions or tool schemas).
- **Provider request** (`before_provider_request`): the final request payload (`messages`, `system`, `prompt`) is deep-masked right before sending — a safety net for content injected after `context` (e.g. by another extension). Hits show a warning at most once per turn. Re-masking is idempotent, so already-masked content passes through untouched.

The `context` hook remains the primary boundary; `before_provider_request` is a defense-in-depth fallback, not a replacement — inbound unmasking for display (`message_end`) and tool execution (`tool_call`) still happens on the normalized message flow.

---

## History viewer

### Full-screen history replay

`/masking-history` replays the complete user/assistant/tool conversation on the active Pi branch. It starts in the local-original view: the original message remains structurally unchanged, while changed spans are highlighted instead of being annotated with parentheses or brackets.

| Key | Action |
|-----|--------|
| `Ctrl+M` or `M` | Toggle between the local-original and model-input views |
| `C` | Toggle comparison view; wide terminals use two columns, narrow terminals stack the versions |
| `N` / `P` | Move through replacement mappings shown in the bottom inspector |
| `Ctrl+O` | Expand/collapse all tool outputs (collapsed output previews the first 10 lines) |
| `Ctrl+T` | Show/hide all thinking blocks |
| `↑` / `↓`, `PageUp` / `PageDown`, `Home` / `End` | Scroll |
| Mouse wheel | Scroll when Pi is running in full-screen TUI mode |
| `Esc` | Close the viewer |

The newest assistant response is shown immediately but remains provisional until it is included in a subsequent model request. Only confirmed outbound snapshots are persisted. The replay represents normalized messages captured by the `context` hook; content injected only at `before_provider_request` is still masked by the safety net and reported as a warning, but it may not correspond to a stored conversation message that can be replayed.

### History persistence

With `options.persistHistory` enabled (the default), the extension writes two kinds of Pi custom session entries:

- one 32-byte session key, used to keep generated placeholders stable when the same conversation is reopened;
- versioned masked-text position deltas for messages confirmed at the outbound context boundary.

These custom entries do not participate in LLM context. They store hashes, positions, and masked replacements rather than another copy of the original secret text; Pi already stores the real conversation in its session JSONL. Snapshot batches are signature-deduplicated, and only a changed representation is appended. On restore, the extension reads the active branch only, so sibling fork snapshots are not mixed together.

Sessions created before this feature can still be opened immediately: their original messages are loaded from Pi, while messages without a verifiable historical model-input snapshot are explicitly marked unavailable. After a message crosses a new outbound boundary, its current representation becomes available and is persisted.

Setting `persistHistory` to `false` stops writing new session keys and snapshots; it does not delete metadata already present in an existing Pi session, and previously stored records can still be read. A new conversation created with persistence disabled has process-local replay only, so a later restart cannot recover its exact model-input representations or guarantee the previous placeholders.

---

## Built-in commands

| Command | Description |
|---------|-------------|
| `/masking-list` | Browse all rules in a full-screen, scrollable panel (↑↓ to navigate, Esc to close). Literal rules show their current placeholder, regex rules show their pattern; real values never shown |
| `/masking-history` | Open the full-screen local/model/comparison replay for the active session branch; see [Full-screen history replay](#full-screen-history-replay) |
| `/masking-toggle` | Toggle on/off persistently for future sessions and projects; rules in config files are not changed |
| `/masking-test <text>` | Preview rule transformation in an isolated widget for 20 seconds, without changing session mappings or provenance |

Earlier releases exposed `/masking-status`, `/masking-clear`, and an automatic per-round statistics panel. They are intentionally no longer present: the status bar shows whether masking is enabled, `/masking-history` provides detailed auditing, full-screen views close with `Esc`, and `/masking-test` disappears automatically.

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
| `preserveStructure` | object | — | `{ "keepPrefix": true \| number, "keepIPv4Octets": number }` — keep structural properties in the placeholder (see [Placeholder generation](#placeholder-generation)) |
| `lowEntropy` | boolean | — | Silence the config-loader warning for values < 8 chars (literal) / patterns matching ≤ 6 chars (regex) if you still want to mask them |

**Regex rule fields (`type: "regex"`):**

| Field | Type | Required | Description |
|-------|------|----------|--------------|
| `id` | string | ✅ | Unique rule id |
| `description` | string | — | Describes what this rule protects |
| `type` | `"regex"` | ✅ | Must be explicitly `"regex"` |
| `pattern` | string | ✅ | Regex source (no delimiters); a match is treated as sensitive. With capture groups, only the captured part is replaced |
| `flags` | string | — | Optional; omit to follow global `caseSensitive`, set to take full control (overrides global). No need to include the global-match flag manually |
| `preserveStructure` | object | — | Same as literal rules; applied to lazily generated placeholders |
| `lowEntropy` | boolean | — | Same as literal rules |

> Regex rules don't support `real` / `placeholder` — the real value is only known at runtime, so the placeholder can only be generated then too.

**`options` fields:**

| Field | Type | Default | Description |
|-------|------|---------|--------------|
| `caseSensitive` | boolean | `true` | Case sensitivity for literal matching and for regex rules without their own `flags` |
| `showStatusBar` | boolean | `true` | Whether to keep showing masking status in the bottom status bar |
| `systemPromptGuidance` | boolean | `false` | Append a paragraph to the system prompt telling the LLM masked values are opaque placeholders — reduces confusion from structural claims about masked values (see [Provenance](#provenance-first-seen-is-forever)) |
| `persistHistory` | boolean | `true` | Write masked-text differences and the session key as non-LLM Pi session metadata, allowing `/masking-history` and stable placeholders to survive restart. Turning it off stops new writes but does not delete existing metadata |

---

## Testing rules with /masking-test

To verify that a rule works without sending anything to the LLM:

```
/masking-test <text to preview>
```

The command applies all current masking rules to the text in an isolated preview and shows the resulting transformation:

```
🧪 Masking test  ·  21:09:00
─── Original
  My email is user@company-internal.com and my key is sk-prod-abc123456789
─── After masking (what LLM sees)  🔒 2 value(s) masked
  My email is user@northstar-systems.com and my key is sk-nqpz-mwx847312654
```

Behaviour notes:

- Runs on a **temporary isolated `Masker`** with the current session key. It does not mutate the live dynamic map or provenance sets.
- It is a rule preview, not an audit of the next provider request: first-seen provenance and mappings already discovered in the live conversation are intentionally not imported into the temporary masker.
- Requires masking to be enabled. The widget closes automatically after 20 seconds.

This is the recommended way to validate new rules before deploying a config change — no need to start a full conversation.

---

## File overview

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point: registers the `context` / `message_end` / `tool_call` / `before_agent_start` / `before_provider_request` hooks, session lifecycle, status bar, and all `/masking-*` commands |
| `masker.ts` | Core masking engine — the `Masker` class, rule compilation, span-based mask/unmask, collision tracking for regex-discovered placeholders |
| `placeholder-gen.ts` | Format-preserving placeholder generation (HMAC-derived byte stream, connection-string and IPv4 special cases) |
| `config-loader.ts` | Loads, validates, and merges global + project config; fills auto placeholders; watches config paths for hot reload |
| `history-viewer.ts` | Full-screen original/model/comparison replay with scrolling, tool expansion, thinking visibility, and replacement inspection |
| `history-persistence.ts` | Persists the per-session key and masked-text deltas in Pi custom entries, then restores the active session branch |
| `details.ts` | Shared per-rule/per-value match-detail accumulation used by the masking engine |
| `tests/` | Unit tests (`node:test`) covering masking, placeholder generation, configuration, history rendering, and persistence |
| `masking.config.example.json` | Ready-to-use starter config (15 rules) covering company identifiers, credentials, platform tokens, and network/contact info; edit before use |

---

## Development

```bash
npm install
npm run check   # type-check everything (including tests)
npm test        # run the unit test suite (node:test)
```

CI (GitHub Actions, `.github/workflows/ci.yml`) runs `npm ci` + `npm run check` + `npm test` on every push and pull request.
