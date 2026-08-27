/**
 * tests/masked-cache.integration.test.ts
 * End-to-end regression for the masked-output cache across the two outbound
 * hooks: context(original) -> before_provider_request(masked) must not
 * re-run the masker, and the next turn's context(original) must still hit.
 * This is the exact sequence from the PR #2 review where single-hash lookups
 * made sensitive messages thrash between the original and masked hashes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Masker } from "../masker.ts";

const TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), "masking-cache-agent-"));
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;
process.on("exit", () => rmSync(TEST_AGENT_DIR, { recursive: true, force: true }));

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

async function createHarness(cwd: string) {
  const events = new Map<string, Handler[]>();
  const pi = {
    on(name: string, handler: Handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    registerCommand() {},
    appendEntry() {},
  };
  const ctx = {
    cwd,
    ui: { notify() {}, setStatus() {}, setWidget() {} },
    sessionManager: { getBranch: () => [] },
  };

  const extension = (await import("../index.ts")).default;
  await extension(pi as never);
  for (const handler of events.get("session_start") ?? []) await handler({}, ctx);

  return {
    ctx,
    async emit(name: string, event: unknown): Promise<unknown> {
      let result: unknown;
      for (const handler of events.get(name) ?? []) result = await handler(event, ctx);
      return result;
    },
    async shutdown() {
      for (const handler of events.get("session_shutdown") ?? []) await handler({}, ctx);
    },
  };
}

/** Count masker.maskValue invocations to observe when masking actually runs. */
function spyOnMaskValue() {
  const original = Masker.prototype.maskValue;
  let calls = 0;
  Masker.prototype.maskValue = function (value: unknown, opts?: Parameters<typeof original>[1]) {
    calls++;
    return original.call(this, value, opts);
  };
  return {
    calls: () => calls,
    restore: () => {
      Masker.prototype.maskValue = original;
    },
  };
}

test("context(original) -> provider(masked) -> next context(original) invokes masking only once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "masking-cache-"));
  const configDir = join(dir, ".pi", "pi-data-masking");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "masking.config.json"), JSON.stringify({
    rules: [{ id: "email", name: "Corp email", real: "alice@corp.com", placeholder: "bob@corp.com" }],
  }));

  const harness = await createHarness(dir);
  const history = [
    { role: "user", content: [{ type: "text", text: "mail alice@corp.com please" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];

  try {
    const first = await harness.emit("context", { messages: structuredClone(history) }) as {
      messages: Array<{ role: string; content: Array<{ text: string }> }>;
    };
    assert.equal(first.messages[0]!.role, "user");
    assert.equal(first.messages[0]!.content[0]!.text.includes("alice@corp.com"), false, "original must be masked");
    assert.ok(first.messages[0]!.content[0]!.text.includes("bob@corp.com"), "placeholder must be present");

    const spy = spyOnMaskValue();
    try {
      // The provider boundary receives exactly what the context hook produced:
      // every message fingerprint now matches the stored masked-output hash.
      const payload: Record<string, unknown> = { messages: first.messages };
      await harness.emit("before_provider_request", { payload });
      assert.equal(spy.calls(), 0, "provider(masked) must be served from cache without re-masking");
      assert.equal(payload.messages, first.messages, "unchanged payload messages must not be replaced");

      // Next turn: the same history reaches the context hook again. The
      // masked-boundary pass above must not have replaced the original
      // mapping, so this lookup hits too.
      const second = await harness.emit("context", { messages: structuredClone(history) }) as {
        messages: Array<{ role: string; content: Array<{ text: string }> }>;
      };
      assert.equal(spy.calls(), 0, "next context(original) must be served from cache without re-masking");
      assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)));
    } finally {
      spy.restore();
    }
  } finally {
    await harness.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
