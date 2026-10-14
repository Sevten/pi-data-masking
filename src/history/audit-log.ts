/**
 * audit-log.ts
 * Session-persisted audit trail of restoration decisions and the persisted
 * form of the file-marker registry (Phase 3, docs/egress-scoping-design.md
 * "Notifications and audit").
 *
 * Both use one custom session entry per write, following the existing
 * RULE_EPOCH_ENTRY / SNAPSHOT_ENTRY pattern: entries are append-only facts;
 * restoring a session replays them into in-memory state. Nothing in the
 * entries is secret — events carry rule names, destinations, and paths,
 * never real values.
 */

import type { SessionEntryLike } from "./history-persistence.ts";

export const AUDIT_ENTRY = "pi-data-masking.audit.v1";
export const MARKERS_ENTRY = "pi-data-masking.markers.v1";

export type AuditEventKind =
  /** The real value was released into the call. */
  | "restored"
  /** The call was refused; the real value did not leave. */
  | "blocked"
  /** Annotation, not a decision: the call ran, nothing new was released —
   *  the entry marks where the marker chain's observability ends. */
  | "warning";

/** Why the decision was what it was — the matrix row the call fell in.
 *  Orthogonal to the kind (the outcome); the explanation line renders it. */
export type AuditBasis =
  | "verified"
  | "unverifiable"
  | "violation"
  | "local"
  | "consumer"
  | "user-approved"
  | "user-declined"
  | "session-granted";

export interface AuditEvent {
  /** Date.now() at the decision. */
  at: number;
  /** Outcome: what happened to the value. */
  kind: AuditEventKind;
  /** Reason: which situation the call fell in (matrix row). */
  basis: AuditBasis;
  ruleId: string;
  ruleName: string;
  tool: string;
  /** Destinations involved: offending (blocked) or matched
   *  (restored); empty when the trigger was destination-less intent. */
  destinations?: string[];
  /** Free-form context: marked path(s), reason summary. */
  detail?: string;
  /** The tool call this decision fired on. Lets the audit view jump to the
   *  matching transcript entry (`tool:<callId>`). Nested sub-tool calls carry
   *  an id that never appears in the transcript; the jump reports that. */
  callId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KINDS: readonly AuditEventKind[] = [
  "restored",
  "blocked",
  "warning",
];

const BASES: readonly AuditBasis[] = [
  "verified",
  "unverifiable",
  "violation",
  "local",
  "consumer",
  "user-approved",
  "user-declined",
  "session-granted",
];

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value as string[];
}

export function parseAuditEvent(value: unknown): AuditEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.at !== "number") return undefined;
  if (typeof value.kind !== "string" || !KINDS.includes(value.kind as AuditEventKind)) return undefined;
  if (typeof value.basis !== "string" || !BASES.includes(value.basis as AuditBasis)) return undefined;
  if (typeof value.ruleId !== "string" || typeof value.ruleName !== "string") return undefined;
  if (typeof value.tool !== "string") return undefined;
  if (typeof value.callId !== "string") return undefined;
  const destinations = value.destinations === undefined ? undefined : asStringArray(value.destinations);
  if (value.destinations !== undefined && destinations === undefined) return undefined;
  if (value.detail !== undefined && typeof value.detail !== "string") return undefined;
  const parsed: AuditEvent = {
    at: value.at,
    kind: value.kind as AuditEventKind,
    basis: value.basis as AuditBasis,
    ruleId: value.ruleId,
    ruleName: value.ruleName,
    tool: value.tool,
    destinations,
    detail: value.detail as string | undefined,
    callId: value.callId,
  };
  return parsed;
}

/** Replay audit entries from a session branch, in order. */
export function loadAuditEvents(entries: readonly SessionEntryLike[]): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== AUDIT_ENTRY) continue;
    const event = parseAuditEvent(entry.data);
    if (event) events.push(event);
  }
  return events;
}

// ── Marker registry persistence ─────────────────────────────────────────────

export interface MarkerSnapshot {
  version: 1;
  /** Path → governing rule ids. Absolute, normalized paths. */
  markers: Record<string, string[]>;
}

export function buildMarkerSnapshot(markers: ReadonlyMap<string, ReadonlySet<string>>): MarkerSnapshot {
  const record: Record<string, string[]> = {};
  for (const [path, ruleIds] of markers) record[path] = [...ruleIds];
  return { version: 1, markers: record };
}

export function parseMarkerSnapshot(value: unknown): MarkerSnapshot | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.markers)) return undefined;
  const markers: Record<string, string[]> = {};
  for (const [path, ruleIds] of Object.entries(value.markers)) {
    const ids = asStringArray(ruleIds);
    if (!ids || typeof path !== "string" || path.length === 0) return undefined;
    markers[path] = ids;
  }
  return { version: 1, markers };
}

/** Latest marker snapshot from a session branch, if any. */
export function loadMarkerSnapshot(entries: readonly SessionEntryLike[]): MarkerSnapshot | undefined {
  let latest: MarkerSnapshot | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== MARKERS_ENTRY) continue;
    const snapshot = parseMarkerSnapshot(entry.data);
    if (snapshot) latest = snapshot;
  }
  return latest;
}
