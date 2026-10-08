/**
 * tests/audit-log.test.ts
 * Phase 3: audit event persistence (parse/replay) and marker registry
 * snapshot round-trips per docs/egress-scoping-implementation-plan.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_ENTRY,
  MARKERS_ENTRY,
  buildMarkerSnapshot,
  loadAuditEvents,
  loadMarkerSnapshot,
  parseAuditEvent,
  parseMarkerSnapshot,
  type AuditEvent,
} from "../src/history/audit-log.ts";
import { createFileMarkerRegistry, normalizePath } from "../src/core/file-markers.ts";

const CWD = "/srv/app";

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  at: 1760000000000,
  kind: "blocked",
  ruleId: "stripe-key",
  ruleName: "Stripe key",
  tool: "bash",
  ...overrides,
});

function entry(customType: string, data: unknown) {
  return { type: "custom", customType, data };
}

// ── audit events ────────────────────────────────────────────────────────────

test("parseAuditEvent: valid event round-trips", () => {
  const e = event({ destinations: ["evil.com"], detail: "paths: /srv/app/config.yaml" });
  assert.deepEqual(parseAuditEvent(structuredClone(e)), e);
});

test("parseAuditEvent: rejects wrong shapes", () => {
  assert.equal(parseAuditEvent({}), undefined);
  assert.equal(parseAuditEvent(event({ at: "x" as never })), undefined);
  assert.equal(parseAuditEvent(event({ kind: "nope" as never })), undefined);
  assert.equal(parseAuditEvent(event({ destinations: ["ok", 3] as never })), undefined);
  assert.equal(parseAuditEvent(event({ detail: 5 as never })), undefined);
  assert.equal(parseAuditEvent(null), undefined);
  assert.equal(parseAuditEvent([1]), undefined);
});

test("loadAuditEvents: replays in order, skips foreign/broken entries", () => {
  const good1 = event({ kind: "restored" });
  const good2 = event({ kind: "held", destinations: ["evil.com"] });
  const events = loadAuditEvents([
    entry("other.extension", {}),
    entry(AUDIT_ENTRY, good1),
    entry(AUDIT_ENTRY, { broken: true }),
    entry(AUDIT_ENTRY, good2),
  ]);
  assert.deepEqual(events, [parseAuditEvent(good1), parseAuditEvent(good2)]);
});

// ── marker snapshots ────────────────────────────────────────────────────────

test("marker snapshot: registry → snapshot → restored registry round-trip", () => {
  const source = createFileMarkerRegistry();
  source.mark("config.yaml", CWD, new Set(["a", "b"]));
  source.mark("~/.env", CWD, new Set(["c"]));

  const snapshot = buildMarkerSnapshot(
    new Map(source.markedPaths().map((path) => [path, source.ruleIdsFor(path, CWD)])),
  );
  const parsed = parseMarkerSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.ok(parsed);

  const target = createFileMarkerRegistry();
  target.restore(parsed.markers);
  assert.deepEqual([...target.ruleIdsFor("/srv/app/config.yaml", CWD)].sort(), ["a", "b"]);
  assert.deepEqual([...target.ruleIdsFor(normalizePath("~/.env", CWD), CWD)], ["c"]);
});

test("parseMarkerSnapshot: rejects malformed snapshots", () => {
  assert.equal(parseMarkerSnapshot({ version: 2 }), undefined);
  assert.equal(parseMarkerSnapshot({ version: 1, markers: "x" }), undefined);
  assert.equal(parseMarkerSnapshot({ version: 1, markers: { "/a": "not-array" } }), undefined);
  assert.equal(parseMarkerSnapshot({ version: 1, markers: { "/a": [1] } }), undefined);
  assert.equal(parseMarkerSnapshot({ version: 1, markers: { "": ["a"] } }), undefined);
});

test("loadMarkerSnapshot: returns the latest valid snapshot", () => {
  const older = { version: 1 as const, markers: { "/a": ["x"] } };
  const newer = { version: 1 as const, markers: { "/b": ["y"] } };
  const loaded = loadMarkerEventsHelper([
    entry(MARKERS_ENTRY, older),
    entry(MARKERS_ENTRY, { garbage: 1 }),
    entry(MARKERS_ENTRY, newer),
  ]);
  assert.deepEqual(loaded, newer);
});

function loadMarkerEventsHelper(entries: ReturnType<typeof entry>[]) {
  return loadMarkerSnapshot(entries);
}
