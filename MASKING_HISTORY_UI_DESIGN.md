# Masking History UI Design

Status: proposed  
Scope: `/masking-history`

## Summary

Simplify the masking-history transcript and add a read-only rule-version view.
The main screen focuses on the local/model transcript and the selected masked
occurrence. Rule metadata and changes move to a dedicated screen opened with
`R`.

The UI must avoid the word `factual`. Internally, a factual entry means an
observation that actually crossed an outbound boundary rather than a
hypothetical replay, but `factual message` can incorrectly imply that the
message content is true.

## Main history screen

### Wide layout

```text
Masking history · Rule version 1/2 · 2 active rules · MODEL INPUT
Selected masked occurrence 1/3  LOCAL: wsl90.top → MODEL: test.internal
Underlined: masked text · Inverse highlight: selected occurrence

[conversation history]

[/] rule version · R view version rules · N/P next/previous occurrence · M original/masked · C compare · Ctrl+O tools · Ctrl+T thinking · Esc close
messages 48–50 of 50
```

The screen has three information areas:

1. **Top:** selected rule version, masking state, view mode, selected occurrence,
   and visual legend.
2. **Middle:** the transcript.
3. **Bottom:** keyboard controls and, when useful, scroll progress.

All lines must wrap or adapt to narrow terminals without clipping actionable
text.

### Header

Use:

```text
Masking history · Rule version 1/2 · 2 active rules · MODEL INPUT
```

`Rule version n/total` numbers only versions with recorded outbound
observations. Empty internal epochs remain hidden. The active-rule count belongs
on the same line because it describes the selected version, not the current
live configuration.

An active rule is enabled and available while global masking is enabled. Use
singular `1 active rule` where appropriate.

When global masking was disabled for the selected version, use:

```text
Masking history · Rule version 2/2 · Masking off · MODEL INPUT
```

Do not show any of the following in the header or a subtitle:

- `factual messages`;
- `Initial factual version`;
- a detailed change summary against the previous version.

`Version 1/2` already identifies the first displayed version. Detailed changes
belong on the version-rules screen.

### Selected occurrence

Place the occurrence inspector above the transcript:

```text
Selected masked occurrence 1/3  LOCAL: wsl90.top → MODEL: test.internal
```

The denominator counts changed text occurrences, not messages. Repeated uses of
the same mapping are separate occurrences. `N` and `P` navigate these
occurrences and keep the selected occurrence visible.

If the selected version has no changed occurrences, show:

```text
No masked text in this version
```

The inspector is status information, so it must not appear between the
transcript and the keyboard controls.

### Visual legend

Use terminology understandable without terminal-specific knowledge:

```text
Underlined: masked text · Inverse highlight: selected occurrence
```

The legend explains appearance only. The footer separately explains that `N`
and `P` change the selection. Do not use `Reverse video: current N/P target`.

In local-original and comparison modes, adapt the first clause as needed while
keeping `Inverse highlight: selected occurrence` consistent.

### Footer controls

Use the explicit rule-view action:

```text
R view version rules
```

Do not shorten it to `R rules`, which does not say whether the action views,
edits, or switches rules. The complete footer is:

```text
[/] rule version · R view version rules · N/P next/previous occurrence · M original/masked · C compare · Ctrl+O tools · Ctrl+T thinking · Esc close
```

Continue to omit controls that have no effect:

- omit `[/] rule version` when only one displayed version exists;
- omit `N/P next/previous occurrence` when fewer than two occurrences exist.

### Message progress

Do not show a message count in the header. The previous header count represented
all transcript records observed under the selected version, not messages that
contained masking, and it duplicated the footer's more useful progress.

When the transcript requires scrolling, show:

```text
messages 48–50 of 50
```

This means that the viewport intersects top-level displayed messages 48 through
50 out of 50. It is not an occurrence count, a line count, or a provider-request
count. Tool results embedded in tool-call cards are not separate top-level
messages for this progress indicator.

Hide progress when all top-level messages fit in the viewport. In particular,
do not show low-value progress such as:

```text
messages 1–3 of 3
```

## Version-rules screen

Pressing `R` opens a read-only description of the selected historical rule
version. Reuse the visual structure of the `/masking` configuration rule list
so users see familiar columns, but do not reuse its editing behavior.

### Layout

```text
Rules for history version 2/2
GLOBAL MASKING [ON] · 2 active / 3 configured

  STATE  ORDER  SCOPE    TYPE     NAME                 CHANGE
  [ON]       1  project  literal  Service token        UPDATED
  [ON]       2  global   preset   Private IP           MOVED 3→2
  [OFF]      3  project  regex    Legacy host          DISABLED

Removed since previous version:
- Old access token

Other changes:
- Case-sensitive matching enabled

↑↓ browse · [/] rule version · Esc back
```

### Rule columns

Reuse the `/masking` columns and add `CHANGE`:

| Column | Meaning |
| --- | --- |
| `STATE` | Historical rule state: `ON`, `OFF`, or `WAIT` when enabled but unavailable. |
| `ORDER` | Evaluation order in the selected version. |
| `SCOPE` | `project` or `global`. |
| `TYPE` | `literal`, `regex`, or `preset`. |
| `NAME` | Stored secret-free rule name. |
| `CHANGE` | Net change from the previous displayed history version. |

Supported `CHANGE` labels are:

- `ADDED`;
- `UPDATED`;
- `ENABLED`;
- `DISABLED`;
- `MOVED 3→2`.

Combine labels when one rule has multiple net changes, for example:

```text
ENABLED, UPDATED
```

A rule removed from the selected version cannot appear in the current table.
List it under `Removed since previous version` instead. Put global masking and
option changes, such as case-sensitive matching, under `Other changes`.

Changes are net changes between adjacent **displayed** history versions, not
between hidden unused internal epochs. Never attribute a change to a particular
rule when old persisted metadata can prove only that the overall configuration
changed; show a generic configuration change under `Other changes` instead.

For the first displayed version, the `CHANGE` column contains `—` and the
removed/other-change sections are omitted.

### Interaction

The version-rules screen is an audit view. It supports:

- `↑`/`↓` and paging to browse long rule lists;
- `[`/`]` to switch displayed history versions while remaining on the rules
  screen;
- `Esc` to return to the transcript for the same version.

It must not support:

- enabling or disabling rules;
- editing, adding, deleting, or reordering rules;
- revealing real values;
- testing rules;
- importing or exporting configuration.

Historical epoch metadata contains names, state, order, scope, type, and opaque
behavior fingerprints. It does not contain enough information to reconstruct
or reveal complete historical real values, replacements, patterns, or editable
configuration. The screen must not imply otherwise.

## Information model

The two screens have separate responsibilities:

- The main history screen answers: **What local and model-facing text was
  actually recorded under this rule version?**
- The version-rules screen answers: **Which rule metadata applied to this
  version, and how did it differ from the previous displayed version?**

This separation keeps the transcript uncluttered without losing the explanation
for why multiple rule versions exist.
