/**
 * config-loader.ts
 * Loads and merges global + project-level config; validates rules; fills
 * auto placeholders for literal rules; provides hot-reload subscription.
 *
 * Regex rules (type: "regex") are skipped here — their real values aren't
 * known until runtime, so masker.ts generates their placeholders lazily.
 */

import { readFile } from "node:fs/promises";
import { watch, existsSync, type FSWatcher } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { generatePlaceholder } from "./placeholder-gen.ts";
import { isRegexRule, MAX_COLLISION_ATTEMPTS, type MaskingRule } from "./masker.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MaskingOptions {
  /** Whether literal matching is case-sensitive (default true) */
  caseSensitive: boolean;
  /** Whether to show masking status in the bottom status bar (default true) */
  showStatusBar: boolean;
}

export interface MaskingConfig {
  enabled: boolean;
  rules: MaskingRule[];
  options: MaskingOptions;
}

export interface LoadResult {
  config: MaskingConfig;
  /** Non-fatal problems found while reading/validating the config */
  warnings: string[];
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

/** Project-level config path: <cwd>/.pi/pi-data-masking/masking.config.json */
export function getProjectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "pi-data-masking", "masking.config.json");
}

// ─── Defaults ─────────────────────────────────────────────────────────────

function defaultConfig(): MaskingConfig {
  return {
    enabled: true,
    rules: [],
    options: {
      caseSensitive: true,
      showStatusBar: true,
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

  const rules = [
    ...(Array.isArray(project?.rules) ? project.rules : []),
    ...(Array.isArray(global?.rules) ? global.rules : []),
  ];

  const options: MaskingOptions = {
    ...base.options,
    ...(global?.options ?? {}),
    ...(project?.options ?? {}),
  };

  return { enabled, rules, options };
}

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * Validate raw rule entries. Invalid rules are skipped (not fatal) and a
 * warning is produced for each, so a typo in one rule never disables the
 * whole extension silently.
 */
export function validateConfig(rawRules: unknown): { rules: MaskingRule[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!Array.isArray(rawRules)) {
    return { rules: [], warnings: ["config.rules is not an array; all rules were ignored"] };
  }

  const rules: MaskingRule[] = [];
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

    if (rule.type === "regex") {
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
      rules.push(raw as MaskingRule);
      continue;
    }

    if (rule.type === undefined || rule.type === "literal") {
      const real = typeof rule.real === "string" ? rule.real : "";
      if (!real) {
        warnings.push(`Rule [${id}] is literal but has no 'real' value; skipped`);
        continue;
      }
      if (rule.placeholder !== undefined && rule.placeholder !== "auto") {
        if (typeof rule.placeholder !== "string" || rule.placeholder.length === 0) {
          warnings.push(`Rule [${id}] has an invalid placeholder (must be a non-empty string or "auto"); skipped`);
          continue;
        }
      }
      rules.push(raw as MaskingRule);
      continue;
    }

    warnings.push(`Rule [${id}] has unknown type ${JSON.stringify(rule.type)} and was skipped`);
  }
  return { rules, warnings };
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
    let candidate = generatePlaceholder(rule.real, sessionKey, attempt);
    while (
      (used.has(candidate) || candidate === rule.real) &&
      attempt < MAX_COLLISION_ATTEMPTS
    ) {
      attempt++;
      candidate = generatePlaceholder(rule.real, sessionKey, attempt);
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
  sessionKey: Buffer
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
  const validated = validateConfig(config.rules);
  warnings.push(...validated.warnings);
  config.rules = validated.rules;

  fillPlaceholders(config.rules, sessionKey, warnings);
  return { config, warnings };
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

  return () => {
    if (timer) clearTimeout(timer);
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
