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
    return { value: probe.value, count: 0, held: [], warned: [] };
  }

  const hitRuleIds = new Set(probe.details.map((d) => d.ruleId));
  const constrained = [...hitRuleIds].filter((id) => opts.scopes.has(id));
  if (constrained.length === 0) {
    return { value: probe.value, count: probe.count, held: [], warned: [] };
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
  };
}
