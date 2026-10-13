/**
 * The scoped-restoration decision flow for tool calls (design:
 * docs/egress-scoping-design.md + the three-mode ladder in
 * docs/egress-mode-redesign-notes.zh.md).
 *
 * Pure over its inputs: given the tool name, the raw arguments, and the
 * effective scopes of the active rules, it produces the arguments with only
 * the restorations that passed their rule's scope applied — violating rules
 * block the call outright — plus the per-rule violation/warn records for
 * the caller to report. No placeholders in the input means zero scope work.
 *
 * The matrix (mode × situation):
 *
 * | situation                        | strict | semi-strict   | permissive      |
 * |----------------------------------|--------|-----------|-----------------|
 * | destination verified             | restore| restore   | restore         |
 * | destination outside allowlist    | block  | block     | block           |
 * | outbound (signature), unverifiable| block  | warn      | warn            |
 * | local (no signature, no dest.)   | block  | block     | restore (+mark)|
 *
 * Failure is safe by construction: a violation blocks the call, so the
 * attacker is left holding at most a placeholder.
 */

import { extractDestinations } from "./destination-extract.ts";
import type { Masker } from "./masker.ts";import {
  compileDestinations,
  unmatchedDestinations,
  type DestinationMatcher,
  type EffectiveScope,
} from "./restore-scope.ts";

export interface ScopeViolation {
  ruleId: string;
  ruleName: string;
  /** tool: the rule's `tools` list excludes the current tool.
   *  destination: an extracted destination is not allowlisted.
   *  no-destination: no destination could be extracted — an outbound
   *  (network-signature) call under strict, or any local use under
   *  strict/semi-strict (use-not-copy). */
  reason: "tool" | "destination" | "no-destination";
  /** The disallowed tool name (reason=tool) or offending destinations
   *  (reason=destination); empty otherwise. */
  offending: string[];
}

/** Semi-strict/permissive notice: restored, but no destination could be checked
 *  (outbound call with a hidden destination — a detection gap, not a
 *  confirmed violation). */
export interface UnverifiedRestore {
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
  /** Rules whose scope the call violates — the caller must block the call. */
  violations: ScopeViolation[];
  /** Permissive confirmed violations: the value is restored, but the caller
   *  must ask the user before the call runs (decline → block). */
  confirm: ScopeViolation[];
  unverified: UnverifiedRestore[];
  /** Rule ids whose values were restored (hit minus violated) — the caller uses
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
   *  count). With a signature and no extractable destination the call sits
   *  in the detection-gap cell: strict blocks, semi-strict/permissive restore
   *  with a warning. Without a signature the call is local: permissive
   *  restores (the marker chain covers materialized values), strict and
   *  semi-strict block (use-not-copy). */
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
    return { value: probe.value, count: 0, violations: [], confirm: [], unverified: [], restoredRuleIds: [] };
  }

  const hitRuleIds = new Set(probe.details.map((d) => d.ruleId));
  const constrained = [...hitRuleIds].filter((id) => opts.scopes.has(id));
  if (constrained.length === 0) {
    return {
      value: probe.value,
      count: probe.count,
      violations: [],
      confirm: [],
      unverified: [],
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
  const violations = new Map<string, ScopeViolation>();
  const confirm = new Map<string, ScopeViolation>();
  const unverified = new Map<string, UnverifiedRestore>();

  const setViolation = (map: Map<string, ScopeViolation>, ruleId: string, reason: ScopeViolation["reason"], offending: string[]): void => {
    const existing = map.get(ruleId);
    if (existing) {
      const merged = new Set([...existing.offending, ...offending]);
      existing.offending = [...merged];
      return;
    }
    map.set(ruleId, { ruleId, ruleName: opts.ruleName(ruleId), reason, offending });
  };

  const allow = (ruleId: string): boolean => {
    const scope = opts.scopes.get(ruleId);
    if (!scope) return true;
    const name = opts.ruleName(ruleId);

    if (scope.tools && !scope.tools.includes(opts.toolName)) {
      // Permissive asks the user instead of blocking; the value is restored
      // and the caller blocks the call unless the user approves.
      if (scope.mode === "permissive") {
        setViolation(confirm, ruleId, "tool", [opts.toolName]);
        return true;
      }
      setViolation(violations, ruleId, "tool", [opts.toolName]);
      return false;
    }

    if (scope.destinations) {
      if (destinations.length === 0) {
        if (opts.commandSignature) {
          // Detection-gap cell: outbound intent, destination hidden
          // (`curl … "$URL"`). strict fails closed; semi-strict and
          // permissive restore with a warning.
          if (scope.mode === "strict") {
            setViolation(violations, ruleId, "no-destination", []);
            return false;
          }
          if (!unverified.has(ruleId)) {
            unverified.set(ruleId, { ruleId, ruleName: name, kind: "no-destination" });
          }
          return true;
        }
        // Local cell: no outbound form at all. permissive restores — the
        // marker chain covers materialized values. strict and semi-strict
        // enforce use-not-copy: the value only flows to allowlisted
        // destinations, and a local file or indirect process is not one.
        if (scope.mode === "permissive") return true;
        setViolation(violations, ruleId, "no-destination", []);
        return false;
      }
      const offending = unmatchedDestinations(destinations, matchersFor(scope));
      if (offending.length > 0) {
        // Confirmed violation: strict/semi-strict block; permissive asks the
        // user (restore now, caller blocks unless the user approves).
        if (scope.mode === "permissive") {
          setViolation(confirm, ruleId, "destination", offending);
          return true;
        }
        setViolation(violations, ruleId, "destination", offending);
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
    violations: [...violations.values()],
    confirm: [...confirm.values()],
    unverified: [...unverified.values()],
    restoredRuleIds: [...hitRuleIds].filter((id) => !violations.has(id)),
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
 * "File markers" + the three-mode ladder). The real value lives on disk —
 * if the call runs, the leak is already complete — so a confirmed
 * violation (destination outside the allowlist) blocks under strict/
 * semi-strict and asks the user under permissive, and the detection-gap
 * form (network signature, no verifiable destination) blocks under strict
 * while semi-strict/permissive allow the call with a warning. There is
 * nothing to hold back here: no placeholder is involved.
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
  /** Rule ids of the governing scopes that fired a blocking violation. */
  blocked: MarkedPathViolation[];
  /** Permissive confirmed violations: the caller must ask the user before
   *  the call runs (decline → block). */
  confirm: MarkedPathViolation[];
  /** Detection-gap violations the semi-strict/permissive modes allow with a
   *  warning. */
  unverified: MarkedPathViolation[];
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
  const unverified: MarkedPathViolation[] = [];

  for (const ruleId of referencedRuleIds) {
    const scope = opts.scopes.get(ruleId);
    if (!scope?.destinations) continue; // not governed by markers
    if (scope.destinations.length === 0) continue; // defensive: same rule

    let offending: string[] = [];
    if (opts.destinations.length > 0) {
      offending = unmatchedDestinations(opts.destinations, matchersFor(scope));
      if (offending.length === 0) continue; // all destinations allowlisted
      // Confirmed violation: strict/semi-strict block; permissive asks.
      const violation: MarkedPathViolation = { ruleId, ruleName: opts.ruleName(ruleId), offending };
      if (scope.mode === "permissive") confirm.push(violation);
      else blocked.push(violation);
    } else if (opts.signatureOnly) {
      // Detection gap: intent, no verified destination. strict fails
      // closed; semi-strict and permissive tolerate it with a warning.
      const violation: MarkedPathViolation = { ruleId, ruleName: opts.ruleName(ruleId), offending };
      if (scope.mode === "strict") blocked.push(violation);
      else unverified.push(violation);
    }
    // no egress intent at all — advisory state never blocks
  }

  return { blocked, confirm, unverified };
}
