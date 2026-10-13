/**
 * audit-viewer.ts
 * Full-screen audit view for restoration decisions (the Restoration audit
 * tab of /masking-history):
 * one line per event — time, outcome symbol, tool, rule, destinations —
 * with a text filter and scrolling. Same visual language as the history
 * viewer: accent header, muted inspector, dim legend/footer, scrollable
 * body, latest events at the bottom.
 */

import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AuditBasis, AuditEvent, AuditEventKind } from "./audit-log.ts";

interface AuditTheme {
  fg(color: any, text: string): string;
  bold(text: string): string;
  inverse?(text: string): string;
}

interface AuditTui {
  terminal: { rows: number };
  requestRender(): void;
}

interface AuditKeybindings {
  matches(data: string, keybinding: any): boolean;
}

/**
 * Outcome symbols must be Emoji_Presentation=Yes glyphs: terminals paint
 * them two cells and pi-tui's width table counts two, so the column stays
 * aligned by construction. East Asian Ambiguous glyphs (✓ ✖ ⚠ …) vary per
 * font fallback and break the layout. Pad labels before coloring — padEnd
 * on an ANSI-colored string counts the escapes and never pads.
 */
const KIND_SYMBOL: Record<AuditEventKind, string> = {
  restored: "✅",
  blocked: "❌",
  warning: "⚠\uFE0F",
};

const KIND_COLOR: Record<AuditEventKind, string> = {
  restored: "success",
  blocked: "error",
  warning: "warning",
};

const KIND_LABEL: Record<AuditEventKind, string> = {
  restored: "RESTORED",
  blocked: "BLOCKED",
  warning: "WARNING",
};

// One-line semantics shown below the bottom rule for the selected event:
// `symbol kind (basis) — outcome sentence (basis sentence)`. The kind
// answers "did the value leave"; the basis answers "why this decision".
const OUTCOME_EXPLAIN: Record<AuditEventKind, string> = {
  restored: "the real value was released into this call",
  blocked: "the call was refused; the real value did not leave",
  warning: "the call ran and nothing new was released — this entry marks a boundary, not a decision",
};

const BASIS_EXPLAIN: Record<AuditBasis, string> = {
  verified: "destination verified against the rule's allowlist",
  unverifiable: "outbound intent with no verifiable destination (e.g. curl \"$URL\")",
  violation: "destination or tool outside the rule's allowlist",
  local: "local use: a file write or local process, no outbound intent",
  consumer: "a marked or inline value was handed to an interpreter — that process's network behavior is not observable",
  "user-approved": "you approved a confirmed violation at the prompt",
  "user-declined": "you declined at the prompt; the reason was returned to the model",
};

function explain(event: AuditEvent): string {
  const label = KIND_LABEL[event.kind].toLowerCase();
  let basisPhrase = BASIS_EXPLAIN[event.basis];
  if (event.basis === "unverifiable") {
    basisPhrase += `; the mode chose to ${event.kind === "restored" ? "let it through" : "fail closed"}`;
  }
  return `${KIND_SYMBOL[event.kind]} ${label} (${event.basis}) — ${OUTCOME_EXPLAIN[event.kind]} (${basisPhrase})`;
}

// Session-local view: time of day only; the date prefix appears just for
// days other than the newest event's (an audit trail rarely spans days).
function formatTime(at: number, refAt: number): string {
  const date = new Date(at);
  const ref = new Date(refAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const sameDay =
    date.getFullYear() === ref.getFullYear() &&
    date.getMonth() === ref.getMonth() &&
    date.getDate() === ref.getDate();
  return sameDay ? hm : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`;
}

function eventLines(event: AuditEvent, width: number, theme: AuditTheme, selected = false, refAt = event.at): string[] {
  const symbol = theme.fg(KIND_COLOR[event.kind], KIND_SYMBOL[event.kind]);
  const time = theme.fg("dim", formatTime(event.at, refAt));
  const tool = theme.fg("muted", event.tool);
  // One line per event: symbol, time, tool, rule, destinations, detail. The
  // kind label is intentionally omitted — the symbol carries it, and the
  // explanation line below the list spells out the selected combination.
  const parts = [`"${event.ruleName}"`];
  if (event.destinations && event.destinations.length > 0) {
    parts.push(`→ ${event.destinations.join(", ")}`);
  }
  if (event.detail) parts.push(event.detail);
  const body = theme.fg("muted", parts.join("  "));
  return [truncateToWidth(`${selected ? theme.fg("accent", "> ") : "  "}${symbol} ${time} ${tool}  ${body}`, width)];
}

export function createAuditViewer(
  tui: AuditTui,
  theme: AuditTheme,
  keybindings: AuditKeybindings,
  events: readonly AuditEvent[],
  done: () => void,
  onJump: (event: AuditEvent) => boolean = () => false,
): Component & { isSearchActive(): boolean } {
  let filter = "";
  let filterMode = false;
  // Bottom-anchored: newest events are the interesting ones.
  let offset = 0; // 0 = live edge; >0 = lines scrolled up from the bottom.
  // Selected event, an index into filtered(); -1 follows the live edge.
  let cursor = -1;
  let status = "";
  let lastWidth = 80;

  const filtered = (): AuditEvent[] => {
    if (!filter) return [...events];
    const needle = filter.toLowerCase();
    return events.filter(
      (event) =>
        event.ruleName.toLowerCase().includes(needle) ||
        event.ruleId.toLowerCase().includes(needle) ||
        event.tool.toLowerCase().includes(needle) ||
        event.destinations?.some((d) => d.toLowerCase().includes(needle)) ||
        event.detail?.toLowerCase().includes(needle),
    );
  };

  const render = (width: number): string[] => {
    lastWidth = width;
    const matching = filtered();
    if (cursor < 0 || cursor >= matching.length) cursor = matching.length - 1;
    const blocks = matching.map((event, index) =>
      eventLines(event, width, theme, index === cursor, events.length > 0 ? events[events.length - 1]!.at : event.at),
    );
    const body: string[] = [];
    if (matching.length === 0) {
      body.push(theme.fg("muted", filter ? `  No events match "${filter}"` : "  No restoration events recorded yet"));
    } else {
      for (const block of blocks) body.push(...block);
    }

    const bodyRows = Math.max(1, tui.terminal.rows - 6);
    // Keep the selected block inside the window, then clamp.
    if (blocks.length > 0 && blocks[cursor]) {
      const starts: number[] = [];
      let total = 0;
      for (const block of blocks) {
        starts.push(total);
        total += block.length;
      }
      const blockStart = starts[cursor]!;
      const blockEnd = blockStart + blocks[cursor]!.length;
      let window = offset === 0 ? Math.max(0, body.length - bodyRows) : offset;
      if (blockStart < window) window = blockStart;
      if (blockEnd > window + bodyRows) window = blockEnd - bodyRows;
      offset = window;
    }
    offset = Math.max(0, Math.min(offset, Math.max(0, body.length - bodyRows)));
    const visible = offset === 0 ? body.slice(-bodyRows) : body.slice(offset, offset + bodyRows);
    const ruleLine = theme.fg("muted", "\u2500".repeat(width));

    const header = theme.fg("accent", theme.bold(`Restoration audit · ${matching.length}${filter ? ` of ${events.length}` : ""} events${filter ? ` · filter: ${filter}` : ""}`));
    const progress = status
      ? theme.fg("warning", status)
      : offset > 0
        ? theme.fg("dim", `scrolled up ${offset} lines`)
        : "";
    const footerLines = filterMode
      ? [theme.fg("muted", `filter: ${filter}█`)]
      : [theme.fg("dim", "↑↓ select · Enter jump to message · PgUp/PgDn page · / filter · Esc close"), progress].filter(Boolean);

    // Contextual semantics for the selected event, between the bottom rule
    // and the key hints; the transient status line keeps its own slot.
    const selectedEvent = cursor >= 0 && cursor < matching.length ? matching[cursor] : undefined;
    const context = selectedEvent
      ? wrapTextWithAnsi(theme.fg("dim", explain(selectedEvent)), width)
      : [];
    const lines = [...wrapTextWithAnsi(header, width), ruleLine, ...visible, ruleLine, ...context, "", ...footerLines];

    return [...lines, ...Array(Math.max(0, tui.terminal.rows - lines.length)).fill("")];
  };

  const setCursor = (index: number): void => {
    const matching = filtered();
    cursor = Math.max(0, Math.min(index, matching.length - 1));
    status = "";
    tui.requestRender();
  };

  const pageCursor = (direction: number): void => {
    const matching = filtered();
    if (matching.length === 0) return;
    const rows = Math.max(1, tui.terminal.rows - 5);
    const sizes = matching.map((event) => eventLines(event, lastWidth, theme).length);
    let steps = 0;
    let budget = rows;
    for (;;) {
      const next = cursor + (steps + 1) * direction;
      if (next < 0 || next >= matching.length) break;
      budget -= sizes[next]!;
      if (budget < 0 && steps > 0) break;
      steps++;
    }
    setCursor(cursor + Math.max(1, steps) * direction);
  };

  const jump = (): void => {
    const matching = filtered();
    if (cursor < 0 || cursor >= matching.length) cursor = matching.length - 1;
    if (cursor < 0 || cursor >= matching.length) return;
    const event = matching[cursor]!;
    if (onJump(event)) return; // the shell switches to the views tab
    status = "no matching tool call in this session's transcript";
    tui.requestRender();
  };

  return {
    invalidate: () => {},
    isSearchActive: () => filterMode,
    render: (width) => render(Math.max(1, width)),
    handleInput: (data: string) => {
      if (filterMode) {
        if (data === "\r" || data === "\n" || data === "\x1b") {
          filterMode = false;
          offset = 0;
          cursor = -1;
          tui.requestRender();
          return;
        }
        if (data === "\x7f" || data === "\b") {
          filter = filter.slice(0, -1);
          offset = 0;
          cursor = -1;
          tui.requestRender();
          return;
        }
        if (data.length === 1 && data >= " ") {
          filter += data;
          offset = 0;
          cursor = -1;
          tui.requestRender();
        }
        return;
      }
      if (data === "\x1b" || data === "q") {
        done();
        return;
      }
      if (data === "/") {
        filterMode = true;
        tui.requestRender();
        return;
      }
      if (data === "\r" || data === "\n") {
        jump();
        return;
      }
      if (data === "\u001b[A" || data === "k") return setCursor(cursor - 1);
      if (data === "\u001b[B" || data === "j") return setCursor(cursor + 1);
      if (data === "\u001b[5~") return pageCursor(-1);
      if (data === "\u001b[6~") return pageCursor(1);
      if (data === "\u001b[H" || data === "g") return setCursor(0);
      if (data === "\u001b[F" || data === "G") return setCursor(filtered().length - 1);
    },
  };
}
