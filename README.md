# pi-data-masking

A Pi extension that replaces configured sensitive values before they reach the LLM, restores them at the tool-execution boundary, and masks matching tool results before they return to model context.

The main conversation and tools use real values. The model receives stable, format-preserving placeholders.

```text
user/tool data → mask → LLM → unmask tool arguments → tool runs on real data
                              tool result → mask → next LLM request
```

## Security scope

This extension is rule-based masking, not a PII detector or encryption.

- Only strings matched by configured literal or regex rules are protected.
- Pi session files contain the real conversation by default under `~/.pi/agent/sessions/`; protect their file permissions.
- Binary and non-string data is not scanned.
- The final `before_provider_request` safety net depends on provider support for that hook.
- Format-preserving placeholders retain shape, not meaning. Do not mask short/common values such as PINs, weak passwords, or ordinary words.

See [Limitations and rule design](#limitations-and-rule-design) before relying on the extension for sensitive workloads.

## Install

```bash
pi install npm:@sevten/pi-data-masking
```

Then choose where the initial configuration should apply.

For a global configuration shared by all projects:

```bash
mkdir -p ~/.pi/agent/pi-data-masking
cp ~/.pi/agent/npm/node_modules/@sevten/pi-data-masking/masking.config.example.json \
  ~/.pi/agent/pi-data-masking/masking.config.json
```

Or, for a configuration limited to the current project:

```bash
mkdir -p .pi/pi-data-masking
cp ~/.pi/agent/npm/node_modules/@sevten/pi-data-masking/masking.config.example.json \
  .pi/pi-data-masking/masking.config.json
```

Edit the chosen file and replace the example values with the real values you want to protect. Configuration changes are applied automatically without restarting Pi.

Both scopes may be used together: keep shared rules in the global file and add only project-specific rules or option overrides to the project file. Do not copy the complete global configuration into the project file, because both rule lists are merged.

## Quick configuration

```json
{
  "enabled": true,
  "options": {
    "caseSensitive": true,
    "showStatusBar": true,
    "systemPromptGuidance": false,
    "persistHistory": true
  },
  "rules": [
    {
      "id": "prod_api_key",
      "description": "Production API key",
      "real": "sk-prod-abc123456789",
      "preserveStructure": { "keepPrefix": true }
    },
    {
      "id": "github_pat",
      "type": "regex",
      "description": "GitHub personal access token",
      "pattern": "\\bghp_[A-Za-z0-9]{36}\\b"
    }
  ]
}
```

Rule types:

- A **literal rule** omits `type` or uses `"literal"`. Every fixed-string occurrence of `real` is replaced, including substring occurrences.
- A **regex rule** uses `"type": "regex"`. Each value matched by `pattern` receives a stable placeholder when first encountered.

The packaged `masking.config.example.json` contains a larger starter set for domains, connection credentials, bearer tokens, platform tokens, private keys, IP addresses, and phone numbers. Delete rules you do not need.

### Configuration paths and merging

| Path | Scope |
|---|---|
| `~/.pi/agent/pi-data-masking/masking.config.json` | All projects |
| `<project>/.pi/pi-data-masking/masking.config.json` | Current project |

When both files exist:

- project rules are evaluated first, followed by global rules;
- project option fields override matching global fields;
- project `enabled` wins when explicitly set;
- a saved `/masking-toggle` state overrides both files.

`/masking-toggle` stores its state in `~/.pi/agent/pi-data-masking/toggle-state.json`. Delete that file and restart Pi to return control to the config-file `enabled` value.

Invalid rules are skipped and reported instead of preventing the extension from loading.

## Commands

| Command | Description |
|---|---|
| `/masking-list` | Open a full-screen list of configured rules. Literal rules show placeholders; regex rules show patterns; real values are hidden |
| `/masking-history` | Open the full-screen local/model/comparison history viewer |
| `/masking-toggle` | Enable or disable masking persistently for future sessions and projects |
| `/masking-test <text>` | Preview rule transformation locally for 20 seconds without changing live session mappings |

When `showStatusBar` is enabled, the status bar shows whether masking is active. No automatic per-round panel is added to the main workspace; use `/masking-history` for auditing.

### History viewer controls

`/masking-history` replays the complete user, assistant, and tool conversation on the active Pi branch.

| Key | Action |
|---|---|
| `Ctrl+M` or `M` | Toggle local-original and model-input views |
| `C` | Toggle comparison view; wide terminals use columns and narrow terminals stack both versions |
| `N` / `P` | Select the next/previous replacement in the inspector |
| `Ctrl+O` | Expand or collapse tool outputs; collapsed output previews 10 lines |
| `Ctrl+T` | Show or hide thinking blocks |
| `↑` / `↓`, `PageUp` / `PageDown`, `Home` / `End` | Scroll |
| Mouse wheel | Scroll when Pi uses full-screen TUI mode |
| `Esc` | Close |

The local view highlights sensitive original spans without injecting brackets or parentheses into the conversation. The model view highlights replacements. The comparison view shows both.

The newest assistant response is provisional until it participates in the next model request; only confirmed outbound representations are persisted.

## Placeholder behavior

Auto placeholders are derived from `HMAC(sessionKey, real value)` and preserve common structure:

| Input property | Behavior |
|---|---|
| Uppercase/lowercase/digits | Replaced with the same character class |
| Separators such as `-`, `_`, `@`, `.`, `:` and `/` | Preserved |
| Valid IPv4 address | Each replaced octet remains within `0–255` |
| Known connection string | Scheme, port, and path are preserved; user info and host are replaced |

Examples:

```text
sk-prod-abc123456789  → sk-nqpz-mwx847312654
172.16.254.1          → 233.84.19.207
postgresql://admin:secret@db.company.com:5432/prod
                     → postgresql://bxkzp:qwerty@wn.xm7rqnj.rkt:5432/prod
```

The exact output is session-specific. With history persistence enabled, reopening the same Pi conversation restores its session key and placeholders. A new conversation receives a new key.

### Preserving asserted structure

Use `preserveStructure` when a conversation refers to a non-secret prefix or network segment:

```json
{
  "id": "prod_api_key",
  "real": "sk-prod-abc123456789",
  "preserveStructure": { "keepPrefix": true }
}
```

```json
{
  "id": "internal_ip",
  "type": "regex",
  "pattern": "\\b10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b",
  "preserveStructure": { "keepIPv4Octets": 2 }
}
```

- `keepPrefix: true` keeps the first segment through its separator, such as `sk-`. A number limits how many characters are retained.
- `keepIPv4Octets: 2` keeps two leading octets and randomizes the rest. At least one octet is always randomized.

Literal rules may set an explicit `placeholder`. Regex rules cannot because one pattern may discover many different real values.

## Regex guidelines

Use regex only for value classes you cannot enumerate. Prefer narrow patterns based on value structure, such as `ghp_`, `AKIA`, JWT, or PEM formats. Avoid broad “key name followed by anything” patterns; they tend to mask source code while missing real secrets.

### Replace only part of a match

When a pattern contains capture groups, only the captured values are replaced:

```json
{
  "id": "bearer_token",
  "type": "regex",
  "pattern": "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)",
  "flags": "i"
}
```

This keeps `Authorization: Bearer` readable to the model.

Use lookahead when adjacent rules must not claim each other's text:

```json
{
  "id": "employee_email_local_part",
  "type": "regex",
  "pattern": "[A-Za-z0-9._%+-]+(?=@company-internal\\.com)"
}
```

Rules run in list order and earlier matches claim overlapping regions. Put specific rules before broad rules. Regex `flags` override global `caseSensitive`; the extension adds global matching internally.

Test representative positive and negative examples with `/masking-test` before relying on a rule. This command uses an isolated `Masker`, so it previews rule behavior without importing or mutating live provenance and dynamic mappings.

## History persistence

`options.persistHistory` defaults to `true`. It stores Pi custom session entries containing:

- the 32-byte session key used for stable placeholders;
- changed string positions and masked replacements for confirmed model-input messages.

These custom entries do not enter LLM context and do not duplicate the original secret text. Pi already stores the real conversation in its session JSONL.

On restart, the extension restores the active branch only and rebuilds dynamic mappings and provenance locally. Sibling fork snapshots are not mixed together.

For sessions created before persistence existed, original messages remain viewable. A model-input representation is marked unavailable until that message crosses a new outbound boundary.

Setting `persistHistory` to `false` stops new metadata writes but does not delete existing entries. A new conversation created with persistence disabled cannot recover exact model-input history or guarantee identical placeholders after restart.

## Limitations and rule design

### First-seen is forever

The first source of a value determines how it is handled for the rest of the session:

- First seen in a user message or tool result: register and mask it in every role, including later assistant echoes.
- First seen in model output: treat it as model-invented and never mask it later, even if the user subsequently sends the same string.
- Tool results always register because they are real external data sources.

This keeps historical model context stable and avoids changing the representation of the model's own earlier output. The trade-off is that a value invented by the model before the user supplies the same value is not protected. This is negligible for high-entropy secrets but unsafe for short/common values.

### Practical rule checklist

1. Prefer literal rules when you know the exact value.
2. Do not mask low-entropy values such as short codes, weak passwords, or common words.
3. Constrain regex with structure, boundaries, lookaheads, or capture groups.
4. Preserve a prefix or IP subnet only when that structure is safe and important to model reasoning.
5. Pass placeholders verbatim to tools; arithmetic, slicing, concatenation, and hashing operate on fake characters and cannot be reversed.
6. Enable `systemPromptGuidance` if the model tends to transform placeholders or infer meaning from their appearance.

Other boundaries:

- A short literal may match inside unrelated text because literal matching is substring-based.
- A model output that accidentally equals a known placeholder can be restored to the corresponding real value; high-entropy placeholders make this unlikely.
- Very large message/tool payloads are recursively copied and scanned, which has a memory and CPU cost.
- Content injected only at the final provider boundary is protected and reported, but may not correspond to a stored message that `/masking-history` can replay.

## Configuration reference

### Top level

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Config-file masking state; overridden by saved `/masking-toggle` state |
| `rules` | array | `[]` | Ordered literal and regex rules |
| `options` | object | defaults below | Runtime behavior |

### Literal rule

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier |
| `description` | string | no | Label shown in `/masking-list` |
| `type` | `"literal"` | no | May be omitted |
| `real` | string | yes | Fixed string to replace |
| `placeholder` | string | no | Explicit replacement; omit or use `"auto"` to generate one |
| `preserveStructure` | object | no | `keepPrefix` and/or `keepIPv4Octets` |
| `lowEntropy` | boolean | no | Suppress the warning for an intentionally short value |

### Regex rule

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier |
| `description` | string | no | Label shown in `/masking-list` |
| `type` | `"regex"` | yes | Select regex matching |
| `pattern` | string | yes | JavaScript regex source without delimiters |
| `flags` | string | no | Override global case sensitivity; global matching is added internally |
| `preserveStructure` | object | no | `keepPrefix` and/or `keepIPv4Octets` |
| `lowEntropy` | boolean | no | Suppress the warning for an intentionally short match shape |

Regex rules do not support `real` or a fixed `placeholder`.

### Options

| Field | Type | Default | Description |
|---|---|---|---|
| `caseSensitive` | boolean | `true` | Literal matching and regex rules without their own flags |
| `showStatusBar` | boolean | `true` | Show masking state in Pi's status bar |
| `systemPromptGuidance` | boolean | `false` | Tell the model to treat placeholders as opaque values |
| `persistHistory` | boolean | `true` | Persist model-input differences and the session key in Pi session metadata |

## Development

```bash
npm install
npm run check
npm test
```

CI runs the type check and test suite on pushes and pull requests.

See [CHANGELOG.md](CHANGELOG.md) for the version history.
