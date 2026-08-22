import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryViewer, diffText, mergePendingAssistant, mergeTranscript } from "../history-viewer.ts";

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

test("history scrolling renders only the visible transcript window", () => {
  let backgroundRenders = 0;
  let renderRequests = 0;
  const theme = {
    fg: (_color: unknown, text: string) => text,
    bg: (_color: unknown, text: string) => {
      backgroundRenders++;
      return text;
    },
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
  };
  const keybindings = {
    matches: (data: string, keybinding: string) => data === keybinding,
  };
  const entries = Array.from({ length: 1_000 }, (_, index) => ({
    key: `user:${index}`,
    original: { role: "user", content: `message ${index}` },
    masked: { role: "user", content: `message ${index}` },
    capturedAt: index,
  }));
  const viewer = createHistoryViewer(
    { terminal: { rows: 12 }, requestRender: () => { renderRequests++; } },
    theme,
    keybindings,
    entries,
    () => undefined,
  );

  viewer.render(100);
  const firstPageRenders = backgroundRenders;
  assert.ok(firstPageRenders > 0);
  assert.ok(firstPageRenders < 20, `first page rendered ${firstPageRenders} message backgrounds`);

  viewer.handleInput?.("tui.select.pageDown");
  viewer.render(100);

  assert.equal(renderRequests, 1);
  assert.ok(backgroundRenders > firstPageRenders);
  assert.ok(backgroundRenders < 40, `two pages rendered ${backgroundRenders} message backgrounds`);

  const twoPageRenders = backgroundRenders;
  viewer.handleInput?.("tui.select.pageUp");
  viewer.render(100);
  assert.equal(backgroundRenders, twoPageRenders);
});
