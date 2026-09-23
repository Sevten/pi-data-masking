/**
 * tests/stream-restore.test.ts
 * Unit tests for the provider-stream restoration transformer: delta
 * restoration with prefix hold-back, per-block isolation, end/done/error
 * repair, toolcall passthrough, and failure containment.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Provider,
} from "@earendil-works/pi-ai";
import { Masker } from "../masker.ts";
import {
  createStreamRestore,
  registerNativeStreamRestoreProvider,
  type StreamRestoreBlockState,
} from "../stream-restore.ts";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "hex");

function makeMasker(rules: Array<Record<string, unknown>>, dynamicMap?: Map<string, never>): Masker {
  return new Masker(rules as never, KEY, dynamicMap ?? new Map(), new Set(), new Set());
}

let messageSeq = 0;
function makePartial(content: AssistantMessage["content"]): AssistantMessage {
  messageSeq += 1;
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "test",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "pending",
    timestamp: messageSeq,
  };
}

function textBlock(text: string) {
  return { type: "text" as const, text };
}

function thinkingBlock(thinking: string) {
  return { type: "thinking" as const, thinking };
}

async function runEvents(masker: Masker, events: AssistantMessageEvent[]): Promise<AssistantMessageEvent[]> {
  const upstream = createAssistantMessageEventStream();
  for (const event of events) upstream.push(event);
  upstream.end();
  const { wrap } = createStreamRestore(() => masker);
  const out = wrap(upstream);
  const collected: AssistantMessageEvent[] = [];
  for await (const event of out) collected.push(event);
  return collected;
}

const LITERAL = [{ id: "cred", real: "s3cret-value", placeholder: "PH-XYZ" }];

test("holdback: complete placeholder in one delta is restored immediately", async () => {
  const m = makeMasker(LITERAL);
  const partial = makePartial([textBlock("")]);
  const events = await runEvents(m, [
    { type: "text_delta", contentIndex: 0, delta: "before PH-XYZ after", partial },
  ]);
  assert.deepEqual(events, [
    {
      type: "text_delta",
      contentIndex: 0,
      delta: "before s3cret-value after",
      partial: { ...partial, content: [textBlock("before s3cret-value after")] },
    },
  ]);
  assert.equal(partial.content[0].type === "text" && partial.content[0].text, "before s3cret-value after");
});

test("holdback: placeholder split across deltas is never emitted as a fragment", async () => {
  const m = makeMasker(LITERAL);
  const partial = makePartial([textBlock("")]);
  const events = await runEvents(m, [
    { type: "text_delta", contentIndex: 0, delta: "key: PH-", partial },
    { type: "text_delta", contentIndex: 0, delta: "XYZ!", partial },
  ]);
  // "PH-" was withheld, so the second delta emits only the restored remainder.
  assert.deepEqual(events.map((e) => (e.type === "text_delta" ? e.delta : e)), ["key: ", "s3cret-value!"]);
  assert.equal(partial.content[0].type === "text" && partial.content[0].text, "key: s3cret-value!");
});

test("holdback: near-miss prefix is held back, then released intact", async () => {
  const m = makeMasker([{ id: "tok", real: "real-token", placeholder: "@SECRET@" }]);
  const partial = makePartial([textBlock("")]);
  const events = await runEvents(m, [
    { type: "text_delta", contentIndex: 0, delta: "see @SECRET", partial },
    { type: "text_delta", contentIndex: 0, delta: " is here", partial },
  ]);
  // "@SECRET" is a strict prefix of "@SECRET@" → withheld on the first delta.
  assert.equal(events[0].type === "text_delta" && events[0].delta, "see ");
  // The next delta resolves it as plain text → the held-back run is released.
  assert.equal(events[1].type === "text_delta" && events[1].delta, "@SECRET is here");
});

test("per-block state: thinking and text blocks restore independently", async () => {
  const m = makeMasker(LITERAL);
  const partial = makePartial([thinkingBlock(""), textBlock("")]);
  const events = await runEvents(m, [
    { type: "thinking_delta", contentIndex: 0, delta: "think PH-", partial },
    { type: "text_delta", contentIndex: 1, delta: "answer PH-XYZ", partial },
    { type: "thinking_delta", contentIndex: 0, delta: "XYZ end", partial },
  ]);
  assert.equal(events[0].type === "thinking_delta" && events[0].delta, "think ");
  assert.equal(events[1].type === "text_delta" && events[1].delta, "answer s3cret-value");
  assert.equal(events[2].type === "thinking_delta" && events[2].delta, "s3cret-value end");
  if (partial.content[0].type === "thinking") assert.equal(partial.content[0].thinking, "think s3cret-value end");
  if (partial.content[1].type === "text") assert.equal(partial.content[1].text, "answer s3cret-value");
});

test("text_end and thinking_end restore their content", async () => {
  const m = makeMasker(LITERAL);
  const partial = makePartial([textBlock("PH-XYZ"), thinkingBlock("about PH-XYZ")]);
  const events = await runEvents(m, [
    { type: "text_end", contentIndex: 0, content: "PH-XYZ", partial },
    { type: "thinking_end", contentIndex: 1, content: "about PH-XYZ", partial },
  ]);
  assert.equal(events[0].type === "text_end" && events[0].content, "s3cret-value");
  assert.equal(events[1].type === "thinking_end" && events[1].content, "about s3cret-value");
  if (partial.content[0].type === "text") assert.equal(partial.content[0].text, "s3cret-value");
});

test("done: message content strings are restored in place", async () => {
  const m = makeMasker(LITERAL);
  const message = makePartial([textBlock("uses PH-XYZ here"), thinkingBlock("PH-XYZ")]);
  const events = await runEvents(m, [{ type: "done", reason: "stop", message }]);
  assert.equal(events.length, 1);
  if (message.content[0].type === "text") assert.equal(message.content[0].text, "uses s3cret-value here");
  if (message.content[1].type === "thinking") assert.equal(message.content[1].thinking, "s3cret-value");
});

test("error: message strings are restored, aborted streams pass through", async () => {
  const m = makeMasker(LITERAL);
  const error = makePartial([textBlock("partial PH-XYZ")]);
  error.stopReason = "aborted";
  const events = await runEvents(m, [{ type: "error", reason: "aborted", error }]);
  assert.equal(events.length, 1);
  if (error.content[0].type === "text") assert.equal(error.content[0].text, "partial s3cret-value");
});

test("toolcall deltas pass through untouched", async () => {
  const m = makeMasker(LITERAL);
  const partial = makePartial([]);
  const toolCall = { type: "toolCall" as const, id: "t1", name: "edit", arguments: { content: "PH-XYZ" } };
  const events = await runEvents(m, [
    { type: "toolcall_start", contentIndex: 0, partial },
    { type: "toolcall_delta", contentIndex: 0, delta: '{"content":"PH-XYZ"}', partial },
    { type: "toolcall_end", contentIndex: 0, toolCall, partial },
  ]);
  assert.deepEqual(events.map((e) => e.type), ["toolcall_start", "toolcall_delta", "toolcall_end"]);
  assert.equal(events[1].type === "toolcall_delta" && events[1].delta, '{"content":"PH-XYZ"}');
});

test("toolcall_end restores arguments in place (event toolCall and partial block)", async () => {
  const m = makeMasker(LITERAL);
  const toolCall = { type: "toolCall" as const, id: "t1", name: "edit", arguments: { content: "PH-XYZ", nested: { v: "PH-XYZ" }, keep: 1 } };
  const partial = makePartial([toolCall]);
  const events = await runEvents(m, [
    { type: "toolcall_end", contentIndex: 0, toolCall, partial },
  ]);
  assert.equal(events.length, 1);
  // Mutated in place: the same object now holds real values.
  assert.deepEqual(toolCall.arguments, { content: "s3cret-value", nested: { v: "s3cret-value" }, keep: 1 });
  const block = partial.content[0];
  assert.equal(block.type === "toolCall" && block.arguments, toolCall.arguments);
});

test("toolcall_end restores partial block when event toolCall is a separate object", async () => {
  const m = makeMasker(LITERAL);
  const eventToolCall = { type: "toolCall" as const, id: "t1", name: "edit", arguments: { content: "PH-XYZ" } };
  const blockToolCall = { type: "toolCall" as const, id: "t1", name: "edit", arguments: { content: "PH-XYZ" } };
  const partial = makePartial([blockToolCall]);
  await runEvents(m, [
    { type: "toolcall_end", contentIndex: 0, toolCall: eventToolCall, partial },
  ]);
  assert.deepEqual(eventToolCall.arguments, { content: "s3cret-value" });
  assert.deepEqual(blockToolCall.arguments, { content: "s3cret-value" });
});

test("done message restores toolCall arguments", async () => {
  const m = makeMasker(LITERAL);
  const message = makePartial([
    { type: "toolCall" as const, id: "t1", name: "edit", arguments: { content: "PH-XYZ" } },
  ]);
  message.stopReason = "toolUse";
  const events = await runEvents(m, [{ type: "done", reason: "toolUse", message }]);
  assert.equal(events.length, 1);
  const block = message.content[0];
  assert.equal(block.type === "toolCall" && block.arguments.content, "s3cret-value");
});

test("transform failure forwards the original event instead of breaking the stream", async () => {
  const upstream = createAssistantMessageEventStream();
  const partial = makePartial([textBlock("")]);
  upstream.push({ type: "text_delta", contentIndex: 0, delta: "PH-XYZ", partial });
  upstream.end();
  const { wrap } = createStreamRestore(() => {
    throw new Error("masker exploded");
  });
  const out = wrap(upstream);
  const collected: AssistantMessageEvent[] = [];
  for await (const event of out) collected.push(event);
  assert.equal(collected.length, 1);
  assert.equal(collected[0].type === "text_delta" && collected[0].delta, "PH-XYZ");
});

test("empty masker degrades to a pass-through proxy", async () => {
  const m = makeMasker([]);
  const partial = makePartial([textBlock("")]);
  const events = await runEvents(m, [
    { type: "text_delta", contentIndex: 0, delta: "plain PH-XYZ text", partial },
  ]);
  assert.equal(events[0].type === "text_delta" && events[0].delta, "plain PH-XYZ text");
});

test("displayHoldbackLength: strict prefixes only, case-insensitive support", () => {
  const cs = makeMasker(LITERAL);
  assert.equal(cs.displayHoldbackLength(""), 0);
  assert.equal(cs.displayHoldbackLength("tail PH-"), 3);
  // A complete placeholder is not a strict prefix of itself.
  assert.equal(cs.displayHoldbackLength("tail PH-XYZ"), 0);
  // Non-placeholder text without placeholder-prefix tails holds back nothing.
  assert.equal(cs.displayHoldbackLength("plain text"), 0);

  const ci = makeMasker([{ id: "tok", real: "real", placeholder: "@Secret@", caseSensitive: false }]);
  assert.equal(ci.displayHoldbackLength("value @SECR"), 5);
  assert.equal(ci.displayHoldbackLength("value @secre"), 6);
  assert.equal(ci.displayHoldbackLength("unrelated"), 0);
});

test("native provider registration preserves authentication", () => {
  const auth = {
    apiKey: {
      name: "Test credentials",
      async resolve() {
        return { auth: { apiKey: "test-key" }, source: "test" };
      },
    },
  };
  const upstream = createAssistantMessageEventStream();
  upstream.end();
  const provider: Provider = {
    id: "native-test",
    name: "Native test",
    auth,
    getModels: () => [],
    stream: () => upstream,
    streamSimple: () => upstream,
  };
  const calls: unknown[][] = [];
  const pi = {
    registerProvider(...args: unknown[]) {
      calls.push(args);
    },
  } as unknown as ExtensionAPI;

  registerNativeStreamRestoreProvider(pi, provider, provider.stream.bind(provider), { wrap: (stream) => stream });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  const registered = calls[0][0] as Provider;
  assert.equal(registered.id, provider.id);
  assert.equal(registered.auth, auth);
  assert.equal(registered.getModels, provider.getModels);
});

test("Pi 0.86 keeps native provider auth after stream registration", async () => {
  const emptyStream = () => {
    const stream = createAssistantMessageEventStream();
    stream.end();
    return stream;
  };
  const provider: Provider = {
    id: "native-auth-test",
    name: "Native auth test",
    auth: {
      apiKey: {
        name: "Test credentials",
        async resolve() {
          return { auth: { apiKey: "test-key" }, source: "test" };
        },
      },
    },
    getModels: () => [],
    stream: emptyStream,
    streamSimple: emptyStream,
  };
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(provider);

  registerNativeStreamRestoreProvider(
    registry as unknown as ExtensionAPI,
    registry.getProvider(provider.id)!,
    provider.stream,
    { wrap: (stream) => stream },
  );

  assert.equal(registry.getRegisteredProviderConfig(provider.id), undefined);
  assert.ok(registry.getRegisteredNativeProvider(provider.id));
  assert.equal((await registry.getProviderAuth(provider.id))?.auth.apiKey, "test-key");
});

test("dynamic placeholders participate in restoration and hold-back", async () => {
  const dynamicMap = new Map();
  const m = makeMasker([{ id: "tok", type: "regex", pattern: "token-[a-z]+" }], dynamicMap as never);
  const { text, count } = m.mask("use token-abc now");
  assert.equal(count, 1);
  const placeholder = /use (\S+) now/.exec(text)?.[1];
  assert.ok(placeholder && placeholder !== "token-abc");

  const partial = makePartial([textBlock("")]);
  const events = await runEvents(m, [
    { type: "text_delta", contentIndex: 0, delta: `found ${placeholder.slice(0, 4)}`, partial },
    { type: "text_delta", contentIndex: 0, delta: `${placeholder.slice(4)} done`, partial },
  ]);
  assert.equal(events[0].type === "text_delta" && events[0].delta, "found ");
  assert.equal(events[1].type === "text_delta" && events[1].delta, "token-abc done");
});
