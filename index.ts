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
 *  4. markdown transformer — display-only unmasking: assistant text and
 *                          thinking render with real values from the first
 *                          streaming delta, so long responses never paint
 *                          placeholders into terminal scrollback (TUI only;
 *                          pi's web client does not use this hook)
 *  5. provider stream wrapper — data-level unmasking: AssistantMessageEvents
 *                          are rewritten before they enter pi's event
 *                          pipeline, so every UI (TUI, pi-web, web UIs built
 *                          on the SDK) streams real values instead of
 *                          placeholders
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
 *    and global masking-state changes)
 *  - This guarantees the same real value always maps to the same placeholder
 *    within a session
 *
 * Dynamic placeholder map (regex rules only):
 *  - Real values matched by regex rules aren't known at config-load time, so
 *    masker.ts generates their placeholders at runtime and records them in
 *    dynamicPlaceholderMap.
 *  - dynamicPlaceholderMap shares its lifecycle with sessionKey: created
 *    (cleared) only on session_start; every other path (config hot reload and
 *    global masking-state changes) reuses the same Map reference when
 *    constructing a new Masker, so dynamically generated placeholders stay
 *    stable across rule changes or toggling — only a brand-new session
 *    resets them.
 *
 */

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Model, type Provider } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { createHmac } from "node:crypto";
import { Masker } from "./masker.ts";
import type { DynamicPlaceholderMap, MaskOptions } from "./masker.ts";
import { armStreamRestore, createStreamRestore, registerStreamRestoreProviders } from "./stream-restore.ts";
import { openMaskingConfig } from "./ui/config-screen.ts";
import { selectMaskingOption, type MaskingUIBridge } from "./ui/masking-common.ts";
import {
  GLOBAL_CONFIG_PATH,
  getProjectConfigPath,
  loadConfig,
  loadConfigFromSnapshot,
  loadPersistentToggle,
  savePersistentToggle,
  watchConfigs,
} from "./config-loader.ts";
import type {
  ConfigSourceSnapshot,
  MaskingConfig,
  RawConfigRule,
} from "./config-loader.ts";
import { generateSessionKey } from "./placeholder-gen.ts";
import { guidanceNoteForConfig } from "./guidance.ts";
import {
  decideGuidanceNotice,
  markGuidanceNoticeShown,
  migrationStatePath,
  readMigrationStateSync,
  writeMigrationState,
} from "./migration.ts";
import {
  createEpochHistoryViewer,
  createHistoryViewer,
  mergePendingAssistant,
  mergeTranscript,
  transcriptKey,
  type MessageContentHashPair,
  type TranscriptEntry,
} from "./history-viewer.ts";
import {
  SESSION_STATE_ENTRY,
  SNAPSHOT_ENTRY,
  buildMessageSnapshot,
  restoreHistory,
  type RestoredHistory,
  type MessageSnapshot,
  type PersistedSessionState,
  type SessionEntryLike,
  type SnapshotBatch,
} from "./history-persistence.ts";
import { MaskedCache, hashMessage } from "./masked-cache.ts";
import {
  RULE_EPOCH_ENTRY,
  createRuleEpoch,
  restoreRuleEpochs,
  ruleBehaviorFingerprint,
  type RuleEpoch,
  type RuleEpochReason,
} from "./rule-epoch.ts";
import {
  EPOCH_TRANSCRIPT_ENTRY,
  appendUnobservedTail,
  createEpochTranscriptState,
  markEpochBatchPersisted,
  mergeEpochFacts,
  mergeEpochPendingAssistant,
  mergeEpochPrefixObservation,
  restoreEpochTranscripts,
  type EpochFactObservation,
  type EpochPrefixObservation,
  type EpochTranscriptBatch,
  type EpochTranscriptState,
  type PrefixComponentFingerprint,
} from "./epoch-transcript.ts";

// ─── Types ──────────────────────────────────────────────────────────────────



// Warn once per session when the dynamic placeholder map (regex-discovered
// values) grows past this many entries — it only grows within a session.
const DYNAMIC_MAP_WARN_THRESHOLD = 5000;

// Model guidance appended to the system prompt (options.systemPromptGuidance, default off):
// appended after the masked system prompt to establish the behavioral
// contract for masked values — see guidance.ts and
// docs/model-guidance-design.md. Composed per config so the optional
// placeholder disclosure list reflects the active rule set.

// Upper bound for snapshotContentHashes (last-persisted per-message
// fingerprints). It otherwise mirrors transcript growth, which is unbounded
// by design; overflowing clears it wholesale, costing one re-diff pass.
const SNAPSHOT_CONTENT_HASH_MAX_ENTRIES = 10_000;

// ─── Helpers ──────────────────────────────────────────────────────────────

function statusLabel(cfg: MaskingConfig): string {
  const configured = cfg.configuredRules.length;
  const active = cfg.rules.length;
  return cfg.enabled
    ? `🔒 Masking: ${active} active / ${configured} configured`
    : `🔓 Masking: off · ${active} rule(s) ready`;
}

/**
 * Build latestModelInput for the messages of the most recent provider
 * request. `original` aliases the transcript entry's private clone instead of
 * deep-cloning the whole conversation on every request — every requested
 * message was just merged under the same transcriptKey. The masked
 * fingerprint comes from the boundary observation when available.
 */
function latestInputsFromTranscript(
  entries: readonly TranscriptEntry[],
  originals: readonly Record<string, unknown>[],
  maskedHashAt: (index: number) => string,
): Array<{ original: Record<string, unknown>; maskedHash: string }> {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return originals.map((message, index) => ({
    original: byKey.get(transcriptKey(message, index))?.original ?? message,
    maskedHash: maskedHashAt(index),
  }));
}

// ─── Extension entry point ──────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // Register stream-restoring provider wrappers eagerly — see stream-restore.ts.
  registerStreamRestoreProviders(pi);

  let config: MaskingConfig = {
    enabled: false,
    rules: [],
    configuredRules: [],
    options: { caseSensitive: true, showStatusBar: true, systemPromptGuidance: false, disclosePlaceholders: false, persistHistory: true },
  };
  let masker = new Masker([], true);
  let stopWatching: (() => void) | null = null;
  let configSnapshot: ConfigSourceSnapshot | undefined;

  // Session key: generated on session_start, stays constant for the whole
  // session (including config hot reloads). Pre-initialized to a valid value to
  // avoid a null pointer if another event fires before session_start.
  let sessionKey: Buffer = generateSessionKey();

  // Upgrade notice state: set at startup for existing-config users who have
  // not seen (or enabled) the model guidance; cleared once the marker file is
  // written and after the user enables guidance. See migration.ts.
  let guidanceNoticePending = false;

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

  // Rule configuration is immutable for one complete agent run (from
  // before_agent_start through agent_settled), including every tool-loop LLM
  // call. Changes that arrive during a run are coalesced here and activated
  // atomically before the next run starts.
  let ruleEpochs: RuleEpoch[] = [];
  let epochTranscripts = new Map<number, EpochTranscriptState>();
  let activeRuleEpoch: RuleEpoch | undefined;
  let activeEpochConfig: MaskingConfig | undefined;
  let persistedEpochIds = new Set<number>();
  let pendingSystemSourceHash: string | undefined;
  let pendingSystemSourceText: string | undefined;
  /** Most recent factual model input, retained only in memory for an immediate
   *  dry-run when masking behavior changes. `original` aliases the
   *  transcript's private clone (maskers never mutate their input — they
   *  build new containers), so no per-request re-clone is needed. */
  let latestModelInput: Array<{ original: Record<string, unknown>; maskedHash: string }> = [];
  let latestSystemPrefix: { source: string; emitted: string } | undefined;
  let impactPreviewKeys = new Set<string>();
  let agentRunActive = false;
  let pendingConfigActivation: { config: MaskingConfig; reason: RuleEpochReason } | null = null;

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

  /** True once the session's model-bound transcript actually contains masked
   *  content (original ≠ masked fingerprints seen in resolveMaskedMessage,
   *  including restored history priming). Disabling masking then changes what
   *  the next request sends, invalidating provider prefix cache from the
   *  earliest changed component. When nothing was masked yet, disabling has
   *  no prefix-cache impact and needs no second confirmation. */
  let sessionMaskedOutbound = false;

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** Build a Masker from one immutable config and the session-wide mapping state. */
  function buildMasker(cfg: MaskingConfig): Masker {
    return new Masker(
      cfg.enabled ? cfg.rules : [],
      cfg.options.caseSensitive,
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
      // Serve the entry's canonical pair: a hit may have matched via the
      // stored masked-output hash (provider boundary re-checks the context
      // hook's output), and pair.original must stay the un-masked
      // fingerprint either way.
      if (cached.hash !== cached.maskedHash) sessionMaskedOutbound = true;
      return {
        masked: cached.masked,
        pair: { original: cached.hash, masked: cached.maskedHash },
        fromCache: true,
        count: 0,
      };
    }
    const role = (message as { role?: string } | null | undefined)?.role;
    const r = masker.maskValue(message, maskOptionsForRole(role));
    const maskedHash = hashMessage(r.value);
    maskedCache.record(key, hash, maskedHash, r.value);
    if (hash !== maskedHash) sessionMaskedOutbound = true;
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
    if (systemPromptMemo !== null && systemPromptMemo.input === input) {
      return systemPromptMemo;
    }
    const r = masker.mask(input, { discover: true });
    systemPromptMemo = { input, text: r.text, count: r.count };
    return systemPromptMemo;
  }

  function persistRuleEpoch(ctx: ExtensionContext, epoch: RuleEpoch): void {
    if (!config.options.persistHistory || persistedEpochIds.has(epoch.epochId)) return;
    // Persist a contiguous chain. This matters when persistHistory was off for
    // an earlier in-memory epoch and is enabled later in the same session.
    for (const candidate of ruleEpochs) {
      if (candidate.epochId > epoch.epochId) break;
      if (persistedEpochIds.has(candidate.epochId)) continue;
      if (candidate.parentEpochId !== undefined && !persistedEpochIds.has(candidate.parentEpochId)) return;
      try {
        pi.appendEntry(RULE_EPOCH_ENTRY, candidate);
        persistedEpochIds.add(candidate.epochId);
      } catch (err) {
        if (!persistenceWarned) {
          persistenceWarned = true;
          ctx.ui.notify(`⚠️ Failed to persist masking rule history: ${(err as Error).message}`, "warning");
        }
        return;
      }
    }
  }

  function ensureEpochTranscript(epoch: RuleEpoch): EpochTranscriptState {
    let state = epochTranscripts.get(epoch.epochId);
    if (!state) {
      state = createEpochTranscriptState(epoch);
      epochTranscripts.set(epoch.epochId, state);
    }
    return state;
  }

  function persistEpochTranscriptBatch(
    ctx: ExtensionContext,
    state: EpochTranscriptState,
    batch: EpochTranscriptBatch | undefined,
  ): void {
    if (!batch || !config.options.persistHistory) return;
    ensureSessionStatePersisted(ctx);
    if (!sessionStatePersisted) return;
    persistRuleEpoch(ctx, state.epoch);
    if (!persistedEpochIds.has(state.epoch.epochId)) return;
    try {
      pi.appendEntry(EPOCH_TRANSCRIPT_ENTRY, batch);
      markEpochBatchPersisted(state, batch);
    } catch (err) {
      if (!persistenceWarned) {
        persistenceWarned = true;
        ctx.ui.notify(`⚠️ Failed to persist factual masking history: ${(err as Error).message}`, "warning");
      }
    }
  }

  function observeEpochFacts(
    ctx: ExtensionContext,
    observations: readonly EpochFactObservation[],
    capturedAt = Date.now(),
  ): void {
    if (!activeRuleEpoch || observations.length === 0) return;
    const state = ensureEpochTranscript(activeRuleEpoch);
    const { batch } = mergeEpochFacts(state, observations, capturedAt);
    persistEpochTranscriptBatch(ctx, state, batch);
  }

  function prefixValueFingerprint(value: string): string {
    return createHmac("sha256", sessionKey).update(value).digest("hex");
  }

  function prefixComponentFingerprint(source: string, emitted: string): PrefixComponentFingerprint {
    return { sourceHash: prefixValueFingerprint(source), emittedHash: prefixValueFingerprint(emitted) };
  }

  function observeEpochProviderPrefix(ctx: ExtensionContext, observation: EpochPrefixObservation): void {
    if (!activeRuleEpoch) return;
    const state = ensureEpochTranscript(activeRuleEpoch);
    // Keep factual provider-boundary fingerprints for epoch history, but do not
    // show a post-request cache warning: at this point the user can no longer
    // preserve reuse. Actionable warnings belong to the save/reload preflight.
    const { batch } = mergeEpochPrefixObservation(state, observation);
    persistEpochTranscriptBatch(ctx, state, batch);
  }

  /** Persisted so the provisional response survives a restart; the next
   *  boundary observation replaces it and clears the pending flag. */
  function observeEpochPendingAssistant(
    ctx: ExtensionContext,
    original: Record<string, unknown>,
    masked: Record<string, unknown>,
  ): void {
    if (!activeRuleEpoch) return;
    const state = ensureEpochTranscript(activeRuleEpoch);
    const { batch } = mergeEpochPendingAssistant(state, original, masked);
    persistEpochTranscriptBatch(ctx, state, batch);
  }

  function epochObservations(
    originals: readonly Record<string, unknown>[],
    masked: readonly Record<string, unknown>[],
    hashes: readonly MessageContentHashPair[],
  ): EpochFactObservation[] {
    return originals.map((original, index) => ({
      messageKey: transcriptKey(original, index),
      original,
      masked: masked[index] ?? original,
      hashes: hashes[index]!,
    }));
  }

  /** Activate one behavior version; equal behavior reuses the current epoch. */
  function activateConfig(cfg: MaskingConfig, reason: RuleEpochReason, ctx: ExtensionContext): string[] {
    const fingerprint = ruleBehaviorFingerprint(cfg, sessionKey);
    const behaviorChanged = activeRuleEpoch?.behaviorFingerprint !== fingerprint;
    config = cfg;
    masker = buildMasker(cfg);
    // Rules/caseSensitive changed → cached masked outputs are stale.
    invalidateMaskedCaches();
    if (behaviorChanged) {
      const epoch = createRuleEpoch({
        config: cfg,
        previousConfig: activeEpochConfig,
        previousEpoch: activeRuleEpoch,
        sessionKey,
        reason,
      });
      ruleEpochs.push(epoch);
      activeRuleEpoch = epoch;
    }
    activeEpochConfig = cfg;
    if (activeRuleEpoch) {
      ensureEpochTranscript(activeRuleEpoch);
      persistRuleEpoch(ctx, activeRuleEpoch);
    }
    return masker.warnings;
  }

  interface ConfigImpactPreview {
    systemChanged: boolean;
    changedMessageCount: number;
    firstChangedIndex: number;
  }

  /**
   * Dry-run a candidate behavior against the most recent factual model input.
   * Mutable Masker inputs are cloned, so previewing cannot reserve a
   * placeholder or alter first-seen provenance. Compaction, later extensions,
   * serialization, and provider policy remain outside this local estimate.
   *
   * Both sides of every comparison are fresh re-masks (candidate vs the
   * config that is currently slated to run), never the recorded maskedHash.
   * Re-masking with the current config cancels out recorder drift (stale
   * cache entries, restored sessions, changed toggles), so a rule that has
   * never fired on any message produces no diff and no confirmation prompt.
   */
  function previewConfigImpact(cfg: MaskingConfig): ConfigImpactPreview | undefined {
    if (latestModelInput.length === 0 && !latestSystemPrefix) return undefined;
    const baseCfg = pendingConfigActivation?.config ?? config;
    const previewMaskerFor = (c: MaskingConfig) => new Masker(
      c.enabled ? c.rules : [],
      c.options.caseSensitive,
      sessionKey,
      new Map(dynamicPlaceholderMap),
      new Set(llmInventedValues),
      new Set(protectedValues),
    );

    let systemChanged = false;
    if (latestSystemPrefix) {
      const emittedWith = (c: MaskingConfig) => {
        let emitted = latestSystemPrefix!.source;
        if (c.enabled && c.rules.length > 0) {
          emitted = previewMaskerFor(c).mask(emitted, { discover: true }).text;
          const guidanceNote = guidanceNoteForConfig(c);
          if (guidanceNote) emitted += "\n\n" + guidanceNote;
        }
        return emitted;
      };
      systemChanged = emittedWith(cfg) !== emittedWith(baseCfg);
    }

    const baselineMasker = previewMaskerFor(baseCfg);
    const candidateMasker = previewMaskerFor(cfg);
    let changedMessageCount = 0;
    let firstChangedIndex = -1;
    for (let index = 0; index < latestModelInput.length; index++) {
      const entry = latestModelInput[index]!;
      const role = (entry.original as { role?: string }).role;
      const options = maskOptionsForRole(role);
      const remask = (masker: Masker) => masker.maskValue(entry.original, options).value;
      if (hashMessage(remask(candidateMasker)) === hashMessage(remask(baselineMasker))) continue;
      changedMessageCount++;
      if (firstChangedIndex < 0) firstChangedIndex = index;
    }

    if (!systemChanged && changedMessageCount === 0) return undefined;
    return { systemChanged, changedMessageCount, firstChangedIndex };
  }

  function configImpactPreviewKey(cfg: MaskingConfig): string {
    const currentFingerprint = activeRuleEpoch?.behaviorFingerprint ?? "none";
    const candidateFingerprint = ruleBehaviorFingerprint(cfg, sessionKey);
    const factualSignature = hashMessage({
      system: latestSystemPrefix?.emitted,
      messages: latestModelInput.map((entry) => entry.maskedHash),
    });
    return `${currentFingerprint}:${candidateFingerprint}:${factualSignature}`;
  }

  function notifyConfigImpactPreview(
    ctx: ExtensionContext,
    cfg: MaskingConfig,
    prediction: ConfigImpactPreview,
  ): void {
    const previewKey = configImpactPreviewKey(cfg);
    if (impactPreviewKeys.has(previewKey)) return;
    impactPreviewKeys.add(previewKey);

    const history = prediction.changedMessageCount > 0
      ? `${prediction.changedMessageCount} existing conversation message${prediction.changedMessageCount === 1 ? "" : "s"} (earliest #${prediction.firstChangedIndex + 1})`
      : "";
    const target = prediction.systemChanged
      ? `the provider system prompt${history ? ` and ${history}` : ""}`
      : history;
    const activation = agentRunActive
      ? " The active agent run keeps its current rules; this estimate applies when the pending change activates."
      : "";
    ctx.ui.notify(
      `⚠️ Local preflight: this masking change is expected to change ${target}; provider prefix cache reuse may decrease from the earliest changed component.${activation} No provider request has been sent for this check; review or revert the rule before the next request if cache reuse is more important.`,
      "warning",
    );
  }

  function configImpactMessage(prediction: ConfigImpactPreview): string {
    const history = prediction.changedMessageCount > 0
      ? `${prediction.changedMessageCount} existing conversation message${prediction.changedMessageCount === 1 ? "" : "s"} (earliest #${prediction.firstChangedIndex + 1})`
      : "";
    const target = prediction.systemChanged
      ? `the provider system prompt${history ? ` and ${history}` : ""}`
      : history;
    const activation = agentRunActive
      ? "\n\nThe active agent run keeps its current rules; this estimate applies when the pending change activates."
      : "";
    return `Local preflight expects this change to alter ${target}. Provider prefix cache reuse may decrease from the earliest changed component.${activation}`;
  }

  async function confirmConfigSave(
    ctx: ExtensionContext,
    cfg: MaskingConfig,
    options: { title?: string; warning?: string; force?: boolean } = {},
    ask?: (title: string, message: string) => Promise<boolean>,
  ): Promise<boolean> {
    const behaviorChanged = activeRuleEpoch?.behaviorFingerprint !== ruleBehaviorFingerprint(cfg, sessionKey);
    const prediction = behaviorChanged ? previewConfigImpact(cfg) : undefined;
    if (!prediction && !options.force) return true;
    const sections = [options.warning, prediction ? configImpactMessage(prediction) : undefined]
      .filter((section): section is string => Boolean(section));
    const title = options.title ?? "Save masking changes?";
    const message = sections.join("\n\n");
    const choice = ask
      ? await ask(title, message) ? "Save anyway" : "Back to editing"
      : await selectMaskingOption(ctx, title, ["Save anyway", "Back to editing"], message);
    if (choice !== "Save anyway") return false;
    if (prediction) impactPreviewKeys.add(configImpactPreviewKey(cfg));
    return true;
  }

  async function candidateConfigFromSources(
    ctx: ExtensionContext,
    sources: Array<{ path: string; data: { rules: RawConfigRule[]; [key: string]: unknown } }>,
  ): Promise<{ config: MaskingConfig; warnings: string[] }> {
    const snapshot: ConfigSourceSnapshot = structuredClone(configSnapshot ?? { global: null, project: null });
    const projectPath = getProjectConfigPath(ctx.cwd);
    for (const source of sources) {
      if (source.path === projectPath) snapshot.project = source.data as unknown as Partial<MaskingConfig>;
      else if (source.path === GLOBAL_CONFIG_PATH) snapshot.global = source.data as unknown as Partial<MaskingConfig>;
    }
    const loaded = loadConfigFromSnapshot(ctx.cwd, sessionKey, snapshot);
    const persisted = await applyPersistentToggle(loaded.config);
    return {
      config: persisted.config,
      warnings: [...loaded.warnings, ...persisted.warnings],
    };
  }

  /** Validate now, preview factual history impact, then activate immediately or coalesce behind the active run. */
  function acceptConfigChange(
    ctx: ExtensionContext,
    cfg: MaskingConfig,
    reason: RuleEpochReason,
    warnings: string[] = [],
  ): "activated" | "queued" {
    const compileWarnings = buildMasker(cfg).warnings;
    notifyWarnings(ctx, [...warnings, ...compileWarnings]);
    const candidateFingerprint = ruleBehaviorFingerprint(cfg, sessionKey);
    if (activeRuleEpoch?.behaviorFingerprint !== candidateFingerprint) {
      const prediction = previewConfigImpact(cfg);
      if (prediction) notifyConfigImpactPreview(ctx, cfg, prediction);
    }
    if (agentRunActive) {
      pendingConfigActivation = { config: cfg, reason };
      updateStatus(ctx);
      return "queued";
    }
    // A change accepted after the previous run settled supersedes anything
    // that had been queued during that run.
    pendingConfigActivation = null;
    activateConfig(cfg, reason, ctx);
    ensureSessionStatePersisted(ctx);
    updateStatus(ctx);
    return "activated";
  }

  function activatePendingConfig(ctx: ExtensionContext): void {
    if (!pendingConfigActivation) return;
    const pending = pendingConfigActivation;
    pendingConfigActivation = null;
    activateConfig(pending.config, pending.reason, ctx);
    ensureSessionStatePersisted(ctx);
    ctx.ui.notify(
      `🔒 Pending masking changes activated as E${activeRuleEpoch?.epochId ?? 1} for this agent run; previously recorded masking facts remain unchanged`,
      "info",
    );
    updateStatus(ctx);
  }

  /** Apply the user-level masking-state override after config-file merging. */
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
    const pending = pendingConfigActivation ? " · changes pending" : "";
    ctx.ui.setStatus("masking", statusLabel(config) + pending);
  }

  async function reloadConfigNow(ctx: ExtensionContext): Promise<void> {
    const loaded = await loadConfig(ctx.cwd, sessionKey, configSnapshot);
    configSnapshot = loaded.snapshot;
    const persisted = await applyPersistentToggle(loaded.config);
    const disposition = acceptConfigChange(
      ctx,
      persisted.config,
      "ui_edit",
      [...loaded.warnings, ...persisted.warnings],
    );
    if (disposition === "queued") {
      ctx.ui.notify(
        "Masking changes are saved; the active agent run keeps its current rules, the final change activates before the next run, and recorded history is not rewritten",
        "info",
      );
    }
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

  // ── Display restoration (TUI live view) ─────────────────────────────────

  // Restore real values in rendered assistant text and thinking markdown —
  // including while the response is still streaming. Without this, the TUI
  // displays raw model output (which contains placeholders) until message_end
  // swaps in the restored message; for very long thinking output the masked
  // rendering is committed to terminal scrollback line-by-line and remains
  // visible after completion even though stored history is fully restored.
  //
  // This hook is display-only by contract: it never touches session storage,
  // model-facing context, or tool arguments, and it runs synchronously on
  // every render — hence the single-pass unmaskDisplay() fast path. Only
  // assistant content is transformed: user messages already hold real values
  // locally. Runs for streaming updates, finalized messages, and restored
  // session messages; pi's web client does not use this hook and instead
  // applies the message_end restoration when the message finalizes.
  // Optional chaining keeps the extension loadable on older pi cores (and
  // minimal test harnesses) whose ExtensionAPI predates this hook.
  pi.registerMarkdownTransformer?.((markdown, renderCtx) => {
    if (renderCtx.messageType !== "assistant" && renderCtx.messageType !== "assistant-thinking") {
      return markdown;
    }
    if (!config.enabled || config.rules.length === 0) return markdown;
    return masker.unmaskDisplay(markdown);
  });

  // ── Stream restoration (provider-level, all UIs) ───────────────────────

  // Rewrites provider stream events so placeholders become real values before
  // they reach pi's event pipeline. This is what makes streaming show real
  // values in pi's web client (whose render pipeline ignores the markdown
  // transformer above) and doubles as a data-level guarantee for the TUI.
  // See docs/stream-restore-design.md for the full design.
  const streamRestore = createStreamRestore(() => masker);
  // Pristine provider streams, captured before any registration so the
  // delegation never recurses into our own wrapper (a composed provider's
  // streamWith closure keeps the extension binding from its composition time).
  const pristineProviderStreams = new Map<string, Provider["stream"]>();
  const streamRestoredApis = new Map<string, string>();

  const ensureStreamDisplayRestore = (model: Model<any> | undefined, ctx: ExtensionContext): void => {
    if (!model?.provider || !model.api) return;
    const providerId = model.provider;
    if (streamRestoredApis.get(providerId) === model.api) return;
    let stream = pristineProviderStreams.get(providerId);
    if (!stream) {
      let provider: Provider | undefined;
      try {
        provider = ctx.modelRegistry.getProvider(providerId);
      } catch {
        provider = undefined;
      }
      const fn = provider?.stream;
      if (typeof fn !== "function") return;
      stream = fn.bind(provider);
      pristineProviderStreams.set(providerId, stream);
    }
    const pristine = stream;
    try {
      // registerProvider applies immediately and merges over previous
      // registrations; refresh({ allowNetwork: false }) it triggers is
      // offline-safe. Optional chaining keeps older cores loadable — they
      // simply keep today's behavior (mask restored at message_end only).
      pi.registerProvider?.(providerId, {
        api: model.api,
        streamSimple: (m, c, o) => streamRestore.wrap(pristine(m, c, o)),
      });
      streamRestoredApis.set(providerId, model.api);
    } catch {
      // Registration refused — leave streaming untouched.
    }
  };

  pi.on("model_select", (event, ctx) => {
    ensureStreamDisplayRestore(event.model, ctx);
  });

  // Safety net for headless/web sessions where the model may be configured
  // after session_start without a model_select event: before_agent_start
  // fires before every prompt with the model resolved. Idempotent, so the
  // earlier hooks make this a no-op in the common case.
  pi.on("before_agent_start", (_event, ctx) => {
    // Arm the process-wide slot so the factory-time queued provider wrappers
    // (see top of this file) delegate to THIS instance's live masker. arming
    // here — right before the stream starts — also keeps concurrent sessions
    // as fresh as possible.
    armStreamRestore(() => streamRestore);
    ensureStreamDisplayRestore(ctx.model, ctx);
  });

  // ── Session lifecycle ─────────────────────────────────────────────────────

  /**
   * Rebuild branch-derived state (transcript, rule epochs, epoch transcripts)
   * from the session manager's active branch. Runs on session_start and again
   * on session_tree so /tree navigation never leaves the in-memory history
   * (shown by /masking-history) pointing at the previous branch. Returns the
   * restored history so callers can replay messages with the activated config.
   */
  /** Reset every session-scoped mutable field to its fresh-session default.
   *  restoreBranchState() calls this before applying branch-derived state and
   *  session_shutdown() so nothing stale survives the session — the field
   *  list exists exactly once, here, so the two paths cannot drift apart.
   *  Not reset: stopWatching (watcher lifecycle), config/masker/configSnapshot
   *  (config lifecycle), sessionKey (re-derived per branch),
   *  guidanceNoticePending (session_start migration flow). */
  function resetSessionState(): void {
    transcript = [];
    snapshotSignatures = new Map();
    snapshotContentHashes = new Map();
    requestSequence = 0;
    sessionStatePersisted = false;
    dynamicPlaceholderMap = new Map();
    llmInventedValues = new Set();
    protectedValues = new Set();
    ruleEpochs = [];
    epochTranscripts = new Map();
    activeRuleEpoch = undefined;
    activeEpochConfig = undefined;
    persistedEpochIds = new Set();
    pendingSystemSourceHash = undefined;
    pendingSystemSourceText = undefined;
    latestModelInput = [];
    latestSystemPrefix = undefined;
    impactPreviewKeys = new Set();
    agentRunActive = false;
    pendingConfigActivation = null;
    sessionMaskedOutbound = false;
    invalidateMaskedCaches();
    fallbackNotifiedThisTurn = false;
    systemPromptWarned = false;
    dynamicMapWarned = false;
    inventedMapWarned = false;
    persistenceWarned = false;
  }

  const restoreBranchState = (ctx: ExtensionContext): RestoredHistory => {
    resetSessionState();
    const branchEntries = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
    const restored = restoreHistory(branchEntries);
    transcript = restored.transcript;
    snapshotSignatures = restored.signatures;
    requestSequence = restored.requestSequence;
    sessionStatePersisted = sessionStatePersisted || restored.sessionKey !== undefined;

    // A resumed Pi session reuses its persisted key, keeping placeholders
    // stable across process restarts. Sessions predating persistence get a new
    // key and clearly marked missing snapshots for their existing messages.
    sessionKey = restored.sessionKey ?? sessionKey ?? generateSessionKey();
    ruleEpochs = restored.sessionKey ? restoreRuleEpochs(branchEntries) : [];
    epochTranscripts = restoreEpochTranscripts(branchEntries, ruleEpochs, restored.messages);
    // Sessions recorded before pending persistence existed can end before the
    // branch's real last message; fill that gap so /masking-history opens at
    // the live edge even before the next provider request re-observes history.
    appendUnobservedTail(epochTranscripts, restored.messages);
    activeRuleEpoch = ruleEpochs.at(-1);
    activeEpochConfig = undefined;
    persistedEpochIds = new Set(ruleEpochs.map((epoch) => epoch.epochId));
    latestModelInput = transcript.map((entry) => ({
      original: entry.original,
      maskedHash: hashMessage(entry.masked),
    }));
    return restored;
  };

  /** Replay the full active branch locally to rebuild dynamic mappings and
   * first-seen provenance using the restored session key, priming the
   * masked-output cache so the first post-restore request skips re-masking
   * history. Nothing from this pass is counted or sent to the model.
   * Must run with the session's config already activated. */
  const replayBranchMessages = (messages: RestoredHistory["messages"]) => {
    for (let index = 0; index < messages.length; index++) {
      resolveMaskedMessage(messages[index], index);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    ensureStreamDisplayRestore(ctx.model, ctx);
    stopWatching?.();
    const restored = restoreBranchState(ctx);

    configSnapshot = undefined;
    const loaded = await loadConfig(ctx.cwd, sessionKey);
    configSnapshot = loaded.snapshot;
    const persisted = await applyPersistentToggle(loaded.config);
    const compileWarnings = activateConfig(persisted.config, "session_start", ctx);

    // Replay the full active branch locally to rebuild dynamic mappings and
    // first-seen provenance using the restored session key, priming the
    // masked-output cache so the first post-restore request skips re-masking
    // history. Nothing from this pass is counted or sent to the model.
    replayBranchMessages(restored.messages);

    ensureSessionStatePersisted(ctx);
    notifyWarnings(ctx, [...loaded.warnings, ...persisted.warnings, ...compileWarnings]);

    // One-time upgrade notice: only for existing-config users, only until
    // the marker records this notice version. The actual enablement lives
    // in the /masking settings zone; this never blocks or asks inline.
    try {
      const statePath = migrationStatePath(getAgentDir());
      const state = readMigrationStateSync(statePath);
      const configExists = existsSync(GLOBAL_CONFIG_PATH) || existsSync(getProjectConfigPath(ctx.cwd));
      if (decideGuidanceNotice(state, configExists).pending) {
        guidanceNoticePending = true;
        await writeMigrationState(statePath, markGuidanceNoticeShown(state));
        if (!persisted.config.options.systemPromptGuidance) {
          ctx.ui.notify(
            "pi-data-masking: new in this version — model guidance can tell the model how to work with masked values (compare, pass through, transform via tools). Open /masking, Tab to the settings zone to enable it.",
            "info",
          );
        }
      }
    } catch {
      // The notice is best-effort; never block session start over it.
    }

    stopWatching = watchConfigs(ctx.cwd, async () => {
      // Hot reload: reuse the current session's sessionKey and dynamicPlaceholderMap
      const reloaded = await loadConfig(ctx.cwd, sessionKey, configSnapshot);
      configSnapshot = reloaded.snapshot;
      const persistedReload = await applyPersistentToggle(reloaded.config);
      const disposition = acceptConfigChange(
        ctx,
        persistedReload.config,
        "file_reload",
        [...reloaded.warnings, ...persistedReload.warnings],
      );
      if (disposition === "activated") ensureSessionStatePersisted(ctx);
      if (disposition === "queued") {
        ctx.ui.notify(
          "🔒 Masking config reload saved; the active run keeps its current rules, the reload activates before the next run, and recorded history is not rewritten",
          "info"
        );
      }
    });

    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    // /tree navigation re-points the active branch without reloading the
    // extension, so branch-derived state must be rebuilt here as well —
    // otherwise /masking-history keeps showing the previous branch.
    const restored = restoreBranchState(ctx);
    replayBranchMessages(restored.messages);
    ensureSessionStatePersisted(ctx);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopWatching?.();
    stopWatching = null;
    resetSessionState();
  });

  // ── Hook 1: context — outbound masking ────────────────────────────────────

  pi.on("context", async (event, ctx) => {
    const messages = event.messages;
    const originals = messages as unknown as Record<string, unknown>[];
    // Retain the complete local replay even while masking is off. When it is
    // enabled, the same entries are replaced below with the actual masked form
    // sent through this boundary.
    if (!config.enabled || config.rules.length === 0) {
      const capturedAt = Date.now();
      const disabledPairs: MessageContentHashPair[] = [];
      for (let index = 0; index < originals.length; index++) {
        const hash = hashMessage(originals[index]);
        disabledPairs.push({ original: hash, masked: hash });
      }
      transcript = mergeTranscript(transcript, originals, originals, capturedAt, disabledPairs);
      latestModelInput = latestInputsFromTranscript(transcript, originals, (index) => hashMessage(originals[index]));
      impactPreviewKeys.clear();
      observeEpochFacts(ctx, epochObservations(originals, originals, disabledPairs), capturedAt);
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

    const capturedAt = Date.now();
    transcript = mergeTranscript(
      transcript,
      originals,
      maskedMessages,
      capturedAt,
      contentHashes,
    );
    latestModelInput = latestInputsFromTranscript(
      transcript,
      originals,
      (index) => contentHashes[index]?.masked ?? hashMessage(maskedMessages[index] ?? originals[index]),
    );
    impactPreviewKeys.clear();
    observeEpochFacts(ctx, epochObservations(originals, maskedMessages, contentHashes), capturedAt);
    persistSnapshots(ctx, originals, maskedMessages, contentHashes);
    return { messages: maskedMessages as unknown as typeof event.messages };
  });

  // ── Hook 2: message_end — inbound unmasking ───────────────────────────────

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    if (!config.enabled || config.rules.length === 0) {
      const message = event.message as unknown as Record<string, unknown>;
      transcript = mergePendingAssistant(transcript, message, message);
      observeEpochPendingAssistant(ctx, message, message);
      return;
    }

    // Restore real values before storing, so the user always sees the real data
    const { value: message } = masker.unmaskValue(event.message);
    // The response is not part of the outbound context until the next model
    // request. Keep a provisional snapshot so the viewer includes it now; the
    // next context hook replaces it with the exact provider-boundary version.
    const maskedForTranscript = masker.maskValue(message, maskOptionsForRole("assistant")).value;
    transcript = mergePendingAssistant(
      transcript,
      message as unknown as Record<string, unknown>,
      maskedForTranscript as Record<string, unknown>,
    );
    observeEpochPendingAssistant(
      ctx,
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

  // before_agent_start normally pins the run before agent_start fires. The
  // latter is a fallback for programmatic continuations that skip prompt
  // assembly. Keep the pin through every tool-loop turn until agent_settled.
  pi.on("agent_start", async (_event, ctx) => {
    if (agentRunActive) return;
    activatePendingConfig(ctx);
    agentRunActive = true;
  });

  pi.on("agent_settled", async () => {
    agentRunActive = false;
    pendingSystemSourceHash = undefined;
    pendingSystemSourceText = undefined;
  });

  // ── Hook 5: before_agent_start — mask the system prompt (default on) ──────

  pi.on("before_agent_start", async (event, ctx) => {
    activatePendingConfig(ctx);
    agentRunActive = true;
    pendingSystemSourceHash = prefixValueFingerprint(event.systemPrompt);
    pendingSystemSourceText = event.systemPrompt;
    if (!config.enabled || config.rules.length === 0) return;
    // Memoized: the prompt is static per session and is masked again at the
    // provider boundary; fill registers provenance exactly once.
    const r = maskSystemPromptCached(event.systemPrompt);
    let text = r.text;
    const guidanceNote = guidanceNoteForConfig(config);
    if (guidanceNote) {
      text += "\n\n" + guidanceNote;
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
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return;

    const record = payload as Record<string, unknown>;
    const maskingActive = config.enabled && config.rules.length > 0;
    let intercepted = 0;

    if (!maskingActive) {
      if (Array.isArray(record.messages)) {
        const observations: EpochFactObservation[] = [];
        for (let index = 0; index < record.messages.length; index++) {
          const message = record.messages[index];
          if (message === null || typeof message !== "object" || Array.isArray(message)) continue;
          const hash = hashMessage(message);
          observations.push({
            messageKey: transcriptKey(message as Record<string, unknown>, index),
            original: message as Record<string, unknown>,
            masked: message as Record<string, unknown>,
            hashes: { original: hash, masked: hash },
          });
        }
        observeEpochFacts(ctx, observations);
      }
    } else if (Array.isArray(record.messages)) {
      let changedCount = 0;
      const source = record.messages as unknown[];
      const maskedMessages: unknown[] = new Array(source.length);
      const boundaryObservations: EpochFactObservation[] = [];
      for (let index = 0; index < source.length; index++) {
        const m = source[index];
        const resolved = resolveMaskedMessage(m, index);
        maskedMessages[index] = resolved.masked;
        // A context-produced masked object hits via pair.masked and has already
        // been recorded. An unmasked source (including injected content or a
        // request that bypassed context) matches pair.original and is a new
        // factual boundary observation. Equal hashes are harmlessly deduped.
        if (
          m !== null && typeof m === "object" && !Array.isArray(m) &&
          resolved.masked !== null && typeof resolved.masked === "object" && !Array.isArray(resolved.masked) &&
          hashMessage(m) === resolved.pair.original
        ) {
          boundaryObservations.push({
            messageKey: transcriptKey(m as Record<string, unknown>, index),
            original: m as Record<string, unknown>,
            masked: resolved.masked as Record<string, unknown>,
            hashes: resolved.pair,
          });
        }
        // Cache hits mean the context hook already sent this exact content
        // through the masker — only fills can be boundary interceptions.
        // Assistant re-masking at this boundary is bookkeeping and never
        // counts toward the fallback notice.
        const role = (m as { role?: string } | null)?.role;
        if (!resolved.fromCache && role !== "assistant") intercepted += resolved.count;
        if (hashMessage(m) !== resolved.pair.masked) changedCount++;
      }
      // Replace the payload only when something actually differs; system and
      // prompt below are still scanned unconditionally either way.
      if (changedCount > 0) record.messages = maskedMessages;
      observeEpochFacts(ctx, boundaryObservations);
    }

    let system: PrefixComponentFingerprint | undefined;
    if (typeof record.system === "string") {
      const source = record.system;
      if (maskingActive) {
        const r = maskSystemPromptCached(source);
        if (r.count > 0) {
          record.system = r.text;
          intercepted += r.count;
        }
      }
      const originalSource = pendingSystemSourceText ?? source;
      latestSystemPrefix = { source: originalSource, emitted: record.system as string };
      system = {
        sourceHash: pendingSystemSourceHash ?? prefixValueFingerprint(source),
        emittedHash: prefixValueFingerprint(record.system as string),
      };
    }

    let prompt: PrefixComponentFingerprint | undefined;
    if (typeof record.prompt === "string") {
      const source = record.prompt;
      if (maskingActive) {
        const r = masker.mask(source, { discover: true });
        if (r.count > 0) {
          record.prompt = r.text;
          intercepted += r.count;
        }
      }
      prompt = prefixComponentFingerprint(source, record.prompt as string);
    }

    observeEpochProviderPrefix(ctx, { observedAt: Date.now(), system, prompt });

    if (maskingActive && intercepted > 0 && !fallbackNotifiedThisTurn) {
      fallbackNotifiedThisTurn = true;
      ctx.ui.notify(
        `🛡️ ${intercepted} sensitive value(s) intercepted at the provider request boundary (bypassed the context hook — check other extensions or injected content)`,
        "warning"
      );
    }

    if (maskingActive) return payload;
  });

  // Bridge between the /masking UI modules and the extension closure.
  const maskingUIBridge: MaskingUIBridge = {
    config: () => config,
    effectiveConfig: () => pendingConfigActivation?.config ?? config,
    activationPending: () => pendingConfigActivation !== null,
    sessionKey: () => sessionKey,
    sessionMaskedOutbound: () => sessionMaskedOutbound,
    guidanceNoticePending: () => guidanceNoticePending,
    clearGuidanceNotice: () => {
      guidanceNoticePending = false;
    },
    candidateConfigFromSources,
    acceptConfigChange,
    confirmConfigSave,
    reloadConfigNow,
    notifyWarnings,
  };

  pi.registerCommand("masking", {
    description: "Enable/disable masking and configure rules (real values stay hidden)",
    handler: async (_args, ctx) => openMaskingConfig(maskingUIBridge, ctx),
  });

  // ── Command: /masking-history ────────────────────────────────────────────

  pi.registerCommand("masking-history", {
    description: "Replay factual masking results by rule version",
    handler: async (_args, ctx) => {
      const epochViews = [...epochTranscripts.values()]
        .filter((state) => state.entries.length > 0)
        .sort((left, right) => left.epoch.epochId - right.epoch.epochId)
        .map((state) => ({
          epoch: state.epoch,
          entries: state.entries,
        }));
      if (epochViews.length === 0 && transcript.length === 0) {
        ctx.ui.notify("No conversation has reached the masking boundary yet", "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, keybindings, done) => epochViews.length > 0
        ? createEpochHistoryViewer(tui, theme, keybindings, epochViews, done)
        : createHistoryViewer(tui, theme, keybindings, transcript, done),
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
      });
    },
  });

}
