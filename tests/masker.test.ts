/**
 * tests/masker.test.ts
 * Unit tests for the masking engine: roundtrips, capture groups, priority,
 * collision retries, case sensitivity, special placeholder formats, and
 * deep value masking.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Masker, MAX_COLLISION_ATTEMPTS } from "../masker.ts";
import { generatePlaceholder } from "../placeholder-gen.ts";
import type { MaskingRule } from "../masker.ts";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "hex");

test("literal rule: mask and unmask roundtrip", () => {
  const m = new Masker(
    [{ id: "d", real: "company-internal.com", placeholder: "northstar-systems.com" }],
    true,
    KEY
  );
  const text = "My mail is user@company-internal.com and docs are at docs.company-internal.com";
  const masked = m.mask(text);
  assert.equal(masked.text, "My mail is user@northstar-systems.com and docs are at docs.northstar-systems.com");
  assert.equal(masked.count, 2);
  const unmasked = m.unmask(masked.text);
  assert.equal(unmasked.text, text);
});

test("literal rule with auto placeholder: roundtrip", () => {
  const real = "sk-prod-abc123456789";
  const m = new Masker(
    [{ id: "k", real, placeholder: generatePlaceholder(real, KEY) }],
    true,
    KEY
  );
  const text = `key=${real}`;
  const masked = m.mask(text);
  assert.notEqual(masked.text, text);
  assert.ok(!masked.text.includes(real));
  assert.equal(m.unmask(masked.text).text, text);
});

test("regex rule: whole-match replacement roundtrip via dynamic map", () => {
  const m = new Masker(
    [{ id: "phone", type: "regex", pattern: "\\b\\d{3}-\\d{4}\\b" }],
    true,
    KEY
  );
  const text = "Call 123-4567 now or 987-6543 later";
  const masked = m.mask(text);
  assert.equal(masked.count, 2);
  assert.ok(!masked.text.includes("123-4567"));
  assert.ok(!masked.text.includes("987-6543"));
  // Same real value reuses the same placeholder within the session
  const again = m.mask("123-4567");
  assert.equal(again.text, masked.text.slice(5, 5 + 8));
  assert.equal(m.unmask(masked.text).text, text);
});

test("regex rule with capture group replaces only the captured part", () => {
  const m = new Masker(
    [{ id: "bearer", type: "regex", pattern: "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)", flags: "i" }],
    true,
    KEY
  );
  const text = "Authorization: Bearer abcDEF123456";
  const masked = m.mask(text);
  assert.ok(masked.text.startsWith("Authorization: Bearer "));
  assert.notEqual(masked.text, text);
  assert.ok(!masked.text.includes("abcDEF123456"));
  assert.equal(m.unmask(masked.text).text, text);
});

test("priority: earlier rule claims a region, later overlapping rule skips it", () => {
  const m = new Masker(
    [
      { id: "first", real: "abc", placeholder: "xyz" },
      { id: "second", type: "regex", pattern: "a.c" },
    ],
    true,
    KEY
  );
  const masked = m.mask("prefix abc suffix");
  assert.equal(masked.text, "prefix xyz suffix");
  assert.equal(masked.count, 1);
  assert.equal(m.unmask(masked.text).text, "prefix abc suffix");
});

test("lookahead keeps adjacent rules from claiming each other's text", () => {
  const m = new Masker(
    [
      { id: "local", type: "regex", pattern: "[A-Za-z0-9._%+-]+(?=@corp\\.com)" },
      { id: "domain", real: "corp.com", placeholder: "example.org" },
    ],
    true,
    KEY
  );
  const text = "user@corp.com";
  const masked = m.mask(text);
  assert.ok(masked.text.endsWith("@example.org"));
  const local = masked.text.slice(0, masked.text.indexOf("@"));
  assert.notEqual(local, "user");
  assert.equal(m.unmask(masked.text).text, text);
});

test("zero-width regex matches do not hang or crash", () => {
  const m = new Masker([{ id: "z", type: "regex", pattern: "a*" }], true, KEY);
  const masked = m.mask("aaa bbb");
  assert.equal(masked.count, 1);
  assert.ok(masked.text.endsWith(" bbb"));
  assert.notEqual(masked.text, "aaa bbb");
  assert.equal(m.unmask(masked.text).text, "aaa bbb");
});

test("dynamic placeholder retries when it collides with an existing placeholder", () => {
  const real = "abc123";
  const p0 = generatePlaceholder(real, KEY, 0); // what attempt 0 would produce
  const m = new Masker(
    [
      { id: "lit", real: "some-other-real", placeholder: p0 },
      { id: "re", type: "regex", pattern: "[a-z]{3}\\d{3}" },
    ],
    true,
    KEY
  );
  const masked = m.mask(`value ${real}`);
  assert.notEqual(masked.text, `value ${p0}`);
  assert.equal(m.unmask(masked.text).text, `value ${real}`);
  assert.equal(MAX_COLLISION_ATTEMPTS, 10);
});

test("caseSensitive false masks and unmasks case-insensitively", () => {
  const rules = [{ id: "s", real: "SecretKey", placeholder: "FakeKey" }];
  const m = new Masker(rules, false, KEY);
  assert.equal(m.mask("my SecretKey and secretkey").text, "my FakeKey and FakeKey");
  assert.equal(m.unmask("my FakeKey and fakekey").text, "my SecretKey and SecretKey");
  const strict = new Masker(rules, true, KEY);
  assert.equal(strict.mask("my secretkey").text, "my secretkey");
});

test("IPv4 regex values produce syntactically valid IPv4 placeholders", () => {
  const m = new Masker(
    [{ id: "ip", type: "regex", pattern: "\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b" }],
    true,
    KEY
  );
  const text = "host 10.0.0.1";
  const masked = m.mask(text);
  const ip = masked.text.slice(5);
  assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/);
  assert.ok(ip.split(".").every((o) => Number(o) >= 0 && Number(o) <= 255));
  assert.equal(m.unmask(masked.text).text, text);
});

test("connection-string regex keeps scheme, port and path; replaces userinfo", () => {
  const m = new Masker(
    [{ id: "db", type: "regex", pattern: "(?:postgresql|mysql)://([^\\s]+)@" }],
    true,
    KEY
  );
  const text = "conn postgresql://admin:secret@db.internal:5432/prod";
  const masked = m.mask(text);
  const body = masked.text.slice(5);
  assert.ok(body.startsWith("postgresql://"));
  assert.ok(body.endsWith(":5432/prod"));
  const at = body.lastIndexOf("@");
  const userinfo = body.slice("postgresql://".length, at);
  assert.notEqual(userinfo, "admin:secret");
  assert.equal(body.slice(at + 1), "db.internal:5432/prod");
  assert.equal(m.unmask(masked.text).text, text);
});

test("maskValue/unmaskValue recurse deeply and preserve non-strings", () => {
  const m = new Masker(
    [{ id: "e", real: "a@corp.com", placeholder: "b@corp.com" }],
    true,
    KEY
  );
  const input = { user: "a@corp.com", meta: { tags: ["x", "a@corp.com"], n: 42 }, flag: true, nil: null };
  const { value, count } = m.maskValue(input) as { value: any; count: number };
  assert.equal(count, 2);
  assert.equal(value.user, "b@corp.com");
  assert.equal(value.meta.tags[1], "b@corp.com");
  assert.equal(value.meta.tags[0], "x");
  assert.equal(value.meta.n, 42);
  assert.equal(value.flag, true);
  assert.equal(value.nil, null);
  const back = m.unmaskValue(value) as { value: any };
  assert.equal(back.value.user, "a@corp.com");
  assert.equal(back.value.meta.tags[1], "a@corp.com");
  // Non-string values pass through untouched
  assert.deepEqual(m.maskValue(42), { value: 42, count: 0, details: [] });
  assert.deepEqual(m.maskValue(null), { value: null, count: 0, details: [] });
});

test("details group distinct real values per rule with occurrence counts", () => {
  const m = new Masker(
    [{ id: "ip", type: "regex", pattern: "\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b" }],
    true,
    KEY
  );
  const r = m.mask("10.0.0.1 then 10.0.0.1 then 192.168.1.5");
  assert.equal(r.count, 3);
  assert.equal(r.details.length, 1);
  assert.equal(r.details[0].values.length, 2);
  const v1 = r.details[0].values.find((v) => v.real === "10.0.0.1")!;
  const v2 = r.details[0].values.find((v) => v.real === "192.168.1.5")!;
  assert.equal(v1.occurrences, 2);
  assert.equal(v2.occurrences, 1);
});

test("unmask leaves text without known placeholders unchanged", () => {
  const m = new Masker([{ id: "d", real: "abc", placeholder: "xyz" }], true, KEY);
  const r = m.unmask("nothing sensitive here");
  assert.equal(r.text, "nothing sensitive here");
  assert.equal(r.count, 0);
});

test("masking already-masked text is idempotent (provider-boundary double-mask regression)", () => {
  // A format-preserving placeholder (digits→digits) still matches the phone
  // shape regex that produced it. The before_provider_request fallback
  // re-runs maskValue() on the context hook's output, so without protection
  // the second pass would register real: P1 -> placeholder: P2, the LLM would
  // see P2, and unmask could only restore P2 -> P1, never the real digits.
  const m = new Masker(
    [{ id: "phone", type: "regex", pattern: "\\b\\d{3}-\\d{4}\\b" }],
    true,
    KEY
  );
  const real = "Call 123-4567 now or 987-6543 later";
  const once = m.mask(real);
  const twice = m.mask(once.text);
  assert.equal(twice.text, once.text, "re-masking must not re-mask placeholders");
  assert.equal(m.unmask(twice.text).text, real);
});

test("second masking pass still masks genuinely new values and keeps old placeholders", () => {
  const m = new Masker(
    [{ id: "phone", type: "regex", pattern: "\\b\\d{3}-\\d{4}\\b" }],
    true,
    KEY
  );
  const first = m.mask("Call 123-4567 now");
  // A value injected after the context hook (e.g. by another extension)
  // reaches the provider boundary unmasked and must still be caught.
  const payload = first.text + " then 999-8888";
  const r = m.maskValue(payload) as { value: string };
  assert.ok(!r.value.includes("999-8888"), "new leak must still be masked");
  assert.ok(r.value.includes(first.text.slice(5, 13)), "old placeholder must be preserved");
  assert.equal(m.unmask(r.value).text, "Call 123-4567 now then 999-8888");
});

test("literal placeholders are protected from a generic shape regex on re-mask", () => {
  const m = new Masker(
    [
      { id: "company_root_domain", real: "company-internal.com", placeholder: "northstar-systems.com" },
      { id: "generic", type: "regex", pattern: "[A-Za-z0-9._-]+" },
    ],
    true,
    KEY
  );
  const real = "internal host is company-internal.com";
  const once = m.mask(real);
  const twice = m.mask(once.text);
  assert.equal(twice.text, once.text, "literal placeholder must not be re-masked");
  assert.equal(m.unmask(twice.text).text, real);
});

test("placeholder contained as a substring of a new secret is still masked (no overlap leak)", () => {
  // Literal placeholder that happens to look like a private IP address.
  const m = new Masker(
    [
      { id: "lit", real: "some-internal-key", placeholder: "10.0.0.1" },
      { id: "privip", type: "regex", pattern: "\\b(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})\\b" },
    ],
    true,
    KEY
  );
  // "10.0.0.15" begins with the placeholder "10.0.0.1": covering only the
  // placeholder must NOT swallow the longer, genuinely new secret.
  const masked = m.mask("10.0.0.15");
  assert.notEqual(masked.text, "10.0.0.15", "new secret must be masked, not leaked");
  assert.equal(m.unmask(masked.text).text, "10.0.0.15");
  // The placeholder alone still stays untouched on a re-mask.
  const alone = m.mask("10.0.0.1");
  assert.equal(alone.text, "10.0.0.1", "placeholder alone must stay untouched");
});

test("manual placeholder conflicts produce warnings", () => {
  const m = new Masker(
    [
      { id: "a", real: "aa", placeholder: "dup" },
      { id: "b", real: "bb", placeholder: "dup" },
      { id: "c", real: "cc", placeholder: "cc" },
    ],
    true,
    KEY
  );
  assert.ok(m.warnings.some((w) => w.includes("already used by rule")));
  assert.ok(m.warnings.some((w) => w.includes("has no effect")));
});
