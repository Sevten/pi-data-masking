import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig, validateRawConfigRule } from "../config-loader.ts";
import { MASKING_PRESETS } from "../presets.ts";
import { analyzeRegexSafety } from "../regex-safety.ts";

test("regex safety diagnostics find common excessive-backtracking shapes", () => {
  assert.deepEqual(
    analyzeRegexSafety("^(a+)+$").map((issue) => issue.kind),
    ["nested-repetition"],
  );
  assert.deepEqual(
    analyzeRegexSafety("^(?:.*a)*$").map((issue) => issue.kind),
    ["nested-repetition"],
  );
  assert.deepEqual(
    analyzeRegexSafety("^(foo|foobar)+$").map((issue) => issue.kind),
    ["overlapping-alternatives"],
  );
  assert.deepEqual(
    analyzeRegexSafety("^.*.*END$").map((issue) => issue.kind),
    ["adjacent-repetition"],
  );
});

test("regex safety diagnostics avoid common separated and bounded patterns", () => {
  const safePatterns = [
    "(?:\\d+\\.)+\\d+",
    "\\btoken_[A-Za-z0-9]{24}\\b",
    "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)",
    "(?:foo|bar){1,5}",
  ];
  for (const pattern of safePatterns) {
    assert.deepEqual(analyzeRegexSafety(pattern), [], pattern);
  }
  for (const preset of MASKING_PRESETS) {
    assert.deepEqual(analyzeRegexSafety(preset.pattern), [], preset.name);
  }
});

test("risky regex warnings are advisory during load and save validation", () => {
  const raw = { id: "risky", type: "regex", pattern: "^(a+)+$" };
  const loaded = validateConfig([raw]);
  assert.equal(loaded.rules.length, 1);
  assert.ok(loaded.warnings.some((warning) => warning.includes("regex risk") && warning.includes("excessive backtracking")));

  const saveWarnings = validateRawConfigRule(raw);
  assert.ok(saveWarnings.some((warning) => warning.includes("fixed upper bound")));
});
