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
 * Collision protection:
 *  - A "used placeholders" set is kept (fixed literal placeholders +
 *    already-generated dynamic ones).
 *  - When a freshly generated placeholder collides (or equals the real
 *    value itself), regenerate with an incremented attempt counter until it
 *    no longer collides (bounded retries; falls back to accepting the
 *    result with a warning).
 *
 * Provenance (first-seen is forever, per docs/design-proposal.md D1/O1):
 *  - The caller owns two session-scoped sets alongside dynamicMap:
 *      llmInventedValues: values first seen in LLM output. They are never
 *        masked for the whole session — the LLM already knows them, and
 *        masking them would change the representation of its own messages
 *        (logical contradictions, cache misses). Even if the user later
 *        sends the same string, it stays unmasked (accepted trade-off).
 *      protectedValues: values first seen in user messages or tool results.
 *        They are masked in EVERY message role (including assistant
 *        history), so restored echoes never leak back to the LLM.
 *  - mask(text, { discover }) selects the behavior: user/tool/system
 *    messages pass discover: true (register new values); assistant messages
 *    pass discover: false (only already-protected values are replaced, and
 *    unmatched values are recorded as LLM-invented).
 *  - Tool results pass ignoreInvented: true — real data sources always
 *    register, regardless of what the LLM happened to say earlier.
 */

import { generatePlaceholder } from "./placeholder-gen.ts";
import { finalizeDetails, mergeDetailInto, type DetailAccumulator } from "./details.ts";

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
  description?: string;
  /** Preserve structural properties of the value in its placeholder. */
  preserveStructure?: PreserveStructure;
  /** Opt-out flag for the config-loader low-entropy warning. */
  lowEntropy?: boolean;
}

export interface LiteralMaskingRule extends BaseMaskingRule {
  type?: "literal";
  /** The real value to be replaced */
  real: string;
  /**
   * The placeholder shown to the LLM.
   * Set to "auto" or omit to have config-loader generate it; set an
   * explicit value to use it directly (manual takes precedence).
   */
  placeholder?: string;
}

export interface RegexMaskingRule extends BaseMaskingRule {
  type: "regex";
  /** Regex source (no delimiters) */
  pattern: string;
  /**
   * Optional flags. If provided, they fully control case sensitivity etc.
   * (independent of the global caseSensitive option); if omitted, falls
   * back to global options.caseSensitive (adds "i" when false).
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
}

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

/** First 4 chars + ***, for display purposes */
export function makePreview(real: string): string {
  if (real.length <= 4) return "***";
  return real.slice(0, 4) + "***";
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
}

interface CompiledRegexRule {
  kind: "regex";
  ruleId: string;
  description?: string;
  pattern: RegExp; // always has g + d flags
  preserveStructure?: PreserveStructure;
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
  /** Mask even values previously recorded as LLM-invented (tool results). */
  ignoreInvented?: boolean;
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
  /** Values first seen in user/tool messages: masked in every role. */
  private readonly protectedValues: Set<string>;
  private usedPlaceholders: Set<string> = new Set();
  /** Case flag for unmask patterns, mirrors the mask direction ("" or "i"). */
  private readonly caseFlag: string;

  /** Cached alternation regex matching every known placeholder string; see getProtectPattern(). */
  private protectPattern: RegExp | null = null;
  private protectPatternDirty = true;

  /** Regex compile errors etc., for the caller to surface via ctx.ui.notify */
  public readonly warnings: string[] = [];

  /**
   * @param rules        Merged rule list (literal + regex)
   * @param caseSensitive Global case-sensitivity option; regex rules with
   *                      their own flags fully override it
   * @param sessionKey   Session key used to derive placeholders for
   *                      regex-discovered values; null is fine for
   *                      literal-only setups
   * @param dynamicMap   Shared map (regex-discovered real → placeholder)
   *                      reused across Masker rebuilds; lifecycle owned by
   *                      the caller (index.ts), cleared only on session_start
   * @param llmInventedValues Shared set of values first seen in LLM output;
   *                      never masked (see file header)
   * @param protectedValues  Shared set of values first seen in user/tool
   *                      messages; masked in every message role
   */
  constructor(
    rules: MaskingRule[],
    caseSensitive: boolean,
    sessionKey: Buffer | null = null,
    dynamicMap: DynamicPlaceholderMap = new Map(),
    llmInventedValues: Set<string> = new Set(),
    protectedValues: Set<string> = new Set()
  ) {
    this.sessionKey = sessionKey;
    this.dynamicMap = dynamicMap;
    this.llmInventedValues = llmInventedValues;
    this.protectedValues = protectedValues;
    this.caseFlag = caseSensitive ? "" : "i";

    for (const rule of rules) {
      if (isRegexRule(rule)) {
        const compiled = this.compileRegexRule(rule, caseSensitive);
        if (compiled) this.compiledRules.push(compiled);
        continue;
      }

      // Literal rules without a placeholder (shouldn't happen — config-loader
      // already fills it in) are silently skipped.
      if (!rule.real || !rule.placeholder) continue;

      const pattern = new RegExp(toLiteralPattern(rule.real), `g${this.caseFlag}`);
      const unmaskPattern = new RegExp(toLiteralPattern(rule.placeholder), "g" + this.caseFlag);

      this.compiledRules.push({
        kind: "literal",
        ruleId: rule.id,
        description: rule.description,
        real: rule.real,
        placeholder: rule.placeholder,
        pattern,
        unmaskPattern,
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
      if (!isRegexRule(rule) && rule.real) realValues.add(rule.real);
    }
    for (const rule of rules) {
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
  }

  private compileRegexRule(
    rule: RegexMaskingRule,
    caseSensitive: boolean
  ): CompiledRegexRule | null {
    try {
      const baseFlags = rule.flags ?? (caseSensitive ? "" : "i");
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
    preserveStructure: PreserveStructure | undefined
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
      (this.usedPlaceholders.has(candidate) || candidate === real) &&
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
    if (this.usedPlaceholders.has(candidate) || candidate === real) {
      this.warnings.push(
        `Rule [${ruleId}]: placeholder still collided after ${MAX_COLLISION_ATTEMPTS} retries; accepted as-is`
      );
    }

    this.usedPlaceholders.add(candidate);
    this.dynamicMap.set(real, { real, placeholder: candidate, ruleId, description });
    this.protectedValues.add(real);
    this.protectPatternDirty = true;
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
   * The pattern matches placeholders with the same case behavior the unmask
   * direction uses (global `caseFlag`), so the protected regions agree with
   * what `unmask()` can actually restore.
   */
  private getProtectPattern(): RegExp | null {
    if (!this.protectPatternDirty) return this.protectPattern;

    const set = new Set<string>();
    for (const rule of this.compiledRules) {
      if (rule.kind === "literal") set.add(rule.placeholder);
    }
    for (const entry of this.dynamicMap.values()) set.add(entry.placeholder);

    if (set.size === 0) {
      this.protectPattern = null;
      this.protectPatternDirty = false;
      return null;
    }

    // Longest-first so a longer placeholder wins when one is a substring of
    // another, mirroring the unmask direction's ordering.
    const placeholders = Array.from(set).sort((a, b) => b.length - a.length);
    this.protectPattern = new RegExp(
      placeholders.map(toLiteralPattern).join("|"),
      "g" + this.caseFlag
    );
    this.protectPatternDirty = false;
    return this.protectPattern;
  }

  /**
   * Locate every occurrence of a known placeholder in `text` and merge
   * overlapping/adjacent occurrences into continuous "covered" intervals
   * (contiguous masked regions count as one interval).
   */
  private mergeCoveredRegions(text: string): Array<[number, number]> {
    const protect = this.getProtectPattern();
    if (protect === null) return [];

    const spans: Array<[number, number]> = [];
    protect.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = protect.exec(text))) {
      if (pm[0].length === 0) {
        protect.lastIndex++;
        continue;
      }
      spans.push([pm.index, pm.index + pm[0].length]);
    }
    if (spans.length === 0) return [];

    const sorted = spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    let [cs, ce] = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const [s, e] = sorted[i];
      if (s <= ce) {
        if (e > ce) ce = e;
      } else {
        merged.push([cs, ce]);
        [cs, ce] = [s, e];
      }
    }
    merged.push([cs, ce]);
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
   * Provenance-aware masking decision (first-seen is forever):
   *  - user/tool/system messages (discover, the default): a value is masked
   *    and registered unless it was first seen in LLM output
   *    (llmInventedValues) — except tool results, which always register
   *    (ignoreInvented);
   *  - assistant messages (discover: false, passed explicitly): only
   *    already-protected values are replaced (restored echoes of user/tool
   *    secrets); anything else is assumed to be LLM-invented content and is
   *    recorded as such.
   */
  private shouldMaskSpan(
    real: string,
    opts: MaskOptions
  ): { mask: boolean; register: boolean } {
    if (opts.discover !== false) {
      if (this.protectedValues.has(real)) return { mask: true, register: false };
      if (opts.ignoreInvented !== true && this.llmInventedValues.has(real)) {
        // First seen in LLM output — never masked, by design.
        return { mask: false, register: false };
      }
      return { mask: true, register: true };
    }

    // Assistant message: mask only protected (user/tool-sourced) values;
    // record everything else as LLM-invented.
    if (this.protectedValues.has(real)) return { mask: true, register: false };
    this.llmInventedValues.add(real);
    return { mask: false, register: false };
  }

  // ── mask: collect every rule's match spans over the original text, then
  //    reconstruct the output in one pass ───────────────────────────────────

  private collectMaskSpans(text: string, opts: MaskOptions): ReplaceSpan[] {
    const claimed: Array<[number, number]> = [];

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
          const decided = subSpans.map((s) => ({
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
          span.preserveStructure
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
    const dynamicEntries = Array.from(this.dynamicMap.values()).sort(
      (a, b) => b.placeholder.length - a.placeholder.length
    );
    for (const entry of dynamicEntries) {
      const pattern = new RegExp(toLiteralPattern(entry.placeholder), "g" + this.caseFlag);
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
