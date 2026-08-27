import {
  applyMessageSnapshot,
  buildMessageSnapshot,
  parseMessageSnapshot,
  type MessageSnapshot,
  type SessionEntryLike,
} from "./history-persistence.ts";
import {
  transcriptKey,
  type MessageContentHashPair,
  type TranscriptEntry,
} from "./history-viewer.ts";
import { hashMessage } from "./masked-cache.ts";
import { RULE_EPOCH_ENTRY, parseRuleEpoch, type RuleEpoch } from "./rule-epoch.ts";

type JsonRecord = Record<string, unknown>;

export const EPOCH_TRANSCRIPT_ENTRY = "pi-data-masking.epoch-transcript.v1";

/** One message as it actually crossed an outbound boundary under an epoch. */
export interface EpochFactObservation {
  messageKey: string;
  original: JsonRecord;
  masked: JsonRecord;
  hashes: MessageContentHashPair;
}

export interface PersistedEpochMessage {
  recordKey: string;
  messageKey: string;
  originalHash: string;
  maskedHash: string;
  firstObservedAt: number;
  lastObservedAt: number;
  snapshot: MessageSnapshot;
}

export interface EpochTranscriptBatch {
  version: 1;
  epochId: number;
  capturedAt: number;
  messages: PersistedEpochMessage[];
}

export interface EpochTranscriptEntry extends TranscriptEntry {
  recordKey: string;
  messageKey: string;
  originalHash: string;
  maskedHash: string;
  firstObservedAt: number;
  lastObservedAt: number;
}

export interface EpochTranscriptState {
  epoch: RuleEpoch;
  entries: EpochTranscriptEntry[];
  records: Map<string, EpochTranscriptEntry>;
  /** The masked fingerprint last successfully appended for each record. */
  persistedMaskedHashes: Map<string, string>;
}

export interface EpochTranscriptMergeResult {
  batch?: EpochTranscriptBatch;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function epochRecordKey(messageKey: string, originalHash: string): string {
  return `${messageKey}:${originalHash}`;
}

export function createEpochTranscriptState(epoch: RuleEpoch): EpochTranscriptState {
  return {
    epoch,
    entries: [],
    records: new Map(),
    persistedMaskedHashes: new Map(),
  };
}

function persistedMessage(entry: EpochTranscriptEntry): PersistedEpochMessage {
  const snapshot = buildMessageSnapshot(entry.original, entry.masked, 0);
  snapshot.messageKey = entry.messageKey;
  return {
    recordKey: entry.recordKey,
    messageKey: entry.messageKey,
    originalHash: entry.originalHash,
    maskedHash: entry.maskedHash,
    firstObservedAt: entry.firstObservedAt,
    lastObservedAt: entry.lastObservedAt,
    snapshot,
  };
}

/**
 * Add the cumulative union of factual observations for one epoch. Repeated
 * tool-loop requests with identical content update only in-memory recency and
 * do not produce another persisted batch after the first append succeeds.
 */
export function mergeEpochFacts(
  state: EpochTranscriptState,
  observations: readonly EpochFactObservation[],
  capturedAt = Date.now(),
): EpochTranscriptMergeResult {
  const changedForPersistence = new Map<string, EpochTranscriptEntry>();

  for (const observation of observations) {
    const recordKey = epochRecordKey(observation.messageKey, observation.hashes.original);
    let entry = state.records.get(recordKey);
    if (!entry) {
      entry = {
        key: observation.messageKey,
        recordKey,
        messageKey: observation.messageKey,
        originalHash: observation.hashes.original,
        maskedHash: observation.hashes.masked,
        original: structuredClone(observation.original),
        masked: structuredClone(observation.masked),
        capturedAt,
        firstObservedAt: capturedAt,
        lastObservedAt: capturedAt,
        contentHashes: { ...observation.hashes },
      };
      state.records.set(recordKey, entry);
      state.entries.push(entry);
    } else {
      entry.lastObservedAt = capturedAt;
      entry.capturedAt = capturedAt;
      if (entry.maskedHash !== observation.hashes.masked) {
        entry.original = structuredClone(observation.original);
        entry.masked = structuredClone(observation.masked);
        entry.maskedHash = observation.hashes.masked;
        entry.contentHashes = { ...observation.hashes };
      }
    }

    if (state.persistedMaskedHashes.get(recordKey) !== entry.maskedHash) {
      changedForPersistence.set(recordKey, entry);
    }
  }

  if (changedForPersistence.size === 0) return {};
  return {
    batch: {
      version: 1,
      epochId: state.epoch.epochId,
      capturedAt,
      messages: [...changedForPersistence.values()].map(persistedMessage),
    },
  };
}

/** Call only after appendEntry succeeds, so a failed append is retried later. */
export function markEpochBatchPersisted(
  state: EpochTranscriptState,
  batch: EpochTranscriptBatch,
): void {
  if (batch.epochId !== state.epoch.epochId) return;
  for (const message of batch.messages) {
    state.persistedMaskedHashes.set(message.recordKey, message.maskedHash);
  }
}

function parsePersistedEpochMessage(value: unknown): PersistedEpochMessage | undefined {
  if (!isRecord(value)) return undefined;
  const snapshot = parseMessageSnapshot(value.snapshot);
  if (
    typeof value.recordKey !== "string" ||
    typeof value.messageKey !== "string" ||
    !isHash(value.originalHash) ||
    !isHash(value.maskedHash) ||
    !isFiniteTimestamp(value.firstObservedAt) ||
    !isFiniteTimestamp(value.lastObservedAt) ||
    value.lastObservedAt < value.firstObservedAt ||
    value.recordKey !== epochRecordKey(value.messageKey, value.originalHash) ||
    !snapshot || snapshot.messageKey !== value.messageKey
  ) return undefined;
  return {
    recordKey: value.recordKey,
    messageKey: value.messageKey,
    originalHash: value.originalHash,
    maskedHash: value.maskedHash,
    firstObservedAt: value.firstObservedAt,
    lastObservedAt: value.lastObservedAt,
    snapshot,
  };
}

export function parseEpochTranscriptBatch(value: unknown): EpochTranscriptBatch | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.epochId !== "number" ||
    !Number.isInteger(value.epochId) ||
    value.epochId < 1 ||
    !isFiniteTimestamp(value.capturedAt) ||
    !Array.isArray(value.messages)
  ) return undefined;
  const messages = value.messages.map(parsePersistedEpochMessage);
  if (messages.some((message) => message === undefined)) return undefined;
  return {
    version: 1,
    epochId: value.epochId,
    capturedAt: value.capturedAt,
    messages: messages as PersistedEpochMessage[],
  };
}

/** Restore only facts whose local original still exists on the active branch. */
export function restoreEpochTranscripts(
  sessionEntries: readonly SessionEntryLike[],
  epochs: readonly RuleEpoch[],
  originals: readonly JsonRecord[],
): Map<number, EpochTranscriptState> {
  const states = new Map(epochs.map((epoch) => [epoch.epochId, createEpochTranscriptState(epoch)]));
  const originalsByRecordKey = new Map<string, JsonRecord>();
  for (let index = 0; index < originals.length; index++) {
    const original = originals[index]!;
    const messageKey = transcriptKey(original, index);
    originalsByRecordKey.set(epochRecordKey(messageKey, hashMessage(original)), original);
  }

  let activeEpochId: number | undefined;
  let nextEpochIndex = 0;
  for (const sessionEntry of sessionEntries) {
    if (sessionEntry.type !== "custom") continue;
    if (sessionEntry.customType === RULE_EPOCH_ENTRY) {
      const parsed = parseRuleEpoch(sessionEntry.data);
      const expected = epochs[nextEpochIndex];
      if (
        parsed && expected &&
        parsed.epochId === expected.epochId &&
        parsed.behaviorFingerprint === expected.behaviorFingerprint
      ) {
        activeEpochId = parsed.epochId;
        nextEpochIndex++;
      }
      continue;
    }
    if (sessionEntry.customType !== EPOCH_TRANSCRIPT_ENTRY) continue;
    const batch = parseEpochTranscriptBatch(sessionEntry.data);
    const state = batch ? states.get(batch.epochId) : undefined;
    // A transcript can grow only while its owning epoch is the active record
    // in the append-only log. Late batches cannot mutate a closed epoch.
    if (!batch || !state || batch.epochId !== activeEpochId) continue;

    for (const message of batch.messages) {
      const original = originalsByRecordKey.get(message.recordKey);
      if (!original) continue;
      const applied = applyMessageSnapshot(original, message.snapshot);
      if (!applied.valid || hashMessage(applied.message) !== message.maskedHash) continue;

      const prior = state.records.get(message.recordKey);
      if (prior) {
        prior.masked = applied.message;
        prior.maskedHash = message.maskedHash;
        prior.lastObservedAt = Math.max(prior.lastObservedAt, message.lastObservedAt);
        prior.capturedAt = Math.max(prior.capturedAt, batch.capturedAt);
        prior.contentHashes = { original: message.originalHash, masked: message.maskedHash };
      } else {
        const entry: EpochTranscriptEntry = {
          key: message.messageKey,
          recordKey: message.recordKey,
          messageKey: message.messageKey,
          originalHash: message.originalHash,
          maskedHash: message.maskedHash,
          original: structuredClone(original),
          masked: applied.message,
          capturedAt: batch.capturedAt,
          firstObservedAt: message.firstObservedAt,
          lastObservedAt: message.lastObservedAt,
          contentHashes: { original: message.originalHash, masked: message.maskedHash },
        };
        state.records.set(message.recordKey, entry);
        state.entries.push(entry);
      }
      state.persistedMaskedHashes.set(message.recordKey, message.maskedHash);
    }
  }

  return states;
}
