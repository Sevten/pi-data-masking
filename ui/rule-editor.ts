/**
 * ui/rule-editor.ts
 * Rule Builder and rule/state mutation flows for /masking: add/edit/delete/
 * move/enable/disable rules (form + JSON modes), import/export, global
 * masking toggle, options saving, and the local test-preview helpers.
 * All state access and config activation cross MaskingUIBridge.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type EditorTheme } from "@earendil-works/pi-tui";
import {
  GLOBAL_CONFIG_PATH,
  ensureProjectConfigGitignored,
  generateUniqueRuleId,
  getProjectConfigPath,
  previewConfigOptionChanges,
  previewConfigRuleMutations,
  previewRuleEnabledChanges,
  readRawConfigFile,
  redactRawConfigFile,
  saveConfigOptionChanges,
  saveConfigRuleMutations,
  savePersistentToggle,
  saveRuleEnabledChanges,
  buildInitialConfig,
  validateConfig,
  validateRawConfigRule,
  createJsonFileExclusive,
  type ConfigScope,
  type ConfiguredMaskingRule,
  type MaskingConfig,
  type MaskingOptions,
  type RawConfigRule,
  type RuleEnabledChange,
} from "../config-loader.ts";
import { Masker, isRegexRule, type MaskingRule } from "../masker.ts";
import { generatePlaceholder } from "../placeholder-gen.ts";
import { MASKING_PRESETS } from "../presets.ts";
import {
  MASKING_SCREEN_OPTIONS,
  chooseExistingSource,
  confirmMaskingAction,
  fillMaskingScreen,
  inputMaskingValue,
  selectMaskingOption,
  wrappedMaskingText,
  configuredRuleDisplayName,
  configuredRuleStableKey,
  type ConfigSaveConfirmation,
  type ConfigSaveResult,
  type MaskingUIBridge,
} from "./masking-common.ts";

export async function toggleGlobalMasking(
  bridge: MaskingUIBridge,
  ctx: ExtensionContext,
): Promise<{ enabled: boolean; disposition: "activated" | "queued" } | undefined> {
  const baseConfig = bridge.effectiveConfig();
  const enabled = !baseConfig.enabled;
  try {
    await savePersistentToggle(enabled);
  } catch (err) {
    ctx.ui.notify(`Failed to save masking setting: ${(err as Error).message}`, "error");
    return undefined;
  }
  const disposition = bridge.acceptConfigChange(ctx, { ...baseConfig, enabled }, "toggle");
  ctx.ui.notify(
    disposition === "queued"
      ? `Data masking ${enabled ? "enable" : "disable"} saved; the active run keeps its current rules, the change activates before the next run, and recorded history is not rewritten`
      : `Data masking ${enabled ? "enabled" : "disabled"}; previously recorded masking facts remain unchanged (saved across projects and future sessions)`,
    "info",
  );
  return { enabled, disposition };
}
export async function saveStructuralChanges(
  bridge: MaskingUIBridge,
  ctx: ExtensionContext,
  mutations: Parameters<typeof saveConfigRuleMutations>[0],
  confirmation: ConfigSaveConfirmation = {},
): Promise<boolean> {
  try {
    const preview = await previewConfigRuleMutations(mutations);
    const candidate = await bridge.candidateConfigFromSources(ctx, preview.sources);
    const outcome = await bridge.confirmConfigSave(ctx, candidate.config, confirmation);
    if (!outcome.saved) return false;
    const saved = await saveConfigRuleMutations(mutations);
    bridge.notifyWarnings(ctx, saved.warnings);
    await bridge.reloadConfigNow(ctx);
    return true;
  } catch (err) {
    ctx.ui.notify(`Failed to update masking config: ${(err as Error).message}`, "error");
    return false;
  }
}

export async function saveRuleStateChanges(
  bridge: MaskingUIBridge,
  ctx: ExtensionContext,
  changes: RuleEnabledChange[],
  confirmation: ConfigSaveConfirmation = {},
  ask?: (title: string, message: string) => Promise<boolean>,
): Promise<ConfigSaveResult> {
  const preview = await previewRuleEnabledChanges(changes);
  const candidate = await bridge.candidateConfigFromSources(ctx, preview.sources);
  const outcome = await bridge.confirmConfigSave(ctx, candidate.config, confirmation, ask);
  if (!outcome.saved) return { saved: false };
  await saveRuleEnabledChanges(changes);
  await bridge.reloadConfigNow(ctx);
  return { saved: true, impact: outcome.impact };
}
export interface LocalMaskingPreview {
  text: string;
  count: number;
  attribution: string;
  warnings: string[];
}
export function previewWithRules(
  bridge: MaskingUIBridge,
  input: string,
  rules: MaskingRule[],
  names: ReadonlyMap<string, string>,
  warnings: string[] = [],
): LocalMaskingPreview {
  if (!input) return { text: "", count: 0, attribution: "Enter text to preview locally", warnings };
  if (rules.length === 0) return { text: input, count: 0, attribution: "No valid rules available for this preview", warnings };
  const tempMasker = new Masker(
    rules,
    bridge.sessionKey(),
    new Map(),
    new Set(),
    new Set(),
    bridge.config().options.allowlist ?? [],
  );
  const result = tempMasker.mask(input);
  let attribution: string;
  if (result.details.length > 0) {
    attribution = result.details.map((detail) => {
      const occurrences = detail.values.reduce((sum, value) => sum + value.occurrences, 0);
      return `${names.get(detail.ruleId) ?? detail.ruleId} ×${occurrences}`;
    }).join(" · ");
  } else {
    // Surface allowlisted values in the preview: they match rules but stay
    // unmasked by design, so "No values matched" would be misleading.
    const allowlist = bridge.config().options.allowlist ?? [];
    const present = allowlist.filter((entry) => entry.text.length > 0
      && (entry.caseSensitive === false
        ? input.toLowerCase().includes(entry.text.toLowerCase())
        : input.includes(entry.text)));
    attribution = present.length > 0
      ? `${present.length} allowlisted value(s) left unmasked`
      : "No values matched";
  }
  return {
    text: result.text,
    count: result.count,
    attribution,
    warnings: [...warnings, ...tempMasker.warnings],
  };
}

export function previewCandidateRule(bridge: MaskingUIBridge, input: string, draftText: string): LocalMaskingPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(draftText) as unknown;
  } catch (err) {
    return { text: input, count: 0, attribution: "Draft is not valid JSON", warnings: [(err as Error).message] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { text: input, count: 0, attribution: "Draft must be a JSON object", warnings: [] };
  }
  const candidate: RawConfigRule = { ...(parsed as RawConfigRule), enabled: true };
  if (typeof candidate.id !== "string" || !candidate.id.trim()) candidate.id = "preview-rule";
  const validated = validateConfig([candidate]);
  let mutationWarnings: string[] = [];
  try {
    mutationWarnings = validateRawConfigRule(candidate);
  } catch {
    // validateConfig warnings below already explain why no runnable rule exists.
  }
  for (const rule of validated.rules) {
    if (!isRegexRule(rule) && (!rule.placeholder || rule.placeholder === "auto")) {
      rule.placeholder = generatePlaceholder(rule.real, bridge.sessionKey(), 0, rule.preserveStructure);
    }
  }
  const id = typeof candidate.id === "string" ? candidate.id : "candidate";
  const name = typeof candidate.name === "string" ? candidate.name : id;
  return previewWithRules(
    bridge,
    input,
    validated.rules,
    new Map([[id, name]]),
    [...new Set([...validated.warnings, ...mutationWarnings])],
  );
}

export function previewActiveRules(bridge: MaskingUIBridge, input: string): LocalMaskingPreview {
  const names = new Map<string, string>();
  for (const configured of bridge.config().configuredRules) {
    if (!names.has(configured.rule.id)) names.set(configured.rule.id, configuredRuleDisplayName(configured));
  }
  return previewWithRules(bridge, input, bridge.config().rules, names);
}
export async function addConfigRule(
  bridge: MaskingUIBridge,
  ctx: ExtensionContext,
  editing?: { configured: ConfiguredMaskingRule; original: RawConfigRule; initial: RawConfigRule },
  options: { initialMode?: "form" | "json" } = {},
): Promise<string | undefined> {
  const projectPath = getProjectConfigPath(ctx.cwd);
  const sources: Array<{ scope: ConfigScope; path: string; label: string }> = [
    { scope: "project", path: projectPath, label: `project · ${projectPath}` },
    { scope: "global", path: GLOBAL_CONFIG_PATH, label: `global · ${GLOBAL_CONFIG_PATH}` },
  ];

  const existingIds = new Map<string, string[]>();
  try {
    for (const source of sources) {
      if (existsSync(source.path)) {
        const raw = await readRawConfigFile(source.path);
        existingIds.set(source.path, raw.rules.flatMap((rule) => typeof rule.id === "string" ? [rule.id] : []));
      } else {
        existingIds.set(source.path, []);
      }
    }
  } catch (err) {
    ctx.ui.notify(`Failed to open Rule Builder: ${(err as Error).message}`, "error");
    return;
  }

  type BuilderType = "Built-in preset template" | "Literal from environment" | "Exact literal value" | "Custom regex";
  type BuilderField = "type" | "scope" | "name" | "description" | "pattern" | "flags" | "case" | "env" | "real" | "replacement" | "placeholder" | "disclose" | "json" | "test";
  const builderTypes: readonly BuilderType[] = ["Built-in preset template", "Literal from environment", "Exact literal value", "Custom regex"];
  let selectedSource: (typeof sources)[number] = sources.find((source) => source.scope === "global")!;
  let selectedType: BuilderType | undefined;
  if (editing) {
    selectedSource = sources.find((source) => source.path === editing.configured.path) ?? sources[0];
    selectedType = typeof editing.initial.pattern === "string" || editing.initial.type === "regex"
      ? "Custom regex"
      : typeof editing.initial.realFromEnv === "string"
        ? "Literal from environment"
        : "Exact literal value";
  } else if (options.initialMode === "json") {
    selectedType = "Exact literal value";
  } else {
    const selectedTypeOption = await selectMaskingOption(ctx, "Rule type", builderTypes);
    if (!selectedTypeOption) return;
    selectedType = selectedTypeOption as BuilderType;
  }
  if (!selectedType) return;
  let selectedPreset: (typeof MASKING_PRESETS)[number] | undefined;
  if (selectedType === "Built-in preset template") {
    type PresetPick = { preset: (typeof MASKING_PRESETS)[number] } | { batch: Array<(typeof MASKING_PRESETS)[number]> };
    const pick = await ctx.ui.custom<PresetPick | undefined>((tui, theme, keybindings, done) => {
      let query = "";
      const filtered = () => {
        const q = query.trim().toLowerCase();
        const list = q
          ? MASKING_PRESETS.filter((preset) =>
              `${preset.label} ${preset.name} ${preset.description}`.toLowerCase().includes(q)
            )
          : MASKING_PRESETS;
        return [...list].sort((a, b) => a.label.localeCompare(b.label));
      };
      let selectedIndex = 0;
      const marked = new Set<string>();
      // Rows consumed by the title, filter input, blank lines, description/example, and hint lines.
      const chromeRows = 10;
      const viewportSize = () => Math.max(3, tui.terminal.rows - chromeRows);
      const clampScroll = (value: number, length: number) => Math.min(Math.max(0, value), Math.max(0, length - viewportSize()));
      let scrollTop = 0;
      const ensureVisible = (length: number) => {
        const size = viewportSize();
        if (selectedIndex < scrollTop) scrollTop = selectedIndex;
        if (selectedIndex >= scrollTop + size) scrollTop = selectedIndex - size + 1;
        scrollTop = clampScroll(scrollTop, length);
      };
      return {
        render: (width) => {
          const list = filtered();
          selectedIndex = Math.min(selectedIndex, Math.max(0, list.length - 1));
          ensureVisible(list.length);
          const selected = list[selectedIndex];
          const size = viewportSize();
          const markedCount = marked.size;
          const lines = [theme.fg("accent", theme.bold(`Choose a built-in preset (${list.length}/${MASKING_PRESETS.length})${markedCount > 0 ? ` · ${markedCount} marked` : ""}`))];
          lines.push(theme.fg(query ? "accent" : "dim", `Filter: ${query}▊`));
          lines.push("");
          for (let index = scrollTop; index < Math.min(scrollTop + size, list.length); index++) {
            const preset = list[index]!;
            const cursor = index === selectedIndex ? "▶" : " ";
            const mark = marked.has(preset.name) ? "●" : " ";
            const row = `${cursor}${mark} ${preset.label}`;
            lines.push(index === selectedIndex ? theme.fg("accent", row) : theme.fg("muted", row));
          }
          if (list.length === 0) lines.push(theme.fg("dim", "  no matching presets"));
          if (scrollTop > 0) lines.push(theme.fg("dim", "  ↑ more"));
          if (scrollTop + size < list.length) lines.push(theme.fg("dim", "  ↓ more"));
          lines.push("");
          if (selected) {
            lines.push(...wrappedMaskingText(theme.fg("dim", `Description: ${selected.description}`), width));
            lines.push(...wrappedMaskingText(theme.fg("dim", `Example: ${selected.example}`), width));
          }
          lines.push("");
          lines.push(...wrappedMaskingText(theme.fg("dim", "Space mark · Type to filter · ↑↓ select · PgUp/PgDn page · Enter continue · Esc cancel"), width));
          return fillMaskingScreen(lines, width, tui.terminal.rows);
        },
        invalidate: () => {},
        handleInput: (data) => {
          const size = viewportSize();
          if (keybindings.matches(data, "tui.select.up")) {
            const list = filtered();
            if (list.length > 0) selectedIndex = (selectedIndex - 1 + list.length) % list.length;
            tui.requestRender();
          } else if (keybindings.matches(data, "tui.select.down")) {
            const list = filtered();
            if (list.length > 0) selectedIndex = (selectedIndex + 1) % list.length;
            tui.requestRender();
          } else if (keybindings.matches(data, "tui.select.pageUp")) {
            const list = filtered();
            if (list.length > 0) selectedIndex = Math.max(0, selectedIndex - size);
            tui.requestRender();
          } else if (keybindings.matches(data, "tui.select.pageDown")) {
            const list = filtered();
            if (list.length > 0) selectedIndex = Math.min(list.length - 1, selectedIndex + size);
            tui.requestRender();
          } else if (data === " ") {
            const preset = filtered()[selectedIndex];
            if (preset) {
              if (marked.has(preset.name)) marked.delete(preset.name);
              else marked.add(preset.name);
            }
            tui.requestRender();
          } else if (data === "\x7f" || data === "\b") {
            query = query.slice(0, -1);
            selectedIndex = 0;
            tui.requestRender();
          } else if (data.length === 1 && data >= " " && data !== "\x7f") {
            query += data;
            selectedIndex = 0;
            tui.requestRender();
          } else if (keybindings.matches(data, "tui.select.confirm")) {
            const list = filtered();
            const batch = list.filter((preset) => marked.has(preset.name));
            if (batch.length > 1) done({ batch });
            else if (list[selectedIndex]) done({ preset: list[selectedIndex]! });
          } else if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) {
            done(undefined);
          }
        },
      };
    }, MASKING_SCREEN_OPTIONS);
    if (!pick) return;
    if ("batch" in pick) {
      const source = sources.find((source) => source.scope === "global")!;
      if (!existsSync(source.path)) {
        const initial = buildInitialConfig([]);
        try {
          await createJsonFileExclusive(source.path, {
            $schema: initial.$schema,
            version: initial.version,
            rules: [],
          });
        } catch (err) {
          if (!existsSync(source.path)) {
            ctx.ui.notify(`Failed to create config file: ${(err as Error).message}`, "error");
            return;
          }
        }
      }
      const usedIds = existingIds.get(source.path) ?? [];
      const rules: RawConfigRule[] = pick.batch.map((preset) => {
        const id = generateUniqueRuleId(preset.label, usedIds);
        usedIds.push(id);
        return {
          id,
          type: "regex",
          enabled: true,
          name: preset.label,
          description: `${preset.description} · Example: ${preset.example}`,
          pattern: preset.pattern,
          ...(preset.flags ? { flags: preset.flags } : {}),
          ...(preset.preserveStructure ? { preserveStructure: { ...preset.preserveStructure } } : {}),
        };
      });
      const mutations = rules.map((rule) => ({ kind: "append" as const, path: source.path, rule }));
      const preview = await previewConfigRuleMutations(mutations);
      const candidate = await bridge.candidateConfigFromSources(ctx, preview.sources);
      const outcome = await bridge.confirmConfigSave(ctx, candidate.config);
      if (!outcome.saved) return;
      const saved = await saveConfigRuleMutations(mutations);
      bridge.notifyWarnings(ctx, saved.warnings);
      await bridge.reloadConfigNow(ctx);
      ctx.ui.notify(`Added ${rules.length} preset rules to ${source.scope} config`, "info");
      return;
    }
    selectedPreset = pick.preset;
  }

  type BuiltRule = { source: typeof sources[number]; rule: RawConfigRule; createdSource: boolean; impact?: string };
  let sourceCreatedDuringBuilder = false;

    async function persistBuilderDraft(
    source: typeof sources[number],
    rule: RawConfigRule,
  ): Promise<ConfigSaveResult> {
    if (!existsSync(source.path)) {
      const initial = buildInitialConfig([]);
      try {
        await createJsonFileExclusive(source.path, {
          $schema: initial.$schema,
          version: initial.version,
          rules: [],
        });
        sourceCreatedDuringBuilder = true;
      } catch (err) {
        if (!existsSync(source.path)) throw err;
      }
    }
    const mutations = editing
      ? source.path === editing.configured.path
        ? [{ kind: "replace" as const, path: editing.configured.path, sourceIndex: editing.configured.sourceIndex, id: editing.configured.rule.id, rule }]
        : [
            { kind: "delete" as const, path: editing.configured.path, sourceIndex: editing.configured.sourceIndex, id: editing.configured.rule.id },
            { kind: "append" as const, path: source.path, rule },
          ]
      : [{ kind: "append" as const, path: source.path, rule }];
    const preview = await previewConfigRuleMutations(mutations);
    const candidate = await bridge.candidateConfigFromSources(ctx, preview.sources);
    const outcome = await bridge.confirmConfigSave(ctx, candidate.config);
    if (!outcome.saved) return { saved: false };
    const saved = await saveConfigRuleMutations(mutations);
    bridge.notifyWarnings(ctx, saved.warnings);
    await bridge.reloadConfigNow(ctx);
    return { saved: true, impact: outcome.impact };
  }

  const built = await ctx.ui.custom<BuiltRule | undefined>((tui, theme, keybindings, done) => {
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
    let saveMessage = "";
    let saveWarnings: string[] = [];
    let warningSignature = "";
    let saving = false;
    let discardConfirmation = false;
    let builderType: BuilderType = selectedType;
    let replacementIndex = editing && editing.initial.placeholder !== undefined && editing.initial.placeholder !== "auto" ? 1 : 0;
    // Disclosure preference for literal rules: off is the default; the
    // global on/off master switch pauses it anyway.
    let discloseOn = editing && editing.initial.disclosePlaceholder === true;
    let caseSensitiveOn = editing ? editing.initial.caseSensitive !== false : true;
    const discloseGlobalMode = bridge.config().options.disclosePlaceholders;
    let mode: "form" | "json" = options.initialMode ?? "form";
    let focusIndex = !editing && mode === "form" ? 2 : 0;
    let lastFormField: BuilderField = !editing && mode === "form" ? "name" : "type";
    let explicitId: string | undefined = editing && typeof editing.initial.id === "string" ? editing.initial.id : undefined;
    let advancedFields: RawConfigRule = editing ? { ...editing.initial } : {};
    let testAutoManaged = !editing && mode === "form";
    let updatingAutoTest = false;
    let testEditor: Editor | undefined;
    const makeEditor = (initial = "", singleLine = true, afterChange?: (text: string) => void) => {
      const editor = new Editor(tui, editorTheme);
      editor.setText(initial);
      let normalizing = false;
      editor.onChange = (text) => {
        if (singleLine && !normalizing) {
          const normalized = text.replace(/\s*[\r\n]+\s*/g, " ");
          if (normalized !== text) {
            normalizing = true;
            editor.setText(normalized);
            normalizing = false;
            return;
          }
        }
        saveMessage = "";
        saveWarnings = [];
        warningSignature = "";
        discardConfirmation = false;
        afterChange?.(text);
        tui.requestRender();
      };
      return editor;
    };
    const editors = {
      name: makeEditor(selectedPreset?.label ?? (typeof editing?.initial.name === "string" ? editing.initial.name : "")),
      description: makeEditor(selectedPreset ? `${selectedPreset.description} · Example: ${selectedPreset.example}` : (typeof editing?.initial.description === "string" ? editing.initial.description : "")),
      pattern: makeEditor(selectedPreset?.pattern ?? (typeof editing?.initial.pattern === "string" ? editing.initial.pattern : "")),
      flags: makeEditor(selectedPreset?.flags ?? (typeof editing?.initial.flags === "string" ? editing.initial.flags : "")),
      env: makeEditor(typeof editing?.initial.realFromEnv === "string" ? editing.initial.realFromEnv : ""),
      real: makeEditor(typeof editing?.initial.real === "string" ? editing.initial.real : "", true, (text) => {
        if (testAutoManaged && builderType === "Exact literal value" && testEditor) {
          updatingAutoTest = true;
          testEditor.setText(text);
          updatingAutoTest = false;
        }
      }),
      placeholder: makeEditor(typeof editing?.initial.placeholder === "string" && editing.initial.placeholder !== "auto" ? editing.initial.placeholder : ""),
      json: makeEditor("", false),
      test: makeEditor("", false, () => {
        if (!updatingAutoTest) testAutoManaged = false;
      }),
    };
    testEditor = editors.test;

    const setAutoTestText = (text: string) => {
      if (!testAutoManaged) return;
      updatingAutoTest = true;
      editors.test.setText(text);
      updatingAutoTest = false;
    };

    const currentSource = () => selectedSource;
    const currentType = () => builderType;
    const editableTypes: readonly BuilderType[] = ["Exact literal value", "Literal from environment", "Custom regex"];
    const typeLabel = (type = currentType()) => type === "Exact literal value"
      ? "exact"
      : type === "Literal from environment"
        ? "env"
        : "regex";
    const changeType = (delta: -1 | 1) => {
      const normalizedType: BuilderType = currentType() === "Built-in preset template" ? "Custom regex" : currentType();
      const currentIndex = editableTypes.indexOf(normalizedType);
      builderType = editableTypes[(currentIndex + delta + editableTypes.length) % editableTypes.length]!;
      setAutoTestText(builderType === "Exact literal value" ? editors.real.getExpandedText() : "");
      saveMessage = "";
      saveWarnings = [];
      warningSignature = "";
      focusFormField("type");
    };
    const changeSource = (delta: -1 | 1) => {
      const currentIndex = Math.max(0, sources.findIndex((source) => source.path === currentSource().path));
      selectedSource = sources[(currentIndex + delta + sources.length) % sources.length]!;
      saveMessage = "";
      saveWarnings = [];
      warningSignature = "";
      focusFormField("scope");
    };
    const generatedId = (): string | undefined => {
      if (explicitId) return explicitId;
      const name = editors.name.getExpandedText().trim();
      return name ? generateUniqueRuleId(name, existingIds.get(currentSource().path) ?? []) : undefined;
    };

    function formFields(): BuilderField[] {
      const common: BuilderField[] = [];
      common.push("type", "scope", "name", "description");
      // Case sensitivity is a literal-rule field: regex rules control it
      // through their own flags.
      if (currentType() === "Built-in preset template" || currentType() === "Custom regex") common.push("pattern", "flags");
      else if (currentType() === "Literal from environment") {
        common.push("env", "replacement");
        if (replacementIndex === 1) common.push("placeholder");
        common.push("disclose", "case");
      }
      else {
        common.push("real", "replacement");
        if (replacementIndex === 1) common.push("placeholder");
        common.push("disclose", "case");
      }
      common.push("test");
      return common;
    }
    const fields = () => mode === "json" ? ["json", "test"] as BuilderField[] : formFields();
    const focusedField = () => fields()[Math.max(0, Math.min(focusIndex, fields().length - 1))]!;
    const editorForField = (field: BuilderField): Editor | undefined => field in editors
      ? editors[field as keyof typeof editors]
      : undefined;

    const structuredFields = (): BuilderField[] => formFields().filter((field) => field !== "test");

    function focusFormField(field: BuilderField): void {
      const available = structuredFields();
      const resolved = available.includes(field) ? field : available[0]!;
      lastFormField = resolved;
      focusIndex = formFields().indexOf(resolved);
      tui.requestRender();
    }

    function moveFormField(delta: -1 | 1): void {
      const available = structuredFields();
      const current = Math.max(0, available.indexOf(focusedField()));
      const next = Math.max(0, Math.min(available.length - 1, current + delta));
      focusFormField(available[next]!);
    }

    function switchInputArea(): void {
      if (mode === "json") {
        focusIndex = focusedField() === "test" ? 0 : 1;
      } else if (focusedField() === "test") {
        focusFormField(lastFormField);
        return;
      } else {
        lastFormField = focusedField();
        focusIndex = formFields().indexOf("test");
      }
      tui.requestRender();
    }

    function draftFromForm(): RawConfigRule {
      const name = editors.name.getExpandedText().trim();
      const description = editors.description.getExpandedText().trim();
      const base: RawConfigRule = {
        ...advancedFields,
        enabled: typeof advancedFields.enabled === "boolean" ? advancedFields.enabled : true,
      };
      const id = generatedId();
      if (id) base.id = id;
      else delete base.id;
      if (name) base.name = name;
      else delete base.name;
      if (description) base.description = description;
      else delete base.description;
      if (currentType() === "Built-in preset template" || currentType() === "Custom regex") {
        const preset = currentType() === "Built-in preset template" ? selectedPreset : undefined;
        const flags = editors.flags.getExpandedText().trim();
        const regexRule: RawConfigRule = {
          ...base,
          type: "regex",
          pattern: editors.pattern.getExpandedText(),
          ...(flags ? { flags } : {}),
          ...(base.preserveStructure === undefined && preset?.preserveStructure
            ? { preserveStructure: { ...preset.preserveStructure } }
            : {}),
        };
        if (!flags) delete regexRule.flags;
        delete regexRule.caseSensitive;
        delete regexRule.real;
        delete regexRule.realFromEnv;
        delete regexRule.placeholder;
        delete regexRule.preset;
        delete regexRule.disclosePlaceholder;
        return regexRule;
      }
      if (currentType() === "Literal from environment") {
        const envRule: RawConfigRule = {
          ...base,
          realFromEnv: editors.env.getExpandedText().trim(),
          placeholder: replacementIndex === 0 ? "auto" : editors.placeholder.getExpandedText(),
        };
        delete envRule.type;
        delete envRule.disclosePlaceholder;
        if (discloseOn) envRule.disclosePlaceholder = true;
        if (!caseSensitiveOn) envRule.caseSensitive = false;
        else delete envRule.caseSensitive;
        delete envRule.pattern;
        delete envRule.pattern;
        delete envRule.flags;
        delete envRule.real;
        delete envRule.preset;
        return envRule;
      }
      const literalRule: RawConfigRule = {
        ...base,
        real: editors.real.getExpandedText(),
        placeholder: replacementIndex === 0 ? "auto" : editors.placeholder.getExpandedText(),
      };
      delete literalRule.disclosePlaceholder;
      if (discloseOn) literalRule.disclosePlaceholder = true;
      if (!caseSensitiveOn) literalRule.caseSensitive = false;
      else delete literalRule.caseSensitive;
      delete literalRule.pattern;
      delete literalRule.flags;
      delete literalRule.realFromEnv;
      delete literalRule.preset;
      if (literalRule.type !== "literal") delete literalRule.type;
      return literalRule;
    }

    function currentDraft(): { rule?: RawConfigRule; text: string; error?: string } {
      if (mode === "form") {
        const rule = draftFromForm();
        return { rule, text: JSON.stringify(rule, null, 2) };
      }
      const text = editors.json.getExpandedText();
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Rule must be a JSON object");
        return { rule: parsed as RawConfigRule, text };
      } catch (err) {
        return { text, error: (err as Error).message };
      }
    }

    if (mode === "json") {
      editors.json.setText(JSON.stringify(editing?.initial ?? draftFromForm(), null, 2));
    }

    const draftSignature = (): string => {
      const draft = currentDraft();
      return `${currentSource().path}\n${draft.rule ? JSON.stringify(draft.rule) : draft.text}`;
    };
    const initialDraftSignature = draftSignature();

    function importJsonToForm(): boolean {
      const draft = currentDraft();
      if (!draft.rule) {
        saveMessage = `Cannot switch to form: ${draft.error}`;
        return false;
      }
      const rule = draft.rule;
      const isRegex = rule.type === "regex" || typeof rule.pattern === "string";
      const hasEnv = typeof rule.realFromEnv === "string";
      const hasReal = typeof rule.real === "string";
      if (isRegex && (hasEnv || hasReal)) {
        saveMessage = "Cannot switch to form: regex JSON cannot also contain real or realFromEnv";
        return false;
      }
      if (!isRegex && hasEnv === hasReal) {
        saveMessage = "Cannot switch to form: literal JSON must contain exactly one of real or realFromEnv";
        return false;
      }
      builderType = isRegex ? "Custom regex" : hasEnv ? "Literal from environment" : "Exact literal value";
      advancedFields = { ...rule };
      discloseOn = rule.disclosePlaceholder === true;
      caseSensitiveOn = rule.caseSensitive !== false;
      explicitId = typeof rule.id === "string" ? rule.id : undefined;
      editors.name.setText(typeof rule.name === "string" ? rule.name : "");
      editors.description.setText(typeof rule.description === "string" ? rule.description : "");
      if (currentType() === "Custom regex") {
        editors.pattern.setText(typeof rule.pattern === "string" ? rule.pattern : "");
        editors.flags.setText(typeof rule.flags === "string" ? rule.flags : "");
      } else if (currentType() === "Literal from environment") {
        if (typeof rule.realFromEnv !== "string") {
          saveMessage = "Cannot switch to form: JSON must contain realFromEnv";
          return false;
        }
        editors.env.setText(rule.realFromEnv);
        const placeholder = typeof rule.placeholder === "string" ? rule.placeholder : "auto";
        replacementIndex = placeholder === "auto" ? 0 : 1;
        if (placeholder !== "auto") editors.placeholder.setText(placeholder);
      } else {
        if (typeof rule.real !== "string") {
          saveMessage = "Cannot switch to form: JSON must contain an exact real value";
          return false;
        }
        editors.real.setText(typeof rule.real === "string" ? rule.real : "");
        const placeholder = typeof rule.placeholder === "string" ? rule.placeholder : "auto";
        replacementIndex = placeholder === "auto" ? 0 : 1;
        if (placeholder !== "auto") editors.placeholder.setText(placeholder);
      }
      saveMessage = "";
      return true;
    }

    function padCell(value: string, width: number): string {
      const rendered = truncateToWidth(value, Math.max(1, width));
      return rendered + " ".repeat(Math.max(0, width - visibleWidth(rendered)));
    }

    function valueWithCursor(editor: Editor, width: number): string {
      const text = editor.getExpandedText().replace(/[\r\n]+/g, " ");
      const cursor = Math.max(0, Math.min(editor.getCursor().col, text.length));
      const marked = `${text.slice(0, cursor)}▌${text.slice(cursor)}`;
      const cursorColumn = visibleWidth(text.slice(0, cursor));
      const startColumn = Math.max(0, cursorColumn - Math.max(1, width - 3));
      const prefix = startColumn > 0 ? "…" : "";
      return prefix + sliceByColumn(marked, startColumn, Math.max(1, width - visibleWidth(prefix)));
    }

    type RenderedFieldDetail = {
      label: string;
      value: string;
      description: string;
      cursorEditor?: Editor;
      selector?: boolean;
      dim?: boolean;
    };
    const renderedFieldDetails = new Map<BuilderField, RenderedFieldDetail>();

    function renderFieldRow(
      lines: string[],
      field: BuilderField | undefined,
      label: string,
      value: string,
      width: number,
      description: string,
      options: { cursorEditor?: Editor; selector?: boolean; selectorPrefix?: string; selectorSuffix?: string; dim?: boolean } = {},
    ): void {
      const focused = field !== undefined && focusedField() === field;
      const marker = focused ? "▶" : " ";
      const labelWidth = 14;
      const rawValue = options.selector
        ? (options.selectorPrefix !== undefined ? `${options.selectorPrefix} ‹ ${value} ›` : `‹ ${value} ›`) + (options.selectorSuffix !== undefined ? ` ${options.selectorSuffix}` : "")
        : value || "—";
      const valueWidth = Math.max(1, width - (2 + labelWidth + 2));
      const displayedValue = focused && options.cursorEditor
        ? valueWithCursor(options.cursorEditor, valueWidth)
        : truncateToWidth(rawValue, valueWidth);
      const summary = `${marker} ${padCell(label, labelWidth)}  ${displayedValue}`;
      const rendered = truncateToWidth(summary, Math.max(1, width));
      const editorAreaFocused = focusedField() !== "test";
      lines.push(focused
        ? theme.fg("accent", rendered)
        : options.dim || !editorAreaFocused
          ? theme.fg("dim", rendered)
          : rendered);
      if (field !== undefined) {
        renderedFieldDetails.set(field, { label, value, description, ...options });
      }
    }

    function renderActiveFieldDescription(lines: string[], width: number): void {
      const detail = renderedFieldDetails.get(focusedField() === "test" ? lastFormField : focusedField());
      if (!detail) return;
      const description = focusedField() === "test" ? theme.fg("dim", detail.description) : detail.description;
      lines.push(...wrappedMaskingText(description, width));
    }

    function renderSelector(lines: string[], field: BuilderField, label: string, value: string, width: number, description: string, selectorSuffix?: string): void {
      renderFieldRow(lines, field, label, value, width, description, { selector: true, selectorSuffix });
    }

    function renderSingleLineField(lines: string[], field: BuilderField, label: string, editor: Editor, width: number, description: string): void {
      const focused = focusedField() === field;
      editor.focused = focused;
      renderFieldRow(lines, field, label, editor.getExpandedText(), width, description, { cursorEditor: editor });
    }

    function renderMultilineEditor(lines: string[], field: BuilderField, editor: Editor, width: number): void {
      const focused = focusedField() === field;
      editor.focused = focused;
      editor.borderColor = (text) => theme.fg(focused ? "accent" : "dim", text);
      lines.push(...editor.render(width));
    }

    function cleanBuilderIssue(issue: string): string {
      let cleaned = issue.trim().replace(/^Rule \[[^\]]*\]\s*/, "");
      if (cleaned === "A rule entry is missing a non-empty 'id' and was skipped") {
        return "Enter a rule name or a non-empty JSON id";
      }
      cleaned = cleaned
        .replace(/^has an invalid regex and was skipped:\s*/, "Regex is invalid: ")
        .replace(/^is type "regex" but has no pattern; skipped$/, "Enter a regex pattern")
        .replace(/^is literal but has no 'real' value or valid 'realFromEnv'; skipped$/, "Enter an exact value or a valid environment variable name")
        .replace(/^has placeholder equal to its real value; the rule has no effect$/, "Placeholder must differ from the exact value")
        .replace(/\s+and was skipped(?=[:;.]|$)/g, "")
        .replace(/;\s*skipped(?=[:;.]|$)/g, "");
      return cleaned ? cleaned[0]!.toUpperCase() + cleaned.slice(1) : "Rule is invalid";
    }

    function cleanBuilderIssues(message: string): string[] {
      return message.split(/;\s+(?=Rule \[|A rule entry)/).map(cleanBuilderIssue);
    }

    function builderPreview(draft: { rule?: RawConfigRule; text: string; error?: string }): LocalMaskingPreview {
      const input = editors.test.getExpandedText();
      if (mode === "form") {
        if (currentType() === "Exact literal value" && !editors.real.getExpandedText()) {
          return { text: input, count: 0, attribution: "Enter an exact value to preview", warnings: [] };
        }
        if (currentType() === "Literal from environment" && !editors.env.getExpandedText().trim()) {
          return { text: input, count: 0, attribution: "Enter an environment variable name to preview", warnings: [] };
        }
        if ((currentType() === "Built-in preset template" || currentType() === "Custom regex") && !editors.pattern.getExpandedText()) {
          return { text: input, count: 0, attribution: "Enter a regex pattern to preview", warnings: [] };
        }
      }
      return previewCandidateRule(bridge, input, draft.text);
    }

    async function attemptSave(): Promise<void> {
      saveWarnings = [];
      const draft = currentDraft();
      if (!draft.rule) {
        saveMessage = `Cannot save: ${draft.error}`;
        tui.requestRender();
        return;
      }
      if (mode === "form" && !editing && !editors.name.getExpandedText().trim()) {
        saveMessage = "Cannot save: enter a rule name";
        focusFormField("name");
        return;
      }
      if (mode === "form" && currentType() === "Exact literal value" && !editors.real.getExpandedText()) {
        saveMessage = "Cannot save: enter an exact value";
        focusFormField("real");
        return;
      }
      if (mode === "form" && currentType() === "Literal from environment" && !editors.env.getExpandedText().trim()) {
        saveMessage = "Cannot save: enter an environment variable name, for example PROD_API_KEY";
        focusFormField("env");
        return;
      }
      if (mode === "form" && (currentType() === "Built-in preset template" || currentType() === "Custom regex")
        && !editors.pattern.getExpandedText()) {
        saveMessage = "Cannot save: enter a regex pattern";
        focusFormField("pattern");
        return;
      }
      if (mode === "form" && (currentType() === "Literal from environment" || currentType() === "Exact literal value")
        && replacementIndex === 1 && !editors.placeholder.getExpandedText()) {
        saveMessage = "Cannot save: enter a custom placeholder or choose Generate automatically";
        focusFormField("placeholder");
        return;
      }
      if (typeof draft.rule.id !== "string" || !draft.rule.id.trim()) {
        const name = typeof draft.rule.name === "string" ? draft.rule.name.trim() : "";
        if (!name) {
          saveMessage = `Cannot save: ${mode === "json" ? "enter a non-empty id or name in the JSON" : "enter a rule name"}`;
          if (mode === "form") focusFormField("name");
          else tui.requestRender();
          return;
        }
        draft.rule.id = generateUniqueRuleId(name, existingIds.get(currentSource().path) ?? []);
      }
      let warnings: string[];
      try {
        warnings = validateRawConfigRule(draft.rule);
      } catch (err) {
        const issues = cleanBuilderIssues((err as Error).message);
        saveMessage = `Cannot save: ${issues[0] ?? "rule is invalid"}`;
        saveWarnings = issues.slice(1);
        tui.requestRender();
        return;
      }
      const id = typeof draft.rule.id === "string" ? draft.rule.id : "";
      const isOriginalEntry = editing
        && currentSource().path === editing.configured.path
        && id === editing.configured.rule.id;
      if ((existingIds.get(currentSource().path) ?? []).includes(id) && !isOriginalEntry) {
        saveMessage = `Cannot save: ID ${JSON.stringify(id)} already exists in ${currentSource().scope}`;
        tui.requestRender();
        return;
      }
      const signature = warnings.join("\n");
      if (warnings.length > 0 && warningSignature !== signature) {
        warningSignature = signature;
        saveWarnings = warnings.map(cleanBuilderIssue);
        saveMessage = "Warnings are shown below · press Enter again to save anyway";
        tui.requestRender();
        return;
      }
      saving = true;
      saveMessage = "Saving…";
      tui.requestRender();
      try {
        const persisted = await persistBuilderDraft(currentSource(), draft.rule);
        if (!persisted.saved) {
          saving = false;
          saveMessage = "Save cancelled · draft retained";
          tui.requestRender();
          return;
        }
        done({ source: currentSource(), rule: draft.rule, createdSource: sourceCreatedDuringBuilder, impact: persisted.impact });
      } catch (err) {
        saving = false;
        saveMessage = `Cannot save: ${(err as Error).message} · draft retained`;
        tui.requestRender();
      }
    }

    return {
      render: (width) => {
        const draft = currentDraft();
        renderedFieldDetails.clear();
        // Disclose selector layout depends only on the global mode (constant
        // while editing), so toggling the stored value never reshuffles the
        // row — only the word inside the brackets changes.
        const storedLabel = `${discloseOn ? "ON" : "OFF"} (stored)`;
        const overridden = discloseGlobalMode === true || discloseGlobalMode === false;
        const discloseValue = overridden ? storedLabel : storedLabel.replace(/ \(stored\)$/, "");
        const discloseSuffixText = overridden
          ? theme.fg("warning", `not in effect — global ${discloseGlobalMode ? "ON" : "OFF"}`)
          : undefined;
        const discloseDescription = overridden
          ? "stored value is overridden by the global setting — ←/→ or Space changes what is stored here, not what happens"
          : "no global override — this rule setting applies";
        const editorFocused = focusedField() !== "test";
        const editorDivider = theme.fg(editorFocused ? "accent" : "dim", "─".repeat(Math.max(1, width)));
        const editorTitle = mode === "form" ? "RULE FIELDS" : "RULE JSON";
        const lines: string[] = [
          theme.fg("accent", theme.bold(`${editing ? "Edit" : "New"} masking rule · Rule Builder`)),
          ...wrappedMaskingText(theme.fg("muted", `${currentSource().scope} · ${typeLabel()}${currentType() === "Built-in preset template" && selectedPreset ? ` · ${selectedPreset.label}` : ""} · ${mode === "form" ? "Structured fields" : "Advanced JSON"}`), width),
          ...wrappedMaskingText(theme.fg("dim", currentSource().path), width),
          "",
          editorFocused
            ? theme.fg("accent", theme.bold(`${editorTitle} · focused`))
            : theme.fg("muted", `${editorTitle} · Tab to focus`),
        ];
        if (mode === "form") {
          lines.push(editorDivider);
          const fieldRowsStart = lines.length;
          renderSelector(lines, "type", "Rule type", typeLabel(), width, "←/→ or Space switches between exact, environment, and regular-expression rules");
          renderSelector(lines, "scope", "Scope", currentSource().scope, width, "←/→ or Space moves the rule between project and global configuration");
          renderSingleLineField(lines, "name", "Name", editors.name, width, "Human-readable label for this rule");
          const displayedId = generatedId();
          renderFieldRow(lines, undefined, "Generated ID", displayedId ?? "Enter a name to generate", width, "Generated from Name · existing IDs are preserved while editing", { dim: !displayedId });
          renderSingleLineField(lines, "description", "Description", editors.description, width, "Optional longer explanation");
          if (currentType() === "Built-in preset template" || currentType() === "Custom regex") {
            renderSingleLineField(lines, "pattern", "Pattern", editors.pattern, width, "JavaScript regex without /.../ · e.g. \\btoken_[A-Za-z0-9]{24}\\b");
            renderSingleLineField(lines, "flags", "Flags", editors.flags, width, "Optional: i case-insensitive · m multiline anchors · s dot matches newline · g automatic");
          } else if (currentType() === "Literal from environment") {
            renderSingleLineField(lines, "env", "Environment", editors.env, width, "Variable name only, for example PROD_API_KEY (do not enter $ or the secret value)");
            renderSelector(lines, "replacement", "Replacement", replacementIndex === 0 ? "Generate automatically" : "Exact custom replacement", width, "←/→ or Space changes the replacement mode");
            if (replacementIndex === 1) renderSingleLineField(lines, "placeholder", "Placeholder", editors.placeholder, width, "Exact replacement shown to the model");
            renderSelector(lines, "disclose", "Disclose", discloseValue, width, discloseDescription, discloseSuffixText);
            renderSelector(lines, "case", "Case", caseSensitiveOn ? "Sensitive" : "Insensitive", width,
              "←/→ or Space toggles case-sensitive matching for this rule");
          } else {
            renderSingleLineField(lines, "real", "Exact value", editors.real, width, "Exact text to mask");
            renderSelector(lines, "replacement", "Replacement", replacementIndex === 0 ? "Generate automatically" : "Exact custom replacement", width, "←/→ or Space changes the replacement mode");
            if (replacementIndex === 1) renderSingleLineField(lines, "placeholder", "Placeholder", editors.placeholder, width, "Exact replacement shown to the model");
            renderSelector(lines, "disclose", "Disclose", discloseValue, width, discloseDescription, discloseSuffixText);
            renderSelector(lines, "case", "Case", caseSensitiveOn ? "Sensitive" : "Insensitive", width,
              "←/→ or Space toggles case-sensitive matching for this rule");
          }
          const fixedFieldRowCount = 8;
          while (lines.length - fieldRowsStart < fixedFieldRowCount) lines.push("");
          lines.push(editorDivider);
          renderActiveFieldDescription(lines, width);
        } else {
          lines.push(editorFocused
            ? "Edit the complete rule object as multiline JSON"
            : theme.fg("dim", "Edit the complete rule object as multiline JSON"));
          renderMultilineEditor(lines, "json", editors.json, width);
        }
        lines.push("");
        lines.push(focusedField() === "test"
          ? theme.fg("accent", theme.bold("TEST THIS RULE · focused"))
          : theme.fg("muted", "TEST THIS RULE · Tab to focus"));
        renderMultilineEditor(lines, "test", editors.test, width);
        const preview = builderPreview(draft);
        const status = preview.count > 0 ? `${preview.count} value(s) masked` : preview.attribution;
        lines.push(theme.fg(preview.count > 0 ? "accent" : "muted", `Preview: ${status}`));
        for (const line of preview.text.split("\n").slice(0, 2)) if (line) lines.push(line);
        if (preview.count > 0) lines.push(theme.fg("muted", `Matched: ${preview.attribution}`));
        if (saveMessage) {
          lines.push(...wrappedMaskingText(theme.fg(saveMessage.startsWith("Cannot") ? "warning" : "accent", saveMessage), width));
        }
        for (const warning of saveWarnings.slice(0, 3)) {
          lines.push(...wrappedMaskingText(theme.fg("warning", `Warning: ${warning}`), width));
        }
        lines.push("");
        // Keyboard hints and any pending confirmation sit at the very
        // bottom of the terminal window, not directly under the content.
        const hintLines = wrappedMaskingText(theme.fg("dim", "↑↓ fields · Tab form/test · ←→ or Space change selection · F2 form/JSON · Enter save · Esc cancel"), width);
        const bottomPad = Math.max(1, tui.terminal.rows - lines.length - hintLines.length);
        lines.push(...Array(bottomPad).fill(""));
        lines.push(...hintLines);
        return fillMaskingScreen(lines, width, tui.terminal.rows);
      },
      invalidate: () => Object.values(editors).forEach((editor) => editor.invalidate()),
      handleInput: (data) => {
        if (saving) return;
        if (discardConfirmation) {
          if (matchesKey(data, "y") || keybindings.matches(data, "tui.select.confirm")) {
            done(undefined);
          } else if (
            matchesKey(data, "n")
            || keybindings.matches(data, "tui.select.cancel")
            || keybindings.matches(data, "app.interrupt")
          ) {
            discardConfirmation = false;
            saveMessage = "Editing resumed";
            tui.requestRender();
          }
          return;
        }
        if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) {
          if (draftSignature() === initialDraftSignature) done(undefined);
          else {
            discardConfirmation = true;
            saveMessage = "Discard unsaved changes? Y / Enter discard · N / Esc continue editing";
            tui.requestRender();
          }
          return;
        }
        if (matchesKey(data, Key.f2)) {
          testAutoManaged = false;
          if (mode === "form") {
            editors.json.setText(JSON.stringify(draftFromForm(), null, 2));
            mode = "json";
            focusIndex = 0;
          } else if (importJsonToForm()) {
            mode = "form";
            focusIndex = 0;
          }
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
          switchInputArea();
          return;
        }

        const field = focusedField();
        if (matchesKey(data, Key.enter)) {
          if (field === "test") {
            // Editor.submitValue() clears its contents before onSubmit. The
            // embedded test area is multiline, so Enter must be handled as a
            // newline instead of submitting (and clearing) the editor.
            editors.test.handleInput("\n");
          } else {
            // Save before forwarding Enter to Editor: Editor clears its
            // contents before invoking onSubmit, which would make the form
            // draft observe an empty current field.
            void attemptSave();
          }
          return;
        }
        if (mode === "form" && field !== "test" && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
          moveFormField(matchesKey(data, Key.up) ? -1 : 1);
          return;
        }
        const selectorDirection = matchesKey(data, Key.left) ? -1
          : matchesKey(data, Key.right) || matchesKey(data, Key.space) ? 1
          : 0;
        if (selectorDirection !== 0) {
          if (field === "type") {
            changeType(selectorDirection < 0 ? -1 : 1);
          } else if (field === "scope") {
            changeSource(selectorDirection < 0 ? -1 : 1);
          } else if (field === "replacement") {
            replacementIndex = replacementIndex === 0 ? 1 : 0;
            focusIndex = Math.min(focusIndex, fields().length - 1);
          } else if (field === "disclose") {
            discloseOn = !discloseOn;
          } else if (field === "case") {
            caseSensitiveOn = !caseSensitiveOn;
          } else {
            editorForField(field)?.handleInput(data);
            return;
          }
          saveMessage = "";
          saveWarnings = [];
          warningSignature = "";
          tui.requestRender();
          return;
        }
        editorForField(field)?.handleInput(data);
      },
    };
  }, MASKING_SCREEN_OPTIONS);

  if (!built) return undefined;
  const id = String(built.rule.id);
  const action = editing && built.source.path !== editing.configured.path ? "Moved and updated" : editing ? "Updated" : "Added";
  ctx.ui.notify(`${action} rule [${id}] in ${built.source.scope} config`, "info");
  if (built.createdSource) {
    ctx.ui.notify(
      `Created minimal ${built.source.scope} config: ${built.source.path}${built.source.scope === "project" ? " · this file may be tracked by Git" : ""}`,
      built.source.scope === "project" ? "warning" : "info",
    );
    if (built.source.scope === "project") {
      const addIgnore = await confirmMaskingAction(
        ctx,
        "Exclude project masking config from Git?",
        `Add .pi/pi-data-masking/masking.config.json to ${ctx.cwd}/.gitignore?\n\nChoose Yes if this config may contain exact literal values.`,
      );
      if (addIgnore) {
        try {
          const added = await ensureProjectConfigGitignored(ctx.cwd);
          ctx.ui.notify(
            added ? "Added project masking config to .gitignore" : "Project masking config is already ignored",
            "info",
          );
        } catch (err) {
          ctx.ui.notify(`Failed to update .gitignore: ${(err as Error).message}`, "error");
        }
      }
    }
  }
  return built.impact;
}

export async function editConfigRule(
  bridge: MaskingUIBridge,
  ctx: ExtensionContext,
  configured: ConfiguredMaskingRule,
  initialMode: "form" | "json" = "form",
): Promise<string | undefined> {
  try {
    const data = await readRawConfigFile(configured.path);
    const original = data.rules[configured.sourceIndex];
    if (!original || typeof original !== "object" || original.id !== configured.rule.id) {
      throw new Error("source position changed; reopen /masking");
    }
    const initial = configured.sourceKind === "preset" ? { ...configured.rule } : { ...original };
    return await addConfigRule(bridge, ctx, { configured, original, initial }, { initialMode });
  } catch (err) {
    ctx.ui.notify(`Failed to edit rule: ${(err as Error).message}`, "error");
    return undefined;
  }
}

export async function deleteConfigRule(bridge: MaskingUIBridge, ctx: ExtensionContext, configured: ConfiguredMaskingRule): Promise<void> {
  if (await saveStructuralChanges(bridge, ctx, [{
    kind: "delete",
    path: configured.path,
    sourceIndex: configured.sourceIndex,
    id: configured.rule.id,
  }], {
    title: "Delete masking rule?",
    force: true,
    warning: `Delete "${configuredRuleDisplayName(configured)}" [${configured.rule.id}] from the ${configured.scope} config?\nThis may expose matching values in future requests and cannot retract earlier model context.`,
  })) ctx.ui.notify(`Deleted rule "${configuredRuleDisplayName(configured)}" [${configured.rule.id}]`, "info");
}

export async function showRuleConfigurationHelp(ctx: ExtensionContext): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => ({
    render: (width) => {
      const lines = [theme.fg("accent", theme.bold("How to configure masking rules")), ""];
      const section = (title: string, ...paragraphs: string[]) => {
        lines.push(theme.fg("accent", title));
        for (const paragraph of paragraphs) lines.push(...wrappedMaskingText(paragraph, width));
        lines.push("");
      };
      section("Literal from environment",
        "Use an environment-variable name; its value is resolved in memory and is not stored in JSON.");
      section("Exact literal value",
        "Match one exact string. Choose an automatic or custom replacement. Explicit editing shows the stored value.");
      section("Built-in preset",
        "Choose a documented template. The complete regex is written to the config so it can be customized.");
      section("Custom regex",
        "Write JavaScript regex source without surrounding /.../.",
        "Example: \\bnpm_[A-Za-z0-9]{36}\\b matches npm_ followed by exactly 36 ASCII letters/digits.",
        "\\b is a word boundary; [A-Za-z0-9] is one allowed character; {36} repeats it exactly 36 times.",
        "Optional flags include i (case-insensitive), m (multiline), and s (dot matches newline); g is automatic.",
        "Without capture groups the whole match is masked; with groups, only captured portions are masked.");
      section("Keyboard shortcuts",
        "↑/↓ select · PgUp/PgDn page · Home/End first/add · Enter edit/add · F2 JSON · Space rule on/off · M global masking on/off",
        "Case field: per-rule case-sensitive matching; regex rules with explicit flags keep their own flags.",
        "R show/hide exact values · F filter · / search · Ctrl+↑/↓ reorder · A add · D/Delete remove",
        "Tab test area · B batch · I import · X export · H/Enter/Esc close help");
      lines.push(...wrappedMaskingText(theme.fg("muted", "Rules run from top to bottom. Prefer narrow patterns and use the embedded test area before relying on them."), width));
      lines.push("");
      lines.push(...wrappedMaskingText(theme.fg("dim", "Enter / Esc / H close help"), width));
      return fillMaskingScreen(lines, width, tui.terminal.rows);
    },
    invalidate: () => {},
    handleInput: (data) => {
      if (
        keybindings.matches(data, "tui.select.confirm")
        || keybindings.matches(data, "tui.select.cancel")
        || keybindings.matches(data, "app.interrupt")
        || matchesKey(data, "h")
      ) done();
    },
  }), MASKING_SCREEN_OPTIONS);
}

export async function moveConfigRule(
  bridge: MaskingUIBridge,
  ctx: ExtensionContext,
  configured: ConfiguredMaskingRule,
  direction: -1 | 1,
  notifySuccess = true,
): Promise<boolean> {
  const sameSource = bridge.config().configuredRules
    .filter((candidate) => candidate.path === configured.path)
    .sort((a, b) => a.sourceIndex - b.sourceIndex);
  const index = sameSource.findIndex((candidate) => configuredRuleStableKey(candidate) === configuredRuleStableKey(configured));
  const target = sameSource[index + direction];
  if (!target) {
    ctx.ui.notify(`Rule is already at the ${direction < 0 ? "top" : "bottom"} of its ${configured.scope} scope`, "info");
    return false;
  }
  const saved = await saveStructuralChanges(bridge, ctx, [{
    kind: "move",
    path: configured.path,
    sourceIndex: configured.sourceIndex,
    id: configured.rule.id,
    targetIndex: target.sourceIndex,
    targetId: target.rule.id,
  }]);
  if (saved && notifySuccess) ctx.ui.notify(`Moved rule "${configuredRuleDisplayName(configured)}" [${configured.rule.id}] ${direction < 0 ? "up" : "down"}`, "info");
  return saved;
}

export async function toggleConfigRule(
  bridge: MaskingUIBridge,
  ctx: ExtensionContext,
  configured: ConfiguredMaskingRule,
  notifySuccess = true,
  ask?: (title: string, message: string) => Promise<boolean>,
): Promise<ConfigSaveResult> {
  const enabled = !configured.enabled;
  try {
    const outcome = await saveRuleStateChanges(bridge, ctx, [{
      path: configured.path,
      sourceIndex: configured.sourceIndex,
      id: configured.rule.id,
      enabled,
    }], {}, ask);
    if (!outcome.saved) return { saved: false };
    const state = enabled && !configured.available
      ? `enabled in config but waiting for environment variable ${configured.realFromEnv}`
      : enabled ? "enabled immediately" : "disabled immediately";
    if (notifySuccess) {
      ctx.ui.notify(
        `Rule "${configuredRuleDisplayName(configured)}" [${configured.rule.id}] ${state}. ${enabled ? "Changes affect future requests only" : "Matching values may be exposed in future requests"}; earlier context cannot be retracted. Consider a new session for a clean boundary.`,
        enabled ? "info" : "warning",
      );
    }
    return { saved: true, impact: outcome.impact };
  } catch (err) {
    ctx.ui.notify(`Failed to toggle rule: ${(err as Error).message}`, "error");
    return { saved: false };
  }
}

export async function applyBatchRuleState(bridge: MaskingUIBridge, ctx: ExtensionContext, changes: RuleEnabledChange[], ask?: (title: string, message: string) => Promise<boolean>): Promise<ConfigSaveResult> {
  if (changes.length === 0) return { saved: false };
  const disabling = changes.filter((change) => !change.enabled).length;
  try {
    const outcome = await saveRuleStateChanges(bridge, ctx, changes, {
      title: "Apply batch rule changes?",
      force: true,
      warning: `${changes.length - disabling} rule(s) will be enabled and ${disabling} disabled.\nDisabled rules may expose matching values in future requests. Earlier context cannot be retracted.`,
    }, ask);
    if (!outcome.saved) return { saved: false };
    ctx.ui.notify(`Applied ${changes.length} rule state change(s) immediately`, "info");
    return { saved: true, impact: outcome.impact };
  } catch (err) {
    ctx.ui.notify(`Failed to update rules: ${(err as Error).message}`, "error");
    return { saved: false };
  }
}

export async function importConfigRules(bridge: MaskingUIBridge, ctx: ExtensionContext): Promise<void> {
  const sourceInput = (await inputMaskingValue(ctx, "Import rules from JSON file", "path/to/masking.config.json"))?.trim();
  if (!sourceInput) return;
  const importPath = resolve(ctx.cwd, sourceInput);
  const target = await chooseExistingSource(ctx, "Import into which config?");
  if (!target) return;
  try {
    const imported = await readRawConfigFile(importPath);
    if (imported._redactedExport !== undefined) throw new Error("redacted exports cannot be imported as runnable rules");
    if (imported.rules.length === 0) {
      ctx.ui.notify("Import file contains no rules", "info");
      return;
    }
    const ids = imported.rules.map((rule) => typeof rule?.id === "string" ? rule.id : "<invalid>");
    const literalCount = imported.rules.filter((rule) => typeof rule?.real === "string").length;
    const riskWarnings = imported.rules.flatMap((rule) => validateRawConfigRule(rule));
    const mutations = imported.rules.map((rule) => ({ kind: "append" as const, path: target.path, rule }));
    if (await saveStructuralChanges(bridge, ctx, mutations, {
      title: "Import masking rules?",
      force: true,
      warning: [`Source: ${importPath}`, `Target: ${target.path}`, `Rules (${ids.length}): ${ids.join(", ")}`, `${literalCount} direct literal value(s) will be copied without being displayed.`, ...riskWarnings.map((warning) => `Warning: ${warning}`)].join("\n"),
    })) ctx.ui.notify(`Imported ${ids.length} rule(s) into ${target.scope} config`, "info");
  } catch (err) {
    ctx.ui.notify(`Failed to import rules: ${(err as Error).message}`, "error");
  }
}

export async function exportConfigRules(bridge: MaskingUIBridge, ctx: ExtensionContext): Promise<void> {
  const source = await chooseExistingSource(ctx, "Export which config?");
  if (!source) return;
  const destinationInput = (await inputMaskingValue(ctx, "Redacted export destination", "masking.config.redacted.json"))?.trim();
  if (!destinationInput) return;
  const destination = resolve(ctx.cwd, destinationInput);
  try {
    const redacted = redactRawConfigFile(await readRawConfigFile(source.path));
    if (!await confirmMaskingAction(
      ctx,
      "Create redacted export?",
      `Destination: ${destination}\nDirect literal values will be replaced. The export cannot be imported as a runnable configuration and will not overwrite an existing file.`,
    )) return;
    await createJsonFileExclusive(destination, redacted);
    ctx.ui.notify(`Created redacted export: ${destination}`, "info");
  } catch (err) {
    ctx.ui.notify(`Failed to export config: ${(err as Error).message}`, "error");
  }
}

/** Options are global-only settings: they always live in the global config
 *  (created on first save if it does not exist yet). */
function optionsEditTarget(_ctx: ExtensionContext): { scope: ConfigScope; path: string } {
  return { scope: "global", path: GLOBAL_CONFIG_PATH };
}

/** Save options changes with the same cache-impact preflight as rule edits. */
export async function saveConfigOptionsUI(
  bridge: MaskingUIBridge,
  ctx: ExtensionContext,
  options: Partial<Pick<MaskingOptions, "systemPromptGuidance" | "disclosePlaceholders" | "showStatusBar" | "allowlist">>,
  target?: { scope: ConfigScope; path: string },
): Promise<ConfigSaveResult> {
  const resolvedTarget = target ?? optionsEditTarget(ctx);
  try {
    const preview = await previewConfigOptionChanges(resolvedTarget.path, options);
    const candidate = await bridge.candidateConfigFromSources(ctx, preview.sources);
    // Non-forced option saves never ask: interactive confirmation (save /
    // discard) happens in the calling editor when one exists.
    const outcome = await bridge.confirmConfigSave(ctx, candidate.config);
    if (!outcome.saved) return { saved: false };
    await saveConfigOptionChanges(resolvedTarget.path, options);
    bridge.notifyWarnings(ctx, candidate.warnings);
    await bridge.reloadConfigNow(ctx);
    return { saved: true, impact: outcome.impact };
  } catch (err) {
    ctx.ui.notify(`Failed to update masking options: ${(err as Error).message}`, "error");
    return { saved: false };
  }
}
