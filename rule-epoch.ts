import { createHmac } from "node:crypto";
import type { ConfiguredMaskingRule, MaskingConfig } from "./config-loader.ts";
import { isRegexRule, type MaskingRule } from "./masker.ts";

export const RULE_EPOCH_ENTRY = "pi-data-masking.rule-epoch.v1";

export type RuleEpochReason = "session_start" | "ui_edit" | "file_reload" | "toggle";

export interface RuleEpochRuleMetadata {
  key: string;
  id: string;
  name: string;
  scope: "project" | "global";
  sourceKind: "literal" | "regex" | "preset";
  enabled: boolean;
  available: boolean;
  order: number;
  /** Opaque equality token for the rule's effective matching/replacement behavior. */
  behaviorFingerprint?: string;
}

export type RuleEpochChangeKind =
  | "initialized"
  | "masking_enabled"
  | "masking_disabled"
  | "option_changed"
  | "rule_added"
  | "rule_removed"
  | "rule_enabled"
  | "rule_disabled"
  | "rule_moved"
  | "rule_updated"
  | "configuration_changed";

export interface RuleEpochChange {
  kind: RuleEpochChangeKind;
  ruleKey?: string;
  ruleId?: string;
  ruleName?: string;
  option?: "caseSensitive" | "systemPromptGuidance";
  fields?: string[];
  fromOrder?: number;
  toOrder?: number;
}

export interface RuleEpoch {
  version: 1;
  epochId: number;
  parentEpochId?: number;
  activatedAt: number;
  behaviorFingerprint: string;
  enabled: boolean;
  caseSensitive: boolean;
  systemPromptGuidance: boolean;
  reason: RuleEpochReason;
  rules: RuleEpochRuleMetadata[];
  changes: RuleEpochChange[];
}

interface SessionEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

interface RuleDescriptor {
  metadata: RuleEpochRuleMetadata;
  fields: Record<string, string>;
}

function keyedDigest(sessionKey: Buffer, value: unknown): string {
  return createHmac("sha256", sessionKey).update(JSON.stringify(value)).digest("hex");
}

function behaviorRule(rule: MaskingRule): Record<string, unknown> {
  if (isRegexRule(rule)) {
    return {
      type: "regex",
      id: rule.id,
      pattern: rule.pattern,
      flags: rule.flags ?? null,
      preserveStructure: rule.preserveStructure ?? null,
    };
  }
  return {
    type: "literal",
    id: rule.id,
    real: rule.real,
    placeholder: rule.placeholder ?? null,
    preserveStructure: rule.preserveStructure ?? null,
  };
}

/** Session-keyed equality fingerprint; the persisted value never contains rule secrets. */
export function ruleBehaviorFingerprint(config: MaskingConfig, sessionKey: Buffer): string {
  const behavior = config.enabled
    ? {
        enabled: true,
        caseSensitive: config.options.caseSensitive,
        systemPromptGuidance: config.options.systemPromptGuidance,
        rules: config.rules.map(behaviorRule),
      }
    : { enabled: false };
  return keyedDigest(sessionKey, behavior);
}

function displayName(configured: ConfiguredMaskingRule): string {
  return configured.rule.name?.trim()
    || configured.rule.id;
}

function descriptor(configured: ConfiguredMaskingRule, order: number, sessionKey: Buffer): RuleDescriptor {
  const rule = configured.rule;
  const fields: Record<string, string> = {
    type: isRegexRule(rule) ? "regex" : "literal",
    sourceKind: configured.sourceKind,
    match: keyedDigest(sessionKey, isRegexRule(rule) ? rule.pattern : rule.real),
    flags: keyedDigest(sessionKey, isRegexRule(rule) ? rule.flags ?? null : null),
    placeholder: keyedDigest(sessionKey, isRegexRule(rule) ? null : rule.placeholder ?? null),
    preserveStructure: keyedDigest(sessionKey, rule.preserveStructure ?? null),
  };
  return {
    metadata: {
      key: `${configured.scope}:${rule.id}`,
      id: rule.id,
      name: displayName(configured),
      scope: configured.scope,
      sourceKind: configured.sourceKind,
      enabled: configured.enabled,
      available: configured.available,
      order,
      behaviorFingerprint: keyedDigest(sessionKey, behaviorRule(rule)),
    },
    fields,
  };
}

function descriptors(config: MaskingConfig, sessionKey: Buffer): RuleDescriptor[] {
  return config.configuredRules.map((configured, order) => descriptor(configured, order, sessionKey));
}

export function summarizeRuleChanges(
  previous: MaskingConfig | undefined,
  next: MaskingConfig,
  sessionKey: Buffer,
): RuleEpochChange[] {
  if (!previous) return [{ kind: "initialized" }];

  const changes: RuleEpochChange[] = [];
  if (previous.enabled !== next.enabled) {
    changes.push({ kind: next.enabled ? "masking_enabled" : "masking_disabled" });
  }
  if (previous.options.caseSensitive !== next.options.caseSensitive) {
    changes.push({ kind: "option_changed", option: "caseSensitive" });
  }
  if (previous.options.systemPromptGuidance !== next.options.systemPromptGuidance) {
    changes.push({ kind: "option_changed", option: "systemPromptGuidance" });
  }

  const before = new Map(descriptors(previous, sessionKey).map((item) => [item.metadata.key, item]));
  const after = new Map(descriptors(next, sessionKey).map((item) => [item.metadata.key, item]));

  for (const [key, oldRule] of before) {
    if (after.has(key)) continue;
    changes.push({
      kind: "rule_removed",
      ruleKey: key,
      ruleId: oldRule.metadata.id,
      ruleName: oldRule.metadata.name,
    });
  }

  for (const [key, newRule] of after) {
    const oldRule = before.get(key);
    if (!oldRule) {
      changes.push({
        kind: "rule_added",
        ruleKey: key,
        ruleId: newRule.metadata.id,
        ruleName: newRule.metadata.name,
      });
      continue;
    }
    if (oldRule.metadata.enabled !== newRule.metadata.enabled) {
      changes.push({
        kind: newRule.metadata.enabled ? "rule_enabled" : "rule_disabled",
        ruleKey: key,
        ruleId: newRule.metadata.id,
        ruleName: newRule.metadata.name,
      });
    }
    if (oldRule.metadata.order !== newRule.metadata.order) {
      changes.push({
        kind: "rule_moved",
        ruleKey: key,
        ruleId: newRule.metadata.id,
        ruleName: newRule.metadata.name,
        fromOrder: oldRule.metadata.order,
        toOrder: newRule.metadata.order,
      });
    }
    const changedFields = Object.keys(newRule.fields).filter((field) => oldRule.fields[field] !== newRule.fields[field]);
    if (oldRule.metadata.available !== newRule.metadata.available) changedFields.push("availability");
    if (changedFields.length > 0) {
      changes.push({
        kind: "rule_updated",
        ruleKey: key,
        ruleId: newRule.metadata.id,
        ruleName: newRule.metadata.name,
        fields: changedFields,
      });
    }
  }

  return changes.length > 0 ? changes : [{ kind: "configuration_changed" }];
}

export function summarizeEpochNetChanges(previous: RuleEpoch, next: RuleEpoch): RuleEpochChange[] {
  const changes: RuleEpochChange[] = [];
  if (previous.enabled !== next.enabled) {
    changes.push({ kind: next.enabled ? "masking_enabled" : "masking_disabled" });
  }
  if (previous.caseSensitive !== next.caseSensitive) {
    changes.push({ kind: "option_changed", option: "caseSensitive" });
  }
  if (previous.systemPromptGuidance !== next.systemPromptGuidance) {
    changes.push({ kind: "option_changed", option: "systemPromptGuidance" });
  }

  const before = new Map(previous.rules.map((rule) => [rule.key, rule]));
  const after = new Map(next.rules.map((rule) => [rule.key, rule]));
  let hasUncomparableRule = false;

  for (const [key, oldRule] of before) {
    if (after.has(key)) continue;
    changes.push({
      kind: "rule_removed",
      ruleKey: key,
      ruleId: oldRule.id,
      ruleName: oldRule.name,
    });
  }

  for (const [key, newRule] of after) {
    const oldRule = before.get(key);
    if (!oldRule) {
      changes.push({
        kind: "rule_added",
        ruleKey: key,
        ruleId: newRule.id,
        ruleName: newRule.name,
      });
      continue;
    }
    if (oldRule.enabled !== newRule.enabled) {
      changes.push({
        kind: newRule.enabled ? "rule_enabled" : "rule_disabled",
        ruleKey: key,
        ruleId: newRule.id,
        ruleName: newRule.name,
      });
    }
    if (oldRule.order !== newRule.order) {
      changes.push({
        kind: "rule_moved",
        ruleKey: key,
        ruleId: newRule.id,
        ruleName: newRule.name,
        fromOrder: oldRule.order,
        toOrder: newRule.order,
      });
    }
    const availabilityChanged = oldRule.available !== newRule.available;
    let behaviorChanged = false;
    if (oldRule.behaviorFingerprint !== undefined && newRule.behaviorFingerprint !== undefined) {
      behaviorChanged = oldRule.behaviorFingerprint !== newRule.behaviorFingerprint;
    } else {
      hasUncomparableRule = true;
    }
    if (availabilityChanged || behaviorChanged) {
      changes.push({
        kind: "rule_updated",
        ruleKey: key,
        ruleId: newRule.id,
        ruleName: newRule.name,
        fields: availabilityChanged ? ["availability"] : undefined,
      });
    }
  }

  // Old persisted epochs have no per-rule fingerprints. Their global token can
  // prove that some final behavior differs, but cannot safely attribute it.
  if (
    previous.behaviorFingerprint !== next.behaviorFingerprint &&
    previous.enabled && next.enabled &&
    hasUncomparableRule
  ) {
    changes.push({ kind: "configuration_changed" });
  }
  if (changes.length === 0 && previous.behaviorFingerprint !== next.behaviorFingerprint) {
    changes.push({ kind: "configuration_changed" });
  }
  return changes;
}

export function createRuleEpoch(args: {
  config: MaskingConfig;
  previousConfig?: MaskingConfig;
  previousEpoch?: RuleEpoch;
  sessionKey: Buffer;
  reason: RuleEpochReason;
  activatedAt?: number;
}): RuleEpoch {
  const { config, previousConfig, previousEpoch, sessionKey, reason } = args;
  return {
    version: 1,
    epochId: (previousEpoch?.epochId ?? 0) + 1,
    parentEpochId: previousEpoch?.epochId,
    activatedAt: args.activatedAt ?? Date.now(),
    behaviorFingerprint: ruleBehaviorFingerprint(config, sessionKey),
    enabled: config.enabled,
    caseSensitive: config.options.caseSensitive,
    systemPromptGuidance: config.options.systemPromptGuidance,
    reason,
    rules: descriptors(config, sessionKey).map(({ metadata }) => metadata),
    changes: previousEpoch && !previousConfig
      ? [{ kind: "configuration_changed" }]
      : summarizeRuleChanges(previousConfig, config, sessionKey),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRuleMetadata(value: unknown): RuleEpochRuleMetadata | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.key !== "string" ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    (value.scope !== "project" && value.scope !== "global") ||
    (value.sourceKind !== "literal" && value.sourceKind !== "regex" && value.sourceKind !== "preset") ||
    typeof value.enabled !== "boolean" ||
    typeof value.available !== "boolean" ||
    typeof value.order !== "number" || !Number.isInteger(value.order) || value.order < 0 ||
    (value.behaviorFingerprint !== undefined && typeof value.behaviorFingerprint !== "string")
  ) return undefined;
  return value as unknown as RuleEpochRuleMetadata;
}

function parseChange(value: unknown): RuleEpochChange | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  const kinds: RuleEpochChangeKind[] = [
    "initialized", "masking_enabled", "masking_disabled", "option_changed",
    "rule_added", "rule_removed", "rule_enabled", "rule_disabled", "rule_moved",
    "rule_updated", "configuration_changed",
  ];
  if (!kinds.includes(value.kind as RuleEpochChangeKind)) return undefined;
  if (value.fields !== undefined && (!Array.isArray(value.fields) || value.fields.some((field) => typeof field !== "string"))) return undefined;
  return {
    kind: value.kind as RuleEpochChangeKind,
    ruleKey: typeof value.ruleKey === "string" ? value.ruleKey : undefined,
    ruleId: typeof value.ruleId === "string" ? value.ruleId : undefined,
    ruleName: typeof value.ruleName === "string" ? value.ruleName : undefined,
    option: value.option === "caseSensitive" || value.option === "systemPromptGuidance" ? value.option : undefined,
    fields: value.fields as string[] | undefined,
    fromOrder: typeof value.fromOrder === "number" && Number.isInteger(value.fromOrder) ? value.fromOrder : undefined,
    toOrder: typeof value.toOrder === "number" && Number.isInteger(value.toOrder) ? value.toOrder : undefined,
  };
}

export function parseRuleEpoch(value: unknown): RuleEpoch | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (
    typeof value.epochId !== "number" || !Number.isInteger(value.epochId) || value.epochId < 1 ||
    (value.parentEpochId !== undefined && (typeof value.parentEpochId !== "number" || !Number.isInteger(value.parentEpochId) || value.parentEpochId < 1)) ||
    typeof value.activatedAt !== "number" || !Number.isFinite(value.activatedAt) ||
    typeof value.behaviorFingerprint !== "string" ||
    typeof value.enabled !== "boolean" ||
    typeof value.caseSensitive !== "boolean" ||
    typeof value.systemPromptGuidance !== "boolean" ||
    (value.reason !== "session_start" && value.reason !== "ui_edit" && value.reason !== "file_reload" && value.reason !== "toggle") ||
    !Array.isArray(value.rules) || !Array.isArray(value.changes)
  ) return undefined;
  const rules = value.rules.map(parseRuleMetadata);
  const changes = value.changes.map(parseChange);
  if (rules.some((rule) => rule === undefined) || changes.some((change) => change === undefined)) return undefined;
  return {
    version: 1,
    epochId: value.epochId,
    parentEpochId: value.parentEpochId as number | undefined,
    activatedAt: value.activatedAt,
    behaviorFingerprint: value.behaviorFingerprint,
    enabled: value.enabled,
    caseSensitive: value.caseSensitive,
    systemPromptGuidance: value.systemPromptGuidance,
    reason: value.reason,
    rules: rules as RuleEpochRuleMetadata[],
    changes: changes as RuleEpochChange[],
  };
}

/** Restore valid immutable epoch records in branch order, ignoring duplicates and regressions. */
export function restoreRuleEpochs(entries: readonly SessionEntryLike[]): RuleEpoch[] {
  const epochs: RuleEpoch[] = [];
  let lastId = 0;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== RULE_EPOCH_ENTRY) continue;
    const epoch = parseRuleEpoch(entry.data);
    if (!epoch || epoch.epochId <= lastId) continue;
    if (epoch.parentEpochId !== undefined && epoch.parentEpochId !== lastId) continue;
    epochs.push(epoch);
    lastId = epoch.epochId;
  }
  return epochs;
}
