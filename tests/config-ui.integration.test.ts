import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";

type Component = {
  render(width: number): string[];
  handleInput(data: string): void;
};

type Scenario = (component: Component) => Promise<void>;

const TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), "masking-ui-agent-"));
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;
process.on("exit", () => rmSync(TEST_AGENT_DIR, { recursive: true, force: true }));

const INPUT = {
  space: " ",
  enter: "\r",
  escape: "\x1b",
  down: "\x1b[B",
  ctrlDown: "\x1b[1;5B",
  ctrlC: "\x03",
} as const;

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("timed out waiting for TUI state change");
}

function configRules(path: string): Array<Record<string, unknown>> {
  return (JSON.parse(readFileSync(path, "utf8")) as { rules: Array<Record<string, unknown>> }).rules;
}

async function createHarness(cwd: string, scenarios: Scenario[]) {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const events = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void> | void>>();
  const notifications: string[] = [];
  const statuses: string[] = [];
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
    appendEntry() {},
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const actionKeys: Record<string, string> = {
    "tui.select.up": "\x1b[A",
    "tui.select.down": INPUT.down,
    "tui.select.confirm": INPUT.enter,
    "tui.select.cancel": INPUT.escape,
    "app.interrupt": INPUT.ctrlC,
  };
  const keybindings = { matches: (data: string, action: string) => data === actionKeys[action] };
  const tui = { terminal: { rows: 50, columns: 120 }, requestRender() {} };
  const ui = {
    notify(message: string) { notifications.push(message); },
    setStatus(_key: string, value: string | undefined) { if (value) statuses.push(value); },
    setWidget() {},
    async confirm() { return true; },
    async select() { return undefined; },
    async input() { return undefined; },
    async custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => Component): Promise<T> {
      const scenario = scenarios.shift();
      assert.ok(scenario, "unexpected TUI screen");
      return new Promise<T>((resolve, reject) => {
        const component = factory(tui, theme, keybindings, resolve);
        void scenario(component).catch(reject);
      });
    },
  };
  const ctx = {
    cwd,
    ui,
    sessionManager: { getBranch: () => [] },
  };

  const extension = (await import("../index.ts")).default;
  await extension(pi as never);
  for (const handler of events.get("session_start") ?? []) await handler({}, ctx);

  return {
    commands,
    events,
    ctx,
    notifications,
    statuses,
    async emit(name: string, event: unknown): Promise<unknown> {
      let result: unknown;
      for (const handler of events.get(name) ?? []) {
        result = await (handler as (value: unknown, context: unknown) => Promise<unknown> | unknown)(event, ctx);
      }
      return result;
    },
    async shutdown() {
      for (const handler of events.get("session_shutdown") ?? []) await handler({}, ctx);
    },
  };
}

test("model-first values remain stable across later user and tool-result messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "masking-ui-"));
  const projectPath = join(dir, ".pi", "pi-data-masking", "masking.config.json");
  mkdirSync(join(dir, ".pi", "pi-data-masking"), { recursive: true });
  writeFileSync(projectPath, JSON.stringify({ rules: [
    { id: "pin", name: "PIN", real: "123456", placeholder: "834919", lowEntropy: true },
  ] }));

  const harness = await createHarness(dir, []);
  const assistant = { role: "assistant", content: [{ type: "text", text: "example 123456" }] };
  const user = { role: "user", content: [{ type: "text", text: "my password is 123456" }] };
  const toolResult = { role: "toolResult", content: [{ type: "text", text: "file contains 123456" }] };

  try {
    const first = await harness.emit("context", { messages: [assistant] }) as { messages: unknown[] };
    assert.equal(JSON.stringify(first.messages).includes("123456"), true);

    const withUserAndTool = await harness.emit("context", { messages: [assistant, user, toolResult] }) as { messages: unknown[] };
    assert.equal(JSON.stringify(withUserAndTool.messages).match(/123456/g)?.length, 3);
    assert.equal(JSON.stringify(withUserAndTool.messages).includes("834919"), false);

    const nextRequest = await harness.emit("context", {
      messages: [assistant, user, toolResult, { role: "user", content: [{ type: "text", text: "continue" }] }],
    }) as { messages: unknown[] };
    assert.equal(JSON.stringify(nextRequest.messages).match(/123456/g)?.length, 3);
    assert.equal(JSON.stringify(nextRequest.messages).includes("834919"), false);
  } finally {
    await harness.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configuration home toggles and reorders in place while retaining selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "masking-ui-"));
  const projectPath = join(dir, ".pi", "pi-data-masking", "masking.config.json");
  mkdirSync(join(dir, ".pi", "pi-data-masking"), { recursive: true });
  writeFileSync(projectPath, JSON.stringify({ rules: [
    { id: "first", name: "First rule", real: "first-secret-value" },
    { id: "second", name: "Second rule", real: "second-secret-value" },
  ] }));

  const harness = await createHarness(dir, [async (component) => {
    assert.ok(component.render(100).some((line) => line.includes("STATE") && line.includes("ORDER") && line.includes("NAME")));
    const narrowLines = component.render(42);
    const narrow = narrowLines.join("\n");
    assert.ok(narrowLines.every((line) => visibleWidth(line) <= 42));
    assert.match(narrow, /Space rule on\/off/);
    assert.match(narrow, /M global\nmasking on\/off/);
    assert.match(narrow, /Ctrl\+↑↓ reorder/);
    assert.match(narrow, /I\s+import/);
    assert.match(narrow, /X export/);
    assert.match(narrow, /Esc close/);
    assert.ok(component.render(100).some((line) => line.includes("GLOBAL MASKING [ON]")));
    component.handleInput("M");
    await waitFor(() => component.render(100).some((line) => line.includes("GLOBAL MASKING [OFF]")));
    component.handleInput("m");
    await waitFor(() => component.render(100).some((line) => line.includes("GLOBAL MASKING [ON]")));
    component.handleInput("\t");
    assert.ok(component.render(100).some((line) => line.includes("TEST ACTIVE RULES · focused")));
    component.handleInput("\t");
    assert.ok(component.render(100).some((line) => line.includes("RULES · focused")));
    component.handleInput(INPUT.space);
    await waitFor(() => configRules(projectPath)[0]?.enabled === false);
    await waitFor(() => component.render(100).some((line) => line.includes("[OFF ]") && line.includes("First rule")));
    assert.ok(component.render(100).some((line) => line.includes("[OFF ]") && line.includes("First rule")));

    component.handleInput(INPUT.ctrlDown);
    await waitFor(() => configRules(projectPath).map((rule) => rule.id).join(",") === "second,first");
    await waitFor(() => component.render(100)[0]?.includes("Order saved") === true);
    const selectedRow = component.render(100).find((line) => line.includes("First rule"));
    assert.ok(selectedRow?.startsWith("›"), "moved rule should remain selected");
    component.handleInput(INPUT.escape);
  }, async (component) => {
    const confirmation = component.render(100).join("\n");
    assert.match(confirmation, /Disable masking\?/);
    assert.match(confirmation, /persists across projects/);
    assert.match(confirmation, /future sessions/);
    component.handleInput(INPUT.enter);
  }]);

  try {
    assert.equal(harness.commands.has("masking"), true);
    assert.equal(harness.commands.has("masking-toggle"), false);
    assert.equal(harness.commands.has("masking-config"), false);
    assert.equal(harness.commands.has("masking-test"), false);
    assert.equal(harness.commands.has("masking-list"), false);
    assert.equal(harness.commands.has("masking-init"), false);
    assert.equal(harness.commands.has("masking-rule"), false);
    await harness.commands.get("masking")!.handler("", harness.ctx);
    assert.equal(harness.notifications.some((message) => message.includes("first-secret-value")), false);

    await harness.shutdown();
    const restarted = await createHarness(dir, []);
    try {
      assert.ok(restarted.statuses.some((status) => status.includes("1 active / 2 configured")));
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await harness.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history-changing saves confirm inside configuration UI before writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "masking-ui-"));
  const projectPath = join(dir, ".pi", "pi-data-masking", "masking.config.json");
  mkdirSync(join(dir, ".pi", "pi-data-masking"), { recursive: true });
  writeFileSync(projectPath, JSON.stringify({ rules: [
    { id: "token", name: "Token", real: "secret-service-token", placeholder: "masked-service-token" },
    { id: "host", name: "Host", real: "secret-service-host", placeholder: "masked-service-host" },
  ] }));

  let firstCancelled = false;
  let confirmationCount = 0;
  const assertImpactConfirmation = (component: Component, sourceIndex: number) => {
    confirmationCount++;
    const lines = component.render(100);
    assert.ok(lines.some((line) => line.includes("Save masking changes?")));
    assert.ok(lines.some((line) => line.includes("1 existing conversation message")));
    assert.ok(lines.some((line) => line.includes("earliest #1")));
    assert.equal(configRules(projectPath)[sourceIndex]?.enabled, undefined, "candidate must not be written before confirmation");
  };
  const harness = await createHarness(dir, [
    async (component) => {
      component.handleInput(INPUT.space);
      await waitFor(() => firstCancelled);
      assert.equal(configRules(projectPath)[0]?.enabled, undefined, "Back to editing must leave the file unchanged");
      component.handleInput(INPUT.space);
      await waitFor(() => configRules(projectPath)[0]?.enabled === false);
      await waitFor(() => component.render(100)[0]?.includes("Disabled ·") === true);
      component.handleInput(INPUT.down);
      component.handleInput(INPUT.space);
      await waitFor(() => configRules(projectPath)[1]?.enabled === false);
      component.handleInput(INPUT.escape);
    },
    async (component) => {
      assertImpactConfirmation(component, 0);
      component.handleInput(INPUT.down);
      component.handleInput(INPUT.enter);
      firstCancelled = true;
    },
    async (component) => {
      assertImpactConfirmation(component, 0);
      component.handleInput(INPUT.enter);
    },
    async (component) => {
      assertImpactConfirmation(component, 1);
      component.handleInput(INPUT.enter);
    },
  ]);

  try {
    await harness.emit("context", {
      messages: [{ role: "user", content: "use secret-service-token at secret-service-host" }],
    });
    await harness.commands.get("masking")!.handler("", harness.ctx);
    assert.equal(configRules(projectPath)[0]?.enabled, false);
    assert.equal(configRules(projectPath)[1]?.enabled, false);
    assert.equal(confirmationCount, 3, "each impactful repeated edit should confirm against the last factual input");
    assert.equal(harness.notifications.some((message) => message.includes("Local preflight")), false);
  } finally {
    await harness.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adding a rule keeps the type picker and builder on clean full-screen pages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "masking-ui-"));
  const projectPath = join(dir, ".pi", "pi-data-masking", "masking.config.json");
  mkdirSync(join(dir, ".pi", "pi-data-masking"), { recursive: true });
  writeFileSync(projectPath, JSON.stringify({ rules: [] }));

  const assertFullScreen = (component: Component, title: string) => {
    const lines = component.render(100);
    assert.equal(lines.length >= 50, true, `${title} must paint the complete terminal viewport`);
    assert.equal(lines.some((line) => line.includes(title)), true);
  };
  const harness = await createHarness(dir, [
    async (component) => {
      assertFullScreen(component, "Masking configuration");
      component.handleInput("a");
      assert.ok(component.render(100)[0]?.includes("Opening rule builder"));
      await waitFor(() => !component.render(100)[0]?.includes("Opening"));
      // The same mounted home component is restored after the child overlays.
      assertFullScreen(component, "Masking configuration");
      component.handleInput(INPUT.escape);
    },
    async (component) => {
      assertFullScreen(component, "Rule type");
      component.handleInput(INPUT.down);
      component.handleInput(INPUT.down);
      component.handleInput(INPUT.enter);
    },
    async (component) => {
      assertFullScreen(component, "New masking rule");
      component.handleInput(INPUT.escape);
    },
  ]);

  try {
    await harness.commands.get("masking")!.handler("", harness.ctx);
    assert.equal(configRules(projectPath).length, 0);
  } finally {
    await harness.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Rule Builder retains a dirty draft after save failure and confirms discard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "masking-ui-"));
  const projectPath = join(dir, ".pi", "pi-data-masking", "masking.config.json");
  mkdirSync(join(dir, ".pi", "pi-data-masking"), { recursive: true });
  writeFileSync(projectPath, JSON.stringify({ rules: [
    { id: "original", name: "Original", real: "original-secret-value" },
  ] }));

  const harness = await createHarness(dir, [
    async (component) => {
      component.handleInput(INPUT.enter);
      assert.ok(component.render(100)[0]?.includes("Opening rule"));
      await waitFor(() => !component.render(100)[0]?.includes("Opening"), 5000);
      component.handleInput(INPUT.escape);
    },
    async (component) => {
      assert.ok(component.render(100).some((line) => line.includes("Edit masking rule")));
      component.handleInput(INPUT.down);
      component.handleInput(INPUT.down);
      component.handleInput("X");
      writeFileSync(projectPath, JSON.stringify({ rules: [
        { id: "changed-elsewhere", name: "External", real: "external-secret-value" },
      ] }));
      component.handleInput(INPUT.enter);
      await waitFor(() => component.render(100).some((line) => line.includes("draft retained")));
      assert.ok(component.render(100).some((line) => line.includes("OriginalX")));

      component.handleInput(INPUT.escape);
      assert.ok(component.render(100).some((line) => line.includes("Discard unsaved changes?")));
      component.handleInput(INPUT.enter);
    },
  ]);

  try {
    await harness.commands.get("masking")!.handler("", harness.ctx);
    assert.equal(configRules(projectPath)[0]?.id, "changed-elsewhere");
    assert.equal(harness.notifications.some((message) => message.includes("original-secret-value")), false);
  } finally {
    await harness.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hot reload keeps the last valid rules visible after transient invalid JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "masking-ui-"));
  const projectPath = join(dir, ".pi", "pi-data-masking", "masking.config.json");
  mkdirSync(join(dir, ".pi", "pi-data-masking"), { recursive: true });
  writeFileSync(projectPath, JSON.stringify({ rules: [
    { id: "last-valid", name: "Last valid rule", real: "last-valid-secret-value" },
  ] }));

  const harness = await createHarness(dir, [async (component) => {
    assert.ok(component.render(100).some((line) => line.includes("Last valid rule")));
    component.handleInput(INPUT.escape);
  }]);

  try {
    writeFileSync(projectPath, "{ transiently invalid");
    await waitFor(() => harness.notifications.some((message) => message.includes("last valid project config")));
    assert.ok(harness.statuses.at(-1)?.includes("1 active / 1 configured"));
    assert.equal(harness.notifications.some((message) => message.includes("last-valid-secret-value")), false);
    await harness.commands.get("masking")!.handler("", harness.ctx);
  } finally {
    await harness.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
