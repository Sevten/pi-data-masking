# pi-data-masking

pi-data-masking is a Pi agent extension that replaces configured values—secrets or anything else you don't want the model to see—with stable, realistic-looking placeholders before a request reaches the model. The real values remain in Pi's local conversation and are restored only when a tool needs them.

Use pi-data-masking to keep any configured content out of the LLM provider's view in Pi: API keys, access tokens, private hostnames, connection credentials, internal URLs, customer data, proprietary code snippets, or simply text you prefer the model never reads. It works best when the model only needs to pass such values through to tools—not when it must analyze their exact contents.

```text
user/tool data → mask → LLM → restore tool arguments → tool uses real data
                              tool result → mask → next LLM request
```

## Features

- **Provider-boundary protection** — configured values are masked before model requests while remaining available to local sessions and tools.
- **Model-friendly placeholders** — recognizable token, URL, address, and credential shapes reduce disruption to model reasoning and tool calls without exposing an obvious `[REDACTED]` marker.
- **Automatic tool restoration** — the model passes placeholders in tool calls, and the extension restores the original values immediately before execution with no manual step.
- **Integrated rule management** — `/masking` centralizes project and global rules, presets, ordering, testing, import, and redacted export in one UI.
- **Efficient long conversations** — with stable rules, cached masking results avoid repeated regex scans of unchanged history as the conversation grows.
- **Prompt-cache-aware updates** — impact checks before saving help avoid rule changes that would unnecessarily disrupt provider prompt-cache reuse.
- **Auditable model view** — `/masking-history` lets you verify the exact local and model-facing representations, together with the rule versions that produced them.

## Use cases

- Pass API keys, access tokens, and credentials through model-generated tool calls without exposing the real values to the provider.
- Let the model work with private hostnames and connection strings through structure-preserving substitutes.
- Hide non-secret content you still don't want the model to read—internal system names, customer or personal data, proprietary snippets, or any sensitive text matched by a rule.
- Audit exactly how local conversation content was transformed before reaching the model.
- Keep model-facing conversation prefixes stable across repeated requests and review rule changes before they disrupt cache reuse.

## Quick start

```bash
pi install npm:@sevten/pi-data-masking
```

Start Pi and open `/masking`. Select `＋ Add new rule`, choose project or global scope (global is the default), test the rule in the same screen, and save it.

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

## How it works

### Realistic placeholders

An obvious marker such as `[REDACTED]` tells the model that data is missing. That can change its reasoning, make it ask for the value again, or make it avoid a tool call.

Automatic placeholders instead preserve character classes and separators: letters remain letters, digits remain digits, and URL or token structure remains usable. Rules can preserve safe prefixes or IP octets, and literal rules may specify a deliberately realistic replacement.

```text
sk-prod-abc123456789  → sk-nqpz-mwx847312654  (with keepPrefix)
172.16.254.1          → 172.16.19.207       (with private-ipv4 preset)
db.prod.internal      → db-primary.prod.corpnet.internal
```

Automatic placeholders use HMAC-SHA-256 keyed by a random per-conversation key to derive deterministic replacement characters. This is not standard format-preserving encryption: character classes and separators—and any prefixes or IP octets explicitly configured to be retained—remain visible.

The replacement is operationally believable, not semantically equivalent to the real value.

### Stable model context

The same real value maps to the same placeholder throughout a conversation. Persisted conversations restore their session key and exact model-facing history; new conversations use a new key.

Before saving a change that would alter the existing model-facing prompt prefix, `/masking` identifies the earliest affected system prompt or message and asks whether to continue. This helps preserve opportunities for provider prompt-cache reuse, but does not predict provider cache behavior. External file reloads receive an immediate warning instead.

### Transparent tool execution

The model plans tool calls using placeholders. Immediately before a tool runs, matching placeholders in its arguments are restored to their real values. Tool results remain real in the local conversation and are masked again before the next model request.

The model must pass a placeholder verbatim. A placeholder that the model slices, concatenates, hashes, or otherwise transforms cannot be restored.

### Inspectable model view

`/masking-history` shows only representations that actually reached the model, grouped into consecutive rule versions rather than hypothetical replays. It supports local original, exact model-facing, and comparison views with navigation across every masked occurrence.

Each version includes a read-only rule list and net changes. Unused intermediate edits are omitted, while persisted and compacted history remains associated with the version that processed it.

## Rules and configuration

| Rule source | Configuration | Best use |
|---|---|---|
| Exact literal | `real` | One known value |
| Environment literal | `realFromEnv` | One known value that should not be stored in JSON |
| Custom regex | `type: "regex"`, `pattern` | A narrowly defined class of values |
| Built-in preset | `preset` | Common tokens, credentials, private keys, connection strings, or IP addresses |

Every rule has a unique `id` within its file. `name` is the user-facing label; `enabled` defaults to `true`. Literal rules may use a fixed `placeholder` or automatic generation. Regex matches always receive generated placeholders because one pattern can discover many distinct values.

Custom patterns use standard JavaScript `RegExp` syntax. Store the pattern source without `/.../` and escape backslashes for JSON, for example `"\\btoken_[A-Za-z0-9]{24}\\b"`. Standard flags such as `i`, `m`, and `s` are supported; global scanning and match indices are added internally. If capture groups exist, only the captured parts are masked. Earlier rules take priority over overlapping later rules.

The packaged [`masking.config.example.json`](masking.config.example.json) contains exact, environment, custom-regex, and preset examples. [`masking.config.schema.json`](masking.config.schema.json) is the complete field reference and enables editor validation.

## Performance

Compiled rules and masked outputs are cached, so unchanged history is reused across requests and only new or changed messages require full scanning. Large messages, many active rules, and broad or backtracking-heavy regexes can still add local latency.

Regex diagnostics are advisory. Keep patterns narrow and test representative positive, negative, and large inputs in `/masking`.

## Commands and shortcuts

| Command | Purpose |
|---|---|
| `/masking` | Manage and locally test project/global rules and the global masking state |
| `/masking-history` | Audit exact local/model views by rule version |

### `/masking`

| Key | Action |
|---|---|
| `M` | Toggle global masking |
| `Space` | Toggle the selected rule |
| `↑/↓` / `PgUp/PgDn` / `Home/End` | Browse rules by row or page, or jump to the first rule/Add row |
| `Enter` / `A` | Edit the selection or add a rule with structured fields |
| `F2` | Edit the selected rule as JSON, or start a new JSON rule draft |
| `Ctrl+↑/↓` | Reorder the selected rule |
| `D` / `Delete` | Remove the selected rule |
| `Tab` | Focus the local test area |
| `R` | Show or hide exact literal values (shown by default) |
| `F` / `/` | Filter or search rules |
| `B` / `I` / `X` | Batch edit, import, or redacted export |
| `H` | Open help |
| `Esc` | Close |

Test input remains local and does not enter model context, session history, configuration, or live placeholder mappings.

### `/masking-history`

| Key | Action |
|---|---|
| `[` / `]` | Switch rule version |
| `R` | Inspect the selected version's rules and net changes |
| `N` / `P` | Navigate masked occurrences |
| `M` | Switch between local original and model-facing views |
| `C` | Toggle comparison view |
| `Ctrl+O` / `Ctrl+T` | Toggle tool and thinking content |
| `↑/↓` / `PgUp/PgDn` | Scroll |
| `Esc` | Go back or close |

## Security model and limitations

> Do not mask a value whose exact characters or meaning the model must analyze—whether it is a secret or not. A realistic placeholder is an operational substitute, not a semantic equivalent. Even when a task is not explicitly about the hidden value, the model may infer properties from the placeholder and generate code based on them.

Masking has several inherent limitations:

- **LLM secret-handling heuristics misfire on placeholders.** Models trained to avoid reading secrets verbatim often compare only head/tail samples or length, encode instead of comparing, or refuse credential-shaped strings outright. Because distinct originals can produce placeholders with equal length and preserved prefixes, sampled comparison yields confidently wrong equality judgments. The opt-in `systemPromptGuidance` note counters this with a behavioral contract (exact full-string equality, verbatim tool passthrough), but compliance is not guaranteed.
- **Assertions about hidden characters may be wrong.** Password-strength judgments, numeric comparisons, parsing, and generated checks for prefixes, lengths, or character classes describe the placeholder unless that structure was explicitly preserved.
- **Derived values cannot be restored.** Arithmetic, slicing, concatenation, hashing, checksums, and signatures operate on placeholder characters rather than the real value.
- **One string cannot carry two semantic identities.** If `password` is protected as the real password and the model later writes the ordinary word `password` in code or documentation, the next request masks both alike. The model then sees a changed version of its own earlier answer, which can cause confusion or inconsistent reasoning.

Low-entropy and common values are therefore unsuitable. Prefer high-entropy secrets and narrow contextual rules, and test both positive and negative samples before relying on a rule. Options such as `keepPrefix`, `keepIPv4Octets`, and `systemPromptGuidance` can reduce semantic drift but cannot recover hidden meaning or guarantee model compliance.

### Immutable first-seen classification

To preserve reasoning consistency and cache prefixes, the first matching occurrence determines how that exact string is classified for the rest of the conversation:

- First seen in user, system, or tool-result data: `protected`. It is masked consistently, including later assistant echoes.
- First seen in model output: `model-known`. Later occurrences from the user or tools remain unmasked.

If the model saw a string first, protecting it later would rewrite text the model had already seen. pi-data-masking preserves the established model view instead, accepting that a later secret with the same string will not be protected. This deterministic policy matters primarily for low-entropy values; independently reproducing an exact high-entropy secret is extremely unlikely.

### Security boundaries

- This is rule-based masking, not encryption or automatic PII detection. Only configured string matches are protected.
- Pi session files contain the real conversation under `~/.pi/agent/sessions/`; protect their permissions and backups.
- Binary and other non-string data is not scanned. The final provider-request safety pass also depends on provider support for that Pi hook.
- Literal matching includes substring occurrences. Prefer exact high-entropy values; use narrow regex rules for value classes.
- A custom placeholder must be unique and must not equal another real value. Generated placeholders include collision checks.
- Content injected only at the final provider boundary is visible in live history, but cannot be reconstructed after restart unless Pi also stored its local original as a session message.

## Scope, persistence, and recovery

Project rules run before global rules, and project options override global options. The persistent global switch in `/masking` overrides both files. Writes are atomic, multi-file operations roll back on failure, and a temporarily invalid or unreadable file leaves the last valid configuration active.

Rule or global-state changes received during an agent run activate before the next run, keeping tool placeholder restoration consistent. With the default `persistHistory: true`, session keys, rule-version metadata, and model-facing differences survive restarts without duplicating original secrets beyond Pi's normal local conversation storage.

Other options are `caseSensitive`, `showStatusBar`, `systemPromptGuidance`, and `disclosePlaceholders`; see the JSON Schema for defaults and descriptions.

## FAQ

### How is this different from replacing values with `[REDACTED]`?

Generated placeholders preserve recognizable structure, reducing the chance that the model treats a value as missing. They remain substitutes, not semantically equivalent or encrypted versions of the original values.

### Does pi-data-masking encrypt Pi session files?

No. Masking applies at the LLM-provider boundary; Pi's local session files still contain the real conversation.

### Does it automatically detect every secret or piece of PII?

No. Only values matched by configured literal, environment, preset, or regex rules are masked—whether they are secrets or any other content you choose to hide.

### Do tools receive the original value?

Yes. When the model passes a placeholder unchanged in a tool call, the extension restores the original value immediately before execution.

### Does masking guarantee provider prompt-cache hits?

No. Stable placeholders and save-time preflight help preserve model-facing prefixes, but provider serialization, tokenization, and cache policy remain outside the extension's control.

### What happens if the model modifies a placeholder?

A sliced, concatenated, hashed, or otherwise transformed placeholder cannot be mapped back to the original value. The model guidance tells the model to pass placeholders verbatim into tools and let the tool perform any transformation, but this is advice, not an enforcement mechanism.

### Can the model be told which values are placeholders?

Yes, opt-in. `options.disclosePlaceholders` (or a per-rule `disclosePlaceholder` override, literal rules only) lists the session's actual placeholder strings inside the model guidance, grouped into "generated" (structure preserved) and "custom" (structure not preserved) substitutes. Disclosure requires `systemPromptGuidance` and enables it automatically. Regex-discovered placeholders are never listed: they appear lazily mid-session, and listing them would invalidate the provider prefix cache on every discovery. A disclosed list also does not certify that everything unlisted is real — a value that escaped masking never gains credibility from not being listed. Toggle both switches in the `/masking` home screen's settings zone (top block, Tab to focus).

## Development

Development and CI use Node.js 24. Install the locked dependencies and run all checks:

```bash
npm ci
npm run check
npm test
npm run pack:dry
```

To load the working tree for an end-to-end check without installing it, run `pi -e .`, then open `/masking` to verify rule editing, local tests, and history inspection. `npm run pack:dry` verifies the files that would be included in the published package.

See [`CHANGELOG.md`](CHANGELOG.md) for release history.

## License

Licensed under the [MIT License](LICENSE).
