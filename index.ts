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
 * Provenance (first-seen is forever):
 *  - Values first seen in LLM output are never masked for the session
 *    (llmInventedValues): the LLM already knows them, and masking them would
 *    change the representation of its own messages. Only user messages and
 *    tool results register values (protectedValues); assistant history is
 *    re-masked only for already-registered values, so restored echoes never
 *    leak back to the LLM. Provenance is immutable: a later user message or
 *    tool result cannot promote an LLM-invented value to protected.
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

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, decodeKittyPrintable, matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditorTheme } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Masker, isRegexRule } from "./masker.ts";
import type { DynamicPlaceholderMap, MaskingRule, MaskOptions } from "./masker.ts";
import {
  GLOBAL_CONFIG_PATH,
  buildInitialConfig,
  createJsonFileExclusive,
  ensureProjectConfigGitignored,
  generateUniqueRuleId,
  getProjectConfigPath,
  loadConfig,
  loadPersistentToggle,
  readRawConfigFile,
  redactRawConfigFile,
  saveConfigRuleMutations,
  savePersistentToggle,
  saveRuleEnabledChanges,
  validateConfig,
  validateRawConfigRule,
  watchConfigs,
} from "./config-loader.ts";
import type {
  ConfiguredMaskingRule,
  ConfigScope,
  ConfigSourceSnapshot,
  MaskingConfig,
  RawConfigRule,
  RuleEnabledChange,
} from "./config-loader.ts";
import { generatePlaceholder, generateSessionKey } from "./placeholder-gen.ts";
import { MASKING_PRESETS } from "./presets.ts";
import {
  createHistoryViewer,
  mergePendingAssistant,
  mergeTranscript,
  transcriptKey,
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
import { MaskedCache, hashMessage } from "./masked-cache.ts";

// ─── Types ──────────────────────────────────────────────────────────────────



// Warn once per session when the dynamic placeholder map (regex-discovered
// values) grows past this many entries — it only grows within a session.
const DYNAMIC_MAP_WARN_THRESHOLD = 5000;

// System-prompt guidance paragraph (options.systemPromptGuidance, default
// off): appended after the masked system prompt to reduce the chance the LLM
// treats placeholder appearance as meaningful.
const SYSTEM_PROMPT_GUIDANCE =
  "[System note: some values in this conversation are masked placeholders. " +
  "Treat them as opaque tokens: never infer their original values from their " +
  "appearance, never transform or derive from them, and note that text " +
  "describing a value's properties (prefix, format, strength) may refer to " +
  "the original value, not the placeholder.]";

// Upper bound for snapshotContentHashes (last-persisted per-message
// fingerprints). It otherwise mirrors transcript growth, which is unbounded
// by design; overflowing clears it wholesale, costing one re-diff pass.
const SNAPSHOT_CONTENT_HASH_MAX_ENTRIES = 10_000;

// ─── Helpers ──────────────────────────────────────────────────────────────

function unmaskMessage<T>(
  message: T,
  masker: Masker
): { message: T } {
  const r = masker.unmaskValue(message);
  return { message: r.value as T };
}

function statusLabel(cfg: MaskingConfig): string {
  const configured = cfg.configuredRules.length;
  const active = cfg.rules.length;
  return cfg.enabled
    ? `🔒 Masking: ${active} active / ${configured} configured`
    : `🔓 Masking: off · ${active} rule(s) ready`;
}

function configuredRuleKey(configured: ConfiguredMaskingRule): string {
  return `${configured.path}\0${configured.sourceIndex}`;
}

function configuredRuleStableKey(configured: ConfiguredMaskingRule): string {
  return `${configured.path}\0${configured.rule.id}`;
}

function configuredRuleKind(configured: ConfiguredMaskingRule): "regex" | "exact" | "env" {
  if (isRegexRule(configured.rule)) return "regex";
  return configured.realFromEnv ? "env" : "exact";
}

function configuredRuleDisplayName(configured: ConfiguredMaskingRule): string {
  return configured.rule.name?.trim()
    || configured.rule.description?.trim()
    || configured.rule.id;
}

function configuredRuleDetail(configured: ConfiguredMaskingRule, revealValue: boolean): string[] {
  const rule = configured.rule;
  const lines = [
    `Description: ${rule.description?.trim() || "—"}`,
  ];
  if (configured.sourceKind === "preset") {
    lines.push(`Preset: ${configured.presetName}`);
    if (isRegexRule(rule)) lines.push(`Expanded regex: /${rule.pattern}/${rule.flags ?? ""}`);
  } else if (isRegexRule(rule)) {
    lines.push(`Regex: /${rule.pattern}/${rule.flags ?? ""}`);
  } else {
    if (configured.realFromEnv) {
      lines.push(`Environment: ${configured.realFromEnv} · ${configured.available ? "available" : "missing or empty"}`);
      if (configured.available) {
        lines.push(revealValue
          ? `Resolved value: ${JSON.stringify(rule.real)}`
          : "Resolved value: <hidden> · R to reveal");
      }
    } else {
      lines.push(revealValue
        ? `Exact value: ${JSON.stringify(rule.real)}`
        : "Exact value: <hidden> · R to reveal");
    }
    if (configured.placeholderMode === "custom") {
      lines.push(`Placeholder: ${rule.placeholder} · custom, stable across sessions`);
    } else if (configured.enabled && configured.available && rule.placeholder && rule.placeholder !== "auto") {
      lines.push(`Placeholder: ${rule.placeholder} · auto, current session`);
    } else {
      lines.push("Placeholder: automatic · generated when the rule becomes active");
    }
  }
  lines.push(`Scope: ${configured.scope}`);
  lines.push(`Source: ${configured.path}`);
  return lines;
}

// ─── Extension entry point ──────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  let config: MaskingConfig = {
    enabled: false,
    rules: [],
    configuredRules: [],
    options: { caseSensitive: true, showStatusBar: true, systemPromptGuidance: false, persistHistory: true },
  };
  let masker = new Masker([], true);
  let stopWatching: (() => void) | null = null;
  let configSnapshot: ConfigSourceSnapshot | undefined;

  // Session key: generated on session_start, stays constant for the whole
  // session (including config hot reloads). Pre-initialized to a valid value to
  // avoid a null pointer if another event fires before session_start.
  let sessionKey: Buffer = generateSessionKey();

  // Dynamic placeholder map (regex-discovered values only): created and
  // cleared on session_start, reused everywhere else — see file header.
  let dynamicPlaceholderMap: DynamicPlaceholderMap = new Map();

  // Provenance sets (see file header): values first seen in LLM output are
  // never masked; values first seen outside model output are masked in
  // every message role. Same lifecycle as dynamicPlaceholderMap.
  let llmInventedValues: Set<string> = new Set();
  let protectedValues: Set<string> = new Set();

  // A local-only replay of messages that crossed the model boundary.
  let transcript: TranscriptEntry[] = [];
  let snapshotSignatures = new Map<string, string>();
  /** Last-persisted content fingerprints per messageKey; lets persistSnapshots
   *  skip buildMessageSnapshot for messages whose original AND masked forms
   *  are provably unchanged since the previous request. */
  let snapshotContentHashes = new Map<string, MessageContentHashPair>();
  let requestSequence = 0;
  let sessionStatePersisted = false;

  // Masked-output caches (see masked-cache.ts): history messages are
  // immutable between turns and masking is deterministic, so unchanged
  // messages reuse their stored masked form instead of re-running every
  // rule regex. Cleared by invalidateMaskedCaches() on any masker-input
  // change (rebuild, toggle, session_start).
  const maskedCache = new MaskedCache();
  let systemPromptMemo: { input: string; text: string; count: number } | null = null;

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
   *  that are already protected (restored echoes); every non-assistant source
   *  may register only values whose first-seen provenance is still unknown. */
  function maskOptionsForRole(role: string | undefined): MaskOptions {
    if (role === "assistant") return { discover: false };
    return { discover: true };
  }

  /** Cache contents depend on rules, case sensitivity, sessionKey-derived
   *  placeholders, and provenance behavior; every path that swaps the Masker
   *  or starts a new session must clear them. Clearing is always safe —
   *  misses merely refill. */
  function invalidateMaskedCaches(): void {
    maskedCache.invalidate();
    systemPromptMemo = null;
  }

  interface MessageContentHashPair {
    original: string;
    masked: string;
  }

  interface ResolvedMaskedMessage {
    masked: unknown;
    pair: MessageContentHashPair;
    /** True when served from cache (fill side effects happened earlier). */
    fromCache: boolean;
    /** masker-reported replacement count; 0 for cache hits. */
    count: number;
  }

  function resolveMaskedMessage(message: unknown, index: number): ResolvedMaskedMessage {
    const key = message !== null && typeof message === "object"
      ? transcriptKey(message as Record<string, unknown>, index)
      : `raw:index:${index}`;
    const hash = hashMessage(message);
    const cached = maskedCache.lookup(key, hash);
    if (cached) {
      return {
        masked: cached.masked,
        pair: { original: hash, masked: cached.maskedHash },
        fromCache: true,
        count: 0,
      };
    }
    const role = (message as { role?: string } | null | undefined)?.role;
    const r = masker.maskValue(message, maskOptionsForRole(role));
    const maskedHash = hashMessage(r.value);
    maskedCache.record(key, hash, maskedHash, r.value);
    return {
      masked: r.value,
      pair: { original: hash, masked: maskedHash },
      fromCache: false,
      count: r.count,
    };
  }

  /**
   * Mask the system prompt through a one-entry memo. The prompt is static
   * for a session, yet before_agent_start and before_provider_request each
   * mask it; the memo stores the pre-guidance text and callers append
   * options-dependent guidance themselves. Fill runs the full discover:true
   * mask so provenance registration happens exactly once.
   */
  function maskSystemPromptCached(input: string): { text: string; count: number } {
    if (
      systemPromptMemo !== null &&
      systemPromptMemo.input.length === input.length &&
      systemPromptMemo.input === input
    ) {
      return systemPromptMemo;
    }
    const r = masker.mask(input, { discover: true });
    systemPromptMemo = { input, text: r.text, count: r.count };
    return systemPromptMemo;
  }

  /** Rebuild masker and return any regex-compile warnings for the caller to surface */
  function rebuild(cfg: MaskingConfig): string[] {
    config = cfg;
    masker = buildMasker(cfg.rules);
    // Rules/caseSensitive changed → cached masked outputs are stale.
    invalidateMaskedCaches();
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
    if (!config.options.showStatusBar) {
      ctx.ui.setStatus("masking", undefined);
      return;
    }
    ctx.ui.setStatus("masking", statusLabel(config));
  }

  async function reloadConfigNow(ctx: ExtensionContext): Promise<void> {
    const loaded = await loadConfig(ctx.cwd, sessionKey, configSnapshot);
    configSnapshot = loaded.snapshot;
    const persisted = await applyPersistentToggle(loaded.config);
    const compileWarnings = rebuild(persisted.config);
    notifyWarnings(ctx, [...loaded.warnings, ...persisted.warnings, ...compileWarnings]);
    updateStatus(ctx);
  }

  /** Persist only new/changed per-message model-input differences.
   *  contentHashes (when provided) skips the full diff/hash walk for
   *  messages whose original AND masked forms are unchanged since the last
   *  persisted request — the common case for history on every turn. */
  function persistSnapshots(
    ctx: ExtensionContext,
    originals: Record<string, unknown>[],
    masked: Record<string, unknown>[],
    contentHashes?: ReadonlyArray<MessageContentHashPair | undefined>,
  ) {
    if (!config.options.persistHistory) return;
    requestSequence++;
    const changed: MessageSnapshot[] = [];
    const changedPairs: Array<{ key: string; pair?: MessageContentHashPair }> = [];
    for (let index = 0; index < originals.length; index++) {
      const original = originals[index]!;
      const maskedMessage = masked[index] ?? original;
      const messageKey = transcriptKey(original, index);
      const pair = contentHashes?.[index];
      if (pair) {
        const prev = snapshotContentHashes.get(messageKey);
        if (
          prev !== undefined &&
          snapshotSignatures.has(messageKey) &&
          prev.original === pair.original &&
          prev.masked === pair.masked
        ) continue;
      }
      const snapshot = buildMessageSnapshot(original, maskedMessage, index);
      if (snapshotSignatures.get(snapshot.messageKey) !== snapshot.signature) {
        changed.push(snapshot);
        changedPairs.push({ key: snapshot.messageKey, pair });
      }
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
      if (snapshotContentHashes.size >= SNAPSHOT_CONTENT_HASH_MAX_ENTRIES) snapshotContentHashes.clear();
      for (let i = 0; i < changed.length; i++) {
        snapshotSignatures.set(changed[i]!.messageKey, changed[i]!.signature);
        const recordedPair = changedPairs[i]!.pair;
        if (recordedPair) snapshotContentHashes.set(changedPairs[i]!.key, recordedPair);
      }
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
    snapshotContentHashes = new Map();
    // Fresh sessionKey and provenance sets — cached masked outputs from any
    // prior state must not survive. (rebuild() below clears again; this also
    // covers paths that never reach it.)
    invalidateMaskedCaches();
    fallbackNotifiedThisTurn = false;
    systemPromptWarned = false;
    dynamicMapWarned = false;
    inventedMapWarned = false;
    persistenceWarned = false;

    configSnapshot = undefined;
    const loaded = await loadConfig(ctx.cwd, sessionKey);
    configSnapshot = loaded.snapshot;
    const persisted = await applyPersistentToggle(loaded.config);
    const compileWarnings = rebuild(persisted.config);

    // Replay the full active branch locally to rebuild dynamic mappings and
    // first-seen provenance using the restored session key, priming the
    // masked-output cache so the first post-restore request skips re-masking
    // history. Nothing from this pass is counted or sent to the model.
    for (let index = 0; index < restored.messages.length; index++) {
      resolveMaskedMessage(restored.messages[index], index);
    }

    ensureSessionStatePersisted(ctx);
    notifyWarnings(ctx, [...loaded.warnings, ...persisted.warnings, ...compileWarnings]);

    stopWatching = watchConfigs(ctx.cwd, async () => {
      // Hot reload: reuse the current session's sessionKey and dynamicPlaceholderMap
      const reloaded = await loadConfig(ctx.cwd, sessionKey, configSnapshot);
      configSnapshot = reloaded.snapshot;
      const persistedReload = await applyPersistentToggle(reloaded.config);
      const reloadWarnings = rebuild(persistedReload.config);
      ensureSessionStatePersisted(ctx);
      ctx.ui.notify(
        `🔒 Masking config reloaded (${persistedReload.config.rules.length} active / ${persistedReload.config.configuredRules.length} configured)`,
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
  });

  // ── Hook 1: context — outbound masking ────────────────────────────────────

  pi.on("context", async (event, ctx) => {
    const messages = event.messages;
    const originals = messages as unknown as Record<string, unknown>[];
    // Retain the complete local replay even while masking is off. When it is
    // enabled, the same entries are replaced below with the actual masked form
    // sent through this boundary.
    if (!config.enabled || config.rules.length === 0) {
      const disabledHashes: string[] = [];
      const disabledPairs: MessageContentHashPair[] = [];
      for (let index = 0; index < originals.length; index++) {
        const hash = hashMessage(originals[index]);
        disabledHashes.push(hash);
        disabledPairs.push({ original: hash, masked: hash });
      }
      transcript = mergeTranscript(transcript, originals, originals, Date.now(), disabledHashes);
      persistSnapshots(ctx, originals, originals, disabledPairs);
      return;
    }

    // Mask everything (including history) before returning to the LLM, so
    // it only ever sees placeholders for protected values. History messages
    // are immutable between turns, so resolveMaskedMessage serves their
    // stored masked form from the cache; the full maskValue cost is paid
    // only for new or changed tail messages.
    const maskedMessages: Record<string, unknown>[] = [];
    const contentHashes: MessageContentHashPair[] = [];
    for (let index = 0; index < originals.length; index++) {
      const resolved = resolveMaskedMessage(originals[index], index);
      maskedMessages.push(resolved.masked as Record<string, unknown>);
      contentHashes.push(resolved.pair);
    }

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
      originals,
      maskedMessages,
      Date.now(),
      contentHashes.map((pair) => pair.original),
    );
    persistSnapshots(ctx, originals, maskedMessages, contentHashes);
    return { messages: maskedMessages as unknown as typeof event.messages };
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
    // Memoized: the prompt is static per session and is masked again at the
    // provider boundary; fill registers provenance exactly once.
    const r = maskSystemPromptCached(event.systemPrompt);
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
    let changedCount = 0;

    if (Array.isArray(record.messages)) {
      const source = record.messages as unknown[];
      const maskedMessages: unknown[] = new Array(source.length);
      for (let index = 0; index < source.length; index++) {
        const m = source[index];
        const resolved = resolveMaskedMessage(m, index);
        maskedMessages[index] = resolved.masked;
        // Cache hits mean the context hook already sent this exact content
        // through the masker — only fills can be boundary interceptions.
        // Assistant re-masking at this boundary is bookkeeping and never
        // counts toward the fallback notice.
        const role = (m as { role?: string } | null)?.role;
        if (!resolved.fromCache && role !== "assistant") intercepted += resolved.count;
        if (resolved.masked !== m) changedCount++;
      }
      // Replace the payload only when something actually differs; system and
      // prompt below are still scanned unconditionally either way.
      if (changedCount > 0) record.messages = maskedMessages;
    }
    if (typeof record.system === "string") {
      const r = maskSystemPromptCached(record.system);
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

  // ── Command: /masking ────────────────────────────────────────────────────

  async function chooseExistingSource(
    ctx: ExtensionContext,
    title: string,
  ): Promise<{ scope: ConfigScope; path: string } | undefined> {
    const projectPath = getProjectConfigPath(ctx.cwd);
    const choices: Array<{ label: string; scope: ConfigScope; path: string }> = [];
    if (existsSync(projectPath)) choices.push({ label: `project  ·  ${projectPath}`, scope: "project", path: projectPath });
    if (existsSync(GLOBAL_CONFIG_PATH)) choices.push({ label: `global   ·  ${GLOBAL_CONFIG_PATH}`, scope: "global", path: GLOBAL_CONFIG_PATH });
    if (choices.length === 0) {
      ctx.ui.notify("Add a rule first to create a project or global config", "warning");
      return undefined;
    }
    const selected = await ctx.ui.select(title, [...choices.map(({ label }) => label), "Cancel"]);
    if (!selected || selected === "Cancel") return undefined;
    return choices.find(({ label }) => label === selected);
  }

  async function saveStructuralChanges(
    ctx: ExtensionContext,
    mutations: Parameters<typeof saveConfigRuleMutations>[0],
  ): Promise<boolean> {
    try {
      const saved = await saveConfigRuleMutations(mutations);
      notifyWarnings(ctx, saved.warnings);
      await reloadConfigNow(ctx);
      return true;
    } catch (err) {
      ctx.ui.notify(`Failed to update masking config: ${(err as Error).message}`, "error");
      return false;
    }
  }

  interface LocalMaskingPreview {
    text: string;
    count: number;
    attribution: string;
    warnings: string[];
  }

  function previewWithRules(
    input: string,
    rules: MaskingRule[],
    names: ReadonlyMap<string, string>,
    warnings: string[] = [],
  ): LocalMaskingPreview {
    if (!input) return { text: "", count: 0, attribution: "Enter text to preview locally", warnings };
    if (rules.length === 0) return { text: input, count: 0, attribution: "No valid rules available for this preview", warnings };
    const tempMasker = new Masker(
      rules,
      config.options.caseSensitive,
      sessionKey,
      new Map(),
      new Set(),
      new Set(),
    );
    const result = tempMasker.mask(input);
    const attribution = result.details.length === 0
      ? "No values matched"
      : result.details.map((detail) => {
          const occurrences = detail.values.reduce((sum, value) => sum + value.occurrences, 0);
          return `${names.get(detail.ruleId) ?? detail.ruleId} ×${occurrences}`;
        }).join(" · ");
    return {
      text: result.text,
      count: result.count,
      attribution,
      warnings: [...warnings, ...tempMasker.warnings],
    };
  }

  function previewCandidateRule(input: string, draftText: string): LocalMaskingPreview {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draftText) as unknown;
    } catch (err) {
      return { text: input, count: 0, attribution: "Draft is not valid JSON", warnings: [(err as Error).message] };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { text: input, count: 0, attribution: "Draft must be a JSON object", warnings: [] };
    }
    const candidate: RawConfigRule = { ...(parsed as RawConfigRule), enabled: true };
    const validated = validateConfig([candidate]);
    let mutationWarnings: string[] = [];
    try {
      mutationWarnings = validateRawConfigRule(candidate);
    } catch {
      // validateConfig warnings below already explain why no runnable rule exists.
    }
    for (const rule of validated.rules) {
      if (!isRegexRule(rule) && (!rule.placeholder || rule.placeholder === "auto")) {
        rule.placeholder = generatePlaceholder(rule.real, sessionKey, 0, rule.preserveStructure);
      }
    }
    const id = typeof candidate.id === "string" ? candidate.id : "candidate";
    const name = typeof candidate.name === "string" ? candidate.name : id;
    return previewWithRules(
      input,
      validated.rules,
      new Map([[id, name]]),
      [...new Set([...validated.warnings, ...mutationWarnings])],
    );
  }

  function previewActiveRules(input: string): LocalMaskingPreview {
    const names = new Map<string, string>();
    for (const configured of config.configuredRules) {
      if (!names.has(configured.rule.id)) names.set(configured.rule.id, configuredRuleDisplayName(configured));
    }
    return previewWithRules(input, config.rules, names);
  }

  async function editRuleJson(
    ctx: ExtensionContext,
    title: string,
    prefill: string,
    options: { literalValue?: string; hiddenMarker?: string; initialTestText?: string } = {},
  ): Promise<string | undefined> {
    return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
      const editorTheme: EditorTheme = {
        borderColor: (text) => theme.fg("accent", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      };
      const ruleEditor = new Editor(tui, editorTheme);
      const testEditor = new Editor(tui, editorTheme);
      ruleEditor.setText(prefill);
      testEditor.setText(options.initialTestText ?? "");
      let focus: "rule" | "test" = "rule";
      let literalHidden = options.literalValue !== undefined
        && options.hiddenMarker !== undefined
        && prefill.includes(options.hiddenMarker);
      let literalValue = options.literalValue;
      let toggleError = "";

      function toggleLiteral(): void {
        if (literalValue === undefined || !options.hiddenMarker) return;
        try {
          const parsed = JSON.parse(ruleEditor.getExpandedText()) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("rule must be a JSON object");
          }
          const draft = parsed as RawConfigRule;
          if (literalHidden) {
            if (draft.real !== options.hiddenMarker) {
              throw new Error("the hidden marker was edited; fix or submit the draft first");
            }
            draft.real = literalValue;
          } else {
            if (typeof draft.real !== "string") throw new Error("the real field must be a string");
            literalValue = draft.real;
            draft.real = options.hiddenMarker;
          }
          literalHidden = !literalHidden;
          toggleError = "";
          ruleEditor.setText(JSON.stringify(draft, null, 2));
        } catch (err) {
          toggleError = `Cannot toggle literal display: ${(err as Error).message}`;
        }
        tui.requestRender();
      }

      ruleEditor.onChange = () => tui.requestRender();
      testEditor.onChange = () => tui.requestRender();
      testEditor.onSubmit = () => {};
      ruleEditor.onSubmit = (text) => {
        if (literalHidden && literalValue !== undefined && options.hiddenMarker) {
          try {
            const parsed = JSON.parse(text) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              const draft = parsed as RawConfigRule;
              if (draft.real === options.hiddenMarker) {
                draft.real = literalValue;
                done(JSON.stringify(draft, null, 2));
                return;
              }
            }
          } catch {
            // Return invalid JSON unchanged so the existing validation loop can reopen it.
          }
        }
        done(text);
      };

      return {
        render: (width) => {
          const ruleFocused = focus === "rule";
          const lines = [
            theme.fg("accent", theme.bold(title)),
            "",
            ruleFocused
              ? theme.fg("accent", theme.bold("RULE JSON · focused"))
              : theme.fg("muted", "RULE JSON · Tab to focus"),
          ];
          ruleEditor.focused = focus === "rule";
          testEditor.focused = focus === "test";
          ruleEditor.borderColor = (text) => theme.fg(focus === "rule" ? "accent" : "dim", text);
          testEditor.borderColor = (text) => theme.fg(focus === "test" ? "accent" : "dim", text);
          lines.push(...ruleEditor.render(width));
          lines.push("");
          lines.push(focus === "test"
            ? theme.fg("accent", theme.bold("TEST THIS DRAFT RULE · focused"))
            : theme.fg("muted", "TEST THIS DRAFT RULE · Tab to focus"));
          lines.push(...testEditor.render(width));
          const draftForPreview = (() => {
            const text = ruleEditor.getExpandedText();
            if (!literalHidden || literalValue === undefined || !options.hiddenMarker) return text;
            try {
              const parsed = JSON.parse(text) as RawConfigRule;
              if (parsed.real === options.hiddenMarker) parsed.real = literalValue;
              return JSON.stringify(parsed);
            } catch {
              return text;
            }
          })();
          const preview = previewCandidateRule(testEditor.getExpandedText(), draftForPreview);
          const previewStatus = preview.count > 0 ? `${preview.count} value(s) masked` : preview.attribution;
          lines.push(theme.fg(preview.count > 0 ? "accent" : "muted", `Preview: ${previewStatus}`));
          if (preview.text) {
            for (const line of preview.text.split("\n").slice(0, 3)) lines.push(`  ${line}`);
          }
          if (preview.count > 0) lines.push(theme.fg("muted", `Matched: ${preview.attribution}`));
          for (const warning of preview.warnings.slice(0, 2)) lines.push(theme.fg("warning", `Warning: ${warning}`));
          lines.push("");
          const hints = ["Tab switch area", "Enter save from Rule JSON", "Esc cancel"];
          if (literalValue !== undefined) hints.push(`Ctrl+R ${literalHidden ? "reveal" : "hide"} exact value`);
          lines.push(theme.fg("dim", hints.join(" · ")));
          if (toggleError) lines.push(theme.fg("warning", toggleError));
          return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
        },
        invalidate: () => {
          ruleEditor.invalidate();
          testEditor.invalidate();
        },
        handleInput: (data) => {
          if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) {
            done(undefined);
          } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
            focus = focus === "rule" ? "test" : "rule";
            tui.requestRender();
          } else if (matchesKey(data, Key.ctrl("r")) && literalValue !== undefined) {
            toggleLiteral();
          } else {
            (focus === "rule" ? ruleEditor : testEditor).handleInput(data);
          }
        },
      };
    }, {
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
    });
  }

  async function addConfigRule(
    ctx: ExtensionContext,
    editing?: { configured: ConfiguredMaskingRule; original: RawConfigRule; initial: RawConfigRule },
  ): Promise<void> {
    const projectPath = getProjectConfigPath(ctx.cwd);
    const sources: Array<{ scope: ConfigScope; path: string; label: string }> = [
      { scope: "project", path: projectPath, label: `project · ${projectPath}` },
      { scope: "global", path: GLOBAL_CONFIG_PATH, label: `global · ${GLOBAL_CONFIG_PATH}` },
    ];

    const existingIds = new Map<string, string[]>();
    try {
      for (const source of sources) {
        if (existsSync(source.path)) {
          const raw = await readRawConfigFile(source.path);
          existingIds.set(source.path, raw.rules.flatMap((rule) => typeof rule.id === "string" ? [rule.id] : []));
        } else {
          existingIds.set(source.path, []);
        }
      }
    } catch (err) {
      ctx.ui.notify(`Failed to open Rule Builder: ${(err as Error).message}`, "error");
      return;
    }

    type BuilderType = "Built-in preset template" | "Literal from environment" | "Exact literal value" | "Custom regex";
    type BuilderField = "type" | "scope" | "name" | "description" | "pattern" | "flags" | "env" | "real" | "replacement" | "placeholder" | "json" | "test";
    const builderTypes: readonly BuilderType[] = ["Built-in preset template", "Literal from environment", "Exact literal value", "Custom regex"];
    let selectedSource: (typeof sources)[number] = sources[0]!;
    let selectedType: BuilderType | undefined;
    if (editing) {
      selectedSource = sources.find((source) => source.path === editing.configured.path) ?? sources[0];
      selectedType = typeof editing.initial.pattern === "string" || editing.initial.type === "regex"
        ? "Custom regex"
        : typeof editing.initial.realFromEnv === "string"
          ? "Literal from environment"
          : "Exact literal value";
    } else {
      selectedSource = sources.find((source) => existsSync(source.path)) ?? sources[0];
      const selectedTypeOption = await ctx.ui.select("Rule type", [...builderTypes, "Cancel"]);
      if (!selectedTypeOption || selectedTypeOption === "Cancel") return;
      selectedType = selectedTypeOption as BuilderType;
    }
    if (!selectedType) return;
    let selectedPreset: (typeof MASKING_PRESETS)[number] | undefined;
    if (selectedType === "Built-in preset template") {
      selectedPreset = await ctx.ui.custom<(typeof MASKING_PRESETS)[number] | undefined>((tui, theme, keybindings, done) => {
        let selectedIndex = 0;
        return {
          render: (width) => {
            const selected = MASKING_PRESETS[selectedIndex]!;
            const lines = [theme.fg("accent", theme.bold("Choose a built-in preset")), ""];
            for (let index = 0; index < MASKING_PRESETS.length; index++) {
              const preset = MASKING_PRESETS[index]!;
              const row = `${index === selectedIndex ? "▶" : " "} ${preset.label}`;
              lines.push(index === selectedIndex ? theme.fg("accent", row) : theme.fg("muted", row));
            }
            lines.push("");
            lines.push(theme.fg("dim", `Description: ${selected.description}`));
            lines.push(theme.fg("dim", `Example: ${selected.example}`));
            lines.push("", theme.fg("dim", "↑↓ select · Enter continue · Esc cancel"));
            return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
          },
          invalidate: () => {},
          handleInput: (data) => {
            if (keybindings.matches(data, "tui.select.up")) {
              selectedIndex = (selectedIndex - 1 + MASKING_PRESETS.length) % MASKING_PRESETS.length;
              tui.requestRender();
            } else if (keybindings.matches(data, "tui.select.down")) {
              selectedIndex = (selectedIndex + 1) % MASKING_PRESETS.length;
              tui.requestRender();
            } else if (keybindings.matches(data, "tui.select.confirm")) {
              done(MASKING_PRESETS[selectedIndex]);
            } else if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) {
              done(undefined);
            }
          },
        };
      }, {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
      });
      if (!selectedPreset) return;
    }

    type BuiltRule = { source: typeof sources[number]; rule: RawConfigRule; createdSource: boolean };
    let sourceCreatedDuringBuilder = false;

    async function persistBuilderDraft(source: typeof sources[number], rule: RawConfigRule): Promise<void> {
      if (!existsSync(source.path)) {
        const initial = buildInitialConfig([]);
        try {
          await createJsonFileExclusive(source.path, {
            $schema: initial.$schema,
            version: initial.version,
            rules: [],
          });
          sourceCreatedDuringBuilder = true;
        } catch (err) {
          if (!existsSync(source.path)) throw err;
        }
      }
      const mutations = editing
        ? source.path === editing.configured.path
          ? [{ kind: "replace" as const, path: editing.configured.path, sourceIndex: editing.configured.sourceIndex, id: editing.configured.rule.id, rule }]
          : [
              { kind: "delete" as const, path: editing.configured.path, sourceIndex: editing.configured.sourceIndex, id: editing.configured.rule.id },
              { kind: "append" as const, path: source.path, rule },
            ]
        : [{ kind: "append" as const, path: source.path, rule }];
      const saved = await saveConfigRuleMutations(mutations);
      notifyWarnings(ctx, saved.warnings);
      await reloadConfigNow(ctx);
    }

    const built = await ctx.ui.custom<BuiltRule | undefined>((tui, theme, keybindings, done) => {
      const editorTheme: EditorTheme = {
        borderColor: (text) => theme.fg("accent", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      };
      const makeEditor = (initial = "", singleLine = true) => {
        const editor = new Editor(tui, editorTheme);
        editor.setText(initial);
        let normalizing = false;
        editor.onChange = (text) => {
          if (singleLine && !normalizing) {
            const normalized = text.replace(/\s*[\r\n]+\s*/g, " ");
            if (normalized !== text) {
              normalizing = true;
              editor.setText(normalized);
              normalizing = false;
            }
          }
          saveMessage = "";
          warningSignature = "";
          discardConfirmation = false;
          tui.requestRender();
        };
        return editor;
      };
      let saveMessage = "";
      let warningSignature = "";
      let saving = false;
      let discardConfirmation = false;
      let builderType: BuilderType = selectedType;
      let replacementIndex = editing && editing.initial.placeholder !== undefined && editing.initial.placeholder !== "auto" ? 1 : 0;
      let focusIndex = 0;
      let lastFormField: BuilderField = "type";
      let mode: "form" | "json" = "form";
      let explicitId: string | undefined = editing && typeof editing.initial.id === "string" ? editing.initial.id : undefined;
      let advancedFields: RawConfigRule = editing ? { ...editing.initial } : {};
      const editors = {
        name: makeEditor(selectedPreset?.label ?? (typeof editing?.initial.name === "string" ? editing.initial.name : "")),
        description: makeEditor(selectedPreset ? `${selectedPreset.description} · Example: ${selectedPreset.example}` : (typeof editing?.initial.description === "string" ? editing.initial.description : "")),
        pattern: makeEditor(selectedPreset?.pattern ?? (typeof editing?.initial.pattern === "string" ? editing.initial.pattern : "")),
        flags: makeEditor(selectedPreset?.flags ?? (typeof editing?.initial.flags === "string" ? editing.initial.flags : "")),
        env: makeEditor(typeof editing?.initial.realFromEnv === "string" ? editing.initial.realFromEnv : ""),
        real: makeEditor(typeof editing?.initial.real === "string" ? editing.initial.real : ""),
        placeholder: makeEditor(typeof editing?.initial.placeholder === "string" && editing.initial.placeholder !== "auto" ? editing.initial.placeholder : ""),
        json: makeEditor("", false),
        test: makeEditor("", false),
      };

      const currentSource = () => selectedSource;
      const currentType = () => builderType;
      const editableTypes: readonly BuilderType[] = ["Exact literal value", "Literal from environment", "Custom regex"];
      const typeLabel = (type = currentType()) => type === "Exact literal value"
        ? "exact"
        : type === "Literal from environment"
          ? "env"
          : "regex";
      const changeType = (delta: -1 | 1) => {
        const normalizedType: BuilderType = currentType() === "Built-in preset template" ? "Custom regex" : currentType();
        const currentIndex = editableTypes.indexOf(normalizedType);
        builderType = editableTypes[(currentIndex + delta + editableTypes.length) % editableTypes.length]!;
        saveMessage = "";
        warningSignature = "";
        focusFormField("type");
      };
      const changeSource = (delta: -1 | 1) => {
        const currentIndex = Math.max(0, sources.findIndex((source) => source.path === currentSource().path));
        selectedSource = sources[(currentIndex + delta + sources.length) % sources.length]!;
        saveMessage = "";
        warningSignature = "";
        focusFormField("scope");
      };
      const generatedId = () => explicitId ?? generateUniqueRuleId(
        editors.name.getExpandedText().trim() || "rule",
        existingIds.get(currentSource().path) ?? [],
      );

      function formFields(): BuilderField[] {
        const common: BuilderField[] = [];
        common.push("type", "scope", "name", "description");
        if (currentType() === "Built-in preset template" || currentType() === "Custom regex") common.push("pattern", "flags");
        else if (currentType() === "Literal from environment") {
          common.push("env", "replacement");
          if (replacementIndex === 1) common.push("placeholder");
        }
        else {
          common.push("real", "replacement");
          if (replacementIndex === 1) common.push("placeholder");
        }
        common.push("test");
        return common;
      }
      const fields = () => mode === "json" ? ["json", "test"] as BuilderField[] : formFields();
      const focusedField = () => fields()[Math.max(0, Math.min(focusIndex, fields().length - 1))]!;
      const editorForField = (field: BuilderField): Editor | undefined => field in editors
        ? editors[field as keyof typeof editors]
        : undefined;

      const structuredFields = (): BuilderField[] => formFields().filter((field) => field !== "test");

      function focusFormField(field: BuilderField): void {
        const available = structuredFields();
        const resolved = available.includes(field) ? field : available[0]!;
        lastFormField = resolved;
        focusIndex = formFields().indexOf(resolved);
        tui.requestRender();
      }

      function moveFormField(delta: -1 | 1): void {
        const available = structuredFields();
        const current = Math.max(0, available.indexOf(focusedField()));
        const next = Math.max(0, Math.min(available.length - 1, current + delta));
        focusFormField(available[next]!);
      }

      function switchInputArea(): void {
        if (mode === "json") {
          focusIndex = focusedField() === "test" ? 0 : 1;
        } else if (focusedField() === "test") {
          focusFormField(lastFormField);
          return;
        } else {
          lastFormField = focusedField();
          focusIndex = formFields().indexOf("test");
        }
        tui.requestRender();
      }

      function draftFromForm(): RawConfigRule {
        const name = editors.name.getExpandedText().trim();
        const description = editors.description.getExpandedText().trim();
        const base: RawConfigRule = {
          ...advancedFields,
          id: generatedId(),
          name,
          enabled: typeof advancedFields.enabled === "boolean" ? advancedFields.enabled : true,
        };
        if (description) base.description = description;
        else delete base.description;
        if (currentType() === "Built-in preset template" || currentType() === "Custom regex") {
          const preset = currentType() === "Built-in preset template" ? selectedPreset : undefined;
          const flags = editors.flags.getExpandedText().trim();
          const regexRule: RawConfigRule = {
            ...base,
            type: "regex",
            pattern: editors.pattern.getExpandedText(),
            ...(flags ? { flags } : {}),
            ...(base.preserveStructure === undefined && preset?.preserveStructure
              ? { preserveStructure: { ...preset.preserveStructure } }
              : {}),
          };
          if (!flags) delete regexRule.flags;
          delete regexRule.real;
          delete regexRule.realFromEnv;
          delete regexRule.placeholder;
          delete regexRule.preset;
          return regexRule;
        }
        if (currentType() === "Literal from environment") {
          const envRule: RawConfigRule = {
            ...base,
            realFromEnv: editors.env.getExpandedText().trim(),
            placeholder: replacementIndex === 0 ? "auto" : editors.placeholder.getExpandedText(),
          };
          delete envRule.type;
          delete envRule.pattern;
          delete envRule.flags;
          delete envRule.real;
          delete envRule.preset;
          return envRule;
        }
        const literalRule: RawConfigRule = {
          ...base,
          real: editors.real.getExpandedText(),
          placeholder: replacementIndex === 0 ? "auto" : editors.placeholder.getExpandedText(),
        };
        delete literalRule.pattern;
        delete literalRule.flags;
        delete literalRule.realFromEnv;
        delete literalRule.preset;
        if (literalRule.type !== "literal") delete literalRule.type;
        return literalRule;
      }

      function currentDraft(): { rule?: RawConfigRule; text: string; error?: string } {
        if (mode === "form") {
          const rule = draftFromForm();
          return { rule, text: JSON.stringify(rule, null, 2) };
        }
        const text = editors.json.getExpandedText();
        try {
          const parsed = JSON.parse(text) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Rule must be a JSON object");
          return { rule: parsed as RawConfigRule, text };
        } catch (err) {
          return { text, error: (err as Error).message };
        }
      }

      const draftSignature = (): string => {
        const draft = currentDraft();
        return `${currentSource().path}\n${draft.rule ? JSON.stringify(draft.rule) : draft.text}`;
      };
      const initialDraftSignature = draftSignature();

      function importJsonToForm(): boolean {
        const draft = currentDraft();
        if (!draft.rule) {
          saveMessage = `Cannot switch to form: ${draft.error}`;
          return false;
        }
        const rule = draft.rule;
        const isRegex = rule.type === "regex" || typeof rule.pattern === "string";
        const hasEnv = typeof rule.realFromEnv === "string";
        const hasReal = typeof rule.real === "string";
        if (isRegex && (hasEnv || hasReal)) {
          saveMessage = "Cannot switch to form: regex JSON cannot also contain real or realFromEnv";
          return false;
        }
        if (!isRegex && hasEnv === hasReal) {
          saveMessage = "Cannot switch to form: literal JSON must contain exactly one of real or realFromEnv";
          return false;
        }
        builderType = isRegex ? "Custom regex" : hasEnv ? "Literal from environment" : "Exact literal value";
        advancedFields = { ...rule };
        explicitId = typeof rule.id === "string" ? rule.id : undefined;
        editors.name.setText(typeof rule.name === "string" ? rule.name : "");
        editors.description.setText(typeof rule.description === "string" ? rule.description : "");
        if (currentType() === "Custom regex") {
          editors.pattern.setText(typeof rule.pattern === "string" ? rule.pattern : "");
          editors.flags.setText(typeof rule.flags === "string" ? rule.flags : "");
        } else if (currentType() === "Literal from environment") {
          if (typeof rule.realFromEnv !== "string") {
            saveMessage = "Cannot switch to form: JSON must contain realFromEnv";
            return false;
          }
          editors.env.setText(rule.realFromEnv);
          const placeholder = typeof rule.placeholder === "string" ? rule.placeholder : "auto";
          replacementIndex = placeholder === "auto" ? 0 : 1;
          if (placeholder !== "auto") editors.placeholder.setText(placeholder);
        } else {
          if (typeof rule.real !== "string") {
            saveMessage = "Cannot switch to form: JSON must contain an exact real value";
            return false;
          }
          editors.real.setText(typeof rule.real === "string" ? rule.real : "");
          const placeholder = typeof rule.placeholder === "string" ? rule.placeholder : "auto";
          replacementIndex = placeholder === "auto" ? 0 : 1;
          if (placeholder !== "auto") editors.placeholder.setText(placeholder);
        }
        saveMessage = "";
        return true;
      }

      function padCell(value: string, width: number): string {
        const rendered = truncateToWidth(value, Math.max(1, width));
        return rendered + " ".repeat(Math.max(0, width - visibleWidth(rendered)));
      }

      function valueWithCursor(editor: Editor, width: number): string {
        const text = editor.getExpandedText().replace(/[\r\n]+/g, " ");
        const cursor = Math.max(0, Math.min(editor.getCursor().col, text.length));
        const marked = `${text.slice(0, cursor)}▌${text.slice(cursor)}`;
        const cursorColumn = visibleWidth(text.slice(0, cursor));
        const startColumn = Math.max(0, cursorColumn - Math.max(1, width - 3));
        const prefix = startColumn > 0 ? "…" : "";
        return prefix + sliceByColumn(marked, startColumn, Math.max(1, width - visibleWidth(prefix)));
      }

      type RenderedFieldDetail = {
        label: string;
        value: string;
        description: string;
        cursorEditor?: Editor;
        selector?: boolean;
      };
      const renderedFieldDetails = new Map<BuilderField, RenderedFieldDetail>();

      function renderFieldRow(
        lines: string[],
        field: BuilderField | undefined,
        label: string,
        value: string,
        width: number,
        description: string,
        options: { cursorEditor?: Editor; selector?: boolean } = {},
      ): void {
        const focused = field !== undefined && focusedField() === field;
        const marker = focused ? "▶" : " ";
        const labelWidth = 14;
        const rawValue = options.selector ? `‹ ${value} ›` : value || "—";
        const valueWidth = Math.max(1, width - (2 + labelWidth + 2));
        const displayedValue = focused && options.cursorEditor
          ? valueWithCursor(options.cursorEditor, valueWidth)
          : truncateToWidth(rawValue, valueWidth);
        const summary = `${marker} ${padCell(label, labelWidth)}  ${displayedValue}`;
        lines.push(theme.fg(focused ? "accent" : "muted", truncateToWidth(summary, Math.max(1, width))));
        if (field !== undefined) {
          renderedFieldDetails.set(field, { label, value, description, ...options });
        }
      }

      function renderActiveFieldDescription(lines: string[], width: number): void {
        const detail = renderedFieldDetails.get(focusedField() === "test" ? lastFormField : focusedField());
        if (!detail) return;
        lines.push(theme.fg("dim", truncateToWidth(detail.description, Math.max(1, width))));
      }

      function renderSelector(lines: string[], field: BuilderField, label: string, value: string, width: number, description: string): void {
        renderFieldRow(lines, field, label, value, width, description, { selector: true });
      }

      function renderSingleLineField(lines: string[], field: BuilderField, label: string, editor: Editor, width: number, description: string): void {
        const focused = focusedField() === field;
        editor.focused = focused;
        renderFieldRow(lines, field, label, editor.getExpandedText(), width, description, { cursorEditor: editor });
      }

      function renderMultilineEditor(lines: string[], field: BuilderField, editor: Editor, width: number): void {
        const focused = focusedField() === field;
        editor.focused = focused;
        editor.borderColor = (text) => theme.fg(focused ? "accent" : "dim", text);
        lines.push(...editor.render(width));
      }

      async function attemptSave(): Promise<void> {
        const draft = currentDraft();
        if (!draft.rule) {
          saveMessage = `Cannot save: ${draft.error}`;
          tui.requestRender();
          return;
        }
        if (mode === "form" && currentType() === "Literal from environment" && !editors.env.getExpandedText().trim()) {
          saveMessage = "Cannot save: enter an environment variable name, for example PROD_API_KEY";
          focusFormField("env");
          return;
        }
        if (mode === "form" && (currentType() === "Literal from environment" || currentType() === "Exact literal value")
          && replacementIndex === 1 && !editors.placeholder.getExpandedText()) {
          saveMessage = "Cannot save: enter a custom placeholder or choose Generate automatically";
          focusFormField("placeholder");
          return;
        }
        let warnings: string[];
        try {
          warnings = validateRawConfigRule(draft.rule);
        } catch (err) {
          saveMessage = `Cannot save: ${(err as Error).message}`;
          tui.requestRender();
          return;
        }
        const id = typeof draft.rule.id === "string" ? draft.rule.id : "";
        const isOriginalEntry = editing
          && currentSource().path === editing.configured.path
          && id === editing.configured.rule.id;
        if ((existingIds.get(currentSource().path) ?? []).includes(id) && !isOriginalEntry) {
          saveMessage = `Cannot save: rule ID [${id}] already exists in ${currentSource().scope}`;
          tui.requestRender();
          return;
        }
        const signature = warnings.join("\n");
        if (warnings.length > 0 && warningSignature !== signature) {
          warningSignature = signature;
          saveMessage = "Warnings are shown below · press Enter again to save anyway";
          tui.requestRender();
          return;
        }
        saving = true;
        saveMessage = "Saving…";
        tui.requestRender();
        try {
          await persistBuilderDraft(currentSource(), draft.rule);
          done({ source: currentSource(), rule: draft.rule, createdSource: sourceCreatedDuringBuilder });
        } catch (err) {
          saving = false;
          saveMessage = `Cannot save: ${(err as Error).message} · draft retained`;
          tui.requestRender();
        }
      }

      return {
        render: (width) => {
          const draft = currentDraft();
          renderedFieldDetails.clear();
          const editorFocused = focusedField() !== "test";
          const editorDivider = theme.fg(editorFocused ? "accent" : "dim", "─".repeat(Math.max(1, width)));
          const editorTitle = mode === "form" ? "RULE FIELDS" : "RULE JSON";
          const lines: string[] = [
            theme.fg("accent", theme.bold(`${editing ? "Edit" : "New"} masking rule · Rule Builder`)),
            theme.fg("muted", `${currentSource().scope} · ${typeLabel()}${currentType() === "Built-in preset template" && selectedPreset ? ` · ${selectedPreset.label}` : ""} · ${mode === "form" ? "Structured fields" : "Advanced JSON"}`),
            theme.fg("dim", currentSource().path),
            "",
            editorFocused
              ? theme.fg("accent", theme.bold(`${editorTitle} · focused`))
              : theme.fg("muted", `${editorTitle} · Tab to focus`),
          ];
          if (mode === "form") {
            lines.push(editorDivider);
            const fieldRowsStart = lines.length;
            renderSelector(lines, "type", "Rule type", typeLabel(), width, "←/→ or Space switches between exact, environment, and regular-expression rules");
            renderSelector(lines, "scope", "Scope", currentSource().scope, width, "←/→ or Space moves the rule between project and global configuration");
            renderSingleLineField(lines, "name", "Name", editors.name, width, "Required display name");
            renderFieldRow(lines, undefined, "Generated ID", generatedId(), width, "Read-only · generated from name");
            renderSingleLineField(lines, "description", "Description", editors.description, width, "Optional longer explanation");
            if (currentType() === "Built-in preset template" || currentType() === "Custom regex") {
              renderSingleLineField(lines, "pattern", "Pattern", editors.pattern, width, "JavaScript regex without /.../ · e.g. \\btoken_[A-Za-z0-9]{24}\\b");
              renderSingleLineField(lines, "flags", "Flags", editors.flags, width, "Optional: i case-insensitive · m multiline anchors · s dot matches newline · g automatic");
            } else if (currentType() === "Literal from environment") {
              renderSingleLineField(lines, "env", "Environment", editors.env, width, "Variable name only, for example PROD_API_KEY (do not enter $ or the secret value)");
              renderSelector(lines, "replacement", "Replacement", replacementIndex === 0 ? "Generate automatically" : "Exact custom replacement", width, "←/→ or Space changes the replacement mode");
              if (replacementIndex === 1) renderSingleLineField(lines, "placeholder", "Placeholder", editors.placeholder, width, "Exact replacement shown to the model");
            } else {
              renderSingleLineField(lines, "real", "Exact value", editors.real, width, "Stored in plaintext in the config");
              renderSelector(lines, "replacement", "Replacement", replacementIndex === 0 ? "Generate automatically" : "Exact custom replacement", width, "←/→ or Space changes the replacement mode");
              if (replacementIndex === 1) renderSingleLineField(lines, "placeholder", "Placeholder", editors.placeholder, width, "Exact replacement shown to the model");
            }
            const fixedFieldRowCount = 8;
            while (lines.length - fieldRowsStart < fixedFieldRowCount) lines.push("");
            lines.push(editorDivider);
            renderActiveFieldDescription(lines, width);
          } else {
            lines.push(theme.fg("dim", "Edit the complete rule object as multiline JSON"));
            renderMultilineEditor(lines, "json", editors.json, width);
          }
          lines.push("");
          lines.push(focusedField() === "test"
            ? theme.fg("accent", theme.bold("TEST THIS RULE · focused"))
            : theme.fg("muted", "TEST THIS RULE · Tab to focus"));
          renderMultilineEditor(lines, "test", editors.test, width);
          const preview = previewCandidateRule(editors.test.getExpandedText(), draft.text);
          const status = preview.count > 0 ? `${preview.count} value(s) masked` : preview.attribution;
          lines.push(theme.fg(preview.count > 0 ? "accent" : "muted", `Preview: ${status}`));
          for (const line of preview.text.split("\n").slice(0, 2)) if (line) lines.push(`  ${line}`);
          if (preview.count > 0) lines.push(theme.fg("muted", `Matched: ${preview.attribution}`));
          for (const warning of preview.warnings.slice(0, 3)) lines.push(theme.fg("warning", `Warning: ${warning}`));
          if (saveMessage) lines.push(theme.fg(saveMessage.startsWith("Cannot") ? "warning" : "accent", saveMessage));
          lines.push("", theme.fg("dim", "↑↓ fields · Tab form/test · ←→ or Space change selection · F2 form/JSON · Enter save · Esc cancel"));
          return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
        },
        invalidate: () => Object.values(editors).forEach((editor) => editor.invalidate()),
        handleInput: (data) => {
          if (saving) return;
          if (discardConfirmation) {
            if (matchesKey(data, "y") || keybindings.matches(data, "tui.select.confirm")) {
              done(undefined);
            } else if (
              matchesKey(data, "n")
              || keybindings.matches(data, "tui.select.cancel")
              || keybindings.matches(data, "app.interrupt")
            ) {
              discardConfirmation = false;
              saveMessage = "Editing resumed";
              tui.requestRender();
            }
            return;
          }
          if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) {
            if (draftSignature() === initialDraftSignature) done(undefined);
            else {
              discardConfirmation = true;
              saveMessage = "Discard unsaved changes? Y / Enter discard · N / Esc continue editing";
              tui.requestRender();
            }
            return;
          }
          if (matchesKey(data, Key.f2)) {
            if (mode === "form") {
              editors.json.setText(JSON.stringify(draftFromForm(), null, 2));
              mode = "json";
              focusIndex = 0;
            } else if (importJsonToForm()) {
              mode = "form";
              focusIndex = 0;
            }
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
            switchInputArea();
            return;
          }

          const field = focusedField();
          if (matchesKey(data, Key.enter)) {
            if (field === "test") {
              // Editor.submitValue() clears its contents before onSubmit. The
              // embedded test area is multiline, so Enter must be handled as a
              // newline instead of submitting (and clearing) the editor.
              editors.test.handleInput("\n");
            } else {
              // Save before forwarding Enter to Editor: Editor clears its
              // contents before invoking onSubmit, which would make the form
              // draft observe an empty current field.
              void attemptSave();
            }
            return;
          }
          if (mode === "form" && field !== "test" && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
            moveFormField(matchesKey(data, Key.up) ? -1 : 1);
            return;
          }
          const selectorDirection = matchesKey(data, Key.left) ? -1
            : matchesKey(data, Key.right) || matchesKey(data, Key.space) ? 1
            : 0;
          if (selectorDirection !== 0) {
            if (field === "type") {
              changeType(selectorDirection < 0 ? -1 : 1);
            } else if (field === "scope") {
              changeSource(selectorDirection < 0 ? -1 : 1);
            } else if (field === "replacement") {
              replacementIndex = replacementIndex === 0 ? 1 : 0;
              focusIndex = Math.min(focusIndex, fields().length - 1);
            } else {
              editorForField(field)?.handleInput(data);
              return;
            }
            saveMessage = "";
            warningSignature = "";
            tui.requestRender();
            return;
          }
          editorForField(field)?.handleInput(data);
        },
      };
    }, {
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
    });

    if (!built) return;
    const id = String(built.rule.id);
    const action = editing && built.source.path !== editing.configured.path ? "Moved and updated" : editing ? "Updated" : "Added";
    ctx.ui.notify(`${action} rule [${id}] in ${built.source.scope} config`, "info");
    if (built.createdSource) {
      ctx.ui.notify(
        `Created minimal ${built.source.scope} config: ${built.source.path}${built.source.scope === "project" ? " · this file may be tracked by Git" : ""}`,
        built.source.scope === "project" ? "warning" : "info",
      );
      if (built.source.scope === "project") {
        const addIgnore = await ctx.ui.confirm(
          "Exclude project masking config from Git?",
          `Add .pi/pi-data-masking/masking.config.json to ${ctx.cwd}/.gitignore?\n\nChoose Yes if this config may contain exact literal values.`,
        );
        if (addIgnore) {
          try {
            const added = await ensureProjectConfigGitignored(ctx.cwd);
            ctx.ui.notify(
              added ? "Added project masking config to .gitignore" : "Project masking config is already ignored",
              "info",
            );
          } catch (err) {
            ctx.ui.notify(`Failed to update .gitignore: ${(err as Error).message}`, "error");
          }
        }
      }
    }
  }

  async function editConfigRule(ctx: ExtensionContext, configured: ConfiguredMaskingRule): Promise<void> {
    try {
      const data = await readRawConfigFile(configured.path);
      const original = data.rules[configured.sourceIndex];
      if (!original || typeof original !== "object" || original.id !== configured.rule.id) {
        throw new Error("source position changed; reopen /masking");
      }
      const initial = configured.sourceKind === "preset" ? { ...configured.rule } : { ...original };
      await addConfigRule(ctx, { configured, original, initial });
    } catch (err) {
      ctx.ui.notify(`Failed to edit rule: ${(err as Error).message}`, "error");
    }
  }

  async function deleteConfigRule(ctx: ExtensionContext, configured: ConfiguredMaskingRule): Promise<void> {
    if (!await ctx.ui.confirm(
      "Delete masking rule?",
      `Delete "${configuredRuleDisplayName(configured)}" [${configured.rule.id}] from the ${configured.scope} config?\nThis may expose matching values in future requests and cannot retract earlier model context.`,
    )) return;
    if (await saveStructuralChanges(ctx, [{
      kind: "delete",
      path: configured.path,
      sourceIndex: configured.sourceIndex,
      id: configured.rule.id,
    }])) ctx.ui.notify(`Deleted rule "${configuredRuleDisplayName(configured)}" [${configured.rule.id}]`, "info");
  }

  async function showRuleConfigurationHelp(ctx: ExtensionContext): Promise<void> {
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => ({
      render: (width) => {
        const lines = [
          theme.fg("accent", theme.bold("How to configure masking rules")),
          "",
          theme.fg("accent", "Literal from environment"),
          "Use an environment-variable name; its value is resolved in memory and is not stored in JSON.",
          "",
          theme.fg("accent", "Exact literal value"),
          "Match one exact string. Choose an automatic or custom replacement. Explicit editing shows the stored value.",
          "",
          theme.fg("accent", "Built-in preset"),
          "Choose a documented template. The complete regex is written to the config so it can be customized.",
          "",
          theme.fg("accent", "Custom regex"),
          "Write JavaScript regex source without surrounding /.../.",
          "Example: \\bnpm_[A-Za-z0-9]{36}\\b matches npm_ followed by exactly 36 ASCII letters/digits.",
          "\\b is a word boundary; [A-Za-z0-9] is one allowed character; {36} repeats it exactly 36 times.",
          "Optional flags include i (case-insensitive), m (multiline), and s (dot matches newline); g is automatic.",
          "Without capture groups the whole match is masked; with groups, only captured portions are masked.",
          "",
          theme.fg("muted", "Rules run from top to bottom. Prefer narrow patterns and use the embedded test area before relying on them."),
          "",
          theme.fg("dim", "Enter / Esc / H close help"),
        ];
        return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
      },
      invalidate: () => {},
      handleInput: (data) => {
        if (
          keybindings.matches(data, "tui.select.confirm")
          || keybindings.matches(data, "tui.select.cancel")
          || keybindings.matches(data, "app.interrupt")
          || matchesKey(data, "h")
        ) done();
      },
    }), {
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
    });
  }

  async function moveConfigRule(
    ctx: ExtensionContext,
    configured: ConfiguredMaskingRule,
    direction: -1 | 1,
    notifySuccess = true,
  ): Promise<boolean> {
    const sameSource = config.configuredRules
      .filter((candidate) => candidate.path === configured.path)
      .sort((a, b) => a.sourceIndex - b.sourceIndex);
    const index = sameSource.findIndex((candidate) => configuredRuleKey(candidate) === configuredRuleKey(configured));
    const target = sameSource[index + direction];
    if (!target) {
      ctx.ui.notify(`Rule is already at the ${direction < 0 ? "top" : "bottom"} of its ${configured.scope} scope`, "info");
      return false;
    }
    const saved = await saveStructuralChanges(ctx, [{
      kind: "move",
      path: configured.path,
      sourceIndex: configured.sourceIndex,
      id: configured.rule.id,
      targetIndex: target.sourceIndex,
      targetId: target.rule.id,
    }]);
    if (saved && notifySuccess) ctx.ui.notify(`Moved rule "${configuredRuleDisplayName(configured)}" [${configured.rule.id}] ${direction < 0 ? "up" : "down"}`, "info");
    return saved;
  }

  async function toggleConfigRule(
    ctx: ExtensionContext,
    configured: ConfiguredMaskingRule,
    notifySuccess = true,
  ): Promise<boolean> {
    const enabled = !configured.enabled;
    try {
      await saveRuleEnabledChanges([{
        path: configured.path,
        sourceIndex: configured.sourceIndex,
        id: configured.rule.id,
        enabled,
      }]);
      await reloadConfigNow(ctx);
      const state = enabled && !configured.available
        ? `enabled in config but waiting for environment variable ${configured.realFromEnv}`
        : enabled ? "enabled immediately" : "disabled immediately";
      if (notifySuccess) {
        ctx.ui.notify(
          `Rule "${configuredRuleDisplayName(configured)}" [${configured.rule.id}] ${state}. ${enabled ? "Changes affect future requests only" : "Matching values may be exposed in future requests"}; earlier context cannot be retracted. Consider a new session for a clean boundary.`,
          enabled ? "info" : "warning",
        );
      }
      return true;
    } catch (err) {
      ctx.ui.notify(`Failed to toggle rule: ${(err as Error).message}`, "error");
      return false;
    }
  }

  async function applyBatchRuleState(ctx: ExtensionContext, changes: RuleEnabledChange[]): Promise<void> {
    if (changes.length === 0) return;
    const disabling = changes.filter((change) => !change.enabled).length;
    if (!await ctx.ui.confirm(
      "Apply batch rule changes?",
      `${changes.length - disabling} rule(s) will be enabled and ${disabling} disabled.\nDisabled rules may expose matching values in future requests. Earlier context cannot be retracted.`,
    )) return;
    try {
      await saveRuleEnabledChanges(changes);
      await reloadConfigNow(ctx);
      ctx.ui.notify(`Applied ${changes.length} rule state change(s) immediately`, "info");
    } catch (err) {
      ctx.ui.notify(`Failed to update rules: ${(err as Error).message}`, "error");
    }
  }

  async function importConfigRules(ctx: ExtensionContext): Promise<void> {
    const sourceInput = (await ctx.ui.input("Import rules from JSON file", "path/to/masking.config.json"))?.trim();
    if (!sourceInput) return;
    const importPath = resolve(ctx.cwd, sourceInput);
    const target = await chooseExistingSource(ctx, "Import into which config?");
    if (!target) return;
    try {
      const imported = await readRawConfigFile(importPath);
      if (imported._redactedExport !== undefined) throw new Error("redacted exports cannot be imported as runnable rules");
      if (imported.rules.length === 0) {
        ctx.ui.notify("Import file contains no rules", "info");
        return;
      }
      const ids = imported.rules.map((rule) => typeof rule?.id === "string" ? rule.id : "<invalid>");
      const literalCount = imported.rules.filter((rule) => typeof rule?.real === "string").length;
      const riskWarnings = imported.rules.flatMap((rule) => validateRawConfigRule(rule));
      if (!await ctx.ui.confirm(
        "Import masking rules?",
        [`Source: ${importPath}`, `Target: ${target.path}`, `Rules (${ids.length}): ${ids.join(", ")}`, `${literalCount} direct literal value(s) will be copied without being displayed.`, ...riskWarnings.map((warning) => `Warning: ${warning}`)].join("\n"),
      )) return;
      const mutations = imported.rules.map((rule) => ({ kind: "append" as const, path: target.path, rule }));
      if (await saveStructuralChanges(ctx, mutations)) ctx.ui.notify(`Imported ${ids.length} rule(s) into ${target.scope} config`, "info");
    } catch (err) {
      ctx.ui.notify(`Failed to import rules: ${(err as Error).message}`, "error");
    }
  }

  async function exportConfigRules(ctx: ExtensionContext): Promise<void> {
    const source = await chooseExistingSource(ctx, "Export which config?");
    if (!source) return;
    const destinationInput = (await ctx.ui.input("Redacted export destination", "masking.config.redacted.json"))?.trim();
    if (!destinationInput) return;
    const destination = resolve(ctx.cwd, destinationInput);
    try {
      const redacted = redactRawConfigFile(await readRawConfigFile(source.path));
      if (!await ctx.ui.confirm(
        "Create redacted export?",
        `Destination: ${destination}\nDirect literal values will be replaced. The export cannot be imported as a runnable configuration and will not overwrite an existing file.`,
      )) return;
      await createJsonFileExclusive(destination, redacted);
      ctx.ui.notify(`Created redacted export: ${destination}`, "info");
    } catch (err) {
      ctx.ui.notify(`Failed to export config: ${(err as Error).message}`, "error");
    }
  }

  async function openMaskingConfig(ctx: ExtensionContext): Promise<void> {
    const filters = ["all", "enabled", "disabled", "project", "global", "literal", "regex", "preset"] as const;
    let filterIndex = 0;
    let searchQuery = "";
    let selectedRuleKey: string | undefined;
    let revealedRuleKey: string | undefined;
    let homeTestText = "";
    let homeFocus: "rules" | "test" = "rules";
    for (;;) {
    const configuredRules = config.configuredRules;
    type ScreenAction =
      | { kind: "batch"; changes: RuleEnabledChange[] }
      | { kind: "edit"; rule: ConfiguredMaskingRule }
      | { kind: "delete"; rule: ConfiguredMaskingRule }
      | { kind: "add" | "import" | "export" | "help" };
    const result = await ctx.ui.custom<ScreenAction | undefined>((tui, theme, keybindings, done) => {
      let screenRules = configuredRules;
      let selectedIndex = 0;
      let scrollOffset = 0;
      let searchMode = false;
      let mutationInProgress = false;
      let mutationMessage = "";
      const testEditorTheme: EditorTheme = {
        borderColor: (text) => theme.fg("accent", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      };
      const testEditor = new Editor(tui, testEditorTheme);
      testEditor.setText(homeTestText);
      testEditor.onSubmit = () => {};
      testEditor.onChange = (text) => {
        homeTestText = text;
        tui.requestRender();
      };

      function visibleRules(): ConfiguredMaskingRule[] {
        const filter = filters[filterIndex]!;
        const query = searchQuery.toLowerCase();
        return screenRules.filter((configured) => {
          const matchesFilter = filter === "all"
            || (filter === "enabled" && configured.enabled)
            || (filter === "disabled" && !configured.enabled)
            || filter === configured.scope
            || filter === configured.sourceKind;
          if (!matchesFilter) return false;
          if (!query) return true;
          return [
            configured.rule.id,
            configured.rule.name,
            configured.rule.description,
            configured.presetName,
            configured.realFromEnv,
            configured.scope,
            configured.sourceKind,
          ].some((value) => value?.toLowerCase().includes(query));
        });
      }

      if (selectedRuleKey) {
        const retainedIndex = visibleRules().findIndex(
          (configured) => configuredRuleStableKey(configured) === selectedRuleKey,
        );
        if (retainedIndex >= 0) selectedIndex = retainedIndex;
      }

      function refresh(): void {
        const visible = visibleRules();
        selectedIndex = Math.max(0, Math.min(selectedIndex, visible.length));
        tui.requestRender();
      }

      function keepSelectedVisible(listHeight: number, visibleCount: number): void {
        if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
        if (selectedIndex >= scrollOffset + listHeight) scrollOffset = selectedIndex - listHeight + 1;
        scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, visibleCount - listHeight)));
      }

      function retainSelectedRule(stableKey: string): void {
        selectedRuleKey = stableKey;
        const retainedIndex = visibleRules().findIndex(
          (configured) => configuredRuleStableKey(configured) === stableKey,
        );
        if (retainedIndex >= 0) selectedIndex = retainedIndex;
        else selectedIndex = Math.max(0, Math.min(selectedIndex, visibleRules().length));
      }

      async function toggleRuleInPlace(selected: ConfiguredMaskingRule): Promise<void> {
        const stableKey = configuredRuleStableKey(selected);
        const enabling = !selected.enabled;
        mutationInProgress = true;
        mutationMessage = "Saving…";
        tui.requestRender();
        const saved = await toggleConfigRule(ctx, selected, false);
        if (saved) {
          screenRules = config.configuredRules;
          retainSelectedRule(stableKey);
          mutationMessage = enabling
            ? "Enabled · affects future requests"
            : "Disabled · future matches may be exposed";
        } else {
          mutationMessage = "Save failed · no changes applied";
        }
        mutationInProgress = false;
        refresh();
      }

      async function moveRuleInPlace(selected: ConfiguredMaskingRule, direction: -1 | 1): Promise<void> {
        const stableKey = configuredRuleStableKey(selected);
        mutationInProgress = true;
        mutationMessage = "Saving order…";
        tui.requestRender();
        const saved = await moveConfigRule(ctx, selected, direction, false);
        if (saved) {
          screenRules = config.configuredRules;
          retainSelectedRule(stableKey);
          mutationMessage = "Order saved";
        } else {
          mutationMessage = "Order unchanged";
        }
        mutationInProgress = false;
        refresh();
      }

      return {
        render: (width) => {
          const visibleRulesNow = visibleRules();
          const active = screenRules.filter((configured) => configured.enabled && configured.available).length;
          const rulesDivider = theme.fg(homeFocus === "rules" ? "accent" : "dim", "─".repeat(Math.max(1, width)));
          const lines: string[] = [
            theme.fg("accent", theme.bold(`Masking configuration${mutationMessage ? ` · ${mutationMessage}` : ""}`)),
            theme.fg("muted", `${active} active / ${screenRules.length} configured · filter: ${filters[filterIndex]}${searchQuery ? ` · search: ${searchQuery}` : ""}`),
            "",
            homeFocus === "rules"
              ? theme.fg("accent", theme.bold("RULES · focused"))
              : theme.fg("muted", "RULES · Tab to focus"),
            rulesDivider,
          ];

          if (screenRules.length === 0) {
            lines.push(theme.fg("warning", "No rules are configured."));
            lines.push(theme.fg("muted", "Create or edit one of these files:"));
            lines.push(theme.fg("dim", `  project  ${getProjectConfigPath(ctx.cwd)}`));
            lines.push(theme.fg("dim", `  global   ${GLOBAL_CONFIG_PATH}`));
            lines.push("");
            lines.push(theme.fg("accent", "Choose Add new rule; its Scope creates the project or global config when saved."));
            lines.push("", theme.fg("accent", "▶ ＋ Add new rule"));
          } else if (visibleRulesNow.length === 0) {
            lines.push(theme.fg("warning", "No rules match the current filter/search."));
            lines.push("", theme.fg("accent", "▶ ＋ Add new rule"));
          } else {
            const header = `  ${"STATE".padEnd(6)} ${"ORDER".padStart(5)}  ${"SCOPE".padEnd(7)}  ${"TYPE".padEnd(7)}  NAME`;
            lines.push(theme.fg("dim", truncateToWidth(header, Math.max(1, width))));
            const reservedRows = 24;
            const rowCount = visibleRulesNow.length + 1;
            const listHeight = Math.max(3, Math.min(rowCount, tui.terminal.rows - reservedRows));
            keepSelectedVisible(listHeight, rowCount);
            const endIndex = Math.min(rowCount, scrollOffset + listHeight);
            for (let absoluteIndex = scrollOffset; absoluteIndex < endIndex; absoluteIndex++) {
              if (absoluteIndex === visibleRulesNow.length) {
                const addRow = `${absoluteIndex === selectedIndex ? "▶" : " "} ＋ Add new rule`;
                lines.push(absoluteIndex === selectedIndex ? theme.fg("accent", addRow) : theme.fg("muted", addRow));
                continue;
              }
              const configured = visibleRulesNow[absoluteIndex]!;
              const enabled = configured.enabled;
              const cursor = absoluteIndex === selectedIndex ? "›" : " ";
              const stateLabel = !enabled ? "OFF" : configured.available ? "ON" : "WAIT";
              const statePadding = Math.max(0, 4 - stateLabel.length);
              const state = `${" ".repeat(Math.floor(statePadding / 2))}${stateLabel}${" ".repeat(Math.ceil(statePadding / 2))}`;
              const priority = screenRules.indexOf(configured) + 1;
              const displayName = configuredRuleDisplayName(configured);
              const text = `${cursor} [${state}] ${String(priority).padStart(5)}  ${configured.scope.padEnd(7)}  ${configuredRuleKind(configured).padEnd(7)}  ${displayName}`;
              const clipped = truncateToWidth(text, Math.max(1, width));
              lines.push(absoluteIndex === selectedIndex
                ? theme.fg("accent", clipped)
                : enabled ? clipped : theme.fg("dim", clipped));
            }

          }

          lines.push(rulesDivider);
          if (screenRules.length > 0 && visibleRulesNow.length > 0) {
            // Keep details outside the list dividers and reserve a fixed block
            // so exact/env/regex/preset rows never move the test panel.
            const detailRowCount = 6;
            const selected = visibleRulesNow[selectedIndex];
            const details = selected
              ? configuredRuleDetail(
                  selected,
                  revealedRuleKey === configuredRuleStableKey(selected),
                )
              : [];
            for (let index = 0; index < detailRowCount; index++) {
              const detail = details[index];
              lines.push(detail
                ? truncateToWidth(theme.fg("muted", detail), Math.max(1, width))
                : "");
            }
          }
          lines.push("");
          if (searchMode) {
            lines.push(theme.fg("accent", `Search: ${searchQuery}▌`));
            lines.push(theme.fg("dim", "Type to search · Backspace delete · Enter accept · Esc clear"));
          } else {
            const showTestPanel = tui.terminal.rows >= 26 || homeFocus === "test" || homeTestText.length > 0;
            if (showTestPanel) {
              testEditor.focused = homeFocus === "test";
              testEditor.borderColor = (text) => theme.fg(homeFocus === "test" ? "accent" : "dim", text);
              lines.push(homeFocus === "test"
                ? theme.fg("accent", theme.bold(`TEST ACTIVE RULES · focused${config.enabled ? "" : " · masking is off; preview only"}`))
                : theme.fg("muted", `TEST ACTIVE RULES · Tab to focus${config.enabled ? "" : " · masking is off; preview only"}`));
              lines.push(...testEditor.render(width));
              const preview = previewActiveRules(testEditor.getExpandedText());
              const status = preview.count > 0 ? `${preview.count} value(s) masked` : preview.attribution;
              lines.push(theme.fg(preview.count > 0 ? "accent" : "muted", `Preview: ${status}`));
              for (const line of preview.text.split("\n").slice(0, 2)) {
                if (line) lines.push(`  ${line}`);
              }
              if (preview.count > 0) lines.push(theme.fg("muted", `Matched: ${preview.attribution}`));
            } else {
              lines.push(theme.fg("muted", "TEST ACTIVE RULES · Tab to focus"));
            }
            lines.push("");
            lines.push(theme.fg("dim", "↑↓ browse · Space immediate toggle · Enter edit/add · A add · D / Delete remove · Ctrl+↑↓ reorder"));
            lines.push(theme.fg("dim", "Tab switch area · R reveal value · F filter · / search · B batch · H help · I import · X export · Esc close"));
          }
          return [...lines, ...Array(Math.max(0, tui.terminal.rows - lines.length)).fill("")];
        },
        invalidate: () => {},
        handleInput: (data) => {
          if (mutationInProgress) return;
          mutationMessage = "";
          if (searchMode) {
            if (matchesKey(data, Key.enter)) {
              searchMode = false;
              refresh();
            } else if (matchesKey(data, Key.escape)) {
              searchMode = false;
              searchQuery = "";
              refresh();
            } else if (matchesKey(data, Key.backspace)) {
              searchQuery = searchQuery.slice(0, -1);
              refresh();
            } else {
              const printable = decodeKittyPrintable(data) ?? (data.length === 1 ? data : undefined);
              if (printable && printable.length === 1 && printable >= " ") {
                searchQuery += printable;
                refresh();
              }
            }
            return;
          }

          if (homeFocus === "test") {
            if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
              homeFocus = "rules";
              refresh();
            } else if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) {
              homeFocus = "rules";
              refresh();
            } else {
              testEditor.handleInput(data);
            }
            return;
          }
          if (matchesKey(data, Key.tab)) {
            homeFocus = "test";
            refresh();
            return;
          }

          const visible = visibleRules();
          const selected = visible[selectedIndex];
          if (matchesKey(data, Key.ctrl(Key.up)) && selected) {
            void moveRuleInPlace(selected, -1);
            return;
          }
          if (matchesKey(data, Key.ctrl(Key.down)) && selected) {
            void moveRuleInPlace(selected, 1);
            return;
          }
          if (keybindings.matches(data, "tui.select.up")) {
            selectedIndex = Math.max(0, selectedIndex - 1);
            revealedRuleKey = undefined;
            refresh();
            return;
          }
          if (keybindings.matches(data, "tui.select.down")) {
            selectedIndex = Math.min(visible.length, selectedIndex + 1);
            revealedRuleKey = undefined;
            refresh();
            return;
          }
          if (matchesKey(data, Key.space) && selected) {
            void toggleRuleInPlace(selected);
            return;
          }
          if (keybindings.matches(data, "tui.select.confirm")) {
            done(selected ? { kind: "edit", rule: selected } : { kind: "add" });
            return;
          }
          if ((matchesKey(data, "d") || matchesKey(data, Key.delete)) && selected) {
            const retained = visible[selectedIndex + 1] ?? visible[selectedIndex - 1];
            selectedRuleKey = retained ? configuredRuleStableKey(retained) : undefined;
            done({ kind: "delete", rule: selected });
            return;
          }
          if (matchesKey(data, "a")) return void done({ kind: "add" });
          if (matchesKey(data, "r") && selected && configuredRuleKind(selected) !== "regex") {
            const key = configuredRuleStableKey(selected);
            revealedRuleKey = revealedRuleKey === key ? undefined : key;
            refresh();
            return;
          }
          if (matchesKey(data, "i")) return void done({ kind: "import" });
          if (matchesKey(data, "x")) return void done({ kind: "export" });
          if (matchesKey(data, "h")) return void done({ kind: "help" });
          if (matchesKey(data, "f")) {
            filterIndex = (filterIndex + 1) % filters.length;
            selectedIndex = 0;
            scrollOffset = 0;
            refresh();
            return;
          }
          if (matchesKey(data, Key.slash)) {
            searchMode = true;
            refresh();
            return;
          }
          if (matchesKey(data, "b") && visible.length > 0) {
            const enabled = visible.some((configured) => !configured.enabled);
            const changes = visible.filter((configured) => configured.enabled !== enabled).map((configured) => ({
              path: configured.path,
              sourceIndex: configured.sourceIndex,
              id: configured.rule.id,
              enabled,
            }));
            done({ kind: "batch", changes });
            return;
          }
          if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) {
            done(undefined);
          }
        },
      };
    }, {
      overlay: true,
      overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
    });

    if (!result) return;
    if (result.kind === "batch") await applyBatchRuleState(ctx, result.changes);
    else if (result.kind === "edit") await editConfigRule(ctx, result.rule);
    else if (result.kind === "delete") await deleteConfigRule(ctx, result.rule);
    else if (result.kind === "add") await addConfigRule(ctx);
    else if (result.kind === "help") await showRuleConfigurationHelp(ctx);
    else if (result.kind === "import") await importConfigRules(ctx);
    else await exportConfigRules(ctx);
    }
  }

  pi.registerCommand("masking", {
    description: "View and configure masking rules (real values stay hidden)",
    handler: async (_args, ctx) => openMaskingConfig(ctx),
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
      // Bypasses rebuild(), so clear the masked-output caches explicitly:
      // toggling must never serve cached outputs across an enable cycle.
      invalidateMaskedCaches();
      ctx.ui.notify(`Data masking ${enabled ? "enabled" : "disabled"} (saved for future sessions)`, "info");
      notifyWarnings(ctx, masker.warnings);
      updateStatus(ctx);
    },
  });

}
