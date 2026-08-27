import {
  Box,
  Container,
  Markdown,
  Spacer,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { RuleEpoch, RuleEpochChange } from "./rule-epoch.ts";

type JsonRecord = Record<string, unknown>;

export interface MessageContentHashPair {
  /** Fingerprint of the source message before outbound masking. */
  original: string;
  /** Fingerprint of the exact model-facing message after outbound masking. */
  masked: string;
}

export interface TranscriptEntry {
  key: string;
  original: JsonRecord;
  masked: JsonRecord;
  capturedAt: number;
  /** The newest assistant response has not yet been included in a provider request. */
  pending?: boolean;
  /** Restored from a session that predates persisted model-input snapshots. */
  snapshotMissing?: boolean;
  /** Fingerprints of both stored copies; mergeTranscript may skip cloning only
   *  when the source and model-facing forms are both unchanged. */
  contentHashes?: MessageContentHashPair;
}

interface HistoryTheme {
  fg(color: any, text: string): string;
  bg(color: any, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  strikethrough?(text: string): string;
  underline?(text: string): string;
}

type ViewMode = "original" | "model" | "compare";

export interface DiffSegment {
  original: string;
  masked: string;
  changed: boolean;
}

interface Replacement {
  original: string;
  masked: string;
}

interface HistoryTui {
  terminal: { rows: number };
  requestRender(): void;
}

interface HistoryKeybindings {
  matches(data: string, keybinding: any): boolean;
}

export interface HistoryViewerOptions {
  title?: string;
  subtitle?: string;
  footerPrefix?: string;
}

export interface EpochHistoryView {
  epoch: RuleEpoch;
  entries: readonly TranscriptEntry[];
  current?: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A stable identity for the message shapes Pi sends through the context hook. */
export function transcriptKey(message: JsonRecord, index: number): string {
  const role = typeof message.role === "string" ? message.role : "unknown";
  if (role === "toolResult" && typeof message.toolCallId === "string") {
    return `tool:${message.toolCallId}`;
  }
  if (typeof message.timestamp === "number") return `${role}:${message.timestamp}`;
  return `${role}:index:${index}`;
}

function cloneMessage<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Keep one latest snapshot for every message that has reached the provider
 * boundary. Old entries are deliberately retained across compaction so the
 * viewer remains a session replay instead of only showing the current context.
 */
export function mergeTranscript(
  existing: TranscriptEntry[],
  originals: readonly JsonRecord[],
  masked: readonly JsonRecord[],
  capturedAt = Date.now(),
  contentHashes?: readonly (MessageContentHashPair | undefined)[],
): TranscriptEntry[] {
  const byKey = new Map(existing.map((entry) => [entry.key, entry]));
  const next = [...existing];

  for (let index = 0; index < originals.length; index++) {
    const original = originals[index]!;
    const maskedMessage = masked[index] ?? original;
    const key = transcriptKey(original, index);
    const hashes = contentHashes?.[index];
    const prior = byKey.get(key);
    if (prior) {
      // Flag transitions apply even when content is unchanged: a pending
      // assistant response is confirmed by reaching the provider boundary.
      prior.pending = false;
      prior.snapshotMissing = false;
      prior.capturedAt = capturedAt;
      // A source message can be remasked after a rule/toggle change without
      // changing its original fingerprint. Both stored copies are reusable
      // only when both fingerprints still match. Missing hashes (legacy
      // callers and restored v1 entries) take the safe re-clone path.
      if (
        !hashes ||
        prior.contentHashes?.original !== hashes.original ||
        prior.contentHashes.masked !== hashes.masked
      ) {
        prior.original = cloneMessage(original);
        prior.masked = cloneMessage(maskedMessage);
        prior.contentHashes = hashes;
      }
    } else {
      const entry: TranscriptEntry = {
        key,
        original: cloneMessage(original),
        masked: cloneMessage(maskedMessage),
        capturedAt,
        contentHashes: hashes,
      };
      next.push(entry);
      byKey.set(key, entry);
    }
  }
  return next;
}

/** Add the just-finished assistant response before its next outbound request. */
export function mergePendingAssistant(
  existing: TranscriptEntry[],
  original: JsonRecord,
  masked: JsonRecord,
  capturedAt = Date.now(),
): TranscriptEntry[] {
  const key = transcriptKey(original, existing.length);
  const prior = existing.find((entry) => entry.key === key);
  if (prior) {
    prior.original = cloneMessage(original);
    prior.masked = cloneMessage(masked);
    prior.capturedAt = capturedAt;
    prior.pending = true;
    return [...existing];
  }
  return [...existing, { key, original: cloneMessage(original), masked: cloneMessage(masked), capturedAt, pending: true }];
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!isRecord(block)) return String(block);
    if (block.type === "text") return typeof block.text === "string" ? block.text : "";
    if (block.type === "image") return `[image: ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}]`;
    return "";
  }).filter(Boolean).join("\n");
}

/** Split masked text into common and replaced spans without injecting markers. */
export function diffText(original: string, masked: string): DiffSegment[] {
  if (original === masked) return [{ original, masked, changed: false }];
  const maxWork = 32_000;
  if (original.length + masked.length > maxWork) return [{ original, masked, changed: true }];

  let before = original;
  let after = masked;
  const segments: DiffSegment[] = [];
  const push = (left: string, right: string, changed: boolean) => {
    if (left.length === 0 && right.length === 0) return;
    const prior = segments.at(-1);
    if (prior?.changed === changed) {
      prior.original += left;
      prior.masked += right;
    } else {
      segments.push({ original: left, masked: right, changed });
    }
  };

  while (before !== after && before.length > 0 && after.length > 0) {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    push(before.slice(0, prefix), after.slice(0, prefix), false);
    before = before.slice(prefix);
    after = after.slice(prefix);
    if (before === after) {
      push(before, after, false);
      return segments;
    }

    // Look for the next sufficiently useful shared fragment. The cap keeps a
    // long tool result from turning history rendering into quadratic work.
    let anchorOriginal = -1;
    let anchorMasked = -1;
    const scan = Math.min(before.length, 2_000);
    for (let start = 0; start < scan; start++) {
      const fragment = before.slice(start, start + 6);
      if (fragment.length < 3) break;
      const found = after.indexOf(fragment);
      if (found >= 0) {
        anchorOriginal = start;
        anchorMasked = found;
        break;
      }
    }
    if (anchorOriginal < 0) {
      push(before, after, true);
      return segments;
    }
    push(before.slice(0, anchorOriginal), after.slice(0, anchorMasked), true);
    before = before.slice(anchorOriginal);
    after = after.slice(anchorMasked);
  }
  push(before, after, before !== after);
  return segments;
}

function collectReplacements(original: unknown, masked: unknown, target: Map<string, Replacement>): void {
  if (typeof original === "string" && typeof masked === "string") {
    for (const segment of diffText(original, masked)) {
      if (!segment.changed || segment.original === segment.masked) continue;
      const key = `${segment.original}\0${segment.masked}`;
      if (!target.has(key)) target.set(key, { original: segment.original, masked: segment.masked });
    }
    return;
  }
  if (Array.isArray(original) && Array.isArray(masked)) {
    for (let index = 0; index < Math.max(original.length, masked.length); index++) {
      collectReplacements(original[index], masked[index], target);
    }
    return;
  }
  if (isRecord(original) && isRecord(masked)) {
    for (const key of new Set([...Object.keys(original), ...Object.keys(masked)])) {
      collectReplacements(original[key], masked[key], target);
    }
  }
}

function markdownTheme(theme: HistoryTheme) {
  return {
    heading: (text: string) => theme.fg("mdHeading", text),
    link: (text: string) => theme.fg("mdLink", text),
    linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
    code: (text: string) => theme.fg("mdCode", text),
    codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
    quote: (text: string) => theme.fg("mdQuote", text),
    quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
    hr: (text: string) => theme.fg("mdHr", text),
    listBullet: (text: string) => theme.fg("mdListBullet", text),
    bold: (text: string) => theme.bold(text),
    italic: (text: string) => theme.italic(text),
    strikethrough: (text: string) => theme.strikethrough?.(text) ?? text,
    underline: (text: string) => theme.underline?.(text) ?? text,
  };
}

function highlightSegment(
  segment: DiffSegment,
  side: "original" | "model",
  theme: HistoryTheme,
  baseColor: string,
  selected: Replacement | undefined,
): string {
  const value = side === "original" ? segment.original : segment.masked;
  if (!segment.changed) return theme.fg(baseColor, value);
  const isSelected = selected?.original === segment.original && selected.masked === segment.masked;
  const emphasized = isSelected ? theme.bold(theme.underline?.(value) ?? value) : value;
  return side === "original"
    ? theme.bg("toolErrorBg", theme.fg("warning", emphasized))
    : theme.bg("toolSuccessBg", theme.fg("success", emphasized));
}

function styledSide(
  original: string,
  masked: string,
  side: "original" | "model",
  theme: HistoryTheme,
  baseColor: string,
  selected: Replacement | undefined,
  italic: boolean,
): string {
  const rendered = diffText(original, masked)
    .map((segment) => highlightSegment(segment, side, theme, baseColor, selected))
    .join("");
  return italic ? theme.italic(rendered) : rendered;
}

function comparisonText(
  original: string,
  masked: string,
  theme: HistoryTheme,
  baseColor: string,
  selected: Replacement | undefined,
  italic: boolean,
): Component {
  return {
    invalidate: () => undefined,
    render: (width) => {
      const local = styledSide(original, masked, "original", theme, baseColor, selected, italic);
      const model = styledSide(original, masked, "model", theme, baseColor, selected, italic);
      if (width < 90) {
        return [
          theme.fg("muted", "LOCAL ORIGINAL"),
          ...new Text(local, 1, 0).render(width),
          theme.fg("muted", "MODEL INPUT"),
          ...new Text(model, 1, 0).render(width),
        ];
      }

      const gap = 3;
      const columnWidth = Math.max(20, Math.floor((width - gap) / 2));
      const left = [theme.fg("muted", "LOCAL ORIGINAL"), ...new Text(local, 0, 0).render(columnWidth)];
      const right = [theme.fg("muted", "MODEL INPUT"), ...new Text(model, 0, 0).render(columnWidth)];
      const lines: string[] = [];
      for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const leftLine = left[index] ?? "";
        const padding = " ".repeat(Math.max(0, columnWidth - visibleWidth(leftLine) + gap));
        lines.push(`${leftLine}${padding}${right[index] ?? ""}`);
      }
      return lines;
    },
  };
}

function addMessageText(
  container: { addChild(component: Component): void },
  original: string,
  masked: string,
  theme: HistoryTheme,
  style: "user" | "assistant" | "thinking",
  mode: ViewMode,
  selected: Replacement | undefined,
) {
  const baseColor = style === "user" ? "userMessageText" : style === "thinking" ? "thinkingText" : "text";
  const italic = style === "thinking";
  if (mode === "compare") {
    container.addChild(comparisonText(original, masked, theme, baseColor, selected, italic));
    return;
  }
  if (original === masked && !italic) {
    const text = mode === "original" ? original : masked;
    container.addChild(new Markdown(text, 1, 0, markdownTheme(theme), {
      color: (value) => theme.fg(baseColor as any, value),
    }));
    return;
  }
  container.addChild(new Text(
    styledSide(original, masked, mode, theme, baseColor, selected, italic),
    1,
    0,
  ));
}

function addToolCard(
  container: Container,
  call: JsonRecord,
  maskedCall: JsonRecord,
  result: TranscriptEntry | undefined,
  expanded: boolean,
  theme: HistoryTheme,
  mode: ViewMode,
  selected: Replacement | undefined,
) {
  const originalArguments = JSON.stringify(call.arguments ?? {}, null, 2);
  const maskedArguments = JSON.stringify(maskedCall.arguments ?? {}, null, 2);
  const card = new Box(1, 0, (text) => theme.bg("toolSuccessBg", text));
  const name = typeof call.name === "string" ? call.name : "tool";
  card.addChild(new Text(theme.fg("toolTitle", theme.bold(`▸ ${name}`))));
  addMessageText(card, originalArguments, maskedArguments, theme, "assistant", mode, selected);
  if (result) {
    const original = contentText(result.original.content);
    const masked = contentText(result.masked.content);
    const preview = expanded ? original : original.split("\n").slice(0, 10).join("\n");
    const previewMasked = expanded ? masked : masked.split("\n").slice(0, 10).join("\n");
    addMessageText(card, preview, previewMasked, theme, "assistant", mode, selected);
    const totalLines = Math.max(original.split("\n").length, masked.split("\n").length);
    if (!expanded && totalLines > 10) {
      card.addChild(new Text(theme.fg("dim", `… (${totalLines - 10} more lines, Ctrl+O to expand)`), 1, 0));
    }
    if (result.snapshotMissing) {
      card.addChild(new Text(theme.fg("warning", "Historical model-input snapshot is unavailable for this tool result."), 1, 0));
    }
  }
  container.addChild(card);
}

function addAssistant(
  container: Container,
  entry: TranscriptEntry,
  toolResults: ReadonlyMap<string, TranscriptEntry>,
  expanded: boolean,
  thinkingVisible: boolean,
  theme: HistoryTheme,
  mode: ViewMode,
  selected: Replacement | undefined,
) {
  const originalContent = Array.isArray(entry.original.content) ? entry.original.content : [];
  const maskedContent = Array.isArray(entry.masked.content) ? entry.masked.content : [];
  let thinkingRun: Array<[JsonRecord, JsonRecord]> = [];
  const flushThinking = () => {
    if (thinkingRun.length === 0) return;
    if (thinkingVisible) {
      const original = thinkingRun.map(([block]) => String(block.thinking ?? "")).join("\n");
      const masked = thinkingRun.map(([, block]) => String(block.thinking ?? "")).join("\n");
      addMessageText(container, original, masked, theme, "thinking", mode, selected);
    } else {
      container.addChild(new Text(theme.fg("thinkingText", theme.italic("Thinking...")), 1, 0));
    }
    thinkingRun = [];
  };

  for (let index = 0; index < originalContent.length; index++) {
    const original = originalContent[index];
    const masked = maskedContent[index];
    if (!isRecord(original)) continue;
    const maskedBlock = isRecord(masked) ? masked : original;
    if (original.type === "thinking") {
      thinkingRun.push([original, maskedBlock]);
      continue;
    }
    flushThinking();
    if (original.type === "text") {
      addMessageText(container, String(original.text ?? ""), String(maskedBlock.text ?? ""), theme, "assistant", mode, selected);
    } else if (original.type === "toolCall") {
      const id = typeof original.id === "string" ? original.id : "";
      addToolCard(container, original, maskedBlock, toolResults.get(`tool:${id}`), expanded, theme, mode, selected);
    }
  }
  flushThinking();
}

function renderTranscriptEntry(
  entry: TranscriptEntry,
  toolResults: ReadonlyMap<string, TranscriptEntry>,
  expanded: boolean,
  thinkingVisible: boolean,
  theme: HistoryTheme,
  mode: ViewMode,
  selected: Replacement | undefined,
): Component {
  const container = new Container();
  const role = entry.original.role;
  container.addChild(new Spacer(1));
  if (role === "user") {
    const box = new Box(0, 0, (text) => theme.bg("userMessageBg", text));
    box.addChild(new Text(theme.fg("muted", "You"), 1, 0));
    addMessageText(box, contentText(entry.original.content), contentText(entry.masked.content), theme, "user", mode, selected);
    container.addChild(box);
  } else if (role === "assistant") {
    container.addChild(new Text(theme.fg("accent", "Assistant"), 1, 0));
    addAssistant(container, entry, toolResults, expanded, thinkingVisible, theme, mode, selected);
    if (entry.pending) container.addChild(new Text(theme.fg("dim", "Not yet included in a subsequent model request."), 1, 0));
  } else {
    container.addChild(new Text(theme.fg("muted", `Unsupported message type: ${String(role)}`), 1, 0));
  }
  if (entry.snapshotMissing) {
    container.addChild(new Text(theme.fg("warning", "Historical model-input snapshot is unavailable for this message."), 1, 0));
  }
  return container;
}

function wheelDelta(data: string): number | undefined {
  const match = /\x1b\[<(64|65);\d+;\d+[Mm]/.exec(data);
  if (!match) return undefined;
  return match[1] === "64" ? -3 : 3;
}

/** A full-screen, read-only transcript viewer with Pi-compatible global toggles. */
export function createHistoryViewer(
  tui: HistoryTui,
  theme: HistoryTheme,
  keybindings: HistoryKeybindings,
  entries: readonly TranscriptEntry[],
  done: () => void,
  options: HistoryViewerOptions = {},
): Component {
  let toolsExpanded = false;
  let thinkingVisible = true;
  let viewMode: ViewMode = "original";
  let modeBeforeCompare: Exclude<ViewMode, "compare"> = "original";
  let replacementIndex = 0;
  let lastWidth = 80;
  let cacheVersion = 0;
  let position = { entry: 0, line: 0 };

  const toolResults = new Map(entries
    .filter((entry) => entry.original.role === "toolResult")
    .map((entry) => [entry.key, entry]));
  const displayEntries = entries.filter((entry) => entry.original.role !== "toolResult");
  const entryCache = new Map<number, { width: number; version: number; lines: string[] }>();

  const replacementMap = new Map<string, Replacement>();
  for (const entry of entries) collectReplacements(entry.original, entry.masked, replacementMap);
  const replacements = [...replacementMap.values()];
  const selectedReplacement = () => replacements[replacementIndex];

  const pageSize = () => Math.max(3, tui.terminal.rows - (options.subtitle ? 5 : 4));
  const entryLines = (index: number, width: number): string[] => {
    const cached = entryCache.get(index);
    if (cached?.width === width && cached.version === cacheVersion) return cached.lines;
    const entry = displayEntries[index];
    if (!entry) return [];
    const lines = renderTranscriptEntry(
      entry,
      toolResults,
      toolsExpanded,
      thinkingVisible,
      theme,
      viewMode,
      selectedReplacement(),
    ).render(width);
    entryCache.set(index, { width, version: cacheVersion, lines });
    return lines;
  };

  const advance = (start: typeof position, amount: number, width: number) => {
    const next = { ...start };
    while (amount > 0 && next.entry < displayEntries.length) {
      const lines = entryLines(next.entry, width);
      const remaining = Math.max(0, lines.length - next.line);
      if (amount < remaining) {
        next.line += amount;
        return next;
      }
      amount -= remaining;
      next.entry++;
      next.line = 0;
    }
    return next;
  };

  const retreat = (start: typeof position, amount: number, width: number) => {
    const next = { ...start };
    while (amount > 0 && (next.entry > 0 || next.line > 0)) {
      if (next.line === 0) {
        next.entry--;
        next.line = entryLines(next.entry, width).length;
      }
      const step = Math.min(amount, next.line);
      next.line -= step;
      amount -= step;
    }
    return next;
  };

  const move = (amount: number) => {
    position = amount < 0
      ? retreat(position, -amount, lastWidth)
      : advance(position, amount, lastWidth);
  };

  const toggleModelView = () => {
    if (viewMode === "compare") viewMode = modeBeforeCompare;
    viewMode = viewMode === "original" ? "model" : "original";
    modeBeforeCompare = viewMode;
    cacheVersion++;
  };

  const toggleCompareView = () => {
    if (viewMode === "compare") viewMode = modeBeforeCompare;
    else {
      modeBeforeCompare = viewMode;
      viewMode = "compare";
    }
    cacheVersion++;
  };

  const visiblePage = (width: number) => {
    const renderFromPosition = () => {
      while (position.entry < displayEntries.length) {
        const lines = entryLines(position.entry, width);
        if (position.line < lines.length) break;
        position = { entry: position.entry + 1, line: 0 };
      }
      const visible: string[] = [];
      let cursor = { ...position };
      while (visible.length < pageSize() && cursor.entry < displayEntries.length) {
        const lines = entryLines(cursor.entry, width);
        const take = Math.min(pageSize() - visible.length, Math.max(0, lines.length - cursor.line));
        visible.push(...lines.slice(cursor.line, cursor.line + take));
        cursor.line += take;
        if (cursor.line >= lines.length) cursor = { entry: cursor.entry + 1, line: 0 };
      }
      return { visible, cursor };
    };

    let page = renderFromPosition();
    if (page.cursor.entry === displayEntries.length && page.visible.length < pageSize()) {
      position = retreat({ entry: displayEntries.length, line: 0 }, pageSize(), width);
      page = renderFromPosition();
    }
    return page;
  };

  return {
    invalidate: () => {
      cacheVersion++;
      entryCache.clear();
    },
    render: (width) => {
      lastWidth = width;
      const { visible, cursor } = visiblePage(width);
      const modeLabel = viewMode === "original" ? "LOCAL ORIGINAL" : viewMode === "model" ? "MODEL INPUT" : "SIDE-BY-SIDE COMPARE";
      const title = options.title ?? `Masking history · ${entries.length} messages`;
      const header = theme.fg("accent", theme.bold(`${title} · ${modeLabel}`));
      const visibleEnd = Math.min(cursor.entry + (cursor.line > 0 ? 1 : 0), displayEntries.length);
      const progress = displayEntries.length > 0
        ? ` messages ${Math.min(position.entry + 1, displayEntries.length)}-${visibleEnd}/${displayEntries.length}`
        : "";
      const selected = selectedReplacement();
      const inspector = selected
        ? `Replacement ${replacementIndex + 1}/${replacements.length}  LOCAL: ${selected.original}  →  MODEL: ${selected.masked}`
        : "No masking replacements in this session";
      const legend = viewMode === "original"
        ? "Highlighted text is sensitive local content replaced before the model request"
        : viewMode === "model"
          ? "Highlighted text is the replacement sent to the model"
          : "Left: local original · Right: model input · highlighted spans differ";
      const footerPrefix = options.footerPrefix ? `${options.footerPrefix} · ` : "";
      const footer = `${footerPrefix}↑↓/PgUp/PgDn scroll · Ctrl+M or M model · C compare · N/P mapping · Ctrl+O tools · Ctrl+T thinking · Esc close${progress}`;
      const lines = [
        truncateToWidth(header, width),
        ...(options.subtitle ? [theme.fg("muted", truncateToWidth(options.subtitle, width))] : []),
        theme.fg("dim", truncateToWidth(legend, width)),
        ...visible,
        theme.fg("muted", truncateToWidth(inspector, width)),
        theme.fg("dim", truncateToWidth(footer, width)),
      ];
      return [...lines, ...Array(Math.max(0, tui.terminal.rows - lines.length)).fill("")];
    },
    handleInput: (data) => {
      const wheel = wheelDelta(data);
      if (wheel !== undefined) move(wheel);
      else if (keybindings.matches(data, "app.tools.expand")) {
        toolsExpanded = !toolsExpanded;
        cacheVersion++;
      }
      else if (keybindings.matches(data, "app.thinking.toggle")) {
        thinkingVisible = !thinkingVisible;
        cacheVersion++;
      }
      else if (data === "m" || data === "M" || matchesKey(data, "ctrl+m")) toggleModelView();
      else if (data === "c" || data === "C") toggleCompareView();
      else if ((data === "n" || data === "N") && replacements.length > 0) {
        replacementIndex = (replacementIndex + 1) % replacements.length;
        cacheVersion++;
      }
      else if ((data === "p" || data === "P") && replacements.length > 0) {
        replacementIndex = (replacementIndex - 1 + replacements.length) % replacements.length;
        cacheVersion++;
      }
      else if (keybindings.matches(data, "tui.select.up")) move(-1);
      else if (keybindings.matches(data, "tui.select.down")) move(1);
      else if (keybindings.matches(data, "tui.select.pageUp")) move(-pageSize());
      else if (keybindings.matches(data, "tui.select.pageDown")) move(pageSize());
      else if (data === "\x1b[H" || data === "\x1bOH") position = { entry: 0, line: 0 };
      else if (data === "\x1b[F" || data === "\x1bOF") position = { entry: displayEntries.length, line: 0 };
      else if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) done();
      else return;
      tui.requestRender();
    },
  };
}

function epochChangeLabel(change: RuleEpochChange): string {
  const rule = change.ruleName ?? change.ruleId ?? "rule";
  switch (change.kind) {
    case "initialized": return "session start";
    case "masking_enabled": return "masking enabled";
    case "masking_disabled": return "masking disabled";
    case "option_changed": return `${change.option ?? "option"} changed`;
    case "rule_added": return `${rule} added`;
    case "rule_removed": return `${rule} removed`;
    case "rule_enabled": return `${rule} enabled`;
    case "rule_disabled": return `${rule} disabled`;
    case "rule_moved": return `${rule} reordered`;
    case "rule_updated": return `${rule} updated`;
    case "configuration_changed": return "configuration changed";
  }
}

function epochLabel(view: EpochHistoryView, index: number, total: number): string {
  return `Masking history · E${view.epoch.epochId} (${index + 1}/${total}) · ${view.entries.length} factual messages`;
}

function epochDetails(view: EpochHistoryView): string {
  const changeSummary = view.epoch.changes.map(epochChangeLabel).join("; ");
  const activated = new Date(view.epoch.activatedAt).toLocaleString();
  const status = view.current ? "current" : "closed";
  return `${status} · activated ${activated} · ${view.epoch.reason} · fingerprint ${view.epoch.behaviorFingerprint.slice(0, 12)} · ${changeSummary}`;
}

/**
 * Epoch selector around the transcript viewer. Empty/unused epochs are hidden;
 * the newest epoch with factual outbound observations is selected by default.
 */
export function createEpochHistoryViewer(
  tui: HistoryTui,
  theme: HistoryTheme,
  keybindings: HistoryKeybindings,
  epochViews: readonly EpochHistoryView[],
  done: () => void,
): Component {
  const views = epochViews.filter((view) => view.entries.length > 0);
  let selectedIndex = Math.max(0, views.length - 1);
  const createSelected = (): Component => {
    const view = views[selectedIndex];
    return createHistoryViewer(
      tui,
      theme,
      keybindings,
      view?.entries ?? [],
      done,
      {
        title: view
          ? epochLabel(view, selectedIndex, views.length)
          : "Masking history · no factual epochs",
        subtitle: view ? epochDetails(view) : undefined,
        footerPrefix: views.length > 1 ? "[/] rule epoch" : undefined,
      },
    );
  };
  let selected = createSelected();

  return {
    invalidate: () => selected.invalidate?.(),
    render: (width) => selected.render(width),
    handleInput: (data) => {
      const delta = data === "[" ? -1 : data === "]" ? 1 : 0;
      if (delta === 0 || views.length < 2) {
        selected.handleInput?.(data);
        return;
      }
      const next = Math.max(0, Math.min(views.length - 1, selectedIndex + delta));
      if (next === selectedIndex) return;
      selectedIndex = next;
      selected = createSelected();
      tui.requestRender();
    },
  };
}
