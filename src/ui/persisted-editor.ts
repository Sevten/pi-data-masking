/**
 * ui/persisted-editor.ts
 * Overlay editor for the built-in persisted-secrets protection
 * (options.persistedSecrets): one scope guarding the pi sessions directory
 * (session transcripts keep restored values verbatim) and the masking config
 * file (every rule's `real`). The form mirrors the Rule Builder's scope
 * experience: same row grammar (▶ marker, 14-column label, ‹ value ›
 * selector), the description of the focused field rendered once below the
 * rows so navigation never shifts them, and the same Outbound selector
 * (Never / Listed only) governing the Destinations list. Esc finishes: with
 * staged changes an explicit confirmation picks Save & close, Discard
 * changes, or Back to editing — nothing is written without an explicit
 * save. Saving goes through the same options pipeline as the other settings.
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
import { saveConfigOptionsUI, valueWithCursor } from "./rule-editor.ts";

const MODES: ScopeMode[] = ["strict", "semi-strict", "permissive"];
const REFUSALS: RefuseAction[] = ["block", "ask"];
const LABEL_WIDTH = 14;

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
  // Outbound selector, mirroring the Rule Builder: `anywhere` = no
  // destination checks (stored as ["*"], judged like a rule scope without a
  // destinations key); `listed` = only the listed destinations; `never` =
  // the files may never be sent outbound. Switching away from Listed
  // stashes the list so a stray flip does not destroy it.
  type Outbound = "anywhere" | "listed" | "never";
  const outboundOf = (destinations: string[]): Outbound =>
    destinations.includes("*") ? "anywhere" : destinations.length === 0 ? "never" : "listed";
  let outbound: Outbound = outboundOf(draft.destinations);
  let stashedDestinations: string[] = [];
  // Field rows depend on the Outbound choice: 0 Enabled · 1 Outbound ·
  // 2 Destinations (only when Listed only) · 3 Scope mode · 4 On refusal.
  const fieldCount = () => (outbound === "listed" ? 5 : 4);
  const DEST_FIELD = () => (outbound === "listed" ? 2 : -1);
  let selectedField = 0;
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
    // Inline comma-list editor, exactly like the Rule Builder's
    // Destinations field: typing edits, ↑/↓ move between fields.
    const destinationsEditor = new Editor(tui, editorTheme, { paddingX: 1 });
    destinationsEditor.setText(draft.destinations.join(", "));
    destinationsEditor.onChange = (text) => {
      draft.destinations = text.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      tui.requestRender();
    };

    const refresh = () => tui.requestRender();

    const outboundLabel = (value: Outbound = outbound): string =>
      value === "never" ? "Never" : value === "listed" ? "Listed only" : "Anywhere";
    const outboundDescription = (): string =>
      outbound === "anywhere"
        ? "Anywhere: outbound sends are not destination-checked · Scope mode still governs blind sends"
        : outbound === "listed"
          ? "Listed only: outbound sends require a destination from the list below"
          : "Never: the files may never be sent outbound · whether local use is allowed is set by Scope mode";
    const OUTBOUND_CYCLE: Outbound[] = ["anywhere", "listed", "never"];

    function setOutbound(next: Outbound): void {
      if (next === outbound) return;
      if (outbound === "listed") stashedDestinations = [...draft.destinations];
      outbound = next;
      draft.destinations = next === "listed"
        ? [...stashedDestinations]
        : next === "anywhere" ? ["*"] : [];
      destinationsEditor.setText(draft.destinations.join(", "));
      if (next === "listed") {
        stashedDestinations = [];
        selectedField = DEST_FIELD();
      }
      message = "Staged";
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
      if (outboundLabel() !== outboundLabel(outboundOf(original.destinations))) {
        summary.push(`outbound ${outboundLabel()}`);
      }
      if (draft.mode !== original.mode) summary.push(`mode ${original.mode} → ${draft.mode}`);
      if (draft.onRefuse !== original.onRefuse) summary.push(`on refusal ${original.onRefuse} → ${draft.onRefuse}`);
      if (draft.destinations.length !== original.destinations.length
        || draft.destinations.some((host, index) => host !== original.destinations[index])) {
        summary.push(`${draft.destinations.length} destination(s)`);
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
        outbound = outboundOf(draft.destinations);
        destinationsEditor.setText(draft.destinations.join(", "));
        done(false);
        return;
      }
      exiting = false;
      message = "";
      refresh();
    }

    /** Rule-editor semantics: changing the mode re-presets On refusal. */
    const presetRefusal = (mode: ScopeMode): RefuseAction => (mode === "permissive" ? "ask" : "block");

    function cycleField(direction: 1 | -1): void {
      if (selectedField === 0) {
        draft.enabled = !draft.enabled;
        message = draft.enabled ? "Protection on" : "Protection off — transcripts and config can be sent out unchecked";
      } else if (selectedField === 1) {
        setOutbound(cycle(OUTBOUND_CYCLE, outbound, direction));
        return;
      } else if (selectedField === DEST_FIELD()) {
        // An editor field: keys go to the editor, not a cycler.
        return;
      } else if (selectedField === fieldCount() - 2) {
        draft.mode = cycle(MODES, draft.mode, direction);
        draft.onRefuse = presetRefusal(draft.mode);
        message = `Staged · mode ${draft.mode} · on refusal ${draft.onRefuse}`;
      } else {
        draft.onRefuse = cycle(REFUSALS, draft.onRefuse, direction);
        message = `Staged · on refusal ${draft.onRefuse}`;
      }
      refresh();
    }

    /** The description rows render once below the field rows (Rule Builder
     *  pattern): navigation never shifts the field rows themselves. */
    const fieldRow = (index: number): [string, string, boolean?] | null => {
      const marker = index === selectedField ? "▶" : " ";
      const row = (label: string, value: string, dim = false): string =>
        dim
          ? `${marker} ${label.padEnd(LABEL_WIDTH)}  ${value}`
          : `${marker} ${label.padEnd(LABEL_WIDTH)}  ‹ ${value} ›`;
      if (index === 0) {
        return [row("Enabled", draft.enabled ? "ON" : "OFF"),
          draft.enabled
            ? "an outbound command that sends these files is checked"
            : "no protection — transcripts and config can be sent out unchecked"];
      }
      if (index === 1) return [row("Outbound", outboundLabel()), outboundDescription()];
      if (index === DEST_FIELD()) {
        const typed = destinationsEditor.getExpandedText().trim();
        const value = index === selectedField
          ? valueWithCursor(destinationsEditor, 44)
          : typed.length > 0 ? typed : "(e.g. archive.internal, 10.0.*)";
        return [row("Destinations", value, typed.length === 0 && index !== selectedField),
          "these destinations may receive the files · comma-separated"];
      }
      if (index === fieldCount() - 2) {
        return [row("Scope mode", draft.mode === "strict" ? "Strict" : draft.mode === "semi-strict" ? "Semi-strict" : "Permissive"),
          "how a blind send (no verifiable destination) is judged · ←/→ re-presets On refusal"];
      }
      return [row("On refusal", draft.onRefuse === "block" ? "Block" : "Ask"),
        draft.onRefuse === "block"
          ? "Block: the call is refused and the model is told why"
          : "Ask: you decide — approve releases this call, decline blocks it"];
    };

    return {
      render: (width) => {
        const lines: string[] = [
          theme.fg("accent", theme.bold("SESSION HISTORY · built-in protection")),
          ...wrappedMaskingText(
            theme.fg("dim", "Protects the two files where your secrets sit in plain text: the session transcripts and the masking config that stores every rule's real value. Reading them locally is always allowed; sending them anywhere else is checked."),
            width,
          ),
        ];
        lines.push("");

        let focusedDescription = "";
        for (let index = 0; index < fieldCount(); index++) {
          const cell = fieldRow(index);
          if (!cell) continue;
          const [text, description, dim] = cell;
          lines.push(index === selectedField
            ? theme.fg("accent", truncateToWidth(text, Math.max(1, width)))
            : dim
              ? theme.fg("dim", truncateToWidth(text, Math.max(1, width)))
              : theme.fg("muted", truncateToWidth(text, Math.max(1, width))));
          if (index === selectedField) focusedDescription = description;
        }
        if (focusedDescription) {
          lines.push(...wrappedMaskingText(theme.fg("dim", focusedDescription), width));
        }
        // Staged-change notices render below the field block so navigation
        // never shifts the rows.
        if (message) lines.push(...wrappedMaskingText(theme.fg("muted", message), width));
        lines.push("");
        lines.push(...wrappedMaskingText(theme.fg("dim", "↑/↓ field · ←/→ change or edit · S save · Esc finish"), width));
        return fillMaskingScreen(lines, width, tui.terminal.rows);
      },
      invalidate: () => {
        destinationsEditor.invalidate();
      },
      handleInput: (data) => {
        if (exiting) return;
        const escape = keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")
          || matchesKey(data, Key.escape);
        // Field mode. Esc always finishes; ↑/↓ always navigate; everything
        // else depends on the focused field — editors own their keys (Rule
        // Builder behavior), selector rows cycle on ←/→/Space.
        if (escape) {
          void finish();
          return;
        }
        const navigate = (delta: -1 | 1): void => {
          selectedField = Math.max(0, Math.min(fieldCount() - 1, selectedField + delta));
          message = "";
          refresh();
        };
        if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.select.up")) {
          navigate(-1);
          return;
        }
        if (matchesKey(data, Key.down) || keybindings.matches(data, "tui.select.down")) {
          navigate(1);
          return;
        }
        if (selectedField === DEST_FIELD()) {
          if (matchesKey(data, Key.enter) || keybindings.matches(data, "tui.select.confirm")) {
            navigate(1);
            return;
          }
          destinationsEditor.handleInput(data);
          return;
        }
        if (matchesKey(data, Key.left)) {
          cycleField(-1);
          return;
        }
        if (matchesKey(data, Key.right) || matchesKey(data, Key.space)) {
          cycleField(1);
          return;
        }
        if (matchesKey(data, Key.enter) || keybindings.matches(data, "tui.select.confirm")) {
          void finish();
          return;
        }
        if (typeof data === "string" && data.length === 1 && data.toLowerCase() === "s") {
          void finish();
          return;
        }
      },
    };
  }, MASKING_SCREEN_OPTIONS);
}
