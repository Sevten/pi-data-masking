/**
 * tests/restore-scope.test.ts
 * Unit tests for scope materialization (effectiveScope), dot-anchored
 * destination matching, wildcard semantics, and host normalization.
 * Semantics are pinned here per docs/egress-scoping-implementation-plan.md
 * §5.7 to avoid implementation drift.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileDestination,
  compileDestinations,
  effectiveScope,
  normalizeHost,
  unmatchedDestinations,
  type RestoreScope,
} from "../src/core/restore-scope.ts";

// ─── effectiveScope materialization ───────────────────────────────────────

test("effectiveScope: no declared scope → null (unconditional restore)", () => {
  assert.equal(effectiveScope({ scope: undefined, realFromEnv: undefined }), null);
  assert.equal(effectiveScope({ scope: undefined, realFromEnv: "K" }), null);
});

test("effectiveScope: declared scope passes mode/onRefuse through verbatim", () => {
  const scope: RestoreScope = { destinations: ["internal.acme.com"], mode: "semi-strict", onRefuse: "ask" };
  assert.deepEqual(
    effectiveScope({ scope, realFromEnv: undefined }),
    { destinations: ["internal.acme.com"], tools: undefined, envNames: undefined, mode: "semi-strict", onRefuse: "ask" },
  );
});

test("effectiveScope: envNames falls back to realFromEnv", () => {
  const scope: RestoreScope = { destinations: ["a.com"], mode: "strict", onRefuse: "block" };
  const effective = effectiveScope({ scope, realFromEnv: "REAL" });
  assert.deepEqual(effective?.envNames, ["REAL"]);
  const explicit: RestoreScope = { destinations: ["a.com"], mode: "strict", onRefuse: "block", envNames: ["OTHER"] };
  assert.deepEqual(effectiveScope({ scope: explicit, realFromEnv: "REAL" })?.envNames, ["OTHER"]);
});

test("effectiveScope: trustedDestinations widen declared destinations", () => {
  const scope: RestoreScope = { destinations: ["my-proxy.corp"], mode: "strict", onRefuse: "block" };
  const effective = effectiveScope({ scope, realFromEnv: undefined, trustedDestinations: ["corp.internal"] });
  assert.deepEqual(effective?.destinations, ["my-proxy.corp", "corp.internal"]);
});

test("effectiveScope: an explicit empty allowlist is absolute (not widened)", () => {
  const scope: RestoreScope = { destinations: [], mode: "semi-strict", onRefuse: "block" };
  const effective = effectiveScope({ scope, realFromEnv: undefined, trustedDestinations: ["corp.internal"] });
  assert.deepEqual(effective?.destinations, [], "the global trusted list must not reopen a never-outbound rule");
});

test("effectiveScope: tools-only scope constrains tools without destination checks", () => {
  const scope = effectiveScope({
    scope: { tools: ["write", "edit"], mode: "permissive", onRefuse: "ask" },
    realFromEnv: undefined,
  });
  assert.deepEqual(scope, { destinations: undefined, tools: ["write", "edit"], envNames: undefined, mode: "permissive", onRefuse: "ask" });
});

// ─── host normalization ──────────────────────────────────────────────────────

test("normalizeHost: lowercase, trailing dot, punycode, decimal IP", () => {
  assert.equal(normalizeHost("API.Stripe.COM."), "api.stripe.com");
  assert.equal(normalizeHost(" Bücher.example "), "xn--bcher-kva.example");
  assert.equal(normalizeHost("2130706433"), "127.0.0.1");
  assert.equal(normalizeHost("0x7F.1"), "127.0.0.1");
  assert.equal(normalizeHost("[::1]"), "::1");
});

test("normalizeHost: rejects wildcards, userinfo, paths, ports", () => {
  assert.equal(normalizeHost("*.internal.acme.com"), null);
  assert.equal(normalizeHost("api.stripe.com@evil.com"), null);
  assert.equal(normalizeHost("evil.com/path"), null);
  assert.equal(normalizeHost("evil.com:8080"), null);
  assert.equal(normalizeHost(""), null);
});

// ─── dot-anchored suffix matching ───────────────────────────────────────────

test("domain entries match the domain and its subdomains, dot-anchored", () => {
  const matcher = compileDestination("stripe.com");
  assert.ok(matcher);
  assert.ok(matcher.test("stripe.com"));
  assert.ok(matcher.test("api.stripe.com"));
  assert.ok(matcher.test("API.STRIPE.com."));
  assert.ok(matcher.test("files.stripe.com"));
  // Suffix tricks must not match
  assert.ok(!matcher.test("stripe.com.evil.com"));
  assert.ok(!matcher.test("evilstripe.com"));
  assert.ok(!matcher.test("stripe.com.evil.com."));
});

test("IP literal entries match exactly after normalization", () => {
  const matcher = compileDestination("127.0.0.1");
  assert.ok(matcher);
  assert.ok(matcher.test("127.0.0.1"));
  assert.ok(matcher.test("2130706433")); // decimal form of 127.0.0.1
  assert.ok(!matcher.test("127.0.0.2"));
  assert.ok(!matcher.test("127.0.0.1.evil.com"));
});

test("leading wildcard matches exactly one label", () => {
  const matcher = compileDestination("*.internal.acme.com");
  assert.ok(matcher);
  assert.ok(matcher.test("web.internal.acme.com"));
  assert.ok(matcher.test("a-b.internal.acme.com"));
  // zero labels or more than one label do not match
  assert.ok(!matcher.test("internal.acme.com"));
  assert.ok(!matcher.test("x.y.internal.acme.com"));
  assert.ok(!matcher.test("internal.acme.com.evil.com"));
});

test("trailing wildcard matches one or more trailing labels", () => {
  const matcher = compileDestination("10.0.*");
  assert.ok(matcher);
  assert.ok(matcher.test("10.0.1"));
  assert.ok(matcher.test("10.0.3.4"));
  assert.ok(matcher.test("10.0.host.internal"));
  assert.ok(!matcher.test("10.0")); // zero remaining labels
  // by the pinned semantics, the trailing wildcard spans any remaining labels
  assert.ok(matcher.test("10.0.1.evil.com"));
});

test("trailing wildcard is dot-anchored at the front", () => {
  const matcher = compileDestination("10.0.*");
  assert.ok(matcher);
  assert.ok(!matcher.test("110.0.1"));
  assert.ok(!matcher.test("9.0.1"));
});

test("invalid entries compile to null and are dropped from lists", () => {
  assert.equal(compileDestination(""), null);
  assert.equal(compileDestination("*"), null);
  assert.equal(compileDestination("a.*.b"), null);
  assert.equal(compileDestination("*.a.*"), null);
  assert.equal(compileDestination("not a host"), null);
  const matchers = compileDestinations(["ok.com", "", "*.*", "10.0.*"]);
  assert.equal(matchers.length, 2);
});

test("unmatchedDestinations reports the offending hosts", () => {
  const matchers = compileDestinations(["stripe.com", "10.0.*"]);
  assert.deepEqual(unmatchedDestinations(["api.stripe.com", "10.0.1.2", "evil.com"], matchers), ["evil.com"]);
  assert.deepEqual(unmatchedDestinations([], matchers), []);
});
