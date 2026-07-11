import { EXIT, RigorError } from "./errors.js";
import {
  MODEL_PROFILES_SCHEMA,
  ROUTING_INPUT_SCHEMA,
  ROUTING_DECISION_SCHEMA,
  type CapabilityClass,
  type ModelCandidate,
  type ModelProfiles,
  type Preflight,
  type RoutingDecision,
  type RoutingExclusionReason,
  type RoutingInput,
  type RoutingPurpose,
  type SignalLevel,
  type VerificationStrength,
} from "./types.js";
import { hash, record, strings, taskId, textField } from "./util.js";

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

export function parseRoutingInput(value: unknown): RoutingInput {
  const item = record(value, "routing input");
  if (item.schemaVersion !== ROUTING_INPUT_SCHEMA)
    throw new RigorError("Unsupported routing input schema", EXIT.inputError);
  const signals = record(item.signals, "signals");
  const budget = record(item.budget, "budget");
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
    signals: {
      complexity: oneOf(signals.complexity, signalLevels, "complexity"),
      ambiguity: oneOf(signals.ambiguity, signalLevels, "ambiguity"),
      novelty: oneOf(signals.novelty, signalLevels, "novelty"),
      verificationStrength: oneOf(
        signals.verificationStrength,
        verificationStrengths,
        "verificationStrength",
      ),
    },
    assessmentReasons,
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
  };
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
): RoutingExclusionReason | null {
  if (!candidate.enabled) return "DISABLED";
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
): RoutingDecision {
  if (input.taskId !== preflight.taskId)
    throw new RigorError(
      "Routing taskId does not match preflight",
      EXIT.inputError,
    );
  const required = requiredCapability(input);
  const eligible: ModelCandidate[] = [];
  const excluded: RoutingDecision["excludedCandidates"] = [];
  for (const candidate of profiles.candidates) {
    const reasonCode = exclusionReason(candidate, input, preflight, required);
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
  const selected = eligible[0];
  const selection = selected
    ? {
        candidateId: selected.id,
        provider: selected.provider,
        ...(selected.model === undefined ? {} : { model: selected.model }),
        capabilityClass: selected.capabilityClass,
        relativeCost: selected.relativeCost,
      }
    : null;
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
    status: selection ? "selected" : "unroutable",
  };
}
