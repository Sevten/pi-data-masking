import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RULE_EPOCH_ENTRY, type RuleEpoch } from "../rule-epoch.ts";
import { EPOCH_TRANSCRIPT_ENTRY, type EpochTranscriptBatch } from "../epoch-transcript.ts";

const TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), "masking-epoch-agent-"));
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;
process.on("exit", () => rmSync(TEST_AGENT_DIR, { recursive: true, force: true }));

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  assert.fail("timed out waiting for rule-epoch state change");
}

async function createHarness(cwd: string, branch: unknown[] = []) {
  const events = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const notifications: string[] = [];
  const pi = {
    on(name: string, handler: Handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data: structuredClone(data) });
    },
  };
  const ctx = {
    cwd,
    ui: {
      notify(message: string) { notifications.push(message); },
      setStatus() {},
      setWidget() {},
    },
    sessionManager: { getBranch: () => branch },
  };

  const extension = (await import("../index.ts")).default;
  await extension(pi as never);
  for (const handler of events.get("session_start") ?? []) await handler({}, ctx);

  return {
    commands,
    entries,
    notifications,
    async emit(name: string, event: unknown): Promise<unknown> {
      let result: unknown;
      for (const handler of events.get(name) ?? []) result = await handler(event, ctx);
      return result;
    },
    async command(name: string) {
      const command = commands.get(name);
      assert.ok(command, `missing command ${name}`);
      await command.handler("", ctx);
    },
    async shutdown() {
      for (const handler of events.get("session_shutdown") ?? []) await handler({}, ctx);
    },
  };
}

function epochs(entries: Array<{ customType: string; data: unknown }>): RuleEpoch[] {
  return entries.filter((entry) => entry.customType === RULE_EPOCH_ENTRY).map((entry) => entry.data as RuleEpoch);
}

function epochBatches(entries: Array<{ customType: string; data: unknown }>): EpochTranscriptBatch[] {
  return entries
    .filter((entry) => entry.customType === EPOCH_TRANSCRIPT_ENTRY)
    .map((entry) => entry.data as EpochTranscriptBatch);
}

function epochFactBatches(entries: Array<{ customType: string; data: unknown }>, epochId: number): EpochTranscriptBatch[] {
  return epochBatches(entries).filter((batch) => batch.epochId === epochId && batch.messages.length > 0);
}

test("a running agent keeps one epoch across tool loops and coalesces pending toggles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "masking-epoch-"));
  const configDir = join(dir, ".pi", "pi-data-masking");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "masking.config.json"), JSON.stringify({
    rules: [{ id: "token", real: "secret-service-token", placeholder: "masked-service-token" }],
  }));

  const harness = await createHarness(dir);
  const original = { role: "user", content: "use secret-service-token" };
  const systemOriginal = "system secret-service-token";

  try {
    assert.deepEqual(epochs(harness.entries).map((epoch) => epoch.epochId), [1]);
    const firstStart = await harness.emit("before_agent_start", { systemPrompt: systemOriginal, prompt: "go" }) as {
      systemPrompt?: string;
    } | undefined;

    const first = await harness.emit("context", { messages: [structuredClone(original)] }) as {
      messages: Array<{ content: string }>;
    };
    assert.equal(first.messages[0]!.content, "use masked-service-token");
    const firstProviderPayload = {
      messages: first.messages,
      system: firstStart?.systemPrompt ?? systemOriginal,
    };
    await harness.emit("before_provider_request", { payload: firstProviderPayload });
    assert.equal(firstProviderPayload.system, "system masked-service-token");
    assert.equal(harness.notifications.filter((message) => message.includes("prefix-cache reuse")).length, 0);
    const e1PrefixBatch = epochBatches(harness.entries).find((batch) => batch.epochId === 1 && batch.prefix);
    assert.ok(e1PrefixBatch?.prefix?.system);
    assert.equal(JSON.stringify(e1PrefixBatch).includes(systemOriginal), false);

    await harness.command("masking-toggle");
    assert.ok(harness.notifications.some((message) => message.includes("active run keeps its current rules")));
    assert.equal(harness.notifications.filter((message) => message.includes("prefix-cache reuse")).length, 0);

    // The persisted toggle changed, but every context/tool operation in this
    // still-running agent uses E1 and its placeholder map.
    const duringToolLoop = await harness.emit("context", { messages: [structuredClone(original)] }) as {
      messages: Array<{ content: string }>;
    };
    assert.equal(duringToolLoop.messages[0]!.content, "use masked-service-token");
    assert.equal(epochFactBatches(harness.entries, 1).length, 1);
    await harness.emit("before_provider_request", {
      payload: { messages: duringToolLoop.messages, system: firstStart?.systemPrompt ?? systemOriginal },
    });
    assert.equal(epochBatches(harness.entries).filter((batch) => batch.epochId === 1 && batch.prefix).length, 1);
    const toolEvent = { input: { token: "masked-service-token" } };
    await harness.emit("tool_call", toolEvent);
    assert.equal(toolEvent.input.token, "secret-service-token");
    assert.equal(epochs(harness.entries).length, 1);

    await harness.emit("agent_settled", {});
    await harness.emit("before_agent_start", { systemPrompt: systemOriginal, prompt: "next" });
    assert.deepEqual(epochs(harness.entries).map((epoch) => epoch.epochId), [1, 2]);
    assert.ok(epochs(harness.entries)[1]!.changes.some((change) => change.kind === "masking_disabled"));
    assert.equal(harness.notifications.filter((message) => message.includes("prefix-cache reuse")).length, 0);
    const disabledResult = await harness.emit("context", { messages: [structuredClone(original)] });
    assert.equal(disabledResult, undefined);
    assert.equal(harness.notifications.filter((message) => message.includes("prefix-cache reuse")).length, 0);
    assert.equal(epochFactBatches(harness.entries, 2).length, 1);
    const disabledInjected = { role: "user", timestamp: 98, content: "unmasked while disabled" };
    await harness.emit("before_provider_request", { payload: { messages: [disabledInjected], system: systemOriginal } });
    const e2FactBatches = epochFactBatches(harness.entries, 2);
    assert.equal(e2FactBatches.length, 2);
    assert.equal(e2FactBatches[1]!.messages[0]!.messageKey, "user:98");
    assert.equal(harness.notifications.filter((message) => message.includes("prefix-cache reuse")).length, 1);
    assert.ok(harness.notifications.some((message) => message.includes("provider system prompt")));

    // Two edits during E2 coalesce to the original disabled behavior, so the
    // next run reuses E2 instead of creating unused E3/E4 epochs.
    await harness.command("masking-toggle");
    await harness.command("masking-toggle");
    await harness.emit("agent_settled", {});
    await harness.emit("before_agent_start", { systemPrompt: "system", prompt: "again" });
    assert.deepEqual(epochs(harness.entries).map((epoch) => epoch.epochId), [1, 2]);

    // Re-enable between runs (E3), then change the rule file while E3 is
    // running. The watcher queues E4 without disturbing E3's tool loop.
    await harness.emit("agent_settled", {});
    await harness.command("masking-toggle");
    assert.deepEqual(epochs(harness.entries).map((epoch) => epoch.epochId), [1, 2, 3]);
    await harness.emit("before_agent_start", { systemPrompt: "system", prompt: "reload" });
    writeFileSync(join(configDir, "masking.config.json"), JSON.stringify({
      rules: [{ id: "token", real: "secret-service-token", placeholder: "rotated-mask-value" }],
    }));
    await waitFor(() => harness.notifications.some((message) => message.includes("reload saved")));

    const beforeReloadActivation = await harness.emit("context", { messages: [structuredClone(original)] }) as {
      messages: Array<{ content: string }>;
    };
    assert.equal(beforeReloadActivation.messages[0]!.content, "use masked-service-token");
    assert.equal(epochFactBatches(harness.entries, 3).length, 1);
    assert.deepEqual(epochs(harness.entries).map((epoch) => epoch.epochId), [1, 2, 3]);

    await harness.emit("agent_settled", {});
    await harness.emit("before_agent_start", { systemPrompt: "system", prompt: "activate reload" });
    const afterReloadActivation = await harness.emit("context", { messages: [structuredClone(original)] }) as {
      messages: Array<{ content: string }>;
    };
    assert.equal(afterReloadActivation.messages[0]!.content, "use rotated-mask-value");
    assert.equal(epochFactBatches(harness.entries, 4).length, 1);
    assert.deepEqual(epochs(harness.entries).map((epoch) => epoch.epochId), [1, 2, 3, 4]);

    // Content injected after the context hook is still captured as a factual
    // E4 observation by the final provider boundary, without exposing a
    // provider-request timeline in the viewer.
    const injected = { role: "user", timestamp: 99, content: "injected secret-service-token" };
    const providerPayload = { messages: [injected] };
    await harness.emit("before_provider_request", { payload: providerPayload });
    assert.equal((providerPayload.messages[0] as typeof injected).content, "injected rotated-mask-value");
    const e4FactBatches = epochFactBatches(harness.entries, 4);
    assert.equal(e4FactBatches.length, 2);
    assert.equal(e4FactBatches[1]!.messages[0]!.messageKey, "user:99");

    // A process restart on the same Pi branch restores E4 and must not append
    // a duplicate epoch when the effective config fingerprint is unchanged.
    const branch = harness.entries.map((entry) => ({ type: "custom", ...entry }));
    await harness.shutdown();
    const resumed = await createHarness(dir, branch);
    try {
      assert.equal(epochs(resumed.entries).length, 0);
      const restored = await resumed.emit("context", { messages: [structuredClone(original)] }) as {
        messages: Array<{ content: string }>;
      };
      assert.equal(restored.messages[0]!.content, "use rotated-mask-value");
      assert.equal(epochs(resumed.entries).length, 0);
    } finally {
      await resumed.shutdown();
    }
  } finally {
    await harness.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
