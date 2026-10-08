/**
 * Per-rule restoration scope ("restoreScope"): declares where a rule's real
 * values may flow once restored into tool arguments. See
 * docs/egress-scoping-design.md.
 *
 * This module owns the scope vocabulary: the declared shape, its
 * materialization into an effective scope (preset defaults, env-name
 * fallback, strict/permissive mode), and dot-anchored destination matching
 * with host normalization (lowercase, trailing dot, punycode, IPv4
 * literal forms) and userinfo exclusion.
 */

/** Declared per-rule scope, exactly as it appears in the config file. */
export interface RestoreScope {
  /** Hosts the rule's values may be sent to (dot-anchored suffix match,
   *  IP literals, intranet wildcards). Present ⇒ tool calls with no
   *  extractable destination follow `mode`. */
  destinations?: string[];
  /** Tool names allowed to receive the restored value. */
  tools?: string[];
  /** Environment variable names bound to this rule (Phase 2: env-reference
   *  path). Defaults to the rule's `realFromEnv` name. */
  envNames?: string[];
  /** What to do when the scope cannot be verified:
   *  - strict: hold the restoration (placeholder stays) and notify;
   *  - permissive: restore and notify when no destination was extracted,
   *    hold only on a destination present but unmatched.
   *  Default: "strict" for preset rules with default destinations,
   *  "permissive" otherwise. */
  mode?: "strict" | "permissive";
}

export type ScopeMode = "strict" | "permissive";

/** Materialized scope used by the tool_call decision flow. Null = the rule
 *  carries no tool-call constraints (today's unconditional restoration). */
export interface EffectiveScope {
  destinations: string[] | undefined;
  tools: string[] | undefined;
  envNames: string[] | undefined;
  mode: ScopeMode;
}

/** Inputs to effectiveScope(): the declared scope plus the rule's origin. */
export interface ScopeMaterializationInput {
  scope: RestoreScope | undefined;
  /** Preset default destinations, or undefined for non-preset rules and
   *  presets without an issuing domain. */
  presetDestinations: string[] | undefined;
  sourceKind: "literal" | "regex" | "preset";
  realFromEnv: string | undefined;
}

/**
 * Materialize the declared scope. Returns null when neither an explicit
 * scope nor a preset default exists — the rule then restores unconditionally
 * (backward compatible). `envNames` alone does not constrain tool calls;
 * it participates once the env-reference path is enforced.
 */
export function effectiveScope(input: ScopeMaterializationInput): EffectiveScope | null {
  const declared = input.scope;
  const presetDefault = input.sourceKind === "preset" ? input.presetDestinations : undefined;
  if (!declared && !presetDefault) return null;

  const destinations = declared?.destinations ?? presetDefault;
  const envNames = declared?.envNames ?? (input.realFromEnv ? [input.realFromEnv] : undefined);
  const mode: ScopeMode =
    declared?.mode ?? (presetDefault !== undefined ? "strict" : "permissive");
  return { destinations, tools: declared?.tools, envNames, mode };
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
