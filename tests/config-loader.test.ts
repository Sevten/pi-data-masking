/**
 * tests/config-loader.test.ts
 * Unit tests for config loading: merge order, validation, parse errors,
 * collision-safe placeholder filling, and directory watching.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfigFromPaths, validateConfig, watchConfigPaths } from "../config-loader.ts";
import { Masker, isRegexRule } from "../masker.ts";
import { generatePlaceholder } from "../placeholder-gen.ts";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "hex");

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "masking-cfg-"));
}

test("project rules come first; options merge; project enabled wins", async () => {
  const dir = makeTmp();
  try {
    const globalPath = join(dir, "global.json");
    const projectPath = join(dir, "project.json");
    writeFileSync(globalPath, JSON.stringify({
      enabled: true,
      rules: [{ id: "g", real: "g.com", placeholder: "g.example" }],
      options: { caseSensitive: false, showStatusBar: true },
    }));
    writeFileSync(projectPath, JSON.stringify({
      enabled: false,
      rules: [{ id: "p", real: "p.com", placeholder: "p.example" }],
      options: { caseSensitive: true },
    }));
    const { config, warnings } = await loadConfigFromPaths(globalPath, projectPath, KEY);
    assert.deepEqual(config.rules.map((r) => r.id), ["p", "g"]);
    assert.equal(config.enabled, false);
    assert.equal(config.options.caseSensitive, true);
    assert.equal(config.options.showStatusBar, true);
    assert.deepEqual(warnings, []);
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
      { id: "p2", real: "other", placeholder: "auto" },
    ] }));
    const r1 = await loadConfigFromPaths(g, p, KEY);
    const r2 = await loadConfigFromPaths(g, p, KEY);
    const phOf = (r: { placeholder?: string; type?: string }) => r.placeholder ?? "";
    const ph = phOf(r1.config.rules[0] as { placeholder?: string });
    assert.notEqual(ph, "auto");
    assert.ok(ph.length > 0);
    assert.equal(phOf(r2.config.rules[0] as { placeholder?: string }), ph); // deterministic across loads
    assert.equal(phOf(r1.config.rules[1] as { placeholder?: string }), generatePlaceholder("other", KEY));
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
      { id: "a", real: "ao", placeholder: "auto" },
      { id: "b", real: "bq", placeholder: "auto" },
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
    { id: "ok", real: "x", placeholder: "auto" },
    { id: "bad", type: "regex", pattern: "(" },
    "junk",
  ]);
  assert.deepEqual(rules.map((r) => r.id), ["ok"]);
  assert.equal(warnings.length, 2);
  assert.ok(warnings[1].includes("not an object"));
  assert.deepEqual(validateConfig("nope"), { rules: [], warnings: ["config.rules is not an array; all rules were ignored"] });
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
