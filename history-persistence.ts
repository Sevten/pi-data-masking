import { createHash } from "node:crypto";
import { diffText, transcriptKey, type TranscriptEntry } from "./history-viewer.ts";

type JsonRecord = Record<string, unknown>;
type PathPart = string | number;

export const SESSION_STATE_ENTRY = "pi-data-masking.session.v1";
export const SNAPSHOT_ENTRY = "pi-data-masking.snapshot.v1";

export interface PersistedSessionState {
  version: 1;
  sessionKey: string;
}

export interface TextReplacement {
  start: number;
  end: number;
  masked: string;
}

export interface TextChange {
  path: PathPart[];
  originalHash: string;
  replacements: TextReplacement[];
}

export interface MessageSnapshot {
  messageKey: string;
  signature: string;
  changes: TextChange[];
}

export interface SnapshotBatch {
  version: 1;
  requestSequence: number;
  capturedAt: number;
  messages: MessageSnapshot[];
}

export interface SessionEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafePath(path: unknown[]): path is PathPart[] {
  return path.every((part) =>
    (typeof part === "number" && Number.isInteger(part) && part >= 0) ||
    (typeof part === "string" && part !== "__proto__" && part !== "prototype" && part !== "constructor")
  );
}

function textHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function collectTextChanges(original: unknown, masked: unknown, path: PathPart[], output: TextChange[]): void {
  if (typeof original === "string" && typeof masked === "string") {
    if (original === masked) return;
    let offset = 0;
    const replacements: TextReplacement[] = [];
    for (const segment of diffText(original, masked)) {
      if (segment.changed) {
        replacements.push({ start: offset, end: offset + segment.original.length, masked: segment.masked });
      }
      offset += segment.original.length;
    }
    output.push({ path: [...path], originalHash: textHash(original), replacements });
    return;
  }

  if (Array.isArray(original) && Array.isArray(masked)) {
    for (let index = 0; index < Math.min(original.length, masked.length); index++) {
      collectTextChanges(original[index], masked[index], [...path, index], output);
    }
    return;
  }

  if (isRecord(original) && isRecord(masked)) {
    for (const key of Object.keys(original)) {
      if (key in masked) collectTextChanges(original[key], masked[key], [...path, key], output);
    }
  }
}

export function buildMessageSnapshot(
  original: JsonRecord,
  masked: JsonRecord,
  index: number,
): MessageSnapshot {
  const changes: TextChange[] = [];
  collectTextChanges(original, masked, [], changes);
  const signature = createHash("sha256").update(JSON.stringify(changes)).digest("hex");
  return { messageKey: transcriptKey(original, index), signature, changes };
}

function setAtPath(root: JsonRecord, path: PathPart[], change: TextChange): boolean {
  if (path.length === 0) return false;
  let target: unknown = root;
  for (const part of path.slice(0, -1)) {
    if (typeof part === "number") {
      if (!Array.isArray(target)) return false;
      target = target[part];
    } else {
      if (!isRecord(target)) return false;
      target = target[part];
    }
  }

  const leaf = path[path.length - 1]!;
  const value = typeof leaf === "number"
    ? Array.isArray(target) ? target[leaf] : undefined
    : isRecord(target) ? target[leaf] : undefined;
  if (typeof value !== "string" || textHash(value) !== change.originalHash) return false;

  let reconstructed = value;
  const replacements = [...change.replacements].sort((a, b) => b.start - a.start);
  for (const replacement of replacements) {
    if (replacement.start < 0 || replacement.end < replacement.start || replacement.end > reconstructed.length) return false;
    reconstructed = reconstructed.slice(0, replacement.start) + replacement.masked + reconstructed.slice(replacement.end);
  }

  if (typeof leaf === "number" && Array.isArray(target)) target[leaf] = reconstructed;
  else if (typeof leaf === "string" && isRecord(target)) target[leaf] = reconstructed;
  else return false;
  return true;
}

export function applyMessageSnapshot(
  original: JsonRecord,
  snapshot: MessageSnapshot,
): { message: JsonRecord; valid: boolean } {
  const message = structuredClone(original);
  for (const change of snapshot.changes) {
    if (!setAtPath(message, change.path, change)) return { message: structuredClone(original), valid: false };
  }
  return { message, valid: true };
}

function asMessageSnapshot(value: unknown): MessageSnapshot | undefined {
  if (!isRecord(value) || typeof value.messageKey !== "string" || typeof value.signature !== "string" || !Array.isArray(value.changes)) {
    return undefined;
  }
  const changes: TextChange[] = [];
  for (const rawChange of value.changes) {
    if (!isRecord(rawChange) || !Array.isArray(rawChange.path) || !isSafePath(rawChange.path) || typeof rawChange.originalHash !== "string" || !Array.isArray(rawChange.replacements)) {
      return undefined;
    }
    const replacements: TextReplacement[] = [];
    for (const rawReplacement of rawChange.replacements) {
      if (
        !isRecord(rawReplacement) ||
        typeof rawReplacement.start !== "number" ||
        !Number.isInteger(rawReplacement.start) ||
        typeof rawReplacement.end !== "number" ||
        !Number.isInteger(rawReplacement.end) ||
        typeof rawReplacement.masked !== "string"
      ) {
        return undefined;
      }
      replacements.push({ start: rawReplacement.start, end: rawReplacement.end, masked: rawReplacement.masked });
    }
    changes.push({ path: rawChange.path as PathPart[], originalHash: rawChange.originalHash, replacements });
  }
  return { messageKey: value.messageKey, signature: value.signature, changes };
}

function asSnapshotBatch(value: unknown): SnapshotBatch | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.requestSequence !== "number" || typeof value.capturedAt !== "number" || !Array.isArray(value.messages)) {
    return undefined;
  }
  const messages = value.messages.map(asMessageSnapshot);
  if (messages.some((message) => message === undefined)) return undefined;
  return {
    version: 1,
    requestSequence: value.requestSequence,
    capturedAt: value.capturedAt,
    messages: messages as MessageSnapshot[],
  };
}

export interface RestoredHistory {
  transcript: TranscriptEntry[];
  messages: JsonRecord[];
  signatures: Map<string, string>;
  requestSequence: number;
  sessionKey?: Buffer;
}

/** Restore the active branch only; snapshots from sibling forks are excluded. */
export function restoreHistory(entries: readonly SessionEntryLike[]): RestoredHistory {
  const originals: JsonRecord[] = [];
  const latestSnapshots = new Map<string, MessageSnapshot>();
  const signatures = new Map<string, string>();
  let requestSequence = 0;
  let sessionKey: Buffer | undefined;

  for (const entry of entries) {
    if (entry.type === "message" && isRecord(entry.message)) originals.push(structuredClone(entry.message));
    if (entry.type !== "custom" || typeof entry.customType !== "string") continue;

    if (entry.customType === SESSION_STATE_ENTRY && isRecord(entry.data) && entry.data.version === 1 && typeof entry.data.sessionKey === "string") {
      const candidate = Buffer.from(entry.data.sessionKey, "base64");
      if (candidate.length === 32) sessionKey = candidate;
    }
    if (entry.customType === SNAPSHOT_ENTRY) {
      const batch = asSnapshotBatch(entry.data);
      if (!batch) continue;
      requestSequence = Math.max(requestSequence, batch.requestSequence);
      for (const snapshot of batch.messages) {
        latestSnapshots.set(snapshot.messageKey, snapshot);
        signatures.set(snapshot.messageKey, snapshot.signature);
      }
    }
  }

  const transcript = originals.map((original, index): TranscriptEntry => {
    const key = transcriptKey(original, index);
    const snapshot = latestSnapshots.get(key);
    if (!snapshot) {
      return { key, original: structuredClone(original), masked: structuredClone(original), capturedAt: 0, snapshotMissing: true };
    }
    const applied = applyMessageSnapshot(original, snapshot);
    return {
      key,
      original: structuredClone(original),
      masked: applied.message,
      capturedAt: 0,
      snapshotMissing: !applied.valid,
    };
  });

  return { transcript, messages: originals, signatures, requestSequence, sessionKey };
}
