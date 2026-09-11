/**
 * tests/guidance.test.ts
 * Unit tests for the guidance note: three-state composition, the disclosure
 * inheritance matrix, loader auto-correction, and Hook-6-style re-masking
 * idempotence over the note itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  composeGuidanceNote,
  guidanceDisclosureEntries,
  guidanceNoteForConfig,
  type GuidanceDisclosureEntry,
} from "../guidance.ts";
import { loadConfigFromPaths, type ConfiguredMaskingRule, type MaskingConfig } from "../config-loader.ts";
import { Masker } from "../masker.ts";
import { generateSessionKey } from "../placeholder-gen.ts";
import { decideGuidanceNotice, markGuidanceNoticeShown, GUIDANCE_NOTICE_VERSION } from "../migration.ts";

const KEY = generateSessionKey();

function configuredRule(overrides: Partial<ConfiguredMaskingRule> & { placeholder?: string; ruleOverrides?: Record<string, unknown> } = {}): ConfiguredMaskingRule {
  const { ruleOverrides, placeholder, ...rest } = overrides;
  return {
    rule: {
      id: "r1",
      real: "real-secret-value-123456",
      placeholder: placeholder ?? "placeholder-xyz-123456",
      ...(ruleOverrides ?? {}),
    } as ConfiguredMaskingRule["rule"],
    scope: "global",
    path: "/tmp/config.json",
    sourceIndex: 0,
    enabled: true,
    available: true,
    sourceKind: "literal",
    placeholderMode: "auto",
    ...rest,
  };
}

function config(overrides: Partial<MaskingConfig> & {
  guidance?: boolean;
  discloseGlobal?: boolean;
} = {}): MaskingConfig {
  const configuredRules = overrides.configuredRules ?? [configuredRule()];
  return {
    enabled: true,
    rules: configuredRules.filter((c) => c.enabled && c.available).map((c) => c.rule),
    configuredRules,
    options: {
      caseSensitive: true,
      showStatusBar: true,
      systemPromptGuidance: overrides.guidance ?? true,
      disclosePlaceholders: overrides.discloseGlobal ?? false,
      persistHistory: true,
    },
  };
}

test("guidance-only form contains no list-oriented phrasing", () => {
  const note = guidanceNoteForConfig(config({ guidance: true, discloseGlobal: false }))!;
  assert.ok(note.startsWith("[Data-masking note]"));
  assert.ok(note.includes("Some values in this conversation are synthetic placeholders"));
  assert.ok(!note.includes("The following strings"));
  assert.ok(!note.includes("Generated substitutes"));
  assert.ok(!note.includes("Custom substitutes"));
  assert.ok(!note.includes("- "));
});

test("full form emits the disclosure block atomically with grouped entries", () => {
  const entries: GuidanceDisclosureEntry[] = [
    { placeholder: "sk-generated-1", custom: false },
    { placeholder: "FIXEDPRODTOKEN", custom: true },
    { placeholder: "generated-2", custom: false },
  ];
  const note = composeGuidanceNote(entries);
  assert.ok(note.includes("The following strings are placeholders (this list may not be exhaustive):"));
  const generatedIdx = note.indexOf("Generated substitutes (structure preserved):");
  const customIdx = note.indexOf("Custom substitutes (structure not preserved):");
  const firstEntry = note.indexOf("- sk-generated-1");
  assert.ok(generatedIdx > 0 && customIdx > generatedIdx && firstEntry > generatedIdx);
  assert.ok(note.indexOf("- generated-2") < customIdx);
  assert.ok(note.includes("- FIXEDPRODTOKEN"));
  // Trust sentence and contract are present in both forms.
  assert.ok(note.includes("Generated placeholders preserve length,"));
  assert.ok(note.includes("Never request the original values."));
});

test("duplicate placeholders are deduplicated across rules", () => {
  const note = composeGuidanceNote([
    { placeholder: "same-placeholder", custom: false },
    { placeholder: "same-placeholder", custom: false },
  ]);
  assert.equal(note.split("same-placeholder").length - 1, 1);
});

test("inheritance matrix: global × rule override", () => {
  // false / unset → no
  assert.deepEqual(guidanceDisclosureEntries(config({ discloseGlobal: false })), []);
  // false / true → yes
  const overrideTrue = configuredRule({ ruleOverrides: { disclosePlaceholder: true } });
  assert.equal(guidanceDisclosureEntries(config({ configuredRules: [overrideTrue] })).length, 1);
  // true / unset → yes
  assert.equal(guidanceDisclosureEntries(config({ discloseGlobal: true })).length, 1);
  // true / false → no
  const overrideFalse = configuredRule({ ruleOverrides: { disclosePlaceholder: false } });
  assert.deepEqual(guidanceDisclosureEntries(config({ discloseGlobal: true, configuredRules: [overrideFalse] })), []);
});

test("WAIT-state and regex rules never appear in the disclosure list", () => {
  const waitRule = configuredRule({ available: false, placeholder: "auto" });
  const regexRule = configuredRule({
    sourceKind: "regex",
    placeholderMode: undefined,
    ruleOverrides: { type: "regex", pattern: "x+" },
  });
  assert.deepEqual(guidanceDisclosureEntries(config({ discloseGlobal: true, configuredRules: [waitRule, regexRule] })), []);
});

test("custom placeholders land in the custom group", () => {
  const custom = configuredRule({ placeholderMode: "custom", placeholder: "FIXEDPRODTOKEN" });
  const note = guidanceNoteForConfig(config({ discloseGlobal: true, configuredRules: [custom] }))!;
  assert.ok(note.includes("Custom substitutes (structure not preserved):"));
  assert.ok(!note.includes("Generated substitutes"));
});

test("disabled rules and guidance-off produce no note or entries", () => {
  assert.equal(guidanceNoteForConfig(config({ guidance: false, discloseGlobal: true })), null);
  const disabled = configuredRule({ enabled: false });
  assert.deepEqual(guidanceDisclosureEntries(config({ discloseGlobal: true, configuredRules: [disabled] })), []);
});

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "masking-guidance-"));
}

async function loadFromFiles(
  dir: string,
  rules: unknown[],
  options: Record<string, unknown> = {},
): Promise<{ config: MaskingConfig; warnings: string[] }> {
  const globalPath = join(dir, "global.json");
  writeFileSync(globalPath, JSON.stringify({
    version: 1,
    enabled: true,
    rules,
    options: { systemPromptGuidance: true, ...options },
  }));
  const loaded = await loadConfigFromPaths(globalPath, join(dir, "project.json"), KEY);
  return { config: loaded.config, warnings: loaded.warnings };
}

test("loader auto-corrects disclosure without guidance and warns", async () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, "global.json"), JSON.stringify({
      version: 1,
      enabled: true,
      rules: [{ id: "k", real: "real-secret-value-123456" }],
      options: { systemPromptGuidance: false, disclosePlaceholders: true },
    }));
    const loaded = await loadConfigFromPaths(join(dir, "global.json"), join(dir, "project.json"), KEY);
    assert.equal(loaded.config.options.systemPromptGuidance, true);
    assert.ok(loaded.warnings.some((warning) => warning.includes("disclosePlaceholders")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regex rules with disclosePlaceholder are rejected; literal values survive end to end", async () => {
  const dir = makeTmp();
  try {
    const rejected = await loadFromFiles(dir, [{ id: "rx", type: "regex", pattern: "\\btoken_[A-Za-z0-9]{8,}\\b", disclosePlaceholder: true }], { disclosePlaceholders: true });
    assert.equal(rejected.config.configuredRules.length, 0);
    assert.ok(rejected.warnings.some((w) => w.includes("disclosePlaceholder")));

    const accepted = await loadFromFiles(dir, [
      { id: "k", real: "real-secret-value-123456", placeholder: "FIXEDPRODTOKEN" },
      { id: "k2", realFromEnv: "PROD_API_KEY_MISSING" },
    ], { disclosePlaceholders: true });
    const note = guidanceNoteForConfig(accepted.config)!;
    assert.ok(note.includes("- FIXEDPRODTOKEN"));
    assert.ok(note.includes("Custom substitutes (structure not preserved):"));
    // WAIT-state env rule contributes no entry and no empty group heading.
    assert.ok(!note.includes("Generated substitutes"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("note with embedded placeholders survives Hook-6-style re-masking unchanged", () => {
  const rules = [{ id: "k", real: "real-secret-value-123456", placeholder: "FIXEDPRODTOKEN" }];
  const masker = new Masker(rules as never, true, KEY, new Map(), new Set(), new Set());
  const note = composeGuidanceNote([{ placeholder: "FIXEDPRODTOKEN", custom: true }]);
  const first = masker.maskValue(note).value;
  const second = masker.maskValue(first).value;
  assert.equal(first, note);
  assert.equal(second, note);
});

test("note text containing a real value is masked by the safety net", () => {
  const rules = [{ id: "k", real: "real-secret-value-123456", placeholder: "FIXEDPRODTOKEN" }];
  const masker = new Masker(rules as never, true, KEY, new Map(), new Set(), new Set());
  const contaminated = `preamble real-secret-value-123456 tail\n- FIXEDPRODTOKEN`;
  const masked = masker.maskValue(contaminated).value as string;
  assert.ok(!masked.includes("real-secret-value-123456"));
  assert.ok(masked.includes("FIXEDPRODTOKEN"));
});

test("migration notice fires once and only for existing-config users", () => {
  assert.deepEqual(decideGuidanceNotice({}, true).pending, true);
  assert.deepEqual(decideGuidanceNotice({}, false).pending, false);
  const shown = markGuidanceNoticeShown({});
  assert.equal(shown.guidanceNoticeVersion, GUIDANCE_NOTICE_VERSION);
  assert.deepEqual(decideGuidanceNotice(shown, true).pending, false);
});

test("composed note is deterministic within a session", () => {
  const cfg = config({ discloseGlobal: true });
  assert.equal(guidanceNoteForConfig(cfg), guidanceNoteForConfig(cfg));
});
