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
import type { MaskDetail, DetailValue, DynamicPlaceholderMap } from "./masker.ts";
import { loadConfig, watchConfigs } from "./config-loader.ts";
import type { MaskingConfig } from "./config-loader.ts";
import { generateSessionKey } from "./placeholder-gen.ts";

// ─── Types ──────────────────────────────────────────────────────────────────



interface HistoryEntry {
  time: string;
  masked: number;
  details: MaskDetail[];
}

// Mutable accumulator for a single round's stats: grouped by ruleId, then
// deduplicated by real value within each group.
interface RoundAccEntry {
  description?: string;
  counts: Map<string, number>; // real → occurrences
  order: string[]; // first-seen order of real values
}

// Max number of distinct values shown per rule in the panel, to avoid the
// panel ballooning when a rule hits many different values.
const MAX_DISPLAY_VALUES = 4;

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
    options: { caseSensitive: true, showStatusBar: true },
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

  const history: HistoryEntry[] = [];
  const MAX_HISTORY = 30;

  // Per-round mask stats.
  // lastContextLength: number of messages already processed, used by each
  // context event to find newly added messages and avoid double-counting
  // history across turns. Reset only on session_start.
  let lastContextLength = 0;
  let currentRoundMaskCount = 0;
  const currentRoundAcc = new Map<string, RoundAccEntry>();

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** Build a new Masker from the current config.options, sessionKey, and dynamicPlaceholderMap */
  function buildMasker(rules: MaskingConfig["rules"]): Masker {
    return new Masker(rules, config.options.caseSensitive, sessionKey, dynamicPlaceholderMap);
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

  function mergeMaskDetailInto(d: MaskDetail) {
    let entry = currentRoundAcc.get(d.ruleId);
    if (!entry) {
      entry = { description: d.description, counts: new Map(), order: [] };
      currentRoundAcc.set(d.ruleId, entry);
    }
    for (const v of d.values) {
      if (!entry.counts.has(v.real)) entry.order.push(v.real);
      entry.counts.set(v.real, (entry.counts.get(v.real) ?? 0) + v.occurrences);
    }
  }

  function finalizeRoundDetails(): MaskDetail[] {
    const out: MaskDetail[] = [];
    for (const [ruleId, entry] of currentRoundAcc) {
      out.push({
        ruleId,
        description: entry.description,
        values: entry.order.map((real) => ({
          real,
          occurrences: entry.counts.get(real)!,
        })),
      });
    }
    return out;
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

    const cfg = await loadConfig(ctx.cwd, sessionKey);
    const warnings = rebuild(cfg);
    notifyWarnings(ctx, warnings);

    stopWatching = watchConfigs(ctx.cwd, async () => {
      // Hot reload: reuse the current session's sessionKey and dynamicPlaceholderMap
      const reloaded = await loadConfig(ctx.cwd, sessionKey);
      const reloadWarnings = rebuild(reloaded);
      resetRoundCounters();
      ctx.ui.notify(
        `🔒 Masking config reloaded (${reloaded.rules.length} rule(s))`,
        "info"
      );
      notifyWarnings(ctx, reloadWarnings);
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

  pi.on("context", async (event, _ctx) => {
    if (!config.enabled || config.rules.length === 0) return;

    const messages = event.messages;

    // Only count newly added messages: the LLM API resends the full history
    // on every request, so counting all messages would double-count history
    // across turns.
    const newMessages = messages.slice(lastContextLength);
    lastContextLength = messages.length;

    for (const msg of newMessages) {
      const { count, details } = masker.maskValue(msg);
      currentRoundMaskCount += count;
      details.forEach((d) => mergeMaskDetailInto(d));
    }

    // Mask everything (including history) before returning to the LLM, so
    // it only ever sees placeholders.
    const maskedMessages = messages.map(
      (msg) => masker.maskValue(msg).value
    );
    return { messages: maskedMessages as typeof event.messages };
  });

  // ── Hook 2: message_end — inbound unmasking ───────────────────────────────

  pi.on("message_end", async (event, ctx) => {
    if (!config.enabled || config.rules.length === 0) return;

    const role = (event.message as any).role;
    if (role !== "assistant") return;

    // Restore real values before storing, so the user always sees the real data
    const { message } = unmaskMessage(event.message, masker);

    // Show this round's mask stats panel
    if (currentRoundMaskCount > 0) {
      const time = nowTime();
      const details = finalizeRoundDetails();
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
      // Rule set changed — reset stats and the history pointer to avoid mixing old/new state
      resetRoundCounters();
      lastContextLength = 0;
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
      const cfg = await loadConfig(ctx.cwd, sessionKey);
      const warnings = rebuild(cfg);
      resetRoundCounters();
      ctx.ui.notify(
        `Config reloaded: ${cfg.rules.length} rule(s), masking ${cfg.enabled ? "enabled" : "disabled"}`,
        "info"
      );
      notifyWarnings(ctx, warnings);
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
}
