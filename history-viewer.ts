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

type JsonRecord = Record<string, unknown>;

export interface TranscriptEntry {
  key: string;
  original: JsonRecord;
  masked: JsonRecord;
  capturedAt: number;
  /** The newest assistant response has not yet been included in a provider request. */
  pending?: boolean;
  /** Restored from a session that predates persisted model-input snapshots. */
  snapshotMissing?: boolean;
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
): TranscriptEntry[] {
  const byKey = new Map(existing.map((entry) => [entry.key, entry]));
  const next = [...existing];

  for (let index = 0; index < originals.length; index++) {
    const original = originals[index]!;
    const maskedMessage = masked[index] ?? original;
    const key = transcriptKey(original, index);
    const prior = byKey.get(key);
    if (prior) {
      prior.original = cloneMessage(original);
      prior.masked = cloneMessage(maskedMessage);
      prior.capturedAt = capturedAt;
      prior.pending = false;
      prior.snapshotMissing = false;
    } else {
      const entry: TranscriptEntry = {
        key,
        original: cloneMessage(original),
        masked: cloneMessage(maskedMessage),
        capturedAt,
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
  toolResults: Map<string, TranscriptEntry>,
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

function renderTranscript(
  entries: TranscriptEntry[],
  expanded: boolean,
  thinkingVisible: boolean,
  theme: HistoryTheme,
  mode: ViewMode,
  selected: Replacement | undefined,
): Component {
  const container = new Container();
  const toolResults = new Map(entries.filter((entry) => entry.original.role === "toolResult").map((entry) => [entry.key, entry]));
  for (const entry of entries) {
    const role = entry.original.role;
    if (role === "toolResult") continue; // rendered beneath its tool call
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
): Component {
  let scrollOffset = 0;
  let toolsExpanded = false;
  let thinkingVisible = true;
  let viewMode: ViewMode = "original";
  let modeBeforeCompare: Exclude<ViewMode, "compare"> = "original";
  let lastBodyLines: string[] = [];
  let replacementIndex = 0;

  const replacementMap = new Map<string, Replacement>();
  for (const entry of entries) collectReplacements(entry.original, entry.masked, replacementMap);
  const replacements = [...replacementMap.values()];
  const selectedReplacement = () => replacements[replacementIndex];

  const pageSize = () => Math.max(3, tui.terminal.rows - 4);
  const scroll = (amount: number) => {
    scrollOffset = Math.max(0, Math.min(Math.max(0, lastBodyLines.length - pageSize()), scrollOffset + amount));
  };

  const toggleModelView = () => {
    if (viewMode === "compare") viewMode = modeBeforeCompare;
    viewMode = viewMode === "original" ? "model" : "original";
    modeBeforeCompare = viewMode;
  };

  const toggleCompareView = () => {
    if (viewMode === "compare") viewMode = modeBeforeCompare;
    else {
      modeBeforeCompare = viewMode;
      viewMode = "compare";
    }
  };

  return {
    invalidate: () => undefined,
    render: (width) => {
      const body = renderTranscript(
        [...entries],
        toolsExpanded,
        thinkingVisible,
        theme,
        viewMode,
        selectedReplacement(),
      );
      lastBodyLines = body.render(width);
      scroll(0);
      const visible = lastBodyLines.slice(scrollOffset, scrollOffset + pageSize());
      const modeLabel = viewMode === "original" ? "LOCAL ORIGINAL" : viewMode === "model" ? "MODEL INPUT" : "SIDE-BY-SIDE COMPARE";
      const header = theme.fg("accent", theme.bold(`Masking history · ${entries.length} messages · ${modeLabel}`));
      const progress = lastBodyLines.length > pageSize()
        ? ` ${scrollOffset + 1}-${Math.min(lastBodyLines.length, scrollOffset + pageSize())}/${lastBodyLines.length}`
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
      const footer = `↑↓/PgUp/PgDn scroll · Ctrl+M or M model · C compare · N/P mapping · Ctrl+O tools · Ctrl+T thinking · Esc close${progress}`;
      const lines = [
        truncateToWidth(header, width),
        theme.fg("dim", truncateToWidth(legend, width)),
        ...visible,
        theme.fg("muted", truncateToWidth(inspector, width)),
        theme.fg("dim", truncateToWidth(footer, width)),
      ];
      return [...lines, ...Array(Math.max(0, tui.terminal.rows - lines.length)).fill("")];
    },
    handleInput: (data) => {
      const wheel = wheelDelta(data);
      if (wheel !== undefined) scroll(wheel);
      else if (keybindings.matches(data, "app.tools.expand")) toolsExpanded = !toolsExpanded;
      else if (keybindings.matches(data, "app.thinking.toggle")) thinkingVisible = !thinkingVisible;
      else if (data === "m" || data === "M" || matchesKey(data, "ctrl+m")) toggleModelView();
      else if (data === "c" || data === "C") toggleCompareView();
      else if ((data === "n" || data === "N") && replacements.length > 0) {
        replacementIndex = (replacementIndex + 1) % replacements.length;
      }
      else if ((data === "p" || data === "P") && replacements.length > 0) {
        replacementIndex = (replacementIndex - 1 + replacements.length) % replacements.length;
      }
      else if (keybindings.matches(data, "tui.select.up")) scroll(-1);
      else if (keybindings.matches(data, "tui.select.down")) scroll(1);
      else if (keybindings.matches(data, "tui.select.pageUp")) scroll(-pageSize());
      else if (keybindings.matches(data, "tui.select.pageDown")) scroll(pageSize());
      else if (data === "\x1b[H" || data === "\x1bOH") scrollOffset = 0;
      else if (data === "\x1b[F" || data === "\x1bOF") scroll(lastBodyLines.length);
      else if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) done();
      else return;
      tui.requestRender();
    },
  };
}
