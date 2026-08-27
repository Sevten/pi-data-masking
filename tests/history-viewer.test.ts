import assert from "node:assert/strict";
import test from "node:test";
import { createEpochHistoryViewer, createHistoryViewer, diffText, mergePendingAssistant, mergeTranscript } from "../history-viewer.ts";
import type { RuleEpoch } from "../rule-epoch.ts";

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

test("text diff does not split a replacement at its shared word suffix", () => {
  assert.deepEqual(
    diffText("mysecret", "maskedsecret"),
    [{ original: "mysecret", masked: "maskedsecret", changed: true }],
  );
});

test("N/P navigates every masked occurrence, including repeated mappings", () => {
  let renderRequests = 0;
  const theme = {
    fg: (_color: unknown, text: string) => text,
    bg: (_color: unknown, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    inverse: (text: string) => `[selected]${text}[/selected]`,
    underline: (text: string) => text,
  };
  const keybindings = { matches: (data: string, keybinding: string) => data === keybinding };
  const entry = (key: string, original: string, masked: string) => ({
    key,
    original: { role: "user", content: original },
    masked: { role: "user", content: masked },
    capturedAt: 1,
  });

  const single = createHistoryViewer(
    { terminal: { rows: 20 }, requestRender: () => { renderRequests++; } },
    theme,
    keybindings,
    [entry("user:1", "mysecret", "maskedsecret")],
    () => undefined,
  );
  const singleRender = single.render(120).join("\n");
  assert.match(singleRender, /Masked occurrence 1\/1 \(only\).*LOCAL: mysecret.*MODEL: maskedsecret/);
  assert.doesNotMatch(singleRender, /N\/P masked text/);
  single.handleInput?.("n");
  assert.equal(renderRequests, 0);

  const multiple = createHistoryViewer(
    { terminal: { rows: 8 }, requestRender: () => { renderRequests++; } },
    theme,
    keybindings,
    [
      entry("user:1", "old same-secret", "old same-masked"),
      entry("user:2", "unchanged", "unchanged"),
      entry("user:3", "latest same-secret", "latest same-masked"),
    ],
    () => undefined,
  );
  const latest = multiple.render(120).join("\n");
  assert.match(latest, /N\/P masked text/);
  assert.match(latest, /Masked occurrence 2\/2 \(selected\)/);
  assert.match(latest, /latest same-/);
  assert.doesNotMatch(latest, /old same-/);

  multiple.handleInput?.("n");
  const wrapped = multiple.render(120).join("\n");
  assert.match(wrapped, /Masked occurrence 1\/2 \(selected\)/);
  assert.match(wrapped, /old same-/);
  assert.doesNotMatch(wrapped, /latest same-/);
});

test("M toggles original and masked views while Ctrl+M is not captured", () => {
  let renderRequests = 0;
  const theme = {
    fg: (_color: unknown, text: string) => text,
    bg: (_color: unknown, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    inverse: (text: string) => text,
    underline: (text: string) => text,
  };
  const viewer = createHistoryViewer(
    { terminal: { rows: 12 }, requestRender: () => { renderRequests++; } },
    theme,
    { matches: () => false },
    [{
      key: "user:1",
      original: { role: "user", content: "mysecret" },
      masked: { role: "user", content: "maskedsecret" },
      capturedAt: 1,
    }],
    () => undefined,
  );

  const original = viewer.render(120).join("\n");
  assert.match(original, /LOCAL ORIGINAL/);
  assert.match(original, /M original\/masked · C side-by-side compare/);

  viewer.handleInput?.("m");
  const masked = viewer.render(120).join("\n");
  assert.match(masked, /MODEL INPUT/);
  assert.equal(renderRequests, 1);

  // Ctrl+M is carriage return in terminals; leave it to the host instead of
  // treating Enter as a history-view mode switch.
  viewer.handleInput?.("\r");
  assert.match(viewer.render(120).join("\n"), /MODEL INPUT/);
  assert.equal(renderRequests, 1);

  viewer.handleInput?.("M");
  assert.match(viewer.render(120).join("\n"), /LOCAL ORIGINAL/);
  assert.equal(renderRequests, 2);
});

test("selected replacement styling does not reset the surrounding message background", () => {
  const calls: string[] = [];
  const theme = {
    fg: (_color: unknown, text: string) => text,
    bg: (color: unknown, text: string) => {
      calls.push(String(color));
      return `<bg:${String(color)}>${text}</bg>`;
    },
    bold: (text: string) => text,
    italic: (text: string) => text,
    inverse: (text: string) => `<inverse>${text}</inverse>`,
    underline: (text: string) => text,
  };
  const viewer = createHistoryViewer(
    { terminal: { rows: 12 }, requestRender: () => undefined },
    theme,
    { matches: () => false },
    [{
      key: "user:1",
      original: { role: "user", content: "mysecret" },
      masked: { role: "user", content: "maskedsecret" },
      capturedAt: 1,
    }],
    () => undefined,
  );

  const rendered = viewer.render(120).join("\n");
  assert.match(rendered, /<inverse>mysecret<\/inverse>/);
  assert.deepEqual(new Set(calls), new Set(["userMessageBg"]));
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

  const initial = viewer.render(100).join("\n");
  const firstPageRenders = backgroundRenders;
  assert.match(initial, /message 999/);
  assert.doesNotMatch(initial, /message 0(?:\D|$)/);
  assert.ok(firstPageRenders > 0);
  assert.ok(firstPageRenders < 20, `first page rendered ${firstPageRenders} message backgrounds`);

  viewer.handleInput?.("tui.select.pageUp");
  viewer.render(100);

  assert.equal(renderRequests, 1);
  assert.ok(backgroundRenders > firstPageRenders);
  assert.ok(backgroundRenders < 40, `two pages rendered ${backgroundRenders} message backgrounds`);

  const twoPageRenders = backgroundRenders;
  viewer.handleInput?.("tui.select.pageDown");
  viewer.render(100);
  assert.equal(backgroundRenders, twoPageRenders);
});

test("epoch history defaults to the latest factual version and switches without simulated messages", () => {
  let renderRequests = 0;
  const theme = {
    fg: (_color: unknown, text: string) => text,
    bg: (_color: unknown, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
  };
  const keybindings = { matches: (data: string, keybinding: string) => data === keybinding };
  const makeEpoch = (epochId: number): RuleEpoch => ({
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
  });
  const entry = (key: string, content: string) => ({
    key,
    original: { role: "user", content },
    masked: { role: "user", content },
    capturedAt: 1,
  });
  const viewer = createEpochHistoryViewer(
    { terminal: { rows: 20 }, requestRender: () => { renderRequests++; } },
    theme,
    keybindings,
    [
      { epoch: makeEpoch(1), entries: [entry("user:1", "only factual in E1")] },
      { epoch: makeEpoch(2), entries: [] },
      { epoch: makeEpoch(3), entries: [entry("user:3", "only factual in E3")] },
    ],
    () => undefined,
  );

  const latest = viewer.render(120).join("\n");
  assert.match(latest, /E3 \(2\/2\)/);
  assert.match(latest, /only factual in E3/);
  assert.doesNotMatch(latest, /only factual in E1/);

  viewer.handleInput?.("[");
  const previous = viewer.render(120).join("\n");
  assert.match(previous, /E1 \(1\/2\)/);
  assert.match(previous, /only factual in E1/);
  assert.doesNotMatch(previous, /only factual in E3/);
  assert.equal(renderRequests, 1);
});
