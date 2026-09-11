# Changelog

## [Unreleased]

### Added

- New opt-in system-prompt guidance contract (`options.systemPromptGuidance`, now
  editable in the `/masking` home screen's settings zone): counters LLM secret-handling heuristics
  (sampled head/tail/length comparison, encoding instead of comparing) by
  granting exact full-string equality, requiring verbatim passthrough into
  tool calls, routing transformations through tools, and ending with an escape
  hatch — inexplicable contradictions should be described to the user, never
  investigated by hunting for the original values.
- Opt-in placeholder disclosure: `options.disclosePlaceholders` (global
  switch) with tri-state per-rule `disclosePlaceholder` overrides lists the
  session's literal-rule placeholders in the guidance note, grouped by
  structure fidelity. Disclosure requires guidance and enables it
  automatically; WAIT-state env rules are skipped; regex placeholders are
  never listed. All cache-impacting changes run through the existing save-time
  preflight.
- One-time upgrade notice for existing users pointing at the new settings
  screen (never shown on fresh installs, never repeated).

### Fixed

- Fix `/masking-history` showing the previous branch's history after `/tree`
  navigation: branch-derived state (transcript, rule epochs, epoch transcripts)
  is now also rebuilt on `session_tree`, not only on `session_start`.
- Fix live streaming in @jmfederico/pi-web still showing masked placeholders:
  register the provider stream wrappers at extension load time so the
  registration survives pi-web's post-bootstrap provider freeze; real values
  now appear from the first streaming delta. Other hosts and web UIs that load
  extensions normally already benefited from data-level stream restoration and
  are unaffected.

## [0.6.2] - 2026-09-01

### Added

- Real values now appear from the first streaming delta in every UI, including
  pi's web client: assistant text and thinking are restored live as the model
  streams them, so long thinking output no longer leaves masked placeholders
  in the terminal scrollback after completion.
- Tool arguments are still restored only at tool execution; stream transform
  failures fall back to passing events through untouched, so a transform bug
  can never break streaming.
- Warn when a literal value or custom placeholder collides with a bundled
  common term (e.g. a word that also appears in normal prose), so ambiguous
  rules are caught before they cause accidental unmasking.

### Changed

- The `/masking` configuration home is faster to navigate, with direct JSON
  editing, sensitive-value visibility controls, and clearer compact layouts.
- Creating a global rule is simpler: global scope by default, generated IDs,
  immediate test previews, and validation when saving.

### Fixed

- `/masking-history` comparisons no longer repeatedly rewind a shared prefix
  to the start of a word without making progress.

## [0.6.1] - 2026-08-29

### Added

- Add a built-in preset for publicly routable IPv4 addresses, excluding private
  and common special-use ranges.

### Changed

- Clarify that the private IPv4 preset preserves its first two octets by default.
- Expand the README with common use cases and FAQs, and clarify the masking
  boundary and the benefits and limitations of structure-preserving placeholders.

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
