/**
 * ui/persisted-editor.ts
 * Overlay editor for the built-in persisted-secrets protection
 * (options.persistedSecrets): one scope guarding the pi sessions directory
 * (session transcripts keep restored values verbatim) and the masking
 * config file (every rule's `real`). The scope is a field-row form —
 * Enabled toggle, Scope mode cycle, On refusal cycle — plus an embedded
 * destination-list editor (Enter on the Destinations row; add input at the
 * end, D/Delete remove, Esc back to the fields). Esc finishes: with staged
 * changes an explicit confirmation picks Save & close, Discard changes, or
 * Back to editing — nothing is written without an explicit save. Saving
 * goes through the same options pipeline as the other settings.
 */

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth, type EditorTheme } from "@earendil-works/pi-tui";
import {
  GLOBAL_CONFIG_PATH,
  type ConfigScope,
  type PersistedSecretsScope,
  type ScopeMode,
  type RefuseAction,
} from "../config/config-loader.ts";
import {
  MASKING_SCREEN_OPTIONS,
  fillMaskingScreen,
  selectMaskingOption,
  wrappedMaskingText,
  type MaskingUIBridge,
} from "./masking-common.ts";
import { saveConfigOptionsUI } from "./rule-editor.ts";

const MODES: ScopeMode[] = ["strict", "semi-strict", "permissive"];
const REFUSALS: RefuseAction[] = ["block", "ask"];

function cycle<T>(values: T[], current: T, direction: 1 | -1): T {
  const index = values.indexOf(current);
  return values[(index + (direction === 1 ? 1 : values.length - 1)) % values.length]!;
}

export async function openPersistedSecretsEditor(
  bridge: MaskingUIBridge,
  ctx: ExtensionContext,
  current: PersistedSecretsScope,
): Promise<boolean> {
  const original: PersistedSecretsScope = { ...current, destinations: [...current.destinations] };
  const draft: PersistedSecretsScope = { ...current, destinations: [...current.destinations] };
  // Field rows: 0 Enabled · 1 Scope mode · 2 On refusal · 3 Destinations ·
  // 4 (implicit) Done.
  let selectedField = 0;
  // When true the Destinations list owns the keyboard: the field rows are
  // replaced by the list, an inline edit, and the trailing add input.
  let listEditing = false;
  let selectedIndex = 0;
  let editingIndex: number | null = null;
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
    const editInput = new Editor(tui, editorTheme, { paddingX: 1 });
    editInput.onChange = () => tui.requestRender();

    const refresh = () => tui.requestRender();
    const onAddRow = () => editingIndex === null && selectedIndex === draft.destinations.length;

    const outboundLabel = (): string =>
      draft.destinations.length === 0 ? "never outbound" : `${draft.destinations.length} destination(s)`;

    function addValue(raw: string): void {
      const value = raw.trim();
      if (!value) return;
      if (draft.destinations.includes(value)) {
        message = "Already listed";
        refresh();
        return;
      }
      draft.destinations.push(value);
      selectedIndex = draft.destinations.length - 1;
      message = "Staged · Esc to finish";
      refresh();
    }

    function startEdit(): void {
      if (onAddRow() || selectedIndex < 0 || selectedIndex >= draft.destinations.length) return;
      editingIndex = selectedIndex;
      editInput.setText(draft.destinations[selectedIndex]!);
      message = "Editing destination · Enter apply · Esc cancel";
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
        message = "Empty destination · edit cancelled";
        refresh();
        return;
      }
      if (draft.destinations.some((existing, i) => i !== index && existing === value)) {
        message = "Already listed · edit rejected";
        refresh();
        return;
      }
      draft.destinations[index] = value;
      message = "Staged · Esc to finish";
      refresh();
    };

    addInput.onSubmit = (text) => {
      addValue(text);
      addInput.setText("");
      refresh();
    };

    function deleteSelected(): void {
      if (onAddRow() || selectedIndex < 0 || selectedIndex >= draft.destinations.length) return;
      draft.destinations.splice(selectedIndex, 1);
      if (selectedIndex >= draft.destinations.length) selectedIndex = draft.destinations.length;
      message = "Staged · Esc to finish";
      refresh();
    }

    function moveSelection(delta: 1 | -1): void {
      const next = selectedIndex + delta;
      if (next < 0 || next > draft.destinations.length) return;
      selectedIndex = next;
      refresh();
    }

    function leaveListEditing(): void {
      listEditing = false;
      editingIndex = null;
      editInput.setText("");
      addInput.setText("");
      selectedIndex = 0;
      message = "";
      refresh();
    }

    async function finish(): Promise<void> {
      const changed = draft.enabled !== original.enabled
        || draft.mode !== original.mode
        || draft.onRefuse !== original.onRefuse
        || draft.destinations.length !== original.destinations.length
        || draft.destinations.some((host, index) => host !== original.destinations[index]);
      if (!changed) {
        done(false);
        return;
      }
      exiting = true;
      const summary: string[] = [];
      if (draft.enabled !== original.enabled) summary.push(draft.enabled ? "protection on" : "protection off");
      if (draft.mode !== original.mode) summary.push(`mode ${original.mode} → ${draft.mode}`);
      if (draft.onRefuse !== original.onRefuse) summary.push(`on refusal ${original.onRefuse} → ${draft.onRefuse}`);
      if (outboundLabel() !== (original.destinations.length === 0 ? "never outbound" : `${original.destinations.length} destination(s)`)) {
        summary.push(`outbound ${outboundLabel()}`);
      }
      const choice = await selectMaskingOption(
        ctx,
        "Finish Session history editing",
        ["Save & close", "Discard changes", "Back to editing"],
        `${summary.join(" · ") || "updated"} · written to the global config (${GLOBAL_CONFIG_PATH}).`,
      );
      if (choice === "Save & close") {
        const result = await saveConfigOptionsUI(bridge, ctx, { persistedSecrets: { ...draft } }, { scope: "global" as ConfigScope, path: GLOBAL_CONFIG_PATH });
        if (result.saved) {
          done(true);
          return;
        }
        exiting = false;
        message = "Save failed · changes remain staged";
        refresh();
        return;
      }
      if (choice === "Discard changes") {
        draft.enabled = original.enabled;
        draft.mode = original.mode;
        draft.onRefuse = original.onRefuse;
        draft.destinations = [...original.destinations];
        done(false);
        return;
      }
      exiting = false;
      message = "";
      refresh();
    }

    function cycleField(direction: 1 | -1): void {
      if (selectedField === 0) {
        draft.enabled = !draft.enabled;
        message = draft.enabled ? "Protection on" : "Protection off — transcripts and config can be sent out unchecked";
      } else if (selectedField === 1) {
        draft.mode = cycle(MODES, draft.mode, direction);
        message = `Staged · mode ${draft.mode}`;
      } else if (selectedField === 2) {
        draft.onRefuse = cycle(REFUSALS, draft.onRefuse, direction);
        message = `Staged · on refusal ${draft.onRefuse}`;
      } else {
        listEditing = true;
        selectedIndex = 0;
        message = "";
      }
      refresh();
    }

    return {
      render: (width) => {
        const lines: string[] = [
          theme.fg("accent", theme.bold("SESSION HISTORY · built-in protection")),
          ...wrappedMaskingText(
            theme.fg("dim", "Watches the pi sessions directory (transcripts keep restored values verbatim) and the masking config (every rule's real value). Local reads stay allowed; outbound sends are checked."),
            width,
          ),
        ];
        if (message) lines.push(...wrappedMaskingText(theme.fg("muted", message), width));
        lines.push("");

        if (!listEditing) {
          const rows: Array<[string, string, string]> = [
            ["Enabled", draft.enabled ? "on" : "off",
              draft.enabled
                ? "an outbound command that sends these files is checked"
                : "no protection — transcripts and config can be sent out unchecked"],
            ["Scope mode", draft.mode,
              "how a blind send (no verifiable destination) is judged"],
            ["On refusal", draft.onRefuse,
              draft.onRefuse === "block"
                ? "Block: the call is refused and the model is told why"
                : "Ask: you decide — approve releases this call, decline blocks it"],
            ["Destinations", outboundLabel(),
              draft.destinations.length === 0
                ? "the files may never be sent outbound · Enter to list exceptions"
                : "these destinations may receive the files · Enter to edit"],
          ];
          for (let index = 0; index < rows.length; index++) {
            const [label, value, description] = rows[index]!;
            const cursor = index === selectedField ? "›" : " ";
            const text = `${cursor} ${label.padEnd(14)}‹ ${value} ›`;
            lines.push(index === selectedField ? theme.fg("accent", truncateToWidth(text, Math.max(1, width))) : theme.fg("muted", truncateToWidth(text, Math.max(1, width))));
            if (index === selectedField) {
              lines.push(...wrappedMaskingText(theme.fg("dim", `    ${description}`), width));
            }
          }
          lines.push("");
          lines.push(...wrappedMaskingText(theme.fg("dim", "↑/↓ field · ←/→ or Space change · Enter destinations list · S save · Esc finish"), width));
        } else {
          lines.push(theme.fg("accent", truncateToWidth("  Destinations allowed to receive these files", Math.max(1, width))));
          lines.push("");
          if (draft.destinations.length === 0) {
            lines.push(theme.fg("warning", "No destinations — the files may never be sent outbound."));
          }
          for (let index = 0; index < draft.destinations.length; index++) {
            if (index === editingIndex) {
              lines.push(...editInput.render(width));
              continue;
            }
            const cursor = index === selectedIndex ? "›" : " ";
            const text = `${cursor} ${String(index + 1).padStart(3)}  ${draft.destinations[index]}`;
            lines.push(index === selectedIndex ? theme.fg("accent", truncateToWidth(text, Math.max(1, width))) : truncateToWidth(text, Math.max(1, width)));
          }
          if (onAddRow()) {
            lines.push(...addInput.render(width));
          } else {
            lines.push(theme.fg("dim", truncateToWidth("  ＋ Add destination…", Math.max(1, width))));
          }
          lines.push("");
          const hints = editingIndex !== null
            ? "Enter apply · Esc cancel edit"
            : onAddRow()
              ? "Type a destination · Enter add · ↑ back · Esc back to fields"
              : "↑/↓ navigate · Enter edit · D delete · A add · Esc back to fields";
          lines.push(...wrappedMaskingText(theme.fg("dim", hints), width));
        }
        return fillMaskingScreen(lines, width, tui.terminal.rows);
      },
      invalidate: () => {
        addInput.invalidate();
        editInput.invalidate();
      },
      handleInput: (data) => {
        if (exiting) return;
        const escape = keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")
          || matchesKey(data, Key.escape);
        if (listEditing) {
          if (escape) {
            if (editingIndex !== null) cancelEdit();
            else leaveListEditing();
            return;
          }
          if (editingIndex !== null) {
            editInput.handleInput(data);
            return;
          }
          if (onAddRow()) {
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
            if (key === "d") {
              deleteSelected();
              return;
            }
            if (key === "a") {
              selectedIndex = draft.destinations.length;
              refresh();
              return;
            }
          }
          return;
        }
        // Field mode
        if (escape) {
          void finish();
          return;
        }
        if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.select.up")) {
          selectedField = Math.max(0, selectedField - 1);
          message = "";
          refresh();
          return;
        }
        if (matchesKey(data, Key.down) || keybindings.matches(data, "tui.select.down")) {
          selectedField = Math.min(3, selectedField + 1);
          message = "";
          refresh();
          return;
        }
        if (matchesKey(data, Key.left)) {
          if (selectedField <= 2) cycleField(-1);
          return;
        }
        if (matchesKey(data, Key.right) || matchesKey(data, Key.space)) {
          if (selectedField <= 2) cycleField(1);
          else if (selectedField === 3) cycleField(1);
          return;
        }
        if (matchesKey(data, Key.enter) || keybindings.matches(data, "tui.select.confirm")) {
          if (selectedField === 3) {
            cycleField(1);
            return;
          }
          void finish();
          return;
        }
        if (typeof data === "string" && data.length === 1) {
          const key = data.toLowerCase();
          if (key === "s") {
            void finish();
            return;
          }
          if (key === " ") {
            if (selectedField <= 2) cycleField(1);
            return;
          }
        }
      },
    };
  }, MASKING_SCREEN_OPTIONS);
}
