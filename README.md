# pi-data-masking

**Mask sensitive values before they reach the LLM provider, then restore them locally for display and tool execution.**

pi-data-masking is a Pi extension that replaces configured secrets with stable, realistic-looking placeholders before a request reaches the model. The real values remain in Pi's local conversation and are restored only when a tool needs them.

> This protects the LLM-provider boundary. Pi's local session files and tools that use a secret still receive the real value.

```text
user/tool data → mask → LLM → restore tool arguments → tool uses real data
                              tool result → mask → next LLM request
```

Use it for secrets the model only needs to pass to tools, such as API keys, access tokens, private hostnames, and connection credentials—not values whose exact contents it must parse, transform, or validate.

Key features:

- Format-preserving placeholders keep tokens, URLs, and addresses operationally believable instead of replacing them with obvious `[REDACTED]` markers.
- Tool arguments are restored immediately before execution, so tools continue to receive real values.
- Stable per-conversation mappings preserve the model-facing context and the opportunity for provider prompt-cache hits.
- `/masking-history` shows the exact local and model-facing views for auditing.

## Quick start

```bash
pi install npm:@sevten/pi-data-masking
```

Start Pi and open `/masking`. Select `＋ Add new rule`, choose project or global scope, test the rule in the same screen, and save it.

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
172.16.254.1          → 233.84.19.207
db.prod.internal      → db-primary.prod.corpnet.internal
```

Automatic placeholders use HMAC-SHA-256 keyed by a random per-conversation key to derive deterministic replacement characters. This is not standard format-preserving encryption: character classes and separators—and any prefixes or IP octets explicitly configured to be retained—remain visible.

The replacement is operationally believable, not semantically equivalent to the real value.

### Stable model context

The same real value maps to the same placeholder throughout a conversation. Reopening a persisted Pi conversation restores the same session key and model-facing history, keeping earlier prefixes stable. A new conversation uses a new key.

When masking behavior changes, the extension first performs a side-effect-free
local preflight against the most recent factual model input. A `/masking` save
that would change the model-facing system prompt or existing conversation
messages opens an in-configuration confirmation before writing the candidate
rules. It reports the earliest affected message and offers **Save anyway** or
**Back to editing**, so the user can prefer prefix cache reuse without undoing an
already-published edit. External file reloads and commands outside that screen
use an immediate notification instead. The estimate clones placeholder and
provenance state; it does not mutate live mappings or claim that a provider
cache was affected.

The activation notice also explains which agent run keeps the old rules and
confirms that recorded history is not rewritten. At the first actual provider
boundary under the new rule version, the emitted system prompt and provider
prompt are compared with the most recent factual epoch when their source
fingerprints match. Shared historical messages follow the same factual rule. A
prefix-cache warning appears once only when one of these stored model-input
fingerprints really differs; system has priority over prompt and conversation
position. New tail messages, compacted-away messages, and unchanged output do
not trigger it.

The warning reports an observed provider-boundary change, not a simulated rule
replay or a guaranteed provider cache miss. System and prompt facts are stored
only as session-keyed HMACs, never plaintext, and only the first provider
observation is retained per epoch—there is no request timeline. Serialization
or mutation after this extension's hook, tokenization, and provider cache policy
remain outside the comparison.

### Transparent tool execution

The model plans tool calls using placeholders. Immediately before a tool runs, matching placeholders in its arguments are restored to their real values. Tool results remain real in the local conversation and are masked again before the next model request.

The model must pass a placeholder verbatim. A placeholder that the model slices, concatenates, hashes, or otherwise transforms cannot be restored.

### Inspectable model view

`/masking-history` is a factual audit grouped by masking rule version (E1, E2,
E3, ...). Use `[` and `]` to switch versions. Each version shows only messages
that actually crossed an outbound boundary while that version was active; it
does not apply old or current rules hypothetically to other messages. Empty,
unused versions are hidden.

Within a version, the viewer opens at the newest messages. Underlining marks
all replacements; reverse-video highlighting identifies only the current
navigation target without adding display characters. `N` moves to the next
masked occurrence and `P` to the previous one, visiting every occurrence
(including repeated uses of the same mapping). The viewer also switches among
the local original, the exact stored model-facing representation, and a
comparison view. Wide terminals show
the comparison side by side; narrow terminals stack both versions. The header
includes the activation source, secret-free change summary, and behavior
fingerprint so similar rule versions remain distinguishable.

## Rules and configuration

| Rule source | Configuration | Best use |
|---|---|---|
| Exact literal | `real` | One known value |
| Environment literal | `realFromEnv` | One known value that should not be stored in JSON |
| Custom regex | `type: "regex"`, `pattern` | A narrowly defined class of values |
| Built-in preset | `preset` | Common tokens, credentials, private keys, connection strings, or private IPs |

Every rule has a unique `id` within its file. `name` is the user-facing label; `enabled` defaults to `true`. Literal rules may use a fixed `placeholder` or automatic generation. Regex matches always receive generated placeholders because one pattern can discover many distinct values.

Custom patterns use standard JavaScript `RegExp` syntax. Store the pattern source without `/.../` and escape backslashes for JSON, for example `"\\btoken_[A-Za-z0-9]{24}\\b"`. Standard flags such as `i`, `m`, and `s` are supported; global scanning and match indices are added internally. If capture groups exist, only the captured parts are masked. Earlier rules take priority over overlapping later rules.

The packaged [`masking.config.example.json`](masking.config.example.json) contains exact, environment, custom-regex, and preset examples. [`masking.config.schema.json`](masking.config.schema.json) is the complete field reference and enables editor validation.

## Performance

Masking recursively scans every string in the outbound model context against each active rule. The final provider-boundary safety hook may make a second, idempotent pass. Rules are compiled once per configuration load and placeholders are reused, but large histories, many active rules, or broad and backtracking-heavy custom regexes can add local latency.

Regex safety diagnostics are advisory and do not reject a rule. Keep patterns narrow and test representative positive, negative, and large inputs in `/masking` before relying on them.

## Commands

| Command | Purpose |
|---|---|
| `/masking` | Manage, order, enable, edit, and locally test project/global rules |
| `/masking-toggle` | Persistently enable or disable masking |
| `/masking-history` | Audit factual local/model views by active rule version (`[`/`]`) |

In `/masking`, `Space` toggles a rule, `Enter` edits or adds, `Ctrl+↑/↓` changes priority, `D`/`Delete` removes, `Tab` focuses local testing, and `R` reveals the selected literal value. The screen lists the remaining filter, search, batch, help, import, and redacted-export shortcuts.

The test areas are local: sample text does not enter model context, session history, configuration, or live placeholder mappings.

## Security model and limitations

> Do not mask a value whose exact characters or meaning the model must analyze. A realistic placeholder is an operational substitute, not a semantic equivalent. Even when a task is not explicitly about the secret, the model may infer properties from the placeholder and generate code based on them.

Masking has several inherent limitations:

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
- Content injected only at the final provider boundary is visible in the live
  factual history, but cannot be reconstructed after restart unless Pi also
  stored its local original as a session message.

## Scope, persistence, and recovery

When both configuration files exist, project rules run before global rules; project option fields override global fields. A saved `/masking-toggle` state overrides both files.

Config writes are atomic and use user-only permissions where POSIX modes are available. Multi-file operations roll back on failure. If a watched file is temporarily invalid or unreadable, the last successfully parsed configuration remains active; deleting the file intentionally removes that scope.

Masking behavior is pinned for one complete agent run, including all model/tool
loop iterations. A config reload or `/masking-toggle` change that arrives while
the agent is running is saved immediately but activates before the next agent
run, so tool placeholders are always restored by the masker that created them.
Effective behavior changes append sanitized, secret-free `RuleEpoch` metadata to
the session when history persistence is enabled.

`persistHistory` defaults to `true`. It stores the session key, immutable rule
epochs, and per-epoch model-facing text differences in Pi custom session
metadata so placeholders and factual `/masking-history` views survive a
restart. Repeated tool-loop requests do not create request records or duplicate
unchanged messages. Compacted-away messages remain only in epochs that actually
processed them; a newer epoch never inherits or recomputes them. Persistence
does not duplicate original secrets, although Pi's normal session file already
contains the real conversation.

Other options are `caseSensitive`, `showStatusBar`, and `systemPromptGuidance`; see the JSON Schema for their defaults and descriptions.

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
