# Changelog

- Replaced per-field two-line blocks with a compact field list and one stable,
  full-width active-field editor that separates values from contextual help.

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
- `/masking-config` for browsing, filtering, searching, testing, adding, editing, deleting, and reordering project/global rules without showing literal real values.
- Scope-aware, atomic rule-state writes with user-only file permissions on filesystems that support POSIX modes.
- A guided project/global initializer inside `/masking-config`, including preset selection, option preview, no-overwrite creation, and an optional project `.gitignore` entry.
- Ten built-in regex presets referenced by stable names and expanded at load time.
- Environment-backed literal rules through mutually exclusive `realFromEnv` values.
- `masking.config.schema.json` for editor completion and validation.
- Batch enable/disable, validated rule import, and non-overwriting redacted exports in the configuration center.
- Optional human-readable rule `name` values; the TUI now asks for a name, generates a readable collision-free `id`, and displays the name prominently while preserving legacy fallbacks.
- A shorter exact-literal creation flow with an explicit choice between automatic placeholders and exact custom replacements.

### Changed

- The status bar and reload notifications now distinguish active rules from all configured rules.
- `/masking-list` is now a compatibility alias for `/masking-config`.
- The packaged example is now a minimal configuration using presets and `realFromEnv`; advanced regex guidance remains in README.
- Pressing `Space` now atomically applies a rule switch immediately with no blocking confirmation; disabling emits a non-blocking risk warning, so `Ctrl+S` is no longer needed.

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
