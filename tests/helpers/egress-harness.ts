/**
 * Shared egress integration harness: drives the REAL extension entry
 * point (src/index.ts) over its event pipeline against a mocked pi host.
 * The event shapes emitted here mirror the host's actual dispatch sites:
 * tool_call (agent.beforeToolCall) and tool_result (agent.afterToolCall,
 * { type, toolName, toolCallId, input, content, isError }).
 */
import { TEST_AGENT_DIR, globalConfigPath } from "./test-agent-dir.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Notification = { message: string; level?: string };

export function createEgressHarness(cwd: string) {
  const events = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown> | unknown>>();
  const notifications: Notification[] = [];
  const selects: Array<{ title: string; question: string; options: string[] }> = [];
  let selectChoice: string | null = null;
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerCommand() {},
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
  };
  const ui = {
    notify(message: string, level?: string) { notifications.push({ message, level }); },
    setStatus() {},
    setWidget() {},
    async select(title: string, options: string[]) {
      selects.push({ title, question: "", options });
      return selectChoice !== null && options.includes(selectChoice) ? selectChoice : undefined;
    },
    async input() { return undefined; },
  };
  const ctx = { cwd, ui, sessionManager: { getBranch: () => [] } };

  return (async () => {
    const extension = (await import("../../src/index.ts")).default;
    await extension(pi as never);
    for (const handler of events.get("session_start") ?? []) await handler({}, ctx);
    return {
      notifications,
      selects,
      entries,
      setSelectChoice: (choice: string | null) => { selectChoice = choice; },
      async emit(name: string, event: unknown): Promise<unknown> {
        let result: unknown;
        for (const handler of events.get(name) ?? []) {
          result = await handler(event, ctx);
        }
        return result;
      },
      async shutdown() {
        for (const handler of events.get("session_shutdown") ?? []) await handler({}, ctx);
      },
    };
  })();
}

/** Register a literal rule (global config) with the given real value and scope. */
export function writeLiteralRuleConfig(real: string, scope: Record<string, unknown>): void {
  mkdirSync(join(TEST_AGENT_DIR, "pi-data-masking"), { recursive: true });
  writeFileSync(globalConfigPath, JSON.stringify({
    rules: [{ id: "collector-key", type: "literal", real, placeholder: "auto", description: "test key", restoreScope: scope }],
  }));
}

/** Mask a user message so the literal rule's value is registered and we learn its placeholder. */
export async function placeholderFor(
  harness: Awaited<ReturnType<typeof createEgressHarness>>,
  real: string,
): Promise<string> {
  const out = (await harness.emit("context", {
    messages: [{ role: "user", content: [{ type: "text", text: `the key is ${real}` }] }],
  })) as { messages: Array<{ content: Array<{ text: string }> }> };
  const masked = out.messages[0].content[0].text;
  const token = masked.replace("the key is ", "").trim();
  if (!(token.length > 0 && token !== real)) {
    throw new Error(`placeholder not found in: ${masked}`);
  }
  return token;
}
