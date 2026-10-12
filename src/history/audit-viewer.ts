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
import type { AuditEvent, AuditEventKind } from "./audit-log.ts";

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
  held: "🔒",
  warned: "⚠\uFE0F",
  blocked: "❌",
  confirmed: "☑\uFE0F",
  declined: "🚫",
};

const KIND_COLOR: Record<AuditEventKind, string> = {
  restored: "success",
  held: "warning",
  warned: "warning",
  blocked: "error",
  confirmed: "warning",
  declined: "error",
};

const KIND_LABEL: Record<AuditEventKind, string> = {
  restored: "RESTORED",
  held: "HELD",
  warned: "UNVERIFIED",
  blocked: "BLOCKED",
  confirmed: "CONFIRMED",
  declined: "DECLINED",
};

function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function eventLines(event: AuditEvent, width: number, theme: AuditTheme, selected = false): string[] {
  const symbol = theme.fg(KIND_COLOR[event.kind], KIND_SYMBOL[event.kind]);
  const label = theme.fg(KIND_COLOR[event.kind], KIND_LABEL[event.kind].padEnd(10));
  const time = theme.fg("dim", formatTime(event.at));
  const tool = theme.fg("muted", event.tool);
  const head = `${selected ? theme.fg("accent", "> ") : "  "}${symbol} ${label.padEnd(10)} ${time}  ${tool}`;
  const lines = [truncateToWidth(head, width)];

  const detailParts = [`"${event.ruleName}"`];
  if (event.destinations && event.destinations.length > 0) {
    detailParts.push(`→ ${event.destinations.join(", ")}`);
  }
  if (event.detail) detailParts.push(event.detail);
  const detail = `                ${detailParts.join("  ")}`;
  for (const wrapped of wrapTextWithAnsi(theme.fg("muted", detail), width)) {
    lines.push(truncateToWidth(wrapped, width));
  }
  return lines;
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
    const blocks = matching.map((event, index) => eventLines(event, width, theme, index === cursor));
    const body: string[] = [];
    if (matching.length === 0) {
      body.push(theme.fg("muted", filter ? `  No events match "${filter}"` : "  No restoration events recorded yet"));
    } else {
      for (const block of blocks) body.push(...block);
    }

    const bodyRows = Math.max(1, tui.terminal.rows - 7);
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
    const legend = theme.fg("dim", "✅ restored · 🔒 held (placeholder kept) · ⚠️ unverified · ☑️ confirmed · ❌ blocked · 🚫 declined");
    const progress = status
      ? theme.fg("warning", status)
      : offset > 0
        ? theme.fg("dim", `scrolled up ${offset} lines`)
        : "";
    const footerLines = filterMode
      ? [theme.fg("muted", `filter: ${filter}█`)]
      : [theme.fg("dim", "↑↓ select · Enter jump to message · PgUp/PgDn page · / filter · Esc close"), progress].filter(Boolean);

    return [...wrapTextWithAnsi(header, width), "", legend, ruleLine, ...visible, ruleLine, "", ...footerLines, ...Array(Math.max(0, tui.terminal.rows - (8 + visible.length))).fill("")];
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
    const rows = Math.max(1, tui.terminal.rows - 7);
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
    if (!event.callId) {
      status = "this event predates jump support (no call id recorded)";
      tui.requestRender();
      return;
    }
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
