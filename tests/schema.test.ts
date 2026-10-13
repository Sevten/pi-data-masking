import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

const schema = JSON.parse(
  readFileSync(new URL("../src/config/masking.config.schema.json", import.meta.url), "utf8"),
) as object;
const validate = new Ajv2020({ allErrors: true }).compile(schema);

test("packaged example covers every rule source and matches the schema", () => {
  const example = JSON.parse(
    readFileSync(new URL("../src/config/masking.config.example.json", import.meta.url), "utf8"),
  ) as { rules: Array<Record<string, unknown>> };
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
  assert.equal(example.rules.some((rule) => typeof rule.real === "string"), true);
  assert.equal(example.rules.some((rule) => typeof rule.realFromEnv === "string"), true);
  assert.equal(example.rules.some((rule) => rule.type === "regex"), true);
});

test("JSON Schema accepts literal, environment, and regex rules", () => {
  const config = {
    $schema: "./masking.config.schema.json",
    version: 1,
    enabled: true,
    rules: [
      { id: "domain", name: "Internal domain", real: "internal.example", placeholder: "public.example", allowCommonPlaceholder: false },
      { id: "api", realFromEnv: "PROD_API_KEY", preserveStructure: { keepPrefix: true } },
      { id: "custom", type: "regex", pattern: "\\btoken_[A-Za-z0-9]{24}\\b", flags: "i" },
      { id: "github", type: "regex", pattern: "\\bghp_[A-Za-z0-9]{36}\\b", restoreScope: { destinations: ["github.com"], mode: "strict", onRefuse: "block" } },
    ],
    options: { showStatusBar: true, persistHistory: true },
  };
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test("JSON Schema rejects ambiguous sources, fixed regex placeholders, and preset references", () => {
  const invalidRules = [
    { id: "ambiguous", real: "secret-value", realFromEnv: "SECRET_VALUE" },
    { id: "regex-placeholder", type: "regex", pattern: "secret.+", placeholder: "fixed" },
    { id: "preset-ref", preset: "github-pat" },
    { id: "empty-name", name: "", real: "secret-value-9" },
  ];
  for (const rule of invalidRules) {
    assert.equal(validate({ rules: [rule] }), false, `unexpectedly accepted ${JSON.stringify(rule)}`);
  }
});

test("JSON Schema accepts a valid allowlist and rejects bad entries", () => {
  const base = { $schema: "./masking.config.schema.json", version: 1, enabled: true, rules: [] };
  assert.equal(validate({ ...base, options: { allowlist: ["10.0.0.5", "internal.example"] } }), true,
    JSON.stringify(validate.errors));
  const bad = validate({ ...base, options: { allowlist: ["ok", ""] } });
  assert.equal(bad, false);
  const nonString = validate({ ...base, options: { allowlist: [42] } });
  assert.equal(nonString, false);
});

test("JSON Schema accepts restoreScope and rejects unknown members", () => {
  const valid = {
    $schema: "./masking.config.schema.json",
    version: 1,
    enabled: true,
    rules: [
      { id: "k", type: "regex", pattern: "\\bghp_[A-Za-z0-9]{36}\\b", restoreScope: { destinations: ["github.com"], mode: "strict", onRefuse: "block" } },
      { id: "t", real: "local-secret-value", placeholder: "masked-local-value", restoreScope: { tools: ["write", "edit"], mode: "semi-strict", onRefuse: "block" } },
      { id: "e", real: "another-secret-value", placeholder: "masked-another-value", restoreScope: { envNames: ["OTHER_KEY"], mode: "strict", onRefuse: "ask" } },
      { id: "w", real: "wildcard-secret-value", placeholder: "masked-wildcard-value", restoreScope: { destinations: ["*.internal.acme.com", "10.0.*"], mode: "permissive", onRefuse: "ask" } },
    ],
    options: {},
  };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));

  const invalid = [
    { id: "x", real: "secret-value-1", restoreScope: { unknownField: true } },
    { id: "y", real: "secret-value-2", restoreScope: { mode: "yolo", onRefuse: "block" } },
    { id: "partial", real: "secret-value-5", restoreScope: { destinations: ["a.com"] } },
    { id: "partial2", real: "secret-value-6", restoreScope: { destinations: ["a.com"], mode: "strict" } },
    { id: "z", real: "secret-value-3", restoreScope: { destinations: [] } },
    { id: "w2", real: "secret-value-4", restoreScope: { destinations: ["a.*.b"] } },
  ];
  for (const rule of invalid) {
    const config = { $schema: "./masking.config.schema.json", version: 1, enabled: true, rules: [rule], options: {} };
    assert.equal(validate(config), false, `expected rejection: ${JSON.stringify(rule)}`);
  }
});
