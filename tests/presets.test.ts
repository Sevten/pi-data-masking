import assert from "node:assert/strict";
import test from "node:test";
import { MASKING_PRESETS, expandMaskingPreset } from "../presets.ts";

test("preset examples match their documented regular expressions", () => {
  for (const preset of MASKING_PRESETS) {
    const regex = new RegExp(preset.pattern, preset.flags ?? "");
    assert.match(preset.example, regex, `${preset.name} example must match its pattern`);
  }
});

test("preset defaults use readable labels and descriptions with examples", () => {
  for (const preset of MASKING_PRESETS) {
    assert.notEqual(preset.label, preset.name);
    const expanded = expandMaskingPreset(preset, { id: preset.name, name: preset.label });
    assert.equal(expanded.name, preset.label);
    assert.ok(expanded.description?.includes(preset.example));
  }
});
