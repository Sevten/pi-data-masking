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
import type { Masker } from "./masker.ts";
import {
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
        if (scope.mode === "strict") {
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
