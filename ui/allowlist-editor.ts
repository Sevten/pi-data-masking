/**
 * ui/allowlist-editor.ts
 * Overlay editor for the global allowlist (options.allowlist): a flat list
 * of exact literal values that are never masked, each with its own
 * case-sensitivity flag shown as words (case-sensitive / ignore-case; C
 * toggles it, toggling into an already-listed mode is rejected instead of
 * destroying the entry). The list ends in an always-present "add value"
 * row — navigating onto it focuses an inline input; typing + Enter stages
 * the value. Enter on an existing row opens an inline edit pre-filled with
 * the value (Enter commits, Esc cancels the edit). A jumps to the add row,
 * D or Delete remove, F2 stages the whole list as JSON. A row clips at
 * the terminal width; when the selected entry does not fit, its full
 * value is wrapped below the list. Esc finishes: with staged changes an
 * explicit confirmation picks Save & close, Discard changes, or Back to editing — nothing is written without an explicit
 * save. Saving goes through the same options pipeline as the other
 * settings.
 */

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth, type EditorTheme } from "@earendil-works/pi-tui";
import { type AllowlistEntry, type ConfigScope } from "../config-loader.ts";
import {
  MASKING_SCREEN_OPTIONS,
  fillMaskingScreen,
  selectMaskingOption,
  wrappedMaskingText,
  type MaskingUIBridge,
} from "./masking-common.ts";
import { saveConfigOptionsUI } from "./rule-editor.ts";

/** A config file the allowlist editor can edit, picked by the caller. */
export interface AllowlistTarget {
  scope: ConfigScope;
  path: string;
}

export async function openAllowlistEditor(
  bridge: MaskingUIBridge,
  ctx: ExtensionContext,
  target: AllowlistTarget,
  current: readonly AllowlistEntry[],
): Promise<boolean> {
  const original: AllowlistEntry[] = current.map((entry) => ({ ...entry }));
  let entries: AllowlistEntry[] = current.map((entry) => ({ ...entry }));
  // Selection range: 0..entries.length — the index entries.length is the
  // trailing "add value" row with its inline input.
  let selectedIndex = 0;
  // When set, that row renders an inline edit input instead of its text;
  // Enter commits the staged change, Esc reverts to the list.
  let editingIndex: number | null = null;
  // True while the exit confirmation (save/discard) or the save itself owns
  // the screen; the editor ignores keys so stale input cannot re-trigger it.
  let exiting = false;
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
    const addInput = new Editor(tui, editorTheme, { paddingX: 1 });
    addInput.focused = true;
    addInput.onChange = () => tui.requestRender();
    const editInput = new Editor(tui, editorTheme, { paddingX: 1 });
    editInput.onChange = () => tui.requestRender();

    const onAddRow = () => editingIndex === null && selectedIndex === entries.length;
    const refresh = () => tui.requestRender();

    const entryKey = (entry: AllowlistEntry): string =>
      `${entry.caseSensitive === false ? "i" : "s"}:${entry.text}`;
    const caseLabel = (entry: AllowlistEntry): string =>
      entry.caseSensitive === false ? "ignore-case" : "case-sensitive";

    function addValue(raw: string): void {
      const value = raw.trim();
      if (!value) return;
      const entry: AllowlistEntry = { text: value };
      if (entries.some((existing) => entryKey(existing) === entryKey(entry))) {
        message = "Same value and case mode is already listed";
        refresh();
        return;
      }
      entries.push(entry);
      selectedIndex = entries.length - 1;
      message = "Staged · C sets ignore-case · Esc to finish";
      refresh();
    }

    function startEdit(): void {
      if (onAddRow() || selectedIndex < 0 || selectedIndex >= entries.length) return;
      editingIndex = selectedIndex;
      editInput.setText(entries[selectedIndex]!.text);
      message = "Editing entry · Enter apply · Esc cancel";
      refresh();
    }

    function cancelEdit(): void {
      editingIndex = null;
      editInput.setText("");
      message = "Edit cancelled";
      refresh();
    }

    editInput.onSubmit = (text) => {
      const index = editingIndex;
      if (index === null) return;
      const value = text.trim();
      editingIndex = null;
      editInput.setText("");
      if (!value) {
        message = "Empty value · edit cancelled";
        refresh();
        return;
      }
      const entry = entries[index]!;
      const candidate: AllowlistEntry = { ...entry, text: value };
      if (entries.some((existing, i) => i !== index && entryKey(existing) === entryKey(candidate))) {
        message = "Same value and case mode is already listed · edit rejected";
        refresh();
        return;
      }
      entry.text = value;
      message = "Staged · Esc to finish";
      refresh();
    };

    function toggleSelectedCase(): void {
      if (onAddRow() || selectedIndex < 0 || selectedIndex >= entries.length) return;
      const entry = entries[selectedIndex]!;
      const next: AllowlistEntry = { ...entry, caseSensitive: entry.caseSensitive === false ? undefined : false };
      // Toggling into a mode where the same text is already listed would
      // create a duplicate: reject the toggle instead of dropping the entry.
      if (entries.some((existing, index) => index !== selectedIndex && entryKey(existing) === entryKey(next))) {
        message = `"${entry.text}" is already listed in this case mode · toggle rejected`;
        refresh();
        return;
      }
      if (next.caseSensitive === undefined) delete next.caseSensitive;
      entries[selectedIndex] = next;
      message = "Staged · Esc to finish";
      refresh();
    }

    addInput.onSubmit = (text) => {
      addValue(text);
      addInput.setText("");
      refresh();
    };

    function deleteSelected(): void {
      if (onAddRow() || selectedIndex < 0 || selectedIndex >= entries.length) return;
      entries.splice(selectedIndex, 1);
      if (selectedIndex >= entries.length) selectedIndex = entries.length;
      message = "Staged · Esc to finish";
      refresh();
    }

    function moveSelection(delta: 1 | -1): void {
      const next = selectedIndex + delta;
      if (next < 0 || next > entries.length) return;
      selectedIndex = next;
      refresh();
    }

    function goToAddRow(): void {
      selectedIndex = entries.length;
      message = "";
      refresh();
    }

    async function finish(): Promise<void> {
      const changed = entries.length !== original.length
        || entries.some((entry, index) => entryKey(entry) !== entryKey(original[index]!));
      if (!changed) {
        done(false);
        return;
      }
      exiting = true;
      // Factual change summary for the exit confirmation.
      const summary: string[] = [];
      if (entries.length !== original.length) summary.push(`${original.length} → ${entries.length} entries`);
      const caseChanged = entries.filter((entry) =>
        original.some((other) => other.text === entry.text
          && (other.caseSensitive === false) !== (entry.caseSensitive === false))).length;
      if (caseChanged > 0) summary.push(`case mode changed on ${caseChanged}`);
      const choice = await selectMaskingOption(
        ctx,
        "Finish allowlist editing",
        ["Save & close", "Discard changes", "Back to editing"],
        `${summary.join(" · ") || "list updated"} · the allowlist is written to the global config (${target.path}).`,
      );
      if (choice === "Save & close") {
        const result = await saveConfigOptionsUI(bridge, ctx, { allowlist: entries }, target);
        if (result.saved) {
          done(true);
          return;
        }
        // Keep the editor open with the staged work intact.
        exiting = false;
        message = "Save failed · changes remain staged";
        refresh();
        return;
      }
      if (choice === "Discard changes") {
        entries = original.map((entry) => ({ ...entry }));
        done(false);
        return;
      }
      // "Back to editing" (also chosen by Esc on the confirmation).
      exiting = false;
      message = "";
      refresh();
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
                const valid = (entry: unknown): entry is AllowlistEntry => {
                  if (typeof entry === "string") return entry.length > 0;
                  return entry !== null && typeof entry === "object" && !Array.isArray(entry)
                    && typeof (entry as Record<string, unknown>).text === "string"
                    && ((entry as Record<string, unknown>).text as string).length > 0
                    && ((entry as Record<string, unknown>).caseSensitive === undefined
                      || typeof (entry as Record<string, unknown>).caseSensitive === "boolean");
                };
                if (!Array.isArray(parsed) || parsed.some((entry) => !valid(entry))) {
                  throw new Error('Expected an array of non-empty strings or { "text": "...", "caseSensitive": false } objects');
                }
                const normalized = (parsed as AllowlistEntry[]).map((entry) => typeof entry === "string" ? { text: entry } : entry);
                const seen = new Set<string>();
                const deduped: AllowlistEntry[] = [];
                for (const entry of normalized) {
                  const key = entryKey(entry);
                  if (seen.has(key)) continue;
                  seen.add(key);
                  deduped.push(entry);
                }
                entries = deduped;
                selectedIndex = Math.min(selectedIndex, entries.length);
                message = "Staged · Esc to finish";
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
          `ALLOWLIST · ${entries.length} value(s) never masked`,
        ));
        let selectedClipped = false;
        const lines: string[] = [
          title,
          // Static matching semantics: identical for every entry, so it
          // lives under the title instead of repeating per selection.
          ...wrappedMaskingText(
            theme.fg("dim", 'Boundary-aligned literal: allowing "10.0.0.5" does not exempt "10.0.0.55" — the longer value stays masked.'),
            width,
          ),
        ];
        if (message) lines.push(...wrappedMaskingText(theme.fg("muted", message), width));
        lines.push("");
        if (entries.length === 0) {
          lines.push(theme.fg("warning", "The allowlist is empty — every rule match is masked."));
        }
        for (let index = 0; index < entries.length; index++) {
          if (index === editingIndex) {
            lines.push(...editInput.render(width));
            continue;
          }
          const cursor = index === selectedIndex ? "›" : " ";
          const entry = entries[index]!;
          const text = `${cursor} ${String(index + 1).padStart(3)}  ${entry.text} ${theme.fg("dim", `· ${caseLabel(entry)}`)}`;
          const clipped = truncateToWidth(text, Math.max(1, width));
          if (index === selectedIndex && clipped !== text) selectedClipped = true;
          lines.push(index === selectedIndex ? theme.fg("accent", clipped) : clipped);
        }
        // Trailing add row: a plain prompt when idle, the input when selected.
        if (onAddRow()) {
          lines.push(...addInput.render(width));
        } else {
          lines.push(theme.fg("dim", truncateToWidth("  ＋ Add value…", Math.max(1, width))));
        }
        // The selected row is single-line by design; when its value does
        // not fit, show the full text once below the list instead of
        // clipping it away.
        if (selectedClipped) {
          lines.push(...wrappedMaskingText(entries[selectedIndex]!.text, width).slice(0, 2));
        }
        lines.push("");
        const hints = editingIndex !== null
          ? "Enter apply · Esc cancel edit"
          : onAddRow()
            ? "Type a value · Enter add · ↑ back to list · Esc finish"
            : "↑/↓ navigate · Enter edit · C case mode · A add · D delete · F2 JSON · Esc finish";
        lines.push(...wrappedMaskingText(theme.fg("dim", hints), width));
        return fillMaskingScreen(lines, width, tui.terminal.rows);
      },
      invalidate: () => {
        addInput.invalidate();
        editInput.invalidate();
      },
      handleInput: (data) => {
        if (exiting) return;
        if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")
          || matchesKey(data, Key.escape)) {
          // Esc first closes an open row edit; only then does it finish.
          if (editingIndex !== null) cancelEdit();
          else void finish();
          return;
        }
        if (editingIndex !== null) {
          // The row editor owns every other key while open.
          editInput.handleInput(data);
          return;
        }
        if (onAddRow()) {
          // The add row owns the keys, except Up: it steps back to the list.
          if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.select.up")) {
            moveSelection(-1);
            return;
          }
          addInput.handleInput(data);
          return;
        }
        if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.select.up")) {
          moveSelection(-1);
          return;
        }
        if (matchesKey(data, Key.down) || keybindings.matches(data, "tui.select.down")) {
          moveSelection(1);
          return;
        }
        if (matchesKey(data, Key.enter) || keybindings.matches(data, "tui.select.confirm")) {
          startEdit();
          return;
        }
        if (matchesKey(data, Key.delete)) {
          deleteSelected();
          return;
        }
        if (typeof data === "string" && data.length === 1) {
          const key = data.toLowerCase();
          if (key === "c") {
            toggleSelectedCase();
            return;
          }
          if (key === "d") {
            deleteSelected();
            return;
          }
          if (key === "a") {
            goToAddRow();
            return;
          }
        }
        if (matchesKey(data, Key.f2)) {
          openJsonStage();
          return;
        }
      },
    };
  }, MASKING_SCREEN_OPTIONS);
}
