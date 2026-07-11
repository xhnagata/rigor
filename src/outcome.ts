import { EXIT, RigorError } from "./errors.js";
import {
  OUTCOME_INPUT_SCHEMA,
  OUTCOME_SCHEMA,
  REVIEW_SCHEMA,
  type Attempt,
  type Outcome,
  type OutcomeInput,
  type Verification,
} from "./types.js";
import { artifactId, record, taskId, textField } from "./util.js";

export interface ReviewArtifact {
  taskId: string;
  artifactId: string;
  verificationArtifactId?: string;
}

export interface OutcomeLinks {
  attempt?: Attempt | undefined;
  verification?: Verification | undefined;
  review?: ReviewArtifact | undefined;
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value as T;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new RigorError(`${name} must be a boolean`, EXIT.inputError);
  return value;
}

function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new RigorError(`${name} is out of range`, EXIT.inputError);
  return value;
}

function finite(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new RigorError(`${name} is out of range`, EXIT.inputError);
  return value;
}

function reject(message: string): never {
  throw new RigorError(message, EXIT.policyViolation);
}

function parseUsageInput(value: unknown): OutcomeInput["usage"] {
  const item = record(value, "usage");
  const usage: OutcomeInput["usage"] = {
    status: oneOf(
      item.status,
      ["recorded", "unavailable", "unknown"],
      "usage.status",
    ),
  };
  if (item.inputTokens !== undefined)
    usage.inputTokens = integer(item.inputTokens, "usage.inputTokens", 0, 1e12);
  if (item.outputTokens !== undefined)
    usage.outputTokens = integer(
      item.outputTokens,
      "usage.outputTokens",
      0,
      1e12,
    );
  if (item.totalTokens !== undefined)
    usage.totalTokens = integer(item.totalTokens, "usage.totalTokens", 0, 1e12);
  if (item.reasoningEffort !== undefined)
    usage.reasoningEffort = textField(
      item.reasoningEffort,
      "usage.reasoningEffort",
      128,
    );
  if (item.modelIdentity !== undefined)
    usage.modelIdentity = textField(
      item.modelIdentity,
      "usage.modelIdentity",
      256,
    );
  if (item.providerCost !== undefined) {
    const cost = record(item.providerCost, "usage.providerCost");
    const currency = textField(cost.currency, "usage.providerCost.currency", 3);
    if (!/^[A-Z]{3}$/u.test(currency))
      throw new RigorError(
        "usage.providerCost.currency is invalid",
        EXIT.inputError,
      );
    usage.providerCost = {
      currency,
      amount: finite(cost.amount, "usage.providerCost.amount", 0, 1e12),
    };
  }
  return usage;
}

export function parseOutcomeInput(value: unknown): OutcomeInput {
  const item = record(value, "outcome input");
  if (item.schemaVersion !== OUTCOME_INPUT_SCHEMA)
    throw new RigorError("Unsupported outcome input schema", EXIT.inputError);
  const findings = record(item.reviewFindings, "reviewFindings");
  const input: OutcomeInput = {
    schemaVersion: OUTCOME_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    decision: oneOf(item.decision, ["accepted", "rejected"], "decision"),
    acceptedWithoutModelCodeChanges: boolean(
      item.acceptedWithoutModelCodeChanges,
      "acceptedWithoutModelCodeChanges",
    ),
    humanCorrectionMinutes: integer(
      item.humanCorrectionMinutes,
      "humanCorrectionMinutes",
      0,
      100_000,
    ),
    escalationCount: integer(item.escalationCount, "escalationCount", 0, 100),
    reviewFindings: {
      critical: integer(
        findings.critical,
        "reviewFindings.critical",
        0,
        10_000,
      ),
      high: integer(findings.high, "reviewFindings.high", 0, 10_000),
      medium: integer(findings.medium, "reviewFindings.medium", 0, 10_000),
      low: integer(findings.low, "reviewFindings.low", 0, 10_000),
    },
    revertStatus: oneOf(
      item.revertStatus,
      ["none", "reverted"],
      "revertStatus",
    ),
    escapedDefectStatus: oneOf(
      item.escapedDefectStatus,
      ["none", "suspected", "confirmed"],
      "escapedDefectStatus",
    ),
    usage: parseUsageInput(item.usage),
  };
  if (item.retryCount !== undefined)
    input.retryCount = integer(item.retryCount, "retryCount", 0, 100);
  if (item.commit !== undefined) {
    const commit = textField(item.commit, "commit", 64);
    if (!/^[0-9a-f]{7,64}$/u.test(commit))
      throw new RigorError("commit is invalid", EXIT.inputError);
    input.commit = commit;
  }
  if (item.pullRequest !== undefined)
    input.pullRequest = textField(item.pullRequest, "pullRequest", 256);
  if (item.notes !== undefined) {
    if (!Array.isArray(item.notes) || item.notes.length > 100)
      throw new RigorError("notes must be an array", EXIT.inputError);
    input.notes = item.notes.map((note, index) =>
      textField(note, `notes[${index}]`, 2_000),
    );
  }
  return input;
}

export function parseReviewArtifact(value: unknown): ReviewArtifact {
  const item = record(value, "review");
  if (item.schemaVersion !== REVIEW_SCHEMA)
    throw new RigorError("Unsupported review schema", EXIT.inputError);
  const review: ReviewArtifact = {
    taskId: taskId(item.taskId),
    artifactId: textField(item.artifactId, "review.artifactId", 128),
  };
  if (item.verificationArtifactId !== undefined)
    review.verificationArtifactId = textField(
      item.verificationArtifactId,
      "review.verificationArtifactId",
      128,
    );
  return review;
}

export function createOutcome(
  input: OutcomeInput,
  links: OutcomeLinks,
  now = new Date(),
): Outcome {
  const { attempt, verification, review } = links;
  const task = input.taskId;
  if (attempt && attempt.taskId !== task)
    reject("Attempt taskId does not match the outcome");
  if (verification && verification.taskId !== task)
    reject("Verification taskId does not match the outcome");
  if (review && review.taskId !== task)
    reject("Review taskId does not match the outcome");

  if (input.decision === "rejected" && input.acceptedWithoutModelCodeChanges)
    reject("A rejected outcome cannot be accepted without model code changes");
  if (input.revertStatus === "reverted" && input.decision !== "accepted")
    reject("A reverted outcome must be accepted");
  if (input.escapedDefectStatus !== "none" && input.decision !== "accepted")
    reject("An escaped defect requires an accepted outcome");

  const linkage: Partial<Outcome> = {};
  let retryCount: number;
  if (attempt) {
    const derived = attempt.sequence - 1;
    if (input.retryCount !== undefined && input.retryCount !== derived)
      reject("retryCount conflicts with the linked attempt");
    retryCount = derived;
    linkage.routingPlanArtifactId = attempt.routingPlanArtifactId;
    linkage.attemptArtifactId = attempt.artifactId;
    linkage.attemptSequence = attempt.sequence;
    linkage.attemptStatus = attempt.status;
    linkage.attemptDurationMs = attempt.durationMs;
    linkage.provider = attempt.provider;
    if (attempt.model !== undefined) linkage.model = attempt.model;
    linkage.capabilityClass = attempt.capabilityClass;
    if (input.decision === "accepted" && attempt.status !== "completed")
      reject("An accepted outcome requires a completed attempt");
  } else {
    if (input.retryCount === undefined)
      reject("retryCount is required without a linked attempt");
    retryCount = input.retryCount;
  }

  if (verification) {
    if (
      attempt &&
      attempt.verificationArtifactId !== undefined &&
      verification.artifactId !== attempt.verificationArtifactId
    )
      reject("Verification does not match the attempt's linked verification");
    if (input.decision === "accepted" && verification.status !== "passed")
      reject("An accepted outcome requires a linked passing verification");
    linkage.verificationArtifactId = verification.artifactId;
    linkage.verificationStatus = verification.status;
  } else if (input.decision === "accepted") {
    reject("an accepted outcome requires a linked passing verification");
  }

  if (review) {
    linkage.reviewArtifactId = review.artifactId;
    if (
      review.verificationArtifactId !== undefined &&
      verification &&
      review.verificationArtifactId !== verification.artifactId
    )
      reject("Review verification does not match the linked verification");
  }

  const u = input.usage;
  const measured =
    u.inputTokens !== undefined ||
    u.outputTokens !== undefined ||
    u.totalTokens !== undefined ||
    u.providerCost !== undefined ||
    u.reasoningEffort !== undefined;
  if (u.status !== "recorded") {
    if (measured) reject("Usage measurements are not available");
  } else if (
    u.inputTokens === undefined &&
    u.outputTokens === undefined &&
    u.providerCost === undefined
  ) {
    reject("recorded usage requires at least one measured value");
  }
  if (u.totalTokens !== undefined) {
    if (u.inputTokens !== undefined && u.totalTokens < u.inputTokens)
      reject("token totals are inconsistent");
    if (u.outputTokens !== undefined && u.totalTokens < u.outputTokens)
      reject("token totals are inconsistent");
    if (
      u.inputTokens !== undefined &&
      u.outputTokens !== undefined &&
      u.totalTokens !== u.inputTokens + u.outputTokens
    )
      reject("token totals are inconsistent");
  }

  if (input.commit !== undefined) linkage.commit = input.commit;
  if (input.pullRequest !== undefined) linkage.pullRequest = input.pullRequest;

  const findings = input.reviewFindings;
  const outcome: Outcome = {
    schemaVersion: OUTCOME_SCHEMA,
    artifactId: artifactId("outcome"),
    taskId: task,
    createdAt: now.toISOString(),
    decision: input.decision,
    acceptedWithoutModelCodeChanges: input.acceptedWithoutModelCodeChanges,
    humanCorrectionMinutes: input.humanCorrectionMinutes,
    escalationCount: input.escalationCount,
    retryCount,
    reviewFindings: {
      ...findings,
      total: findings.critical + findings.high + findings.medium + findings.low,
    },
    revertStatus: input.revertStatus,
    escapedDefectStatus: input.escapedDefectStatus,
    executionIdentityStatus: "unverified",
    ...linkage,
    usage: {
      status: u.status,
      inputTokens: u.inputTokens ?? null,
      outputTokens: u.outputTokens ?? null,
      totalTokens: u.totalTokens ?? null,
      reasoningEffort: u.reasoningEffort ?? null,
      providerCost: u.providerCost ?? null,
      modelIdentity:
        u.modelIdentity === undefined
          ? null
          : { value: u.modelIdentity, attestation: "unverified" },
    },
    notes: input.notes ?? [],
  };
  return outcome;
}
