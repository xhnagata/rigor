import { EXIT, RigorError } from "./errors.js";
import {
  CONSULTATION_DECISION_INPUT_SCHEMA,
  CONSULTATION_DECISION_SCHEMA,
  type AssessmentConfidence,
  type AvailabilityState,
  type ConsultationDecision,
  type ConsultationDecisionInput,
  type ConsultationTriggerReason,
  type RiskTier,
  type Transmission,
} from "./types.js";
import { hash, record, taskId } from "./util.js";

const risks: RiskTier[] = ["low", "medium", "high", "critical"];
const confidences: AssessmentConfidence[] = ["low", "medium", "high"];
const progress = ["none", "changed", "unchanged"] as const;
const availability: AvailabilityState[] = [
  "available",
  "unavailable",
  "unknown",
  "incompatible",
];
const unavailableActions = ["skip", "stop", "continue-claude-only"] as const;

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value as T;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new RigorError(`${name} must be boolean`, EXIT.inputError);
  return value;
}

function integer(value: unknown, name: string, minimum: number): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > 20
  )
    throw new RigorError(`${name} is out of range`, EXIT.inputError);
  return value as number;
}

function exactKeys(
  item: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const unexpected = Object.keys(item).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    throw new RigorError(
      `${name} contains unsupported fields: ${unexpected.join(", ")}`,
      EXIT.inputError,
    );
}

export function parseConsultationDecisionInput(
  value: unknown,
): ConsultationDecisionInput {
  const item = record(value, "consultation decision input");
  if (item.schemaVersion !== CONSULTATION_DECISION_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported consultation decision input schema",
      EXIT.inputError,
    );
  exactKeys(
    item,
    [
      "schemaVersion",
      "taskId",
      "riskTier",
      "assessmentConfidence",
      "failureProgress",
      "fingerprintRepetitions",
      "concerns",
      "humanRequested",
      "externalTransmission",
      "pluginAvailability",
      "policy",
    ],
    "consultation decision input",
  );
  const concerns = record(item.concerns, "concerns");
  const policy = record(item.policy, "policy");
  exactKeys(concerns, ["security", "dataIntegrity"], "concerns");
  exactKeys(
    policy,
    ["unchangedFailureThreshold", "unavailableAction"],
    "policy",
  );
  return {
    schemaVersion: CONSULTATION_DECISION_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    riskTier: oneOf(item.riskTier, risks, "riskTier"),
    assessmentConfidence: oneOf(
      item.assessmentConfidence,
      confidences,
      "assessmentConfidence",
    ),
    failureProgress: oneOf(item.failureProgress, progress, "failureProgress"),
    fingerprintRepetitions: integer(
      item.fingerprintRepetitions,
      "fingerprintRepetitions",
      0,
    ),
    concerns: {
      security: bool(concerns.security, "concerns.security"),
      dataIntegrity: bool(concerns.dataIntegrity, "concerns.dataIntegrity"),
    },
    humanRequested: bool(item.humanRequested, "humanRequested"),
    externalTransmission: oneOf(
      item.externalTransmission,
      ["allowed", "denied"] satisfies Transmission[],
      "externalTransmission",
    ),
    pluginAvailability: oneOf(
      item.pluginAvailability,
      availability,
      "pluginAvailability",
    ),
    policy: {
      unchangedFailureThreshold: integer(
        policy.unchangedFailureThreshold,
        "policy.unchangedFailureThreshold",
        2,
      ),
      unavailableAction: oneOf(
        policy.unavailableAction,
        unavailableActions,
        "policy.unavailableAction",
      ),
    },
  };
}

function triggers(
  input: ConsultationDecisionInput,
): ConsultationTriggerReason[] {
  const result: ConsultationTriggerReason[] = [];
  // Fixed ordering is part of the artifact contract and makes multi-trigger
  // decisions stable across runs.
  if (input.riskTier === "high") result.push("HIGH_RISK");
  if (input.riskTier === "critical") result.push("CRITICAL_RISK");
  if (input.assessmentConfidence === "low")
    result.push("LOW_ASSESSMENT_CONFIDENCE");
  if (
    input.failureProgress === "unchanged" &&
    input.fingerprintRepetitions >= input.policy.unchangedFailureThreshold
  )
    result.push("REPEATED_UNCHANGED_FAILURE");
  if (input.concerns.security) result.push("SECURITY_CONCERN");
  if (input.concerns.dataIntegrity) result.push("DATA_INTEGRITY_CONCERN");
  if (input.humanRequested) result.push("HUMAN_REQUEST");
  return result;
}

function decision(
  input: ConsultationDecisionInput,
  result: Omit<
    ConsultationDecision,
    | "schemaVersion"
    | "taskId"
    | "inputHash"
    | "pluginAvailability"
    | "externalTransmission"
    | "approvalEffect"
  >,
): ConsultationDecision {
  return {
    schemaVersion: CONSULTATION_DECISION_SCHEMA,
    taskId: input.taskId,
    inputHash: hash(input),
    pluginAvailability: input.pluginAvailability,
    externalTransmission: input.externalTransmission,
    ...result,
    // Last so no spread value can ever widen the decision into an approval.
    approvalEffect: "none",
  };
}

/** Pure selector: it performs no I/O, provider call, clock read, or mutation. */
export function selectConsultation(
  input: ConsultationDecisionInput,
): ConsultationDecision {
  // Security-significant order: transmission denial is a hard prerequisite and
  // is evaluated before trigger or availability logic can request invocation.
  if (input.externalTransmission === "denied")
    return decision(input, {
      decision: "continue-claude-only",
      reasonCode: "EXTERNAL_TRANSMISSION_DENIED",
      triggerReasons: triggers(input),
      invocationAllowed: false,
    });

  const triggerReasons = triggers(input);
  if (triggerReasons.length === 0)
    return decision(input, {
      decision: "skip-independent-review",
      reasonCode: "NO_REVIEW_TRIGGER",
      triggerReasons,
      invocationAllowed: false,
    });

  if (input.pluginAvailability === "available")
    return decision(input, {
      decision: "request-independent-review",
      reasonCode: "REVIEW_TRIGGERED",
      triggerReasons,
      invocationAllowed: true,
    });

  if (input.policy.unavailableAction === "stop")
    return decision(input, {
      decision: "stop-required-review",
      reasonCode: "REQUIRED_REVIEW_PLUGIN_UNAVAILABLE",
      triggerReasons,
      invocationAllowed: false,
    });
  if (input.policy.unavailableAction === "continue-claude-only")
    return decision(input, {
      decision: "continue-claude-only",
      reasonCode: "CLAUDE_ONLY_PLUGIN_UNAVAILABLE",
      triggerReasons,
      invocationAllowed: false,
    });
  return decision(input, {
    decision: "skip-independent-review",
    reasonCode: "OPTIONAL_REVIEW_PLUGIN_UNAVAILABLE",
    triggerReasons,
    invocationAllowed: false,
  });
}
