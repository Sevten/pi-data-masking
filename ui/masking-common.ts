/**
 * ui/masking-common.ts
 * Shared building blocks for the /masking screens: full-screen overlay
 * conventions, option pickers, text input, source pickers, rule display
 * helpers, and the bridge interface through which the UI modules read
 * extension state and invoke core actions (index.ts implements it).
 * The UI modules never import index.ts — everything crosses the bridge.
 */


import { existsSync } from "node:fs";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, truncateToWidth, wrapTextWithAnsi, type EditorTheme } from "@earendil-works/pi-tui";
import {
  GLOBAL_CONFIG_PATH,
  getProjectConfigPath,
  type ConfigScope,
  type ConfiguredMaskingRule,
  type MaskingConfig,
  type RawConfigRule,
} from "../config-loader.ts";
import { isRegexRule } from "../masker.ts";
import type { RuleEpochReason } from "../rule-epoch.ts";

// ── Command: /masking ────────────────────────────────────────────────────

export const MASKING_SCREEN_OPTIONS = {
  overlay: true,
  overlayOptions: { width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 },
} as const;

/**
 * A full-width overlay still exposes the transcript on rows the component
 * does not render. Every /masking screen therefore paints at least one full
 * terminal viewport, including short pickers and confirmation prompts.
 */
export function fillMaskingScreen(lines: string[], width: number, rows: number): string[] {
  const clipped = lines.map((line) => truncateToWidth(line, Math.max(1, width)));
  return [...clipped, ...Array(Math.max(0, rows - clipped.length)).fill("")];
}

export function wrappedMaskingText(text: string, width: number): string[] {
  return text.split("\n").flatMap((line) => line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]);
}

export async function selectMaskingOption(
  ctx: ExtensionContext,
  title: string,
  options: readonly string[],
  message?: string,
): Promise<string | undefined> {
  if (options.length === 0) return undefined;
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    let selectedIndex = 0;
    return {
      render: (width) => {
        const lines = [theme.fg("accent", theme.bold(title)), ""];
        if (message) lines.push(...wrappedMaskingText(message, width), "");
        for (let index = 0; index < options.length; index++) {
          const row = `${index === selectedIndex ? "▶" : " "} ${options[index]}`;
          lines.push(index === selectedIndex ? theme.fg("accent", row) : theme.fg("muted", row));
        }
        lines.push("");
        lines.push(...wrappedMaskingText(theme.fg("dim", "↑↓ select · Enter confirm · Esc cancel"), width));
        return fillMaskingScreen(lines, width, tui.terminal.rows);
      },
      invalidate: () => {},
      handleInput: (data) => {
        if (keybindings.matches(data, "tui.select.up")) {
          selectedIndex = (selectedIndex - 1 + options.length) % options.length;
          tui.requestRender();
        } else if (keybindings.matches(data, "tui.select.down")) {
          selectedIndex = (selectedIndex + 1) % options.length;
          tui.requestRender();
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          done(options[selectedIndex]);
        } else if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) {
          done(undefined);
        }
      },
    };
  }, MASKING_SCREEN_OPTIONS);
}

export async function confirmMaskingAction(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
  return await selectMaskingOption(ctx, title, ["Yes", "No"], message) === "Yes";
}

export async function inputMaskingValue(
  ctx: ExtensionContext,
  title: string,
  placeholder: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
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
    const editor = new Editor(tui, editorTheme);
    editor.focused = true;
    editor.onChange = () => tui.requestRender();
    editor.onSubmit = (value) => done(value);
    return {
      render: (width) => fillMaskingScreen([
        theme.fg("accent", theme.bold(title)),
        theme.fg("muted", `Example: ${placeholder}`),
        "",
        ...editor.render(width),
        "",
        ...wrappedMaskingText(theme.fg("dim", "Enter confirm · Esc cancel"), width),
      ], width, tui.terminal.rows),
      invalidate: () => editor.invalidate(),
      handleInput: (data) => {
        if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt")) {
          done(undefined);
        } else {
          editor.handleInput(data);
        }
      },
    };
  }, MASKING_SCREEN_OPTIONS);
}

export async function chooseExistingSource(
  ctx: ExtensionContext,
  title: string,
): Promise<{ scope: ConfigScope; path: string } | undefined> {
  const projectPath = getProjectConfigPath(ctx.cwd);
  const choices: Array<{ label: string; scope: ConfigScope; path: string }> = [];
  if (existsSync(projectPath)) choices.push({ label: `project  ·  ${projectPath}`, scope: "project", path: projectPath });
  if (existsSync(GLOBAL_CONFIG_PATH)) choices.push({ label: `global   ·  ${GLOBAL_CONFIG_PATH}`, scope: "global", path: GLOBAL_CONFIG_PATH });
  if (choices.length === 0) {
    ctx.ui.notify("Add a rule first to create a project or global config", "warning");
    return undefined;
  }
  const selected = await selectMaskingOption(ctx, title, choices.map(({ label }) => label));
  if (!selected) return undefined;
  return choices.find(({ label }) => label === selected);
}

export interface ConfigSaveConfirmation {
  title?: string;
  warning?: string;
  force?: boolean;
}
export function configuredRuleStableKey(configured: ConfiguredMaskingRule): string {
  return `${configured.path}\0${configured.rule.id}`;
}

export function configuredRuleKind(configured: ConfiguredMaskingRule): "regex" | "exact" | "env" {
  if (isRegexRule(configured.rule)) return "regex";
  return configured.realFromEnv ? "env" : "exact";
}

export function configuredRuleDisplayName(configured: ConfiguredMaskingRule): string {
  return configured.rule.name?.trim()
    || configured.rule.description?.trim()
    || configured.rule.id;
}

export function configuredRuleDetail(
  configured: ConfiguredMaskingRule,
  showExactValues: boolean,
  globalDisclose: boolean | "per-rule",
  dim: (text: string) => string = (text) => text,
): string[] {
  const rule = configured.rule;
  const lines = [
    `Description: ${rule.description?.trim() || "—"}`,
  ];
  if (configured.sourceKind === "preset") {
    lines.push(`Preset: ${configured.presetName}`);
    if (isRegexRule(rule)) lines.push(`Expanded regex: /${rule.pattern}/${rule.flags ?? ""}`);
  } else if (isRegexRule(rule)) {
    lines.push(`Regex: /${rule.pattern}/${rule.flags ?? ""}`);
  } else {
    if (configured.realFromEnv) {
      lines.push(`Environment: ${configured.realFromEnv} · ${configured.available ? "available" : "missing or empty"}`);
      if (configured.available) {
        lines.push("Resolved value: <hidden>");
      }
    } else {
      lines.push(showExactValues
        ? `Exact value: ${rule.real ?? ""}`
        : "Exact value: <hidden> · R to show");
    }
    if (configured.placeholderMode === "custom") {
      lines.push(`Placeholder: ${rule.placeholder} · custom`);
    } else if (configured.enabled && configured.available && rule.placeholder && rule.placeholder !== "auto") {
      lines.push(`Placeholder: ${rule.placeholder} · automatic`);
    } else {
      lines.push("Placeholder: automatic");
    }
    const disclose = (rule as { disclosePlaceholder?: boolean }).disclosePlaceholder;
    lines.push(ruleDiscloseDetail(disclose, globalDisclose, dim));
  }
  return lines;
}

/** The `Disclose:` rule-detail line: the effective value first, then the
 *  rule-level setting — dimmed whenever it is not the layer in effect (the
 *  global on/off master switch pauses it; in per-rule mode an unset rule
 *  falls back to the default off). */
function ruleDiscloseDetail(
  disclose: boolean | undefined,
  globalMode: boolean | "per-rule",
  dim: (text: string) => string,
): string {
  const ruleLabel = disclose === undefined ? "unset" : disclose ? "on" : "off";
  if (globalMode === "per-rule") {
    const effective = disclose === true ? "on" : "off";
    const rulePart = disclose === undefined ? "rule: unset → default off" : `rule: ${ruleLabel}`;
    return `Disclose: ${effective} (${dim(rulePart)})`;
  }
  return `Disclose: ${globalMode ? "on" : "off"} (global) · ${dim(`rule: ${ruleLabel}${disclose === undefined ? " (default off)" : ""} · paused`)}`;
}

/**
 * The slice of extension state and core actions the /masking UI needs.
 * Implemented in index.ts over the extension closure; UI modules take it as
 * their first parameter and never reach into extension state directly.
 */
export interface MaskingUIBridge {
  /** The active masking config. */
  config(): MaskingConfig;
  /** The config that would run next: pending activation, else active. */
  effectiveConfig(): MaskingConfig;
  /** True while a config change is queued behind the active agent run. */
  activationPending(): boolean;
  /** Session-wide placeholder derivation key. */
  sessionKey(): Buffer;
  /** True once any masked content actually crossed the model boundary. */
  sessionMaskedOutbound(): boolean;
  /** One-time model-guidance upgrade notice still pending? */
  guidanceNoticePending(): boolean;
  /** Clear the upgrade notice (user enabled guidance from the settings zone). */
  clearGuidanceNotice(): void;
  candidateConfigFromSources(
    ctx: ExtensionContext,
    sources: Array<{ path: string; data: { rules: RawConfigRule[]; [key: string]: unknown } }>,
  ): Promise<{ config: MaskingConfig; warnings: string[] }>;
  acceptConfigChange(
    ctx: ExtensionContext,
    cfg: MaskingConfig,
    reason: RuleEpochReason,
    warnings?: string[],
  ): "activated" | "queued";
  confirmConfigSave(
    ctx: ExtensionContext,
    cfg: MaskingConfig,
    options?: ConfigSaveConfirmation,
    ask?: (title: string, message: string) => Promise<boolean>,
  ): Promise<boolean>;
  reloadConfigNow(ctx: ExtensionContext): Promise<void>;
  notifyWarnings(ctx: ExtensionContext, warnings: string[]): void;
}
