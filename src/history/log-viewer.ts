/**
 * log-viewer.ts
 * Tabbed shell for /masking-history: "Masked views" replays what the model
 * actually saw per rule version; "Restoration audit" replays restoration,
 * hold, warn, block, and confirm decisions. The subviews stay black boxes —
 * the shell owns only the tab bar row and Tab routing, and hands each
 * subview one row less than the terminal has.
 */

import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { createAuditViewer } from "./audit-viewer.ts";
import type { AuditEvent } from "./audit-log.ts";
import {
  createEpochHistoryViewer,
  createHistoryViewer,
  type EpochHistoryView,
  type TranscriptEntry,
} from "./history-viewer.ts";

export type MaskingLogTab = "views" | "audit";

interface LogTui {
  terminal: { rows: number };
  requestRender(): void;
}

interface LogTheme {
  fg(color: any, text: string): string;
  bg(color: any, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  inverse?(text: string): string;
  strikethrough?(text: string): string;
}

interface LogKeybindings {
  matches(data: string, keybinding: any): boolean;
}

/** A subview that reports when a text prompt owns the keyboard. */
interface SearchAwareComponent extends Component {
  isSearchActive?(): boolean;
  revealToolCall?(callId: string): boolean;
}

export interface MaskingLogViews {
  epochViews: readonly EpochHistoryView[];
  transcript: readonly TranscriptEntry[];
  auditEvents: readonly AuditEvent[];
  /** Tab shown on open; defaults to "views" when anything was masked. */
  defaultTab?: MaskingLogTab;
}

export function createMaskingLogViewer(
  tui: LogTui,
  theme: LogTheme,
  keybindings: LogKeybindings,
  views: MaskingLogViews,
  done: () => void,
): Component {
  const hasViews = views.epochViews.some((view) => view.entries.length > 0) || views.transcript.length > 0;
  let active: MaskingLogTab = views.defaultTab ?? (hasViews ? "views" : "audit");

  // Subviews lay out against one row less; the shell spends the other row on
  // the tab bar. The getter keeps terminal resizes working.
  const shellTui: LogTui = {
    get terminal() {
      return { rows: Math.max(3, tui.terminal.rows - 1) };
    },
    requestRender: () => tui.requestRender(),
  };

  // Cached so scroll position, filters, and view modes survive tab switches.
  let viewsComponent: SearchAwareComponent | undefined;
  let auditComponent: SearchAwareComponent | undefined;

  const ensureViews = (): SearchAwareComponent =>
    (viewsComponent ??= views.epochViews.length > 0
      ? createEpochHistoryViewer(shellTui, theme, keybindings, views.epochViews, done)
      : createHistoryViewer(shellTui, theme, keybindings, views.transcript, done));

  const activeComponent = (): SearchAwareComponent =>
    active === "views" ? ensureViews() : (auditComponent ??= createAuditViewer(
      shellTui,
      theme,
      keybindings,
      views.auditEvents,
      done,
      // Audit → transcript jump: reveal the call in the views tab. False
      // leaves the user on the audit tab with a status line from the viewer.
      (event) => {
        if (!event.callId) return false;
        const ok = ensureViews().revealToolCall?.(event.callId) ?? false;
        if (ok) active = "views";
        return ok;
      },
    ));

  const tabCount = (tab: MaskingLogTab): string => {
    if (tab === "audit") return `(${views.auditEvents.length})`;
    const epochs = views.epochViews.filter((view) => view.entries.length > 0).length;
    return epochs > 0 ? `(${epochs} version${epochs === 1 ? "" : "s"})` : `(${views.transcript.length})`;
  };

  const renderTabBar = (width: number): string => {
    const cell = (tab: MaskingLogTab, label: string): string =>
      tab === active
        ? theme.fg("accent", theme.bold(`● ${label} ${tabCount(tab)}`))
        : theme.fg("muted", `○ ${label} ${tabCount(tab)}`);
    return truncateToWidth(
      `${cell("views", "Masked views")}   ${cell("audit", "Restoration audit")}   ${theme.fg("dim", "Tab switch")}`,
      width,
    );
  };

  return {
    invalidate: () => activeComponent().invalidate?.(),
    render: (width) => [renderTabBar(Math.max(1, width)), ...activeComponent().render(Math.max(1, width))],
    handleInput: (data: string) => {
      const component = activeComponent();
      // While a search/filter prompt owns the keyboard, Tab belongs to it.
      if (component.isSearchActive?.() !== true) {
        if (data === "\t" || data === "\x1b[Z") {
          active = active === "views" ? "audit" : "views";
          tui.requestRender();
          return;
        }
      }
      component.handleInput?.(data);
    },
  };
}
