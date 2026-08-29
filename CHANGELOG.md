# Changelog

All notable changes to this project are documented in this file.

The entries before 0.4.0 were reconstructed from the Git history and existing tags because the project did not previously publish GitHub Releases.

## [Unreleased]

## [0.6.0] - 2026-08-29

### Added

- Add save-time preflight for masking changes that may alter the model-facing
  prompt prefix and reduce provider prompt-cache reuse, identifying the earliest
  affected system prompt or conversation message before rules are written.
- Add rule-version auditing to `/masking-history`: navigate versions that reached
  the model with `[` and `]`, inspect rules and net changes with `R`, and retain
  immutable transcripts—including compacted messages—plus sanitized metadata
  and session-keyed boundary fingerprints without storing boundary plaintext.

### Changed

- Move the persistent global masking switch into `/masking` under the `M`
  shortcut, with disable confirmation and pending-run status.
- Cache masked output for unchanged history across requests, improving
  performance while preventing repeated masking and isolating cached values
  from external mutation.

### Removed

- Remove `/masking-toggle`; use `M` from within `/masking` instead.

### Fixed

- Improve `/masking-history` at narrow widths and correct comparison headings,
  controls, occurrence navigation, lexical highlighting, and message styling.
- Preserve the selected history display mode across rule versions and refresh
  masked history when rules change even if the source message does not.
- Fix package dependency metadata by declaring Pi core modules as peers,
  preventing duplicate Pi runtime installations.
- Keep all `/masking` workflows on a clean full-screen surface without flashing
  conversation history or blank intermediate screens.

## [0.5.0] - 2026-08-24

### Added

- Add the unified `/masking` configuration center for managing, ordering, testing, importing, and exporting project/global rules.
- Add per-rule enable switches, environment-backed literals, human-readable rule names, and automatic or custom placeholders.
- Add ten built-in presets and a JSON Schema for configuration validation and editor completion.
- Add advisory diagnostics for custom regexes that may cause excessive backtracking.
- Add local rule testing to the configuration home screen and Rule Builder.

### Changed

- Make first-seen provenance immutable for the entire conversation, preserving stable model-facing history and prompt-cache prefixes.
- Apply rule toggles and reordering in place while preserving configuration-screen state.
- Reduce the public command set to `/masking`, `/masking-toggle`, and `/masking-history`.
- Update Pi runtime dependencies to 0.84.2, resolving audited transitive vulnerabilities.
- Rewrite the README around quick start, security boundaries, masking limitations, placeholder generation, and performance.

### Fixed

- Keep the last valid configuration active during transient read or parse failures.
- Roll back multi-file configuration changes when a later write fails.
- Preserve Rule Builder drafts after save failures and confirm before discarding changed drafts.
- Fix Enter handling in Rule Builder text fields.

### Removed

- Remove `/masking-config`, `/masking-test`, `/masking-list`, `/masking-init`, and `/masking-rule`; their workflows are now covered by `/masking`.

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
