/**
 * Per-rule restoration scope ("restoreScope"): declares where a rule's real
 * values may flow once restored into tool arguments. See
 * docs/egress-scoping-design.md.
 *
 * This module owns the scope vocabulary: the declared shape, its
 * materialization into an effective scope, and dot-anchored destination
 * matching with host normalization (lowercase, trailing dot, punycode, IPv4
 * literal forms) and userinfo exclusion.
 *
 * Config semantics: a rule either has no `restoreScope` (restores
 * unconditionally) or a fully explicit one — `mode` and `onRefuse` are
 * required and validated at load time. There is no value derivation from
 * rule origin; presets are a Rule Builder template that materializes.
 */

/** Declared per-rule scope, exactly as it appears in the config file. */
export interface RestoreScope {
  /** Hosts the rule's values may be sent to (dot-anchored suffix match,
   *  IP literals, intranet wildcards). Optional allowlist: present ⇒ calls
   *  to other destinations are confirmed violations; [] = never outbound;
   *  absent (unified "Anywhere") ⇒ no destination checks, but `mode`
   *  still governs every call (detection-gap and local cells included). */
  destinations?: string[];
  /** Tool names allowed to receive the restored value. */
  tools?: string[];
  /** Environment variable names bound to this rule (Phase 2: env-reference
   *  path). Defaults to the rule's `realFromEnv` name. */
  envNames?: string[];
  /** What to restore, per situation (design notes:
 *  docs/egress-mode-redesign-notes.zh.md — three-mode ladder):
 *  - strict: restore only when the destination is verified — blocks
 *    confirmed violations, outbound calls whose destination cannot be
 *    verified, and local use (use-not-copy: the value only flows to
 *    allowlisted destinations);
 *  - semi-strict: also restore local use (the marker chain covers
 *    materialized values), but still block confirmed violations and
 *    outbound calls with an unverifiable destination;
 *  - permissive: also restore outbound calls with an unverifiable
 *    destination (with a warning); confirmed violations are refused in
 *    every mode.
 *  Required: the config file always states the effective mode. */
  mode: ScopeMode;
  /** What to do when the mode refuses to restore (confirmed violations in
   *  every mode, plus the gap/local cells the mode withholds): "block"
   *  refuses the call outright and tells the model why; "ask" pauses for
   *  the user's approval (approve releases this one call, decline blocks
   *  it; no UI means decline). The mode decides what is refused, this
   *  decides who refuses it. Required: always explicit. */
  onRefuse: RefuseAction;
}

export type ScopeMode = "strict" | "semi-strict" | "permissive";
export type RefuseAction = "block" | "ask";

/** Materialized scope used by the tool_call decision flow. Null = the rule
 *  carries no tool-call constraints (today's unconditional restoration). */
export interface EffectiveScope {
  destinations: string[] | undefined;
  tools: string[] | undefined;
  envNames: string[] | undefined;
  mode: ScopeMode;
  /** Effective refusal action: always declared (required in config). */
  onRefuse: RefuseAction;
}

/** Inputs to effectiveScope(): the declared scope plus rule-level context. */
export interface ScopeMaterializationInput {
  scope: RestoreScope | undefined;
  /** Environment variable name backing the rule (envNames fallback). */
  realFromEnv: string | undefined;
  /** Global `options.trustedDestinations`, validated at load time. Merged
   *  (union) into rules that declare a destination allowlist — it widens
   *  the set of verifiable destinations for those rules but never creates
   *  an allowlist where none was declared, and never touches the tools
   *  check. */
  trustedDestinations?: string[];
}

/**
 * Materialize the declared scope. Returns null when no scope is declared —
 * the rule then restores unconditionally. `mode` and `onRefuse` are carried
 * through verbatim (required and validated at load time; no derivation).
 * `envNames` alone does not constrain tool calls; it participates once the
 * env-reference path is enforced.
 */
export function effectiveScope(input: ScopeMaterializationInput): EffectiveScope | null {
  const declared = input.scope;
  if (!declared) return null;

  const destinations = unionDestinations(
    declared.destinations,
    input.trustedDestinations,
  );
  const envNames = declared.envNames ?? (input.realFromEnv ? [input.realFromEnv] : undefined);
  return {
    destinations,
    tools: declared.tools,
    envNames,
    mode: declared.mode,
    onRefuse: declared.onRefuse,
  };
}

/** Merge the global trusted-destination list into a rule's declared
 *  destination allowlist (order-preserving dedupe: rule/preset entries
 *  first, trusted entries after). Rules without a destinations key stay
 *  without one — the global list must not silently turn "Anywhere" into
 *  an allowlist. An explicit empty allowlist is absolute — the value may
 *  never go outbound — so the global list does not widen it back open. */
function unionDestinations(
  base: string[] | undefined,
  trusted: string[] | undefined,
): string[] | undefined {
  if (base === undefined || base.length === 0) return base;
  if (!trusted || trusted.length === 0) return base;
  return [...new Set([...base, ...trusted])];
}

// ─── Host normalization ─────────────────────────────────────────────────────

/**
 * Canonical form of a host for comparison: lowercase, no trailing dot,
 * IDN → punycode, and IPv4 literal forms decoded (WHATWG URL rules, so
 * `2130706433` → `127.0.0.1`). Returns null for values that are not
 * plausible hosts. Userinfo must be stripped by the caller/extractor —
 * never passed in.
 */
export function normalizeHost(raw: string): string | null {
  const trimmed = raw.trim().replace(/\.$/, "").toLowerCase();
  if (!trimmed || /[*?]/.test(trimmed)) return null;
  // Reject anything with separators that indicate we were handed more than
  // a bare host (paths, queries, userinfo, ports are handled upstream).
  if (/[\/?#%@]/.test(trimmed) || trimmed.includes(":")) {
    // Allow bracketed IPv6 literals.
    if (/^\[[0-9a-f:]+\]$/.test(trimmed)) return trimmed.slice(1, -1);
    return null;
  }
  try {
    const host = new URL(`http://${trimmed}`).hostname;
    return host || null;
  } catch {
    return null;
  }
}

// ─── Destination entry matching ─────────────────────────────────────────────

const LABEL = "[^.]+";
/** One entry, pre-parsed for repeated matching. Built at config load time. */
export interface DestinationMatcher {
  entry: string;
  test(host: string): boolean;
}

/**
 * Compile one `destinations` entry. Supported shapes:
 * - domain: dot-anchored suffix match (`stripe.com` covers `api.stripe.com`,
 *   not `api.stripe.com.evil.com`);
 * - IP literal: exact match after normalization;
 * - `*.internal.acme.com`: the leading `*.` matches exactly one label;
 * - `10.0.*`: the trailing `.*` matches one or more additional labels.
 */
export function compileDestination(entry: string): DestinationMatcher | null {
  const raw = entry.trim().toLowerCase().replace(/\.$/, "");
  if (!raw) return null;

  if (raw.startsWith("*.")) {
    const rest = raw.slice(2);
    if (!rest || rest.includes("*")) return null;
    const suffix = rest.split(".").map(escapeRe).join("\\.");
    return { entry: raw, test: (h) => regexTest(`^${LABEL}\\.${suffix}$`, h) };
  }
  if (raw.endsWith(".*")) {
    const rest = raw.slice(0, -2);
    if (!rest || rest.includes("*")) return null;
    const prefix = rest.split(".").map(escapeRe).join("\\.");
    return { entry: raw, test: (h) => regexTest(`^${prefix}\\.${LABEL}(?:\\.${LABEL})*$`, h) };
  }
  if (raw.includes("*")) return null;

  const normalized = normalizeHost(raw);
  if (!normalized) return null;
  return {
    entry: raw,
    test: (h) => {
      const candidate = normalizeHost(h);
      if (!candidate) return false;
      return candidate === normalized || candidate.endsWith(`.${normalized}`);
    },
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function regexTest(source: string, host: string): boolean {
  try {
    return new RegExp(source, "i").test(host);
  } catch {
    return false;
  }
}

/** Compile a destination list; invalid entries are dropped (callers report
 *  them at parse time). */
export function compileDestinations(entries: string[]): DestinationMatcher[] {
  const out: DestinationMatcher[] = [];
  for (const entry of entries) {
    const matcher = compileDestination(entry);
    if (matcher) out.push(matcher);
  }
  return out;
}

/** Destinations (normalized hosts) not covered by the allowlist. */
export function unmatchedDestinations(
  destinations: string[],
  allowlist: DestinationMatcher[],
): string[] {
  const offending: string[] = [];
  for (const destination of destinations) {
    if (!allowlist.some((matcher) => matcher.test(destination))) offending.push(destination);
  }
  return offending;
}
