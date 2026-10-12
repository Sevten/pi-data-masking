import assert from "node:assert/strict";
import test from "node:test";
import { createMaskingLogViewer } from "../src/history/log-viewer.ts";
import type { AuditEvent } from "../src/history/audit-log.ts";
import type { TranscriptEntry } from "../src/history/history-viewer.ts";

const theme = {
  fg: (_color: unknown, text: string) => text,
  bg: (_color: unknown, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
};
const keybindings = { matches: (data: string, keybinding: string) => data === keybinding };

const entry = (key: string, original: string, masked: string): TranscriptEntry => ({
  key,
  original: { role: "user", content: original },
  masked: { role: "user", content: masked },
  capturedAt: 1,
}) as TranscriptEntry;

const auditEvent = (ruleName: string, kind: AuditEvent["kind"] = "restored"): AuditEvent => ({
  at: 1700000000000,
  kind,
  ruleId: `rule-${ruleName}`,
  ruleName,
  tool: "bash",
  destinations: ["api.stripe.com"],
});

const makeTui = () => {
  let renders = 0;
  return {
    terminal: { rows: 24 },
    requestRender: () => {
      renders++;
    },
    renders: () => renders,
  };
};

test("log viewer opens on Masked views and Tab switches to the restoration audit", () => {
  const tui = makeTui();
  const viewer = createMaskingLogViewer(
    tui,
    theme,
    keybindings,
    {
      epochViews: [],
      transcript: [entry("user:1", "mysecret", "maskedsecret")],
      auditEvents: [auditEvent("Stripe key")],
    },
    () => undefined,
  );

  const first = viewer.render(120).join("\n");
  assert.match(first, /● Masked views/);
  assert.match(first, /○ Restoration audit \(1\)/);
  assert.doesNotMatch(first, /Restoration audit · 1 events/);

  viewer.handleInput?.("\t");
  const second = viewer.render(120).join("\n");
  assert.match(second, /Restoration audit · 1 events/);
  assert.match(second, /RESTORED/);
  assert.match(second, /"Stripe key"/);
  assert.ok(tui.renders() > 0);

  viewer.handleInput?.("\t");
  assert.doesNotMatch(viewer.render(120).join("\n"), /Restoration audit · 1 events/);
});

test("audit filter prompt keeps Tab; closing the filter re-enables switching", () => {
  const tui = makeTui();
  const viewer = createMaskingLogViewer(
    tui,
    theme,
    keybindings,
    {
      epochViews: [],
      transcript: [entry("user:1", "mysecret", "maskedsecret")],
      auditEvents: [auditEvent("Stripe key"), auditEvent("GitHub token", "blocked")],
      defaultTab: "audit",
    },
    () => undefined,
  );

  assert.match(viewer.render(120).join("\n"), /Restoration audit · 2 events/);

  viewer.handleInput?.("/");
  viewer.handleInput?.("h");
  viewer.handleInput?.("u");
  assert.match(viewer.render(120).join("\n"), /filter: hu/);

  // Tab while the filter owns the keyboard must not switch tabs.
  viewer.handleInput?.("\t");
  assert.match(viewer.render(120).join("\n"), /Restoration audit · 1 of 2 events/);

  viewer.handleInput?.("\r");
  viewer.handleInput?.("\t");
  assert.doesNotMatch(viewer.render(120).join("\n"), /Restoration audit ·/);
});

test("subview Esc closes the whole tabbed viewer", () => {
  let closed = 0;
  const tui = makeTui();
  const viewer = createMaskingLogViewer(
    tui,
    theme,
    keybindings,
    {
      epochViews: [],
      transcript: [],
      auditEvents: [auditEvent("Stripe key")],
    },
    () => {
      closed++;
    },
  );

  // No masked views at all: opens directly on the audit tab.
  assert.match(viewer.render(120).join("\n"), /Restoration audit · 1 events/);
  viewer.handleInput?.("\x1b");
  assert.equal(closed, 1);
});

test("empty audit tab renders its empty state instead of blocking the tab", () => {
  const tui = makeTui();
  const viewer = createMaskingLogViewer(
    tui,
    theme,
    keybindings,
    {
      epochViews: [],
      transcript: [entry("user:1", "mysecret", "maskedsecret")],
      auditEvents: [],
    },
    () => undefined,
  );

  viewer.handleInput?.("\t");
  const rendered = viewer.render(120).join("\n");
  assert.match(rendered, /No restoration events recorded yet/);
  assert.match(rendered, /○ Masked views/);
});
