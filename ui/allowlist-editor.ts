/**
 * ui/allowlist-editor.ts
 * Overlay editor for the global allowlist (options.allowlist): a flat list
 * of exact literal values that are never masked. An inline input line at
 * the bottom is always focused — typing a value and pressing Enter adds it
 * immediately (staged in memory); Up/Down select, D or Delete remove, F2
 * stages the whole list as JSON. Exit saves via the same options pipeline
 * as the other settings (cache-impact confirmed).
 */

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth, type EditorTheme } from "@earendil-works/pi-tui";
import {
  MASKING_SCREEN_OPTIONS,
  fillMaskingScreen,
  wrappedMaskingText,
  type MaskingUIBridge,
} from "./masking-common.ts";
import { saveConfigOptionsUI } from "./rule-editor.ts";

const HINTS = "↑/↓ select · D or Delete delete · F2 JSON · Esc save & back";

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
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    const input = new Editor(tui, editorTheme, { paddingX: 1 });
    input.focused = true;
    input.onChange = () => tui.requestRender();

    function refresh(): void {
      tui.requestRender();
    }

    function addValue(raw: string): void {
      const value = raw.trim();
      if (!value) return;
      const duplicate = entries.some((entry) => caseInsensitive
        ? entry.toLowerCase() === value.toLowerCase()
        : entry === value);
      if (duplicate) {
        message = "Entry already in the allowlist";
        refresh();
        return;
      }
      entries.push(value);
      selectedIndex = entries.length - 1;
      message = "Staged · saved on exit";
      refresh();
    }

    input.onSubmit = (text) => {
      addValue(text);
      input.setText("");
      refresh();
    };

    function deleteSelected(): void {
      if (selectedIndex < 0 || selectedIndex >= entries.length) return;
      entries.splice(selectedIndex, 1);
      if (selectedIndex >= entries.length) selectedIndex = entries.length - 1;
      message = "Staged · saved on exit";
      refresh();
    }

    function moveSelection(delta: number): void {
      if (entries.length === 0) return;
      selectedIndex = (selectedIndex + delta + entries.length) % entries.length;
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

    /** Stage the whole list from JSON (F2), mirroring the rule editor's JSON mode. */
    function openJsonStage(): void {
      void ctx.ui.custom<void>((jsonTui, jsonTheme, jsonKeybindings, jsonDone) => {
        const jsonInput = new Editor(jsonTui, editorTheme, { paddingX: 1 });
        jsonInput.focused = true;
        jsonInput.setText(JSON.stringify(entries, null, 2));
        let error = "";
        return {
          render: (width) => fillMaskingScreen([
            jsonTheme.fg("accent", jsonTheme.bold("ALLOWLIST · edit as JSON")),
            error ? wrappedMaskingText(jsonTheme.fg("warning", error), width).join("\n") : "",
            ...jsonInput.render(width),
            "",
            ...wrappedMaskingText(jsonTheme.fg("dim", "Enter apply · Esc cancel"), width),
          ].filter((line) => line !== ""), width, jsonTui.terminal.rows),
          invalidate: () => jsonInput.invalidate(),
          handleInput: (data) => {
            if (jsonKeybindings.matches(data, "tui.select.cancel") || jsonKeybindings.matches(data, "app.interrupt")
              || matchesKey(data, Key.escape)) {
              jsonDone(undefined);
              return;
            }
            if (matchesKey(data, Key.enter) || jsonKeybindings.matches(data, "tui.select.confirm")) {
              const text = jsonInput.getExpandedText();
              try {
                const parsed = JSON.parse(text) as unknown;
                if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string" || entry.length === 0)) {
                  throw new Error("Expected an array of non-empty strings");
                }
                entries = [...new Set(parsed as string[])];
                selectedIndex = Math.min(selectedIndex, entries.length - 1);
                message = "Staged · saved on exit";
                refresh();
                jsonDone(undefined);
              } catch (err) {
                error = (err as Error).message;
                jsonTui.requestRender();
              }
              return;
            }
            jsonInput.handleInput(data);
          },
        };
      }, MASKING_SCREEN_OPTIONS);
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
        } else {
          for (let index = 0; index < entries.length; index++) {
            const cursor = index === selectedIndex ? "›" : " ";
            const text = `${cursor} ${String(index + 1).padStart(3)}  ${entries[index]}`;
            const clipped = truncateToWidth(text, Math.max(1, width));
            lines.push(index === selectedIndex ? theme.fg("accent", clipped) : clipped);
          }
        }
        lines.push("");
        lines.push(...wrappedMaskingText(theme.fg("dim", "Type a value and press Enter to add it"), width));
        lines.push(...input.render(width));
        lines.push("");
        lines.push(...wrappedMaskingText(theme.fg("dim", HINTS), width));
        return fillMaskingScreen(lines, width, tui.terminal.rows);
      },
      invalidate: () => input.invalidate(),
      handleInput: (data) => {
        if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")
          || matchesKey(data, Key.escape)) {
          void finish();
          return;
        }
        // With an empty input line the keys drive the list; while typing they
        // belong to the editor.
        if (input.getText().length === 0) {
          if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.select.up")) {
            moveSelection(-1);
            return;
          }
          if (matchesKey(data, Key.down) || keybindings.matches(data, "tui.select.down")) {
            moveSelection(1);
            return;
          }
          if (matchesKey(data, "d") || data === "D" || matchesKey(data, Key.delete)) {
            deleteSelected();
            return;
          }
          if (matchesKey(data, Key.f2)) {
            openJsonStage();
            return;
          }
        }
        input.handleInput(data);
      },
    };
  }, MASKING_SCREEN_OPTIONS);
}
