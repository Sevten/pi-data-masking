import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createEpochHistoryViewer, createHistoryViewer, mergePendingAssistant, mergeTranscript } from "../history-viewer.ts";
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
  assert.match(singleRender, /Selected masked occurrence 1\/1.*LOCAL: mysecret.*MODEL: maskedsecret/);
  assert.doesNotMatch(singleRender, /N\/P next\/previous occurrence/);
  assert.doesNotMatch(singleRender, /messages 1–1 of 1/);
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
  assert.match(latest, /N\/P next\/previous occurrence/);
  assert.match(latest, /Selected masked occurrence 2\/2/);
  assert.match(latest, /latest same-/);
  assert.doesNotMatch(latest, /old same-/);

  multiple.handleInput?.("n");
  const wrapped = multiple.render(120).join("\n");
  assert.match(wrapped, /Selected masked occurrence 1\/2/);
  assert.match(wrapped, /old same-/);
  assert.doesNotMatch(wrapped, /latest same-/);
});

test("only the current N/P target gets selected styling without display markers", () => {
  const theme = {
    fg: (_color: unknown, text: string) => text,
    bg: (_color: unknown, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    inverse: (text: string) => `<current>${text}</current>`,
    underline: (text: string) => `<masked>${text}</masked>`,
  };
  const viewer = createHistoryViewer(
    { terminal: { rows: 12 }, requestRender: () => undefined },
    theme,
    { matches: () => false },
    [{
      key: "user:1",
      original: { role: "user", content: "secret keep secret" },
      masked: { role: "user", content: "masked keep masked" },
      capturedAt: 1,
    }],
    () => undefined,
  );

  const latest = viewer.render(120).join("\n");
  assert.match(latest, /<masked>secret<\/masked> keep <current>secret<\/current>/);
  assert.doesNotMatch(latest, /[⟦⟧]/);

  viewer.handleInput?.("n");
  const first = viewer.render(120).join("\n");
  assert.match(first, /<current>secret<\/current> keep <masked>secret<\/masked>/);
  assert.doesNotMatch(first, /[⟦⟧]/);
});

test("selected styling covers only the factual masking span", () => {
  const viewer = createHistoryViewer(
    { terminal: { rows: 12 }, requestRender: () => undefined },
    {
      fg: (_color: unknown, text: string) => text,
      bg: (_color: unknown, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
      inverse: (text: string) => `<current>${text}</current>`,
      underline: (text: string) => text,
    },
    { matches: () => false },
    [{
      key: "user:1",
      original: { role: "user", content: "home.test.xyz" },
      masked: { role: "user", content: "home.example.com" },
      capturedAt: 1,
    }],
    () => undefined,
  );

  const rendered = viewer.render(120).join("\n");
  assert.match(rendered, /home\.<current>test\.xyz<\/current>/);
  assert.doesNotMatch(rendered, /<current>[^<]*[⟦⟧]/);
});

test("closing delimiters stay outside history highlighting and the occurrence inspector", () => {
  const viewer = createHistoryViewer(
    { terminal: { rows: 12 }, requestRender: () => undefined },
    {
      fg: (_color: unknown, text: string) => text,
      bg: (_color: unknown, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
      inverse: (text: string) => `<current>${text}</current>`,
      underline: (text: string) => text,
    },
    { matches: () => false },
    [{
      key: "user:1",
      original: { role: "user", content: "`wsl90.top`" },
      masked: { role: "user", content: "`test.xyz`" },
      capturedAt: 1,
    }],
    () => undefined,
  );

  const rendered = viewer.render(120).join("\n");
  assert.match(rendered, /`<current>wsl90\.top<\/current>`/);
  assert.match(rendered, /LOCAL: wsl90\.top  →  MODEL: test\.xyz(?:\s|$)/);
  assert.doesNotMatch(rendered, /LOCAL: wsl90\.top`|MODEL: test\.xyz`/);
});

test("wide assistant comparisons show one LOCAL/MODEL heading across content blocks", () => {
  const viewer = createHistoryViewer(
    { terminal: { rows: 16 }, requestRender: () => undefined },
    {
      fg: (_color: unknown, text: string) => text,
      bg: (_color: unknown, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
      underline: (text: string) => text,
    },
    { matches: () => false },
    [{
      key: "assistant:1",
      original: { role: "assistant", content: [
        { type: "text", text: "" },
        { type: "text", text: "first block" },
        { type: "text", text: "second private-token-12345" },
      ] },
      masked: { role: "assistant", content: [
        { type: "text", text: "" },
        { type: "text", text: "first block" },
        { type: "text", text: "second masked-token-67890" },
      ] },
      capturedAt: 1,
    }],
    () => undefined,
  );

  viewer.handleInput?.("C");
  const rendered = viewer.render(120).join("\n");
  assert.equal(rendered.match(/LOCAL ORIGINAL/g)?.length, 1);
  assert.equal(rendered.match(/MODEL INPUT/g)?.length, 1);
  assert.match(rendered, /first block/);
  assert.match(rendered, /second private-token-12345/);
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

  const narrowLines = viewer.render(40);
  // Footer text wraps at narrow widths, so join wrapped lines with spaces to
  // keep phrase-level assertions independent of the wrap points.
  const narrow = narrowLines.join(" ");
  assert.match(narrow, /↑↓\/PgUp\/PgDn scroll/);
  assert.match(narrow, /M original\/masked/);
  assert.match(narrow, /C side-by-side compare/);
  assert.match(narrow, /Ctrl\+O tools/);
  assert.match(narrow, /Ctrl\+T thinking/);
  assert.match(narrow, /Esc close/);
  assert.ok(narrowLines.every((line) => visibleWidth(line) <= 40));

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

test("/ search jumps between text matches incrementally", () => {
  const renderRequests: string[] = [];
  const theme = {
    fg: (_color: unknown, text: string) => text,
    bg: (_color: unknown, text: string) => text,
    bold: (text: string) => `[b]${text}[/b]`,
    italic: (text: string) => text,
    inverse: (text: string) => `[inv]${text}[/inv]`,
    underline: (text: string) => text,
  };
  const keybindings = { matches: (data: string, keybinding: string) => data === keybinding };
  const entry = (key: string, text: string) => ({
    key,
    original: { role: "user", content: text },
    masked: { role: "user", content: text },
    capturedAt: 1,
  });
  const viewer = createHistoryViewer(
    { terminal: { rows: 10 }, requestRender: () => { renderRequests.push("r"); } },
    theme,
    keybindings,
    [entry("user:1", "first needle here"), entry("user:2", "second needle here")],
    () => undefined,
  );
  viewer.render(80);

  // Opening search shows a prompt; typing jumps to the first match at or
  // after the live-edge viewport, i.e. the second entry here.
  viewer.handleInput?.("/");
  assert.match(viewer.render(80).join("\n"), /Search: ▏/);
  viewer.handleInput?.("n");
  viewer.handleInput?.("e");
  viewer.handleInput?.("e");
  const firstHit = viewer.render(80).join("\n");
  assert.match(firstHit, /Search: nee▏/);
  assert.match(firstHit, /2 matches/);
  // Highlight markup splits the matched word, so match around it.
  assert.match(firstHit, /second \[b\]\[inv\]nee\[\/inv\]\[\/b\]dle/);
  assert.doesNotMatch(firstHit, /first/);
  // Matches are inverse-highlighted; the focused hit is also bolded.
  assert.match(firstHit, /\[inv\]nee\[\/inv\]/);
  assert.match(firstHit, /\[b\]\[inv\]nee\[\/inv\]\[\/b\]/);

  // Enter advances and wraps past the end; focus styling moves with it.
  viewer.handleInput?.("\r");
  const wrapped = viewer.render(80).join("\n");
  assert.match(wrapped, /first \[b\]\[inv\]nee\[\/inv\]\[\/b\]dle/);
  viewer.handleInput?.("\r");
  assert.match(viewer.render(80).join("\n"), /second \[b\]\[inv\]nee\[\/inv\]\[\/b\]dle/);

  // Ctrl+R cycles focus backward (readline-style reverse search).
  viewer.handleInput?.("\x12");
  assert.match(viewer.render(80).join("\n"), /first \[b\]\[inv\]nee\[\/inv\]\[\/b\]dle/);

  // Backspace edits the query; Esc closes search mode and restores the footer.
  viewer.handleInput?.("\x7f");
  viewer.handleInput?.("\x7f");
  viewer.handleInput?.("\x7f");
  assert.match(viewer.render(80).join("\n"), /Search: ▏/);
  viewer.handleInput?.("tui.select.cancel");
  const closed = viewer.render(80).join("\n");
  assert.doesNotMatch(closed, /Search:/);
  assert.match(closed, /Esc close/);
  assert.ok(renderRequests.length > 0);
});

test("compare-view search targets the column of the pre-compare lens", () => {
  const theme = {
    fg: (_color: unknown, text: string) => text,
    bg: (_color: unknown, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    inverse: (text: string) => text,
    underline: (text: string) => text,
  };
  const keybindings = { matches: (data: string, keybinding: string) => data === keybinding };
  const entry = {
    key: "user:1",
    original: { role: "user", content: "needle alpha" },
    masked: { role: "user", content: "token alpha" },
    capturedAt: 1,
  };
  const viewer = createHistoryViewer(
    { terminal: { rows: 20 }, requestRender: () => {} },
    theme,
    keybindings,
    [entry],
    () => undefined,
  );
  viewer.render(120);

  const searchCount = (query: string, width = 120) => {
    viewer.handleInput?.("/");
    // A previous search may have left a query behind; clear it first.
    for (let i = 0; i < 40; i++) viewer.handleInput?.("\x7f");
    for (const ch of query) viewer.handleInput?.(ch);
    const output = viewer.render(width).join("\n");
    viewer.handleInput?.("tui.select.cancel");
    const match = /Search[^\n]*?(\d+) match/.exec(output);
    return match ? Number(match[1]) : null;
  };

  // From original view, "c" compares with LOCAL as the search column: the
  // real value hits once, the placeholder is invisible, and shared context
  // ("alpha", present in both columns) is counted once instead of twice.
  viewer.handleInput?.("c");
  assert.equal(searchCount("needle"), 1);
  assert.equal(searchCount("token"), 0);
  assert.equal(searchCount("alpha"), 1);

  // From model view, "c" compares with MODEL as the search column, and the
  // prompt names the scoped column.
  viewer.handleInput?.("m");
  viewer.handleInput?.("c");
  assert.equal(searchCount("token"), 1);
  assert.equal(searchCount("needle"), 0);
  viewer.handleInput?.("/");
  for (let i = 0; i < 40; i++) viewer.handleInput?.("\x7f");
  viewer.handleInput?.("t");
  assert.match(viewer.render(120).join("\n"), /Search · MODEL column: t▏/);
  viewer.handleInput?.("tui.select.cancel");

  // Narrow stacked layout keeps the same one-column semantics.
  viewer.render(80);
  assert.equal(searchCount("needle"), 0);
  assert.equal(searchCount("token"), 1);
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
  assert.doesNotMatch(rendered, /[⟦⟧]/);
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
  assert.match(initial, /messages \d+–1000 of 1000/);
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
    systemPromptGuidance: false,
      disclosePlaceholders: false,
    reason: epochId === 1 ? "session_start" : "ui_edit",
    rules: [{
      key: "project:token",
      id: "token",
      name: "Service token",
      scope: "project",
      sourceKind: "literal",
      enabled: true,
      available: true,
      order: 0,
      behaviorFingerprint: `rule-fingerprint-${epochId}`,
    }],
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
  assert.match(latest, /Rule version 2\/2 · 1 active rule/);
  assert.match(latest, /R view version rules/);
  assert.doesNotMatch(latest, /factual messages|Initial factual version|Changes from previous version/);
  assert.doesNotMatch(latest, /fingerprint|epoch E3|Masking history · E3/);
  assert.match(latest, /only factual in E3/);
  assert.doesNotMatch(latest, /only factual in E1/);

  viewer.handleInput?.("C");
  assert.match(viewer.render(120).join("\n"), /SIDE-BY-SIDE COMPARE/);
  viewer.handleInput?.("R");
  const latestRules = viewer.render(120).join("\n");
  assert.match(latestRules, /Rules for history version 2\/2/);
  assert.match(latestRules, /STATE\s+ORDER\s+SCOPE\s+TYPE\s+NAME\s+CHANGE/);
  assert.match(latestRules, /Service token\s+UPDATED/);
  assert.doesNotMatch(latestRules, /only factual in E3/);

  viewer.handleInput?.("[");
  const previousRules = viewer.render(120).join("\n");
  assert.match(previousRules, /Rules for history version 1\/2/);
  assert.match(previousRules, /Service token\s+—/);
  viewer.handleInput?.("tui.select.cancel");

  const previous = viewer.render(120).join("\n");
  assert.match(previous, /Rule version 1\/2 · 1 active rule/);
  assert.doesNotMatch(previous, /Initial factual version|fingerprint|epoch E1|Masking history · E1/);
  assert.match(previous, /only factual in E1/);
  assert.doesNotMatch(previous, /only factual in E3/);
  assert.match(previous, /SIDE-BY-SIDE COMPARE/);
  assert.equal(renderRequests, 4);
});

test("epoch wrapper passes keystrokes to an active transcript search", () => {
  const theme = {
    fg: (_color: unknown, text: string) => text,
    bg: (_color: unknown, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    inverse: (text: string) => text,
    underline: (text: string) => text,
  };
  const keybindings = { matches: (data: string, keybinding: string) => data === keybinding };
  const epoch = {
    version: 1,
    epochId: 1,
    activatedAt: 1,
    behaviorFingerprint: "fp",
    enabled: true,
    systemPromptGuidance: false,
    disclosePlaceholders: false,
    reason: "session_start",
    rules: [],
    changes: [],
  } as unknown as RuleEpoch;
  const entry = {
    key: "user:1",
    original: { role: "user", content: "needle" },
    masked: { role: "user", content: "needle" },
    capturedAt: 1,
  };
  const viewer = createEpochHistoryViewer(
    { terminal: { rows: 20 }, requestRender: () => {} },
    theme,
    keybindings,
    [{ epoch, entries: [entry] }],
    () => undefined,
  );
  viewer.render(120);

  // Typing a query that includes wrapper shortcut letters must edit the
  // query, not trigger "view version rules" or version switching.
  viewer.handleInput?.("/");
  viewer.handleInput?.("e");
  viewer.handleInput?.("r");
  viewer.handleInput?.("]");
  viewer.handleInput?.("n");
  const searching = viewer.render(120).join("\n");
  assert.match(searching, /Search: er\]n▏/);
  assert.doesNotMatch(searching, /Rules for history version/);

  // Clearing to a real query still finds the text.
  for (let i = 0; i < 4; i++) viewer.handleInput?.("\x7f");
  for (const ch of "needle") viewer.handleInput?.(ch);
  assert.match(viewer.render(120).join("\n"), /1 match/);

  // Once search closes, the shortcuts work again.
  viewer.handleInput?.("tui.select.cancel");
  viewer.handleInput?.("r");
  assert.match(viewer.render(120).join("\n"), /Rules for history version/);
});


test("version rules show read-only rule metadata and net changes", () => {
  const theme = {
    fg: (_color: unknown, text: string) => text,
    bg: (_color: unknown, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
  };
  const keybindings = { matches: (data: string, keybinding: string) => data === keybinding };
  const epoch = (epochId: number, rules: RuleEpoch["rules"], options?: Partial<RuleEpoch>): RuleEpoch => ({
    version: 1,
    epochId,
    parentEpochId: epochId > 1 ? epochId - 1 : undefined,
    activatedAt: epochId,
    behaviorFingerprint: `epoch-${epochId}`,
    enabled: true,
    systemPromptGuidance: false,
      disclosePlaceholders: false,
    reason: epochId === 1 ? "session_start" : "ui_edit",
    rules,
    changes: [],
    ...options,
  });
  const rule = (
    key: string,
    name: string,
    order: number,
    options?: Partial<RuleEpoch["rules"][number]>,
  ): RuleEpoch["rules"][number] => ({
    key,
    id: key,
    name,
    scope: "project",
    sourceKind: "literal",
    enabled: true,
    available: true,
    order,
    behaviorFingerprint: `${key}-v1`,
    ...options,
  });
  const entry = (key: string) => ({
    key,
    original: { role: "user", content: key },
    masked: { role: "user", content: key },
    capturedAt: 1,
  });
  const viewer = createEpochHistoryViewer(
    { terminal: { rows: 20 }, requestRender: () => undefined },
    theme,
    keybindings,
    [
      {
        epoch: epoch(1, [
          rule("service", "Service token", 0),
          rule("legacy", "Legacy token", 1),
        ]),
        entries: [entry("v1")],
      },
      {
        epoch: epoch(2, [
          rule("host", "Private host", 0, { sourceKind: "preset", scope: "global" }),
          rule("service", "Service token", 1, { enabled: false, behaviorFingerprint: "service-v2" }),
        ]),
        entries: [entry("v2")],
      },
    ],
    () => undefined,
  );

  const history = viewer.render(120).join("\n");
  assert.match(history, /Rule version 2\/2 · 1 active rule/);
  assert.doesNotMatch(history, /Legacy token|Case-sensitive/);

  viewer.handleInput?.("r");
  const rules = viewer.render(120).join("\n");
  assert.match(rules, /Private host\s+ADDED/);
  assert.match(rules, /Service token\s+DISABLED, MOVED 1→2, UPDATED/);
  assert.match(rules, /Removed since previous version:\n- Legacy token/);
  assert.doesNotMatch(rules, /Case-sensitive matching/);
  assert.doesNotMatch(rules, /Add new rule|Enter edit|reveal value|TEST ACTIVE RULES/);

  const narrowLines = viewer.render(42);
  const narrow = narrowLines.join("\n");
  assert.match(narrow, /change: ADDED/);
  assert.match(narrow, /DISABLED/);
  assert.match(narrow, /MOVED 1→2/);
  assert.match(narrow, /UPDATED/);
  assert.ok(narrowLines.every((line) => visibleWidth(line) <= 42));
});
