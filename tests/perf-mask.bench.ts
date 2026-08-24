/**
 * tests/perf-mask.bench.ts
 * Manual benchmark (excluded from `npm test`, which only globs *.test.ts).
 *
 * Run: node tests/perf-mask.bench.ts
 *
 * Models the per-turn cost shape of the context hook over a 200-message
 * conversation with 50 rules: cold fill (maskValue per message), the old
 * uncached behavior (re-run maskValue for everything every turn), and the
 * cached path (fingerprint lookup). Reports milliseconds; no assertions, so
 * timing noise can never fail a run.
 */

import { performance } from "node:perf_hooks";
import { Masker } from "../masker.ts";
import type { MaskingRule } from "../masker.ts";
import { MaskedCache, hashMessage } from "../masked-cache.ts";
import { transcriptKey } from "../history-viewer.ts";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
const MESSAGE_COUNT = 200;

const rules: MaskingRule[] = [
  { id: "phone", type: "regex", pattern: "\\b\\d{3}-\\d{3}-\\d{4}\\b" },
  ...Array.from({ length: 49 }, (_, index): MaskingRule => ({
    id: `literal-${index}`,
    real: `sk-service-${index}-aaaaaaaaaaaa`,
    placeholder: `placeholder-${index}`,
  })),
];

function buildConversation(): Array<{ role: string; content: string }> {
  return Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
    role: index % 5 === 4 ? "assistant" : "user",
    content:
      `Message ${index}: key sk-service-${index % 49}-aaaaaaaaaaaa and phone ${String(100 + index).slice(0, 3)}-555-${String(100000 + index).slice(-4)}. ` +
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20),
  }));
}

function runUncached(messages: unknown[], masker: Masker): void {
  for (const message of messages) {
    masker.maskValue(message, { discover: true });
  }
}

function runCached(messages: unknown[], cache: MaskedCache): { hits: number; misses: number } {
  let hits = 0;
  let misses = 0;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const key = transcriptKey(message as Record<string, unknown>, index);
    const hash = hashMessage(message);
    if (cache.lookup(key, hash) !== undefined) {
      hits++;
      continue;
    }
    misses++;
    cache.record(key, hash, hash, message);
  }
  return { hits, misses };
}

const messages = buildConversation();

// Cold fill through the real engine (also populates dynamicMap state).
const fillStart = performance.now();
const engine = new Masker(rules, true, KEY);
runUncached(messages, engine);
const fillMs = performance.now() - fillStart;

// Old behavior: re-mask everything on the next turn.
const uncachedStart = performance.now();
runUncached(messages, engine);
const uncachedMs = performance.now() - uncachedStart;

// Cached behavior: fingerprints only.
const cache = new MaskedCache();
for (let index = 0; index < messages.length; index++) {
  const key = transcriptKey(messages[index] as Record<string, unknown>, index);
  const hash = hashMessage(messages[index]);
  cache.record(key, hash, hash, messages[index]);
}
const cachedStart = performance.now();
const { hits } = runCached(messages, cache);
const cachedMs = performance.now() - cachedStart;

console.log(`messages=${MESSAGE_COUNT} rules=${rules.length}`);
console.log(`cold fill:        ${fillMs.toFixed(2)} ms`);
console.log(`uncached re-pass: ${uncachedMs.toFixed(2)} ms`);
console.log(`cached lookups:   ${cachedMs.toFixed(2)} ms (${hits}/${messages.length} hits)`);
