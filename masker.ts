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
 *
 * Collision protection:
 *  - A "used placeholders" set is kept (fixed literal placeholders +
 *    already-generated dynamic ones).
 *  - When a freshly generated placeholder collides (or equals the real
 *    value itself), regenerate with an incremented attempt counter until it
 *    no longer collides (bounded retries; falls back to accepting the
 *    result with a warning).
 */

import { generatePlaceholder } from "./placeholder-gen.ts";

// ─── Rule types (discriminated union) ──────────────────────────────────────

interface BaseMaskingRule {
  id: string;
  description?: string;
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

// Mutable accumulator used to merge details: grouped by ruleId, then
// deduplicated by real value within each group.
interface DetailAccumulator {
  description?: string;
  counts: Map<string, number>; // real → occurrences
  order: string[]; // first-seen order of real values
}

function mergeDetailInto(map: Map<string, DetailAccumulator>, detail: MaskDetail): void {
  let entry = map.get(detail.ruleId);
  if (!entry) {
    entry = { description: detail.description, counts: new Map(), order: [] };
    map.set(detail.ruleId, entry);
  }
  for (const v of detail.values) {
    if (!entry.counts.has(v.real)) entry.order.push(v.real);
    entry.counts.set(v.real, (entry.counts.get(v.real) ?? 0) + v.occurrences);
  }
}

function finalizeDetails(map: Map<string, DetailAccumulator>): MaskDetail[] {
  const out: MaskDetail[] = [];
  for (const [ruleId, entry] of map) {
    out.push({
      ruleId,
      description: entry.description,
      values: entry.order.map((real) => ({
        real,
        occurrences: entry.counts.get(real)!,
      })),
    });
  }
  return out;
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
}

const MAX_COLLISION_ATTEMPTS = 10;

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
  private usedPlaceholders: Set<string> = new Set();

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
   */
  constructor(
    rules: MaskingRule[],
    caseSensitive: boolean,
    sessionKey: Buffer | null = null,
    dynamicMap: DynamicPlaceholderMap = new Map()
  ) {
    this.sessionKey = sessionKey;
    this.dynamicMap = dynamicMap;

    const caseFlag = caseSensitive ? "" : "i";

    for (const rule of rules) {
      if (isRegexRule(rule)) {
        const compiled = this.compileRegexRule(rule, caseSensitive);
        if (compiled) this.compiledRules.push(compiled);
        continue;
      }

      // Literal rules without a placeholder (shouldn't happen — config-loader
      // already fills it in) are silently skipped.
      if (!rule.real || !rule.placeholder) continue;

      const pattern = new RegExp(toLiteralPattern(rule.real), `g${caseFlag}`);
      const unmaskPattern = new RegExp(toLiteralPattern(rule.placeholder), "g");

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
      return { kind: "regex", ruleId: rule.id, description: rule.description, pattern };
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
    description: string | undefined
  ): string {
    const existing = this.dynamicMap.get(real);
    if (existing) return existing.placeholder;

    let attempt = 0;
    let candidate = generatePlaceholder(real, this.sessionKey ?? Buffer.alloc(32), attempt);
    while (
      (this.usedPlaceholders.has(candidate) || candidate === real) &&
      attempt < MAX_COLLISION_ATTEMPTS
    ) {
      attempt++;
      candidate = generatePlaceholder(real, this.sessionKey ?? Buffer.alloc(32), attempt);
    }
    if (this.usedPlaceholders.has(candidate) || candidate === real) {
      this.warnings.push(
        `Rule [${ruleId}]: placeholder still collided after ${MAX_COLLISION_ATTEMPTS} retries; accepted as-is`
      );
    }

    this.usedPlaceholders.add(candidate);
    this.dynamicMap.set(real, { real, placeholder: candidate, ruleId, description });
    return candidate;
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

  // ── mask: collect every rule's match spans over the original text, then
  //    reconstruct the output in one pass ───────────────────────────────────

  private collectMaskSpans(text: string): ReplaceSpan[] {
    const claimed: Array<[number, number]> = [];
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
        claimed.push([fullStart, fullEnd]);

        if (rule.kind === "literal") {
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
          for (const s of subSpans) {
            spans.push({
              start: s.start,
              end: s.end,
              real: s.real,
              ruleId: rule.ruleId,
              description: rule.description,
              // placeholder left unset; resolved lazily during output
            });
          }
        }
      }
    }

    spans.sort((a, b) => a.start - b.start);
    return spans;
  }

  mask(text: string): MaskResult {
    if (typeof text !== "string" || !text) return { text, count: 0, details: [] };

    const spans = this.collectMaskSpans(text);
    if (spans.length === 0) return { text, count: 0, details: [] };

    const detailMap = new Map<string, DetailAccumulator>();
    let result = "";
    let cursor = 0;
    let count = 0;

    for (const span of spans) {
      result += text.slice(cursor, span.start);
      const placeholder =
        span.placeholder ??
        this.resolveDynamicPlaceholder(span.real, span.ruleId, span.description);
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
      const pattern = new RegExp(toLiteralPattern(entry.placeholder), "g");
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

  maskValue(value: unknown): { value: unknown; count: number; details: MaskDetail[] } {
    if (typeof value === "string") {
      const { text, count, details } = this.mask(value);
      return { value: text, count, details };
    }
    if (Array.isArray(value)) {
      let count = 0;
      const detailMap = new Map<string, DetailAccumulator>();
      const arr = value.map((item) => {
        const r = this.maskValue(item);
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
        const r = this.maskValue(v);
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
