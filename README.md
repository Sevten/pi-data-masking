# pi-data-masking

**Protect sensitive values from the LLM provider without degrading agent reasoning, tool calls, or prompt-cache reuse.**

Real values stay in the local Pi conversation. The model receives stable, realistic-looking placeholders; tools receive the real values again immediately before execution.

```text
user/tool data → mask → LLM → restore tool arguments → tool uses real data
                              tool result → mask → next LLM request
```

## Design principles

Masking is useful only if the agent can continue working normally. The extension is therefore designed around three requirements: preserve reasoning quality, keep tool execution transparent, and keep the model-facing conversation stable for prefix caching.

### Plausible values, not redaction markers

An obvious marker such as `[REDACTED]` tells the model that data is missing. That can change its reasoning, make it ask for the value again, or make it refuse a tool call.

Automatic placeholders instead preserve character classes and separators: letters remain letters, digits remain digits, and URL/token structure remains usable. Rules can preserve safe prefixes or IP octets, and literal rules may specify a deliberately realistic replacement.

```text
sk-prod-abc123456789  → sk-nqpz-mwx847312654  (with keepPrefix)
172.16.254.1          → 233.84.19.207
db.prod.internal      → db-primary.prod.corpnet.internal
```

The placeholder keeps the value operationally believable, not semantically equivalent. This is why rules should target high-entropy secrets rather than values whose meaning depends on their exact characters.

### Stable model context

The same real value maps to the same placeholder throughout a conversation. Reopening a persisted Pi conversation restores its session key and confirmed model-facing snapshots, keeping earlier prefixes stable and preserving the opportunity for provider prompt-cache hits. A new conversation uses a new key.

### Transparent tool execution

The model plans tool calls using placeholders. Immediately before a tool runs, matching placeholders in its arguments are restored to their real values. Tool results remain real in the local conversation; protected values are masked again before the next model request.

The model must pass placeholders verbatim. Arithmetic, slicing, concatenation, or hashing performed on placeholder characters cannot be reversed.

### Inspectable model view

`/masking-history` makes the otherwise invisible boundary auditable. It highlights replacements and switches among the local original, the exact model-facing representation, and a comparison view. Wide terminals show the comparison side by side; narrow terminals stack both versions.

## Project-specific trade-off: immutable first-seen

This extension deliberately makes provenance immutable to protect reasoning consistency and cache prefixes. The first matching occurrence fixes one state for the entire conversation:

- First seen in user, system, or tool-result data: `protected`. It is masked consistently, including later assistant echoes.
- First seen in model output: `model-known`. Later occurrences from the user or tools remain unmasked.

If the model saw a value first, protecting it later would rewrite text the model had already seen. pi-data-masking therefore preserves the established model view and accepts that a later secret with the same string will not be protected. This loss of coverage is a conscious project policy, not an unavoidable property of every masking implementation.

First-seen does not create the identical-string ambiguity described below; it provides a deterministic choice once that ambiguity occurs. With high-entropy secrets, the model independently generating the exact same value is extremely unlikely.

## Inherent limitations of masking

> Do not mask a value whose exact characters or meaning the model must analyze. A realistic placeholder is an operational substitute, not a semantic equivalent, and the model can confidently reason from it incorrectly.

These limitations follow from replacing a value and apply to masking systems generally:

- **Hidden characters cannot be analyzed.** Password-strength judgments, numeric comparisons, parsing, encoding, and logic based on actual characters can be confidently wrong because the model sees the replacement.
- **Derived values cannot be restored.** Arithmetic, slicing, concatenation, hashing, checksums, and signatures operate on placeholder characters rather than the real value.
- **One string cannot carry two semantic identities.** A global matcher cannot know whether `123456` is a password, an ordinary example, or test data when the text is identical.

The last limitation is especially dangerous for low-entropy and common values. If `123456` is protected first and the model later independently writes an ordinary `123456`, matching occurrences are still treated as protected. If the model used `123456` first, immutable first-seen leaves a later password with that value unprotected. No global string-replacement scheme can reliably satisfy both meanings.

Use pi-data-masking for high-entropy, opaque operational values—API keys, access tokens, private hostnames, and connection credentials—that the model should pass through to tools rather than inspect or independently reproduce.

## Mitigations, not guarantees

| Measure | What it helps | What it cannot guarantee |
|---|---|---|
| Format-preserving or custom realistic placeholders | Normal reasoning flow and tool-call willingness | The real value's meaning |
| Stable HMAC mapping and persisted snapshots | Context consistency and cache-prefix reuse | Correct reasoning about hidden characters |
| `keepPrefix` / `keepIPv4Octets` | Selected prefix or network assertions | Unpreserved structure or semantics |
| High-entropy values and narrow contextual rules | Accidental matches and same-string ambiguity | Perfect semantic identity |
| `systemPromptGuidance` | Discouraging placeholder transformation | Model compliance |
| `/masking-history` comparison | Detecting unexpected model views and semantic drift | Preventing the problem automatically |

## Quick start

```bash
pi install npm:@sevten/pi-data-masking
```

Restart Pi and open `/masking`. Select `＋ Add new rule`, choose project or global scope, and test the rule in the same screen before saving.

| Scope | Configuration path |
|---|---|
| Project | `<project>/.pi/pi-data-masking/masking.config.json` |
| Global | `~/.pi/agent/pi-data-masking/masking.config.json` |

When the first project rule is saved, Pi can add the configuration path to `.gitignore`. Configuration files use strict JSON and reload automatically.

For manual configuration:

```json
{
  "$schema": "https://raw.githubusercontent.com/sevten/pi-data-masking/main/masking.config.schema.json",
  "version": 1,
  "enabled": true,
  "rules": [
    {
      "id": "production-api-key",
      "name": "Production API key",
      "realFromEnv": "PROD_API_KEY"
    },
    {
      "id": "github-personal-access-token",
      "name": "GitHub personal access token",
      "preset": "github-pat"
    }
  ]
}
```

Environment-backed values must be present in the process that starts Pi:

```bash
export PROD_API_KEY='sk-prod-example'
pi
```

Enter only the variable name in `realFromEnv`, without `$`. A missing or empty variable leaves the rule in `WAIT` state.

## Rules

| Rule source | Configuration | Best use |
|---|---|---|
| Exact literal | `real` | One known value |
| Environment literal | `realFromEnv` | One known value that should not be stored in JSON |
| Custom regex | `type: "regex"`, `pattern` | A narrowly defined class of values |
| Built-in preset | `preset` | Common tokens, credentials, private keys, connection strings, or private IPs |

Every rule has a unique `id` within its file. `name` is the user-facing label; `enabled` defaults to `true`. Literal rules may use a fixed `placeholder` or automatic generation. Regex matches always receive generated placeholders because one pattern can discover many distinct values.

Custom patterns use standard JavaScript `RegExp` syntax. Store the pattern source without `/.../` and escape backslashes for JSON, for example `"\\btoken_[A-Za-z0-9]{24}\\b"`. Standard flags such as `i`, `m`, and `s` are supported; global scanning and match indices are added internally. If capture groups exist, only the captured parts are masked. Earlier rules take priority over overlapping later rules.

The packaged [`masking.config.example.json`](masking.config.example.json) contains exact, environment, custom-regex, and preset examples. [`masking.config.schema.json`](masking.config.schema.json) is the complete field reference and enables editor validation.

## Commands

| Command | Purpose |
|---|---|
| `/masking` | Manage, order, enable, edit, and locally test project/global rules |
| `/masking-toggle` | Persistently enable or disable masking |
| `/masking-history` | Audit highlighted local/model views and side-by-side comparison |

In `/masking`, `Space` toggles a rule immediately, `Enter` edits or adds, `Ctrl+↑/↓` changes priority, `D`/`Delete` removes, `Tab` focuses local testing, and `R` reveals the selected literal value. The screen lists the remaining filter, search, batch, help, import, and redacted-export shortcuts.

The test areas are local: sample text does not enter model context, session history, configuration, or live placeholder mappings.

## Scope, persistence, and recovery

When both configuration files exist, project rules run before global rules; project option fields override global fields. A saved `/masking-toggle` state overrides both files.

Config writes are atomic and use user-only permissions where POSIX modes are available. Multi-file operations roll back on failure. If a watched file is temporarily invalid or unreadable, the last successfully parsed configuration remains active; deleting the file intentionally removes that scope.

`persistHistory` defaults to `true`. It stores the session key and model-facing text differences in Pi custom session metadata so placeholders and `/masking-history` survive a restart. It does not duplicate original secrets, although Pi's normal session file already contains the real conversation.

Other options are `caseSensitive`, `showStatusBar`, and `systemPromptGuidance`; see the JSON Schema for their defaults and descriptions.

## Implementation and security boundaries

- This is rule-based masking, not encryption or automatic PII detection. Only configured string matches are protected.
- Pi session files contain the real conversation under `~/.pi/agent/sessions/`; protect their permissions and backups.
- Binary and other non-string data is not scanned. The final provider-request safety pass also depends on provider support for that Pi hook.
- PINs, weak passwords, ordinary words, and other low-entropy values are unsuitable; see [Inherent limitations of masking](#inherent-limitations-of-masking).
- Literal matching includes substring occurrences. Prefer exact high-entropy values; use narrow regex rules for value classes and test positive and negative samples.
- A custom placeholder must be unique and must not equal another real value. Generated placeholders include collision checks.
- Content injected only at the final provider boundary can be protected without corresponding to a stored message that `/masking-history` can replay.

## Development

```bash
npm install
npm run check
npm test
npm run pack:dry
```

See [`CHANGELOG.md`](CHANGELOG.md) for release history and [`CONFIGURATION_REQUIREMENTS.md`](CONFIGURATION_REQUIREMENTS.md) for the detailed product requirements.
