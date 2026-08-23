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

Run Pi and open `/masking-config`. Press `M` to create a project or global
configuration, select the built-in presets you need, review the options, and
confirm the preview. No separate `/masking-init` command is required.

The initializer never overwrites an existing file. Project initialization also
warns about Git and can add the config path to `.gitignore`.

For manual setup, choose where the initial configuration should apply.

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

Edit the chosen file and set `PROD_API_KEY` in Pi's environment, or replace the
example rules with your own. Configuration changes are applied automatically
without restarting Pi.

Both scopes may be used together: keep shared rules in the global file and add only project-specific rules or option overrides to the project file. Do not copy the complete global configuration into the project file, because both rule lists are merged.

## Quick configuration

```json
{
  "$schema": "https://raw.githubusercontent.com/sevten/pi-data-masking/main/masking.config.schema.json",
  "version": 1,
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
      "name": "Production API key",
      "enabled": true,
      "description": "Credential used by the production deployment pipeline",
      "realFromEnv": "PROD_API_KEY",
      "preserveStructure": { "keepPrefix": true }
    },
    {
      "id": "github_pat",
      "name": "GitHub personal access token",
      "preset": "github-pat",
      "enabled": false
    }
  ]
}
```

Rule types:

- A **literal rule** omits `type` or uses `"literal"`. Every fixed-string occurrence of `real` is replaced, including substring occurrences.
- A **regex rule** uses `"type": "regex"`. Each value matched by `pattern` receives a stable placeholder when first encountered.
- A **preset rule** uses `"preset"` and expands to a tested built-in regex at load time. Its position still determines priority.

The packaged `masking.config.example.json` is deliberately small. Use presets
for common value shapes and custom regex only when a preset does not fit.

Every rule accepts an optional `enabled` boolean. It defaults to `true`, so existing configurations keep their current behavior. Set it to `false` to retain a rule and its priority position without running it:

```json
{
  "id": "github_pat",
  "name": "GitHub personal access token",
  "type": "regex",
  "enabled": false,
  "pattern": "\\bghp_[A-Za-z0-9]{36}\\b"
}
```

Use `/masking-config` to browse all project and global rules. Press `Space` to
apply a per-rule state change immediately with no confirmation dialog; disabling
shows a non-blocking warning. Press `M` to inspect sources or create a missing config. Rule-list
details hide literal real values; environment rules show only the variable name. Each
write uses an atomic replacement and restricts the config file to user-only
permissions where the filesystem supports POSIX modes.

The home list uses a centered four-character state column: `[ ON ]`, `[OFF ]`,
and `[WAIT]`. Its final selectable row is `＋ Add new rule`, so creation is
discoverable with `Enter` while `A` remains available as a shortcut. Reordering
retains the same selected rule instead of leaving the cursor at the old row.

Configuration-center controls:

| Key | Action |
|---|---|
| `Space` | Immediately enable/disable the selected rule without a confirmation dialog |
| `Enter` | Edit the selected rule, or add one from the `＋ Add new rule` row |
| `A` / `D` or `Delete` | Add or delete a rule |
| `Ctrl+↑` / `Ctrl+↓` | Move a rule within its project/global scope |
| `F` / `/` | Cycle filters or search names, IDs, descriptions, sources, and types |
| `B` | Immediately enable or disable all currently visible rules after one summary confirmation |
| `Tab` | Switch between the rule list and the embedded active-rules test panel |
| `T` | Focus the embedded active-rules test panel |
| `H` | Show an in-app guide to literal, preset, and regex rule configuration |
| `I` / `X` | Import rules from a config or create a non-runnable redacted export |
| `M` | Inspect source paths or initialize a missing configuration |

When adding an `Exact literal value`, the configuration center asks for the
value once and then lets you choose either an automatically generated
placeholder or an exact custom replacement. Prefer an environment-backed
literal for secrets that should not be stored in JSON. Rule-list details never
show the value. Entering the rule editor is an explicit inspection action, so
the stored `real` value is shown there by default. Environment-backed rules
continue to show only the variable name, never the resolved value.

The configuration-center home screen includes a compact `Test active rules`
panel. `Tab` switches between the rule list and test input, while `T` focuses
the test input directly. Input is evaluated locally as it changes and shows a
masked preview plus rule-attributed match counts. It is cleared when the screen
closes and never enters configuration, session history, live dynamic mappings,
or model context. Both panels visibly identify focus: the active title is
prefixed with `▶`. The Rules title stays outside the two dividers that bound the
actual rule list and selected-rule details. Test titles and instructions stay
outside the input editor's own border, avoiding duplicated lines. Test areas
always say `Type or paste sample text`; an unfocused title adds `Tab to focus`.

Existing rules open in the same structured Rule Builder used for creation, with
a candidate-rule test area below. `F2` switches to complete JSON when advanced
fields are needed, and `Tab` switches between editing and testing. Preset
references are expanded into editable regex fields before editing.

Adding a rule first asks for the configuration source and broad rule type. It
then opens one focused Rule Builder instead of continuing through field-by-field
prompts. The Builder contains only that type's contextual fields, local test
input, validation, and masked preview; scope and broad type are shown as fixed
context rather than editable fields. A compact field list shows each label and
editable value on one line, while one fixed line below shows only the selected
field's description. That description remains in place when focus moves to the
test area, so the form and test positions do not jump. Previously entered values
remain visible, active values scroll horizontally around the cursor when needed,
and focus changes never alter the form's height. `Up`/`Down` move between fields;
`Tab`/`Shift+Tab` switch only between the form and local test area.
`Left`/`Right` or `Space` changes a selector. Non-preset rule fields start
empty; examples remain in field descriptions instead of becoming accidental
configuration values. `F2` switches between the structured form and complete
JSON, `Enter` validates and saves from the editing area, and `Esc` cancels. Built-in presets
expand into editable regex fields immediately. Because validation and testing
are already live, there is no separate Review step.

When adding a built-in preset, a dedicated selection step lists only short,
stable preset names and shows the selected preset's description below the list.
After selection, the Rule Builder opens with that short name, description,
pattern, flags, and structure-preservation options expanded into editable
fields. A unique rule ID is generated automatically. The resulting rule can be
edited like any custom regex before saving.

### Built-in presets

Available names are `github-pat`, `npm-token`, `huggingface-token`,
`aws-access-key-id`, `slack-token`, `jwt`, `pem-private-key`, `bearer-token`,
`database-userinfo`, and `private-ipv4`.

```json
{ "id": "github_pat", "name": "GitHub personal access token", "preset": "github-pat", "enabled": true }
```

Preset references may override `name`, `description`, `enabled`, `lowEntropy`, and
`preserveStructure`, but not the built-in pattern or flags. Unknown presets are
reported and remain inactive. Existing config files may continue using these
compact references. When one is opened in the configuration-center editor, it
is expanded into a complete custom regex draft; saving the draft converts that
rule from a preset reference into an independently editable regex.

### Environment-backed literal values

Use `realFromEnv` instead of `real` when a fixed secret should not be stored in
JSON:

```json
{
  "id": "prod_api_key",
  "realFromEnv": "PROD_API_KEY",
  "preserveStructure": { "keepPrefix": true }
}
```

`real` and `realFromEnv` are mutually exclusive. A missing or empty environment
variable leaves the rule inactive and produces a warning containing only the
variable name. The value is resolved again on session start and config reload.

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

`id` is a stable machine identifier used for editing, stale-write protection,
warnings, and diagnostics. It must be unique within one config file. The same ID
may appear once in the project config and once in the global config; those are
independent rules identified by scope and path. `name` is the short label shown
prominently in `/masking-config`, while `description` is optional longer help
text. New rules created in the TUI ask for `name` and derive a readable unique
ID automatically. Existing rules remain compatible and display
`name ?? description ?? id`.

`/masking-toggle` stores its state in `~/.pi/agent/pi-data-masking/toggle-state.json`. Delete that file and restart Pi to return control to the config-file `enabled` value.

Invalid rules are skipped and reported instead of preventing the extension from loading.

## Commands

| Command | Description |
|---|---|
| `/masking-config` | Browse, search, test, add, edit, delete, reorder, import/export, and immediately toggle project/global rules |
| `/masking-list` | Compatibility alias for `/masking-config` |
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

In `/masking-config`, choose `A` → `Custom regex` and provide:

1. **Rule name** — the human-readable label shown in the configuration center;
   a unique ID is generated from it.
2. **JavaScript regex source** — the pattern only, without surrounding `/.../`.
   Because it is stored in JSON, backslashes appear doubled in the resulting
   file, for example `\btoken_[A-Za-z0-9]{24}\b`.
3. **Regex flags (optional)** — JavaScript flags such as `i`, `m`, or `s`;
   you need not add `g`, because global matching is handled internally.

The commonly useful flags are:

- `i` — case-insensitive matching. `token` also matches `TOKEN` and `Token`.
- `m` — multiline anchors. With `^secret=.*$`, `^` and `$` apply to every line
  instead of only the start and end of the complete input.
- `s` — dot-all mode. `BEGIN(.*?)END` can cross newline characters because `.`
  also matches a newline.
- `g` — global matching. It finds every occurrence instead of stopping after
  the first; pi-data-masking adds it automatically, so it need not be entered.

Regex matches receive deterministic generated placeholders. A regex rule
cannot use one fixed `placeholder`, since the same pattern may discover many
different real values. If the pattern contains capture groups, only the
captured portions are masked; without capture groups, the entire match is
masked.

For example, `\bnpm_[A-Za-z0-9]{36}\b` is composed of:

- `\b` — a zero-width word boundary: a position between a word character
  (`A-Z`, `a-z`, `0-9`, or `_`) and a non-word character, or the start/end of
  text. It prevents this pattern from starting or ending inside a larger word.
- `npm_` — those four literal characters.
- `[A-Za-z0-9]` — one ASCII uppercase letter, lowercase letter, or digit.
- `{36}` — repeat the preceding character class exactly 36 times.
- the final `\b` — require the token to end at another word boundary.

Thus it matches an `npm_` prefix followed by exactly 36 ASCII alphanumeric
characters. In the JSON file each backslash is escaped, so the same pattern is
displayed as `"\\bnpm_[A-Za-z0-9]{36}\\b"`.

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
| `$schema` | string | — | Schema URL for editor completion and inline validation |
| `version` | `1` | — | Optional config format version; legacy files may omit it |
| `enabled` | boolean | `true` | Config-file masking state; overridden by saved `/masking-toggle` state |
| `rules` | array | `[]` | Ordered literal, regex, and preset rules |
| `options` | object | defaults below | Runtime behavior |

### Literal rule

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Stable identifier, unique within this config file |
| `name` | string | no | Short display name; TUI-created rules require it and generate `id` automatically |
| `enabled` | boolean | no | Per-rule switch; defaults to `true` |
| `description` | string | no | Optional longer explanation shown in rule details |
| `type` | `"literal"` | no | May be omitted |
| `real` | string | one source required | Fixed string to replace |
| `realFromEnv` | string | one source required | Name of an environment variable containing the fixed value; mutually exclusive with `real` |
| `placeholder` | string | no | Explicit replacement; omit or use `"auto"` to generate one |
| `preserveStructure` | object | no | `keepPrefix` and/or `keepIPv4Octets` |
| `lowEntropy` | boolean | no | Suppress the warning for an intentionally short value |

### Regex rule

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Stable identifier, unique within this config file |
| `name` | string | no | Short display name; TUI-created rules require it and generate `id` automatically |
| `enabled` | boolean | no | Per-rule switch; defaults to `true` |
| `description` | string | no | Optional longer explanation shown in rule details |
| `type` | `"regex"` | yes | Select regex matching |
| `pattern` | string | yes | JavaScript regex source without delimiters, e.g. `\\btoken_[A-Za-z0-9]{24}\\b` in JSON |
| `flags` | string | no | JavaScript flags such as `i`, `m`, or `s`; `g` is added internally |
| `preserveStructure` | object | no | `keepPrefix` and/or `keepIPv4Octets` |
| `lowEntropy` | boolean | no | Suppress the warning for an intentionally short match shape |

Regex rules do not support `real` or a fixed `placeholder`.

### Preset rule

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier within the source file |
| `name` | string | no | Short display name; TUI-created rules require it |
| `preset` | preset name | yes | Built-in preset to expand at load time |
| `enabled` | boolean | no | Per-rule switch; defaults to `true` |
| `description` | string | no | Override the built-in longer explanation |
| `preserveStructure` | object | no | Override the preset's structure-preservation defaults |
| `lowEntropy` | boolean | no | Acknowledge an intentionally low-entropy rule |

The bundled [`masking.config.schema.json`](masking.config.schema.json) describes
all three mutually exclusive rule shapes and supplies editor descriptions and
examples.

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
