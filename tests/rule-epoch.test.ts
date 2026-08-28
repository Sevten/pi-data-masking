import assert from "node:assert/strict";
import test from "node:test";
import type { ConfiguredMaskingRule, MaskingConfig } from "../config-loader.ts";
import type { LiteralMaskingRule } from "../masker.ts";
import {
  RULE_EPOCH_ENTRY,
  createRuleEpoch,
  restoreRuleEpochs,
  ruleBehaviorFingerprint,
  summarizeEpochNetChanges,
  summarizeRuleChanges,
} from "../rule-epoch.ts";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef", "hex");

function literalConfig(args: {
  real?: string;
  placeholder?: string;
  enabled?: boolean;
  ruleEnabled?: boolean;
  name?: string;
  caseSensitive?: boolean;
} = {}): MaskingConfig {
  const rule: LiteralMaskingRule = {
    id: "token",
    name: args.name ?? "Service token",
    real: args.real ?? "secret-service-token",
    placeholder: args.placeholder ?? "masked-service-token",
    enabled: args.ruleEnabled ?? true,
    description: "operator notes must not be persisted",
  };
  const configured: ConfiguredMaskingRule = {
    rule,
    scope: "project",
    path: "/private/project/config.json",
    sourceIndex: 0,
    enabled: args.ruleEnabled ?? true,
    available: true,
    sourceKind: "literal",
    placeholderMode: "custom",
  };
  return {
    enabled: args.enabled ?? true,
    configuredRules: [configured],
    rules: configured.enabled ? [rule] : [],
    options: {
      caseSensitive: args.caseSensitive ?? true,
      showStatusBar: true,
      systemPromptGuidance: false,
      persistHistory: true,
    },
  };
}

test("behavior fingerprints ignore cosmetic metadata but include emitted behavior", () => {
  const base = literalConfig();
  assert.equal(
    ruleBehaviorFingerprint(base, KEY),
    ruleBehaviorFingerprint(literalConfig({ name: "Renamed in UI" }), KEY),
  );
  assert.notEqual(
    ruleBehaviorFingerprint(base, KEY),
    ruleBehaviorFingerprint(literalConfig({ real: "different-service-token" }), KEY),
  );
  assert.notEqual(
    ruleBehaviorFingerprint(base, KEY),
    ruleBehaviorFingerprint(literalConfig({ placeholder: "different-placeholder" }), KEY),
  );
  assert.notEqual(
    ruleBehaviorFingerprint(base, KEY),
    ruleBehaviorFingerprint(literalConfig({ caseSensitive: false }), KEY),
  );
});

test("disabled configurations with different dormant rules are behaviorally equal", () => {
  assert.equal(
    ruleBehaviorFingerprint(literalConfig({ enabled: false }), KEY),
    ruleBehaviorFingerprint(literalConfig({ enabled: false, real: "another-secret", placeholder: "another-mask" }), KEY),
  );
});

test("epoch metadata and change summaries never persist literal values or config paths", () => {
  const previous = literalConfig();
  const next = literalConfig({ real: "rotated-secret-value", placeholder: "rotated-placeholder" });
  const first = createRuleEpoch({ config: previous, sessionKey: KEY, reason: "session_start", activatedAt: 10 });
  const second = createRuleEpoch({
    config: next,
    previousConfig: previous,
    previousEpoch: first,
    sessionKey: KEY,
    reason: "ui_edit",
    activatedAt: 20,
  });

  assert.equal(second.epochId, 2);
  assert.equal(second.parentEpochId, 1);
  assert.ok(second.changes.some((change) => change.kind === "rule_updated" && change.fields?.includes("match")));
  const serialized = JSON.stringify(second);
  assert.equal(serialized.includes("rotated-secret-value"), false);
  assert.equal(serialized.includes("rotated-placeholder"), false);
  assert.equal(serialized.includes("/private/project/config.json"), false);
  assert.equal(serialized.includes("operator notes must not be persisted"), false);
});

test("factual versions report only final net rule changes", () => {
  const base = literalConfig();
  const changed = literalConfig({ placeholder: "temporary-placeholder" });
  const first = createRuleEpoch({ config: base, sessionKey: KEY, reason: "session_start", activatedAt: 10 });
  const intermediate = createRuleEpoch({
    config: changed,
    previousConfig: base,
    previousEpoch: first,
    sessionKey: KEY,
    reason: "ui_edit",
    activatedAt: 20,
  });
  const reverted = createRuleEpoch({
    config: base,
    previousConfig: changed,
    previousEpoch: intermediate,
    sessionKey: KEY,
    reason: "ui_edit",
    activatedAt: 30,
  });

  assert.ok(first.rules[0]?.behaviorFingerprint);
  assert.notEqual(first.rules[0]?.behaviorFingerprint, intermediate.rules[0]?.behaviorFingerprint);
  assert.deepEqual(summarizeEpochNetChanges(first, reverted), []);
  assert.ok(summarizeEpochNetChanges(first, intermediate).some((change) =>
    change.kind === "rule_updated" && change.ruleId === "token"
  ));
});

test("enable, disable, and rule movement produce sanitized change records", () => {
  const disabled = literalConfig({ ruleEnabled: false });
  const enabled = literalConfig({ ruleEnabled: true });
  const changes = summarizeRuleChanges(disabled, enabled, KEY);
  assert.ok(changes.some((change) => change.kind === "rule_enabled" && change.ruleId === "token"));

  const offChanges = summarizeRuleChanges(enabled, { ...enabled, enabled: false }, KEY);
  assert.ok(offChanges.some((change) => change.kind === "masking_disabled"));

  const secondRule: LiteralMaskingRule = {
    id: "account",
    name: "Account",
    real: "private-account-value",
    placeholder: "masked-account-value",
  };
  const secondConfigured: ConfiguredMaskingRule = {
    rule: secondRule,
    scope: "project",
    path: "/private/project/config.json",
    sourceIndex: 1,
    enabled: true,
    available: true,
    sourceKind: "literal",
    placeholderMode: "custom",
  };
  const beforeMove: MaskingConfig = {
    ...enabled,
    configuredRules: [...enabled.configuredRules, secondConfigured],
    rules: [...enabled.rules, secondRule],
  };
  const afterMove: MaskingConfig = {
    ...beforeMove,
    configuredRules: [secondConfigured, ...enabled.configuredRules],
    rules: [secondRule, ...enabled.rules],
  };
  const moveChanges = summarizeRuleChanges(beforeMove, afterMove, KEY);
  assert.ok(moveChanges.some((change) => change.kind === "rule_moved" && change.ruleId === "account"));
});

test("restoration keeps a monotonic immutable epoch chain and rejects regressions", () => {
  const first = createRuleEpoch({ config: literalConfig(), sessionKey: KEY, reason: "session_start", activatedAt: 10 });
  const second = createRuleEpoch({
    config: literalConfig({ enabled: false }),
    previousConfig: literalConfig(),
    previousEpoch: first,
    sessionKey: KEY,
    reason: "toggle",
    activatedAt: 20,
  });
  const legacyFirst = {
    ...first,
    rules: first.rules.map(({ behaviorFingerprint: _fingerprint, ...rule }) => rule),
  };
  const restored = restoreRuleEpochs([
    { type: "custom", customType: RULE_EPOCH_ENTRY, data: legacyFirst },
    { type: "custom", customType: RULE_EPOCH_ENTRY, data: second },
    { type: "custom", customType: RULE_EPOCH_ENTRY, data: first },
    { type: "custom", customType: RULE_EPOCH_ENTRY, data: { ...second, epochId: 4, parentEpochId: 99 } },
  ]);
  assert.deepEqual(restored.map((epoch) => epoch.epochId), [1, 2]);
});
