/**
 * ui/config-screen.ts
 * The /masking home screen: rules list (filter/search/scroll), rule details,
 * settings zone (guidance / disclosure / status-line toggles), and the local
 * test area. Delegates mutations to ui/rule-editor.ts and crosses
 * MaskingUIBridge for state and activation.
 */

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, decodeKittyPrintable, type EditorTheme } from "@earendil-works/pi-tui";
import {
  GLOBAL_CONFIG_PATH,
  getProjectConfigPath,
  type ConfiguredMaskingRule,
  type MaskingConfig,
  type MaskingOptions,
  type RuleEnabledChange,
} from "../config-loader.ts";
import {
  MASKING_SCREEN_OPTIONS,
  confirmMaskingAction,
  fillMaskingScreen,
  selectMaskingOption,
  wrappedMaskingText,
  configuredRuleDetail,
  configuredRuleDisplayName,
  configuredRuleKind,
  configuredRuleStableKey,
  type MaskingUIBridge,
} from "./masking-common.ts";
import { openAllowlistEditor } from "./allowlist-editor.ts";
import {
  addConfigRule,
  applyBatchRuleState,
  deleteConfigRule,
  editConfigRule,
  exportConfigRules,
  importConfigRules,
  moveConfigRule,
  previewActiveRules,
  saveConfigOptionsUI,
  showRuleConfigurationHelp,
  toggleConfigRule,
  toggleGlobalMasking,
} from "./rule-editor.ts";

export async function openMaskingConfig(bridge: MaskingUIBridge, ctx: ExtensionContext): Promise<void> {
  // One-time migration offer: a project config carrying an options object
  // (settings are global-level now) is offered to move into the global
  // config on first /masking visit in that project.
  let migrationNote = "";
  const staleFields = bridge.staleProjectOptions();
  if (staleFields.length > 0) {
    const choice = await selectMaskingOption(
      ctx,
      "Project-level settings detected",
      ["Move to global config", "Leave as is"],
      `options (${staleFields.join(", ")}) in the project config are ignored — settings are global-level now. Move the values to the global config?`,
    );
    if (choice === "Move to global config") {
      const moved = await bridge.migrateProjectOptionsToGlobal(ctx);
      migrationNote = moved ? `Migrated to global config: ${moved.join(", ")}` : "";
    }
  }
  const filters = ["all", "enabled", "disabled", "project", "global", "literal", "regex", "preset"] as const;
  let filterIndex = 0;
  let searchQuery = "";
  let selectedRuleKey: string | undefined;
  let showExactValues = true;
  let homeTestText = "";
  let homeFocus: "settings" | "rules" | "test" = "rules";
  type ScreenAction =
    | { kind: "batch"; changes: RuleEnabledChange[] }
    | { kind: "edit"; rule: ConfiguredMaskingRule; initialMode?: "form" | "json" }
    | { kind: "delete"; rule: ConfiguredMaskingRule }
    | { kind: "add"; initialMode?: "form" | "json" }
    | { kind: "import" | "export" | "help" };
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    let screenRules = bridge.effectiveConfig().configuredRules;
    let selectedIndex = 0;
    let scrollOffset = 0;
    let rulePageSize = 1;
    let searchMode = false;
    let mutationInProgress = false;
    let mutationMessage = migrationNote;
    /** Extra rows granted to the rules list so it fills the terminal
     *  down to the hint bar; corrected each render from the shortfall. */
    let listExtraRows = 0;
    const settingsRows = ["masking", "guidance", "disclose", "status", "allowlist"] as const;
    let settingsIndex = 0;
    const testEditorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    const testEditor = new Editor(tui, testEditorTheme);
    testEditor.setText(homeTestText);
    testEditor.onSubmit = () => {};
    testEditor.onChange = (text) => {
      homeTestText = text;
      tui.requestRender();
    };

    function visibleRules(): ConfiguredMaskingRule[] {
      const filter = filters[filterIndex]!;
      const query = searchQuery.toLowerCase();
      return screenRules.filter((configured) => {
        const matchesFilter = filter === "all"
          || (filter === "enabled" && configured.enabled)
          || (filter === "disabled" && !configured.enabled)
          || filter === configured.scope
          || filter === configured.sourceKind;
        if (!matchesFilter) return false;
        if (!query) return true;
        return [
          configured.rule.id,
          configured.rule.name,
          configured.rule.description,
          configured.presetName,
          configured.realFromEnv,
          configured.scope,
          configured.sourceKind,
        ].some((value) => value?.toLowerCase().includes(query));
      });
    }

    if (selectedRuleKey) {
      const retainedIndex = visibleRules().findIndex(
        (configured) => configuredRuleStableKey(configured) === selectedRuleKey,
      );
      if (retainedIndex >= 0) selectedIndex = retainedIndex;
    }

    function refresh(): void {
      const visible = visibleRules();
      selectedIndex = Math.max(0, Math.min(selectedIndex, visible.length));
      tui.requestRender();
    }

    function keepSelectedVisible(listHeight: number, visibleCount: number): void {
      if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
      if (selectedIndex >= scrollOffset + listHeight) scrollOffset = selectedIndex - listHeight + 1;
      scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, visibleCount - listHeight)));
    }

    function retainSelectedRule(stableKey: string): void {
      selectedRuleKey = stableKey;
      const retainedIndex = visibleRules().findIndex(
        (configured) => configuredRuleStableKey(configured) === stableKey,
      );
      if (retainedIndex >= 0) selectedIndex = retainedIndex;
      else selectedIndex = Math.max(0, Math.min(selectedIndex, visibleRules().length));
    }

    /** Inline second confirmation for disabling global masking: rendered
     *  inside this screen (no separate overlay window). */
    let confirmDisableMasking = false;
    let confirmDisableYes = false;
    /** Inline cache-impact confirmation for rule enable/disable (and batch
     *  state changes): rendered in place of the rule details block. */
    let inlineConfirmState: { title: string; message: string; yes: boolean; resolve: (save: boolean) => void } | null = null;
    const inlineConfirm = (title: string, message: string): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        inlineConfirmState = { title, message, yes: false, resolve };
        mutationMessage = "";
        tui.requestRender();
      });

    function openConfirmDisableMasking(): void {
      confirmDisableMasking = true;
      confirmDisableYes = false;
      mutationMessage = "";
      refresh();
    }

    function toggleMaskingInPlace(): void {
      const baseConfig = bridge.effectiveConfig();
      if (!baseConfig.enabled) {
        performGlobalToggle();
        return;
      }
      // Second confirmation only matters when earlier model-bound context
      // was actually masked: disabling then changes the outbound prefix and
      // drops provider cache reuse. With nothing masked yet there is no
      // cache impact, so toggle directly.
      if (!bridge.sessionMaskedOutbound()) {
        performGlobalToggle();
        return;
      }
      openConfirmDisableMasking();
    }

    async function performGlobalToggle(): Promise<void> {
      const baseConfig = bridge.effectiveConfig();
      const enabled = !baseConfig.enabled;
      mutationInProgress = true;
      mutationMessage = enabled ? "Enabling masking…" : "Disabling masking…";
      tui.requestRender();
      const result = await toggleGlobalMasking(bridge, ctx);
      mutationInProgress = false;
      if (!result) {
        mutationMessage = "Global masking save failed";
      } else if (result.disposition === "queued") {
        mutationMessage = `Masking ${result.enabled ? "ON" : "OFF"} saved · activates next run`;
      } else {
        mutationMessage = `Masking ${result.enabled ? "ON" : "OFF"} · saved globally`;
      }
      screenRules = bridge.effectiveConfig().configuredRules;
      refresh();
    }

    /** Coupled guidance/disclosure toggle (settings zone). Enabling
     *  disclosure force-enables guidance; disabling guidance disables
     *  both — off / guidance-only / full are the only reachable states.
     *  The status-line row is an independent toggle. */
    async function toggleGuidanceInPlace(direction: 1 | -1 = 1): Promise<void> {
      // Base the next state on the effective config (queued changes included)
      // so repeated toggles during an active run accumulate correctly.
      const options = bridge.effectiveConfig().options;
      const next: Partial<Pick<MaskingOptions, "systemPromptGuidance" | "disclosePlaceholders" | "showStatusBar">> = {
        systemPromptGuidance: options.systemPromptGuidance,
        disclosePlaceholders: options.disclosePlaceholders,
      };
      if (settingsIndex === 3) {
        next.showStatusBar = !bridge.config().options.showStatusBar;
      } else if (settingsIndex === 2) {
        // Master mode cycle (←/→ or Space): off → on (disclose everything) →
        // per-rule (rule settings apply, unset rules stay off) → off. on and
        // per-rule force-enable guidance; switching to off/on leaves rule-level
        // values dormant.
        const mode = next.disclosePlaceholders;
        if (mode === false) {
          next.disclosePlaceholders = direction === 1 ? true : "per-rule";
          next.systemPromptGuidance = true;
        } else if (mode === true) {
          next.disclosePlaceholders = direction === 1 ? "per-rule" : false;
          if (direction === 1) next.systemPromptGuidance = true;
        } else {
          next.disclosePlaceholders = direction === 1 ? false : true;
          if (direction === -1) next.systemPromptGuidance = true;
        }
      } else {
        if (next.systemPromptGuidance) {
          next.systemPromptGuidance = false;
          next.disclosePlaceholders = false;
        } else {
          next.systemPromptGuidance = true;
        }
      }
      if (next.systemPromptGuidance === options.systemPromptGuidance
        && next.disclosePlaceholders === options.disclosePlaceholders
        && next.showStatusBar === options.showStatusBar) return;
      mutationInProgress = true;
      mutationMessage = "Saving…";
      refresh();
      const saved = await saveConfigOptionsUI(bridge, ctx, next);
      mutationInProgress = false;
      if (saved && next.systemPromptGuidance) bridge.clearGuidanceNotice();
      mutationMessage = saved
        ? settingsIndex === 3
          ? "Saved · status line updated"
          : "Saved · affects future requests"
        : "Save cancelled · no changes applied";
      refresh();
    }

    /** Settings row 5 (Allowlist): Enter/Space opens the staged editor; the
     *  save itself goes through the options pipeline with impact confirmation. */
    function openAllowlistInPlace(): void {
      mutationInProgress = true;
      mutationMessage = "Opening allowlist…";
      refresh();
      void (async () => {
        // Options are global-only: always edit the global config's own
        // allowlist (the file is created on save if it does not exist yet).
        const target = { scope: "global" as const, path: GLOBAL_CONFIG_PATH };
        const saved = await openAllowlistEditor(bridge, ctx, target, bridge.effectiveConfig().options.allowlist ?? []);
        mutationInProgress = false;
        mutationMessage = saved ? "Saved · global allowlist updated" : "";
        refresh();
      })();
    }

    async function toggleRuleInPlace(selected: ConfiguredMaskingRule): Promise<void> {
      const stableKey = configuredRuleStableKey(selected);
      const enabling = !selected.enabled;
      mutationInProgress = true;
      mutationMessage = "Saving…";
      tui.requestRender();
      const saved = await toggleConfigRule(bridge, ctx, selected, false, inlineConfirm);
      if (saved) {
        // Effective config: a queued change must show its target state now.
        screenRules = bridge.effectiveConfig().configuredRules;
        retainSelectedRule(stableKey);
        mutationMessage = enabling
          ? "Enabled · affects future requests"
          : "Disabled · future matches may be exposed";
      } else {
        mutationMessage = "Save failed · no changes applied";
      }
      mutationInProgress = false;
      refresh();
    }

    async function moveRuleInPlace(selected: ConfiguredMaskingRule, direction: -1 | 1): Promise<void> {
      const stableKey = configuredRuleStableKey(selected);
      mutationInProgress = true;
      mutationMessage = "Saving order…";
      tui.requestRender();
      const saved = await moveConfigRule(bridge, ctx, selected, direction, false);
      if (saved) {
        screenRules = bridge.effectiveConfig().configuredRules;
        retainSelectedRule(stableKey);
        mutationMessage = "Order saved";
      } else {
        mutationMessage = "Order unchanged";
      }
      mutationInProgress = false;
      refresh();
    }

    /** Keep the home overlay mounted while a child screen is open. Stacked
     * overlays transition in one render frame and restore focus to this
     * component, avoiding a transcript/blank-frame flash between pages. */
    async function runScreenAction(action: ScreenAction): Promise<void> {
      if (mutationInProgress) return;
      mutationInProgress = true;
      mutationMessage = action.kind === "edit" ? "Opening rule…"
        : action.kind === "add" ? "Opening rule builder…"
        : action.kind === "delete" ? "Opening confirmation…"
        : action.kind === "help" ? "Opening help…"
        : action.kind === "import" ? "Opening import…"
        : action.kind === "export" ? "Opening export…"
        : "Opening batch confirmation…";
      tui.requestRender();
      try {
        if (action.kind === "batch") await applyBatchRuleState(bridge, ctx, action.changes, inlineConfirm);
        else if (action.kind === "edit") await editConfigRule(bridge, ctx, action.rule, action.initialMode);
        else if (action.kind === "delete") await deleteConfigRule(bridge, ctx, action.rule);
        else if (action.kind === "add") await addConfigRule(bridge, ctx, undefined, { initialMode: action.initialMode });
        else if (action.kind === "help") await showRuleConfigurationHelp(ctx);
        else if (action.kind === "import") await importConfigRules(bridge, ctx);
        else await exportConfigRules(bridge, ctx);
      } finally {
        screenRules = bridge.effectiveConfig().configuredRules;
        mutationInProgress = false;
        mutationMessage = "";
        refresh();
      }
    }

    return {
      render: (width) => {
        const visibleRulesNow = visibleRules();
        let listRendered = false;
        let listExtraCap = 0;
        const active = screenRules.filter((configured) => configured.enabled && configured.available).length;
        const desiredConfig = bridge.effectiveConfig();
        const maskingEnabled = desiredConfig.enabled;
        const maskingActivationPending = bridge.activationPending() && desiredConfig.enabled !== bridge.config().enabled;
        // Settings-zone rows reflect the config that will run next; when a
        // change is queued behind the active agent run, say so per row.
        const options = desiredConfig.options;
        const activeOptions = bridge.config().options;
        // Rules whose enabled state is queued behind the active agent run:
        // the list shows the target state, the row carries a next-run hint.
        const activeRuleEnabled = new Map(bridge.config().configuredRules.map((r) => [configuredRuleStableKey(r), r.enabled]));
        const rulePendingHint = (configured: ConfiguredMaskingRule): string =>
          bridge.activationPending()
          && activeRuleEnabled.get(configuredRuleStableKey(configured)) !== configured.enabled
            ? " · activates next run" : "";
        const optionsPendingSuffix = bridge.activationPending()
          && (options.systemPromptGuidance !== activeOptions.systemPromptGuidance
            || options.disclosePlaceholders !== activeOptions.disclosePlaceholders
            || options.showStatusBar !== activeOptions.showStatusBar
            || JSON.stringify(options.allowlist ?? []) !== JSON.stringify(activeOptions.allowlist ?? []))
          ? " · activates next run" : "";
        const rulesDivider = theme.fg(homeFocus === "rules" ? "accent" : "dim", "─".repeat(Math.max(1, width)));
        const browseHints = wrappedMaskingText(theme.fg("dim", `Enter edit · F2 JSON · ←/→ or Space on/off · / search · R ${showExactValues ? "hide" : "show"} values · A add · D delete · Tab zone · M masking · H help · Esc close`), width);
        const settingsDivider = theme.fg(homeFocus === "settings" ? "accent" : "dim", "─".repeat(Math.max(1, width)));
        const settingRow = (index: number, label: string, value: boolean | string | number, description: string, cell?: string): string => {
          const selected = homeFocus === "settings" && index === settingsIndex;
          const marker = selected ? "▶" : " ";
          // Launcher rows (allowlist) pass an explicit cell: plain text, no
          // ‹ › toggle chrome, since ←/→ do nothing for them. The cell is
          // padded to the same 8-column slot as the toggle cells so the
          // description column stays aligned across rows.
          if (cell !== undefined) {
            const alignedCell = truncateToWidth(cell, 8).padEnd(8);
            const plain = `${marker} ${label}${" ".repeat(Math.max(0, 16 - label.length))} ${alignedCell}`;
            const rowBody = homeFocus === "settings"
              ? (selected ? theme.fg("accent", plain) : plain)
              : theme.fg("dim", plain);
            return truncateToWidth(rowBody + "  " + theme.fg("dim", truncateToWidth(description, Math.max(0, width - visibleWidth(plain) - 2))), width);
          }
          const rawLabel = typeof value === "boolean" ? (value ? "ON" : "OFF") : String(value);
          // ‹ › pinned to fixed columns; centering biases extra space to the
          // right so ON and OFF share the same leading column.
          const pad = Math.max(0, 4 - rawLabel.length);
          const valueLabel = " ".repeat(Math.ceil(pad / 2)) + rawLabel + " ".repeat(Math.floor(pad / 2));
          const valueCell = `‹ ${valueLabel} ›`;
          const plain = `${marker} ${label}${" ".repeat(Math.max(0, 16 - label.length))} ${valueCell}`;
          const descriptionWidth = Math.max(0, width - visibleWidth(plain) - 2);
          const desc = truncateToWidth(description, descriptionWidth);
          const rowBody = homeFocus === "settings"
            ? (selected ? theme.fg("accent", plain) : plain)
            : theme.fg("dim", plain);
          return truncateToWidth(rowBody + "  " + theme.fg("dim", desc), width);
        };
        const settingsLines: string[] = [
          homeFocus === "settings"
            ? theme.fg("accent", theme.bold("SETTINGS · focused · ←/→ or Space changes the selected row"))
            : theme.fg("muted", "SETTINGS · Tab to focus"),
          settingsDivider,
          settingRow(0, "Masking (global)", maskingEnabled,
            maskingActivationPending ? "master switch · saved · activates next run" : "master switch for all masking · saved across projects and future sessions"),
          settingRow(1, "Model guidance", options.systemPromptGuidance,
            `tell the model how to work with masked values${optionsPendingSuffix}`),
          settingRow(2, "Disclose", options.disclosePlaceholders,
            (options.disclosePlaceholders === "per-rule"
              ? "each rule's Disclose setting decides · set per rule in the rule editor"
              : "list literal-rule placeholders in the model guidance") + optionsPendingSuffix),
          settingRow(3, "Status line", options.showStatusBar,
            `show the masking summary on the status line at the bottom of the chat window${optionsPendingSuffix}`),
          settingRow(4, "Allowlist", (options.allowlist ?? []).length,
            `exact values that are never masked · Enter to edit${optionsPendingSuffix}`,
            `${(options.allowlist ?? []).length} values`),
        ];
        if (bridge.guidanceNoticePending() && !options.systemPromptGuidance) {
          settingsLines.push(...wrappedMaskingText(theme.fg("accent", "New in this version: model guidance tells the model how to work with masked values — enable it above."), width));
        }
        const confirmDisableLines = confirmDisableMasking
          ? [
            ...wrappedMaskingText(theme.fg("warning", theme.bold("Disable masking? Configured values may be exposed in future model requests.")), width),
            ...wrappedMaskingText(theme.fg("warning", "This setting persists across projects and future sessions; previously sent context cannot be retracted."), width),
            confirmDisableYes
              ? theme.fg("accent", "▶ Yes · disable masking    No · keep masking")
              : theme.fg("muted", "  Yes · disable masking  ▶ No · keep masking"),
            ...wrappedMaskingText(theme.fg("dim", "←→ select · Enter confirm · Esc cancel"), width),
          ]
          : [];
        const headerSummary = `${active} enabled / ${screenRules.length} configured · filter: ${filters[filterIndex]}${searchQuery ? ` · search: ${searchQuery}` : ""}`;
        const headerTitle = theme.fg("accent", theme.bold(`Masking configuration${mutationMessage ? ` · ${mutationMessage}` : ""}`));
        const lines: string[] = [
          truncateToWidth(`${headerTitle}  ${theme.fg("muted", headerSummary)}`, Math.max(1, width)),
          "",
          ...settingsLines,
          ...confirmDisableLines.length ? ["", ...confirmDisableLines] : [],
          "",
          homeFocus === "rules"
            ? theme.fg("accent", theme.bold("RULES · focused"))
            : theme.fg("muted", "RULES · Tab to focus"),
          rulesDivider,
        ];

        if (screenRules.length === 0) {
          lines.push(theme.fg("warning", "No rules are configured."));
          lines.push(theme.fg("muted", "Create or edit one of these files:"));
          lines.push(...wrappedMaskingText(theme.fg("dim", `  project  ${getProjectConfigPath(ctx.cwd)}`), width));
          lines.push(...wrappedMaskingText(theme.fg("dim", `  global   ${GLOBAL_CONFIG_PATH}`), width));
          lines.push("");
          lines.push(...wrappedMaskingText(theme.fg("accent", "Choose Add new rule; its Scope creates the project or global config when saved."), width));
          lines.push("", theme.fg("accent", "▶ ＋ Add new rule"));
        } else if (visibleRulesNow.length === 0) {
          lines.push(theme.fg("warning", "No rules match the current filter/search."));
          lines.push("", theme.fg("accent", "▶ ＋ Add new rule"));
        } else {
          const header = `  ${"STATE".padEnd(6)} ${"ORDER".padStart(5)}  ${"SCOPE".padEnd(7)}  ${"TYPE".padEnd(7)}  NAME`;
          lines.push(theme.fg("dim", truncateToWidth(header, Math.max(1, width))));
          const reservedRows = 21 + settingsLines.length + confirmDisableLines.length + browseHints.length;
          const rowCount = visibleRulesNow.length + 1;
          listRendered = true;
          listExtraCap = rowCount - (tui.terminal.rows - reservedRows);
          const listHeight = Math.max(3, Math.min(rowCount, tui.terminal.rows - reservedRows + listExtraRows));
          rulePageSize = listHeight;
          keepSelectedVisible(listHeight, rowCount);
          const endIndex = Math.min(rowCount, scrollOffset + listHeight);
          for (let absoluteIndex = scrollOffset; absoluteIndex < endIndex; absoluteIndex++) {
            if (absoluteIndex === visibleRulesNow.length) {
              const addRow = `${absoluteIndex === selectedIndex ? "▶" : " "} ＋ Add new rule`;
              lines.push(homeFocus !== "rules"
                ? theme.fg("dim", addRow)
                : absoluteIndex === selectedIndex ? theme.fg("accent", addRow) : theme.fg("muted", addRow));
              continue;
            }
            const configured = visibleRulesNow[absoluteIndex]!;
            const enabled = configured.enabled;
            const cursor = absoluteIndex === selectedIndex ? "›" : " ";
            const stateLabel = !enabled ? "OFF" : configured.available ? "ON" : "WAIT";
            const stateSlot = (label: string): string => {
              const pad = Math.max(0, 4 - label.length);
              return " ".repeat(Math.ceil(pad / 2)) + label + " ".repeat(Math.floor(pad / 2));
            };
            // ‹ › marks a toggle (same left-aligned cell as the settings zone); square
            // brackets mark the read-only WAIT state.
            const state = stateLabel === "WAIT" ? "[WAIT]" : `‹ ${stateSlot(stateLabel)} ›`;
            const priority = screenRules.indexOf(configured) + 1;
            const displayName = configuredRuleDisplayName(configured) + rulePendingHint(configured);
            const text = `${cursor} ${state} ${String(priority).padStart(5)}  ${configured.scope.padEnd(7)}  ${configuredRuleKind(configured).padEnd(7)}  ${displayName}`;
            const clipped = truncateToWidth(text, Math.max(1, width));
            lines.push(homeFocus !== "rules"
              ? theme.fg("dim", clipped)
              : absoluteIndex === selectedIndex
                ? theme.fg("accent", clipped)
                : enabled ? clipped : theme.fg("dim", clipped));
          }

        }

        lines.push(rulesDivider);
        if (inlineConfirmState) {
          // Temporarily replaces the rule details block below the list.
          lines.push(...wrappedMaskingText(theme.fg("warning", theme.bold(inlineConfirmState.title)), width));
          lines.push(...wrappedMaskingText(inlineConfirmState.message, width));
          lines.push(theme.fg("accent", `${inlineConfirmState.yes ? "▶" : " "} Save anyway    ${inlineConfirmState.yes ? " " : "▶"} Back to editing`));
          lines.push(...wrappedMaskingText(theme.fg("dim", "←→ select · Enter confirm · Esc back to editing"), width));
        } else if (screenRules.length > 0 && visibleRulesNow.length > 0) {
          // Keep details outside the list dividers and reserve a fixed block
          // so exact/env/regex/preset rows never move the test panel.
          const detailRowCount = 5;
          const selected = visibleRulesNow[selectedIndex];
          const details = selected
            ? configuredRuleDetail(selected, showExactValues, bridge.config().options.disclosePlaceholders, (text) => theme.fg("dim", text))
            : [];
          for (let index = 0; index < detailRowCount; index++) {
            const detail = details[index];
            lines.push(detail
              ? truncateToWidth(homeFocus === "rules" ? detail : theme.fg("dim", detail), Math.max(1, width))
              : "");
          }
        }
        lines.push("");
        if (searchMode) {
          lines.push(theme.fg("accent", `Search: ${searchQuery}▌`));
          lines.push(...wrappedMaskingText(theme.fg("dim", "Type to search · Backspace delete · Enter accept · Esc clear"), width));
        } else {
          const showTestPanel = tui.terminal.rows >= 26 || homeFocus === "test" || homeTestText.length > 0;
          if (showTestPanel) {
            testEditor.focused = homeFocus === "test";
            testEditor.borderColor = (text) => theme.fg(homeFocus === "test" ? "accent" : "dim", text);
            const testTitle = homeFocus === "test"
              ? theme.fg("accent", theme.bold(`TEST ACTIVE RULES · focused${bridge.config().enabled ? "" : " · masking is off; preview only"}`))
              : theme.fg("muted", `TEST ACTIVE RULES · Tab to focus${bridge.config().enabled ? "" : " · masking is off; preview only"}`);
            lines.push(...wrappedMaskingText(testTitle, width));
            lines.push(...testEditor.render(width));
            const preview = previewActiveRules(bridge, testEditor.getExpandedText());
            const status = preview.count > 0 ? `${preview.count} value(s) masked` : preview.attribution;
            lines.push(theme.fg(preview.count > 0 ? "accent" : "muted", `Preview: ${status}`));
            for (const line of preview.text.split("\n").slice(0, 2)) {
              if (line) lines.push(line);
            }
            if (preview.count > 0) lines.push(theme.fg("muted", `Matched: ${preview.attribution}`));
          } else {
            lines.push(theme.fg("muted", "TEST ACTIVE RULES · Tab to focus"));
          }
          lines.push("");
          lines.push(...browseHints);
        }
        // Let the rules list absorb any unused rows below the hint bar.
        if (listRendered) {
          const shortfall = tui.terminal.rows - lines.length;
          if (shortfall !== 0) {
            const reservedRows = 21 + settingsLines.length + confirmDisableLines.length + browseHints.length;
            const baseHeight = tui.terminal.rows - reservedRows;
            const next = Math.min(Math.max(listExtraRows + shortfall, -(baseHeight + 3)), listExtraCap);
            if (next !== listExtraRows) {
              listExtraRows = next;
              tui.requestRender();
            }
          }
        }
        return fillMaskingScreen(lines, width, tui.terminal.rows);
      },
      invalidate: () => {},
      handleInput: (data) => {
        if (inlineConfirmState) {
          const state = inlineConfirmState;
          const leftRight = matchesKey(data, Key.left) || matchesKey(data, Key.right);
          const upDown = keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down");
          if (leftRight || upDown) {
            state.yes = !state.yes;
            tui.requestRender();
            return;
          }
          if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "y") || data === "Y") {
            inlineConfirmState = null;
            tui.requestRender();
            state.resolve(true);
            return;
          }
          if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")
            || matchesKey(data, "n") || data === "N") {
            inlineConfirmState = null;
            tui.requestRender();
            state.resolve(false);
            return;
          }
          return;
        }
        if (mutationInProgress) return;
        mutationMessage = "";
        if (confirmDisableMasking) {
          const leftRight = matchesKey(data, Key.left) || matchesKey(data, Key.right);
          const upDown = keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down");
          if (leftRight || upDown) {
            confirmDisableYes = !confirmDisableYes;
            refresh();
            return;
          }
          if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "y") || data === "Y") {
            confirmDisableMasking = false;
            void performGlobalToggle();
            return;
          }
          if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")
            || matchesKey(data, "n") || data === "N") {
            confirmDisableMasking = false;
            mutationMessage = "Global masking unchanged";
            refresh();
            return;
          }
          return;
        }
        if (searchMode) {
          if (matchesKey(data, Key.enter)) {
            searchMode = false;
            refresh();
          } else if (matchesKey(data, Key.escape)) {
            searchMode = false;
            searchQuery = "";
            refresh();
          } else if (matchesKey(data, Key.backspace)) {
            searchQuery = searchQuery.slice(0, -1);
            refresh();
          } else {
            const printable = decodeKittyPrintable(data) ?? (data.length === 1 ? data : undefined);
            if (printable && printable.length === 1 && printable >= " ") {
              searchQuery += printable;
              refresh();
            }
          }
          return;
        }

        if (homeFocus === "test") {
          if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
            homeFocus = "settings";
            refresh();
          } else if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) {
            done(undefined);
          } else {
            testEditor.handleInput(data);
          }
          return;
        }

        if (homeFocus === "settings") {
          if (matchesKey(data, Key.tab)) {
            homeFocus = "rules";
            refresh();
            return;
          }
          if (matchesKey(data, Key.shift("tab"))) {
            homeFocus = "test";
            refresh();
            return;
          }
          if (keybindings.matches(data, "tui.select.up")) {
            settingsIndex = (settingsIndex + settingsRows.length - 1) % settingsRows.length;
            refresh();
            return;
          }
          if (keybindings.matches(data, "tui.select.down")) {
            settingsIndex = (settingsIndex + 1) % settingsRows.length;
            refresh();
            return;
          }
          if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
            const direction: 1 | -1 = matchesKey(data, Key.left) ? -1 : 1;
            if (settingsIndex === 0) toggleMaskingInPlace();
            else if (settingsIndex === 4) openAllowlistInPlace();
            else void toggleGuidanceInPlace(direction);
            return;
          }
          if (matchesKey(data, Key.space) || keybindings.matches(data, "tui.select.confirm")) {
            if (settingsIndex === 0) toggleMaskingInPlace();
            else if (settingsIndex === 4) openAllowlistInPlace();
            else void toggleGuidanceInPlace();
            return;
          }
          if (matchesKey(data, "m") || data === "M") {
            toggleMaskingInPlace();
            return;
          }
          if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) {
            done(undefined);
          }
          return;
        }
        if (matchesKey(data, Key.tab)) {
          homeFocus = "test";
          refresh();
          return;
        }
        if (matchesKey(data, Key.shift("tab"))) {
          homeFocus = "settings";
          refresh();
          return;
        }

        const visible = visibleRules();
        const selected = visible[selectedIndex];
        if (matchesKey(data, Key.f2)) {
          void runScreenAction(selected
            ? { kind: "edit", rule: selected, initialMode: "json" }
            : { kind: "add", initialMode: "json" });
          return;
        }
        if (matchesKey(data, Key.ctrl(Key.up)) && selected) {
          void moveRuleInPlace(selected, -1);
          return;
        }
        if (matchesKey(data, Key.ctrl(Key.down)) && selected) {
          void moveRuleInPlace(selected, 1);
          return;
        }
        if (keybindings.matches(data, "tui.select.up")) {
          selectedIndex = Math.max(0, selectedIndex - 1);
          refresh();
          return;
        }
        if (keybindings.matches(data, "tui.select.down")) {
          selectedIndex = Math.min(visible.length, selectedIndex + 1);
          refresh();
          return;
        }
        if (keybindings.matches(data, "tui.select.pageUp")) {
          selectedIndex = Math.max(0, selectedIndex - rulePageSize);
          refresh();
          return;
        }
        if (keybindings.matches(data, "tui.select.pageDown")) {
          selectedIndex = Math.min(visible.length, selectedIndex + rulePageSize);
          refresh();
          return;
        }
        if (matchesKey(data, Key.home)) {
          selectedIndex = 0;
          refresh();
          return;
        }
        if (matchesKey(data, Key.end)) {
          selectedIndex = visible.length;
          refresh();
          return;
        }
        if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
          if (selected) void toggleRuleInPlace(selected);
          return;
        }
        if (matchesKey(data, Key.space) && selected) {
          void toggleRuleInPlace(selected);
          return;
        }
        if (matchesKey(data, "m") || data === "M") {
          toggleMaskingInPlace();
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm")) {
          void runScreenAction(selected ? { kind: "edit", rule: selected } : { kind: "add" });
          return;
        }
        if ((matchesKey(data, "d") || matchesKey(data, Key.delete)) && selected) {
          const retained = visible[selectedIndex + 1] ?? visible[selectedIndex - 1];
          selectedRuleKey = retained ? configuredRuleStableKey(retained) : undefined;
          void runScreenAction({ kind: "delete", rule: selected });
          return;
        }
        if (matchesKey(data, "a")) return void runScreenAction({ kind: "add" });
        if (matchesKey(data, "r")) {
          showExactValues = !showExactValues;
          refresh();
          return;
        }
        if (matchesKey(data, "i")) return void runScreenAction({ kind: "import" });
        if (matchesKey(data, "x")) return void runScreenAction({ kind: "export" });
        if (matchesKey(data, "h")) return void runScreenAction({ kind: "help" });
        if (matchesKey(data, "f")) {
          filterIndex = (filterIndex + 1) % filters.length;
          selectedIndex = 0;
          scrollOffset = 0;
          refresh();
          return;
        }
        if (matchesKey(data, Key.slash)) {
          searchMode = true;
          refresh();
          return;
        }
        if (matchesKey(data, "b") && visible.length > 0) {
          const enabled = visible.some((configured) => !configured.enabled);
          const changes = visible.filter((configured) => configured.enabled !== enabled).map((configured) => ({
            path: configured.path,
            sourceIndex: configured.sourceIndex,
            id: configured.rule.id,
            enabled,
          }));
          void runScreenAction({ kind: "batch", changes });
          return;
        }
        if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) {
          done(undefined);
        }
      },
    };
  }, MASKING_SCREEN_OPTIONS);
}

