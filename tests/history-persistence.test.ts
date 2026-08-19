import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_STATE_ENTRY,
  SNAPSHOT_ENTRY,
  applyMessageSnapshot,
  buildMessageSnapshot,
  restoreHistory,
  type SnapshotBatch,
} from "../history-persistence.ts";

test("message snapshot reconstructs the exact masked strings from position deltas", () => {
  const original = {
    role: "user",
    timestamp: 1,
    content: [{ type: "text", text: "first=secret-one second=secret-two" }],
  };
  const masked = {
    ...original,
    content: [{ type: "text", text: "first=MASK-A second=MASK-B" }],
  };
  const snapshot = buildMessageSnapshot(original, masked, 0);
  const restored = applyMessageSnapshot(original, snapshot);

  assert.equal(restored.valid, true);
  assert.deepEqual(restored.message, masked);
  assert.ok(snapshot.changes.length > 0);
  assert.equal(JSON.stringify(snapshot).includes("secret-one"), false);
  assert.equal(JSON.stringify(snapshot).includes("secret-two"), false);
});

test("history restores session key and the latest snapshot on the active branch", () => {
  const key = Buffer.alloc(32, 7);
  const original = { role: "user", timestamp: 1, content: "token=secret" };
  const first = buildMessageSnapshot(original, { ...original, content: "token=MASK-1" }, 0);
  const latest = buildMessageSnapshot(original, { ...original, content: "token=MASK-2" }, 0);
  const batch = (requestSequence: number, snapshot: typeof first): SnapshotBatch => ({
    version: 1,
    requestSequence,
    capturedAt: requestSequence,
    messages: [snapshot],
  });

  const restored = restoreHistory([
    { type: "custom", customType: SESSION_STATE_ENTRY, data: { version: 1, sessionKey: key.toString("base64") } },
    { type: "message", message: original },
    { type: "custom", customType: SNAPSHOT_ENTRY, data: batch(1, first) },
    { type: "custom", customType: SNAPSHOT_ENTRY, data: batch(2, latest) },
  ]);

  assert.deepEqual(restored.sessionKey, key);
  assert.equal(restored.requestSequence, 2);
  assert.equal(restored.transcript[0]!.masked.content, "token=MASK-2");
  assert.equal(restored.transcript[0]!.snapshotMissing, false);
});

test("legacy messages without snapshots are restored but explicitly marked", () => {
  const restored = restoreHistory([
    { type: "message", message: { role: "user", timestamp: 1, content: "legacy" } },
  ]);

  assert.equal(restored.transcript.length, 1);
  assert.equal(restored.transcript[0]!.original.content, "legacy");
  assert.equal(restored.transcript[0]!.masked.content, "legacy");
  assert.equal(restored.transcript[0]!.snapshotMissing, true);
});
