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
    KEY
  );
  const text = "My mail is user@company-internal.com and docs are at docs.company-internal.com";
  const masked = m.mask(text);
  assert.equal(masked.text, "My mail is user@northstar-systems.com and docs are at docs.northstar-systems.com");
  assert.equal(masked.count, 2);
  const unmasked = m.unmask(masked.text);
  assert.equal(unmasked.text, text);
});

test("disabled rules are ignored even when Masker is constructed directly", () => {
  const dynamicMap = new Map();
  const m = new Masker(
    [
      { id: "literal-off", enabled: false, real: "company-internal.com", placeholder: "example.test" },
      { id: "regex-off", enabled: false, type: "regex", pattern: "token-[a-z]+" },
    ],
    KEY,
    dynamicMap,
  );
  const text = "company-internal.com token-secret";
  assert.equal(m.mask(text).text, text);
  assert.equal(dynamicMap.size, 0);
});

test("literal rule with auto placeholder: roundtrip", () => {
  const real = "sk-prod-abc123456789";
  const m = new Masker(
    [{ id: "k", real, placeholder: generatePlaceholder(real, KEY) }],
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
  const m = new Masker([{ id: "z", type: "regex", pattern: "a*" }], KEY);
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
    KEY
  );
  const masked = m.mask(`value ${real}`);
  assert.notEqual(masked.text, `value ${p0}`);
  assert.equal(m.unmask(masked.text).text, `value ${real}`);
  assert.equal(MAX_COLLISION_ATTEMPTS, 10);
});

test("caseSensitive false masks and unmasks case-insensitively", () => {
  const rules = [{ id: "s", real: "SecretKey", placeholder: "FakeKey", caseSensitive: false }];
  const m = new Masker(rules, KEY);
  assert.equal(m.mask("my SecretKey and secretkey").text, "my FakeKey and FakeKey");
  assert.equal(m.unmask("my FakeKey and fakekey").text, "my SecretKey and SecretKey");
  const strict = new Masker([{ ...rules[0]!, caseSensitive: undefined }], KEY);
  assert.equal(strict.mask("my secretkey").text, "my secretkey");
});

test("IPv4 regex values produce syntactically valid IPv4 placeholders", () => {
  const m = new Masker(
    [{ id: "ip", type: "regex", pattern: "\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b" }],
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
  const m = new Masker([{ id: "d", real: "abc", placeholder: "xyz" }], KEY);
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
    KEY
  );
  assert.ok(m.warnings.some((w) => w.includes("already used by rule")));
  assert.ok(m.warnings.some((w) => w.includes("has no effect")));
});

// ─── Provenance: first-seen is forever ──────────────────────────────────────

/** Build a Masker with fresh provenance state for one test. */
function makeMasker(rules: MaskingRule[]) {
  return new Masker(rules, KEY, new Map(), new Set(), new Set());
}

test("user message (discover) masks and registers new regex values", () => {
  const m = makeMasker([{ id: "code", type: "regex", pattern: "\\b\\d{4}\\b" }]);
  const masked = m.mask("my code is 4821", { discover: true });
  assert.notEqual(masked.text, "my code is 4821");
  assert.equal(masked.count, 1);
  // The value is now protected: an assistant re-mask keeps it masked.
  const again = m.mask("echo: 4821", { discover: false });
  assert.ok(again.text.includes("my code is 4821".split(" ")[3]) === false);
  assert.notEqual(again.text, "echo: 4821");
});

test("assistant message never registers LLM-invented values and keeps them real", () => {
  const m = makeMasker([{ id: "code", type: "regex", pattern: "\\b\\d{4}\\b" }]);
  // First appearance is in an assistant message → invented.
  const assistant = m.mask("for example 4821 is weak", { discover: false });
  assert.equal(assistant.text, "for example 4821 is weak", "invented value must stay real");
  assert.equal(assistant.count, 0);
  // First-seen is forever: even a later user message leaves it unmasked.
  const user = m.mask("my code is 4821", { discover: true });
  assert.equal(user.text, "my code is 4821", "invented value is never masked");
  assert.equal(user.count, 0);
});

test("restored user-secret echoes are re-masked in assistant messages", () => {
  const m = makeMasker([{ id: "code", type: "regex", pattern: "\\b\\d{4}\\b" }]);
  // User sends the secret → registered + masked.
  const user = m.mask("my code is 4821", { discover: true });
  const placeholder = user.text.match(/\d{4}/)![0];
  assert.notEqual(placeholder, "4821");
  // message_end would restore the placeholder; the stored assistant message
  // therefore contains the REAL value, and the next round's re-mask must
  // mask it again so it never leaks back to the LLM.
  const restored = user.text.replace(placeholder, "4821");
  const assistant = m.mask(`got it, ${restored.split("is ")[1]}`, { discover: false });
  assert.notEqual(assistant.text, `got it, 4821`, "restored echo must be re-masked");
  assert.equal(assistant.count, 1);
  // And it round-trips back to the real value via unmask.
  assert.equal(m.unmask(assistant.text).text, "got it, 4821");
});

test("protected-first tool roundtrips preserve one stable model-facing value", () => {
  const m = makeMasker([{ id: "code", type: "regex", pattern: "\\b\\d{4}\\b" }]);
  const user = m.mask("my code is 4821", { discover: true });
  const placeholder = user.text.match(/\d{4}/)![0];
  assert.notEqual(placeholder, "4821");

  const toolInput = m.unmask(`write ${placeholder}`);
  assert.equal(toolInput.text, "write 4821");
  const toolResult = m.mask("file contains 4821", { discover: true });
  assert.equal(toolResult.text, `file contains ${placeholder}`);
});

test("protected-first values cannot distinguish a later independent low-entropy model use", () => {
  const m = makeMasker([{ id: "code", type: "regex", pattern: "\\b\\d{4}\\b" }]);
  const user = m.mask("my code is 4821", { discover: true });
  const placeholder = user.text.match(/\d{4}/)![0];

  // The engine cannot know that this identical string has a different meaning.
  const assistant = m.mask("ordinary example 4821", { discover: false });
  assert.equal(assistant.text, `ordinary example ${placeholder}`);
});

test("model-first provenance remains immutable across user and tool sources", () => {
  const m = makeMasker([{ id: "code", type: "regex", pattern: "\\b\\d{4}\\b" }]);
  // LLM invented 4821 first.
  const firstAssistant = m.mask("e.g. 4821", { discover: false });
  assert.equal(firstAssistant.text, "e.g. 4821");
  // Neither a later user message nor a tool result may promote it to protected.
  const user = m.mask("my code is 4821", { discover: true });
  const tool = m.mask("file contains 4821", { discover: true });
  assert.equal(user.text, "my code is 4821");
  assert.equal(user.count, 0);
  assert.equal(tool.text, "file contains 4821");
  assert.equal(tool.count, 0);
  // A future replay of the original assistant text must remain byte-stable.
  const assistant = m.mask("e.g. 4821", { discover: false });
  assert.equal(assistant.text, "e.g. 4821");
});

test("literal rules follow the same first-seen semantics", () => {
  const m = makeMasker([
    { id: "dom", real: "company-internal.com", placeholder: "northstar-systems.com" },
  ]);
  // LLM invents the literal real value → never masked afterwards.
  const assistant = m.mask("docs at company-internal.com", { discover: false });
  assert.equal(assistant.text, "docs at company-internal.com");
  const user = m.mask("my domain is company-internal.com", { discover: true });
  assert.equal(user.text, "my domain is company-internal.com", "first-seen wins for literals too");
  // But when the USER sends it first, it is masked everywhere.
  const m2 = makeMasker([
    { id: "dom", real: "company-internal.com", placeholder: "northstar-systems.com" },
  ]);
  const user2 = m2.mask("my domain is company-internal.com", { discover: true });
  assert.notEqual(user2.text, "my domain is company-internal.com");
  const assistant2 = m2.mask("docs at company-internal.com", { discover: false });
  assert.notEqual(assistant2.text, "docs at company-internal.com");
  assert.equal(m2.unmask(assistant2.text).text, "docs at company-internal.com");
});

test("skipped invented regions stay free for lower-priority protected rules", () => {
  const m = makeMasker([
    { id: "broad", type: "regex", pattern: "[A-Za-z0-9-]+" },
    { id: "short", real: "abc", placeholder: "xyz" },
  ]);
  // User registers "abc" first (the broad rule claims it in the user message,
  // so it is protected with a dynamic placeholder).
  const user = m.mask("id is abc", { discover: true });
  assert.notEqual(user.text, "id is abc");
  // Assistant message contains "token-abc": the broad rule's span is
  // LLM-invented and skipped — its region must stay free so the lower
  // literal rule can still mask the protected "abc" inside it.
  const assistant = m.mask("token-abc", { discover: false });
  assert.notEqual(assistant.text, "token-abc", "protected 'abc' must not hide inside an invented token");
  assert.ok(!assistant.text.includes("abc"));
  // Round-trips back to the real value.
  assert.equal(m.unmask(assistant.text).text, "token-abc");
});

// ── unmaskDisplay: single-pass display-only restoration ─────────────────────

test("unmaskDisplay: restores literal placeholders without touching state", () => {
  const m = makeMasker([
    { id: "k", real: "sk-prod-abc123456789", placeholder: "sk-nqpz-mwx847312654" },
  ]);
  const text = "checking sk-nqpz-mwx847312654 against the docs";
  assert.equal(m.unmaskDisplay(text), "checking sk-prod-abc123456789 against the docs");
  // Idempotent and cheap on already-restored text.
  assert.equal(m.unmaskDisplay("checking sk-prod-abc123456789"), "checking sk-prod-abc123456789");
});

test("unmaskDisplay: restores regex-discovered dynamic placeholders", () => {
  const m = makeMasker([{ id: "tok", type: "regex", pattern: "token_[A-Za-z0-9]{8}" }]);
  const masked = m.mask("value token_abcd1234 here", { discover: true });
  assert.notEqual(masked.text, "value token_abcd1234 here");
  const restored = m.unmaskDisplay(masked.text);
  assert.equal(restored, "value token_abcd1234 here");
  // Text without any placeholder passes through unchanged.
  assert.equal(m.unmaskDisplay("nothing sensitive here"), "nothing sensitive here");
});

test("unmaskDisplay: matches unmask() semantics on mixed content", () => {
  const real1 = "sk-prod-abc123456789";
  const m = makeMasker([
    { id: "k", real: real1, placeholder: generatePlaceholder(real1, KEY) },
    { id: "tok", type: "regex", pattern: "token_[A-Za-z0-9]{8}" },
  ]);
  const sample = `thinking about ${real1} and token_zx9q1122 ...`;
  const masked = m.mask(sample, { discover: true });
  assert.equal(m.unmaskDisplay(masked.text), sample);
});

test("unmaskDisplay: longest placeholder wins when one contains another", () => {
  const m = makeMasker([
    { id: "short", real: "short-secret", placeholder: "ph-short" },
    { id: "long", real: "long-secret-value", placeholder: "ph-short-extended" },
  ]);
  // "ph-short-extended" must not be partially restored via "ph-short".
  assert.equal(
    m.unmaskDisplay("a ph-short-extended b ph-short c"),
    "a long-secret-value b short-secret c"
  );
});

test("unmaskDisplay: case-insensitive rule restores case-variant placeholders", () => {
  const m = new Masker(
    [{ id: "k", real: "real-value", placeholder: "Ph-Holder", caseSensitive: false }],
    KEY,
    new Map(),
    new Set(),
    new Set()
  );
  assert.equal(m.unmaskDisplay("x PH-HOLDER y"), "x real-value y");
});

test("unmaskDisplay: empty masker returns the input unchanged", () => {
  const m = makeMasker([]);
  const text = "plain assistant output";
  assert.equal(m.unmaskDisplay(text), text);
});

// ─── Allowlist ──────────────────────────────────────────────────────────────

test("regex rule case sensitivity is controlled solely by its flags", () => {
  const cs = new Masker([{ id: "tok", type: "regex", pattern: "token-[a-z]+" }], KEY, new Map(), new Set(), new Set());
  assert.equal(cs.mask("see TOKEN-abc now", { discover: true }).count, 0);

  // The "i" flag makes the rule case-insensitive.
  const ci = new Masker([{ id: "tok", type: "regex", pattern: "token-[a-z]+", flags: "i" }], KEY, new Map(), new Set(), new Set());
  assert.equal(ci.mask("see TOKEN-abc now", { discover: true }).count, 1);
});

test("regex-discovered dynamic placeholders inherit the rule's flags for restoration", () => {
  const dynamicMap = new Map();
  const ci = new Masker([{ id: "tok", type: "regex", pattern: "token-[a-z]+", flags: "i" }], KEY, dynamicMap, new Set(), new Set());
  const masked = ci.mask("see token-abc now", { discover: true });
  assert.equal(masked.count, 1);
  const placeholder = masked.text.replace("see ", "").replace(" now", "");
  assert.equal(ci.unmaskDisplay(`x ${placeholder.toUpperCase()} y`), "x token-abc y");
  // Case-sensitive rules keep exact-case restoration.
  const dynamicMap2 = new Map();
  const cs = new Masker([{ id: "tok", type: "regex", pattern: "token-[a-z]+" }], KEY, dynamicMap2, new Set(), new Set());
  const masked2 = cs.mask("see token-abc now", { discover: true });
  const placeholder2 = masked2.text.replace("see ", "").replace(" now", "");
  assert.equal(cs.unmaskDisplay(`x ${placeholder2.toUpperCase()} y`), `x ${placeholder2.toUpperCase()} y`);
});

test("allowlist: literal rule match is exempt and not registered anywhere", () => {
  const m = new Masker(
    [{ id: "ip", type: "regex", pattern: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["10.0.0.5"],
  );
  const masked = m.mask("host 10.0.0.5 and 10.0.0.6", { discover: true });
  assert.equal(masked.count, 1);
  assert.equal(masked.text.includes("10.0.0.5"), true);
  assert.equal(masked.text.includes("10.0.0.6"), false);
});

test("allowlist: removing an entry masks the value again", () => {
  const sharedProtected = new Set<string>();
  const sharedInvented = new Set<string>();
  const withEntry = new Masker(
    [{ id: "ip", type: "regex", pattern: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b" }],
    KEY,
    new Map(),
    sharedInvented,
    sharedProtected,
    ["10.0.0.5"],
  );
  assert.equal(withEntry.mask("host 10.0.0.5", { discover: true }).count, 0);
  const withoutEntry = new Masker(
    [{ id: "ip", type: "regex", pattern: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b" }],
    KEY,
    new Map(),
    sharedInvented,
    sharedProtected,
  );
  assert.equal(withoutEntry.mask("host 10.0.0.5", { discover: true }).count, 1);
});

test("allowlist: beats a lower-priority literal rule that also matches", () => {
  const m = new Masker(
    [{ id: "lit", real: "10.0.0.5", placeholder: "masked-ip" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["10.0.0.5"],
  );
  const masked = m.mask("gateway 10.0.0.5", { discover: true });
  assert.equal(masked.text, "gateway 10.0.0.5");
  assert.equal(masked.count, 0);
});

test("allowlist: case-insensitive entry matches case-insensitively", () => {
  const m = new Masker(
    [{ id: "lit", real: "MyHost", placeholder: "masked-host" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    [{ text: "myhost", caseSensitive: false }],
  );
  assert.equal(m.mask("see MyHost now", { discover: true }).count, 0);
});

test("allowlist: case-sensitive entry only matches exact case", () => {
  const m = new Masker(
    [{ id: "lit", real: "MyHost", placeholder: "masked-host" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["myhost"],
  );
  assert.equal(m.mask("see MyHost now", { discover: true }).count, 1);
});

test("allowlist: entry equal to a rule's placeholder produces a warning", () => {
  const m = new Masker(
    [{ id: "lit", real: "secret", placeholder: "masked-secret" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["masked-secret"],
  );
  assert.ok(m.warnings.some((w) => w.includes("exempts placeholder text")));
});

test("allowlist: regex capture group exemption masks sibling groups", () => {
  const m = new Masker(
    [{ id: "pair", type: "regex", pattern: "(\\w+)=(\\w+)" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["allowed"],
  );
  const masked = m.mask("allowed=value secret=hidden", { discover: true });
  assert.equal(masked.text.startsWith("allowed="), true);
  const reals = new Set(masked.details.flatMap((d) => d.values.map((v) => v.real)));
  assert.equal(reals.has("allowed"), false);
  assert.equal(reals.has("value"), true);
  assert.equal(reals.has("hidden"), true);
});

test("allowlist: whole-line entry exempts a capture-group match inside it", () => {
  const m = new Masker(
    [{ id: "bearer", type: "regex", pattern: "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)", flags: "i" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["Authorization: Bearer test123456"],
  );
  const text = "curl -H 'Authorization: Bearer test123456' api.example.com";
  const masked = m.mask(text, { discover: true });
  assert.equal(masked.count, 0);
  assert.equal(masked.text, text);
});

test("allowlist: prefix-only entry shields the captured token it overlaps", () => {
  const m = new Masker(
    [{ id: "bearer", type: "regex", pattern: "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)", flags: "i" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["Bearer test123456"],
  );
  const masked = m.mask("Authorization: Bearer test123456", { discover: true });
  assert.equal(masked.count, 0);
});

test("allowlist: entry that is a prefix of the token does NOT exempt the longer token", () => {
  const m = new Masker(
    [{ id: "bearer", type: "regex", pattern: "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)", flags: "i" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["Authorization: Bearer test"],
  );
  // "Bearer test" continues into "test123": the entry never named that
  // longer token, so it must stay masked.
  const masked = m.mask("Authorization: Bearer test123", { discover: true });
  assert.equal(masked.count, 1);
  assert.equal(masked.text.startsWith("Authorization: Bearer "), true);
  const exact = m.mask("Authorization: Bearer test", { discover: true });
  assert.equal(exact.count, 0);
});

test("allowlist: whole-line entry matches case-insensitively when allowed", () => {
  const m = new Masker(
    [{ id: "bearer", type: "regex", pattern: "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)", flags: "i" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    [{ text: "authorization: bearer TEST123456", caseSensitive: false }],
  );
  const masked = m.mask("Authorization: Bearer test123456", { discover: true });
  assert.equal(masked.count, 0);
});

test("allowlist: whole-line entry needs exact case when caseSensitive", () => {
  const m = new Masker(
    [{ id: "bearer", type: "regex", pattern: "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)", flags: "i" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["authorization: bearer test123456"],
  );
  const masked = m.mask("Authorization: Bearer test123456", { discover: true });
  assert.equal(masked.count, 1);
});

test("allowlist: prefix entry inside a longer value does NOT shield it", () => {
  const m = new Masker(
    [{ id: "tok", type: "regex", pattern: "tok-[A-Za-z0-9]+" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["123456"],
  );
  // "123456" continues into a longer token run inside "tok-123456": a
  // prefix of a longer value is a different value, so it stays masked.
  const masked = m.mask("tok-123456 and tok-abcdef", { discover: true });
  assert.equal(masked.count, 2);
  const reals = masked.details.flatMap((d) => d.values.map((v) => v.real));
  assert.deepEqual(reals, ["tok-123456", "tok-abcdef"]);
});

test("allowlist: boundary-aligned bare value is still exempt", () => {
  const m = new Masker(
    [{ id: "tok", type: "regex", pattern: "tok-[A-Za-z0-9]+" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["123456"],
  );
  const masked = m.mask("tok-123456x and 123456", { discover: true });
  // "tok-123456x" keeps the mask ("123456" inside it is bounded by token
  // chars on both edges); the standalone "123456" is boundary-aligned and
  // exempt.
  assert.equal(masked.count, 1);
  assert.equal(masked.text.endsWith(" and 123456"), true);
  const reals = masked.details.flatMap((d) => d.values.map((v) => v.real));
  assert.deepEqual(reals, ["tok-123456x"]);
});

test("allowlist: every occurrence of an entry is shielded", () => {
  const m = new Masker(
    [{ id: "ip", type: "regex", pattern: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["10.0.0.5"],
  );
  const masked = m.mask("10.0.0.5 to 10.0.0.5 via 10.0.0.6 then 10.0.0.5", { discover: true });
  assert.equal(masked.count, 1);
  assert.equal(masked.text.includes("10.0.0.6"), false);
});

test("allowlist: token-only entry still exempts the bare value", () => {
  const m = new Masker(
    [{ id: "bearer", type: "regex", pattern: "Authorization:\\s*Bearer\\s+([A-Za-z0-9._-]+)", flags: "i" }],
    KEY,
    new Map(),
    new Set(),
    new Set(),
    ["test123456"],
  );
  const masked = m.mask("Authorization: Bearer test123456", { discover: true });
  assert.equal(masked.count, 0);
  assert.equal(masked.text, "Authorization: Bearer test123456");
});
