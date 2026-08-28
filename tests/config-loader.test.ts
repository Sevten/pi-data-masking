/**
 * tests/config-loader.test.ts
 * Unit tests for config loading: merge order, validation, parse errors,
 * collision-safe placeholder filling, and directory watching.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONFIG_SCHEMA_URL,
  buildInitialConfig,
  createInitialConfigFile,
  createJsonFileExclusive,
  ensureProjectConfigGitignored,
  generateUniqueRuleId,
  loadConfigFromPaths,
  loadPersistentToggle,
  previewConfigRuleMutations,
  previewRuleEnabledChanges,
  readRawConfigFile,
  redactRawConfigFile,
  saveConfigRuleMutations,
  savePersistentToggle,
  saveRuleEnabledChanges,
  validateConfig,
  validateRawConfigRule,
  watchConfigPaths,
} from "../config-loader.ts";
import { Masker, isRegexRule } from "../masker.ts";
import { generatePlaceholder } from "../placeholder-gen.ts";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "hex");

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "masking-cfg-"));
}

test("persistent toggle survives a fresh read and is separate from rule config", async () => {
  const dir = makeTmp();
  try {
    const statePath = join(dir, "pi-data-masking", "toggle-state.json");
    assert.equal((await loadPersistentToggle(statePath)).enabled, undefined);

    await savePersistentToggle(false, statePath);
    assert.deepEqual(await loadPersistentToggle(statePath), { enabled: false });

    await savePersistentToggle(true, statePath);
    assert.deepEqual(await loadPersistentToggle(statePath), { enabled: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project rules come first; options merge; project enabled wins", async () => {
  const dir = makeTmp();
  try {
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeFileSync(globalPath, JSON.stringify({
      enabled: true,
      rules: [{ id: "g", real: "g.example.com", placeholder: "g.example.net" }],
      options: { caseSensitive: false, showStatusBar: true },
    }));
    writeFileSync(projectPath, JSON.stringify({
      enabled: false,
      rules: [{ id: "p", real: "p.example.com", placeholder: "p.example.net" }],
      options: { caseSensitive: true, systemPromptGuidance: true },
    }));
    const { config, warnings } = await loadConfigFromPaths(globalPath, projectPath, KEY);
    assert.deepEqual(config.rules.map((r) => r.id), ["p", "g"]);
    assert.equal(config.enabled, false);
    assert.equal(config.options.caseSensitive, true);
    assert.equal(config.options.showStatusBar, true);
    assert.equal(config.options.systemPromptGuidance, true);
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rule IDs are unique per file but may repeat across project and global scopes", async () => {
  const dir = makeTmp();
  try {
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeFileSync(globalPath, JSON.stringify({ rules: [
      { id: "shared-name", real: "global-secret-value" },
      { id: "shared-name", preset: "jwt" },
    ] }));
    writeFileSync(projectPath, JSON.stringify({ rules: [
      { id: "shared-name", preset: "github-pat" },
    ] }));

    const { config, warnings } = await loadConfigFromPaths(globalPath, projectPath, KEY);
    assert.deepEqual(
      config.configuredRules.map(({ rule, scope }) => ({ id: rule.id, scope })),
      [
        { id: "shared-name", scope: "project" },
        { id: "shared-name", scope: "global" },
      ],
    );
    assert.ok(warnings.some((warning) => warning.includes("global") && warning.includes("duplicates an earlier ID")));
    assert.equal(warnings.some((warning) => warning.includes("project") && warning.includes("duplicates")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rule names are optional while generated IDs are readable and collision-free", () => {
  assert.equal(generateUniqueRuleId("Production API Key", []), "production-api-key");
  assert.equal(
    generateUniqueRuleId("Production API Key", ["production-api-key", "production-api-key-2"]),
    "production-api-key-3",
  );
  assert.equal(generateUniqueRuleId("私有 IP 地址", []), "私有-ip-地址");

  const legacy = validateConfig([{ id: "legacy", real: "legacy-secret" }]);
  assert.equal(legacy.rules[0]!.name, undefined);
  const named = validateConfig([{ id: "named", name: "Readable name", preset: "jwt" }]);
  assert.equal(named.rules[0]!.name, "Readable name");
  assert.ok(validateConfig([{ id: "bad-name", name: " ", preset: "jwt" }]).warnings.some(
    (warning) => warning.includes("invalid 'name'"),
  ));
});

test("per-rule enabled defaults on while disabled rules stay configured but inactive", async () => {
  const dir = makeTmp();
  try {
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeFileSync(globalPath, JSON.stringify({ rules: [
      { id: "global-off", enabled: false, real: "global-secret", placeholder: "auto" },
    ] }));
    writeFileSync(projectPath, JSON.stringify({ rules: [
      { id: "project-on", enabled: true, type: "regex", pattern: "token-[a-z]{8}" },
      { id: "project-default", real: "project-secret", placeholder: "auto" },
    ] }));

    const { config, warnings } = await loadConfigFromPaths(globalPath, projectPath, KEY);
    assert.deepEqual(warnings, []);
    assert.deepEqual(config.rules.map((rule) => rule.id), ["project-on", "project-default"]);
    assert.deepEqual(
      config.configuredRules.map(({ rule, scope, sourceIndex, enabled }) => ({
        id: rule.id,
        scope,
        sourceIndex,
        enabled,
      })),
      [
        { id: "project-on", scope: "project", sourceIndex: 0, enabled: true },
        { id: "project-default", scope: "project", sourceIndex: 1, enabled: true },
        { id: "global-off", scope: "global", sourceIndex: 0, enabled: false },
      ],
    );
    const disabled = config.configuredRules[2]!.rule as { placeholder?: string };
    assert.equal(disabled.placeholder, "auto", "disabled literals must not generate or reserve placeholders");
    assert.equal(config.configuredRules[0]!.placeholderMode, undefined);
    assert.equal(config.configuredRules[1]!.placeholderMode, "auto");
    assert.equal(config.configuredRules[2]!.placeholderMode, "auto");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid per-rule enabled is warned and never activated", async () => {
  const dir = makeTmp();
  try {
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeFileSync(globalPath, JSON.stringify({ rules: [
      { id: "bad-state", enabled: "yes", real: "global-secret" },
    ] }));
    writeFileSync(projectPath, JSON.stringify({ rules: [] }));

    const { config, warnings } = await loadConfigFromPaths(globalPath, projectPath, KEY);
    assert.deepEqual(config.rules, []);
    assert.deepEqual(config.configuredRules, []);
    assert.ok(warnings.some((warning) => warning.includes("invalid 'enabled'")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid disabled rules keep their disabled-state context in load warnings", async () => {
  const dir = makeTmp();
  try {
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeFileSync(globalPath, JSON.stringify({ rules: [
      { id: "disabled-broken", enabled: false, type: "regex", pattern: "(" },
    ] }));
    writeFileSync(projectPath, JSON.stringify({ rules: [] }));

    const { config, warnings } = await loadConfigFromPaths(globalPath, projectPath, KEY);
    assert.deepEqual(config.rules, []);
    assert.ok(warnings.some((warning) =>
      warning.includes("disabled-broken")
      && warning.includes("invalid regex")
      && warning.includes("currently disabled")
    ));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preset references expand in place while unknown presets stay inactive", async () => {
  const dir = makeTmp();
  try {
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeFileSync(globalPath, JSON.stringify({ rules: [] }));
    writeFileSync(projectPath, JSON.stringify({ rules: [
      { id: "github", preset: "github-pat" },
      { id: "private", preset: "private-ipv4", preserveStructure: { keepIPv4Octets: 1 } },
      { id: "future", preset: "does-not-exist" },
    ] }));

    const { config, warnings } = await loadConfigFromPaths(globalPath, projectPath, KEY);
    assert.deepEqual(config.rules.map((rule) => rule.id), ["github", "private"]);
    assert.deepEqual(config.configuredRules.map(({ sourceKind, presetName }) => ({ sourceKind, presetName })), [
      { sourceKind: "preset", presetName: "github-pat" },
      { sourceKind: "preset", presetName: "private-ipv4" },
    ]);
    assert.equal((config.rules[1]!.preserveStructure?.keepIPv4Octets), 1);
    assert.ok(warnings.some((warning) => warning.includes("unknown preset")));

    const masker = new Masker(config.rules, true, KEY);
    assert.equal(masker.mask("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").count, 1);
    const ipResult = masker.mask("valid=10.1.2.3 invalid=10.999.2.3");
    assert.equal(ipResult.count, 1);
    assert.ok(ipResult.text.includes("10.999.2.3"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("realFromEnv resolves only in memory and missing/conflicting sources stay inactive", async () => {
  const dir = makeTmp();
  try {
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeFileSync(globalPath, JSON.stringify({ rules: [] }));
    writeFileSync(projectPath, JSON.stringify({ rules: [
      { id: "from-env", realFromEnv: "PROD_API_KEY", placeholder: "auto" },
      { id: "missing", realFromEnv: "MISSING_API_KEY" },
      { id: "conflict", real: "literal-secret", realFromEnv: "PROD_API_KEY" },
    ] }));

    const secret = "sk-prod-super-secret";
    const { config, warnings } = await loadConfigFromPaths(
      globalPath,
      projectPath,
      KEY,
      { PROD_API_KEY: secret, MISSING_API_KEY: "" },
    );
    assert.deepEqual(config.rules.map((rule) => rule.id), ["from-env"]);
    assert.equal(config.configuredRules[0]!.realFromEnv, "PROD_API_KEY");
    assert.equal(config.configuredRules[0]!.placeholderMode, "auto");
    assert.equal(config.configuredRules[0]!.available, true);
    assert.equal(config.configuredRules[1]!.rule.id, "missing");
    assert.equal(config.configuredRules[1]!.available, false);
    assert.equal((config.configuredRules[1]!.rule as { real: string }).real, "");
    assert.equal((config.rules[0] as { real: string }).real, secret);
    assert.ok(warnings.some((warning) => warning.includes("MISSING_API_KEY") && warning.includes("missing or empty")));
    assert.ok(warnings.some((warning) => warning.includes("both 'real' and 'realFromEnv'")));
    assert.ok(warnings.every((warning) => !warning.includes(secret)));
    assert.equal(readFileSync(projectPath, "utf8").includes(secret), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("initializer builds a minimal preset config, refuses overwrite, and can update .gitignore", async () => {
  const dir = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "masking-init-"));
  try {
    const path = join(dir, ".pi", "pi-data-masking", "masking.config.json");
    const initial = buildInitialConfig(["github-pat", "private-ipv4", "github-pat"], {
      showStatusBar: false,
      persistHistory: true,
    });
    assert.equal(initial.$schema, CONFIG_SCHEMA_URL);
    assert.deepEqual(initial.rules.map((rule) => rule.preset), ["github-pat", "private-ipv4"]);
    assert.deepEqual(initial.rules.map((rule) => rule.name), ["GitHub personal access token", "Private IPv4 address"]);
    assert.equal(initial.options.showStatusBar, false);

    await createInitialConfigFile(path, initial);
    const before = readFileSync(path, "utf8");
    assert.deepEqual(JSON.parse(before), initial);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    await assert.rejects(createInitialConfigFile(path, buildInitialConfig([])), /already exists/);
    assert.equal(readFileSync(path, "utf8"), before);

    assert.equal(await ensureProjectConfigGitignored(dir), true);
    assert.equal(await ensureProjectConfigGitignored(dir), false);
    assert.equal(
      readFileSync(join(dir, ".gitignore"), "utf8"),
      ".pi/pi-data-masking/masking.config.json\n",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveRuleEnabledChanges updates exact source entries atomically with mode 0600", async () => {
  // node:os tmpdir may point at a permissionless Windows mount under WSL.
  const dir = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "masking-cfg-"));
  try {
    const path = join(dir, "masking.config.json");
    writeFileSync(path, JSON.stringify({
      customTopLevelField: "preserved",
      rules: [
        { id: "first", real: "first-secret" },
        { id: "second", enabled: false, type: "regex", pattern: "token-[a-z]+" },
      ],
    }), { mode: 0o644 });

    await saveRuleEnabledChanges([
      { path, sourceIndex: 0, id: "first", enabled: false },
      { path, sourceIndex: 1, id: "second", enabled: true },
    ]);

    const saved = JSON.parse(readFileSync(path, "utf8")) as {
      customTopLevelField: string;
      rules: Array<{ id: string; enabled?: boolean }>;
    };
    assert.equal(saved.customTopLevelField, "preserved");
    assert.deepEqual(saved.rules.map(({ id, enabled }) => ({ id, enabled })), [
      { id: "first", enabled: false },
      { id: "second", enabled: true },
    ]);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);

    const beforeMismatch = readFileSync(path, "utf8");
    await assert.rejects(
      saveRuleEnabledChanges([{ path, sourceIndex: 0, id: "wrong-id", enabled: true }]),
      /source position now contains/,
    );
    assert.equal(readFileSync(path, "utf8"), beforeMismatch);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rule change previews stage candidate sources without writing files", async () => {
  const dir = makeTmp();
  try {
    const path = join(dir, "masking.config.json");
    writeFileSync(path, JSON.stringify({
      custom: true,
      rules: [{ id: "token", real: "secret-token-value" }],
    }));
    const before = readFileSync(path, "utf8");

    const toggled = await previewRuleEnabledChanges([
      { path, sourceIndex: 0, id: "token", enabled: false },
    ]);
    assert.equal(toggled.sources[0]!.data.rules[0]!.enabled, false);
    assert.equal(readFileSync(path, "utf8"), before);

    const edited = await previewConfigRuleMutations([{
      kind: "replace",
      path,
      sourceIndex: 0,
      id: "token",
      rule: { id: "token", real: "rotated-secret-value" },
    }]);
    assert.equal(edited.sources[0]!.data.rules[0]!.real, "rotated-secret-value");
    assert.equal(edited.sources[0]!.data.custom, true);
    assert.equal(readFileSync(path, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("structural rule mutations validate targets and preserve unrelated config fields", async () => {
  const dir = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "masking-edit-"));
  try {
    const path = join(dir, "masking.config.json");
    writeFileSync(path, JSON.stringify({
      custom: { preserved: true },
      rules: [
        { id: "a", real: "first-secret" },
        { id: "b", type: "regex", pattern: "token-[a-z]{8}" },
      ],
    }));

    await saveConfigRuleMutations([{ kind: "append", path, rule: { id: "c", preset: "github-pat" } }]);
    await saveConfigRuleMutations([{
      kind: "replace",
      path,
      sourceIndex: 0,
      id: "a",
      rule: { id: "a-renamed", realFromEnv: "EDIT_TEST_SECRET" },
    }]);
    await saveConfigRuleMutations([{
      kind: "move",
      path,
      sourceIndex: 2,
      id: "c",
      targetIndex: 1,
      targetId: "b",
    }]);
    await saveConfigRuleMutations([{ kind: "delete", path, sourceIndex: 2, id: "b" }]);

    const saved = await readRawConfigFile(path);
    assert.deepEqual(saved.custom, { preserved: true });
    assert.deepEqual(saved.rules.map((rule) => rule.id), ["a-renamed", "c"]);

    const targetPath = join(dir, "global.config.json");
    writeFileSync(targetPath, JSON.stringify({ targetCustom: true, rules: [{ id: "z", real: "target-secret" }] }));
    await saveConfigRuleMutations([
      { kind: "delete", path, sourceIndex: 0, id: "a-renamed" },
      { kind: "append", path: targetPath, rule: { id: "a-renamed", realFromEnv: "EDIT_TEST_SECRET" } },
    ]);
    assert.deepEqual((await readRawConfigFile(path)).rules.map((rule) => rule.id), ["c"]);
    const movedTarget = await readRawConfigFile(targetPath);
    assert.equal(movedTarget.targetCustom, true);
    assert.deepEqual(movedTarget.rules.map((rule) => rule.id), ["z", "a-renamed"]);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    await assert.rejects(
      saveConfigRuleMutations([{ kind: "delete", path, sourceIndex: 0, id: "stale" }]),
      /source position changed/,
    );
    await assert.rejects(
      saveConfigRuleMutations([{ kind: "append", path, rule: { id: "c", preset: "jwt" } }]),
      /ID already exists/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-file structural mutations roll back every file when a later publish fails", async () => {
  const dir = makeTmp();
  try {
    const projectPath = join(dir, "project.json");
    const globalPath = join(dir, "global.json");
    writeFileSync(projectPath, JSON.stringify({ rules: [{ id: "move-me", real: "project-secret-value" }] }));
    writeFileSync(globalPath, JSON.stringify({ rules: [{ id: "keep", real: "global-secret-value" }] }));
    const beforeProject = readFileSync(projectPath, "utf8");
    const beforeGlobal = readFileSync(globalPath, "utf8");

    await assert.rejects(
      saveConfigRuleMutations([
        { kind: "delete", path: projectPath, sourceIndex: 0, id: "move-me" },
        { kind: "append", path: globalPath, rule: { id: "move-me", real: "project-secret-value" } },
      ], {
        beforePublish: (_path, index) => {
          if (index === 1) throw new Error("simulated second-file publish failure");
        },
      }),
      /simulated second-file publish failure/,
    );

    assert.equal(readFileSync(projectPath, "utf8"), beforeProject);
    assert.equal(readFileSync(globalPath, "utf8"), beforeGlobal);
    assert.equal(readdirSync(dir).some((name) => name.endsWith(".tmp") || name.endsWith(".bak")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redacted exports hide literals and are created without overwrite", async () => {
  const dir = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "masking-export-"));
  try {
    const source = join(dir, "source.json");
    const destination = join(dir, "export.json");
    const secret = "literal-value-that-must-not-leak";
    writeFileSync(source, JSON.stringify({ rules: [
      { id: "literal", real: secret },
      { id: "env", realFromEnv: "PROD_API_KEY" },
    ] }));
    const redacted = redactRawConfigFile(await readRawConfigFile(source));
    assert.equal(JSON.stringify(redacted).includes(secret), false);
    assert.equal(redacted.rules[0]!.real, "<redacted-literal-value>");
    assert.equal(redacted.rules[1]!.realFromEnv, "PROD_API_KEY");
    assert.ok(redacted._redactedExport);

    await createJsonFileExclusive(destination, redacted);
    const before = readFileSync(destination, "utf8");
    assert.equal(before.includes(secret), false);
    await assert.rejects(createJsonFileExclusive(destination, {}), /already exists/);
    assert.equal(readFileSync(destination, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto placeholders are deterministic and shared per real value", async () => {
  const dir = makeTmp();
  try {
    const g = join(dir, "g.json");
    const p = join(dir, "p.json");
    writeFileSync(g, JSON.stringify({ rules: [{ id: "g1", real: "token-abc", placeholder: "auto" }] }));
    writeFileSync(p, JSON.stringify({ rules: [
      { id: "p1", real: "token-abc", placeholder: "auto" },
      { id: "p2", real: "other-value", placeholder: "auto" },
    ] }));
    const r1 = await loadConfigFromPaths(g, p, KEY);
    const r2 = await loadConfigFromPaths(g, p, KEY);
    const phOf = (r: { placeholder?: string; type?: string }) => r.placeholder ?? "";
    const ph = phOf(r1.config.rules[0] as { placeholder?: string });
    assert.notEqual(ph, "auto");
    assert.ok(ph.length > 0);
    assert.equal(phOf(r2.config.rules[0] as { placeholder?: string }), ph); // deterministic across loads
    assert.equal(phOf(r1.config.rules[1] as { placeholder?: string }), generatePlaceholder("other-value", KEY));
    assert.equal(phOf(r1.config.rules[2] as { placeholder?: string }), ph); // same real as p1 shares one placeholder
    assert.deepEqual(r1.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("literal placeholder collision is resolved (ao/bq regression)", async () => {
  const dir = makeTmp();
  try {
    const g = join(dir, "g.json");
    const p = join(dir, "p.json");
    writeFileSync(g, JSON.stringify({}));
    writeFileSync(p, JSON.stringify({ rules: [
      { id: "a", real: "ao", placeholder: "auto", lowEntropy: true },
      { id: "b", real: "bq", placeholder: "auto", lowEntropy: true },
    ] }));
    const { config, warnings } = await loadConfigFromPaths(g, p, KEY);
    const literalPh = (r: { id: string; real?: string; placeholder?: string; type?: string }) => r.placeholder ?? "";
    const [pa, pb] = config.rules.map((r) => literalPh(r as { id: string; placeholder?: string; type?: string }));
    assert.notEqual(pa, pb);
    assert.deepEqual(warnings, []);
    const m = new Masker(config.rules, true, KEY);
    const masked = m.mask("first=ao second=bq");
    assert.equal(m.unmask(masked.text).text, "first=ao second=bq");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid JSON produces a warning instead of silent failure", async () => {
  const dir = makeTmp();
  try {
    const g = join(dir, "g.json");
    const p = join(dir, "p.json");
    writeFileSync(g, "{ not json");
    writeFileSync(p, JSON.stringify({ rules: [] }));
    const { config, warnings } = await loadConfigFromPaths(g, p, KEY);
    assert.equal(config.enabled, true);
    assert.ok(warnings.some((w) => w.includes("Failed to read/parse")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reload keeps the last valid source when a config is temporarily invalid", async () => {
  const dir = makeTmp();
  try {
    const g = join(dir, "g.json");
    const p = join(dir, "p.json");
    writeFileSync(g, JSON.stringify({ rules: [{ id: "global", real: "global-secret-value" }] }));
    writeFileSync(p, JSON.stringify({ rules: [{ id: "project", real: "project-secret-value" }] }));
    const first = await loadConfigFromPaths(g, p, KEY);

    writeFileSync(p, "{ temporarily invalid");
    const fallback = await loadConfigFromPaths(g, p, KEY, process.env, first.snapshot);
    assert.deepEqual(fallback.config.rules.map((rule) => rule.id), ["project", "global"]);
    assert.ok(fallback.warnings.some((warning) => warning.includes("last valid project config")));

    writeFileSync(p, JSON.stringify({ rules: [{ id: "repaired", real: "repaired-secret-value" }] }));
    const repaired = await loadConfigFromPaths(g, p, KEY, process.env, fallback.snapshot);
    assert.deepEqual(repaired.config.rules.map((rule) => rule.id), ["repaired", "global"]);

    writeFileSync(p, JSON.stringify({ rules: "not-an-array" }));
    const shapeFallback = await loadConfigFromPaths(g, p, KEY, process.env, repaired.snapshot);
    assert.deepEqual(shapeFallback.config.rules.map((rule) => rule.id), ["repaired", "global"]);
    assert.ok(shapeFallback.warnings.some((warning) => warning.includes("project config.rules is not an array")
      && warning.includes("last valid project config")));

    rmSync(p);
    const deleted = await loadConfigFromPaths(g, p, KEY, process.env, shapeFallback.snapshot);
    assert.deepEqual(deleted.config.rules.map((rule) => rule.id), ["global"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid rules are skipped with warnings; valid ones survive", async () => {
  const dir = makeTmp();
  try {
    const g = join(dir, "g.json");
    const p = join(dir, "p.json");
    writeFileSync(g, JSON.stringify({ rules: [
      { id: "", real: "x" },
      { id: "bad-regex", type: "regex", pattern: "(" },
      { id: "no-real", placeholder: "auto" },
      { id: "bad-ph", real: "y", placeholder: "" },
      { id: "unknown-type", type: "weird", real: "z" },
      { id: "ok", real: "good.com", placeholder: "fine.example" },
    ] }));
    writeFileSync(p, JSON.stringify({ rules: "nope" }));
    const { config, warnings } = await loadConfigFromPaths(g, p, KEY);
    assert.deepEqual(config.rules.map((r) => r.id), ["ok"]);
    assert.ok(warnings.some((w) => w.includes("missing a non-empty 'id'")));
    assert.ok(warnings.some((w) => w.includes("invalid regex")));
    assert.ok(warnings.some((w) => w.includes("no 'real' value")));
    assert.ok(warnings.some((w) => w.includes("invalid placeholder")));
    assert.ok(warnings.some((w) => w.includes("unknown type")));
    assert.ok(warnings.some((w) => w.includes("project config.rules is not an array")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateConfig returns invalid-rule warnings and keeps valid rules", () => {
  const { rules, warnings } = validateConfig([
    { id: "ok", real: "x", placeholder: "auto", lowEntropy: true },
    { id: "bad", type: "regex", pattern: "(" },
    "junk",
  ]);
  assert.deepEqual(rules.map((r) => r.id), ["ok"]);
  assert.equal(warnings.length, 2);
  assert.ok(warnings[1].includes("not an object"));
  assert.deepEqual(validateConfig("nope"), { rules: [], warnings: ["config.rules is not an array; all rules were ignored"] });
});

test("low-entropy values produce warnings; lowEntropy:true silences them", () => {
  const short = validateConfig([{ id: "s", real: "abc", placeholder: "auto" }]);
  assert.equal(short.warnings.length, 1);
  assert.ok(short.warnings[0].includes("low entropy"));
  assert.equal(short.rules.length, 1);

  const silenced = validateConfig([{ id: "s", real: "abc", placeholder: "auto", lowEntropy: true }]);
  assert.deepEqual(silenced.warnings, []);
});

test("exact literal mutations support custom placeholders and warn about no-op replacements", () => {
  assert.deepEqual(validateRawConfigRule({
    id: "custom-placeholder",
    name: "Custom placeholder",
    real: "internal.example",
    placeholder: "public.example",
  }), []);
  assert.ok(validateRawConfigRule({
    id: "no-op",
    real: "same-secret-value",
    placeholder: "same-secret-value",
  }).some((warning) => warning.includes("rule has no effect")));
});

test("regex patterns that can only match short values warn; real shapes don't", () => {
  // 4-digit code: max match length 4 → warning
  const code = validateConfig([{ id: "code", type: "regex", pattern: "\\b\\d{4}\\b" }]);
  assert.equal(code.warnings.length, 1);
  assert.ok(code.warnings[0].includes("at most 4 character(s)"));

  const silenced = validateConfig([
    { id: "code", type: "regex", pattern: "\\b\\d{4}\\b", lowEntropy: true },
  ]);
  assert.deepEqual(silenced.warnings, []);

  // US phone pattern: contains \d{3}/\d{4} groups but the overall match is
  // long — must not warn (false-positive guard)
  const phone = validateConfig([{
    id: "phone",
    type: "regex",
    pattern: "\\b(?:\\+?1[-. ]?)?\\(?[2-9]\\d{2}\\)?[-. ]?\\d{3}[-. ]?\\d{4}\\b",
  }]);
  assert.deepEqual(phone.warnings, []);

  // unbounded patterns never warn
  const unbounded = validateConfig([{ id: "t", type: "regex", pattern: "[A-Za-z0-9._-]+" }]);
  assert.deepEqual(unbounded.warnings, []);
});

test("preserveStructure is honored when filling literal placeholders", async () => {
  const dir = makeTmp();
  try {
    const g = join(dir, "g.json");
    const p = join(dir, "p.json");
    writeFileSync(g, JSON.stringify({}));
    writeFileSync(p, JSON.stringify({ rules: [
      { id: "key", real: "prod-api-key-9f3k2", placeholder: "auto", preserveStructure: { keepPrefix: true } },
      { id: "ip", real: "192.168.10.7", placeholder: "auto", preserveStructure: { keepIPv4Octets: 2 } },
    ] }));
    const { config, warnings } = await loadConfigFromPaths(g, p, KEY);
    assert.deepEqual(warnings, []);
    const [keyRule, ipRule] = config.rules as Array<{ id: string; placeholder: string }>;
    // keepPrefix keeps only the FIRST segment (up to the first separator):
    // "prod-api-key-9f3k2" → "prod-" + randomized body
    assert.ok(keyRule.placeholder.startsWith("prod-"), keyRule.placeholder);
    assert.ok(ipRule.placeholder.startsWith("192.168."), ipRule.placeholder);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history persistence defaults on while system-prompt guidance defaults off", async () => {
  const dir = makeTmp();
  try {
    const g = join(dir, "g.json");
    const p = join(dir, "p.json");
    writeFileSync(g, JSON.stringify({}));
    writeFileSync(p, JSON.stringify({ rules: [] }));
    const { config } = await loadConfigFromPaths(g, p, KEY);
    assert.equal(config.options.systemPromptGuidance, false);
    assert.equal(config.options.persistHistory, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchConfigPaths fires when the config file is created after start", async () => {
  const dir = makeTmp();
  try {
    const configDir = join(dir, ".pi", "pi-data-masking");
    const projectPath = join(configDir, "masking.config.json");
    const globalPath = join(dir, "global.json"); // never exists
    mkdirSync(configDir, { recursive: true });

    let fired = 0;
    const stop = watchConfigPaths(globalPath, projectPath, () => { fired++; });
    writeFileSync(projectPath, JSON.stringify({ rules: [] }));

    const deadline = Date.now() + 2000;
    while (fired === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    stop();
    assert.ok(fired >= 1, "onChange should fire after config file creation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchConfigPaths is safe when neither file nor directory exists", () => {
  const dir = makeTmp();
  try {
    const missing = join(dir, "does-not-exist", "pi-data-masking", "masking.config.json");
    let fired = 0;
    const stop = watchConfigPaths(missing, join(dir, "other-missing.json"), () => { fired++; });
    stop();
    assert.equal(fired, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
