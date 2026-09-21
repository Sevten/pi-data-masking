# pi-data-masking

pi-data-masking is a Pi agent extension that replaces configured values—secrets, credentials, customer data—with stable, realistic-looking placeholders before a request reaches the LLM provider.

```text
user/tool data → mask → LLM → restore tool arguments → tool uses real data
                              tool result → mask → next LLM request
```

## Features

- **Model-friendly placeholders** — recognizable token, URL, address, and credential shapes reduce disruption to model reasoning and tool calls without exposing an obvious `[REDACTED]` marker.
- **Integrated rule management** — `/masking` centralizes project and global rules, presets, ordering, testing, import, and redacted export in one UI.
- **Efficient long conversations** — with stable rules, cached masking results avoid repeated regex scans of unchanged history as the conversation grows.
- **Model guidance for placeholders** — an opt-in system-prompt note teaches the model to compare placeholders as exact full strings, pass them verbatim into tools, and route transformations through tools instead of slicing or hashing them.
- **Placeholder disclosure** — optionally list the session's actual placeholder strings in the model guidance, so the model can tell which values are substitutes instead of guessing. Disclosure is a three-position switch (on, off, or per-rule) with a plain on/off toggle per literal rule.
- **Auditable model view** — `/masking-history` lets you verify the exact local and model-facing representations, together with the rule versions that produced them.

## Use cases

- Pass API keys, access tokens, and credentials through model-generated tool calls without exposing the real values to the provider.
- Let the model work with private hostnames and connection strings through structure-preserving substitutes.
- Hide non-secret content you still don't want the model to read—internal system names, customer or personal data, proprietary snippets, or any sensitive text matched by a rule.
- Audit exactly how local conversation content was transformed before reaching the model.

## Quick start

```bash
pi install npm:@sevten/pi-data-masking
```

Start Pi and open `/masking`. Select `+ Add new rule`, pick one of the four rule types (literal, environment, regex, or preset), choose project or global scope (global is the default), test the rule in the same screen, and save it. That's it—masked values are replaced from the next request on.

Configuration files are created and updated by the UI automatically; see [Rules and configuration](#rules-and-configuration) for their locations and the manual format.

## How it works

### Realistic placeholders

An obvious marker such as `[REDACTED]` tells the model that data is missing. That can change its reasoning, make it ask for the value again, or make it avoid a tool call.

Automatic placeholders instead preserve character classes and separators: letters remain letters, digits remain digits, and URL or token structure remains usable. Rules can preserve safe prefixes or IP octets, and literal rules may specify a deliberately realistic replacement.

```text
sk-live-abc123456789     → sk-live-qxn4mwp827315692   (automatic with keepPrefix, or a preset rule)
git.corp.acme-tools.com  → git.eu-west.stackline.dev  (literal rule with a custom placeholder)
```

Automatic placeholders use HMAC-SHA-256 keyed by a random per-conversation key to derive deterministic replacement characters. This is not standard format-preserving encryption: character classes and separators—and any prefixes or IP octets explicitly configured to be retained—remain visible.

The replacement is operationally believable, not semantically equivalent to the real value.

### Stable model context

The same real value maps to the same placeholder throughout a conversation. Persisted conversations restore their session key and exact model-facing history; new conversations use a new key.

### Transparent tool execution

The model plans tool calls using placeholders. Immediately before a tool runs, matching placeholders in its arguments are restored to their real values. Tool results remain real in the local conversation and are masked again before the next model request.

### Inspectable model view

`/masking-history` shows only representations that actually reached the model, grouped into consecutive rule versions. It supports local original, exact model-facing, and comparison views; each version lists the rules that produced it, and unused intermediate edits are omitted.

## Rules and configuration

Rules live in JSON files that the UI creates and updates automatically:

| Scope | Configuration path |
|---|---|
| Project | `<project>/.pi/pi-data-masking/masking.config.json` |
| Global | `~/.pi/agent/pi-data-masking/masking.config.json` |

Files use strict JSON and reload automatically. When the first project rule is saved, Pi can add the path to `.gitignore`. Project rules run before global rules. Settings (`options`) are global-level: they are read from the global config only, and a leftover `options` object in a project config is ignored, with a one-time prompt in `/masking` to migrate it into the global config. The persistent global switch in `/masking` overrides both files.

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

Environment-backed values must be present in the process that starts Pi; enter only the variable name in `realFromEnv`, without `$`. A missing or empty variable leaves the rule in `WAIT` state.

Four rule sources are available:

| Rule source | Configuration |
|---|---|
| Exact literal | `real` |
| Environment literal | `realFromEnv` — read from an environment variable, never stored in the config file |
| Custom regex | `type: "regex"` with a JavaScript `RegExp` `pattern` |
| Built-in preset | `preset` — common tokens, credentials, private keys, connection strings, and IP addresses |

Literal rules may use a fixed `placeholder` or automatic generation; regex matches always receive generated placeholders, and capture groups restrict masking to the captured parts. Earlier rules take priority over overlapping later rules.

Literal rules match case-sensitively by default; the Rule Builder's `Case` field makes a rule case-insensitive (regex rules use their own flags). An allowlist (`options.allowlist`, edited in `/masking`) exempts listed values or whole lines from masking even when a rule would match. Other options include `showStatusBar`, `systemPromptGuidance`, and `disclosePlaceholders`; see [`masking.config.schema.json`](masking.config.schema.json) for the complete field reference and defaults.

## Performance

Compiled rules and masked outputs are cached, so unchanged history is reused across requests and only new or changed messages require full scanning. Large messages, many active rules, and broad or backtracking-heavy regexes can still add local latency.

Regex diagnostics are advisory. Keep patterns narrow and test representative positive, negative, and large inputs in `/masking`.

## Commands and shortcuts

| Command | Purpose |
|---|---|
| `/masking` | Manage and locally test project/global rules and the global masking state |
| `/masking test <text>` | Run the effective rules over the text and preview the masked output |
| `/masking on` / `off` | Toggle the global masking switch |
| `/masking-history` | Audit exact local/model views by rule version |

### `/masking`

| Key | Action |
|---|---|
| `M` | Toggle global masking |
| `Space` | Toggle the selected rule |
| `Enter` / `A` | Edit the selection or add a rule with structured fields |
| `F2` | Edit the selected rule as JSON, or start a new JSON rule draft |
| `Ctrl+↑/↓` | Reorder the selected rule |
| `D` / `Delete` | Remove the selected rule |
| `Tab` | Focus the local test area |
| `R` | Show or hide exact literal values (shown by default) |
| `F` / `/` | Filter or search rules |
| `B` / `I` / `X` | Batch edit, import, or redacted export |
| `H` | Open help |

### `/masking-history`

| Key | Action |
|---|---|
| `[` / `]` | Switch rule version |
| `R` | Inspect the selected version's rules and net changes |
| `N` / `P` | Navigate masked occurrences |
| `/` | Search the transcript; `Enter`/`Ctrl+R` cycle matches, `Esc` closes |
| `M` | Switch between local original and model-facing views |
| `C` | Toggle comparison view |
| `Ctrl+O` / `Ctrl+T` | Toggle tool and thinking content |

## Security model and limitations

Masking has several inherent limitations:

- **Secrets stored in files invite side-channel probing.** Models are trained to avoid reading secret-like content verbatim, so when a secret lives in a file, a model may probe its shape through tools instead—sampling the head or tail, comparing lengths, hashing, or slicing. Two consequences follow:
    - *Contradictions.* The probed side information rarely matches what the model expects of the value: derived results contradict its assumptions, assertions such as password-strength judgments or numeric comparisons describe the placeholder rather than the value, and the model may repeatedly re-verify or distrust its own earlier answers.
    - *Real leakage.* Whatever the probe returns is real: head and tail characters expose true fragments, and in the extreme a tool that processes the file fragment by fragment—or character by character—can reveal the entire value. None of this derived text matches the configured masked string, so masking cannot intercept it.
- **Transformed placeholders cannot be restored.** An encoded, hashed, or sliced placeholder passed to a tool no longer maps back to the real value, so the tool call fails or operates on the wrong data.

The opt-in `systemPromptGuidance` note mitigates both: its escape hatch (report inexplicable contradictions instead of investigating them) targets the probing behavior, and its behavioral contract (exact full-string equality, verbatim tool passthrough, transformations through tools) addresses unrestorable placeholders. It is advice, not enforcement.

- **One string cannot carry two semantic identities.** If `password` is protected as the real password and the model later writes the ordinary word `password` in code or documentation, the next request masks both alike. The model then sees a changed version of its own earlier answer, which can cause confusion or inconsistent reasoning.

  No guidance can prevent this—it is inherent to whole-string matching. Low-entropy and common values are therefore unsuitable: prefer high-entropy secrets and narrow contextual rules, and test positive and negative samples before relying on a rule.

### Immutable first-seen classification

pi-data-masking deliberately classifies each exact string once, at its first matching occurrence, and never reclassifies it. Reclassifying a string the model has already seen would rewrite model-facing history mid-conversation—contradicting what the model read earlier and discarding provider prompt-cache prefixes:

- First seen in user, system, or tool-result data: `protected`. It is masked consistently, including later assistant echoes.
- First seen in model output: `model-known`. Later occurrences from the user or tools remain unmasked.

The accepted trade-off: if the model saw a string first, a later secret with the same string will not be protected. This matters primarily for low-entropy values; independently reproducing an exact high-entropy secret is extremely unlikely.

### What masking does not cover

- This is rule-based masking, not encryption or automatic PII detection. Only configured string matches are protected.
- Binary and other non-string data is not scanned.
- Literal rules match every occurrence of the value, including inside longer text—not just standalone words.

## FAQ

### How is this different from replacing values with `[REDACTED]`?

Generated placeholders preserve recognizable structure, reducing the chance that the model treats a value as missing. They remain substitutes, not semantically equivalent or encrypted versions of the original values.

### Does pi-data-masking encrypt Pi session files?

No. Masking applies at the LLM-provider boundary; Pi's local session files still contain the real conversation.

### Does it automatically detect every secret or piece of PII?

No. Only values matched by configured literal, environment, preset, or regex rules are masked—whether they are secrets or any other content you choose to hide.

### Do tools receive the original value?

Yes. When the model passes a placeholder unchanged in a tool call, the extension restores the original value immediately before execution.

### What do `systemPromptGuidance` and `disclosePlaceholders` do?

Both are opt-in switches in the `/masking` settings zone. Enable them if you notice the model analyzing or distrusting placeholders.

`systemPromptGuidance` injects a note into the system prompt that pins down how the model must treat placeholders: compare them as exact full strings, pass them verbatim into tools, route transformations through tools, and report inexplicable contradictions instead of investigating them. It is advice, not enforcement.

With disclosure enabled, the guidance lists the session's actual placeholder strings (grouped by structure fidelity), so the model knows exactly which values are substitutes. Regex-discovered placeholders are never listed. Enabling disclosure enables guidance automatically.

`disclosePlaceholders` is a three-position master switch in the `/masking` settings zone: on discloses all eligible literal rules, off discloses none, and per-rule (the default) defers to each rule's own on/off toggle. Enable it if you notice the model analyzing or distrusting placeholders.

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
