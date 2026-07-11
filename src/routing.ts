import { EXIT, RigorError } from "./errors.js";
import {
  MODEL_PROFILES_SCHEMA,
  ROUTING_INPUT_SCHEMA,
  ROUTING_INPUT_V2_SCHEMA,
  ROUTING_DECISION_SCHEMA,
  ROUTING_PLAN_SCHEMA,
  type AssessmentConfidence,
  type AssessmentEvidence,
  type AvailabilityReport,
  type AvailabilityState,
  type CapabilityClass,
  type ModelCandidate,
  type ModelProfiles,
  type Preflight,
  type RoutingDecision,
  type RoutingExclusionReason,
  type RoutingInput,
  type RoutingPlan,
  type RoutingPurpose,
  type SignalLevel,
  type VerificationStrength,
} from "./types.js";
import type { Contract } from "./types.js";
import {
  artifactId,
  hash,
  record,
  strings,
  taskId,
  textField,
} from "./util.js";

const signalLevels: SignalLevel[] = ["low", "medium", "high", "critical"];
const verificationStrengths: VerificationStrength[] = [
  "weak",
  "moderate",
  "strong",
];
const capabilityClasses: CapabilityClass[] = [
  "economy",
  "standard",
  "premium",
  "frontier",
];
const purposes: RoutingPurpose[] = [
  "implementation",
  "consultation",
  "review",
  "adversarial-review",
  "rescue",
];
const confidenceLevels: AssessmentConfidence[] = ["low", "medium", "high"];
const routingInputSchemaVersions = [
  ROUTING_INPUT_SCHEMA,
  ROUTING_INPUT_V2_SCHEMA,
] as const;

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value as T;
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
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

// Repository-relative path discipline shared with intent planned paths: reject
// absolute paths and ".." traversal segments so evidence cannot anchor itself
// outside the repository it claims to observe.
function assessmentPath(value: unknown, name: string): string {
  const p = textField(value, name, 1024);
  if (p.startsWith("/") || p.split(/[\\/]/u).includes(".."))
    throw new RigorError(
      `${name} must be a repository-relative path`,
      EXIT.inputError,
    );
  return p;
}

function parseSignals(value: unknown): RoutingInput["signals"] {
  const signals = record(value, "signals");
  return {
    complexity: oneOf(signals.complexity, signalLevels, "complexity"),
    ambiguity: oneOf(signals.ambiguity, signalLevels, "ambiguity"),
    novelty: oneOf(signals.novelty, signalLevels, "novelty"),
    verificationStrength: oneOf(
      signals.verificationStrength,
      verificationStrengths,
      "verificationStrength",
    ),
  };
}

function parseBudget(value: unknown): RoutingInput["budget"] {
  const budget = record(value, "budget");
  return {
    maxAttempts: integer(budget.maxAttempts, "maxAttempts", 1, 20),
    maxDurationMs: integer(
      budget.maxDurationMs,
      "maxDurationMs",
      1_000,
      86_400_000,
    ),
    maxRelativeCost: integer(
      budget.maxRelativeCost,
      "maxRelativeCost",
      1,
      1_000_000,
    ),
  };
}

function parseEvidence(value: unknown): AssessmentEvidence[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new RigorError(
      "assessment.evidence must not be empty",
      EXIT.inputError,
    );
  if (value.length > 20)
    throw new RigorError(
      "assessment.evidence must not exceed 20 items",
      EXIT.inputError,
    );
  return value.map((raw, index) => {
    const item = record(raw, `assessment.evidence[${index}]`);
    return {
      path: assessmentPath(item.path, `assessment.evidence[${index}].path`),
      observation: textField(
        item.observation,
        `assessment.evidence[${index}].observation`,
        10_000,
      ),
    };
  });
}

export function parseRoutingInput(value: unknown): RoutingInput {
  const item = record(value, "routing input");
  if (item.schemaVersion === ROUTING_INPUT_SCHEMA) {
    const assessmentReasons = strings(
      item.assessmentReasons,
      "assessmentReasons",
      20,
    );
    if (assessmentReasons.length === 0)
      throw new RigorError(
        "assessmentReasons must not be empty",
        EXIT.inputError,
      );
    return {
      schemaVersion: ROUTING_INPUT_SCHEMA,
      taskId: taskId(item.taskId),
      purpose: oneOf(item.purpose, purposes, "purpose"),
      signals: parseSignals(item.signals),
      assessmentReasons,
      budget: parseBudget(item.budget),
    };
  }
  if (item.schemaVersion === ROUTING_INPUT_V2_SCHEMA) {
    const assessmentRecord = record(item.assessment, "assessment");
    const confidence = oneOf(
      assessmentRecord.confidence,
      confidenceLevels,
      "assessment.confidence",
    );
    const evidence = parseEvidence(assessmentRecord.evidence);
    const signals = parseSignals(item.signals);
    // Fail closed: a claimed maximally-ambiguous task, or a task without
    // deterministic verification, cannot also be assessed with high
    // confidence. That combination is contradictory on its face.
    if (
      confidence === "high" &&
      (signals.ambiguity === "critical" ||
        signals.verificationStrength === "weak")
    )
      throw new RigorError(
        "Contradictory assessment: high confidence with critical ambiguity or weak verification",
        EXIT.inputError,
      );
    return {
      schemaVersion: ROUTING_INPUT_V2_SCHEMA,
      taskId: taskId(item.taskId),
      purpose: oneOf(item.purpose, purposes, "purpose"),
      signals,
      // v2 does not carry a separate top-level assessmentReasons field; the
      // internal invariant that every routing input has non-empty reasons is
      // preserved by deriving reasons from the evidence observations.
      assessmentReasons: evidence.map((entry) => entry.observation),
      budget: parseBudget(item.budget),
      assessment: {
        inputSchemaVersion: ROUTING_INPUT_V2_SCHEMA,
        confidence,
        evidence,
      },
    };
  }
  throw new RigorError("Unsupported routing input schema", EXIT.inputError);
}

function parseCandidate(value: unknown, index: number): ModelCandidate {
  const item = record(value, `candidates[${index}]`);
  const candidate: ModelCandidate = {
    id: textField(item.id, `candidates[${index}].id`, 128),
    provider: textField(item.provider, `candidates[${index}].provider`, 128),
    capabilityClass: oneOf(
      item.capabilityClass,
      capabilityClasses,
      `candidates[${index}].capabilityClass`,
    ),
    purposes: strings(
      item.purposes,
      `candidates[${index}].purposes`,
      purposes.length,
    ).map((purpose) =>
      oneOf(purpose, purposes, `candidates[${index}].purpose`),
    ),
    relativeCost: integer(
      item.relativeCost,
      `candidates[${index}].relativeCost`,
      1,
      1_000_000,
    ),
    requiresAdditionalExternalTransmission: bool(
      item.requiresAdditionalExternalTransmission,
      `candidates[${index}].requiresAdditionalExternalTransmission`,
    ),
    enabled: bool(item.enabled, `candidates[${index}].enabled`),
  };
  if (item.model !== undefined)
    candidate.model = textField(item.model, `candidates[${index}].model`, 256);
  if (candidate.purposes.length === 0)
    throw new RigorError(
      `candidates[${index}].purposes must not be empty`,
      EXIT.inputError,
    );
  if (new Set(candidate.purposes).size !== candidate.purposes.length)
    throw new RigorError(
      `candidates[${index}].purposes contains duplicates`,
      EXIT.inputError,
    );
  return candidate;
}

export function parseModelProfiles(value: unknown): ModelProfiles {
  const item = record(value, "model profiles");
  if (item.schemaVersion !== MODEL_PROFILES_SCHEMA)
    throw new RigorError("Unsupported model profiles schema", EXIT.inputError);
  if (!Array.isArray(item.candidates) || item.candidates.length === 0)
    throw new RigorError("candidates must not be empty", EXIT.inputError);
  const candidates = item.candidates.map(parseCandidate);
  if (
    new Set(candidates.map((candidate) => candidate.id)).size !==
    candidates.length
  )
    throw new RigorError("Candidate IDs must be unique", EXIT.inputError);
  return { schemaVersion: MODEL_PROFILES_SCHEMA, candidates };
}

export function requiredCapability(input: RoutingInput): CapabilityClass {
  const signalRank = Math.max(
    signalLevels.indexOf(input.signals.complexity),
    signalLevels.indexOf(input.signals.ambiguity),
    signalLevels.indexOf(input.signals.novelty),
  );
  const weaknessBump = input.signals.verificationStrength === "weak" ? 1 : 0;
  return capabilityClasses[Math.min(signalRank + weaknessBump, 3)]!;
}

function exclusionReason(
  candidate: ModelCandidate,
  input: RoutingInput,
  preflight: Preflight,
  required: CapabilityClass,
  availability: Map<string, AvailabilityState>,
): RoutingExclusionReason | null {
  if (!candidate.enabled) return "DISABLED";
  const state = availability.get(candidate.id);
  if (state === "incompatible") return "INCOMPATIBLE";
  if (state === "unavailable") return "UNAVAILABLE";
  if (!candidate.purposes.includes(input.purpose)) return "PURPOSE_UNSUPPORTED";
  if (
    preflight.externalTransmission === "denied" &&
    candidate.requiresAdditionalExternalTransmission
  )
    return "EXTERNAL_TRANSMISSION_DENIED";
  if (
    capabilityClasses.indexOf(candidate.capabilityClass) <
    capabilityClasses.indexOf(required)
  )
    return "INSUFFICIENT_CAPABILITY";
  if (candidate.relativeCost > input.budget.maxRelativeCost)
    return "BUDGET_EXCEEDED";
  return null;
}

export function route(
  preflight: Preflight,
  input: RoutingInput,
  profiles: ModelProfiles,
  availability?: AvailabilityReport,
): RoutingDecision {
  if (input.taskId !== preflight.taskId)
    throw new RigorError(
      "Routing taskId does not match preflight",
      EXIT.inputError,
    );
  const availabilityStates = new Map<string, AvailabilityState>();
  if (availability !== undefined) {
    if (availability.modelProfilesHash !== hash(profiles))
      throw new RigorError(
        "Availability report does not match the model profiles",
        EXIT.inputError,
      );
    for (const entry of availability.candidates)
      availabilityStates.set(entry.candidateId, entry.state);
  }
  const required = requiredCapability(input);
  // v1 legacy inputs carry no assessment, so they are treated as "medium"
  // confidence and proceed exactly as they did before this change.
  const confidence: AssessmentConfidence =
    input.assessment?.confidence ?? "medium";
  const eligible: ModelCandidate[] = [];
  const excluded: RoutingDecision["excludedCandidates"] = [];
  for (const candidate of profiles.candidates) {
    const reasonCode = exclusionReason(
      candidate,
      input,
      preflight,
      required,
      availabilityStates,
    );
    if (reasonCode) excluded.push({ candidateId: candidate.id, reasonCode });
    else eligible.push(candidate);
  }
  eligible.sort(
    (left, right) =>
      left.relativeCost - right.relativeCost ||
      capabilityClasses.indexOf(left.capabilityClass) -
        capabilityClasses.indexOf(right.capabilityClass) ||
      left.id.localeCompare(right.id),
  );
  // Low-confidence gate: never silently select economy (or anything else).
  // A low-confidence assessment always produces an explicit review outcome,
  // regardless of whether an eligible candidate exists.
  const selected = confidence === "low" ? undefined : eligible[0];
  const selection = selected
    ? {
        candidateId: selected.id,
        provider: selected.provider,
        ...(selected.model === undefined ? {} : { model: selected.model }),
        capabilityClass: selected.capabilityClass,
        relativeCost: selected.relativeCost,
      }
    : null;
  const status =
    confidence === "low"
      ? "requires-review"
      : selection
        ? "selected"
        : "unroutable";
  return {
    schemaVersion: ROUTING_DECISION_SCHEMA,
    mode: "dry-run",
    taskId: input.taskId,
    preflightArtifactId: preflight.artifactId,
    preflightHash: hash(preflight),
    routingInputHash: hash(input),
    modelProfilesHash: hash(profiles),
    purpose: input.purpose,
    requiredCapabilityClass: required,
    eligibleCandidates: eligible.map((candidate) => candidate.id),
    excludedCandidates: excluded,
    selection,
    controls: {
      externalTransmission: preflight.externalTransmission,
      requireHumanApproval: preflight.requireHumanApproval,
      requireIndependentReview:
        preflight.riskTier === "high" ||
        preflight.riskTier === "critical" ||
        preflight.protectedPaths.length > 0,
    },
    budget: input.budget,
    ...(availability === undefined
      ? {}
      : { availabilityReportHash: hash(availability) }),
    assessment: {
      inputSchemaVersion: input.schemaVersion,
      confidence,
      evidenceCount: input.assessment?.evidence.length ?? 0,
    },
    status,
  };
}

export function createRoutingPlan(
  decision: RoutingDecision,
  preflight: Preflight,
  contract: Contract,
  now = new Date(),
): RoutingPlan {
  if (
    decision.status !== "selected" ||
    decision.selection === null ||
    decision.taskId !== contract.taskId ||
    preflight.taskId !== contract.taskId
  )
    throw new RigorError(
      "A selected, task-matched routing decision is required",
      EXIT.policyViolation,
    );
  if (
    contract.preflightArtifactId !== preflight.artifactId ||
    contract.preflightHash !== hash(preflight)
  )
    throw new RigorError(
      "Contract is not linked to the routing preflight",
      EXIT.policyViolation,
    );
  const {
    schemaVersion: _schemaVersion,
    mode: _mode,
    status: _status,
    ...rest
  } = decision;
  void _schemaVersion;
  void _mode;
  void _status;
  return {
    ...rest,
    schemaVersion: ROUTING_PLAN_SCHEMA,
    artifactId: artifactId("routing-plan"),
    createdAt: now.toISOString(),
    contractArtifactId: contract.artifactId,
    contractHash: hash(contract),
    policyHash: preflight.policyHash,
    plannedHead: preflight.git.head,
    status: "planned",
  };
}

export function parseRoutingPlan(value: unknown): RoutingPlan {
  const item = record(value, "routing plan");
  if (item.schemaVersion !== ROUTING_PLAN_SCHEMA)
    throw new RigorError("Unsupported routing plan schema", EXIT.inputError);
  const selection = record(item.selection, "selection");
  const controls = record(item.controls, "controls");
  const budget = record(item.budget, "budget");
  const plannedHead = item.plannedHead;
  if (plannedHead !== null && typeof plannedHead !== "string")
    throw new RigorError("plannedHead is invalid", EXIT.inputError);
  // Migration path: routing plans recorded before this change carry no
  // `assessment` summary at all. Rather than fail closed on plans that were
  // valid when they were written, synthesize the legacy default that matches
  // how route() has always treated assessment-free v1 inputs.
  const assessment =
    item.assessment === undefined
      ? {
          inputSchemaVersion: ROUTING_INPUT_SCHEMA,
          confidence: "medium" as const,
          evidenceCount: 0,
        }
      : (() => {
          const raw = record(item.assessment, "assessment");
          return {
            inputSchemaVersion: oneOf(
              raw.inputSchemaVersion,
              routingInputSchemaVersions,
              "assessment.inputSchemaVersion",
            ),
            confidence: oneOf(
              raw.confidence,
              confidenceLevels,
              "assessment.confidence",
            ),
            evidenceCount: integer(
              raw.evidenceCount,
              "assessment.evidenceCount",
              0,
              20,
            ),
          };
        })();
  const plan: RoutingPlan = {
    schemaVersion: ROUTING_PLAN_SCHEMA,
    artifactId: textField(item.artifactId, "artifactId", 128),
    createdAt: textField(item.createdAt, "createdAt", 128),
    taskId: taskId(item.taskId),
    preflightArtifactId: textField(
      item.preflightArtifactId,
      "preflightArtifactId",
      128,
    ),
    preflightHash: textField(item.preflightHash, "preflightHash", 128),
    routingInputHash: textField(item.routingInputHash, "routingInputHash", 128),
    modelProfilesHash: textField(
      item.modelProfilesHash,
      "modelProfilesHash",
      128,
    ),
    contractArtifactId: textField(
      item.contractArtifactId,
      "contractArtifactId",
      128,
    ),
    contractHash: textField(item.contractHash, "contractHash", 128),
    policyHash: textField(item.policyHash, "policyHash", 128),
    plannedHead,
    purpose: oneOf(item.purpose, purposes, "purpose"),
    requiredCapabilityClass: oneOf(
      item.requiredCapabilityClass,
      capabilityClasses,
      "requiredCapabilityClass",
    ),
    eligibleCandidates: strings(item.eligibleCandidates, "eligibleCandidates"),
    excludedCandidates: [],
    selection: {
      candidateId: textField(selection.candidateId, "candidateId", 128),
      provider: textField(selection.provider, "provider", 128),
      capabilityClass: oneOf(
        selection.capabilityClass,
        capabilityClasses,
        "selection.capabilityClass",
      ),
      relativeCost: integer(
        selection.relativeCost,
        "selection.relativeCost",
        1,
        1_000_000,
      ),
    },
    controls: {
      externalTransmission: oneOf(
        controls.externalTransmission,
        ["allowed", "denied"],
        "externalTransmission",
      ),
      requireHumanApproval: bool(
        controls.requireHumanApproval,
        "requireHumanApproval",
      ),
      requireIndependentReview: bool(
        controls.requireIndependentReview,
        "requireIndependentReview",
      ),
    },
    budget: {
      maxAttempts: integer(budget.maxAttempts, "maxAttempts", 1, 20),
      maxDurationMs: integer(
        budget.maxDurationMs,
        "maxDurationMs",
        1_000,
        86_400_000,
      ),
      maxRelativeCost: integer(
        budget.maxRelativeCost,
        "maxRelativeCost",
        1,
        1_000_000,
      ),
    },
    assessment,
    status: "planned",
  };
  if (selection.model !== undefined)
    plan.selection!.model = textField(selection.model, "selection.model", 256);
  if (!Array.isArray(item.excludedCandidates))
    throw new RigorError(
      "excludedCandidates must be an array",
      EXIT.inputError,
    );
  plan.excludedCandidates = item.excludedCandidates.map((raw, index) => {
    const excluded = record(raw, `excludedCandidates[${index}]`);
    return {
      candidateId: textField(excluded.candidateId, "candidateId", 128),
      reasonCode: oneOf(
        excluded.reasonCode,
        [
          "DISABLED",
          "PURPOSE_UNSUPPORTED",
          "EXTERNAL_TRANSMISSION_DENIED",
          "INSUFFICIENT_CAPABILITY",
          "BUDGET_EXCEEDED",
          "UNAVAILABLE",
          "INCOMPATIBLE",
        ],
        "reasonCode",
      ),
    };
  });
  if (item.availabilityReportHash !== undefined)
    plan.availabilityReportHash = textField(
      item.availabilityReportHash,
      "availabilityReportHash",
      128,
    );
  return plan;
}
