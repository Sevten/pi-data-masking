import {
  Box,
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { summarizeEpochNetChanges, type RuleEpoch, type RuleEpochChange } from "./rule-epoch.ts";

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
  inverse?(text: string): string;
  strikethrough?(text: string): string;
  underline?(text: string): string;
}

export type HistoryViewMode = "original" | "model" | "compare";

export interface HistoryViewState {
  mode: HistoryViewMode;
  modeBeforeCompare: Exclude<HistoryViewMode, "compare">;
}

export interface DiffSegment {
  original: string;
  masked: string;
  changed: boolean;
}

interface Replacement {
  original: string;
  masked: string;
  /** Visible transcript entry containing this factual occurrence. */
  entryIndex: number;
  /** Changed span index in that entry's rendered text. */
  entryOccurrenceIndex: number;
  /** Full tool output is needed to preserve and reveal this rendered location. */
  requiresToolsExpanded?: boolean;
}

interface RenderSelection {
  targetOccurrence?: number;
  nextOccurrence: number;
  comparisonHeaderShown?: boolean;
}

// Internal zero-width anchor used only to locate the selected occurrence after
// Text has wrapped it. entryRender() strips it before any line reaches the TUI.
const SELECTED_OCCURRENCE_ANCHOR = "\u2063\u200b\u2063";

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
  /** Shared by the rule-version wrapper so switching versions preserves view mode. */
  viewState?: HistoryViewState;
}

export interface EpochHistoryView {
  epoch: RuleEpoch;
  entries: readonly TranscriptEntry[];
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
    // A shared prefix that ends inside a word can belong to the replacement
    // itself (for example the leading `m` in mysecret → maskedsecret). Keep
    // stable punctuation/context, but move the tentative boundary back to the
    // beginning of that lexical token before recording the changed span.
    if (
      prefix > 0 && prefix < before.length && prefix < after.length &&
      WORD_CHARACTER.test(before[prefix - 1] ?? "") &&
      WORD_CHARACTER.test(before[prefix] ?? "") &&
      WORD_CHARACTER.test(after[prefix] ?? "")
    ) {
      while (
        prefix > 0 &&
        WORD_CHARACTER.test(before[prefix - 1] ?? "") &&
        WORD_CHARACTER.test(after[prefix - 1] ?? "")
      ) prefix--;
    }
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
      // Prefix rewinding can leave the same shared fragment at offset zero in
      // both strings. Accepting that (0, 0) anchor would slice away nothing
      // and repeat this loop forever, so every anchor must advance at least
      // one side of the comparison.
      if (
        found >= 0 && (start > 0 || found > 0) &&
        isContextAnchor(before, start) && isContextAnchor(after, found)
      ) {
        anchorOriginal = start;
        anchorMasked = found;
        break;
      }
    }
    if (anchorOriginal < 0) {
      // Short closing delimiters (for example the final backtick in
      // `wsl90.top` → `test.xyz`) are too small to qualify as scan anchors,
      // but they are still unchanged context and must not appear inside the
      // factual replacement span. Preserve only the immediately trailing
      // non-word run; shared lexical suffixes remain part of the replacement.
      const trailingContext = sharedTrailingNonWordLength(before, after);
      if (trailingContext > 0) {
        push(before.slice(0, -trailingContext), after.slice(0, -trailingContext), true);
        push(before.slice(-trailingContext), after.slice(-trailingContext), false);
      } else {
        push(before, after, true);
      }
      return segments;
    }
    push(before.slice(0, anchorOriginal), after.slice(0, anchorMasked), true);
    before = before.slice(anchorOriginal);
    after = after.slice(anchorMasked);
  }
  push(before, after, before !== after);
  return segments;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * Shared text inside a replacement is not unchanged context. Only use an
 * anchor that begins at a lexical boundary; this keeps `mysecret` →
 * `maskedsecret` as one factual-looking replacement instead of inventing the
 * misleading `my` → `masked` mapping from their shared `secret` suffix.
 */
function isContextAnchor(text: string, start: number): boolean {
  if (start <= 0) return true;
  return !WORD_CHARACTER.test(text[start - 1] ?? "") || !WORD_CHARACTER.test(text[start] ?? "");
}

/** Length of the identical trailing punctuation/whitespace run on both sides. */
function sharedTrailingNonWordLength(original: string, masked: string): number {
  let length = 0;
  while (length < original.length && length < masked.length) {
    const originalChar = original[original.length - length - 1] ?? "";
    const maskedChar = masked[masked.length - length - 1] ?? "";
    if (originalChar !== maskedChar || WORD_CHARACTER.test(originalChar)) break;
    length++;
  }
  return length;
}

function collectTextReplacements(
  original: string,
  masked: string,
  target: Replacement[],
  entryIndex: number,
  occurrence: { next: number },
  requiresToolsExpanded = false,
): void {
  for (const segment of diffText(original, masked)) {
    if (!segment.changed || segment.original === segment.masked) continue;
    target.push({
      original: segment.original,
      masked: segment.masked,
      entryIndex,
      entryOccurrenceIndex: occurrence.next++,
      requiresToolsExpanded,
    });
  }
}

/** Collect only spans represented by the viewer, in the same order it renders them. */
function collectEntryReplacements(
  entry: TranscriptEntry,
  entryIndex: number,
  toolResults: ReadonlyMap<string, TranscriptEntry>,
  target: Replacement[],
): void {
  const occurrence = { next: 0 };
  let requiresToolsExpanded = false;
  const collect = (original: string, masked: string, toolOutput = requiresToolsExpanded) => {
    collectTextReplacements(original, masked, target, entryIndex, occurrence, toolOutput);
  };
  if (entry.original.role === "user") {
    collect(contentText(entry.original.content), contentText(entry.masked.content));
    return;
  }
  if (entry.original.role !== "assistant") return;

  const originalContent = Array.isArray(entry.original.content) ? entry.original.content : [];
  const maskedContent = Array.isArray(entry.masked.content) ? entry.masked.content : [];
  let thinkingRun: Array<[JsonRecord, JsonRecord]> = [];
  const flushThinking = () => {
    if (thinkingRun.length === 0) return;
    collect(
      thinkingRun.map(([block]) => String(block.thinking ?? "")).join("\n"),
      thinkingRun.map(([, block]) => String(block.thinking ?? "")).join("\n"),
    );
    thinkingRun = [];
  };

  for (let index = 0; index < originalContent.length; index++) {
    const original = originalContent[index];
    if (!isRecord(original)) continue;
    const masked = isRecord(maskedContent[index]) ? maskedContent[index] as JsonRecord : original;
    if (original.type === "thinking") {
      thinkingRun.push([original, masked]);
      continue;
    }
    flushThinking();
    if (original.type === "text") {
      collect(String(original.text ?? ""), String(masked.text ?? ""));
    } else if (original.type === "toolCall") {
      collect(
        JSON.stringify(original.arguments ?? {}, null, 2),
        JSON.stringify(masked.arguments ?? {}, null, 2),
      );
      const id = typeof original.id === "string" ? original.id : "";
      const result = toolResults.get(`tool:${id}`);
      if (result) {
        collect(contentText(result.original.content), contentText(result.masked.content), true);
        // When collapsed, omitted tool-result spans would shift the occurrence
        // ordinals of any content rendered after this card.
        requiresToolsExpanded = true;
      }
    }
  }
  flushThinking();
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
  selected: boolean,
): string {
  const value = side === "original" ? segment.original : segment.masked;
  if (!segment.changed) return theme.fg(baseColor, value);
  if (selected) {
    // Keep navigation styling display-only: the highlighted characters remain
    // exactly the factual replacement span, without bracket-like decorations.
    const marked = theme.bold(theme.fg("accent", `${SELECTED_OCCURRENCE_ANCHOR}${value}`));
    return theme.inverse?.(marked) ?? marked;
  }
  const colored = side === "original"
    ? theme.fg("warning", value)
    : theme.fg("success", value);
  return theme.underline?.(colored) ?? colored;
}

function styledSide(
  segments: readonly DiffSegment[],
  side: "original" | "model",
  theme: HistoryTheme,
  baseColor: string,
  selectedChangedIndex: number | undefined,
  italic: boolean,
): string {
  let changedIndex = 0;
  const rendered = segments.map((segment) => {
    const selected = segment.changed && changedIndex++ === selectedChangedIndex;
    return highlightSegment(segment, side, theme, baseColor, selected);
  }).join("");
  return italic ? theme.italic(rendered) : rendered;
}

function comparisonText(
  segments: readonly DiffSegment[],
  theme: HistoryTheme,
  baseColor: string,
  selectedChangedIndex: number | undefined,
  italic: boolean,
  showHeaders: boolean,
): Component {
  return {
    invalidate: () => undefined,
    render: (width) => {
      const local = styledSide(segments, "original", theme, baseColor, selectedChangedIndex, italic);
      const model = styledSide(segments, "model", theme, baseColor, selectedChangedIndex, italic);
      if (width < 90) {
        // Stacked blocks need their own labels because local/model content is
        // interleaved vertically rather than sharing persistent columns.
        return [
          theme.fg("muted", "LOCAL ORIGINAL"),
          ...new Text(local, 1, 0).render(width),
          theme.fg("muted", "MODEL INPUT"),
          ...new Text(model, 1, 0).render(width),
        ];
      }

      const gap = 3;
      const columnWidth = Math.max(20, Math.floor((width - gap) / 2));
      const left = [...(showHeaders ? [theme.fg("muted", "LOCAL ORIGINAL")] : []), ...new Text(local, 0, 0).render(columnWidth)];
      const right = [...(showHeaders ? [theme.fg("muted", "MODEL INPUT")] : []), ...new Text(model, 0, 0).render(columnWidth)];
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
  mode: HistoryViewMode,
  selection: RenderSelection,
) {
  const baseColor = style === "user" ? "userMessageText" : style === "thinking" ? "thinkingText" : "text";
  const italic = style === "thinking";
  const segments = diffText(original, masked);
  const changedCount = segments.filter((segment) => segment.changed).length;
  const selectedChangedIndex = selection.targetOccurrence === undefined
    ? undefined
    : selection.targetOccurrence - selection.nextOccurrence;
  selection.nextOccurrence += changedCount;
  const selectedInThisText = selectedChangedIndex !== undefined &&
    selectedChangedIndex >= 0 && selectedChangedIndex < changedCount
    ? selectedChangedIndex
    : undefined;
  if (mode === "compare") {
    // Assistant content can contain several text/thinking/tool blocks. Treat
    // their comparison columns as one message-level view instead of repeating
    // the same LOCAL/MODEL heading before every block. Empty blocks should not
    // claim the one heading either.
    if (original.length === 0 && masked.length === 0) return;
    const showHeaders = selection.comparisonHeaderShown !== true;
    selection.comparisonHeaderShown = true;
    container.addChild(comparisonText(segments, theme, baseColor, selectedInThisText, italic, showHeaders));
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
    styledSide(segments, mode, theme, baseColor, selectedInThisText, italic),
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
  mode: HistoryViewMode,
  selection: RenderSelection,
) {
  const originalArguments = JSON.stringify(call.arguments ?? {}, null, 2);
  const maskedArguments = JSON.stringify(maskedCall.arguments ?? {}, null, 2);
  const card = new Box(1, 0, (text) => theme.bg("toolSuccessBg", text));
  const name = typeof call.name === "string" ? call.name : "tool";
  card.addChild(new Text(theme.fg("toolTitle", theme.bold(`▸ ${name}`))));
  addMessageText(card, originalArguments, maskedArguments, theme, "assistant", mode, selection);
  if (result) {
    const original = contentText(result.original.content);
    const masked = contentText(result.masked.content);
    const preview = expanded ? original : original.split("\n").slice(0, 10).join("\n");
    const previewMasked = expanded ? masked : masked.split("\n").slice(0, 10).join("\n");
    addMessageText(card, preview, previewMasked, theme, "assistant", mode, selection);
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
  mode: HistoryViewMode,
  selection: RenderSelection,
) {
  const originalContent = Array.isArray(entry.original.content) ? entry.original.content : [];
  const maskedContent = Array.isArray(entry.masked.content) ? entry.masked.content : [];
  let thinkingRun: Array<[JsonRecord, JsonRecord]> = [];
  const flushThinking = () => {
    if (thinkingRun.length === 0) return;
    const original = thinkingRun.map(([block]) => String(block.thinking ?? "")).join("\n");
    const masked = thinkingRun.map(([, block]) => String(block.thinking ?? "")).join("\n");
    if (thinkingVisible) {
      addMessageText(container, original, masked, theme, "thinking", mode, selection);
    } else {
      // Hidden thinking still occupies factual occurrence ordinals so a later
      // selected span in the same assistant message stays aligned.
      selection.nextOccurrence += diffText(original, masked).filter((segment) => segment.changed).length;
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
      addMessageText(container, String(original.text ?? ""), String(maskedBlock.text ?? ""), theme, "assistant", mode, selection);
    } else if (original.type === "toolCall") {
      const id = typeof original.id === "string" ? original.id : "";
      addToolCard(container, original, maskedBlock, toolResults.get(`tool:${id}`), expanded, theme, mode, selection);
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
  mode: HistoryViewMode,
  selected: Replacement | undefined,
): Component {
  const container = new Container();
  const selection: RenderSelection = {
    targetOccurrence: selected?.entryOccurrenceIndex,
    nextOccurrence: 0,
  };
  const role = entry.original.role;
  container.addChild(new Spacer(1));
  if (role === "user") {
    const box = new Box(0, 0, (text) => theme.bg("userMessageBg", text));
    box.addChild(new Text(theme.fg("muted", "You"), 1, 0));
    addMessageText(box, contentText(entry.original.content), contentText(entry.masked.content), theme, "user", mode, selection);
    container.addChild(box);
  } else if (role === "assistant") {
    container.addChild(new Text(theme.fg("accent", "Assistant"), 1, 0));
    addAssistant(container, entry, toolResults, expanded, thinkingVisible, theme, mode, selection);
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
  let viewMode: HistoryViewMode = options.viewState?.mode ?? "original";
  let modeBeforeCompare: Exclude<HistoryViewMode, "compare"> = options.viewState?.modeBeforeCompare ?? "original";
  let replacementIndex = 0;
  let lastWidth = 80;
  let cacheVersion = 0;
  let revealSelectedOccurrence = false;

  const toolResults = new Map(entries
    .filter((entry) => entry.original.role === "toolResult")
    .map((entry) => [entry.key, entry]));
  const displayEntries = entries.filter((entry) => entry.original.role !== "toolResult");
  // History is a replay: open at its live edge rather than at session start.
  // visiblePage() will retreat just enough to fill the screen on first render.
  let position = { entry: displayEntries.length, line: 0 };
  const entryCache = new Map<number, {
    width: number;
    version: number;
    lines: string[];
    selectedLine: number;
  }>();

  const replacements: Replacement[] = [];
  for (let index = 0; index < displayEntries.length; index++) {
    collectEntryReplacements(displayEntries[index]!, index, toolResults, replacements);
  }
  // The inspector starts at the most recent masked occurrence, matching the
  // initial viewport. N wraps forward; P walks backward through occurrences.
  replacementIndex = Math.max(0, replacements.length - 1);
  const selectedReplacement = () => replacements[replacementIndex];
  if (selectedReplacement()?.requiresToolsExpanded) toolsExpanded = true;

  const selectReplacement = (delta: number) => {
    if (replacements.length < 2) return;
    replacementIndex = (replacementIndex + delta + replacements.length) % replacements.length;
    const selected = selectedReplacement();
    if (selected) {
      position = { entry: selected.entryIndex, line: 0 };
      if (selected.requiresToolsExpanded) toolsExpanded = true;
      revealSelectedOccurrence = true;
    }
    cacheVersion++;
  };

  let chromeRows = options.subtitle ? 5 : 4;
  const pageSize = () => Math.max(1, tui.terminal.rows - chromeRows);
  const entryRender = (index: number, width: number) => {
    const cached = entryCache.get(index);
    if (cached?.width === width && cached.version === cacheVersion) return cached;
    const entry = displayEntries[index];
    if (!entry) return { width, version: cacheVersion, lines: [], selectedLine: -1 };
    const rendered = renderTranscriptEntry(
      entry,
      toolResults,
      toolsExpanded,
      thinkingVisible,
      theme,
      viewMode,
      selectedReplacement()?.entryIndex === index ? selectedReplacement() : undefined,
    ).render(width);
    const selectedLine = rendered.findIndex((line) => line.includes(SELECTED_OCCURRENCE_ANCHOR));
    const lines = rendered.map((line) => line.replaceAll(SELECTED_OCCURRENCE_ANCHOR, ""));
    const result = { width, version: cacheVersion, lines, selectedLine };
    entryCache.set(index, result);
    return result;
  };
  const entryLines = (index: number, width: number): string[] => entryRender(index, width).lines;

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

  const persistViewState = () => {
    if (!options.viewState) return;
    options.viewState.mode = viewMode;
    options.viewState.modeBeforeCompare = modeBeforeCompare;
  };

  const toggleModelView = () => {
    if (viewMode === "compare") viewMode = modeBeforeCompare;
    viewMode = viewMode === "original" ? "model" : "original";
    modeBeforeCompare = viewMode;
    persistViewState();
    cacheVersion++;
  };

  const toggleCompareView = () => {
    if (viewMode === "compare") viewMode = modeBeforeCompare;
    else {
      modeBeforeCompare = viewMode;
      viewMode = "compare";
    }
    persistViewState();
    cacheVersion++;
  };

  const visiblePage = (width: number) => {
    if (revealSelectedOccurrence) {
      const selected = selectedReplacement();
      if (selected) {
        const selectedLine = entryRender(selected.entryIndex, width).selectedLine;
        if (selectedLine >= 0) position = { entry: selected.entryIndex, line: Math.max(0, selectedLine - 1) };
      }
      revealSelectedOccurrence = false;
    }

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
      const safeWidth = Math.max(1, width);
      const wrapStyled = (text: string) => wrapTextWithAnsi(text, safeWidth);
      const modeLabel = viewMode === "original" ? "LOCAL ORIGINAL" : viewMode === "model" ? "MODEL INPUT" : "SIDE-BY-SIDE COMPARE";
      const title = options.title ?? "Masking history";
      const header = theme.fg("accent", theme.bold(`${title} · ${modeLabel}`));
      const selected = selectedReplacement();
      const inspector = selected
        ? `Selected masked occurrence ${replacementIndex + 1}/${replacements.length}  LOCAL: ${selected.original}  →  MODEL: ${selected.masked}`
        : "No masked text in this version";
      const legend = viewMode === "original"
        ? "Underlined: local text changed by masking · Inverse highlight: selected occurrence"
        : viewMode === "model"
          ? "Underlined: masked text · Inverse highlight: selected occurrence"
          : "Left: local original · Right: model input · Inverse highlight: selected occurrence";
      const footerPrefix = options.footerPrefix ? `${options.footerPrefix} · ` : "";
      const occurrenceControl = replacements.length > 1 ? " · N/P next/previous occurrence" : "";
      const footerText = `${footerPrefix}↑↓/PgUp/PgDn scroll${occurrenceControl} · M original/masked · C side-by-side compare · Ctrl+O tools · Ctrl+T thinking · Esc close`;
      const headerLines = wrapStyled(header);
      const subtitleLines = options.subtitle ? wrapStyled(theme.fg("muted", options.subtitle)) : [];
      const inspectorLines = [theme.fg("muted", truncateToWidth(inspector, safeWidth))];
      const legendLines = wrapStyled(theme.fg("dim", legend));

      // Start without progress. If the complete transcript fits, a message
      // range such as "messages 1–3 of 3" adds no useful information.
      const controlFooterLines = wrapStyled(theme.fg("dim", footerText));
      let footerLines = controlFooterLines;
      chromeRows = headerLines.length + subtitleLines.length + inspectorLines.length + legendLines.length + footerLines.length;
      let page = visiblePage(safeWidth);
      const atLiveEdge = page.cursor.entry === displayEntries.length;
      const allMessagesVisible = displayEntries.length === 0 || (
        position.entry === 0 && position.line === 0 && atLiveEdge
      );

      if (!allMessagesVisible) {
        const maximumProgress = `messages ${displayEntries.length}–${displayEntries.length} of ${displayEntries.length}`;
        const maximumProgressLines = wrapStyled(theme.fg("dim", maximumProgress));
        footerLines = [...controlFooterLines, ...maximumProgressLines];
        chromeRows = headerLines.length + subtitleLines.length + inspectorLines.length + legendLines.length + footerLines.length;
        // Adding the progress row shrinks the transcript. Preserve the live-edge
        // anchor instead of dropping the final message from the first render.
        if (atLiveEdge) position = { entry: displayEntries.length, line: 0 };
        page = visiblePage(safeWidth);
        const progressFor = (cursor: typeof page.cursor) => {
          const first = Math.min(position.entry + 1, displayEntries.length);
          const last = Math.min(cursor.entry + (cursor.line > 0 ? 1 : 0), displayEntries.length);
          return `messages ${first}–${last} of ${displayEntries.length}`;
        };
        let actualProgressLines = wrapStyled(theme.fg("dim", progressFor(page.cursor)));
        if (actualProgressLines.length !== maximumProgressLines.length) {
          chromeRows += actualProgressLines.length - maximumProgressLines.length;
          page = visiblePage(safeWidth);
          actualProgressLines = wrapStyled(theme.fg("dim", progressFor(page.cursor)));
        }
        footerLines = [...controlFooterLines, ...actualProgressLines];
      }

      const lines = [
        ...headerLines,
        ...subtitleLines,
        ...inspectorLines,
        ...legendLines,
        ...page.visible,
        ...footerLines,
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
      else if (data === "m" || data === "M") toggleModelView();
      else if (data === "c" || data === "C") toggleCompareView();
      else if ((data === "n" || data === "N") && replacements.length > 1) selectReplacement(1);
      else if ((data === "p" || data === "P") && replacements.length > 1) selectReplacement(-1);
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

function activeRuleCount(view: EpochHistoryView): number {
  if (!view.epoch.enabled) return 0;
  return view.epoch.rules.filter((rule) => rule.enabled && rule.available).length;
}

function epochLabel(view: EpochHistoryView, index: number, total: number): string {
  const ruleState = view.epoch.enabled
    ? `${activeRuleCount(view)} active rule${activeRuleCount(view) === 1 ? "" : "s"}`
    : "Masking off";
  return `Masking history · Rule version ${index + 1}/${total} · ${ruleState}`;
}

function changeLabelsByRule(changes: readonly RuleEpochChange[]): Map<string, string[]> {
  const labels = new Map<string, string[]>();
  for (const change of changes) {
    if (!change.ruleKey || change.kind === "rule_removed") continue;
    let label: string | undefined;
    switch (change.kind) {
      case "rule_added": label = "ADDED"; break;
      case "rule_updated": label = "UPDATED"; break;
      case "rule_enabled": label = "ENABLED"; break;
      case "rule_disabled": label = "DISABLED"; break;
      case "rule_moved": {
        const from = change.fromOrder === undefined ? "?" : String(change.fromOrder + 1);
        const to = change.toOrder === undefined ? "?" : String(change.toOrder + 1);
        label = `MOVED ${from}→${to}`;
        break;
      }
    }
    if (!label) continue;
    const ruleLabels = labels.get(change.ruleKey) ?? [];
    ruleLabels.push(label);
    labels.set(change.ruleKey, ruleLabels);
  }
  return labels;
}

function otherEpochChanges(
  previous: EpochHistoryView | undefined,
  view: EpochHistoryView,
  changes: readonly RuleEpochChange[],
): string[] {
  if (!previous) return [];
  const labels: string[] = [];
  for (const change of changes) {
    if (change.kind === "masking_enabled") labels.push("Global masking enabled");
    else if (change.kind === "masking_disabled") labels.push("Global masking disabled");
    else if (change.kind === "configuration_changed") labels.push("Configuration changed");
    else if (change.kind === "option_changed" && change.option === "caseSensitive") {
      labels.push(`Case-sensitive matching ${view.epoch.caseSensitive ? "enabled" : "disabled"}`);
    } else if (change.kind === "option_changed" && change.option === "systemPromptGuidance") {
      labels.push(`System-prompt guidance ${view.epoch.systemPromptGuidance ? "enabled" : "disabled"}`);
    }
  }
  return labels;
}

function createVersionRulesViewer(
  tui: HistoryTui,
  theme: HistoryTheme,
  keybindings: HistoryKeybindings,
  view: EpochHistoryView,
  previous: EpochHistoryView | undefined,
  index: number,
  total: number,
  back: () => void,
  done: () => void,
): Component {
  let scrollOffset = 0;
  let pageSize = 1;
  const changes = previous ? summarizeEpochNetChanges(previous.epoch, view.epoch) : [];
  const labelsByRule = changeLabelsByRule(changes);
  const removed = changes
    .filter((change) => change.kind === "rule_removed")
    .map((change) => change.ruleName ?? change.ruleId ?? "Unnamed rule");
  const otherChanges = otherEpochChanges(previous, view, changes);
  const rules = [...view.epoch.rules].sort((left, right) => left.order - right.order);

  const bodyLines = (width: number): string[] => {
    const lines: string[] = [];
    if (width >= 80) {
      // Reserve enough space for combined labels such as
      // "DISABLED, MOVED 1→2, UPDATED" instead of giving all spare width to NAME.
      const nameWidth = Math.max(12, width - 72);
      const header = `  ${"STATE".padEnd(6)} ${"ORDER".padStart(5)}  ${"SCOPE".padEnd(7)}  ${"TYPE".padEnd(7)}  ${"NAME".padEnd(nameWidth)}  CHANGE`;
      lines.push(theme.fg("dim", truncateToWidth(header, width)));
      for (const rule of rules) {
        const stateLabel = !rule.enabled ? "OFF" : rule.available ? "ON" : "WAIT";
        const state = `[${stateLabel.padEnd(4)}]`;
        const labels = previous ? labelsByRule.get(rule.key)?.join(", ") ?? "—" : "—";
        const clippedName = truncateToWidth(rule.name, nameWidth);
        const paddedName = `${clippedName}${" ".repeat(Math.max(0, nameWidth - visibleWidth(clippedName)))}`;
        const row = `  ${state} ${String(rule.order + 1).padStart(5)}  ${rule.scope.padEnd(7)}  ${rule.sourceKind.padEnd(7)}  ${paddedName}  ${labels}`;
        lines.push(rule.enabled ? truncateToWidth(row, width) : theme.fg("dim", truncateToWidth(row, width)));
      }
    } else {
      for (const rule of rules) {
        const stateLabel = !rule.enabled ? "OFF" : rule.available ? "ON" : "WAIT";
        const labels = previous ? labelsByRule.get(rule.key)?.join(", ") ?? "—" : "—";
        const summary = `[${stateLabel}] ${rule.order + 1} · ${rule.name}`;
        const styledSummary = rule.enabled ? summary : theme.fg("dim", summary);
        lines.push(...wrapTextWithAnsi(styledSummary, Math.max(1, width)));
        lines.push(...wrapTextWithAnsi(theme.fg("muted", `  ${rule.scope} · ${rule.sourceKind} · change: ${labels}`), Math.max(1, width)));
      }
    }

    if (rules.length === 0) lines.push(theme.fg("muted", "No rules were configured in this version."));
    if (removed.length > 0) {
      lines.push("", theme.fg("muted", "Removed since previous version:"));
      for (const name of removed) lines.push(...wrapTextWithAnsi(`- ${name}`, Math.max(1, width)));
    }
    if (otherChanges.length > 0) {
      lines.push("", theme.fg("muted", "Other changes:"));
      for (const change of otherChanges) lines.push(...wrapTextWithAnsi(`- ${change}`, Math.max(1, width)));
    }
    return lines;
  };

  return {
    invalidate: () => {},
    render: (width) => {
      const safeWidth = Math.max(1, width);
      const active = activeRuleCount(view);
      const header = [
        ...wrapTextWithAnsi(theme.fg("accent", theme.bold(`Rules for history version ${index + 1}/${total}`)), safeWidth),
        ...wrapTextWithAnsi(theme.fg(view.epoch.enabled ? "success" : "warning", `GLOBAL MASKING [${view.epoch.enabled ? "ON" : "OFF"}] · ${active} active / ${rules.length} configured`), safeWidth),
        "",
      ];
      const footerText = `${total > 1 ? "[/] rule version · " : ""}↑↓/PgUp/PgDn scroll · Esc back`;
      const footer = wrapTextWithAnsi(theme.fg("dim", footerText), safeWidth);
      const body = bodyLines(safeWidth);
      pageSize = Math.max(1, tui.terminal.rows - header.length - footer.length);
      scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, body.length - pageSize)));
      const lines = [...header, ...body.slice(scrollOffset, scrollOffset + pageSize), ...footer];
      return [...lines, ...Array(Math.max(0, tui.terminal.rows - lines.length)).fill("")];
    },
    handleInput: (data) => {
      if (keybindings.matches(data, "tui.select.up")) scrollOffset--;
      else if (keybindings.matches(data, "tui.select.down")) scrollOffset++;
      else if (keybindings.matches(data, "tui.select.pageUp")) scrollOffset -= pageSize;
      else if (keybindings.matches(data, "tui.select.pageDown")) scrollOffset += pageSize;
      else if (data === "\x1b[H" || data === "\x1bOH") scrollOffset = 0;
      else if (data === "\x1b[F" || data === "\x1bOF") scrollOffset = Number.MAX_SAFE_INTEGER;
      else if (keybindings.matches(data, "tui.select.cancel")) {
        back();
        return;
      } else if (keybindings.matches(data, "app.interrupt")) {
        done();
        return;
      } else return;
      scrollOffset = Math.max(0, scrollOffset);
      tui.requestRender();
    },
  };
}

/**
 * Epoch selector around the transcript and read-only rule-version viewers.
 * Empty/unused epochs are hidden; the newest epoch with factual outbound
 * observations is selected by default.
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
  let screen: "history" | "rules" = "history";
  const viewState: HistoryViewState = { mode: "original", modeBeforeCompare: "original" };

  const createSelected = (): Component => {
    const view = views[selectedIndex];
    if (screen === "rules" && view) {
      return createVersionRulesViewer(
        tui,
        theme,
        keybindings,
        view,
        views[selectedIndex - 1],
        selectedIndex,
        views.length,
        () => {
          screen = "history";
          selected = createSelected();
          tui.requestRender();
        },
        done,
      );
    }
    const footerActions = [
      ...(views.length > 1 ? ["[/] rule version"] : []),
      ...(view ? ["R view version rules"] : []),
    ];
    return createHistoryViewer(
      tui,
      theme,
      keybindings,
      view?.entries ?? [],
      done,
      {
        title: view
          ? epochLabel(view, selectedIndex, views.length)
          : "Masking history · no recorded versions",
        footerPrefix: footerActions.join(" · ") || undefined,
        viewState,
      },
    );
  };
  let selected = createSelected();

  return {
    invalidate: () => selected.invalidate?.(),
    render: (width) => selected.render(width),
    handleInput: (data) => {
      const delta = data === "[" ? -1 : data === "]" ? 1 : 0;
      if (delta !== 0 && views.length > 1) {
        const next = Math.max(0, Math.min(views.length - 1, selectedIndex + delta));
        if (next === selectedIndex) return;
        selectedIndex = next;
        selected = createSelected();
        tui.requestRender();
        return;
      }
      if (screen === "history" && (data === "r" || data === "R") && views[selectedIndex]) {
        screen = "rules";
        selected = createSelected();
        tui.requestRender();
        return;
      }
      selected.handleInput?.(data);
    },
  };
}
