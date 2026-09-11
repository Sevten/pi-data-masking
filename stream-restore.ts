/**
 * stream-restore.ts
 * Provider-level stream restoration (all UIs) — see docs/stream-restore-design.md.
 *
 * Rewrites AssistantMessageEvents so placeholders become real values before
 * they reach pi's event pipeline, plus the registration machinery that gets
 * the wrapper into every host's provider path:
 *
 *  - createStreamRestore(): the pure event transformer + stream wrapper.
 *  - registerStreamRestoreProviders(): registers stream-restoring wrappers
 *    eagerly at extension-factory time for every known provider. pi-web's
 *    session daemon freezes provider mutations on the shared runtime after a
 *    one-time bootstrap; only factory-time queued registrations (which are
 *    applied before the freeze) survive there. In the CLI the same
 *    registrations simply apply at runner init — behavior unchanged.
 *  - armStreamRestore(): before_agent_start hands the process-wide slot the
 *    live session's transformer, so factory-time queued wrappers (possibly
 *    queued by the daemon's throwaway bootstrap instance, whose masker has no
 *    session state) delegate to whichever live extension instance armed
 *    itself last.
 *
 * Concurrency note: when two sessions stream at once, the one that armed most
 * recently wins. Restoring with a foreign session's masker is a harmless no-op
 * (placeholders are sessionKey-derived), so the loser simply degrades to the
 * pre-fix behavior (restore at message_end) instead of corrupting output.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Masker } from "./masker.ts";

/** Accumulated stream state for one content block (text or thinking). */
export interface StreamRestoreBlockState {
  /** Raw (still-masked) text received for the block so far. */
  raw: string;
  /** How much of the restored text has already been emitted as deltas. */
  emittedLen: number;
}

/** The subset of Masker the stream transformer needs (also satisfiable by test doubles). */
export type StreamRestoreMasker = Pick<Masker, "unmaskDisplay" | "displayHoldbackLength">;

/**
 * Build the provider-stream transformer: rewrite AssistantMessageEvents so
 * placeholders are restored to real values before they enter pi's event
 * pipeline. This is the data-level fix that makes streaming show real values
 * in every UI — TUI, pi-web, and any web UI built on pi's SDK — because they
 * all consume the same event stream (the TUI renders the partial message, web
 * clients accumulate deltas append-only and finalize from message.end).
 *
 * Deltas carry only the confirmed prefix of the restored text: a trailing
 * fragment that could be the start of a placeholder is held back until the
 * next event resolves it, so a placeholder split across deltas is never
 * painted as a partial string. Tool arguments are deliberately not rewritten
 * here (partial JSON repair is unsafe); they keep using the tool_call hook.
 *
 * The masker is read through a getter so mid-session config swaps take effect
 * immediately and tests can inject their own instance.
 */
export function createStreamRestore(getMasker: () => StreamRestoreMasker): {
  transformEvent: (event: AssistantMessageEvent, blocks: Map<number, StreamRestoreBlockState>) => AssistantMessageEvent;
  wrap: (upstream: AssistantMessageEventStream) => AssistantMessageEventStream;
} {
  const restoreBlockText = (partial: AssistantMessage | undefined, contentIndex: number, restored: string): void => {
    const block = partial?.content?.[contentIndex];
    if (!block) return;
    if (block.type === "text") block.text = restored;
    else if (block.type === "thinking") block.thinking = restored;
  };

  const restoreMessageStrings = (message: AssistantMessage | undefined): void => {
    for (const block of message?.content ?? []) {
      if (block.type === "text") block.text = getMasker().unmaskDisplay(block.text);
      else if (block.type === "thinking") block.thinking = getMasker().unmaskDisplay(block.thinking);
    }
  };

  const transformEvent = (
    event: AssistantMessageEvent,
    blocks: Map<number, StreamRestoreBlockState>,
  ): AssistantMessageEvent => {
    switch (event.type) {
      case "text_delta":
      case "thinking_delta": {
        const m = getMasker();
        const state = blocks.get(event.contentIndex) ?? { raw: "", emittedLen: 0 };
        blocks.set(event.contentIndex, state);
        state.raw += event.delta;
        const candidate = m.unmaskDisplay(state.raw);
        // Keep the partial the TUI renders in sync with the restored text.
        restoreBlockText(event.partial, event.contentIndex, candidate);
        const confirmed = candidate.length - m.displayHoldbackLength(candidate);
        let delta = "";
        if (confirmed >= state.emittedLen) {
          delta = candidate.slice(state.emittedLen, confirmed);
          state.emittedLen = confirmed;
        }
        // A shrunken confirmed region (hold-back miss) emits nothing here;
        // the *_end/done events repair the full text instead.
        return { ...event, delta };
      }
      case "text_end":
      case "thinking_end": {
        const restored = getMasker().unmaskDisplay(event.content);
        restoreBlockText(event.partial, event.contentIndex, restored);
        const state = blocks.get(event.contentIndex);
        if (state) state.emittedLen = restored.length;
        return { ...event, content: restored };
      }
      case "done":
        restoreMessageStrings(event.message);
        blocks.clear();
        return event;
      case "error":
        restoreMessageStrings(event.error);
        blocks.clear();
        return event;
      default:
        return event;
    }
  };

  const wrap = (upstream: AssistantMessageEventStream): AssistantMessageEventStream => {
    try {
      const out = createAssistantMessageEventStream();
      const blocks = new Map<number, StreamRestoreBlockState>();
      let lastPartial: AssistantMessage | undefined;
      void (async () => {
        try {
          for await (const event of upstream) {
            if ("partial" in event) lastPartial = event.partial;
            let next = event;
            try {
              next = transformEvent(event, blocks);
            } catch {
              next = event; // transform bug must never break the stream
            }
            out.push(next);
          }
          out.end();
        } catch (err) {
          // Iterator failure: surface a well-formed error event instead of
          // leaving consumers waiting on result() forever.
          try {
            if (lastPartial) {
              const message: AssistantMessage = {
                ...lastPartial,
                stopReason: "error",
                errorMessage: err instanceof Error ? err.message : String(err),
              };
              out.push({ type: "error", reason: "error", error: message });
            }
          } catch {
            // nothing more we can do
          }
          out.end();
        }
      })();
      return out;
    } catch {
      return upstream; // construction failed — pass the stream through untouched
    }
  };

  return { transformEvent, wrap };
}

/**
 * Process-wide slot for the active stream restore (see createStreamRestore).
 *
 * The streamSimple wrapper that actually reaches streaming may be the one
 * queued at extension-factory time (registerStreamRestoreProviders) —
 * possibly by a host's throwaway bootstrap instance, whose masker has no
 * session state. The queued wrapper is instance-agnostic: it delegates
 * through this slot to whichever live extension instance armed itself last
 * (before_agent_start), so the real per-session masker performs the restore.
 */
const STREAM_RESTORE_SLOT = "__piDataMaskingStreamRestore";

interface StreamRestoreLike {
  wrap(stream: AssistantMessageEventStream): AssistantMessageEventStream;
}

export function armStreamRestore(getRestore: () => StreamRestoreLike): void {
  (globalThis as Record<string, unknown>)[STREAM_RESTORE_SLOT] = { restore: getRestore };
}

function wrapWithActiveRestore(stream: AssistantMessageEventStream): AssistantMessageEventStream {
  const slot = (globalThis as Record<string, unknown>)[STREAM_RESTORE_SLOT] as
    | { restore: () => StreamRestoreLike | undefined }
    | undefined;
  const restore = slot?.restore();
  return restore ? restore.wrap(stream) : stream;
}

/**
 * Register stream-restoring streamSimple wrappers for every known provider at
 * extension-factory time (see module doc). Best effort: older cores or
 * unusual hosts simply keep the lazy registration path in index.ts.
 */
export function registerStreamRestoreProviders(pi: ExtensionAPI): void {
  try {
    registerBuiltInApiProviders();
    const providerApis = new Map<string, string>();
    for (const providerId of getBuiltinProviders()) {
      const model = getBuiltinModels(providerId)[0];
      if (model?.api) providerApis.set(providerId, model.api);
    }
    // models.json-defined (config) providers are not part of the builtin catalog.
    try {
      const modelsPath = resolve(getAgentDir(), "models.json");
      if (existsSync(modelsPath)) {
        const parsed = JSON.parse(readFileSync(modelsPath, "utf8")) as {
          providers?: Record<string, { api?: string }>;
        };
        for (const [providerId, providerConfig] of Object.entries(parsed.providers ?? {})) {
          if (providerConfig?.api && !providerApis.has(providerId)) {
            providerApis.set(providerId, providerConfig.api);
          }
        }
      }
    } catch { /* models.json is optional */ }
    for (const [providerId, api] of providerApis) {
      const apiImpl = getApiProvider(api);
      if (!apiImpl?.streamSimple) continue;
      pi.registerProvider?.(providerId, {
        api,
        streamSimple: (model, context, options) => {
          return wrapWithActiveRestore(apiImpl.streamSimple(model, context, options));
        },
      });
    }
  } catch {
    // Best effort: older cores or unusual hosts simply keep the lazy
    // registration path in ensureStreamDisplayRestore (index.ts).
  }
}
