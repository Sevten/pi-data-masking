import assert from "node:assert/strict";
import test from "node:test";
import {
  EPOCH_TRANSCRIPT_ENTRY,
  createEpochTranscriptState,
  markEpochBatchPersisted,
  mergeEpochFacts,
  restoreEpochTranscripts,
  type EpochFactObservation,
} from "../epoch-transcript.ts";
import { hashMessage } from "../masked-cache.ts";
import type { RuleEpoch } from "../rule-epoch.ts";

function epoch(epochId: number): RuleEpoch {
  return {
    version: 1,
    epochId,
    parentEpochId: epochId > 1 ? epochId - 1 : undefined,
    activatedAt: epochId,
    behaviorFingerprint: `fingerprint-${epochId}`,
    enabled: true,
    caseSensitive: true,
    systemPromptGuidance: false,
    reason: epochId === 1 ? "session_start" : "ui_edit",
    rules: [],
    changes: [{ kind: epochId === 1 ? "initialized" : "configuration_changed" }],
  };
}

function observation(
  original: Record<string, unknown>,
  masked: Record<string, unknown>,
  messageKey = "user:1",
): EpochFactObservation {
  return {
    messageKey,
    original,
    masked,
    hashes: { original: hashMessage(original), masked: hashMessage(masked) },
  };
}

test("epoch facts persist once across repeated tool-loop requests", () => {
  const state = createEpochTranscriptState(epoch(1));
  const original = { role: "user", timestamp: 1, content: "token=secret" };
  const masked = { ...original, content: "token=MASK" };

  const first = mergeEpochFacts(state, [observation(original, masked)], 10);
  assert.ok(first.batch);
  assert.equal(first.batch.messages.length, 1);
  markEpochBatchPersisted(state, first.batch);

  const repeated = mergeEpochFacts(state, [observation(original, masked)], 20);
  assert.equal(repeated.batch, undefined);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0]!.firstObservedAt, 10);
  assert.equal(state.entries[0]!.lastObservedAt, 20);
});

test("the same logical message keeps distinct factual source revisions", () => {
  const state = createEpochTranscriptState(epoch(1));
  const first = { role: "user", timestamp: 1, content: "first secret" };
  const second = { role: "user", timestamp: 1, content: "edited secret" };

  mergeEpochFacts(state, [observation(first, { ...first, content: "first MASK" })], 10);
  mergeEpochFacts(state, [observation(second, { ...second, content: "edited MASK" })], 20);

  assert.equal(state.entries.length, 2);
  assert.notEqual(state.entries[0]!.recordKey, state.entries[1]!.recordKey);
});

test("epoch transcripts restore exact stored masking facts", () => {
  const ruleEpoch = epoch(1);
  const state = createEpochTranscriptState(ruleEpoch);
  const original = { role: "user", timestamp: 1, content: "token=secret" };
  const masked = { ...original, content: "token=MASK" };
  const batch = mergeEpochFacts(state, [observation(original, masked)], 10).batch!;

  const restored = restoreEpochTranscripts(
    [
      { type: "custom", customType: "pi-data-masking.rule-epoch.v1", data: ruleEpoch },
      { type: "custom", customType: EPOCH_TRANSCRIPT_ENTRY, data: batch },
    ],
    [ruleEpoch],
    [original],
  );

  assert.equal(restored.get(1)!.entries.length, 1);
  assert.equal(restored.get(1)!.entries[0]!.masked.content, "token=MASK");
  assert.equal(restored.get(1)!.persistedMaskedHashes.size, 1);
});

test("a newer epoch contains only messages it actually processed after compaction", () => {
  const firstEpoch = createEpochTranscriptState(epoch(1));
  const secondEpoch = createEpochTranscriptState(epoch(2));
  const oldMessage = { role: "user", timestamp: 1, content: "old secret" };
  const retainedMessage = { role: "user", timestamp: 2, content: "retained secret" };

  mergeEpochFacts(firstEpoch, [
    observation(oldMessage, { ...oldMessage, content: "old MASK" }, "user:1"),
    observation(retainedMessage, { ...retainedMessage, content: "retained MASK" }, "user:2"),
  ]);
  mergeEpochFacts(secondEpoch, [
    observation(retainedMessage, { ...retainedMessage, content: "retained MASK-2" }, "user:2"),
  ]);

  assert.deepEqual(firstEpoch.entries.map((entry) => entry.messageKey), ["user:1", "user:2"]);
  assert.deepEqual(secondEpoch.entries.map((entry) => entry.messageKey), ["user:2"]);
});

test("invalid or unknown epoch batches are ignored during recovery", () => {
  const restored = restoreEpochTranscripts([
    { type: "custom", customType: EPOCH_TRANSCRIPT_ENTRY, data: { version: 1, epochId: 1, capturedAt: 1, messages: [{}] } },
    { type: "custom", customType: EPOCH_TRANSCRIPT_ENTRY, data: { version: 1, epochId: 99, capturedAt: 1, messages: [] } },
  ], [epoch(1)], []);

  assert.equal(restored.get(1)!.entries.length, 0);
});

test("recovery refuses a late batch that tries to mutate a closed epoch", () => {
  const first = epoch(1);
  const second = epoch(2);
  const original = { role: "user", timestamp: 1, content: "token=secret" };
  const state = createEpochTranscriptState(first);
  const originalBatch = mergeEpochFacts(
    state,
    [observation(original, { ...original, content: "token=MASK-1" })],
    10,
  ).batch!;
  const lateState = createEpochTranscriptState(first);
  const lateBatch = mergeEpochFacts(
    lateState,
    [observation(original, { ...original, content: "token=ILLEGAL-LATE-MASK" })],
    20,
  ).batch!;

  const restored = restoreEpochTranscripts([
    { type: "custom", customType: "pi-data-masking.rule-epoch.v1", data: first },
    { type: "custom", customType: EPOCH_TRANSCRIPT_ENTRY, data: originalBatch },
    { type: "custom", customType: "pi-data-masking.rule-epoch.v1", data: second },
    { type: "custom", customType: EPOCH_TRANSCRIPT_ENTRY, data: lateBatch },
  ], [first, second], [original]);

  assert.equal(restored.get(1)!.entries[0]!.masked.content, "token=MASK-1");
  assert.equal(restored.get(2)!.entries.length, 0);
});
