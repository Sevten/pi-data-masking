/**
 * tests/placeholder-gen.test.ts
 * Unit tests for format-preserving placeholder generation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePlaceholder, generateSessionKey } from "../placeholder-gen.ts";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "hex");

test("same real + same key + same attempt is deterministic", () => {
  const a = generatePlaceholder("abc123XYZ", KEY, 0);
  const b = generatePlaceholder("abc123XYZ", KEY, 0);
  assert.equal(a, b);
});

test("different attempts produce different placeholders", () => {
  const a = generatePlaceholder("abc123XYZ", KEY, 0);
  const b = generatePlaceholder("abc123XYZ", KEY, 1);
  assert.notEqual(a, b);
});

test("character classes are preserved and separators kept as-is", () => {
  const real = "Ab-12_cd@X";
  const ph = generatePlaceholder(real, KEY);
  assert.equal(ph.length, real.length);
  assert.ok(ph[0] >= "A" && ph[0] <= "Z");
  assert.ok(ph[1] >= "a" && ph[1] <= "z");
  assert.equal(ph[2], "-");
  assert.ok(ph[3] >= "0" && ph[3] <= "9");
  assert.ok(ph[4] >= "0" && ph[4] <= "9");
  assert.equal(ph[5], "_");
  assert.ok(ph[6] >= "a" && ph[6] <= "z");
  assert.ok(ph[7] >= "a" && ph[7] <= "z");
  assert.equal(ph[8], "@");
  assert.ok(ph[9] >= "A" && ph[9] <= "Z");
});

test("valid IPv4 values get syntactically valid placeholders", () => {
  const ph = generatePlaceholder("192.168.1.10", KEY);
  assert.match(ph, /^\d{1,3}(\.\d{1,3}){3}$/);
  assert.ok(ph.split(".").every((o) => Number(o) >= 0 && Number(o) <= 255));
  assert.notEqual(ph, "192.168.1.10");
});

test("invalid IPv4 falls back to per-character replacement", () => {
  const ph = generatePlaceholder("999.1.1.1", KEY);
  // digits stay digits, dots stay dots
  assert.match(ph, /^\d{3}\.\d\.\d\.\d$/);
});

test("connection string keeps scheme, port and path; replaces userinfo and host", () => {
  const real = "postgresql://admin:secret@db.internal:5432/prod";
  const ph = generatePlaceholder(real, KEY);
  assert.ok(ph.startsWith("postgresql://"));
  assert.ok(ph.endsWith(":5432/prod"));
  assert.ok(ph.includes("@"));
  assert.notEqual(ph, real);
  assert.notEqual(ph.slice("postgresql://".length, ph.indexOf("@")), "admin:secret");
  assert.notEqual(ph.slice(ph.indexOf("@") + 1, ph.indexOf(":5432")), "db.internal");
});

test("connection string with @ inside the password keeps the last @ as separator", () => {
  const real = "redis://user:p@ss@host:6379/0";
  const ph = generatePlaceholder(real, KEY);
  assert.ok(ph.startsWith("redis://"));
  assert.ok(ph.endsWith(":6379/0"));
  assert.notEqual(ph, real);
  // The inner @ is format-preserving (kept as-is); the separator is still the last @
  assert.equal(ph.split("@").length - 1, 2);
  const at = ph.lastIndexOf("@");
  assert.notEqual(ph.slice("redis://".length, at), "user:p@ss");
  assert.notEqual(ph.slice(at + 1, ph.indexOf(":6379")), "host");
});

test("connection string without userinfo replaces only the host", () => {
  const ph = generatePlaceholder("mysql://dbhost:3306/app", KEY);
  assert.ok(ph.startsWith("mysql://"));
  assert.ok(ph.endsWith(":3306/app"));
  assert.notEqual(ph.slice("mysql://".length, ph.indexOf(":3306")), "dbhost");
});

test("generateSessionKey returns a 32-byte buffer", () => {
  const k = generateSessionKey();
  assert.ok(Buffer.isBuffer(k));
  assert.equal(k.length, 32);
});

// ─── Structure preservation (keepPrefix / keepIPv4Octets) ──────────────────

test("keepPrefix keeps the first segment deterministically", () => {
  const real = "sk-prod-abc123456789";
  const a = generatePlaceholder(real, KEY, 0, { keepPrefix: true });
  const b = generatePlaceholder(real, KEY, 0, { keepPrefix: true });
  assert.equal(a, b); // deterministic
  assert.ok(a.startsWith("sk-"), a);
  assert.notEqual(a, real);
  // The body after the kept prefix is still format-preserving
  assert.equal(a.length, real.length);
});

test("keepPrefix with a number caps the kept characters", () => {
  const ph = generatePlaceholder("corp-internal-host", KEY, 0, { keepPrefix: 4 });
  assert.ok(ph.startsWith("corp"), ph);
});

test("keepPrefix falls back to full randomization for single-segment values", () => {
  // No separator: keeping the whole value would make the placeholder equal
  // to the real value, so the prefix is dropped instead.
  const real = "abcdef123456";
  const ph = generatePlaceholder(real, KEY, 0, { keepPrefix: true });
  assert.notEqual(ph, real);
});

test("keepIPv4Octets keeps leading octets and randomizes the rest", () => {
  const ph = generatePlaceholder("192.168.10.7", KEY, 0, { keepIPv4Octets: 2 });
  assert.ok(ph.startsWith("192.168."), ph);
  assert.match(ph, /^\d{1,3}(\.\d{1,3}){3}$/);
  assert.ok(ph.split(".").every((o) => Number(o) >= 0 && Number(o) <= 255));
  // At least one octet is always randomized
  const full = generatePlaceholder("192.168.10.7", KEY, 0, { keepIPv4Octets: 4 });
  assert.notEqual(full, "192.168.10.7");
});

test("structure preservation is deterministic across attempts with collision retry", () => {
  const real = "tok-abc123";
  const a = generatePlaceholder(real, KEY, 1, { keepPrefix: true });
  const b = generatePlaceholder(real, KEY, 1, { keepPrefix: true });
  assert.equal(a, b);
  assert.ok(a.startsWith("tok-"), a);
});
