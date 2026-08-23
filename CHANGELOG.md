# Changelog

## Unreleased

- Make first-seen provenance immutable: a value first seen in model output can
  no longer be promoted to protected by a later tool result, preventing prior
  model-facing history and cache prefixes from changing between requests.
- Add multi-turn extension coverage for model-first values across assistant,
  user, tool-result, and subsequent context requests.
- Rewrite the public README around the extension's primary invariant: masking
  must preserve model reasoning, transparent tool execution, and stable
  model-facing prefixes for prompt-cache reuse; clearly separate the project's
  immutable-first-seen trade-off, masking's inherent limitations, partial
  mitigations, and implementation boundaries, while documenting low-entropy
  identity ambiguity and the history viewer's comparison mode.
- Rename the unified configuration center from `/masking-config` to `/masking`
  and remove `/masking-test`; active-rule and candidate-rule testing now live
  inside the configuration UI. `/masking-list`, `/masking-init`, and
  `/masking-rule` also remain unregistered.
- Expand the packaged example to cover exact, environment, custom-regex, and
  preset rules, including a realistic-looking private DNS replacement.
- Keep the last successfully parsed project/global config active during
  transient read, JSON, root-shape, or `rules`-shape failures.
- Add rollback-protected multi-file config publishing so a later failure
  restores already-published files instead of leaving a partial scope move.
- Keep Rule Builder mounted until persistence succeeds, retain the complete
  draft after failures, and confirm before discarding only a changed draft.
- Add Pi/TUI integration coverage for focus switching, in-place toggle and
  reorder selection, failed-save draft retention, and discard confirmation.
- Mark validation errors from disabled rules with explicit disabled-state
  context.
- Add advisory excessive-backtracking diagnostics for nested unbounded
  quantifiers, overlapping repeated alternatives, and adjacent overlapping
  repetitions while preserving native JavaScript regex compatibility.
- Remove the redundant `Type or paste sample text` line from configuration test
  panels; each editor's `Enter text` placeholder now provides the prompt.
- Remove the duplicate field-navigation instruction above the structured rule
  editor; the persistent footer remains the single shortcut reference.

- Added an aligned `STATE / ORDER / SCOPE / TYPE / NAME` header to the home
  rule list, clarifying that the numeric column is execution order.
- Kept preset selection rows compact by showing only readable labels; the
  selected preset's description and example now use separate lines below the
  list.
- Project config creation now asks whether to add its path to `.gitignore`
  after the first rule is saved. Preset selection rows now combine readable
  labels, descriptions, and verified matching examples; selected presets use
  the readable label as Name and generate a separate ID.
- Removed the redundant `M` sources/initializer menu. Rule Builder now exposes
  a project/global Scope selector, creates a missing minimal target config when
  the first rule is saved, and moves edited rules across scopes atomically.
- Reserved eight structured-field rows in Rule Builder so type and replacement
  changes cannot shift the test panel, and placed home details directly against
  the rule-list divider.
- Removed the home screen's redundant `T` shortcut in favor of `Tab` alone,
  removed leading focus arrows from home and Rule Builder area titles, and
  left-aligned titles and instructions with field help directly below its
  divider.
- Made single-rule toggles and reordering save and reload in place while the
  configuration home screen stays mounted, eliminating the full-screen rebuild
  and preserving selection, scrolling, details, and test input.
- Simplified selected-rule details on the configuration home screen by removing
  repeated name, ID, and state fields; added literal values, always-visible
  descriptions, environment availability, and explicit current-session versus
  custom placeholder labelling.
- Split execution type from rule origin in the home list: exact literals,
  environment literals, and regex rules now display as `exact`, `env`, and
  `regex`, while preset origin remains in details and filters. Exact and
  resolved environment values are hidden by default and can be revealed for
  only the selected row with `R`.
- Aligned the Rule Builder's first-row type selector with the home list by using
  the same `exact`, `env`, and `regex` names.
- Moved Rule Builder navigation and active-field help outside the field
  dividers and aligned instructional text across editing and test areas.
- Moved home-screen rule details below the rule list divider and reserved a
  fixed-height detail block so changing rule types no longer shifts the test
  panel.
- Added a first-row Rule type selector to the structured Rule Builder, allowing
  existing and new rules to switch among exact literals, environment-backed
  literals, and regular expressions without discarding temporarily hidden
  field values. JSON-to-form switching now derives the matching type.
- Fixed Rule Builder saving from text fields: pressing Enter now validates the
  current value instead of clearing it first. Enter in the embedded test area
  continues to insert a newline.
- Environment-backed literals can now choose an automatically generated or
  exact custom placeholder, with clearer validation for an empty variable name.

- Unified existing-rule editing with the structured/JSON Rule Builder, made
  Enter save from editing areas, removed redundant F1 help, shortened preset
  selection, and added an explicit selectable add-rule row on the home screen.
- Centered the four-character rule-state column and retained the same selected
  rule after reordering.

- Reduced active-field help to one persistent description line and retained it
  while testing so switching areas no longer shifts the test panel vertically.

- Kept active values editable directly beside their field labels while moving
  contextual descriptions into a stable help-only area below the field list.

- Replaced per-field two-line blocks with a compact field list and a stable
  detail area that separates values from contextual help.

- Removed duplicate outer dividers from bordered editors and moved the Rules
  dividers to bound only the actual list and selected-rule details.

- Removed accidental-looking defaults from non-preset rule fields, moved
  built-in preset selection to a descriptive step before editing, and unified
  content boundaries across Rules, rule-editing, and test areas.

- Stabilized the Rule Builder as fixed-height field rows that keep entered
  values and descriptions visible; `Up`/`Down` now navigate fields while `Tab`
  is reserved for switching between the form and local test area.

- Refined the new-rule flow to select source and broad type before opening a
  focused type-specific Builder, and added matching dividers around the Rules
  panel on the configuration home screen.

- Specified a single-page Rule Builder with live testing, structured/JSON modes,
  and direct save, plus symmetric focus markers and in-panel onboarding on the
  configuration home screen.

- Documented the unified configuration workspace: embedded live local testing
  on the home and rule-editor screens, `H` home help plus contextual `F1` editor
  help, candidate-rule previews, and visible-by-default direct literals inside
  explicit edits.

- Refined configuration-center rule creation: automatic literal replacements
  are no longer presented as universally recommended, built-in presets supply
  their own display names, and `D` is available as a portable delete shortcut.
- Made preset templates transparent and editable in the configuration center,
  retained the selected row after immediate toggles, and let users choose
  whether an exact literal is hidden or revealed while editing.
- Added in-editor `Ctrl+R` literal reveal/hide, retained a neighboring row after
  deletion, added `H` configuration help, and surfaced regex syntax guidance
  during creation and editing.

All notable changes to this project are documented in this file.

The entries before 0.4.0 were reconstructed from the Git history and existing tags because the project did not previously publish GitHub Releases.

## [Unreleased]

### Added

- Per-rule `enabled` switches, defaulting to enabled for backward compatibility.
- `/masking` for browsing, filtering, searching, testing, adding, editing, deleting, and reordering project/global rules without showing literal real values.
- Scope-aware, atomic rule-state writes with user-only file permissions on filesystems that support POSIX modes.
- A guided project/global initializer inside `/masking`, including preset selection, option preview, no-overwrite creation, and an optional project `.gitignore` entry.
- Ten built-in regex presets referenced by stable names and expanded at load time.
- Environment-backed literal rules through mutually exclusive `realFromEnv` values.
- `masking.config.schema.json` for editor completion and validation.
- Batch enable/disable, validated rule import, and non-overwriting redacted exports in the configuration center.
- Optional human-readable rule `name` values; the TUI now asks for a name, generates a readable collision-free `id`, and displays the name prominently while preserving legacy fallbacks.
- A shorter exact-literal creation flow with an explicit choice between automatic placeholders and exact custom replacements.

### Changed

- The status bar and reload notifications now distinguish active rules from all configured rules.
- The formal command set is reduced to `/masking`, `/masking-toggle`, and `/masking-history`.
- The packaged example now demonstrates exact, environment, custom-regex, and preset rules; advanced regex guidance remains in README.
- Pressing `Space` now atomically applies a rule switch immediately with no blocking confirmation; disabling emits a non-blocking risk warning, so `Ctrl+S` is no longer needed.

### Removed

- `/masking-config` in favor of the shorter `/masking` entry point.
- `/masking-test` because equivalent testing with rule attribution is embedded in `/masking` and the Rule Builder.
- `/masking-list`, `/masking-init`, and `/masking-rule`; their workflows are covered by `/masking`.

## [0.4.2] - 2026-08-22

### Fixed

- Reworked `/masking-history` scrolling to render and cache only the visible transcript window instead of eagerly rendering the complete conversation.
- Preserved fast back-navigation by caching rendered message blocks and correctly invalidating them when the theme or display mode changes.

## [0.4.1] - 2026-08-22

### Fixed

- Made `/masking-history` scrolling fast in long conversations by reusing the rendered transcript while paging, with automatic refresh when display settings or terminal width change.

## [0.4.0] - 2026-08-20

### Added

- Full-screen `/masking-list` and `/masking-history` views.
- Local-original, model-input, and comparison history modes with scrolling and replacement inspection.
- Tool-output expansion and thinking-block visibility controls in the history viewer.
- Persistent history snapshots and session keys, allowing history inspection and stable placeholders after restarting Pi.
- Persistent `/masking-toggle` state shared across sessions and projects.

### Changed

- History differences are highlighted without injecting brackets or parentheses into message text.
- Tool outputs use a 10-line collapsed preview.
- Public documentation was consolidated into a shorter README with clearer global/project configuration guidance.

### Removed

- `/masking-status`, `/masking-clear`, and `/masking-reload`; the status bar, full-screen viewers, automatic config refresh, and Pi lifecycle cover their use cases.
- The automatic per-round statistics panel and its unused in-memory history.
- Outdated internal design documents from the public repository.

## [0.3.0] - 2026-08-19

### Added

- First-seen provenance tracking for user, assistant, and tool-result values.
- `preserveStructure.keepPrefix` and `preserveStructure.keepIPv4Octets`.
- Low-entropy rule warnings and the `lowEntropy` acknowledgement field.
- Optional `systemPromptGuidance`.
- Deterministic HMAC-based placeholders scoped to a session.

### Changed

- Values first generated by the model remain unmasked for that session, while user and tool-result values register for protection.
- Example rules favor exact values and recognizable token structures instead of broad key-name matching.

## [0.2.1] - 2026-08-09

### Fixed

- Made repeated masking idempotent so the provider-boundary safety pass does not mask existing placeholders again.

## [0.2.0] - 2026-08-08

### Added

- Placeholder collision detection and retry.
- Config parsing, validation, warnings, and automatic refresh.
- System-prompt masking and a final provider-request safety boundary.
- Dynamic-map growth warnings.
- Unit tests and GitHub Actions CI.
- Expanded example rules for common credentials, tokens, private keys, network values, and contact data.

### Fixed

- Case-insensitive unmasking now follows the configured matching behavior.
- Config files created after session start are detected.

## [0.1.4] - 2026-07-02

### Added

- A key-name-based example regex for assignment-style secrets. This rule was later removed in 0.3.0 because it produced false positives and missed important value shapes.

> Historical note: the `v0.1.4` tag points to source whose `package.json` still reports `0.1.3`.

## [0.1.3] - 2026-07-01

### Added

- `/masking-test` for previewing transformations without sending text to the model.

## [0.1.2] - 2026-07-01

- Version metadata update; no functional source changes recorded.

## [0.1.1] - 2026-07-01

- Version metadata update; no functional source changes recorded.

## [0.1.0] - 2026-07-01

### Added

- Initial Pi extension with literal and regex masking rules.
- Format-preserving placeholders and reverse mapping for tool calls and assistant output.
- Global and project configuration support.
- Status display, masking controls, and example configuration.
