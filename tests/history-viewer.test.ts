import assert from "node:assert/strict";
import test from "node:test";
import { diffText, mergePendingAssistant, mergeTranscript } from "../history-viewer.ts";

test("history transcript updates a context message instead of duplicating it", () => {
  const original = { role: "user", timestamp: 1, content: "secret" };
  const first = mergeTranscript([], [original], [original], 10);
  const second = mergeTranscript(first, [original], [{ ...original, content: "[MASKED]" }], 20);

  assert.equal(second.length, 1);
  assert.equal(second[0]!.masked.content, "[MASKED]");
  assert.equal(second[0]!.capturedAt, 20);
});

test("pending assistant response is replaced once it reaches context", () => {
  const assistant = { role: "assistant", timestamp: 2, content: [{ type: "text", text: "secret" }] };
  const pending = mergePendingAssistant([], assistant, assistant, 10);
  const confirmed = mergeTranscript(
    pending,
    [assistant],
    [{ ...assistant, content: [{ type: "text", text: "[MASKED]" }] }],
    20,
  );

  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0]!.pending, false);
  assert.deepEqual(confirmed[0]!.masked.content, [{ type: "text", text: "[MASKED]" }]);
});

test("text diff keeps replacement spans separate without injecting punctuation", () => {
  assert.deepEqual(
    diffText("token=secret; keep=this", "token=[MASKED]; keep=this"),
    [
      { original: "token=", masked: "token=", changed: false },
      { original: "secret", masked: "[MASKED]", changed: true },
      { original: "; keep=this", masked: "; keep=this", changed: false },
    ],
  );
});
