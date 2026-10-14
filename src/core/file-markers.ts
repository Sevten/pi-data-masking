/**
 * Session-scoped file-marker registry (design: docs/egress-scoping-design.md,
 * "File markers (staging path)").
 *
 * When a masked value is restored into a write-like tool, the destination
 * path is marked "contains values of rule X". A later call whose arguments
 * reference a marked path AND carry egress intent (extracted destination or
 * network signature) is checked against the marked rule's scope — the value
 * is on disk because of our restoration, so the custody chain extends one
 * hop. The registry is advisory state: calls with no destination and no
 * signature (local reads, diffs, greps) are never affected.
 *
 * Pure state + pure helpers; all policy lives in egress-decision.ts.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** Expand `~` and resolve relative paths against `cwd`. Lexical only — no
 *  filesystem access, so non-existent future paths normalize fine. */
export function normalizePath(path: string, cwd: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(cwd, trimmed);
}

export interface FileMarkerRegistry {
  /** Union `ruleIds` into the set for `path` (normalized). */
  mark(path: string, cwd: string, ruleIds: ReadonlySet<string>): void;
  /** Rule ids governing this exact path (normalized), or an empty set. */
  ruleIdsFor(path: string, cwd: string): ReadonlySet<string>;
  markedPaths(): readonly string[];
  /** Replace all state from a persisted snapshot (paths must already be
   *  normalized; used by session resume). */
  restore(markers: Record<string, string[]>): void;
  clear(): void;
}

export function createFileMarkerRegistry(): FileMarkerRegistry {
  const byPath = new Map<string, Set<string>>();
  return {
    mark(path, cwd, ruleIds) {
      if (ruleIds.size === 0) return;
      const key = normalizePath(path, cwd);
      const set = byPath.get(key);
      if (set) {
        for (const id of ruleIds) set.add(id);
      } else {
        byPath.set(key, new Set(ruleIds));
      }
    },
    ruleIdsFor(path, cwd) {
      return byPath.get(normalizePath(path, cwd)) ?? new Set<string>();
    },
    markedPaths() {
      return [...byPath.keys()];
    },
    restore(markers) {
      byPath.clear();
      for (const [path, ruleIds] of Object.entries(markers)) {
        if (ruleIds.length > 0) byPath.set(path, new Set(ruleIds));
      }
    },
    clear() {
      byPath.clear();
    },
  };
}

/** Every string in the input tree (values only; keys are tool schema names,
 *  not attacker-controlled text). */
function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* stringsIn(item);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) yield* stringsIn(item);
  }
}

export interface PathReference {
  path: string;
  ruleIds: string[];
}

/** Marked paths referenced anywhere in the arguments. A path counts as
 *  referenced when it appears as a substring of any argument string —
 *  `-d @/srv/app/.env`, `"$(cat /srv/app/.env)"`, `curl --data-binary
 *  /srv/app/.env https://…` all match. Substring matching is the point:
 *  we cannot parse every shell quoting style, and for an *intent-bearing*
 *  call (the only time this is consulted) erring toward checking is safe. */
export function referencedMarkedPaths(
  registry: FileMarkerRegistry,
  input: unknown,
  cwd: string,
): PathReference[] {
  const args = [...stringsIn(input)].join("\n");
  const refs: PathReference[] = [];
  for (const path of registry.markedPaths()) {
    if (args.includes(path)) {
      refs.push({ path, ruleIds: [...registry.ruleIdsFor(path, cwd)] });
    }
  }
  return refs;
}

/** Substrings whose presence in a tool-call input means the call touches the
 *  persisted secret stores (the pi sessions directory and the masking config
 *  file). Absolute forms catch a custom PI_CODING_AGENT_DIR; the `.pi/agent`
 *  relative form catches `~`/`$HOME` spellings of the default layout; the
 *  bare config filename catches any copy of the config by its name. */
export function persistedSecretPathForms(sessionsDir: string, configPath: string): string[] {
  return [
    sessionsDir,
    sessionsDir.replaceAll("/", "\\"),
    ".pi/agent/sessions",
    ".pi\\agent\\sessions",
    configPath,
    "masking.config.json",
  ];
}

/** True when a tool-call input references a persisted secret store (see
 *  persistedSecretPathForms). These files hold restored values and every
 *  rule's `real` in plaintext no matter how rules are scoped, so an egress
 *  reference is governed by the built-in Session history pseudo-rule. */
export function referencesPersistedSecrets(input: unknown, forms: string[]): boolean {
  for (const value of stringsIn(input)) {
    for (const form of forms) {
      if (value.includes(form)) return true;
    }
  }
  return false;
}

/** Structured path arguments of write-like tools (`write`/`edit` put the
 *  target under `path`; bash/powershell redirect targets are extracted so a
 *  restored value written via `echo … > f` / `tee f` still marks the file). */
export function structuredTargetPaths(toolName: string, input: unknown): string[] {
  if (toolName === "write" || toolName === "edit") {
    const path = (input as Record<string, unknown> | null)?.path;
    return typeof path === "string" && path.trim() ? [path] : [];
  }
  if (toolName === "bash" || toolName === "powershell") {
    const command = (input as Record<string, unknown> | null)?.command;
    if (typeof command !== "string") return [];
    return bashRedirectTargets(command);
  }
  return [];
}

/** File targets of shell output redirects (`> f`, `>> f`) and `tee f`. A
 *  miss only means a missing advisory marker, never a wrong block. FD-prefixed
 *  redirects (`2>/dev/null`, `1>&2`) and process substitution are ignored. */
export function bashRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  for (const segment of command.split(/(?:;|&&|\|\||\||\n)/)) {
    const tokens = tokenize(segment);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!;
      // `>f`, `>>f` as standalone tokens, or fused `>f` when the shell
      // tokenization kept them together.
      const m = /^(>>?)([^\s;&|].*)?$/.exec(tok);
      if (m) {
        const raw = m[2] ?? tokens[i + 1];
        if (raw) targets.push(stripQuotes(raw));
        continue;
      }
      if ((tok === "tee" || tok === "!tee") && tokens[i + 1] && !tokens[i + 1]!.startsWith("-")) {
        // Last non-flag operand of tee is the file (multiple files allowed;
        // each receives the stream).
        for (let j = i + 1; j < tokens.length; j++) {
          const t = tokens[j]!;
          if (t.startsWith("-")) continue;
          targets.push(stripQuotes(t));
        }
      }
    }
  }
  return [...new Set(targets)];
}

function stripQuotes(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** `cp`/`mv`/`rsync` propagation: when a copy/move-style command references
 *  a marked source path, the destination inherits the source's rule set.
 *  Best-effort token scan (single-source forms); a miss only means the
 *  advisory registry lacks one entry, never a wrong block. */
export function propagateCopies(
  command: string,
  registry: FileMarkerRegistry,
  cwd: string,
): void {
  for (const segment of command.split(/(?:;|&&|\|\||\||\n)/)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    if (!COPY_COMMANDS.has(tokens[0])) continue;

    // Last non-flag token is the destination; a flag's value (e.g.
    // rsync's `--rsh=ssh`, `-e ssh`) is excluded by skipping the token
    // after a lone short/long flag.
    const operands: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.startsWith("-")) {
        // `-T target` / `--prefix target` style: skip the value token.
        if (!tok.includes("=") && (tok === "-T" || tok === "--limit" || tok === "--port")) i++;
        continue;
      }
      operands.push(tok);
    }
    if (operands.length < 2) continue;
    const dst = operands[operands.length - 1];
    const sources = operands.slice(0, -1);

    for (const src of sources) {
      const srcKey = normalizePath(src, cwd);
      const ruleIds = registry.ruleIdsFor(srcKey, cwd);
      if (ruleIds.size > 0) {
        registry.mark(dst, cwd, ruleIds);
      }
    }
  }
}

const COPY_COMMANDS = new Set(["cp", "mv", "rsync"]);

/** Quote-aware-enough tokenizer: strips one level of quotes so `cp a "b c"`
 *  yields `b c`; everything else splits on whitespace. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasContent = false;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasContent = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasContent) tokens.push(current);
      current = "";
      hasContent = false;
      continue;
    }
    current += ch;
    hasContent = true;
  }
  if (hasContent) tokens.push(current);
  return tokens;
}

/** Whether `path` (already normalized) refers to the same file as a marked
 *  entry — used by tests and future read-marking; not needed for lookups
 *  today because references go through substring matching. */
export function samePath(a: string, b: string, cwd: string): boolean {
  return normalizePath(a, cwd) === normalizePath(b, cwd);
}
