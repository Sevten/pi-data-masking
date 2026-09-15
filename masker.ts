/**
 * masker.ts
 * Masking engine — bidirectional replacement combining exact literal
 * matching and fuzzy regex matching.
 *
 * Exposes the Masker class, which masks and unmasks both plain strings and
 * arbitrarily nested objects.
 *
 * Two rule kinds:
 *  - Literal (type omitted or "literal"): real is known at config-load time;
 *    placeholder is either hand-written or generated once by config-loader
 *    via placeholder-gen.
 *  - Regex (type: "regex"): real is unknown until a match occurs at
 *    runtime, so the placeholder must be generated lazily during mask() and
 *    recorded in the caller-owned dynamicMap (held by index.ts for the
 *    whole session) so that: 1) the same real value always reuses the same
 *    placeholder within a session; 2) unmask() can look it back up exactly.
 *
 * Capture groups:
 *  - If the regex has capture groups (e.g. `token=(\w+)`), only the
 *    captured substring gets a placeholder; the rest of the match (e.g.
 *    `token=`) is left untouched.
 *  - Without capture groups, the whole match is replaced (suited to bare
 *    values like phone numbers).
 *
 * Matching priority & overlap:
 *  - All rules (literal + regex) are prioritized by their order in the
 *    config; earlier rules win.
 *  - Every rule scans the ORIGINAL text independently (rather than chaining
 *    string mutations like a naive implementation would); once a region is
 *    claimed by a higher-priority match, later rules skip it.
 *  - Placeholders are written only in the final single-pass reconstruction,
 *    so a placeholder is never re-scanned and mistaken for new sensitive
 *    input by another rule.
 *  - mask() is idempotent over already-masked output: regions that are
 *    entirely covered by known placeholders (a cached alternation of every
 *    current literal + dynamic placeholder, merged into continuous
 *    intervals) are treated as already masked and left untouched, so
 *    re-masking a previously masked string (e.g. the before_provider_request
 *    fallback re-masking the context hook's output) is a no-op. A rule span
 *    is skipped only when fully inside such a region — a new value that merely
 *    contains an old placeholder as a substring is still masked. Without this,
 *    a format-preserving placeholder that still matches its own shape regex
 *    (phone digits→digits, generic tokens, ...) would be re-registered as
 *    `real: P1, placeholder: P2`, the LLM would see P2, and unmask could only
 *    ever restore P2→P1.
 *
 * Allowlist:
 *  - Allowlist entries (options.allowlist) are literal text the user marks
 *    as safe, each with its own case-sensitivity flag.
 *    Boundary-aligned occurrences are located in the original text before
 *    rules run, and any rule match overlapping one is skipped — so an
 *    entry may exempt a bare value ("10.0.0.5") or a whole line
 *    ("Authorization: Bearer tok123") containing one. A match that
 *    continues into a longer run of letters/digits does not count:
 *    "Bearer test" never exempts "Bearer test123".
 *
 * Collision protection:
 *  - A "used placeholders" set is kept (fixed literal placeholders +
 *    already-generated dynamic ones).
 *  - When a freshly generated placeholder collides (or equals the real
 *    value itself), regenerate with an incremented attempt counter until it
 *    no longer collides (bounded retries; falls back to accepting the
 *    result with a warning).
 *
 * Provenance (first-seen is forever):
 *  - The caller owns two session-scoped sets alongside dynamicMap:
 *      llmInventedValues: values first seen in LLM output. They are never
 *        masked for the whole session — the LLM already knows them, and
 *        masking them would change the representation of its own messages
 *        (logical contradictions, cache misses). Even if the user later
 *        sends the same string, it stays unmasked (accepted trade-off).
 *      protectedValues: values first seen in user, system, or tool-result data.
 *        They are masked in EVERY message role (including assistant
 *        history), so restored echoes never leak back to the LLM.
 *  - mask(text, { discover }) selects the behavior: user/tool/system
 *    messages pass discover: true (register new values); assistant messages
 *    pass discover: false (only already-protected values are replaced, and
 *    unmatched values are recorded as LLM-invented).
 *  - Both sets are immutable for the session. Later sources cannot promote
 *    an LLM-invented value to protected or demote a protected value.
 */

import { generatePlaceholder } from "./placeholder-gen.ts";
import { finalizeDetails, mergeDetailInto, type DetailAccumulator } from "./details.ts";
import { isCommonSemanticValue } from "./common-semantic-terms.ts";

// ─── Rule types (discriminated union) ──────────────────────────────────────

export interface PreserveStructure {
  /** Keep the first segment (up to the first separator) of the real value
   *  as-is, so structural claims like "starts with gs-" stay true in the
   *  LLM's view. A number caps how many characters of that segment are
   *  kept. See placeholder-gen.ts. */
  keepPrefix?: boolean | number;
  /** For exact IPv4 values: keep the first N octets as-is (recommended 2
   *  for private ranges); remaining octets are randomized within 0-255.
   *  Clamped to at most 3, so at least one octet is always randomized. */
  keepIPv4Octets?: number;
}

interface BaseMaskingRule {
  id: string;
  /** Short human-readable label shown in configuration UIs. */
  name?: string;
  /** Per-rule switch. Omitted means enabled for backward compatibility. */
  enabled?: boolean;
  description?: string;
  /** Preserve structural properties of the value in its placeholder. */
  preserveStructure?: PreserveStructure;
  /** Opt-out flag for the config-loader low-entropy warning. */
  lowEntropy?: boolean;
}

export interface LiteralMaskingRule extends BaseMaskingRule {
  type?: "literal";
  /** Per-rule case-sensitivity switch. Omitted/true = case-sensitive
   *  matching (backward-compatible default); false = case-insensitive. */
  caseSensitive?: boolean;
  /** The real value to be replaced */
  real: string;
  /**
   * The placeholder shown to the LLM.
   * Set to "auto" or omit to have config-loader generate it; set an
   * explicit value to use it directly (manual takes precedence).
   */
  placeholder?: string;
  /** Rule-level disclosure preference, applied when the global
   *  options.disclosePlaceholders is "per-rule" (undefined → not disclosed).
   *  While the global mode is true/false this value is paused, not lost. */
  disclosePlaceholder?: boolean;
}

export interface RegexMaskingRule extends BaseMaskingRule {
  type: "regex";
  /** Regex source (no delimiters) */
  pattern: string;
  /**
   * Optional flags. They fully control case sensitivity etc.; placeholder
   * restoration for this rule's dynamically discovered values is
   * case-insensitive exactly when the flags contain "i".
   * "g" (scan all matches) and "d" (capture group indices) are always
   * appended internally — no need to specify them manually.
   */
  flags?: string;
  /** Regex rules don't support a manual placeholder: a single pattern can
   *  match many different real values, so a fixed placeholder makes no
   *  sense — it's always generated dynamically per match. */
}

export type MaskingRule = LiteralMaskingRule | RegexMaskingRule;

export function isRegexRule(rule: MaskingRule): rule is RegexMaskingRule {
  return rule.type === "regex";
}

// ─── Dynamic placeholder map (for regex-discovered values) ─────────────────

export interface DynamicMapEntry {
  /** The real value discovered at runtime */
  real: string;
  /** The placeholder generated for it */
  placeholder: string;
  ruleId: string;
  description?: string;
  /** Case-insensitive restoration, inherited from the discovering rule
   *  (see BaseMaskingRule.caseSensitive). Missing on entries persisted by
   *  older versions = false (case-sensitive). */
  ci?: boolean;
}

/** Allowlist entry as accepted by the Masker: a bare string (case-sensitive)
 *  or an object with its own case-sensitivity flag. */
export type AllowlistInput = string | { text: string; caseSensitive?: boolean };

/** key = real value. Should be reused across Masker rebuilds within a session. */
export type DynamicPlaceholderMap = Map<string, DynamicMapEntry>;

// ─── Stats details ──────────────────────────────────────────────────────────

export interface DetailValue {
  /** Internal grouping key; callers must convert to a preview before display */
  real: string;
  occurrences: number;
}

export interface MaskDetail {
  ruleId: string;
  description?: string;
  /** All distinct real values seen, in first-seen order; not truncated */
  values: DetailValue[];
}

/** UnmaskDetail has the exact same shape as MaskDetail */
export type UnmaskDetail = MaskDetail;

export interface MaskResult {
  text: string;
  count: number;
  details: MaskDetail[];
}

export interface UnmaskResult {
  text: string;
  count: number;
  details: UnmaskDetail[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function toLiteralPattern(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Characters a secret-shaped run can continue with: letters, digits, and
 *  the common token punctuation (identifier underscore, version dot, base64
 *  plus, slug hyphen). Allowlist occurrences bounded by one of these are a
 *  fragment of a longer value, not the entry's text. Liberal on purpose —
 *  a false "continuation" keeps masking (safe), a miss would expose. */
const TOKEN_CHAR = /[\p{L}\p{N}_.+-]/u;

function isTokenChar(ch: string): boolean {
  return ch !== "" && TOKEN_CHAR.test(ch);
}

function overlaps(claimed: Array<[number, number]>, start: number, end: number): boolean {
  for (const [s, e] of claimed) {
    if (start < e && s < end) return true;
  }
  return false;
}

// ─── Compiled rule representations ─────────────────────────────────────────

interface CompiledLiteralRule {
  kind: "literal";
  ruleId: string;
  description?: string;
  real: string;
  placeholder: string;
  pattern: RegExp; // mask direction: matches real
  unmaskPattern: RegExp; // unmask direction: matches placeholder
  /** Case-insensitive matching, from the rule's caseSensitive flag. */
  ci: boolean;
}

interface CompiledRegexRule {
  kind: "regex";
  ruleId: string;
  description?: string;
  pattern: RegExp; // always has g + d flags
  preserveStructure?: PreserveStructure;
  /** Case-insensitive matching (only when the rule has no explicit flags). */
  ci: boolean;
}

type CompiledRule = CompiledLiteralRule | CompiledRegexRule;

// A region to be replaced (shared by mask and unmask)
interface ReplaceSpan {
  start: number;
  end: number;
  real: string;
  ruleId: string;
  description?: string;
  /** Known up front only for literal rules; regex matches resolve it lazily during output. */
  placeholder?: string;
  /** Carried from the matching rule for lazy placeholder generation. */
  preserveStructure?: PreserveStructure;
  /** Carried from the matching rule so the dynamic entry inherits its case mode. */
  ci?: boolean;
}

export const MAX_COLLISION_ATTEMPTS = 10;

/**
 * Per-call masking options (provenance control, see file header).
 * The default (no options) matches pre-provenance behavior: discover new
 * values and mask them (user-message semantics).
 */
export interface MaskOptions {
  /** Register newly discovered matching values. Default true; assistant
   *  messages pass false: only already-protected values are replaced, and
   *  new matches are recorded as LLM-invented. */
  discover?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────

export class Masker {
  private compiledRules: CompiledRule[] = [];
  /** Literal rules for the unmask direction, in original config order */
  private literalUnmaskRules: Array<{
    ruleId: string;
    description?: string;
    real: string;
    pattern: RegExp;
  }> = [];

  private sessionKey: Buffer | null;
  private dynamicMap: DynamicPlaceholderMap;
  /** Values first seen in LLM output: never masked (first-seen is forever). */
  private readonly llmInventedValues: Set<string>;
  /** Values first seen in user, system, or tool-result data: masked in every role. */
  private readonly protectedValues: Set<string>;
  /** Allowlist entries: literal text regions that are never masked (see
   *  collectAllowlistRegions; occurrences must be boundary-aligned).
   *  Kept as written, plus a lowercased alias on case-insensitive entries. */
  private readonly allowlistEntries: Array<{ text: string; lower: string | null }>;
  private usedPlaceholders: Set<string> = new Set();

  /** Cached alternation regexes matching every known placeholder string,
   *  split by case mode (cs = case-sensitive rules, ci = case-insensitive
   *  ones); see getProtectPatterns(). */
  private protectPatterns: { cs: RegExp | null; ci: RegExp | null } | null = null;
  private protectPatternDirty = true;

  /** Cached placeholder → real lookup for display-only restoration; see unmaskDisplay(). */
  private displayLookup: Map<string, string> | null = null;
  /** Lowercase alias covering only case-insensitively restored placeholders. */
  private displayLookupLower: Map<string, string> | null = null;
  /** Cached known-placeholder first-character indexes for stream hold-back,
   *  split by case mode; see displayHoldbackLength(). */
  private displayPlaceholderCache: {
    cs: { groups: Map<number, Array<{ p: string; len: number }>>; maxLen: number } | null;
    ci: { groups: Map<number, Array<{ p: string; len: number }>>; maxLen: number } | null;
  } | null = null;
  private displayLookupDirty = true;
  private displayCacheDirty = true;

  /** Cached longest-first dynamic entries with their compiled literal match
   *  patterns for the unmask direction; see getUnmaskDynamicPatterns(). */
  private unmaskDynamicPatterns: Array<{ entry: DynamicMapEntry; pattern: RegExp }> | null = null;
  private unmaskDynamicPatternsDirty = true;

  /** Regex compile errors etc., for the caller to surface via ctx.ui.notify */
  public readonly warnings: string[] = [];

  /**
   * @param rules        Merged rule list (literal + regex); each rule's
   *                     caseSensitive flag controls its own matching
   * @param sessionKey   Session key used to derive placeholders for
   *                     regex-discovered values; null is fine for
   *                     literal-only setups
   * @param dynamicMap   Shared map (regex-discovered real → placeholder)
   *                      reused across Masker rebuilds; lifecycle owned by
   *                      the caller (index.ts), cleared only on session_start
   * @param llmInventedValues Shared set of values first seen in LLM output;
   *                      never masked (see file header)
   * @param protectedValues  Shared set of values first seen outside model
   *                      output; masked in every message role
   * @param allowlist    Literal text never masked; bare strings are
   *                     case-sensitive, objects carry their own flag
   */
  constructor(
    rules: MaskingRule[],
    sessionKey: Buffer | null = null,
    dynamicMap: DynamicPlaceholderMap = new Map(),
    llmInventedValues: Set<string> = new Set(),
    protectedValues: Set<string> = new Set(),
    allowlist: Iterable<AllowlistInput> = []
  ) {
    this.sessionKey = sessionKey;
    this.dynamicMap = dynamicMap;
    this.llmInventedValues = llmInventedValues;
    this.protectedValues = protectedValues;

    this.allowlistEntries = [...allowlist]
      .map((entry) => typeof entry === "string" ? { text: entry, caseSensitive: true } : entry)
      .filter((entry) => entry.text.length > 0)
      .map((entry) => ({
        text: entry.text,
        lower: entry.caseSensitive === false ? entry.text.toLowerCase() : null,
      }));

    for (const rule of rules) {
      if (rule.enabled === false) continue;
      if (isRegexRule(rule)) {
        const compiled = this.compileRegexRule(rule);
        if (compiled) this.compiledRules.push(compiled);
        continue;
      }

      // Literal rules without a placeholder (shouldn't happen — config-loader
      // already fills it in) are silently skipped.
      if (!rule.real || !rule.placeholder) continue;

      const ci = rule.caseSensitive === false;
      const flag = ci ? "i" : "";
      const pattern = new RegExp(toLiteralPattern(rule.real), `g${flag}`);
      const unmaskPattern = new RegExp(toLiteralPattern(rule.placeholder), `g${flag}`);

      this.compiledRules.push({
        kind: "literal",
        ruleId: rule.id,
        description: rule.description,
        real: rule.real,
        placeholder: rule.placeholder,
        pattern,
        unmaskPattern,
        ci,
      });

      this.literalUnmaskRules.push({
        ruleId: rule.id,
        description: rule.description,
        real: rule.real,
        pattern: unmaskPattern,
      });

      this.usedPlaceholders.add(rule.placeholder);
    }

    // Existing dynamic mappings also count as "used" to avoid colliding with them
    for (const entry of this.dynamicMap.values()) {
      this.usedPlaceholders.add(entry.placeholder);
    }

    // Detect manual-placeholder conflicts (config-loader already resolves
    // collisions for auto-generated placeholders; manual ones can still clash).
    const placeholderOwners = new Map<string, { ruleId: string; real: string }>();
    const realValues = new Set<string>();
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      if (!isRegexRule(rule) && rule.real) realValues.add(rule.real);
    }
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      if (isRegexRule(rule)) continue;
      if (!rule.real || !rule.placeholder || rule.placeholder === "auto") continue;
      if (rule.placeholder === rule.real) {
        this.warnings.push(
          `Rule [${rule.id}] has placeholder equal to its real value; the rule has no effect`
        );
      }
      const existing = placeholderOwners.get(rule.placeholder);
      if (existing) {
        if (existing.real !== rule.real) {
          this.warnings.push(
            `Rule [${rule.id}] uses placeholder "${rule.placeholder}" which is already used by rule [${existing.ruleId}] for a different real value — unmasking may restore the wrong value; use distinct placeholders`
          );
        }
      } else {
        placeholderOwners.set(rule.placeholder, { ruleId: rule.id, real: rule.real });
      }
      if (realValues.has(rule.placeholder) && rule.placeholder !== rule.real) {
        this.warnings.push(
          `Rule [${rule.id}] placeholder "${rule.placeholder}" is also a real value of another rule — masking may interact unexpectedly; consider distinct values`
        );
      }
    }

    // An allowlist entry equal to a rule's placeholder exempts the
    // placeholder text itself (the covered-region logic already keeps
    // placeholders intact), which is almost certainly a config mistake.
    // Case-insensitive entries compare lowercased, so their check uses a
    // lowercased alias of the owner map.
    const placeholderOwnersLower = new Map([...placeholderOwners].map(([p, o]) => [p.toLowerCase(), o]));
    for (const { text: entry, lower } of this.allowlistEntries) {
      const owner = placeholderOwners.get(entry)
        ?? (lower !== null ? placeholderOwnersLower?.get(lower) : undefined);
      if (owner) {
        this.warnings.push(
          `Allowlist entry "${entry}" equals the placeholder of rule [${owner.ruleId}] — the entry exempts placeholder text, not a real value`
        );
      }
    }
  }

  private compileRegexRule(
    rule: RegexMaskingRule
  ): CompiledRegexRule | null {
    // Case-insensitive placeholder restoration inherits the rule's own
    // "i" flag (the sole case-sensitivity control for regex rules).
    const ci = (rule.flags ?? "").includes("i");
    try {
      const baseFlags = rule.flags ?? "";
      const flagSet = new Set(baseFlags.split(""));
      flagSet.add("g"); // scan all matches
      flagSet.add("d"); // capture group indices, needed for partial replacement
      const pattern = new RegExp(rule.pattern, Array.from(flagSet).join(""));
      return {
        kind: "regex",
        ruleId: rule.id,
        description: rule.description,
        pattern,
        preserveStructure: rule.preserveStructure,
        ci,
      };
    } catch (err) {
      this.warnings.push(
        `Rule [${rule.id}] has an invalid regex and was skipped: ${(err as Error).message}`
      );
      return null;
    }
  }

  /** Resolve (reuse or generate) a placeholder for a regex-discovered real value */
  private resolveDynamicPlaceholder(
    real: string,
    ruleId: string,
    description: string | undefined,
    preserveStructure: PreserveStructure | undefined,
    ci: boolean
  ): string {
    const existing = this.dynamicMap.get(real);
    if (existing) {
      this.protectedValues.add(real);
      return existing.placeholder;
    }

    let attempt = 0;
    let candidate = generatePlaceholder(
      real,
      this.sessionKey ?? Buffer.alloc(32),
      attempt,
      preserveStructure
    );
    while (
      (this.usedPlaceholders.has(candidate) || candidate === real || isCommonSemanticValue(candidate)) &&
      attempt < MAX_COLLISION_ATTEMPTS
    ) {
      attempt++;
      candidate = generatePlaceholder(
        real,
        this.sessionKey ?? Buffer.alloc(32),
        attempt,
        preserveStructure
      );
    }
    if (this.usedPlaceholders.has(candidate) || candidate === real || isCommonSemanticValue(candidate)) {
      this.warnings.push(
        `Rule [${ruleId}]: placeholder still collided or matched a common semantic value after ` +
          `${MAX_COLLISION_ATTEMPTS} retries; accepted as-is`
      );
    }

    this.usedPlaceholders.add(candidate);
    this.dynamicMap.set(real, { real, placeholder: candidate, ruleId, description, ci });
    this.protectedValues.add(real);
    this.protectPatternDirty = true;
    this.displayLookupDirty = true;
    this.displayCacheDirty = true;
    this.unmaskDynamicPatternsDirty = true;
    return candidate;
  }

  /**
   * Return a single regex matching every currently-known placeholder string
   * (fixed literal placeholders + regex-discovered dynamic ones), longest
   * first. Cached, rebuilt only when the placeholder set changes.
   *
   * Why this exists: the provider-boundary fallback (`before_provider_request`)
   * re-runs mask() on the context hook's output, which already contains
   * placeholders. Format-preserving placeholders are themselves matched by
   * the same shape-only regex that produced them (phone digits→digits,
   * generic tokens, keyword=value values, ...), so without protection the
   * second pass registers `real: P1, placeholder: P2` in the dynamic map.
   * The LLM then sees P2, and unmask only ever restores P2→P1 — never the
   * real secret.
   *
   * The patterns match placeholders with the same case behavior the unmask
   * direction uses (per-rule `caseSensitive`), so the protected regions
   * agree with what `unmask()` can actually restore.
   */
  private getProtectPatterns(): { cs: RegExp | null; ci: RegExp | null } {
    if (!this.protectPatternDirty) return this.protectPatterns ?? { cs: null, ci: null };

    const cs = new Set<string>();
    const ci = new Set<string>();
    for (const rule of this.compiledRules) {
      if (rule.kind === "literal") (rule.ci ? ci : cs).add(rule.placeholder);
    }
    for (const entry of this.dynamicMap.values()) (entry.ci ? ci : cs).add(entry.placeholder);

    const build = (set: Set<string>, flags: string): RegExp | null => {
      if (set.size === 0) return null;
      // Longest-first so a longer placeholder wins when one is a substring of
      // another, mirroring the unmask direction's ordering.
      const placeholders = Array.from(set).sort((a, b) => b.length - a.length);
      return new RegExp(placeholders.map(toLiteralPattern).join("|"), `g${flags}`);
    };
    this.protectPatterns = { cs: build(cs, ""), ci: build(ci, "i") };
    this.protectPatternDirty = false;
    return this.protectPatterns;
  }

  /**
   * Locate every occurrence of a known placeholder in `text` and merge
   * overlapping/adjacent occurrences into continuous "covered" intervals
   * (contiguous masked regions count as one interval).
   */
  private mergeCoveredRegions(text: string): Array<[number, number]> {
    const { cs, ci } = this.getProtectPatterns();
    if (cs === null && ci === null) return [];

    const spans: Array<[number, number]> = [];
    for (const protect of [cs, ci]) {
      if (protect === null) continue;
      protect.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = protect.exec(text))) {
        if (pm[0].length === 0) {
          protect.lastIndex++;
          continue;
        }
        spans.push([pm.index, pm.index + pm[0].length]);
      }
    }
    if (spans.length === 0) return [];

    const sorted = spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    let [csStart, csEnd] = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const [s, e] = sorted[i];
      if (s <= csEnd) {
        if (e > csEnd) csEnd = e;
      } else {
        merged.push([csStart, csEnd]);
        [csStart, csEnd] = [s, e];
      }
    }
    merged.push([csStart, csEnd]);
    return merged;
  }

  /**
   * True when the region [start, end) lies entirely inside already-masked
   * content (a merged covered interval). A region that only partially
   * overlaps a placeholder — e.g. a new secret that merely contains an old
   * placeholder as a prefix or substring — is NOT covered, so it is still
   * masked rather than leaking around the protected span.
   */
  private isCovered(
    covered: Array<[number, number]>,
    start: number,
    end: number
  ): boolean {
    for (const [s, e] of covered) {
      if (s <= start && end <= e) return true;
    }
    return false;
  }

  /** Extract the sub-regions to replace from a regex match: capture groups if present, else the whole match. */
  private extractSubSpans(
    m: RegExpExecArray,
    fullStart: number,
    fullEnd: number
  ): Array<{ start: number; end: number; real: string }> {
    const groupCount = m.length - 1;
    const indices = (m as unknown as { indices?: Array<[number, number] | undefined> }).indices;

    if (groupCount > 0 && indices) {
      const spans: Array<{ start: number; end: number; real: string }> = [];
      for (let i = 1; i <= groupCount; i++) {
        const idx = indices[i];
        const val = m[i];
        if (idx === undefined || val === undefined) continue; // group didn't participate in this match
        spans.push({ start: idx[0], end: idx[1], real: val });
      }
      if (spans.length > 0) return spans;
      // Shouldn't happen (overall match succeeded but no group matched) — fall back to whole match
    }

    return [{ start: fullStart, end: fullEnd, real: m[0] }];
  }

  /**
   * Every boundary-aligned occurrence of every allowlist entry in text, as
   * [start, end) regions. Literal substring scan (no regex): an entry
   * exempts the exact text as written — a bare value ("10.0.0.5"), a full
   * line ("Authorization: Bearer tok123"), or anything in between. An
   * occurrence qualifies only when neither edge continues into a longer
   * run of token characters (see isTokenChar): "Bearer test" does not
   * match inside "Bearer test123", and "10.0.0.5" does not match inside
   * "10.0.0.55" — a prefix of a longer value is a different value, which
   * stays masked. Case-insensitive entries scan a lowercased copy of the
   * text; boundary checks always run on the original characters.
   */
  private collectAllowlistRegions(text: string): Array<[number, number]> {
    const regions: Array<[number, number]> = [];
    if (this.allowlistEntries.length === 0) return regions;
    const hay = text.toLowerCase();
    for (const { text: entry, lower } of this.allowlistEntries) {
      const needle = lower !== null ? lower : entry;
      const scanHay = lower !== null ? hay : text;
      for (
        let pos = scanHay.indexOf(needle);
        pos !== -1;
        pos = scanHay.indexOf(needle, pos + entry.length)
      ) {
        const end = pos + entry.length;
        const before = pos > 0 ? text[pos - 1] : "";
        const after = end < text.length ? text[end] : "";
        if (isTokenChar(before) || isTokenChar(after)) continue;
        regions.push([pos, end]);
      }
    }
    return regions;
  }

  /**
   * Provenance-aware masking decision (first-seen is forever):
   *  - user/tool/system messages (discover, the default): a value is masked
   *    and registered unless it was first seen in LLM output
   *    (llmInventedValues); provenance never changes after first sight;
   *  - assistant messages (discover: false, passed explicitly): only
   *    already-protected values are replaced (restored echoes of non-model
   *    secrets); anything else is assumed to be LLM-invented content and is
   *    recorded as such.
   */
  private shouldMaskSpan(
    real: string,
    opts: MaskOptions
  ): { mask: boolean; register: boolean } {
    // Note: allowlist exemptions happen earlier, at the region level in
    // collectMaskSpans(); a span reaching this point is not allowlisted.
    if (opts.discover !== false) {
      if (this.protectedValues.has(real)) return { mask: true, register: false };
      if (this.llmInventedValues.has(real)) {
        // First seen in LLM output — never masked, by design.
        return { mask: false, register: false };
      }
      return { mask: true, register: true };
    }

    // Assistant message: mask only protected (non-model-sourced) values;
    // record everything else as LLM-invented.
    if (this.protectedValues.has(real)) return { mask: true, register: false };
    this.llmInventedValues.add(real);
    return { mask: false, register: false };
  }

  // ── mask: collect every rule's match spans over the original text, then
  //    reconstruct the output in one pass ───────────────────────────────────

  private collectMaskSpans(text: string, opts: MaskOptions): ReplaceSpan[] {
    const claimed: Array<[number, number]> = [];

    // Allowlist regions are literal text the user forbids touching; they
    // are shielded before any rule runs (see collectAllowlistRegions).
    const allowlistRegions = this.collectAllowlistRegions(text);

    // Compute which regions are already-masked content (placeholders from an
    // earlier masking pass). A replacement span is skipped only when it lies
    // ENTIRELY inside such a region; any span that reaches into unmasked text
    // is still masked, so a second pass is idempotent without letting new
    // secrets hide inside old placeholders.
    const covered = this.mergeCoveredRegions(text);

    const spans: ReplaceSpan[] = [];

    for (const rule of this.compiledRules) {
      rule.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;

      while ((m = rule.pattern.exec(text))) {
        const fullStart = m.index;
        const fullEnd = fullStart + m[0].length;

        if (m[0].length === 0) {
          // Avoid an infinite loop on zero-width matches
          rule.pattern.lastIndex++;
          continue;
        }
        if (overlaps(claimed, fullStart, fullEnd)) continue;

        if (rule.kind === "literal") {
          // A literal match overlapping an allowlisted region is skipped
          // whole, so the user's exact text is never rewritten.
          if (overlaps(allowlistRegions, fullStart, fullEnd)) continue;
          const decision = this.shouldMaskSpan(rule.real, opts);
          // Provenance says leave this value as-is; the region stays free so
          // lower-priority rules can still claim it with their own decision.
          if (!decision.mask) continue;
          if (decision.register) this.protectedValues.add(rule.real);
          claimed.push([fullStart, fullEnd]);
          if (this.isCovered(covered, fullStart, fullEnd)) continue;
          spans.push({
            start: fullStart,
            end: fullEnd,
            real: rule.real,
            ruleId: rule.ruleId,
            description: rule.description,
            placeholder: rule.placeholder,
          });
        } else {
          const subSpans = this.extractSubSpans(m, fullStart, fullEnd);
          // Captured parts overlapping an allowlisted region are left in
          // place while sibling groups outside it stay maskable (e.g.
          // `allowed=value` with "allowed" allowlisted masks only `value`).
          const decided = subSpans
            .filter((s) => !overlaps(allowlistRegions, s.start, s.end))
            .map((s) => ({
              span: s,
              decision: this.shouldMaskSpan(s.real, opts),
            }));
          // Claim the full match only when at least one captured part is
          // actually masked, so skipped (LLM-invented) regions stay free
          // for lower-priority rules.
          if (decided.some((d) => d.decision.mask)) claimed.push([fullStart, fullEnd]);
          for (const { span, decision } of decided) {
            if (!decision.mask) continue;
            // Skip only sub-spans that are fully already-masked (e.g. a
            // capture group that re-matched its own placeholder); any
            // capture part reaching into unmasked text is still masked.
            if (this.isCovered(covered, span.start, span.end)) continue;
            spans.push({
              start: span.start,
              end: span.end,
              real: span.real,
              ruleId: rule.ruleId,
              description: rule.description,
              preserveStructure: rule.preserveStructure,
              ci: rule.ci,
              // placeholder left unset; resolved lazily during output
            });
          }
        }
      }
    }

    spans.sort((a, b) => a.start - b.start);
    return spans;
  }

  mask(text: string, opts: MaskOptions = {}): MaskResult {
    if (typeof text !== "string" || !text) return { text, count: 0, details: [] };

    const spans = this.collectMaskSpans(text, opts);    if (spans.length === 0) return { text, count: 0, details: [] };

    const detailMap = new Map<string, DetailAccumulator>();
    let result = "";
    let cursor = 0;
    let count = 0;

    for (const span of spans) {
      result += text.slice(cursor, span.start);
      const placeholder =
        span.placeholder ??
        this.resolveDynamicPlaceholder(
          span.real,
          span.ruleId,
          span.description,
          span.preserveStructure,
          span.ci ?? false
        );
      result += placeholder;
      cursor = span.end;
      count++;

      mergeDetailInto(detailMap, {
        ruleId: span.ruleId,
        description: span.description,
        values: [{ real: span.real, occurrences: 1 }],
      });
    }
    result += text.slice(cursor);

    return { text: result, count, details: finalizeDetails(detailMap) };
  }

  // ── unmask: literal rules' fixed placeholders + the dynamic map's
  //    placeholders, looked up uniformly ─────────────────────────────────────

/**
   * Longest-first dynamic entries with a compiled literal pattern each, for
   * collectUnmaskSpans(). unmask() runs on every message_end and tool_call,
   * so compiling one RegExp per entry — and re-sorting the map — per call
   * would dominate runtime once the dynamic map grows into the thousands.
   * Cached like protectPatterns/displayLookup; invalidated only when a new
   * dynamic placeholder is generated.
   */
  private getUnmaskDynamicPatterns(): Array<{ entry: DynamicMapEntry; pattern: RegExp }> {
    if (!this.unmaskDynamicPatternsDirty) return this.unmaskDynamicPatterns ?? [];
    const sorted = Array.from(this.dynamicMap.values()).sort(
      (a, b) => b.placeholder.length - a.placeholder.length
    );
    this.unmaskDynamicPatterns = sorted.map((entry) => ({
      entry,
      pattern: new RegExp(toLiteralPattern(entry.placeholder), entry.ci ? "gi" : "g"),
    }));
    this.unmaskDynamicPatternsDirty = false;
    return this.unmaskDynamicPatterns;
  }

  private collectUnmaskSpans(text: string): ReplaceSpan[] {
    const claimed: Array<[number, number]> = [];
    const spans: ReplaceSpan[] = [];

    // Literal rules take priority in their original config order
    for (const rule of this.literalUnmaskRules) {
      rule.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.pattern.exec(text))) {
        const start = m.index;
        const end = start + m[0].length;
        if (m[0].length === 0) {
          rule.pattern.lastIndex++;
          continue;
        }
        if (overlaps(claimed, start, end)) continue;
        claimed.push([start, end]);
        spans.push({ start, end, real: rule.real, ruleId: rule.ruleId, description: rule.description });
      }
    }

    // Dynamic map (regex-discovered values), longest placeholder first to
    // reduce the chance of accidental overlap
    for (const { entry, pattern } of this.getUnmaskDynamicPatterns()) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text))) {
        const start = m.index;
        const end = start + m[0].length;
        if (m[0].length === 0) {
          pattern.lastIndex++;
          continue;
        }
        if (overlaps(claimed, start, end)) continue;
        claimed.push([start, end]);
        spans.push({
          start,
          end,
          real: entry.real,
          ruleId: entry.ruleId,
          description: entry.description,
        });
      }
    }

    spans.sort((a, b) => a.start - b.start);
    return spans;
  }

  unmask(text: string): UnmaskResult {
    if (typeof text !== "string" || !text) return { text, count: 0, details: [] };

    const spans = this.collectUnmaskSpans(text);
    if (spans.length === 0) return { text, count: 0, details: [] };

    const detailMap = new Map<string, DetailAccumulator>();
    let result = "";
    let cursor = 0;
    let count = 0;

    for (const span of spans) {
      result += text.slice(cursor, span.start);
      result += span.real;
      cursor = span.end;
      count++;

      mergeDetailInto(detailMap, {
        ruleId: span.ruleId,
        description: span.description,
        values: [{ real: span.real, occurrences: 1 }],
      });
    }
    result += text.slice(cursor);

    return { text: result, count, details: finalizeDetails(detailMap) };
  }

  // ── display unmask: single-pass restore for display-only surfaces ─────────

  /**
   * Placeholder → real lookup for display restoration. Literal rules win in
   * config order (mirroring collectUnmaskSpans), then regex-discovered
   * dynamic entries; the first registration wins on the (warned-about)
   * pathological case of two rules sharing one placeholder. Rebuilt only
   * when a new dynamic placeholder appears or the Masker is reconstructed.
   */
  private getDisplayLookup(): { exact: Map<string, string>; lower: Map<string, string> | null } | null {
    if (!this.displayLookupDirty) {
      return this.displayLookup === null
        ? null
        : { exact: this.displayLookup, lower: this.displayLookupLower };
    }

    const exact = new Map<string, string>();
    for (const rule of this.compiledRules) {
      if (rule.kind !== "literal") continue;
      if (!exact.has(rule.placeholder)) exact.set(rule.placeholder, rule.real);
    }
    for (const entry of this.dynamicMap.values()) {
      if (!exact.has(entry.placeholder)) exact.set(entry.placeholder, entry.real);
    }
    if (exact.size === 0) {
      this.displayLookup = null;
      this.displayLookupLower = null;
      this.displayPlaceholderCache = null;
      this.displayLookupDirty = false;
      this.displayCacheDirty = false;
      return null;
    }
    let lower: Map<string, string> | null = null;
    const ciOwners = new Set<string>();
    for (const rule of this.compiledRules) {
      if (rule.kind === "literal" && rule.ci) ciOwners.add(rule.placeholder);
    }
    for (const entry of this.dynamicMap.values()) {
      if (entry.ci) ciOwners.add(entry.placeholder);
    }
    if (ciOwners.size > 0) {
      lower = new Map<string, string>();
      for (const placeholder of ciOwners) {
        const real = exact.get(placeholder);
        if (real === undefined) continue;
        const key = placeholder.toLowerCase();
        if (!lower.has(key)) lower.set(key, real);
      }
    }
    this.displayLookup = exact;
    this.displayLookupLower = lower;
    this.displayLookupDirty = false;
    return { exact, lower };
  }

  /**
   * Restore every known placeholder in `text` in a single pass, for
   * display-only surfaces (assistant text/thinking markdown rendering).
   *
   * Unlike unmask(), this returns a bare string with no details and treats
   * the protect pattern's longest-first alternation as the match arbiter,
   * which keeps per-render cost at one regex scan plus one replacement pass
   * even for very long streaming content. Storage and provider-boundary
   * paths keep using unmask()/maskValue(); this method never mutates state
   * and is safe to call on every render frame.
   */
  unmaskDisplay(text: string): string {
    if (typeof text !== "string" || text.length === 0) return text;
    const { cs, ci } = this.getProtectPatterns();
    if (cs === null && ci === null) return text;

    const lookup = this.getDisplayLookup();
    if (lookup === null) return text;
    const { exact, lower } = lookup;

    const replaceWith = (current: string, protect: RegExp, ciPass: boolean): string => {
      protect.lastIndex = 0;
      if (!protect.test(current)) {
        protect.lastIndex = 0;
        return current;
      }
      protect.lastIndex = 0;
      return current.replace(protect, (matched) => {
        if (ciPass) {
          // Case-insensitive pass: exact case first, then lowercased alias.
          const direct = exact.get(matched);
          if (direct !== undefined) return direct;
          const lowered = lower?.get(matched.toLowerCase());
          return lowered ?? matched;
        }
        return exact.get(matched) ?? matched;
      });
    };

    // Case-insensitive placeholders run first so a case-sensitive placeholder
    // that contains one is matched literally in the second pass, not partially
    // restored by the first.
    let result = text;
    if (ci !== null) result = replaceWith(result, ci, true);
    if (cs !== null) result = replaceWith(result, cs, false);
    return result;
  }

  /**
   * Length of the longest suffix of `text` that is a strict prefix of some
   * known placeholder. Callers pass post-unmaskDisplay() text, so complete
   * placeholders never appear here and only potentially-incomplete ones are
   * held back while streaming. Case-insensitive placeholders compare against
   * a lowercased copy of the text; case-sensitive ones against the original.
   */
  displayHoldbackLength(text: string): number {
    if (typeof text !== "string" || text.length === 0) return 0;
    const cached = this.getDisplayPlaceholderCache();
    if (cached === null) return 0;
    const n = text.length;
    const check = (
      cache: { groups: Map<number, Array<{ p: string; len: number }>>; maxLen: number } | null,
      hay: string
    ): number => {
      if (cache === null) return 0;
      const limit = Math.min(cache.maxLen - 1, n);
      for (let l = limit; l > 0; l--) {
        const group = cache.groups.get(hay.charCodeAt(n - l));
        if (group === undefined) continue;
        for (const { p, len } of group) {
          if (len > l && hay.endsWith(p.slice(0, l))) return l;
        }
      }
      return 0;
    };
    // Lengths descend from the longest possible strict prefix, so the first
    // hit is the maximum. The first-character index prunes the common case
    // (tail characters that start no placeholder at all) to one Map lookup
    // per candidate length — this runs on every stream delta.
    return Math.max(
      check(cached.ci, text.toLowerCase()),
      check(cached.cs, text),
    );
  }

  private getDisplayPlaceholderCache(): {
    cs: { groups: Map<number, Array<{ p: string; len: number }>>; maxLen: number } | null;
    ci: { groups: Map<number, Array<{ p: string; len: number }>>; maxLen: number } | null;
  } | null {
    if (!this.displayCacheDirty) return this.displayPlaceholderCache;
    const build = (lowered: boolean): { groups: Map<number, Array<{ p: string; len: number }>>; maxLen: number } | null => {
      const seen = new Set<string>();
      const list: Array<{ p: string; len: number }> = [];
      const push = (placeholder: string): void => {
        if (seen.has(placeholder)) return;
        seen.add(placeholder);
        const p = lowered ? placeholder.toLowerCase() : placeholder;
        list.push({ p, len: placeholder.length });
      };
      for (const rule of this.compiledRules) {
        if (rule.kind !== "literal" || rule.ci !== lowered) continue;
        push(rule.placeholder);
      }
      for (const entry of this.dynamicMap.values()) {
        if ((entry.ci ?? false) !== lowered) continue;
        push(entry.placeholder);
      }
      if (list.length === 0) return null;
      const groups = new Map<number, Array<{ p: string; len: number }>>();
      let maxLen = 0;
      for (const item of list) {
        if (item.len > maxLen) maxLen = item.len;
        const first = item.p.charCodeAt(0);
        const group = groups.get(first);
        if (group) group.push(item);
        else groups.set(first, [item]);
      }
      return { groups, maxLen };
    };
    this.displayPlaceholderCache = { cs: build(false), ci: build(true) };
    this.displayCacheDirty = false;
    return this.displayPlaceholderCache;
  }

  // ── Arbitrary-depth objects (recurse over all string values, keys untouched) ──

  maskValue(value: unknown, opts: MaskOptions = {}): { value: unknown; count: number; details: MaskDetail[] } {
    if (typeof value === "string") {
      const { text, count, details } = this.mask(value, opts);
      return { value: text, count, details };
    }
    if (Array.isArray(value)) {
      let count = 0;
      const detailMap = new Map<string, DetailAccumulator>();
      const arr = value.map((item) => {
        const r = this.maskValue(item, opts);
        count += r.count;
        r.details.forEach((d) => mergeDetailInto(detailMap, d));
        return r.value;
      });
      return { value: arr, count, details: finalizeDetails(detailMap) };
    }
    if (value !== null && typeof value === "object") {
      let count = 0;
      const detailMap = new Map<string, DetailAccumulator>();
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const r = this.maskValue(v, opts);
        obj[k] = r.value;
        count += r.count;
        r.details.forEach((d) => mergeDetailInto(detailMap, d));
      }
      return { value: obj, count, details: finalizeDetails(detailMap) };
    }
    return { value, count: 0, details: [] };
  }

  unmaskValue(value: unknown): { value: unknown; count: number; details: UnmaskDetail[] } {
    if (typeof value === "string") {
      const r = this.unmask(value);
      return { value: r.text, count: r.count, details: r.details };
    }
    if (Array.isArray(value)) {
      let count = 0;
      const detailMap = new Map<string, DetailAccumulator>();
      const arr = value.map((item) => {
        const r = this.unmaskValue(item);
        count += r.count;
        r.details.forEach((d) => mergeDetailInto(detailMap, d));
        return r.value;
      });
      return { value: arr, count, details: finalizeDetails(detailMap) };
    }
    if (value !== null && typeof value === "object") {
      let count = 0;
      const detailMap = new Map<string, DetailAccumulator>();
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const r = this.unmaskValue(v);
        obj[k] = r.value;
        count += r.count;
        r.details.forEach((d) => mergeDetailInto(detailMap, d));
      }
      return { value: obj, count, details: finalizeDetails(detailMap) };
    }
    return { value, count: 0, details: [] };
  }
}
