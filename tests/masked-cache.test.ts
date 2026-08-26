/**
 * tests/masked-cache.test.ts
 * Tests for the masked-output cache primitives shared by the outbound hooks:
 * fingerprinting, hit/miss/invalidate semantics, capacity handling, the
 * mergeTranscript clone-skip, and masker determinism while the dynamic map
 * grows (the property that makes cross-turn caching sound).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MASKED_CACHE_MAX_ENTRIES, MaskedCache, hashMessage } from "../masked-cache.ts";
import { Masker } from "../masker.ts";
import type { MaskingRule } from "../masker.ts";
import { mergePendingAssistant, mergeTranscript, transcriptKey } from "../history-viewer.ts";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "hex");

test("hashMessage is stable per content and sensitive to changes", () => {
  const message = { role: "user", content: "call 555-1234" };
  assert.equal(hashMessage(message), hashMessage({ role: "user", content: "call 555-1234" }));
  assert.notEqual(hashMessage(message), hashMessage({ role: "user", content: "call 555-1235" }));
});

test("long strings are hashed by content without joining into one giant JSON string", () => {
  const longA = "a".repeat(10_000);
  const longB = "a".repeat(9_999) + "b";
  assert.equal(hashMessage({ data: longA }), hashMessage({ data: longA }));
  assert.notEqual(hashMessage({ data: longA }), hashMessage({ data: longB }));
});

test("cache serves hits only when the content fingerprint matches", () => {
  const cache = new MaskedCache();
  cache.record("user:index:3", "hash-a", "mask-a", { content: "masked A" });

  const hit = cache.lookup("user:index:3", "hash-a");
  assert.ok(hit);
  assert.deepEqual(hit.masked, { content: "masked A" });
  assert.equal(hit.maskedHash, "mask-a");

  // Key reuse with different content (transcriptKey index fallback shifting
  // after appends) must degrade to a miss, never a stale hit.
  assert.equal(cache.lookup("user:index:3", "hash-b"), undefined);
  assert.equal(cache.lookup("tool:other", "hash-a"), undefined);
});

test("masked-output hash is also a hit and never replaces the original mapping", () => {
  // Regression for PR #2 review: the context hook records entries under the
  // original hash, but before_provider_request receives the context hook's
  // masked output and looks it up by the masked hash. If only the original
  // hash matched, that lookup missed, overwrote the entry under the masked
  // hash, and made the next context(original) miss again — sensitive
  // messages thrashed between the two hashes and never hit.
  const cache = new MaskedCache();
  const masked = { role: "user", content: "call [PHONE_1]" };
  cache.record("user:index:0", "hash-original", "hash-masked", masked);

  // provider(masked): hits via the stored masked-output hash…
  const viaMasked = cache.lookup("user:index:0", "hash-masked");
  assert.ok(viaMasked);
  assert.ok(viaMasked === cache.lookup("user:index:0", "hash-original"));
  assert.equal(viaMasked!.masked, masked);
  assert.equal(viaMasked!.hash, "hash-original");

  // …without replacing the entry, so the next context(original) still hits.
  const nextContext = cache.lookup("user:index:0", "hash-original");
  assert.ok(nextContext);
  assert.equal(nextContext!.masked, masked);

  // An unrelated fingerprint under the same key still misses.
  assert.equal(cache.lookup("user:index:0", "hash-other"), undefined);
});

test("cache clears wholesale at capacity instead of tracking LRU order", () => {
  const cache = new MaskedCache();
  for (let index = 0; index < MASKED_CACHE_MAX_ENTRIES; index++) {
    cache.record(`key-${index}`, "h", "m", index);
  }
  assert.equal(cache.size, MASKED_CACHE_MAX_ENTRIES);

  cache.record("fresh", "h", "m", "fresh");
  assert.equal(cache.size, 1);
  assert.ok(cache.lookup("fresh", "h"));
  assert.equal(cache.lookup("key-0", "h"), undefined);
});

test("invalidate empties the cache", () => {
  const cache = new MaskedCache();
  cache.record("k", "h", "m", 1);
  cache.invalidate();
  assert.equal(cache.size, 0);
  assert.equal(cache.lookup("k", "h"), undefined);
});

test("masking stays deterministic while the dynamic map and provenance sets grow", () => {
  // The property that justifies caching across turns: a fresh mask of an
  // unchanged original resolves already-seen values through dynamicMap.get,
  // so later growth of the map/sets cannot change its output.
  const dynamicMap = new Map();
  const llmInventedValues = new Set<string>();
  const protectedValues = new Set<string>();
  const rules: MaskingRule[] = [{ id: "phone", type: "regex", pattern: "\\d{3}-\\d{4}" }];
  const masker = new Masker(rules, true, KEY, dynamicMap, llmInventedValues, protectedValues);

  const historyMessage = { role: "user", content: "call 555-1234 now" };
  const first = masker.maskValue(historyMessage, { discover: true });

  for (let index = 0; index < 50; index++) {
    masker.maskValue(
      { role: "user", content: `num ${String(index).padStart(3, "0")}-${String(7000 + index).padStart(4, "0")}` },
      { discover: true },
    );
  }
  assert.equal(dynamicMap.size, 51);

  const second = masker.maskValue(historyMessage, { discover: true });
  assert.deepEqual(second.value, first.value);
  assert.equal(second.count, first.count);
});

test("mergeTranscript skips cloning entries whose content hash is unchanged", () => {
  const message = { role: "user", timestamp: 1, content: "secret" };
  const first = mergeTranscript([], [message], [{ ...message, content: "[MASKED]" }], 10, ["hash-1"]);
  const entry = first[0]!;

  const second = mergeTranscript(first, [message], [{ ...message, content: "[MASKED]" }], 20, ["hash-1"]);
  assert.equal(second.length, 1);
  assert.ok(second[0] === entry);
  assert.ok(second[0]!.original === entry.original);
  assert.ok(second[0]!.masked === entry.masked);
  assert.equal(second[0]!.capturedAt, 20);
});

test("mergeTranscript re-clones when the hash changes", () => {
  const message = { role: "user", timestamp: 1, content: "secret" };
  const first = mergeTranscript([], [message], [{ ...message, content: "[MASKED]" }], 10, ["hash-1"]);
  const entry = first[0]!;
  const staleMasked = entry.masked;
  const staleOriginal = entry.original;

  const second = mergeTranscript(first, [message], [{ ...message, content: "[REMASKED]" }], 20, ["hash-2"]);
  assert.equal(second.length, 1);
  assert.ok(second[0] === entry); // entry object is reused…
  assert.ok(second[0]!.masked !== staleMasked); // …but the stored copies are fresh
  assert.ok(second[0]!.original !== staleOriginal);
  assert.equal(second[0]!.masked.content, "[REMASKED]");
  assert.equal(second[0]!.hash, "hash-2");
});

test("unchanged-hash merge still confirms pending assistant responses", () => {
  const message = { role: "assistant", timestamp: 2, content: [{ type: "text", text: "hi" }] };
  const pending = mergePendingAssistant([], message, message, 5);
  pending[0]!.hash = "hash-pending";

  const confirmed = mergeTranscript(pending, [message], [message], 9, ["hash-pending"]);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0]!.pending, false);
  assert.ok(confirmed[0]!.original === pending[0]!.original);
});

test("legacy callers without hashes keep updating entries in place", () => {
  const original = { role: "user", timestamp: 1, content: "secret" };
  const first = mergeTranscript([], [original], [original], 10);
  const second = mergeTranscript(first, [original], [{ ...original, content: "[MASKED]" }], 20);
  assert.equal(second[0]!.masked.content, "[MASKED]");
  assert.equal(second[0]!.capturedAt, 20);
});

test("transcriptKey is stable for timestamped messages regardless of index", () => {
  const message = { role: "user", timestamp: 42, content: "x" };
  assert.equal(transcriptKey(message, 0), transcriptKey(message, 7));
});
