/**
 * ui/allowlist-editor.ts
 * Overlay editor for the global allowlist (options.allowlist): a flat list
 * of exact literal values that are never masked. Stages add/delete in
 * memory and persists the whole array as one options change through the
 * same save pipeline as the other settings (cache-impact confirmed).
 */

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  MASKING_SCREEN_OPTIONS,
  fillMaskingScreen,
  inputMaskingValue,
  wrappedMaskingText,
  type MaskingUIBridge,
} from "./masking-common.ts";
import { saveConfigOptionsUI } from "./rule-editor.ts";

/**
 * Open the allowlist editor for `current`. Stages edits locally; on Exit,
 * saves the array via saveConfigOptionsUI (no-op when nothing changed).
 * Returns true when a change was saved.
 */
export async function openAllowlistEditor(
  bridge: MaskingUIBridge,
  ctx: ExtensionContext,
  current: readonly string[],
): Promise<boolean> {
  const original = [...current];
  const caseInsensitive = !bridge.config().options.caseSensitive;
  let entries = [...current];
  let selectedIndex = entries.length > 0 ? 0 : -1;
  let message = "";

  return await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
    function refresh(): void {
      tui.requestRender();
    }

    async function addEntry(): Promise<void> {
      const input = (await inputMaskingValue(ctx, "Add allowlist entry", "10.0.0.5"))?.trim();
      if (!input) {
        message = input === "" ? "Empty entry ignored" : "";
        refresh();
        return;
      }
      const duplicate = entries.some((entry) => caseInsensitive
        ? entry.toLowerCase() === input.toLowerCase()
        : entry === input);
      if (duplicate) {
        message = "Entry already in the allowlist";
        refresh();
        return;
      }
      entries.push(input);
      selectedIndex = entries.length - 1;
      message = "Staged · saved on exit";
      refresh();
    }

    function deleteSelected(): void {
      if (selectedIndex < 0 || selectedIndex >= entries.length) return;
      entries.splice(selectedIndex, 1);
      if (selectedIndex >= entries.length) selectedIndex = entries.length - 1;
      message = "Staged · saved on exit";
      refresh();
    }

    async function finish(): Promise<void> {
      const changed = entries.length !== original.length
        || entries.some((entry, index) => entry !== original[index]);
      if (!changed) {
        done(false);
        return;
      }
      const saved = await saveConfigOptionsUI(bridge, ctx, { allowlist: entries });
      done(saved);
    }

    return {
      render: (width) => {
        const title = theme.fg("accent", theme.bold(
          `ALLOWLIST · ${entries.length} value(s) never masked${caseInsensitive ? " · case-insensitive" : ""}`,
        ));
        const lines: string[] = [title];
        if (message) lines.push(...wrappedMaskingText(theme.fg("muted", message), width));
        lines.push("");
        if (entries.length === 0) {
          lines.push(theme.fg("warning", "The allowlist is empty — every rule match is masked."));
          lines.push(...wrappedMaskingText(theme.fg("dim", "Press A to add a value (exact literal match)."), width));
        } else {
          for (let index = 0; index < entries.length; index++) {
            const cursor = index === selectedIndex ? "›" : " ";
            const text = `${cursor} ${String(index + 1).padStart(3)}  ${entries[index]}`;
            const clipped = truncateToWidth(text, Math.max(1, width));
            lines.push(index === selectedIndex ? theme.fg("accent", clipped) : clipped);
          }
        }
        lines.push("");
        lines.push(...wrappedMaskingText(theme.fg("dim", "A add · D delete · ↑/↓ select · Esc save & back"), width));
        return fillMaskingScreen(lines, width, tui.terminal.rows);
      },
      invalidate: () => {},
      handleInput: (data) => {
        if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.select.up")) {
          if (entries.length > 0) {
            selectedIndex = (selectedIndex + entries.length) % entries.length;
            refresh();
          }
          return;
        }
        if (matchesKey(data, Key.down) || keybindings.matches(data, "tui.select.down")) {
          if (entries.length > 0) {
            selectedIndex = (selectedIndex + 1) % entries.length;
            refresh();
          }
          return;
        }
        if (matchesKey(data, "a") || data === "A") {
          void addEntry();
          return;
        }
        if (matchesKey(data, "d") || data === "D") {
          deleteSelected();
          return;
        }
        if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")
          || matchesKey(data, Key.escape)) {
          void finish();
          return;
        }
      },
    };
  }, MASKING_SCREEN_OPTIONS);
}
