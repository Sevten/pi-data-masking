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
 *    leak back to the LLM. Stats count only user/tool messages.
 *
 * Session key:
 *  - A random sessionKey is generated on session_start
 *  - It stays the same for the whole session (including hot reloads,
 *    /masking-reload, /masking-toggle)
 *  - This guarantees the same real value always maps to the same placeholder
 *    within a session
 *
 * Dynamic placeholder map (regex rules only):
 *  - Real values matched by regex rules aren't known at config-load time, so
 *    masker.ts generates their placeholders at runtime and records them in
 *    dynamicPlaceholderMap.
 *  - dynamicPlaceholderMap shares its lifecycle with sessionKey: created
 *    (cleared) only on session_start; every other path (hot reload,
 *    /masking-reload, /masking-toggle) reuses the same Map reference when
 *    constructing a new Masker, so dynamically generated placeholders stay
 *    stable across rule changes or toggling — only a brand-new session
 *    resets them.
 *
 * Stats:
 *  - Only mask (outbound) counts are tracked — i.e. how many sensitive
 *    values were intercepted before reaching the LLM
 *  - Each context event counts only newly added messages, to avoid
 *    double-counting history across multiple turns
 *  - Covers both user-sent messages and tool results sent back to the LLM
 *  - A single regex rule may hit several distinct real values; stats are
 *    grouped by rule, then broken down per distinct value within the group
 *
 * Stats panel: shown after each AI turn, listing the rules triggered this
 * round and their counts:
 *   description  preview×N  preview×N  ...
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Masker, isRegexRule, makePreview } from "./masker.ts";
import type { MaskDetail, DetailValue, DynamicPlaceholderMap, MaskOptions } from "./masker.ts";
import { loadConfig, watchConfigs } from "./config-loader.ts";
import type { MaskingConfig } from "./config-loader.ts";
import { generateSessionKey } from "./placeholder-gen.ts";
import { mergeDetailInto, finalizeDetails, type DetailAccumulator } from "./details.ts";

// ─── Types ──────────────────────────────────────────────────────────────────



interface HistoryEntry {
  time: string;
  masked: number;
  details: MaskDetail[];
}

// Max number of distinct values shown per rule in the panel, to avoid the
// panel ballooning when a rule hits many different values.
const MAX_DISPLAY_VALUES = 4;

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

/** Format all distinct real values hit by a rule as "preview***×N  preview***×N  ..." */
function formatDetailValues(values: DetailValue[]): string {
  const shown = values.slice(0, MAX_DISPLAY_VALUES);
  const parts = shown.map((v) => `${makePreview(v.real)}×${v.occurrences}`);
  if (values.length > MAX_DISPLAY_VALUES) {
    parts.push(`...+${values.length - MAX_DISPLAY_VALUES} more`);
  }
  return parts.join("  ");
}

/**
 * Build the stats panel: which rules fired, and the preview + count for
 * each distinct real value. Placeholders are never shown — they're an
 * implementation detail; what the user needs to confirm is which real
 * values were intercepted, not what they became. A single regex rule
 * hitting several distinct values shows each one separately (up to 4).
 */
function buildPanelLines(
  count: number,
  details: MaskDetail[],
  time: string
): string[] {
  if (count === 0) return [];

  const header = `🔒 Masked ${count} value(s)  ·  ${time}`;
  const rows = details.map((d) => {
    const label = (d.description ?? d.ruleId).padEnd(20);
    return `  ${label}  ${formatDetailValues(d.values)}`;
  });

  return [header, ...rows];
}

function statusLabel(cfg: MaskingConfig): string {
  return cfg.enabled
    ? `🔒 Masking: ${cfg.rules.length} rule(s)`
    : `🔓 Masking: off`;
}

// ─── Extension entry point ──────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  let config: MaskingConfig = {
    enabled: false,
    rules: [],
    options: { caseSensitive: true, showStatusBar: true, systemPromptGuidance: false },
  };
  let masker = new Masker([], true);
  let stopWatching: (() => void) | null = null;
  let widgetTimer: ReturnType<typeof setTimeout> | null = null;

  // Session key: generated on session_start, stays constant for the whole
  // session (including hot reloads). Pre-initialized to a valid value to
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

  const history: HistoryEntry[] = [];

  // One-time-per-session warning flags (reset on session_start)
  let fallbackNotifiedThisTurn = false;
  let systemPromptWarned = false;
  let dynamicMapWarned = false;
  let inventedMapWarned = false;
  const MAX_HISTORY = 30;

  // Per-round mask stats.
  // lastContextLength: number of messages already processed, used by each
  // context event to find newly added messages and avoid double-counting
  // history across turns. Reset only on session_start.
  let lastContextLength = 0;
  let currentRoundMaskCount = 0;
  const currentRoundAcc = new Map<string, DetailAccumulator>();

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

  function notifyWarnings(ctx: ExtensionContext, warnings: string[]) {
    for (const w of warnings) ctx.ui.notify(`⚠️ ${w}`, "info");
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!config.options.showStatusBar) return;
    ctx.ui.setStatus("masking", statusLabel(config));
  }

  function showPanel(ctx: ExtensionContext, lines: string[]) {
    if (lines.length === 0) return;
    ctx.ui.setWidget("masking-report", lines, { placement: "belowEditor" });
    if (widgetTimer) clearTimeout(widgetTimer);
    widgetTimer = setTimeout(() => {
      ctx.ui.setWidget("masking-report", undefined);
    }, 20_000);
  }

  function pushHistory(entry: HistoryEntry) {
    history.unshift(entry);
    if (history.length > MAX_HISTORY) history.pop();
  }

  function resetRoundCounters() {
    currentRoundMaskCount = 0;
    currentRoundAcc.clear();
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    stopWatching?.();
    history.length = 0;
    lastContextLength = 0;
    resetRoundCounters();

    // Generate a fresh key and clear the dynamic map on every new session;
    // hot reload / manual reload / toggle all reuse the same sessionKey and
    // dynamicPlaceholderMap reference so mappings (including dynamically
    // generated regex placeholders) stay stable within a session.
    sessionKey = generateSessionKey();
    dynamicPlaceholderMap = new Map();
    llmInventedValues = new Set();
    protectedValues = new Set();
    fallbackNotifiedThisTurn = false;
    systemPromptWarned = false;
    dynamicMapWarned = false;
    inventedMapWarned = false;

    const { config: cfg, warnings } = await loadConfig(ctx.cwd, sessionKey);
    const compileWarnings = rebuild(cfg);
    notifyWarnings(ctx, [...warnings, ...compileWarnings]);

    stopWatching = watchConfigs(ctx.cwd, async () => {
      // Hot reload: reuse the current session's sessionKey and dynamicPlaceholderMap
      const reloaded = await loadConfig(ctx.cwd, sessionKey);
      const reloadWarnings = rebuild(reloaded.config);
      resetRoundCounters();
      ctx.ui.notify(
        `🔒 Masking config reloaded (${reloaded.config.rules.length} rule(s))`,
        "info"
      );
      notifyWarnings(ctx, [...reloaded.warnings, ...reloadWarnings]);
      updateStatus(ctx);
    });

    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopWatching?.();
    stopWatching = null;
    if (widgetTimer) clearTimeout(widgetTimer);
  });

  // ── Hook 1: context — outbound masking ────────────────────────────────────

  pi.on("context", async (event, ctx) => {
    if (!config.enabled || config.rules.length === 0) return;

    const messages = event.messages;

    // Only count newly added messages: the LLM API resends the full history
    // on every request, so counting all messages would double-count history
    // across turns.
    const newMessages = messages.slice(lastContextLength);
    lastContextLength = messages.length;

    for (const msg of newMessages) {
      const role = (msg as { role?: string }).role;
      const isAssistant = role === "assistant";
      const { count, details } = masker.maskValue(msg, maskOptionsForRole(role));
      // Only user-sent messages and tool results count toward the stats:
      // assistant-history re-masking is provenance bookkeeping, and
      // LLM-invented values are never registered or counted.
      if (!isAssistant) {
        currentRoundMaskCount += count;
        details.forEach((d) => mergeDetailInto(currentRoundAcc, d));
      }
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

    // Mask everything (including history) before returning to the LLM, so
    // it only ever sees placeholders for protected values.
    const maskedMessages = messages.map((msg) =>
      masker.maskValue(msg, maskOptionsForRole((msg as { role?: string }).role)).value
    );
    return { messages: maskedMessages as typeof event.messages };
  });

  // ── Hook 2: message_end — inbound unmasking ───────────────────────────────

  pi.on("message_end", async (event, ctx) => {
    if (!config.enabled || config.rules.length === 0) return;

    if (event.message.role !== "assistant") return;

    // Restore real values before storing, so the user always sees the real data
    const { message } = unmaskMessage(event.message, masker);

    // Show this round's mask stats panel
    if (currentRoundMaskCount > 0) {
      const time = nowTime();
      const details = finalizeDetails(currentRoundAcc);
      pushHistory({ time, masked: currentRoundMaskCount, details });
      showPanel(ctx, buildPanelLines(currentRoundMaskCount, details, time));
      resetRoundCounters();
    }

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
    // No extra notification needed — mask stats are already shown in the message_end panel
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

  // ── Hook 7: session_compact — reset the history pointer for sane stats ─────

  pi.on("session_compact", async () => {
    lastContextLength = 0;
    resetRoundCounters();
  });

  // ── Command: /masking-status ─────────────────────────────────────────────

  pi.registerCommand("masking-status", {
    description: "Show data masking extension status",
    handler: async (_args, ctx) => {
      const state = config.enabled ? "✅ enabled" : "❌ disabled";
      const info =
        config.rules.length === 0
          ? "(no rules configured)"
          : `(${config.rules.length} rule(s))`;
      ctx.ui.notify(`Data masking ${state} ${info}`, "info");
    },
  });

  // ── Command: /masking-list ───────────────────────────────────────────────

  pi.registerCommand("masking-list", {
    description: "List all masking rules (real values not shown)",
    handler: async (_args, ctx) => {
      if (config.rules.length === 0) {
        ctx.ui.notify("No masking rules configured — check masking.config.json", "info");
        return;
      }
      const lines = config.rules.map((r, i) => {
        const desc = r.description ? `  —  ${r.description}` : "";
        if (isRegexRule(r)) {
          // Regex rules have no fixed placeholder (real values are only
          // known at runtime); show the pattern itself instead.
          return `${String(i + 1).padStart(2)}. [regex] /${r.pattern}/${r.flags ?? ""}${desc}`;
        }
        return `${String(i + 1).padStart(2)}. ${r.placeholder}${desc}`;
      });
      ctx.ui.setWidget("masking-rules-list", [
        `Rules (${config.rules.length}, in priority order)`,
        ...lines,
      ]);
    },
  });

  // ── Command: /masking-history ────────────────────────────────────────────

  pi.registerCommand("masking-history", {
    description: "View this session's masking history",
    handler: async (_args, ctx) => {
      if (history.length === 0) {
        ctx.ui.notify("No masking activity yet this session", "info");
        return;
      }
      const lines: string[] = [`📋 Masking history (${history.length} entries)`];
      for (const entry of history) {
        lines.push(`─── ${entry.time}  ${entry.masked} masked`);
        for (const d of entry.details) {
          const label = (d.description ?? d.ruleId).padEnd(20);
          lines.push(`    ${label}  ${formatDetailValues(d.values)}`);
        }
      }
      ctx.ui.setWidget("masking-history", lines);
    },
  });

  // ── Command: /masking-toggle ──────────────────────────────────────────────

  pi.registerCommand("masking-toggle", {
    description: "Toggle masking on/off temporarily (doesn't modify the config file)",
    handler: async (_args, ctx) => {
      config = { ...config, enabled: !config.enabled };
      masker = buildMasker(config.enabled ? config.rules : []);
      // Rule set changed — reset stats; keep lastContextLength so messages
      // sent while disabled are counted exactly once on re-enable.
      resetRoundCounters();
      ctx.ui.notify(`Data masking ${config.enabled ? "enabled" : "disabled"}`, "info");
      notifyWarnings(ctx, masker.warnings);
      updateStatus(ctx);
    },
  });

  // ── Command: /masking-reload ──────────────────────────────────────────────

  pi.registerCommand("masking-reload", {
    description: "Manually reload the masking config file",
    handler: async (_args, ctx) => {
      // Reuse the current session's sessionKey and dynamicPlaceholderMap so
      // placeholder mappings (including dynamic regex ones) stay stable
      const { config: cfg, warnings } = await loadConfig(ctx.cwd, sessionKey);
      const compileWarnings = rebuild(cfg);
      resetRoundCounters();
      ctx.ui.notify(
        `Config reloaded: ${cfg.rules.length} rule(s), masking ${cfg.enabled ? "enabled" : "disabled"}`,
        "info"
      );
      notifyWarnings(ctx, [...warnings, ...compileWarnings]);
      updateStatus(ctx);
    },
  });

  // ── Command: /masking-clear ───────────────────────────────────────────────

  pi.registerCommand("masking-clear", {
    description: "Close the currently displayed masking panel",
    handler: async (_args, ctx) => {
      if (widgetTimer) clearTimeout(widgetTimer);
      ctx.ui.setWidget("masking-report", undefined);
      ctx.ui.setWidget("masking-history", undefined);
      ctx.ui.setWidget("masking-rules-list", undefined);
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
    },
  });
}
