/**
 * config-loader.ts
 * Loads and merges global + project-level config; validates rules; fills
 * auto placeholders for literal rules; provides hot-reload subscription.
 *
 * Regex rules (type: "regex") are skipped here — their real values aren't
 * known until runtime, so masker.ts generates their placeholders lazily.
 */

import { chmod, link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { watch, existsSync, statSync, type FSWatcher } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { generatePlaceholder } from "./placeholder-gen.ts";
import { isRegexRule, MAX_COLLISION_ATTEMPTS, type MaskingRule, type PreserveStructure } from "./masker.ts";
import { expandMaskingPreset, getMaskingPreset } from "./presets.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MaskingOptions {
  /** Whether literal matching is case-sensitive (default true) */
  caseSensitive: boolean;
  /** Whether to show masking status in the bottom status bar (default true) */
  showStatusBar: boolean;
  /** Whether to append a guidance paragraph to the system prompt telling the
   *  LLM that masked values are opaque placeholders and must not be inferred
   *  from or transformed (default false). */
  systemPromptGuidance: boolean;
  /** Persist model-input history snapshots and the session key in the Pi
   *  session so /masking-history survives restart (default true). */
  persistHistory: boolean;
}

export interface MaskingConfig {
  enabled: boolean;
  /** Active rules only; kept as the runtime-facing compatibility field. */
  rules: MaskingRule[];
  /** Every valid configured rule, including disabled rules and its source. */
  configuredRules: ConfiguredMaskingRule[];
  options: MaskingOptions;
}

export type ConfigScope = "project" | "global";

export interface ConfiguredMaskingRule {
  /** Expanded runtime rule. Environment values are held only in memory. */
  rule: MaskingRule;
  scope: ConfigScope;
  path: string;
  /** Position in the source file's rules array. */
  sourceIndex: number;
  /** Normalized per-rule state; omitted enabled fields become true. */
  enabled: boolean;
  /** False when the rule is valid but its environment value is unavailable. */
  available: boolean;
  /** Original configuration shape before preset/env expansion. */
  sourceKind: "literal" | "regex" | "preset";
  presetName?: string;
  realFromEnv?: string;
  /** Whether the configured literal replacement is generated or fixed. */
  placeholderMode?: "auto" | "custom";
}

export interface RuleEnabledChange {
  path: string;
  sourceIndex: number;
  id: string;
  enabled: boolean;
}

export type RawConfigRule = Record<string, unknown>;

export type ConfigRuleMutation =
  | { kind: "append"; path: string; rule: RawConfigRule }
  | { kind: "replace"; path: string; sourceIndex: number; id: string; rule: RawConfigRule }
  | { kind: "delete"; path: string; sourceIndex: number; id: string }
  | { kind: "move"; path: string; sourceIndex: number; id: string; targetIndex: number; targetId: string };

export interface RawConfigFile {
  [key: string]: unknown;
  rules: RawConfigRule[];
}

export interface InitialConfigOptions {
  showStatusBar: boolean;
  persistHistory: boolean;
}

export interface InitialConfig {
  $schema: string;
  version: 1;
  enabled: true;
  rules: Array<{ id: string; name: string; preset: string; enabled: true }>;
  options: {
    caseSensitive: true;
    showStatusBar: boolean;
    systemPromptGuidance: false;
    persistHistory: boolean;
  };
}

export interface LoadResult {
  config: MaskingConfig;
  /** Non-fatal problems found while reading/validating the config */
  warnings: string[];
}

export interface PersistentToggleResult {
  /** Undefined means no toggle has been saved; use the config-file value. */
  enabled: boolean | undefined;
  warning?: string;
}

export type { MaskingRule };

// ─── Paths ──────────────────────────────────────────────────────────────────

/** Pi user config root. Can be overridden by PI_CODING_AGENT_DIR. */
const AGENT_CONFIG_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/** Global config: ~/.pi/agent/pi-data-masking/masking.config.json */
export const GLOBAL_CONFIG_PATH = join(
  AGENT_CONFIG_DIR,
  "pi-data-masking",
  "masking.config.json"
);

/**
 * User-level switch state. It is intentionally separate from the rule config:
 * the command must survive new sessions and project-level `enabled` settings
 * without rewriting a user's rules.
 */
export const PERSISTENT_TOGGLE_PATH = join(
  AGENT_CONFIG_DIR,
  "pi-data-masking",
  "toggle-state.json"
);

export const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/sevten/pi-data-masking/main/masking.config.schema.json";

/** Project-level config path: <cwd>/.pi/pi-data-masking/masking.config.json */
export function getProjectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "pi-data-masking", "masking.config.json");
}

/** Generate a readable ID from a display name and avoid collisions in one file. */
export function generateUniqueRuleId(name: string, existingIds: Iterable<string>): string {
  const used = new Set(existingIds);
  const readable = name
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const stem = readable || `rule-${randomUUID().slice(0, 8)}`;
  if (!used.has(stem)) return stem;
  let suffix = 2;
  while (used.has(`${stem}-${suffix}`)) suffix++;
  return `${stem}-${suffix}`;
}

/** Build the minimal config written by the /masking-config initializer. */
export function buildInitialConfig(
  presetNames: readonly string[],
  options: InitialConfigOptions = { showStatusBar: true, persistHistory: true },
): InitialConfig {
  const uniqueNames = [...new Set(presetNames)];
  for (const name of uniqueNames) {
    if (!getMaskingPreset(name)) throw new Error(`Unknown masking preset ${JSON.stringify(name)}`);
  }
  return {
    $schema: CONFIG_SCHEMA_URL,
    version: 1,
    enabled: true,
    rules: uniqueNames.map((presetName) => {
      const preset = getMaskingPreset(presetName)!;
      return { id: presetName, name: preset.label, preset: presetName, enabled: true };
    }),
    options: {
      caseSensitive: true,
      showStatusBar: options.showStatusBar,
      systemPromptGuidance: false,
      persistHistory: options.persistHistory,
    },
  };
}

/**
 * Atomically publish a new config with user-only permissions. A hard-link is
 * used as the final publish operation so an existing target can never be
 * overwritten, including if another process creates it during the wizard.
 */
export async function createInitialConfigFile(path: string, config: InitialConfig): Promise<void> {
  const validation = validateConfig(config.rules);
  if (validation.rules.length !== config.rules.length || validation.warnings.length > 0) {
    throw new Error(`Generated config failed validation: ${validation.warnings.join("; ")}`);
  }

  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(tempPath, 0o600);
    await link(tempPath, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Config already exists at ${path}; it was not overwritten`);
    }
    throw err;
  } finally {
    try {
      await unlink(tempPath);
    } catch {
      // The temp may not have been created or may already be gone.
    }
  }
}

/** Add the project config path to .gitignore without duplicating the entry. */
export async function ensureProjectConfigGitignored(cwd: string): Promise<boolean> {
  const ignorePath = join(cwd, ".gitignore");
  const entry = `${CONFIG_DIR_NAME}/pi-data-masking/masking.config.json`;
  let current = "";
  let mode = 0o644;
  try {
    current = await readFile(ignorePath, "utf8");
    mode = (await stat(ignorePath)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return false;

  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  const content = `${current}${separator}${entry}\n`;
  const tempPath = `${ignorePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode });
    await chmod(tempPath, mode);
    await rename(tempPath, ignorePath);
  } catch (err) {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore cleanup failures.
    }
    throw err;
  }
  return true;
}

// ─── Defaults ─────────────────────────────────────────────────────────────

function defaultConfig(): MaskingConfig {
  return {
    enabled: true,
    rules: [],
    configuredRules: [],
    options: {
      caseSensitive: true,
      showStatusBar: true,
      systemPromptGuidance: false,
      persistHistory: true,
    },
  };
}

// ─── File reading ───────────────────────────────────────────────────────────

interface ReadJsonResult {
  /** Parsed data; null when the file doesn't exist */
  data: Partial<MaskingConfig> | null;
  /** Set when the file exists but can't be read or parsed */
  error: string | null;
}

async function tryReadJson(path: string): Promise<ReadJsonResult> {
  try {
    const raw = await readFile(path, "utf8");
    return { data: JSON.parse(raw) as Partial<MaskingConfig>, error: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { data: null, error: null };
    }
    return { data: null, error: `Failed to read/parse ${path}: ${(err as Error).message}` };
  }
}

/** Read the user-level override written by /masking-toggle. */
export async function loadPersistentToggle(
  path = PERSISTENT_TOGGLE_PATH
): Promise<PersistentToggleResult> {
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || typeof (data as { enabled?: unknown }).enabled !== "boolean") {
      return { enabled: undefined, warning: `Ignoring invalid persistent toggle state at ${path}` };
    }
    return { enabled: (data as { enabled: boolean }).enabled };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { enabled: undefined };
    return { enabled: undefined, warning: `Failed to read persistent toggle state at ${path}: ${(err as Error).message}` };
  }
}

/** Persist the user-controlled enabled state atomically and with user-only permissions. */
export async function savePersistentToggle(
  enabled: boolean,
  path = PERSISTENT_TOGGLE_PATH
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify({ enabled }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

// ─── Merge logic ──────────────────────────────────────────────────────────

/**
 * Merge strategy:
 *  - rules: project-level rules first (higher priority), global rules appended after
 *  - options: project-level fields override global fields of the same name
 *  - enabled: project-level value wins if explicitly set, otherwise falls back to global
 */
function mergeConfigs(
  global: Partial<MaskingConfig> | null,
  project: Partial<MaskingConfig> | null
): MaskingConfig {
  const base = defaultConfig();

  const enabled =
    project?.enabled ?? global?.enabled ?? base.enabled;

  const options: MaskingOptions = {
    ...base.options,
    ...(global?.options ?? {}),
    ...(project?.options ?? {}),
  };

  // Rules are validated and collected with source metadata below.
  return { enabled, rules: [], configuredRules: [], options };
}

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * Validate raw rule entries. Invalid rules are skipped (not fatal) and a
 * warning is produced for each, so a typo in one rule never disables the
 * whole extension silently.
 */
export function validateConfig(
  rawRules: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { rules: MaskingRule[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!Array.isArray(rawRules)) {
    return { rules: [], warnings: ["config.rules is not an array; all rules were ignored"] };
  }

  const rules: MaskingRule[] = [];
  const seenIds = new Set<string>();
  for (const raw of rawRules) {
    if (raw === null || typeof raw !== "object") {
      warnings.push("A rule entry is not an object and was skipped");
      continue;
    }
    const rule = raw as Record<string, unknown>;
    const id = typeof rule.id === "string" ? rule.id : "";
    if (!id) {
      warnings.push("A rule entry is missing a non-empty 'id' and was skipped");
      continue;
    }
    if (seenIds.has(id)) {
      warnings.push(`Rule [${id}] duplicates an earlier ID in the same config and was skipped`);
      continue;
    }
    seenIds.add(id);
    if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
      warnings.push(`Rule [${id}] has invalid 'enabled' (must be a boolean) and was skipped`);
      continue;
    }
    if (rule.name !== undefined && (typeof rule.name !== "string" || rule.name.trim().length === 0)) {
      warnings.push(`Rule [${id}] has invalid 'name' (must be a non-empty string) and was skipped`);
      continue;
    }

    let preserveStructure: PreserveStructure | undefined;
    if (rule.preserveStructure !== undefined) {
      if (!rule.preserveStructure || typeof rule.preserveStructure !== "object" || Array.isArray(rule.preserveStructure)) {
        warnings.push(`Rule [${id}] has invalid 'preserveStructure' (must be an object) and was skipped`);
        continue;
      }
      const preserve = rule.preserveStructure as Record<string, unknown>;
      if (
        preserve.keepPrefix !== undefined &&
        typeof preserve.keepPrefix !== "boolean" &&
        !(typeof preserve.keepPrefix === "number" && Number.isInteger(preserve.keepPrefix) && preserve.keepPrefix >= 0)
      ) {
        warnings.push(`Rule [${id}] has invalid 'preserveStructure.keepPrefix' and was skipped`);
        continue;
      }
      if (
        preserve.keepIPv4Octets !== undefined &&
        !(typeof preserve.keepIPv4Octets === "number" && Number.isInteger(preserve.keepIPv4Octets) && preserve.keepIPv4Octets >= 0 && preserve.keepIPv4Octets <= 3)
      ) {
        warnings.push(`Rule [${id}] has invalid 'preserveStructure.keepIPv4Octets' (expected 0-3) and was skipped`);
        continue;
      }
      preserveStructure = rule.preserveStructure as PreserveStructure;
    }

    if (rule.preset !== undefined) {
      if (typeof rule.preset !== "string" || rule.preset.length === 0) {
        warnings.push(`Rule [${id}] has invalid 'preset' (must be a non-empty string) and was skipped`);
        continue;
      }
      const incompatible = ["type", "real", "realFromEnv", "pattern", "flags", "placeholder"]
        .filter((field) => rule[field] !== undefined);
      if (incompatible.length > 0) {
        warnings.push(`Rule [${id}] preset reference also sets ${incompatible.join(", ")} and was skipped`);
        continue;
      }
      const preset = getMaskingPreset(rule.preset);
      if (!preset) {
        warnings.push(`Rule [${id}] references unknown preset ${JSON.stringify(rule.preset)} and was skipped`);
        continue;
      }
      rules.push(expandMaskingPreset(preset, {
        id,
        name: typeof rule.name === "string" ? rule.name : undefined,
        enabled: rule.enabled as boolean | undefined,
        description: typeof rule.description === "string" ? rule.description : undefined,
        lowEntropy: rule.lowEntropy === true,
        preserveStructure,
      }));
      continue;
    }

    if (rule.type === "regex") {
      if (rule.real !== undefined || rule.realFromEnv !== undefined || rule.placeholder !== undefined) {
        warnings.push(`Rule [${id}] is regex but also sets a literal-only field and was skipped`);
        continue;
      }
      const pattern = typeof rule.pattern === "string" ? rule.pattern : "";
      if (!pattern) {
        warnings.push(`Rule [${id}] is type "regex" but has no pattern; skipped`);
        continue;
      }
      try {
        const baseFlags = typeof rule.flags === "string" ? rule.flags : "";
        new RegExp(pattern, baseFlags);
      } catch (err) {
        warnings.push(`Rule [${id}] has an invalid regex and was skipped: ${(err as Error).message}`);
        continue;
      }
      if (rule.lowEntropy !== true) {
        const est = estimateMatchLength(pattern);
        if (est !== null && est.max > 0 && est.max <= 6) {
          warnings.push(
            `Rule [${id}] can only match values of at most ${est.max} character(s) — low entropy; ` +
              `masking short/common values causes semantic contradictions and coincidental restores. ` +
              `Consider not masking them; set "lowEntropy": true to silence this warning`
          );
        }
      }
      rules.push({ ...(raw as MaskingRule), preserveStructure } as MaskingRule);
      continue;
    }

    if (rule.type === undefined || rule.type === "literal") {
      if (rule.pattern !== undefined || rule.flags !== undefined) {
        warnings.push(`Rule [${id}] is literal but also sets a regex-only field and was skipped`);
        continue;
      }
      const hasReal = typeof rule.real === "string" && rule.real.length > 0;
      const hasEnvName = typeof rule.realFromEnv === "string" && rule.realFromEnv.length > 0;
      if (rule.real !== undefined && rule.realFromEnv !== undefined) {
        warnings.push(`Rule [${id}] sets both 'real' and 'realFromEnv' and was skipped`);
        continue;
      }
      if (!hasReal && !hasEnvName) {
        warnings.push(`Rule [${id}] is literal but has no 'real' value or valid 'realFromEnv'; skipped`);
        continue;
      }
      const envName = hasEnvName ? rule.realFromEnv as string : undefined;
      const real = hasReal ? rule.real as string : envName ? env[envName] ?? "" : "";
      if (envName && real.length === 0) {
        warnings.push(`Rule [${id}] environment variable ${JSON.stringify(envName)} is missing or empty; rule is inactive`);
        continue;
      }
      if (rule.lowEntropy !== true && real.length < 8) {
        warnings.push(
          `Rule [${id}] masks a ${real.length}-character value — low entropy; ` +
            `masking short/common values causes semantic contradictions and coincidental restores. ` +
            `Consider not masking them; set "lowEntropy": true to silence this warning`
        );
      }
      if (rule.placeholder !== undefined && rule.placeholder !== "auto") {
        if (typeof rule.placeholder !== "string" || rule.placeholder.length === 0) {
          warnings.push(`Rule [${id}] has an invalid placeholder (must be a non-empty string or "auto"); skipped`);
          continue;
        }
      }
      const resolved: MaskingRule = {
        id,
        name: typeof rule.name === "string" ? rule.name : undefined,
        type: rule.type as "literal" | undefined,
        enabled: rule.enabled as boolean | undefined,
        description: typeof rule.description === "string" ? rule.description : undefined,
        lowEntropy: rule.lowEntropy === true,
        preserveStructure,
        real,
        placeholder: rule.placeholder as string | undefined,
      };
      rules.push(resolved);
      continue;
    }

    warnings.push(`Rule [${id}] has unknown type ${JSON.stringify(rule.type)} and was skipped`);
  }
  return { rules, warnings };
}

/**
 * Heuristic: estimate the minimum/maximum number of characters a regex can
 * match. Used to flag patterns that can only match very short (low-entropy)
 * values, which are better left unmasked. Returns null when the pattern
 * can't be analyzed (exotic constructs) — validation already rejected
 * invalid regexes, so this only affects warning coverage, never correctness.
 *
 * Handles: literals, character classes, \d/\w/\s-style escapes, \b anchors,
 * groups (capturing/non-capturing/lookaround), alternation, and quantifiers
 * (?, *, +, {m}, {m,n}, {m,}). Lazy/possessive suffixes don't change length.
 */
function estimateMatchLength(pattern: string): { min: number; max: number } | null {
  const INF = Number.POSITIVE_INFINITY;
  let i = 0;

  function parseAlternation(): { min: number; max: number } {
    let min = INF;
    let max = 0;
    let first = true;
    for (;;) {
      const seg = parseSequence();
      if (first) {
        min = seg.min;
        max = seg.max;
        first = false;
      } else {
        min = Math.min(min, seg.min);
        max = Math.max(max, seg.max);
      }
      if (i >= pattern.length || pattern[i] !== "|") break;
      i++; // consume '|'
    }
    return { min, max };
  }

  function parseSequence(): { min: number; max: number } {
    let min = 0;
    let max = 0;
    while (i < pattern.length && pattern[i] !== "|" && pattern[i] !== ")") {
      const atom = parseAtom();
      if (!atom) break;
      let qmin = 1;
      let qmax = 1;
      if (i < pattern.length) {
        const c = pattern[i];
        if (c === "?") {
          qmin = 0;
          qmax = 1;
          i++;
        } else if (c === "*") {
          qmin = 0;
          qmax = INF;
          i++;
        } else if (c === "+") {
          qmin = 1;
          qmax = INF;
          i++;
        } else if (c === "{") {
          const close = pattern.indexOf("}", i);
          if (close !== -1) {
            const parts = pattern.slice(i + 1, close).split(",").map((s) => s.trim());
            const n = parseInt(parts[0] ?? "", 10);
            if (!Number.isNaN(n)) {
              qmin = n;
              qmax = parts.length > 1 ? (parts[1] === "" ? INF : parseInt(parts[1], 10)) : n;
              i = close + 1;
            }
          }
        }
      }
      // Lazy (?) and possessive (+) suffixes don't change the length
      if (i < pattern.length && (pattern[i] === "?" || pattern[i] === "+")) i++;
      if (atom.max === INF || qmax === INF) max = INF;
      else max += atom.max * qmax;
      min += atom.min * qmin;
    }
    return { min, max };
  }

  function parseAtom(): { min: number; max: number } | null {
    if (i >= pattern.length) return null;
    const c = pattern[i];
    if (c === "(") {
      i++;
      if (i < pattern.length && pattern[i] === "?") {
        const next = pattern[i + 1];
        if (next === ":" || next === "=" || next === "!") i += 2; // (?: (?= (?!
        else if (next === "<") i += 3; // (?<= (?<!
        else {
          // Inline flags like (?i) — skip to the closing paren
          const close = pattern.indexOf(")", i);
          if (close === -1) return null;
          i = close + 1;
          return { min: 0, max: 0 };
        }
      }
      const inner = parseAlternation();
      if (i < pattern.length && pattern[i] === ")") i++;
      return inner;
    }
    if (c === "[") {
      i++;
      if (i < pattern.length && pattern[i] === "^") i++;
      while (i < pattern.length && pattern[i] !== "]") i++;
      if (i < pattern.length) i++;
      return { min: 1, max: 1 };
    }
    if (c === "\\") {
      i += 2;
      const esc = pattern[i - 1];
      if (esc === "b" || esc === "B" || esc === "A" || esc === "z" || esc === "Z" || esc === "G") {
        return { min: 0, max: 0 };
      }
      if (esc === "p" || esc === "P") {
        const close = pattern.indexOf("}", i);
        if (close !== -1) i = close + 1;
        return { min: 1, max: 1 };
      }
      return { min: 1, max: 1 }; // \d \w \s \t ... or an escaped literal
    }
    if (c === ".") {
      i++;
      return { min: 1, max: INF };
    }
    if (c === "^" || c === "$") {
      i++;
      return { min: 0, max: 0 };
    }
    i++; // literal character
    return { min: 1, max: 1 };
  }

  const result = parseAlternation();
  return i < pattern.length ? null : result;
}

// ─── Placeholder filling ────────────────────────────────────────────────────

/**
 * For each literal rule, check its placeholder field:
 *  - missing or "auto" → generate via format-preserving replacement
 *  - explicit value     → use as-is (manual takes precedence)
 *
 * Regex rules (type: "regex") are skipped: they have no fixed real value,
 * so masker.ts generates their placeholders at runtime per match.
 *
 * Collision protection: a used set is seeded with every manual placeholder
 * and every real value, then auto-generated placeholders retry with an
 * incremented attempt counter until they don't collide (bounded retries,
 * mirroring masker.ts's runtime logic). The same real value always reuses
 * the same placeholder, so global + project rules stay consistent.
 */
function fillPlaceholders(rules: MaskingRule[], sessionKey: Buffer, warnings: string[]): void {
  const used = new Set<string>();
  const seen = new Map<string, string>(); // real → placeholder, for dedup

  // Seed the used set before generating anything so collisions with manual
  // placeholders or with any rule's real value are avoided from the start.
  for (const rule of rules) {
    if (isRegexRule(rule)) continue;
    if (rule.placeholder && rule.placeholder !== "auto") used.add(rule.placeholder);
    if (rule.real) used.add(rule.real);
  }

  for (const rule of rules) {
    if (isRegexRule(rule)) continue;
    if (rule.placeholder && rule.placeholder !== "auto") continue;

    const existing = seen.get(rule.real);
    if (existing !== undefined) {
      rule.placeholder = existing;
      continue;
    }

    let attempt = 0;
    let candidate = generatePlaceholder(rule.real, sessionKey, attempt, rule.preserveStructure);
    while (
      (used.has(candidate) || candidate === rule.real) &&
      attempt < MAX_COLLISION_ATTEMPTS
    ) {
      attempt++;
      candidate = generatePlaceholder(rule.real, sessionKey, attempt, rule.preserveStructure);
    }
    if (used.has(candidate) || candidate === rule.real) {
      warnings.push(
        `Rule [${rule.id}]: placeholder still collided after ${MAX_COLLISION_ATTEMPTS} retries; accepted as-is`
      );
    }

    rule.placeholder = candidate;
    used.add(candidate);
    seen.set(rule.real, candidate);
  }
}

// ─── Main loader ──────────────────────────────────────────────────────────

/**
 * @param cwd        Current working directory, used to locate project config
 * @param sessionKey Session key, generated by index.ts on session_start and
 *                   passed in unchanged for the whole session (including hot reloads)
 */
export async function loadConfig(
  cwd: string,
  sessionKey: Buffer
): Promise<LoadResult> {
  return loadConfigFromPaths(GLOBAL_CONFIG_PATH, getProjectConfigPath(cwd), sessionKey);
}

/**
 * Load and merge two explicit config paths (used by loadConfig and by tests).
 */
export async function loadConfigFromPaths(
  globalPath: string,
  projectPath: string,
  sessionKey: Buffer,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadResult> {
  const [globalResult, projectResult] = await Promise.all([
    tryReadJson(globalPath),
    tryReadJson(projectPath),
  ]);

  const warnings: string[] = [];
  if (globalResult.error) warnings.push(globalResult.error);
  if (projectResult.error) warnings.push(projectResult.error);

  if (globalResult.data && globalResult.data.rules !== undefined && !Array.isArray(globalResult.data.rules)) {
    warnings.push("global config.rules is not an array; its rules were ignored");
  }
  if (projectResult.data && projectResult.data.rules !== undefined && !Array.isArray(projectResult.data.rules)) {
    warnings.push("project config.rules is not an array; its rules were ignored");
  }

  const config = mergeConfigs(globalResult.data, projectResult.data);
  const configuredRules: ConfiguredMaskingRule[] = [];

  function collect(
    data: Partial<MaskingConfig> | null,
    scope: ConfigScope,
    path: string,
  ): void {
    if (!Array.isArray(data?.rules)) return;
    const seenIds = new Set<string>();
    data.rules.forEach((raw, sourceIndex) => {
      const rawRecord = raw as unknown as Record<string, unknown>;
      const rawId = typeof rawRecord?.id === "string" ? rawRecord.id : undefined;
      if (rawId && seenIds.has(rawId)) {
        warnings.push(`${scope} Rule [${rawId}] duplicates an earlier ID in the same config and was skipped`);
        return;
      }
      if (rawId) seenIds.add(rawId);

      const validated = validateConfig([raw], env);
      warnings.push(...validated.warnings.map((warning) => `${scope} ${warning}`));
      const presetName = typeof rawRecord.preset === "string" ? rawRecord.preset : undefined;
      const realFromEnv = typeof rawRecord.realFromEnv === "string" ? rawRecord.realFromEnv : undefined;
      let rule = validated.rules[0];
      let available = true;
      // A structurally valid env-backed rule remains visible/configurable even
      // when its current process value is unavailable. Probe with an internal
      // non-secret value to distinguish this case from other validation errors.
      if (!rule && realFromEnv && !(env[realFromEnv]?.length)) {
        const probed = validateConfig([raw], { [realFromEnv]: "masking-environment-probe-value" });
        rule = probed.rules[0];
        if (rule && !isRegexRule(rule)) {
          rule = { ...rule, real: "", placeholder: rawRecord.placeholder as string | undefined };
          available = false;
        }
      }
      if (!rule) return;
      configuredRules.push({
        rule,
        scope,
        path,
        sourceIndex,
        enabled: rule.enabled !== false,
        available,
        sourceKind: presetName ? "preset" : isRegexRule(rule) ? "regex" : "literal",
        presetName,
        realFromEnv,
        placeholderMode: !isRegexRule(rule)
          ? typeof rawRecord.placeholder === "string" && rawRecord.placeholder !== "auto"
            ? "custom"
            : "auto"
          : undefined,
      });
    });
  }

  // Preserve the established priority: project rules before global rules.
  collect(projectResult.data, "project", projectPath);
  collect(globalResult.data, "global", globalPath);

  config.configuredRules = configuredRules;
  config.rules = configuredRules
    .filter((configured) => configured.enabled && configured.available)
    .map((configured) => configured.rule);

  // Disabled rules must not reserve or generate placeholders.
  fillPlaceholders(config.rules, sessionKey, warnings);
  return { config, warnings };
}

/**
 * Atomically persist one or more per-rule enabled changes. All targets are
 * parsed and checked before any file is written. A temp file with mode 0600
 * is then renamed over each source config.
 */
export async function saveRuleEnabledChanges(changes: RuleEnabledChange[]): Promise<void> {
  if (changes.length === 0) return;

  const byPath = new Map<string, RuleEnabledChange[]>();
  for (const change of changes) {
    const group = byPath.get(change.path) ?? [];
    group.push(change);
    byPath.set(change.path, group);
  }

  const pending: Array<{ path: string; tempPath: string; content: string }> = [];
  for (const [path, pathChanges] of byPath) {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Cannot update ${path}: config root is not an object`);
    }
    const data = parsed as { rules?: unknown };
    if (!Array.isArray(data.rules)) {
      throw new Error(`Cannot update ${path}: config.rules is not an array`);
    }

    for (const change of pathChanges) {
      const candidate = data.rules[change.sourceIndex];
      if (!candidate || typeof candidate !== "object") {
        throw new Error(`Cannot update rule [${change.id}] in ${path}: source position changed`);
      }
      const candidateId = (candidate as { id?: unknown }).id;
      if (candidateId !== change.id) {
        throw new Error(`Cannot update rule [${change.id}] in ${path}: source position now contains ${JSON.stringify(candidateId)}`);
      }
      (candidate as { enabled?: boolean }).enabled = change.enabled;
    }

    const tempPath = `${path}.${process.pid}.${Date.now()}.${pending.length}.tmp`;
    pending.push({ path, tempPath, content: `${JSON.stringify(data, null, 2)}\n` });
  }

  try {
    for (const item of pending) {
      await mkdir(dirname(item.path), { recursive: true });
      await writeFile(item.tempPath, item.content, { encoding: "utf8", mode: 0o600 });
      // Some mounted/cross-platform filesystems ignore the create mode.
      await chmod(item.tempPath, 0o600);
    }
    for (const item of pending) {
      await rename(item.tempPath, item.path);
      // Re-assert after rename for filesystems that preserve destination mode.
      await chmod(item.path, 0o600);
    }
  } catch (err) {
    await Promise.all(pending.map(async (item) => {
      try {
        await unlink(item.tempPath);
      } catch {
        // Ignore missing/already-renamed temps and cleanup failures.
      }
    }));
    throw err;
  }
}

export function validateRawConfigRule(rule: RawConfigRule): string[] {
  const envName = typeof rule.realFromEnv === "string" ? rule.realFromEnv : undefined;
  const env = envName ? { [envName]: process.env[envName] || "masking-environment-probe-value" } : process.env;
  const validated = validateConfig([rule], env);
  if (validated.rules.length !== 1) {
    throw new Error(validated.warnings.join("; ") || "Rule is invalid");
  }
  const warnings = [...validated.warnings];
  if (typeof rule.real === "string" && rule.placeholder === rule.real) {
    warnings.push(`Rule [${String(rule.id)}] has placeholder equal to its real value; the rule has no effect`);
  }
  return warnings;
}

/** Read one config as JSON while retaining unknown top-level fields. */
export async function readRawConfigFile(path: string): Promise<RawConfigFile> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cannot edit ${path}: config root is not an object`);
  }
  const data = parsed as Record<string, unknown>;
  if (!Array.isArray(data.rules)) {
    throw new Error(`Cannot edit ${path}: config.rules is not an array`);
  }
  return data as RawConfigFile;
}

/** Return a copy safe to display/export; direct literal values are redacted. */
export function redactRawConfigFile(data: RawConfigFile): RawConfigFile {
  return {
    ...data,
    _redactedExport: "Direct literal values were replaced and this export is not a runnable configuration.",
    rules: data.rules.map((rule) => {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) return rule;
      if (typeof rule.real !== "string") return { ...rule };
      return { ...rule, real: "<redacted-literal-value>" };
    }),
  };
}

/** Create a JSON export without overwriting an existing path. */
export async function createJsonFileExclusive(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(tempPath, 0o600);
    await link(tempPath, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`File already exists at ${path}; it was not overwritten`);
    }
    throw err;
  } finally {
    try {
      await unlink(tempPath);
    } catch {
      // Ignore missing temp files.
    }
  }
}

/**
 * Apply structural rule edits against the latest files. Existing entries are
 * verified by array position and ID so stale TUI actions never hit a different
 * rule. Unknown top-level fields and unrelated invalid legacy entries survive.
 */
export async function saveConfigRuleMutations(
  mutations: readonly ConfigRuleMutation[],
): Promise<{ warnings: string[] }> {
  if (mutations.length === 0) return { warnings: [] };
  const byPath = new Map<string, ConfigRuleMutation[]>();
  for (const mutation of mutations) {
    const group = byPath.get(mutation.path) ?? [];
    group.push(mutation);
    byPath.set(mutation.path, group);
  }

  const pending: Array<{ path: string; tempPath: string; content: string }> = [];
  const warnings: string[] = [];
  for (const [path, pathMutations] of byPath) {
    const data = await readRawConfigFile(path);
    for (const mutation of pathMutations) {
      if (mutation.kind === "append") {
        warnings.push(...validateRawConfigRule(mutation.rule));
        const id = mutation.rule.id;
        if (data.rules.some((candidate) => candidate?.id === id)) {
          throw new Error(`Cannot add rule [${String(id)}] to ${path}: ID already exists`);
        }
        data.rules.push({ ...mutation.rule });
        continue;
      }

      const candidate = data.rules[mutation.sourceIndex];
      if (!candidate || typeof candidate !== "object" || candidate.id !== mutation.id) {
        throw new Error(`Cannot ${mutation.kind} rule [${mutation.id}] in ${path}: source position changed`);
      }
      if (mutation.kind === "replace") {
        warnings.push(...validateRawConfigRule(mutation.rule));
        const nextId = mutation.rule.id;
        if (data.rules.some((other, index) => index !== mutation.sourceIndex && other?.id === nextId)) {
          throw new Error(`Cannot rename rule to [${String(nextId)}] in ${path}: ID already exists`);
        }
        data.rules[mutation.sourceIndex] = { ...mutation.rule };
      } else if (mutation.kind === "delete") {
        data.rules.splice(mutation.sourceIndex, 1);
      } else {
        const target = data.rules[mutation.targetIndex];
        if (!target || typeof target !== "object" || target.id !== mutation.targetId) {
          throw new Error(`Cannot move rule [${mutation.id}] in ${path}: target position changed`);
        }
        const [moved] = data.rules.splice(mutation.sourceIndex, 1);
        if (!moved) throw new Error(`Cannot move rule [${mutation.id}] in ${path}`);
        data.rules.splice(mutation.targetIndex, 0, moved);
      }
    }

    const tempPath = `${path}.${process.pid}.${Date.now()}.${pending.length}.tmp`;
    pending.push({ path, tempPath, content: `${JSON.stringify(data, null, 2)}\n` });
  }

  try {
    for (const item of pending) {
      await writeFile(item.tempPath, item.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(item.tempPath, 0o600);
    }
    for (const item of pending) {
      await rename(item.tempPath, item.path);
      await chmod(item.path, 0o600);
    }
  } catch (err) {
    await Promise.all(pending.map(async ({ tempPath }) => {
      try {
        await unlink(tempPath);
      } catch {
        // Ignore missing/already-renamed temps and cleanup failures.
      }
    }));
    throw err;
  }
  return { warnings };
}

// ─── File watching (hot reload) ────────────────────────────────────────────

/**
 * Watch a config file so later creation or edits trigger a reload:
 *  - if the file exists, watch it directly (catches edits);
 *  - if its parent directory exists, watch the directory (catches creation
 *    and editor-style replace-and-rename), filtered to the file name;
 *  - otherwise watch the nearest existing ancestor directory with
 *    recursive:true when supported (Windows/macOS), falling back to a
 *    non-recursive watch.
 */
function watchConfigFile(
  configPath: string,
  handleChange: () => void,
  watchers: FSWatcher[]
): void {
  const configDir = dirname(configPath);
  const fileName = basename(configPath);
  const expectedSuffix = join("pi-data-masking", fileName).split("\\").join("/");

  function matches(filename: unknown): boolean {
    if (filename === null || filename === undefined) return false;
    const normalized = String(filename).split("\\").join("/");
    return (
      normalized === fileName ||
      normalized === expectedSuffix ||
      normalized.endsWith("/" + expectedSuffix)
    );
  }

  // 1. Watch the file itself when it already exists (covers in-place edits).
  if (existsSync(configPath)) {
    try {
      watchers.push(watch(configPath, () => handleChange()));
    } catch {
      // ignore — the directory watcher below still covers most cases
    }
  }

  // 2. Watch the direct parent directory when it exists (covers creation).
  if (existsSync(configDir)) {
    try {
      watchers.push(watch(configDir, (_event, filename) => {
        if (matches(filename)) handleChange();
      }));
      return;
    } catch {
      // ignore — fall through to the ancestor watch
    }
  }

  // 3. Nearest existing ancestor (covers the whole directory chain being
  //    created after session start). Prefer recursive where supported.
  let target = configDir;
  while (!existsSync(target)) {
    const parent = dirname(target);
    if (parent === target) return; // filesystem root; nothing to watch
    target = parent;
  }
  try {
    const watcher = watch(target, { recursive: true }, (_event, filename) => {
      if (matches(filename)) handleChange();
    });
    watchers.push(watcher);
  } catch {
    try {
      watchers.push(watch(target, (_event, filename) => {
        if (matches(filename)) handleChange();
      }));
    } catch {
      // Silently ignore if watching is unsupported for this directory
    }
  }
}

export function watchConfigPaths(
  globalPath: string,
  projectPath: string,
  onChange: () => void
): () => void {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function handleChange() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 300);
  }

  watchConfigFile(globalPath, handleChange, watchers);
  watchConfigFile(projectPath, handleChange, watchers);

  // fs.watch can miss a file created immediately after a watcher is
  // registered (notably on Linux/inotify). Polling the two small config files
  // is a low-cost safety net for that race and for editor atomic replaces.
  function fileSignature(path: string): string | null {
    try {
      const stat = statSync(path);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  }

  let globalSignature = fileSignature(globalPath);
  let projectSignature = fileSignature(projectPath);
  const poller = setInterval(() => {
    const nextGlobalSignature = fileSignature(globalPath);
    const nextProjectSignature = fileSignature(projectPath);
    if (nextGlobalSignature !== globalSignature || nextProjectSignature !== projectSignature) {
      globalSignature = nextGlobalSignature;
      projectSignature = nextProjectSignature;
      handleChange();
    }
  }, 250);

  return () => {
    if (timer) clearTimeout(timer);
    clearInterval(poller);
    watchers.forEach((w) => w.close());
  };
}

/**
 * Watches both global and project-level config files, debounced 300ms
 * before calling onChange. Returns a stop() function to call on
 * session_shutdown.
 */
export function watchConfigs(cwd: string, onChange: () => void): () => void {
  return watchConfigPaths(GLOBAL_CONFIG_PATH, getProjectConfigPath(cwd), onChange);
}
