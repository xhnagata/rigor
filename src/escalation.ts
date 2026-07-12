import { EXIT, RigorError } from "./errors.js";
import {
  ESCALATION_DECISION_INPUT_SCHEMA,
  ESCALATION_DECISION_SCHEMA,
  type AvailabilityReport,
  type CapabilityClass,
  type Contract,
  type EscalationAttemptFact,
  type EscalationCandidateExclusionReason,
  type EscalationDecision,
  type EscalationDecisionInput,
  type EscalationDecisionKind,
  type EscalationFailureCategory,
  type ModelCandidate,
  type ModelProfiles,
  type ProgressStatus,
  type RiskTier,
  type RoutingPlan,
  type RoutingPurpose,
  type Transmission,
} from "./types.js";
import { hash, record, strings, taskId, textField } from "./util.js";
import type { Attempt } from "./types.js";

export const INITIAL_ESCALATION_THRESHOLDS = {
  unchangedAttemptsBeforeDirect: 2,
  infrastructureRetries: 2,
} as const;

const capabilities: CapabilityClass[] = [
  "economy",
  "standard",
  "premium",
  "frontier",
];
const failures: EscalationFailureCategory[] = [
  "implementation",
  "infrastructure",
  "timeout",
  "flaky",
  "mixed",
];
const progressStatuses: ProgressStatus[] = [
  "first",
  "unchanged",
  "reduced",
  "expanded",
  "incomparable",
];
const risks: RiskTier[] = ["low", "medium", "high", "critical"];
const purposes: RoutingPurpose[] = [
  "implementation",
  "consultation",
  "review",
  "adversarial-review",
  "rescue",
];

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value as T;
}

function integer(
  value: unknown,
  name: string,
  minimum = 0,
  maximum = 1_000_000_000,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  )
    throw new RigorError(`${name} is out of range`, EXIT.inputError);
  return value as number;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new RigorError(`${name} must be boolean`, EXIT.inputError);
  return value;
}

function digest(value: unknown, name: string): string {
  const result = textField(value, name, 128);
  if (!/^[a-f0-9]{64}$/u.test(result))
    throw new RigorError(`${name} must be a SHA-256 digest`, EXIT.inputError);
  return result;
}

function attemptFact(value: unknown, name: string): EscalationAttemptFact {
  const item = record(value, name);
  const failureFingerprint = item.failureFingerprint;
  if (failureFingerprint !== null)
    digest(failureFingerprint, `${name}.failureFingerprint`);
  return {
    artifactId: textField(item.artifactId, `${name}.artifactId`, 128),
    artifactHash: digest(item.artifactHash, `${name}.artifactHash`),
    routingPlanArtifactId: textField(
      item.routingPlanArtifactId,
      `${name}.routingPlanArtifactId`,
      128,
    ),
    routingPlanHash: digest(item.routingPlanHash, `${name}.routingPlanHash`),
    sequence: integer(item.sequence, `${name}.sequence`, 1, 20),
    capabilityClass: oneOf(
      item.capabilityClass,
      capabilities,
      `${name}.capabilityClass`,
    ),
    failureCategory: oneOf(
      item.failureCategory,
      failures,
      `${name}.failureCategory`,
    ),
    progress: oneOf(item.progress, progressStatuses, `${name}.progress`),
    failureFingerprint: failureFingerprint as string | null,
    durationMs: integer(item.durationMs, `${name}.durationMs`),
    relativeCost: integer(item.relativeCost, `${name}.relativeCost`, 0),
  };
}

export function parseEscalationDecisionInput(
  value: unknown,
): EscalationDecisionInput {
  const item = record(value, "escalation decision input");
  if (item.schemaVersion !== ESCALATION_DECISION_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported escalation decision input schema",
      EXIT.inputError,
    );
  const contract = record(item.contract, "contract");
  const plan = record(item.routingPlan, "routingPlan");
  const budget = record(item.budget, "budget");
  const concerns = record(item.concerns, "concerns");
  const rawThresholds =
    item.thresholds === undefined
      ? INITIAL_ESCALATION_THRESHOLDS
      : record(item.thresholds, "thresholds");
  if (!Array.isArray(item.previousAttempts))
    throw new RigorError("previousAttempts must be an array", EXIT.inputError);
  const previousAttempts = item.previousAttempts.map((attempt, index) =>
    attemptFact(attempt, `previousAttempts[${index}]`),
  );
  const currentAttempt = attemptFact(item.currentAttempt, "currentAttempt");
  const result: EscalationDecisionInput = {
    schemaVersion: ESCALATION_DECISION_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    purpose: oneOf(item.purpose, purposes, "purpose"),
    contract: {
      artifactId: textField(contract.artifactId, "contract.artifactId", 128),
      artifactHash: digest(contract.artifactHash, "contract.artifactHash"),
    },
    routingPlan: {
      artifactId: textField(plan.artifactId, "routingPlan.artifactId", 128),
      artifactHash: digest(plan.artifactHash, "routingPlan.artifactHash"),
      modelProfilesHash: digest(
        plan.modelProfilesHash,
        "routingPlan.modelProfilesHash",
      ),
    },
    currentAttempt,
    previousAttempts,
    riskTier: oneOf(item.riskTier, risks, "riskTier"),
    externalTransmission: oneOf(
      item.externalTransmission,
      ["allowed", "denied"] satisfies Transmission[],
      "externalTransmission",
    ),
    failureCategory: oneOf(item.failureCategory, failures, "failureCategory"),
    progress: oneOf(item.progress, progressStatuses, "progress"),
    fingerprintRepetitions: integer(
      item.fingerprintRepetitions,
      "fingerprintRepetitions",
      0,
      20,
    ),
    currentCapabilityClass: oneOf(
      item.currentCapabilityClass,
      capabilities,
      "currentCapabilityClass",
    ),
    attemptCount: integer(item.attemptCount, "attemptCount", 1, 20),
    elapsedMs: integer(item.elapsedMs, "elapsedMs"),
    consumedRelativeCost: integer(
      item.consumedRelativeCost,
      "consumedRelativeCost",
    ),
    budget: {
      maxAttempts: integer(budget.maxAttempts, "budget.maxAttempts", 1, 20),
      maxDurationMs: integer(
        budget.maxDurationMs,
        "budget.maxDurationMs",
        1_000,
      ),
      maxRelativeCost: integer(
        budget.maxRelativeCost,
        "budget.maxRelativeCost",
        1,
      ),
    },
    concerns: {
      requirementsChangeRequired: bool(
        concerns.requirementsChangeRequired,
        "concerns.requirementsChangeRequired",
      ),
      acceptanceCriteriaChangeRequired: bool(
        concerns.acceptanceCriteriaChangeRequired,
        "concerns.acceptanceCriteriaChangeRequired",
      ),
      humanOnlyDecision: bool(
        concerns.humanOnlyDecision,
        "concerns.humanOnlyDecision",
      ),
      scopeViolation: bool(concerns.scopeViolation, "concerns.scopeViolation"),
      protectedTestMutation: bool(
        concerns.protectedTestMutation,
        "concerns.protectedTestMutation",
      ),
      configuredCheckRemoval: bool(
        concerns.configuredCheckRemoval,
        "concerns.configuredCheckRemoval",
      ),
      configuredCheckWeakening: bool(
        concerns.configuredCheckWeakening,
        "concerns.configuredCheckWeakening",
      ),
      security: bool(concerns.security, "concerns.security"),
      dataIntegrity: bool(concerns.dataIntegrity, "concerns.dataIntegrity"),
      architectureChange: bool(
        concerns.architectureChange,
        "concerns.architectureChange",
      ),
      contractContradiction: bool(
        concerns.contractContradiction,
        "concerns.contractContradiction",
      ),
    },
    thresholds: {
      unchangedAttemptsBeforeDirect: integer(
        rawThresholds.unchangedAttemptsBeforeDirect,
        "thresholds.unchangedAttemptsBeforeDirect",
        2,
        20,
      ),
      infrastructureRetries: integer(
        rawThresholds.infrastructureRetries,
        "thresholds.infrastructureRetries",
        0,
        20,
      ),
    },
    speculation: strings(item.speculation, "speculation", 100),
  };
  validateConsistency(result);
  return result;
}

function validateConsistency(input: EscalationDecisionInput): void {
  if (
    input.currentAttempt.routingPlanArtifactId !==
      input.routingPlan.artifactId ||
    input.currentAttempt.routingPlanHash !== input.routingPlan.artifactHash
  )
    throw new RigorError(
      "currentAttempt is not linked to routingPlan",
      EXIT.inputError,
    );
  const attempts = [...input.previousAttempts, input.currentAttempt];
  for (let index = 0; index < attempts.length; index += 1) {
    if (attempts[index]?.sequence !== index + 1)
      throw new RigorError(
        "Attempt sequence is stale or inconsistent",
        EXIT.inputError,
      );
  }
  const elapsedMs = attempts.reduce(
    (sum, attempt) => sum + attempt.durationMs,
    0,
  );
  const relativeCost = attempts.reduce(
    (sum, attempt) => sum + attempt.relativeCost,
    0,
  );
  if (
    input.attemptCount !== attempts.length ||
    input.elapsedMs !== elapsedMs ||
    input.consumedRelativeCost !== relativeCost ||
    input.currentCapabilityClass !== input.currentAttempt.capabilityClass ||
    input.failureCategory !== input.currentAttempt.failureCategory ||
    input.progress !== input.currentAttempt.progress
  )
    throw new RigorError(
      "Escalation facts are stale or inconsistent",
      EXIT.inputError,
    );
  const matching = attempts.filter(
    (attempt) =>
      input.currentAttempt.failureFingerprint !== null &&
      attempt.failureFingerprint === input.currentAttempt.failureFingerprint,
  ).length;
  if (input.fingerprintRepetitions !== matching)
    throw new RigorError(
      "fingerprintRepetitions is stale or inconsistent",
      EXIT.inputError,
    );
}

export function validateEscalationArtifacts(
  input: EscalationDecisionInput,
  contract: Contract,
  plans: RoutingPlan[],
  attempts: Attempt[],
): void {
  const plansById = new Map(plans.map((plan) => [plan.artifactId, plan]));
  const currentPlan = plansById.get(input.routingPlan.artifactId);
  if (
    contract.taskId !== input.taskId ||
    currentPlan === undefined ||
    currentPlan.taskId !== input.taskId ||
    input.contract.artifactId !== contract.artifactId ||
    input.contract.artifactHash !== hash(contract) ||
    input.routingPlan.artifactHash !== hash(currentPlan) ||
    input.routingPlan.modelProfilesHash !== currentPlan.modelProfilesHash ||
    currentPlan.contractArtifactId !== contract.artifactId ||
    currentPlan.contractHash !== hash(contract) ||
    input.budget.maxAttempts !== currentPlan.budget.maxAttempts ||
    input.budget.maxDurationMs !== currentPlan.budget.maxDurationMs ||
    input.budget.maxRelativeCost !== currentPlan.budget.maxRelativeCost
  )
    throw new RigorError(
      "Linked escalation artifacts are stale or inconsistent",
      EXIT.inputError,
    );
  const expected = [...input.previousAttempts, input.currentAttempt];
  if (attempts.length !== expected.length)
    throw new RigorError("Attempt artifact set is incomplete", EXIT.inputError);
  for (let index = 0; index < expected.length; index += 1) {
    const actual = attempts[index];
    const fact = expected[index];
    const linkedPlan =
      fact === undefined
        ? undefined
        : plansById.get(fact.routingPlanArtifactId);
    if (
      actual === undefined ||
      fact === undefined ||
      linkedPlan === undefined ||
      linkedPlan.selection === null ||
      linkedPlan.taskId !== input.taskId ||
      linkedPlan.contractArtifactId !== contract.artifactId ||
      linkedPlan.contractHash !== hash(contract) ||
      fact.routingPlanHash !== hash(linkedPlan) ||
      fact.relativeCost !== linkedPlan.selection.relativeCost ||
      actual.taskId !== input.taskId ||
      actual.artifactId !== fact.artifactId ||
      hash(actual) !== fact.artifactHash ||
      actual.routingPlanArtifactId !== fact.routingPlanArtifactId ||
      actual.routingPlanHash !== fact.routingPlanHash ||
      actual.sequence !== fact.sequence ||
      actual.capabilityClass !== fact.capabilityClass ||
      actual.failureCategory !== fact.failureCategory ||
      (actual.progress?.status ?? "first") !== fact.progress ||
      (actual.failureFingerprint ?? null) !== fact.failureFingerprint ||
      actual.durationMs !== fact.durationMs
    )
      throw new RigorError(
        "Attempt artifact is stale or inconsistent",
        EXIT.inputError,
      );
  }
}

function stop(
  input: EscalationDecisionInput,
  profiles: ModelProfiles,
  availability: AvailabilityReport | undefined,
  decision: EscalationDecisionKind,
  reasonCode: string,
): EscalationDecision {
  return baseDecision(input, profiles, availability, {
    decision,
    reasonCode,
    target: null,
    selection: null,
    eligible: [],
    excluded: [],
  });
}

function baseDecision(
  input: EscalationDecisionInput,
  profiles: ModelProfiles,
  availability: AvailabilityReport | undefined,
  result: {
    decision: EscalationDecisionKind;
    reasonCode: string;
    target: CapabilityClass | null;
    selection: EscalationDecision["selection"];
    eligible: string[];
    excluded: EscalationDecision["excludedCandidates"];
  },
): EscalationDecision {
  return {
    schemaVersion: ESCALATION_DECISION_SCHEMA,
    taskId: input.taskId,
    inputHash: hash(input),
    modelProfilesHash: hash(profiles),
    availabilityReportHash:
      availability === undefined ? null : hash(availability),
    decision: result.decision,
    reasonCode: result.reasonCode,
    targetCapabilityClass: result.target,
    selection: result.selection,
    eligibleCandidates: result.eligible,
    excludedCandidates: result.excluded,
    budget: {
      attemptCount: input.attemptCount,
      maxAttempts: input.budget.maxAttempts,
      elapsedMs: input.elapsedMs,
      maxDurationMs: input.budget.maxDurationMs,
      consumedRelativeCost: input.consumedRelativeCost,
      remainingRelativeCost:
        input.budget.maxRelativeCost - input.consumedRelativeCost,
      maxRelativeCost: input.budget.maxRelativeCost,
    },
    facts: {
      failureCategory: input.failureCategory,
      progress: input.progress,
      fingerprintRepetitions: input.fingerprintRepetitions,
      riskTier: input.riskTier,
      currentCapabilityClass: input.currentCapabilityClass,
      concerns: input.concerns,
    },
    speculation: input.speculation,
  };
}

function desiredClass(input: EscalationDecisionInput): {
  decision: EscalationDecisionKind;
  reasonCode: string;
  target: CapabilityClass | null;
} {
  const currentIndex = capabilities.indexOf(input.currentCapabilityClass);
  if (input.progress === "reduced" || input.failureCategory === "flaky")
    return {
      decision: "retry-current",
      reasonCode:
        input.progress === "reduced" ? "FAILURE_SET_REDUCED" : "FLAKY_RETRY",
      target: input.currentCapabilityClass,
    };
  const direct =
    input.concerns.contractContradiction ||
    input.concerns.security ||
    input.concerns.dataIntegrity ||
    input.concerns.architectureChange ||
    (input.progress === "unchanged" &&
      input.fingerprintRepetitions >=
        input.thresholds.unchangedAttemptsBeforeDirect);
  if (direct) {
    const frontier =
      input.riskTier === "critical" ||
      input.concerns.security ||
      input.concerns.dataIntegrity ||
      input.concerns.architectureChange;
    const targetIndex = Math.max(frontier ? 3 : 2, currentIndex + 1);
    return {
      decision: "escalate-direct",
      reasonCode: input.concerns.contractContradiction
        ? "CONTRACT_CONTRADICTION"
        : input.concerns.architectureChange
          ? "ARCHITECTURE_CHANGE"
          : input.concerns.security || input.concerns.dataIntegrity
            ? "SAFETY_CONCERN"
            : "REPEATED_UNCHANGED_FAILURE",
      target: capabilities[targetIndex] ?? null,
    };
  }
  return {
    decision: "escalate-adjacent",
    reasonCode:
      input.progress === "expanded"
        ? "FAILURE_SET_EXPANDED"
        : input.progress === "incomparable"
          ? "FAILURE_SET_INCOMPARABLE"
          : "ORDINARY_IMPLEMENTATION_DEFECT",
    target: capabilities[currentIndex + 1] ?? null,
  };
}

function exclusionReason(
  candidate: ModelCandidate,
  input: EscalationDecisionInput,
  target: CapabilityClass,
  availability: Map<
    string,
    "available" | "unavailable" | "unknown" | "incompatible"
  >,
): EscalationCandidateExclusionReason | null {
  if (!candidate.enabled) return "DISABLED";
  if (!candidate.purposes.includes(input.purpose)) return "PURPOSE_UNSUPPORTED";
  if (
    candidate.requiresAdditionalExternalTransmission &&
    input.externalTransmission === "denied"
  )
    return "EXTERNAL_TRANSMISSION_DENIED";
  if (availability.get(candidate.id) === "unavailable") return "UNAVAILABLE";
  if (availability.get(candidate.id) === "incompatible") return "INCOMPATIBLE";
  if (candidate.capabilityClass !== target) return "CAPABILITY_NOT_SELECTED";
  if (
    input.consumedRelativeCost + candidate.relativeCost >
    input.budget.maxRelativeCost
  )
    return "BUDGET_EXCEEDED";
  return null;
}

/** Pure, deterministic selector. It performs no I/O, time reads, or provider calls. */
export function selectEscalation(
  input: EscalationDecisionInput,
  profiles: ModelProfiles,
  availability?: AvailabilityReport,
): EscalationDecision {
  if (
    input.routingPlan.modelProfilesHash !== hash(profiles) ||
    (availability !== undefined &&
      availability.modelProfilesHash !== hash(profiles))
  )
    throw new RigorError(
      "Profiles or availability are stale or inconsistent",
      EXIT.inputError,
    );

  // Evaluation order is security-significant. Do not move candidate or budget
  // logic above the policy and human-decision stops.
  if (
    input.concerns.scopeViolation ||
    input.concerns.protectedTestMutation ||
    input.concerns.configuredCheckRemoval ||
    input.concerns.configuredCheckWeakening
  )
    return stop(
      input,
      profiles,
      availability,
      "stop-policy-violation",
      input.concerns.scopeViolation
        ? "SCOPE_VIOLATION"
        : input.concerns.protectedTestMutation
          ? "PROTECTED_TEST_MUTATION"
          : input.concerns.configuredCheckRemoval
            ? "CONFIGURED_CHECK_REMOVAL"
            : "CONFIGURED_CHECK_WEAKENING",
    );
  if (
    input.concerns.requirementsChangeRequired ||
    input.concerns.acceptanceCriteriaChangeRequired ||
    input.concerns.humanOnlyDecision
  )
    return stop(
      input,
      profiles,
      availability,
      "stop-human-decision",
      input.concerns.requirementsChangeRequired
        ? "REQUIREMENTS_CHANGE_REQUIRED"
        : input.concerns.acceptanceCriteriaChangeRequired
          ? "ACCEPTANCE_CRITERIA_CHANGE_REQUIRED"
          : "HUMAN_ONLY_DECISION",
    );
  if (
    input.attemptCount >= input.budget.maxAttempts ||
    input.elapsedMs >= input.budget.maxDurationMs ||
    input.consumedRelativeCost >= input.budget.maxRelativeCost
  )
    return stop(
      input,
      profiles,
      availability,
      "stop-budget-exhausted",
      input.attemptCount >= input.budget.maxAttempts
        ? "MAX_ATTEMPTS_EXHAUSTED"
        : input.elapsedMs >= input.budget.maxDurationMs
          ? "MAX_DURATION_EXHAUSTED"
          : "MAX_RELATIVE_COST_EXHAUSTED",
    );
  if (
    input.failureCategory === "infrastructure" ||
    input.failureCategory === "timeout"
  ) {
    const stopInfrastructure =
      input.fingerprintRepetitions > input.thresholds.infrastructureRetries;
    return stop(
      input,
      profiles,
      availability,
      stopInfrastructure ? "stop-infrastructure" : "retry-infrastructure",
      input.failureCategory === "timeout"
        ? stopInfrastructure
          ? "TIMEOUT_RETRY_LIMIT"
          : "TIMEOUT_RETRY"
        : stopInfrastructure
          ? "INFRASTRUCTURE_RETRY_LIMIT"
          : "INFRASTRUCTURE_RETRY",
    );
  }

  const desired = desiredClass(input);
  if (desired.target === null)
    return stop(
      input,
      profiles,
      availability,
      "stop-no-eligible-candidate",
      "NO_HIGHER_CAPABILITY_CLASS",
    );
  const availabilityStates = new Map(
    availability?.candidates.map((candidate) => [
      candidate.candidateId,
      candidate.state,
    ]) ?? [],
  );
  const eligible: ModelCandidate[] = [];
  const excluded: EscalationDecision["excludedCandidates"] = [];
  for (const candidate of profiles.candidates) {
    const reasonCode = exclusionReason(
      candidate,
      input,
      desired.target,
      availabilityStates,
    );
    if (reasonCode === null) eligible.push(candidate);
    else excluded.push({ candidateId: candidate.id, reasonCode });
  }
  eligible.sort(
    (left, right) =>
      capabilities.indexOf(left.capabilityClass) -
        capabilities.indexOf(right.capabilityClass) ||
      left.relativeCost - right.relativeCost ||
      left.id.localeCompare(right.id),
  );
  const selected = eligible[0];
  if (selected === undefined)
    return baseDecision(input, profiles, availability, {
      decision: "stop-no-eligible-candidate",
      reasonCode: "NO_ELIGIBLE_CANDIDATE",
      target: desired.target,
      selection: null,
      eligible: [],
      excluded,
    });
  return baseDecision(input, profiles, availability, {
    decision: desired.decision,
    reasonCode: desired.reasonCode,
    target: desired.target,
    selection: {
      candidateId: selected.id,
      provider: selected.provider,
      ...(selected.model === undefined ? {} : { model: selected.model }),
      capabilityClass: selected.capabilityClass,
      relativeCost: selected.relativeCost,
    },
    eligible: eligible.map((candidate) => candidate.id),
    excluded,
  });
}
