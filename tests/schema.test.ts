import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

const schema = JSON.parse(
  readFileSync(new URL("../masking.config.schema.json", import.meta.url), "utf8"),
) as object;
const validate = new Ajv2020({ allErrors: true }).compile(schema);

test("JSON Schema accepts literal, environment, regex, and preset rules", () => {
  const config = {
    $schema: "./masking.config.schema.json",
    version: 1,
    enabled: true,
    rules: [
      { id: "domain", name: "Internal domain", real: "internal.example", placeholder: "public.example" },
      { id: "api", realFromEnv: "PROD_API_KEY", preserveStructure: { keepPrefix: true } },
      { id: "custom", type: "regex", pattern: "\\btoken_[A-Za-z0-9]{24}\\b", flags: "i" },
      { id: "github", preset: "github-pat", enabled: false },
    ],
    options: { showStatusBar: true, persistHistory: true },
  };
  assert.equal(validate(config), true, JSON.stringify(validate.errors));
});

test("JSON Schema rejects ambiguous sources, fixed regex placeholders, and unknown presets", () => {
  const invalidRules = [
    { id: "ambiguous", real: "secret-value", realFromEnv: "SECRET_VALUE" },
    { id: "regex-placeholder", type: "regex", pattern: "secret.+", placeholder: "fixed" },
    { id: "unknown", preset: "future-preset" },
    { id: "empty-name", name: "", preset: "jwt" },
  ];
  for (const rule of invalidRules) {
    assert.equal(validate({ rules: [rule] }), false, `unexpectedly accepted ${JSON.stringify(rule)}`);
  }
});
