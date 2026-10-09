/**
 * The scoped-restoration decision flow for tool calls (design:
 * docs/egress-scoping-design.md, "Decision flow on each tool call").
 *
 * Pure over its inputs: given the tool name, the raw arguments, and the
 * effective scopes of the active rules, it produces the arguments with only
 * the restorations that passed their rule's scope applied — held-back rules
 * keep their placeholders — plus the per-rule hold/warn records for the
 * caller to report. No placeholders in the input means zero scope work.
 *
 * Failure is safe by construction: anything uncertain stays a placeholder,
 * and the attacker is left holding at most a placeholder.
 */

import { extractDestinations } from "./destination-extract.ts";
import type { Masker } from "./masker.ts";import {
  compileDestinations,
  unmatchedDestinations,
  type DestinationMatcher,
  type EffectiveScope,
} from "./restore-scope.ts";

export interface HeldRestore {
  ruleId: string;
  ruleName: string;
  /** tool: the rule's `tools` list excludes the current tool.
   *  destination: an extracted destination is not allowlisted.
   *  no-destination: strict mode and no destination could be extracted. */
  reason: "tool" | "destination" | "no-destination";
  /** The disallowed tool name (reason=tool) or offending destinations
   *  (reason=destination); empty otherwise. */
  offending: string[];
}

/** Permissive-mode notice: restored, but no destination could be checked. */
export interface ScopeWarning {
  ruleId: string;
  ruleName: string;
  kind: "no-destination";
}

export interface ToolCallDecision {
  /** Arguments with passing restorations applied, in the same shape as the
   *  input (top level is a fresh object; write its keys back in place). */
  value: unknown;
  /** Number of restored occurrences (0 = nothing restored). */
  count: number;
  held: HeldRestore[];
  warned: ScopeWarning[];
  /** Rule ids whose values were restored (hit minus held) — the caller uses
   *  this to mark write targets (file markers). */
  restoredRuleIds: string[];
}

export interface DecisionOptions {
  toolName: string;
  /** ruleId → effective scope; rules without an entry restore
   *  unconditionally (today's behavior). */
  scopes: ReadonlyMap<string, EffectiveScope>;
  /** Display name for a rule id, for reports. */
  ruleName: (ruleId: string) => string;
  /** True when the call runs a known outbound tool at command position
   *  (computed for bash-like tools only — write/edit contents must not
   *  count). With a signature and no extractable destination, permissive
   *  rules hold too: outbound intent is present, the destination is just
   *  hidden (`curl … "$URL"`), so permissive stays loose only for calls
   *  with no outbound form at all. */
  commandSignature?: boolean;
}

/** Compiled allowlists live as long as the scope object they belong to. */
const matcherCache = new WeakMap<EffectiveScope, DestinationMatcher[]>();

function matchersFor(scope: EffectiveScope): DestinationMatcher[] {
  let matchers = matcherCache.get(scope);
  if (!matchers) {
    matchers = compileDestinations(scope.destinations ?? []);
    matcherCache.set(scope, matchers);
  }
  return matchers;
}

export function decideToolCallRestore(
  masker: Masker,
  input: unknown,
  opts: DecisionOptions,
): ToolCallDecision {
  const probe = masker.unmaskValue(input);
  if (probe.count === 0) {
    return { value: probe.value, count: 0, held: [], warned: [], restoredRuleIds: [] };
  }

  const hitRuleIds = new Set(probe.details.map((d) => d.ruleId));
  const constrained = [...hitRuleIds].filter((id) => opts.scopes.has(id));
  if (constrained.length === 0) {
    return {
      value: probe.value,
      count: probe.count,
      held: [],
      warned: [],
      restoredRuleIds: [...hitRuleIds],
    };
  }

  const destinations = extractDestinations(input);
  // Env-var destination resolution: `$VAR`/`${VAR}` references resolved
  // from the extension's environment and fed through the same extraction,
  // so a destination kept in a variable (`curl … "$DEPLOY_URL"`) becomes
  // verifiable instead of a blind hold. Best-effort: session-mid exports
  // are invisible → the value simply contributes nothing. Variables bound
  // to rule secrets are never resolved (they are not destinations, and
  // their values must not flow anywhere).
  {
    const skipEnv = new Set<string>();
    for (const scope of opts.scopes.values()) {
      for (const name of scope.envNames ?? []) skipEnv.add(name);
    }
    for (const hint of envDestinationHints(input, skipEnv)) {
      if (!destinations.includes(hint)) destinations.push(hint);
    }
  }
  const held = new Map<string, HeldRestore>();
  const warned = new Map<string, ScopeWarning>();

  const setHold = (ruleId: string, reason: HeldRestore["reason"], offending: string[]): void => {
    const existing = held.get(ruleId);
    if (existing) {
      const merged = new Set([...existing.offending, ...offending]);
      existing.offending = [...merged];
      return;
    }
    held.set(ruleId, { ruleId, ruleName: opts.ruleName(ruleId), reason, offending });
  };

  const allow = (ruleId: string): boolean => {
    const scope = opts.scopes.get(ruleId);
    if (!scope) return true;
    const name = opts.ruleName(ruleId);

    if (scope.tools && !scope.tools.includes(opts.toolName)) {
      setHold(ruleId, "tool", [opts.toolName]);
      return false;
    }

    if (scope.destinations) {
      if (destinations.length === 0) {
        // Design (2026-10-09): a network signature with no extractable
        // destination is treated as destination-present-but-unmatched —
        // held in both modes. Permissive stays loose only for calls with
        // no outbound form at all (`echo`, local writes, computation).
        if (scope.mode === "strict" || opts.commandSignature) {
          setHold(ruleId, "no-destination", []);
          return false;
        }
        if (!warned.has(ruleId)) {
          warned.set(ruleId, { ruleId, ruleName: name, kind: "no-destination" });
        }
        return true;
      }
      const offending = unmatchedDestinations(destinations, matchersFor(scope));
      if (offending.length > 0) {
        setHold(ruleId, "destination", offending);
        return false;
      }
      return true;
    }
    return true;
  };

  const result = masker.unmaskValue(input, { allowRuleId: allow });
  return {
    value: result.value,
    count: result.count,
    held: [...held.values()],
    warned: [...warned.values()],
    restoredRuleIds: [...hitRuleIds].filter((id) => !held.has(id)),
  };
}

// ── Env-var destination resolution ────────────────────────────────

/** `$env:NAME` | `${NAME}` | `$NAME` (same shapes as envNameReferenced). */
const ENV_REF =
  /\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_])/g;

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

/**
 * Destinations hidden behind environment-variable references in the
 * arguments: each `$NAME` is resolved from the extension's environment and
 * the resolved value is fed through the same destination extraction. Best-
 * effort only — session-mid exports are invisible and contribute nothing.
 * Secret-bound variable names (skip) are never resolved, and resolved
 * values never leave this function: only extracted hosts do.
 */
export function envDestinationHints(
  input: unknown,
  skip: ReadonlySet<string>,
): string[] {
  const strings: string[] = [];
  collectStrings(input, strings);
  const text = strings.join("\n");
  if (!text.includes("$")) return [];
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env) return [];
  const hints = new Set<string>();
  for (const match of text.matchAll(ENV_REF)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (!name || skip.has(name)) continue;
    const value = env[name];
    if (typeof value !== "string" || value.length === 0 || value.length > 2000) continue;
    for (const destination of extractDestinations(value)) hints.add(destination);
  }
  return [...hints];
}

// ── Marker dimension: read-result marking ─────────────────────────────

/**
 * Rule ids whose placeholders appear in a text blob — the read-result
 * marking probe (design: "File markers", read-result marking). When the
 * masked result of a read-like call contains values of rule X and the call
 * referenced path F, the caller marks "F contains values of rule X" so the
 * custody chain covers values that already lived on disk before the
 * session. Pure probe: no restoration is written anywhere.
 */
export function ruleIdsInText(masker: Masker, text: string): Set<string> {
  if (!text) return new Set();
  const probe = masker.unmaskValue(text);
  return new Set(probe.details.map((d) => d.ruleId));
}

// ── Env-reference dimension: $NAME references ───────────────────────────

/**
 * Rule ids whose environment-variable names are referenced in a command —
 * `$NAME`, `${NAME}`, or Windows `$env:NAME` (design: "Env-name binding").
 * The real value lives in the environment, so a referencing command is
 * governed like a marked path: egress intent + unverifiable destination →
 * block (strict) or confirm (permissive). Same word-boundary rule as the
 * shell: `$STRIPE_KEY` does not match inside `$STRIPE_KEY_FULL`.
 */
export function referencedEnvRuleIds(
  command: string,
  scopes: ReadonlyMap<string, EffectiveScope>,
): Set<string> {
  const hits = new Set<string>();
  for (const [ruleId, scope] of scopes) {
    if (scope.envNames?.some((name) => envNameReferenced(command, name))) {
      hits.add(ruleId);
    }
  }
  return hits;
}

function envNameReferenced(command: string, name: string): boolean {
  // Only plain shell-variable names are matchable; anything else in
  // envNames is skipped rather than risked as a regex.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\$env:${escaped}(?![A-Za-z0-9_])|\\$\\{${escaped}\\}|\\$${escaped}(?![A-Za-z0-9_])`,
  ).test(command);
}

// ── Marker dimension: marked-path egress check ─────────────────────────────

/**
 * Decision for a call whose arguments reference a marked path (design:
 * "File markers" + "Hold vs block"). The real value lives on disk — if the
 * call runs, the leak is already complete — so violations block (strict) or
 * confirm (permissive) instead of holding a placeholder.
 *
 * Triggered only by egress intent: an extractable destination or a network
 * signature. Calls with neither are never checked here (local reads, diffs
 * and greps stay untouched). Rules without a destination allowlist are not
 * governed by the marker dimension (scopeless rules create no scope).
 */

export interface MarkedPathViolation {
  ruleId: string;
  ruleName: string;
  /** The offending destinations; empty when the trigger was a network
   *  signature with no verifiable destination. */
  offending: string[];
}

export interface MarkedPathDecision {
  /** Rule ids of the governing scopes that fired a violation. */
  blocked: MarkedPathViolation[];
  /** Permissive violations the user should confirm. */
  confirm: MarkedPathViolation[];
}

export interface MarkedPathOptions {
  /** Effective scopes of the marked rules only (ruleId → scope). Rules
   *  without a destination allowlist can be omitted — they are skipped. */
  scopes: ReadonlyMap<string, EffectiveScope>;
  ruleName: (ruleId: string) => string;
  /** Destinations extracted from the call arguments. */
  destinations: string[];
  /** Whether the command shows outbound intent without a destination
   *  (bash network signature). Both modes treat this as
   *  destination-present-but-unverifiable. */
  signatureOnly: boolean;
}

export function decideMarkedPaths(
  referencedRuleIds: ReadonlySet<string>,
  opts: MarkedPathOptions,
): MarkedPathDecision {
  const blocked: MarkedPathViolation[] = [];
  const confirm: MarkedPathViolation[] = [];

  for (const ruleId of referencedRuleIds) {
    const scope = opts.scopes.get(ruleId);
    if (!scope?.destinations) continue; // not governed by markers
    if (scope.destinations.length === 0) continue; // defensive: same rule

    let offending: string[] = [];
    if (opts.destinations.length > 0) {
      offending = unmatchedDestinations(opts.destinations, matchersFor(scope));
      if (offending.length === 0) continue; // all destinations allowlisted
    } else if (!opts.signatureOnly) {
      continue; // no egress intent at all — advisory state never blocks
    }
    // signatureOnly with zero destinations lands here: intent, no verified
    // destination — the tightened form of decision-flow step 5.

    const violation: MarkedPathViolation = {
      ruleId,
      ruleName: opts.ruleName(ruleId),
      offending,
    };
    if (scope.mode === "strict") blocked.push(violation);
    else confirm.push(violation);
  }

  return { blocked, confirm };
}
