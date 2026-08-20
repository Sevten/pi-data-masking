/**
 * index.ts
 * Main entry point for the pi-data-masking extension.
 *
 * Core mechanism:
 *  1. context event     — outbound masking: deep-replace every message sent
 *                          to the LLM (the conversation itself is unaffected)
 *  2. message_end event — inbound unmasking: restore real values before the
 *                          AI's response is stored in the conversation
 *  3. tool_call event   — pre-execution unmasking: restore tool arguments in
 *                          place so tools run with real values
 *
 * Provenance (first-seen is forever, see docs/design-proposal.md D1/O1):
 *  - Values first seen in LLM output are never masked for the session
 *    (llmInventedValues): the LLM already knows them, and masking them would
 *    change the representation of its own messages. Only user messages and
 *    tool results register values (protectedValues); assistant history is
 *    re-masked only for already-registered values, so restored echoes never
 *    leak back to the LLM.
 *
 * Session key:
 *  - A random sessionKey is generated on session_start
 *  - It stays the same for the whole session (including config hot reloads
 *    and /masking-toggle)
 *  - This guarantees the same real value always maps to the same placeholder
 *    within a session
 *
 * Dynamic placeholder map (regex rules only):
 *  - Real values matched by regex rules aren't known at config-load time, so
 *    masker.ts generates their placeholders at runtime and records them in
 *    dynamicPlaceholderMap.
 *  - dynamicPlaceholderMap shares its lifecycle with sessionKey: created
 *    (cleared) only on session_start; every other path (config hot reload and
 *    /masking-toggle) reuses the same Map reference when
 *    constructing a new Masker, so dynamically generated placeholders stay
 *    stable across rule changes or toggling — only a brand-new session
 *    resets them.
 *
 */

import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";
import { Masker, isRegexRule } from "./masker.ts";
import type { DynamicPlaceholderMap, MaskOptions } from "./masker.ts";
import { loadConfig, loadPersistentToggle, savePersistentToggle, watchConfigs } from "./config-loader.ts";
import type { MaskingConfig } from "./config-loader.ts";
import { generateSessionKey } from "./placeholder-gen.ts";
import {
  createHistoryViewer,
  mergePendingAssistant,
  mergeTranscript,
  type TranscriptEntry,
} from "./history-viewer.ts";
import {
  SESSION_STATE_ENTRY,
  SNAPSHOT_ENTRY,
  buildMessageSnapshot,
  restoreHistory,
  type MessageSnapshot,
  type PersistedSessionState,
  type SessionEntryLike,
  type SnapshotBatch,
} from "./history-persistence.ts";

// ─── Types ──────────────────────────────────────────────────────────────────



// Warn once per session when the dynamic placeholder map (regex-discovered
// values) grows past this many entries — it only grows within a session.
const DYNAMIC_MAP_WARN_THRESHOLD = 5000;

// System-prompt guidance paragraph (options.systemPromptGuidance, default
// off): appended after the masked system prompt to reduce the chance the LLM
// treats placeholder appearance as meaningful (docs/design-proposal.md D6).
const SYSTEM_PROMPT_GUIDANCE =
  "[System note: some values in this conversation are masked placeholders. " +
  "Treat them as opaque tokens: never infer their original values from their " +
  "appearance, never transform or derive from them, and note that text " +
  "describing a value's properties (prefix, format, strength) may refer to " +
  "the original value, not the placeholder.]";

// ─── Helpers ──────────────────────────────────────────────────────────────

function nowTime(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function unmaskMessage<T>(
  message: T,
  masker: Masker
): { message: T } {
  const r = masker.unmaskValue(message);
  return { message: r.value as T };
}

function statusLabel(cfg: MaskingConfig): string {
  return cfg.enabled
    ? `🔒 Masking: ${cfg.rules.length} rule(s)`
    : `🔓 Masking: off`;
}

function ruleListItem(rule: MaskingConfig["rules"][number], index: number): SelectItem {
  const number = String(index + 1).padStart(2);
  if (isRegexRule(rule)) {
    return {
      value: String(index),
      label: `${number}. [regex] /${rule.pattern}/${rule.flags ?? ""}`,
      description: rule.description,
    };
  }
  return {
    value: String(index),
    label: `${number}. ${rule.placeholder ?? "(auto placeholder)"}`,
    description: rule.description,
  };
}

function ruleListDetail(rule: MaskingConfig["rules"][number], index: number): string {
  const header = `Rule ${index + 1}: ${rule.id}`;
  const description = rule.description ? `\nDescription: ${rule.description}` : "";
  if (isRegexRule(rule)) {
    return `${header}\nRegex pattern: /${rule.pattern}/${rule.flags ?? ""}${description}`;
  }
  return `${header}\nPlaceholder: ${rule.placeholder ?? "(auto placeholder)"}${description}`;
}

// ─── Extension entry point ──────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  let config: MaskingConfig = {
    enabled: false,
    rules: [],
    options: { caseSensitive: true, showStatusBar: true, systemPromptGuidance: false, persistHistory: true },
  };
  let masker = new Masker([], true);
  let stopWatching: (() => void) | null = null;
  let testTimer: ReturnType<typeof setTimeout> | null = null;

  // Session key: generated on session_start, stays constant for the whole
  // session (including config hot reloads). Pre-initialized to a valid value to
  // avoid a null pointer if another event fires before session_start.
  let sessionKey: Buffer = generateSessionKey();

  // Dynamic placeholder map (regex-discovered values only): created and
  // cleared on session_start, reused everywhere else — see file header.
  let dynamicPlaceholderMap: DynamicPlaceholderMap = new Map();

  // Provenance sets (see file header): values first seen in LLM output are
  // never masked; values first seen in user/tool messages are masked in
  // every message role. Same lifecycle as dynamicPlaceholderMap.
  let llmInventedValues: Set<string> = new Set();
  let protectedValues: Set<string> = new Set();

  // A local-only replay of messages that crossed the model boundary.
  let transcript: TranscriptEntry[] = [];
  let snapshotSignatures = new Map<string, string>();
  let requestSequence = 0;
  let sessionStatePersisted = false;

  // One-time-per-session warning flags (reset on session_start)
  let fallbackNotifiedThisTurn = false;
  let systemPromptWarned = false;
  let dynamicMapWarned = false;
  let inventedMapWarned = false;
  let persistenceWarned = false;

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** Build a new Masker from the current config.options, sessionKey, and dynamicPlaceholderMap */
  function buildMasker(rules: MaskingConfig["rules"]): Masker {
    return new Masker(
      rules,
      config.options.caseSensitive,
      sessionKey,
      dynamicPlaceholderMap,
      llmInventedValues,
      protectedValues
    );
  }

  /** Per-role masking options: assistant history is only re-masked for values
   *  that are already protected (restored echoes); user and tool messages
   *  discover/register new values; tool results always register (real data
   *  sources, regardless of what the LLM said earlier). */
  function maskOptionsForRole(role: string | undefined): MaskOptions {
    if (role === "assistant") return { discover: false };
    return { discover: true, ignoreInvented: role === "toolResult" };
  }

  /** Rebuild masker and return any regex-compile warnings for the caller to surface */
  function rebuild(cfg: MaskingConfig): string[] {
    config = cfg;
    masker = buildMasker(cfg.rules);
    return masker.warnings;
  }

  /** Apply the user-level /masking-toggle override after config-file merging. */
  async function applyPersistentToggle(cfg: MaskingConfig): Promise<{ config: MaskingConfig; warnings: string[] }> {
    const persisted = await loadPersistentToggle();
    if (persisted.enabled === undefined) {
      return { config: cfg, warnings: persisted.warning ? [persisted.warning] : [] };
    }
    return {
      config: { ...cfg, enabled: persisted.enabled },
      warnings: persisted.warning ? [persisted.warning] : [],
    };
  }

  function notifyWarnings(ctx: ExtensionContext, warnings: string[]) {
    for (const w of warnings) ctx.ui.notify(`⚠️ ${w}`, "info");
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!config.options.showStatusBar) return;
    ctx.ui.setStatus("masking", statusLabel(config));
  }

  /** Persist only new/changed per-message model-input differences. */
  function persistSnapshots(
    ctx: ExtensionContext,
    originals: Record<string, unknown>[],
    masked: Record<string, unknown>[],
  ) {
    if (!config.options.persistHistory) return;
    requestSequence++;
    const changed: MessageSnapshot[] = [];
    for (let index = 0; index < originals.length; index++) {
      const original = originals[index]!;
      const snapshot = buildMessageSnapshot(original, masked[index] ?? original, index);
      if (snapshotSignatures.get(snapshot.messageKey) !== snapshot.signature) changed.push(snapshot);
    }
    if (changed.length === 0) return;

    const batch: SnapshotBatch = {
      version: 1,
      requestSequence,
      capturedAt: Date.now(),
      messages: changed,
    };
    try {
      pi.appendEntry(SNAPSHOT_ENTRY, batch);
      for (const snapshot of changed) snapshotSignatures.set(snapshot.messageKey, snapshot.signature);
    } catch (err) {
      if (!persistenceWarned) {
        persistenceWarned = true;
        ctx.ui.notify(`⚠️ Failed to persist masking history: ${(err as Error).message}`, "warning");
      }
    }
  }

  function ensureSessionStatePersisted(ctx: ExtensionContext) {
    if (!config.options.persistHistory || sessionStatePersisted) return;
    const state: PersistedSessionState = { version: 1, sessionKey: sessionKey.toString("base64") };
    try {
      pi.appendEntry(SESSION_STATE_ENTRY, state);
      sessionStatePersisted = true;
    } catch (err) {
      if (!persistenceWarned) {
        persistenceWarned = true;
        ctx.ui.notify(`⚠️ Failed to persist masking session state: ${(err as Error).message}`, "warning");
      }
    }
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    stopWatching?.();
    const branchEntries = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
    const restored = restoreHistory(branchEntries);
    transcript = restored.transcript;
    snapshotSignatures = restored.signatures;
    requestSequence = restored.requestSequence;
    sessionStatePersisted = restored.sessionKey !== undefined;

    // A resumed Pi session reuses its persisted key, keeping placeholders
    // stable across process restarts. Sessions predating persistence get a new
    // key and clearly marked missing snapshots for their existing messages.
    sessionKey = restored.sessionKey ?? generateSessionKey();
    dynamicPlaceholderMap = new Map();
    llmInventedValues = new Set();
    protectedValues = new Set();
    fallbackNotifiedThisTurn = false;
    systemPromptWarned = false;
    dynamicMapWarned = false;
    inventedMapWarned = false;
    persistenceWarned = false;

    const loaded = await loadConfig(ctx.cwd, sessionKey);
    const persisted = await applyPersistentToggle(loaded.config);
    const compileWarnings = rebuild(persisted.config);

    // Replay the full active branch locally to rebuild dynamic mappings and
    // first-seen provenance using the restored session key. Nothing from this
    // pass is counted or sent to the model.
    for (const message of restored.messages) {
      const role = typeof message.role === "string" ? message.role : undefined;
      masker.maskValue(message, maskOptionsForRole(role));
    }

    ensureSessionStatePersisted(ctx);
    notifyWarnings(ctx, [...loaded.warnings, ...persisted.warnings, ...compileWarnings]);

    stopWatching = watchConfigs(ctx.cwd, async () => {
      // Hot reload: reuse the current session's sessionKey and dynamicPlaceholderMap
      const reloaded = await loadConfig(ctx.cwd, sessionKey);
      const persistedReload = await applyPersistentToggle(reloaded.config);
      const reloadWarnings = rebuild(persistedReload.config);
      ensureSessionStatePersisted(ctx);
      ctx.ui.notify(
        `🔒 Masking config reloaded (${persistedReload.config.rules.length} rule(s))`,
        "info"
      );
      notifyWarnings(ctx, [...reloaded.warnings, ...persistedReload.warnings, ...reloadWarnings]);
      updateStatus(ctx);
    });

    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopWatching?.();
    stopWatching = null;
    if (testTimer) clearTimeout(testTimer);
  });

  // ── Hook 1: context — outbound masking ────────────────────────────────────

  pi.on("context", async (event, ctx) => {
    const messages = event.messages;
    // Retain the complete local replay even while masking is off. When it is
    // enabled, the same entries are replaced below with the actual masked form
    // sent through this boundary.
    if (!config.enabled || config.rules.length === 0) {
      const originals = messages as unknown as Record<string, unknown>[];
      transcript = mergeTranscript(
        transcript,
        originals,
        originals,
      );
      persistSnapshots(ctx, originals, originals);
      return;
    }

    // Mask everything (including history) before returning to the LLM, so
    // it only ever sees placeholders for protected values.
    const maskedMessages = messages.map((msg) =>
      masker.maskValue(msg, maskOptionsForRole((msg as { role?: string }).role)).value
    );

    if (!dynamicMapWarned && dynamicPlaceholderMap.size >= DYNAMIC_MAP_WARN_THRESHOLD) {
      dynamicMapWarned = true;
      ctx.ui.notify(
        `⚠️ ${dynamicPlaceholderMap.size} distinct regex-discovered values this session; the mapping only grows — consider narrowing regex rules`,
        "warning"
      );
    }
    if (!inventedMapWarned && llmInventedValues.size >= DYNAMIC_MAP_WARN_THRESHOLD) {
      inventedMapWarned = true;
      ctx.ui.notify(
        `⚠️ ${llmInventedValues.size} distinct LLM-generated values recorded this session (first-seen-immutable); the set only grows — consider narrower regex rules`,
        "warning"
      );
    }

    transcript = mergeTranscript(
      transcript,
      messages as unknown as Record<string, unknown>[],
      maskedMessages as Record<string, unknown>[],
    );
    persistSnapshots(
      ctx,
      messages as unknown as Record<string, unknown>[],
      maskedMessages as Record<string, unknown>[],
    );
    return { messages: maskedMessages as typeof event.messages };
  });

  // ── Hook 2: message_end — inbound unmasking ───────────────────────────────

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    if (!config.enabled || config.rules.length === 0) {
      transcript = mergePendingAssistant(
        transcript,
        event.message as unknown as Record<string, unknown>,
        event.message as unknown as Record<string, unknown>,
      );
      return;
    }

    // Restore real values before storing, so the user always sees the real data
    const { message } = unmaskMessage(event.message, masker);
    // The response is not part of the outbound context until the next model
    // request. Keep a provisional snapshot so the viewer includes it now; the
    // next context hook replaces it with the exact provider-boundary version.
    const maskedForTranscript = masker.maskValue(message, maskOptionsForRole("assistant")).value;
    transcript = mergePendingAssistant(
      transcript,
      message as unknown as Record<string, unknown>,
      maskedForTranscript as Record<string, unknown>,
    );

    return { message: message as typeof event.message };
  });

  // ── Hook 3: tool_call — pre-execution unmasking ───────────────────────────

  pi.on("tool_call", async (event, _ctx) => {
    if (!config.enabled || config.rules.length === 0) return;

    const { value, count } = masker.unmaskValue(event.input as unknown);
    if (count === 0) return;

    // Update event.input in place so the tool runs with real arguments
    const unmasked = value as Record<string, unknown>;
    for (const key of Object.keys(unmasked)) {
      (event.input as Record<string, unknown>)[key] = unmasked[key];
    }
  });

  // ── Hook 4: turn_start — reset the per-turn fallback notification flag ────

  pi.on("turn_start", async () => {
    fallbackNotifiedThisTurn = false;
  });

  // ── Hook 5: before_agent_start — mask the system prompt (default on) ──────

  pi.on("before_agent_start", async (event, ctx) => {
    if (!config.enabled || config.rules.length === 0) return;
    const r = masker.mask(event.systemPrompt, { discover: true });
    let text = r.text;
    if (config.options.systemPromptGuidance) {
      text += "\n\n" + SYSTEM_PROMPT_GUIDANCE;
    }
    if (r.count > 0 && !systemPromptWarned) {
      systemPromptWarned = true;
      ctx.ui.notify(
        `⚠️ System prompt contained ${r.count} sensitive value(s) and was masked before sending; if this is unexpected, review your masking rules`,
        "warning"
      );
    }
    if (r.count === 0 && !config.options.systemPromptGuidance) return;
    return { systemPrompt: text };
  });

  // ── Hook 6: before_provider_request — final outbound safety net ────────────

  pi.on("before_provider_request", async (event, ctx) => {
    if (!config.enabled || config.rules.length === 0) return;
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return;

    const record = payload as Record<string, unknown>;
    let intercepted = 0;

    if (Array.isArray(record.messages)) {
      const masked = record.messages.map((m) => {
        const role = (m as { role?: string } | null)?.role;
        const isAssistant = role === "assistant";
        const r = masker.maskValue(m, maskOptionsForRole(role));
        // Assistant re-masking at this boundary is bookkeeping (idempotent
        // on the context hook's output); only genuinely intercepted
        // user/tool-side values count toward the fallback notice.
        if (!isAssistant) intercepted += r.count;
        return r.value;
      });
      record.messages = masked;
    }
    if (typeof record.system === "string") {
      const r = masker.mask(record.system, { discover: true });
      if (r.count > 0) {
        record.system = r.text;
        intercepted += r.count;
      }
    }
    if (typeof record.prompt === "string") {
      const r = masker.mask(record.prompt, { discover: true });
      if (r.count > 0) {
        record.prompt = r.text;
        intercepted += r.count;
      }
    }

    if (intercepted > 0 && !fallbackNotifiedThisTurn) {
      fallbackNotifiedThisTurn = true;
      ctx.ui.notify(
        `🛡️ ${intercepted} sensitive value(s) intercepted at the provider request boundary (bypassed the context hook — check other extensions or injected content)`,
        "warning"
      );
    }

    return payload;
  });

  // ── Command: /masking-list ───────────────────────────────────────────────

  pi.registerCommand("masking-list", {
    description: "Browse masking rules in a scrollable panel (real values not shown)",
    handler: async (_args, ctx) => {
      if (config.rules.length === 0) {
        ctx.ui.notify("No masking rules configured — check masking.config.json", "info");
        return;
      }
      const rules = config.rules;
      const items = rules.map(ruleListItem);

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const container = new Container();
        const detail = new Text(ruleListDetail(rules[0]!, 0), 1, 0);
        const list = new SelectList(items, Math.max(3, tui.terminal.rows - 13), {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });

        list.onSelectionChange = (item) => {
          const index = Number(item.value);
          const rule = rules[index];
          if (rule) detail.setText(ruleListDetail(rule, index));
        };
        list.onCancel = () => done();

        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold(`Masking rules (${rules.length}, priority order)`)), 1, 0));
        container.addChild(new Spacer(1));
        container.addChild(list);
        container.addChild(new Spacer(1));
        container.addChild(detail);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "↑↓ browse  ·  Esc close"), 1, 0));
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

        return {
          render: (width) => {
            const lines = container.render(width);
            return [...lines, ...Array(Math.max(0, tui.terminal.rows - lines.length)).fill("")];
          },
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      }, {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
      });
    },
  });

  // ── Command: /masking-history ────────────────────────────────────────────

  pi.registerCommand("masking-history", {
    description: "Replay this session with original and masked text",
    handler: async (_args, ctx) => {
      if (transcript.length === 0) {
        ctx.ui.notify("No conversation has reached the masking boundary yet", "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
        createHistoryViewer(tui, theme, keybindings, transcript, done),
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
      });
    },
  });

  // ── Command: /masking-toggle ──────────────────────────────────────────────

  pi.registerCommand("masking-toggle", {
    description: "Toggle masking on/off for future sessions too",
    handler: async (_args, ctx) => {
      const enabled = !config.enabled;
      try {
        await savePersistentToggle(enabled);
      } catch (err) {
        ctx.ui.notify(`Failed to save masking setting: ${(err as Error).message}`, "error");
        return;
      }
      config = { ...config, enabled };
      masker = buildMasker(enabled ? config.rules : []);
      ctx.ui.notify(`Data masking ${enabled ? "enabled" : "disabled"} (saved for future sessions)`, "info");
      notifyWarnings(ctx, masker.warnings);
      updateStatus(ctx);
    },
  });

  // ── Command: /masking-test ────────────────────────────────────────────────

  pi.registerCommand("masking-test", {
    description: "Preview how a text snippet looks after masking rules are applied",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();
      if (!input) {
        ctx.ui.notify("Usage: /masking-test <text to preview>", "info");
        return;
      }
      if (!config.enabled) {
        ctx.ui.notify(
          "Masking is currently disabled — enable it first with /masking-toggle",
          "info"
        );
        return;
      }
      if (config.rules.length === 0) {
        ctx.ui.notify(
          "No masking rules configured — check masking.config.json",
          "info"
        );
        return;
      }

      // Create a temporary, isolated Masker using the current session key.
      // A fresh empty map and provenance sets are passed so test runs never
      // pollute the real session's dynamicPlaceholderMap / provenance state.
      const tempMap: DynamicPlaceholderMap = new Map();
      const tempMasker = new Masker(
        config.rules,
        config.options.caseSensitive,
        sessionKey,
        tempMap,
        new Set(),
        new Set()
      );

      const { text: masked, count } = tempMasker.mask(input);

      const summary =
        count > 0
          ? `🔒 ${count} value(s) masked`
          : "✅ No values masked by current rules";

      ctx.ui.setWidget("masking-test", [
        `🧪 Masking test  ·  ${nowTime()}`,
        `─── Original`,
        `  ${input}`,
        `─── After masking (what LLM sees)  ${summary}`,
        `  ${masked}`,
      ]);
      if (testTimer) clearTimeout(testTimer);
      testTimer = setTimeout(() => {
        ctx.ui.setWidget("masking-test", undefined);
      }, 20_000);
    },
  });
}
