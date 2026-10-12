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
  warned: "WARNED",
  blocked: "BLOCKED",
  confirmed: "CONFIRMED",
  declined: "DECLINED",
};

function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function eventLines(event: AuditEvent, width: number, theme: AuditTheme): string[] {
  const symbol = theme.fg(KIND_COLOR[event.kind], KIND_SYMBOL[event.kind]);
  const label = theme.fg(KIND_COLOR[event.kind], KIND_LABEL[event.kind].padEnd(9));
  const time = theme.fg("dim", formatTime(event.at));
  const tool = theme.fg("muted", event.tool);
  const head = `  ${symbol} ${label.padEnd(9)} ${time}  ${tool}`;
  const lines = [truncateToWidth(head, width)];

  const detailParts = [`"${event.ruleName}"`];
  if (event.destinations && event.destinations.length > 0) {
    detailParts.push(`→ ${event.destinations.join(", ")}`);
  }
  if (event.detail) detailParts.push(event.detail);
  const detail = `               ${detailParts.join("  ")}`;
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
): Component & { isSearchActive(): boolean } {
  let filter = "";
  let filterMode = false;
  // Bottom-anchored: newest events are the interesting ones.
  let offset = 0; // 0 = live edge; >0 = lines scrolled up from the bottom.

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
    const matching = filtered();
    const body: string[] = [];
    if (matching.length === 0) {
      body.push(theme.fg("muted", filter ? `  No events match "${filter}"` : "  No restoration events recorded yet"));
    }
    for (const event of matching) body.push(...eventLines(event, width, theme));

    const bodyRows = Math.max(1, tui.terminal.rows - 7);
    offset = Math.max(0, Math.min(offset, Math.max(0, body.length - bodyRows)));
    const visible = offset === 0 ? body.slice(-bodyRows) : body.slice(offset, offset + bodyRows);
    const ruleLine = theme.fg("muted", "\u2500".repeat(width));

    const header = theme.fg("accent", theme.bold(`Restoration audit · ${matching.length}${filter ? ` of ${events.length}` : ""} events${filter ? ` · filter: ${filter}` : ""}`));
    const legend = theme.fg("dim", "✅ restored · 🔒 held (placeholder kept) · ⚠️ warned · ☑️ confirmed · ❌ blocked · 🚫 declined");
    const progress = offset > 0 ? theme.fg("dim", `scrolled up ${offset} lines`) : "";
    const footerLines = filterMode
      ? [theme.fg("muted", `filter: ${filter}█`)]
      : [theme.fg("dim", "↑↓/PgUp/PgDn scroll · / filter · Esc close"), progress].filter(Boolean);

    return [...wrapTextWithAnsi(header, width), "", legend, ruleLine, ...visible, ruleLine, "", ...footerLines, ...Array(Math.max(0, tui.terminal.rows - (8 + visible.length))).fill("")];
  };

  const scroll = (delta: number): void => {
    offset = Math.max(0, offset + delta);
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
          tui.requestRender();
          return;
        }
        if (data === "\x7f" || data === "\b") {
          filter = filter.slice(0, -1);
          offset = 0;
          tui.requestRender();
          return;
        }
        if (data.length === 1 && data >= " ") {
          filter += data;
          offset = 0;
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
      if (data === "\u001b[A" || data === "k") return scroll(-1);
      if (data === "\u001b[B" || data === "j") return scroll(1);
      if (data === "\u001b[5~") return scroll(-(tui.terminal.rows - 6));
      if (data === "\u001b[6~") return scroll(tui.terminal.rows - 6);
      if (data === "\u001b[H" || data === "g") return scroll(-Infinity);
      if (data === "\u001b[F" || data === "G") {
        offset = 0;
        tui.requestRender();
      }
    },
  };
}
