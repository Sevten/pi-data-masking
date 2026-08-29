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

test("private IPv4 preset documents and retains its two-octet default", () => {
  const preset = MASKING_PRESETS.find((candidate) => candidate.name === "private-ipv4");
  assert.ok(preset);
  assert.deepEqual(preset.preserveStructure, { keepIPv4Octets: 2 });
  assert.match(preset.description, /first two octets/i);
});

test("public IPv4 preset excludes private and common special-use ranges", () => {
  const preset = MASKING_PRESETS.find((candidate) => candidate.name === "public-ipv4");
  assert.ok(preset);
  const regex = new RegExp(`^(?:${preset.pattern})$`);

  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34"]) {
    assert.match(address, regex);
  }
  for (const address of [
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    assert.doesNotMatch(address, regex);
  }
});
