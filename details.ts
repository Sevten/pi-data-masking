/**
 * details.ts
 * Shared detail-accumulation helpers used by both the masking engine
 * (masker.ts) and the extension entry point (index.ts) to build per-rule,
 * per-real-value stats.
 *
 * Kept in its own module so the two callers don't duplicate the
 * merge/finalize logic.
 */

import type { MaskDetail } from "./masker.ts";

// ─── Mutable accumulator ────────────────────────────────────────────────────

export interface DetailAccumulator {
  description?: string;
  counts: Map<string, number>; // real → occurrences
  order: string[]; // first-seen order of real values
}

/** Merge one detail (ruleId + values) into an accumulator map. */
export function mergeDetailInto(
  map: Map<string, DetailAccumulator>,
  detail: MaskDetail
): void {
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

/** Convert an accumulator map into final MaskDetail[] (first-seen order preserved). */
export function finalizeDetails(map: Map<string, DetailAccumulator>): MaskDetail[] {
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
