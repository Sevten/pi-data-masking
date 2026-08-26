/**
 * masked-cache.ts
 * Per-session cache of masked message outputs shared by the outbound hooks.
 *
 * Why it exists: the context hook masks the ENTIRE conversation on every
 * model request and before_provider_request re-masks all of it again as a
 * safety net. History messages are immutable between turns and masking is
 * deterministic given (rules, sessionKey, dynamicMap state) — a repeated
 * mask of the same original resolves every already-seen value through
 * dynamicMap.get(real), returning pinned placeholders — so a cached masked
 * output for an unchanged original is byte-identical to a fresh maskValue
 * run, minus the O(rules × text) regex scans.
 *
 * Correctness contract:
 *  - Fill always runs the full masker.maskValue(), so provenance side
 *    effects (shouldMaskSpan registering protected/llmInvented values)
 *    happen exactly once, at fill time. Hits skip only the regex work.
 *  - A hit requires a content fingerprint match against EITHER the entry's
 *    original input hash or its stored masked-output hash. The context hook
 *    records entries under the original hash, while before_provider_request
 *    receives the context hook's masked output and looks it up by the masked
 *    hash — accepting both keeps those alternating views on one entry
 *    instead of missing and overwriting each other (which would make every
 *    sensitive message thrash between the two hashes and never hit). A hit
 *    never replaces the stored original mapping, so the next context(original)
 *    still resolves. Masking is idempotent over placeholders, so serving an
 *    entry's masked output for its masked input equals a fresh maskValue run;
 *    any genuinely different payload under the same key degrades to a miss
 *    (key collisions like transcriptKey's role:index fallback shifting after
 *    appends), never a false hit.
 *  - invalidate() must be called whenever masker inputs change: rebuild()
 *    (rules, caseSensitive), /masking-toggle (bypasses rebuild()), and
 *    session_start (fresh sessionKey + provenance sets). Clearing is always
 *    safe — misses merely refill.
 */

import { textHash } from "./history-persistence.ts";

/**
 * Strings longer than this are hashed individually during fingerprinting so
 * a multi-megabyte base64 image block never becomes part of one giant JSON
 * concatenation (sha256 still covers its full content).
 */
const LONG_STRING_HASH_THRESHOLD = 4096;

/**
 * Upper bound on cached messages; the map is cleared wholesale on overflow
 * because refilling an entry costs far less than tracking LRU order.
 */
export const MASKED_CACHE_MAX_ENTRIES = 5000;

/** Stable content fingerprint of an arbitrary JSON-serializable message. */
export function hashMessage(message: unknown): string {
  return textHash(JSON.stringify(message, (_key, value) =>
    typeof value === "string" && value.length > LONG_STRING_HASH_THRESHOLD
      ? `__len:${value.length}:${textHash(value)}`
      : value
  ));
}

export interface MaskedCacheEntry {
  /** Fingerprint of the un-masked input this entry was produced from. */
  hash: string;
  /** Fingerprint of the masked output; lets snapshot persistence skip
   *  re-diffing messages whose masked form provably did not change. */
  maskedHash: string;
  /**
   * Stored AND served BY REFERENCE: the same object may be handed to many
   * consecutive requests (context hook return value and provider payload).
   * Callers must treat it as read-only shared state — fingerprint checks
   * protect against input-side mutations, not output-side ones. Mutating a
   * served value would corrupt every future hit for that key.
   */
  masked: unknown;
}

export class MaskedCache {
  private entries = new Map<string, MaskedCacheEntry>();

  get size(): number {
    return this.entries.size;
  }

  /**
   * Cached entry for key when the fingerprint matches the recorded ORIGINAL
   * hash or the stored masked-output hash. The masked-hash branch serves the
   * provider boundary (whose input is the context hook's already-masked
   * output) without touching the entry: the original mapping survives so the
   * next context(original) lookup still hits.
   */
  lookup(key: string, hash: string): MaskedCacheEntry | undefined {
    const entry = this.entries.get(key);
    return entry !== undefined && (entry.hash === hash || entry.maskedHash === hash)
      ? entry
      : undefined;
  }

  record(key: string, hash: string, maskedHash: string, masked: unknown): void {
    if (this.entries.size >= MASKED_CACHE_MAX_ENTRIES) this.entries.clear();
    this.entries.set(key, { hash, maskedHash, masked });
  }

  invalidate(): void {
    this.entries.clear();
  }
}
