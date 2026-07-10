import { EXIT, RigorError } from "./errors.js";
import { normalizeRepoPath } from "./paths.js";
import { record, strings, taskId, textField } from "./util.js";
import {
  INTENT_SCHEMA,
  POLICY_SCHEMA,
  type Check,
  type Intent,
  type Policy,
  type RiskTier,
  type Rule,
} from "./types.js";

const tiers: RiskTier[] = ["low", "medium", "high", "critical"];

function tier(value: unknown, name: string): RiskTier {
  if (typeof value !== "string" || !tiers.includes(value as RiskTier)) {
    throw new RigorError(`${name} must be a valid risk tier`, EXIT.inputError);
  }
  return value as RiskTier;
}

function bool(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean")
    throw new RigorError(`${name} must be boolean`, EXIT.inputError);
  return value;
}

function parseRule(value: unknown, index: number): Rule {
  const item = record(value, `rules[${index}]`);
  const rule: Rule = {
    id: textField(item.id, `rules[${index}].id`, 128),
    paths: strings(item.paths, `rules[${index}].paths`).map(normalizeRepoPath),
    tier: tier(item.tier, `rules[${index}].tier`),
    reason: textField(item.reason, `rules[${index}].reason`, 1000),
  };
  const protectedValue = bool(item.protected, `rules[${index}].protected`);
  const deny = bool(
    item.denyExternalTransmission,
    `rules[${index}].denyExternalTransmission`,
  );
  const approval = bool(
    item.requireHumanApproval,
    `rules[${index}].requireHumanApproval`,
  );
  if (protectedValue !== undefined) rule.protected = protectedValue;
  if (deny !== undefined) rule.denyExternalTransmission = deny;
  if (approval !== undefined) rule.requireHumanApproval = approval;
  return rule;
}

function parseCheck(value: unknown, index: number): Check {
  const item = record(value, `checks[${index}]`);
  const timeout = item.timeoutMs;
  if (
    !Number.isInteger(timeout) ||
    (timeout as number) < 100 ||
    (timeout as number) > 900_000
  ) {
    throw new RigorError(
      `checks[${index}].timeoutMs is out of range`,
      EXIT.inputError,
    );
  }
  return {
    id: textField(item.id, `checks[${index}].id`, 128),
    command: textField(item.command, `checks[${index}].command`, 512),
    args: strings(item.args, `checks[${index}].args`, 100),
    tiers: strings(item.tiers, `checks[${index}].tiers`, 4).map((v) =>
      tier(v, "check tier"),
    ),
    timeoutMs: timeout as number,
  };
}

export function parsePolicy(value: unknown): Policy {
  const item = record(value, "policy");
  if (item.schemaVersion !== POLICY_SCHEMA)
    throw new RigorError(`Unsupported policy schemaVersion`, EXIT.inputError);
  if (
    item.defaultExternalTransmission !== "allow" &&
    item.defaultExternalTransmission !== "deny"
  ) {
    throw new RigorError(
      "Invalid defaultExternalTransmission",
      EXIT.inputError,
    );
  }
  if (!Array.isArray(item.rules) || !Array.isArray(item.checks))
    throw new RigorError("rules and checks are required", EXIT.inputError);
  const stops = record(item.stopConditions, "stopConditions");
  const ci = record(item.ci, "ci");
  if (
    typeof ci.requireEvidence !== "boolean" ||
    ci.maxPolicyWeakening !== "none"
  ) {
    throw new RigorError("Invalid ci policy", EXIT.inputError);
  }
  const policy: Policy = {
    schemaVersion: POLICY_SCHEMA,
    repositoryId: textField(item.repositoryId, "repositoryId", 256),
    defaultTier: tier(item.defaultTier, "defaultTier"),
    defaultExternalTransmission: item.defaultExternalTransmission,
    rules: item.rules.map(parseRule),
    checks: item.checks.map(parseCheck),
    stopConditions: {
      low: strings(stops.low, "stopConditions.low"),
      medium: strings(stops.medium, "stopConditions.medium"),
      high: strings(stops.high, "stopConditions.high"),
      critical: strings(stops.critical, "stopConditions.critical"),
    },
    ci: { requireEvidence: ci.requireEvidence, maxPolicyWeakening: "none" },
  };
  const ids = [
    ...policy.rules.map((r) => r.id),
    ...policy.checks.map((c) => c.id),
  ];
  if (new Set(ids).size !== ids.length)
    throw new RigorError("Rule and check IDs must be unique", EXIT.inputError);
  return policy;
}

export function parseIntent(value: unknown): Intent {
  const item = record(value, "intent");
  if (item.schemaVersion !== INTENT_SCHEMA)
    throw new RigorError("Unsupported intent schemaVersion", EXIT.inputError);
  const result: Intent = {
    schemaVersion: INTENT_SCHEMA,
    taskId: taskId(item.taskId),
    summary: textField(item.summary, "summary", 2000),
    plannedPaths: strings(item.plannedPaths, "plannedPaths").map(
      normalizeRepoPath,
    ),
  };
  if (item.operations !== undefined)
    result.operations = strings(item.operations, "operations", 100);
  return result;
}
