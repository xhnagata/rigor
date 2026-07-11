import test from "node:test";
import assert from "node:assert/strict";
import {
  createOutcome,
  parseOutcomeInput,
  type OutcomeLinks,
  type ReviewArtifact,
} from "../src/outcome.js";
import type { Attempt, OutcomeInput, Verification } from "../src/types.js";

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    schemaVersion: "rigor.attempt.v1",
    artifactId: "attempt_1",
    taskId: "TASK-1",
    createdAt: new Date(0).toISOString(),
    sessionArtifactId: "attempt-session_1",
    sessionHash: "a".repeat(64),
    routingPlanArtifactId: "routing-plan_1",
    routingPlanHash: "b".repeat(64),
    contractArtifactId: "contract_1",
    contractHash: "c".repeat(64),
    sequence: 1,
    provider: "claude",
    model: "configured-standard",
    capabilityClass: "standard",
    purpose: "implementation",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(500).toISOString(),
    durationMs: 500,
    executionIdentityStatus: "unverified",
    status: "completed",
    beforeHead: null,
    afterHead: null,
    beforeTreeHash: "d".repeat(64),
    afterTreeHash: "e".repeat(64),
    changedPathsBefore: [],
    changedPaths: ["src/a.ts"],
    scopeViolations: [],
    verificationArtifactId: "verification_1",
    ...overrides,
  };
}

function verification(overrides: Partial<Verification> = {}): Verification {
  return {
    schemaVersion: "rigor.verification.v1",
    artifactId: "verification_1",
    taskId: "TASK-1",
    contractArtifactId: "contract_1",
    createdAt: new Date(0).toISOString(),
    policyHash: "policy",
    head: null,
    treeHash: "tree",
    changedPaths: ["src/a.ts"],
    scopeViolations: [],
    checks: [],
    status: "passed",
    ...overrides,
  };
}

function review(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    taskId: "TASK-1",
    artifactId: "review_1",
    verificationArtifactId: "verification_1",
    ...overrides,
  };
}

function input(overrides: Partial<OutcomeInput> = {}): OutcomeInput {
  return parseOutcomeInput({
    schemaVersion: "rigor.outcome-input.v1",
    taskId: "TASK-1",
    decision: "accepted",
    acceptedWithoutModelCodeChanges: false,
    humanCorrectionMinutes: 0,
    escalationCount: 0,
    reviewFindings: { critical: 0, high: 0, medium: 0, low: 0 },
    revertStatus: "none",
    escapedDefectStatus: "none",
    usage: { status: "unavailable" },
    ...overrides,
  });
}

const links: OutcomeLinks = {
  attempt: attempt(),
  verification: verification(),
  review: review(),
};

test("accepted outcome links a completed attempt and passing verification", () => {
  const outcome = createOutcome(input(), links, new Date(0));
  assert.equal(outcome.decision, "accepted");
  assert.equal(outcome.retryCount, 0);
  assert.equal(outcome.attemptStatus, "completed");
  assert.equal(outcome.verificationStatus, "passed");
  assert.equal(outcome.provider, "claude");
  assert.equal(outcome.model, "configured-standard");
  assert.equal(outcome.reviewArtifactId, "review_1");
  assert.equal(outcome.executionIdentityStatus, "unverified");
  assert.equal(outcome.usage.inputTokens, null);
  assert.equal(outcome.usage.modelIdentity, null);
  assert.deepEqual(outcome.notes, []);
});

test("rejected outcome does not require verification", () => {
  const outcome = createOutcome(
    input({ decision: "rejected" }),
    { attempt: attempt({ status: "failed" }) },
    new Date(0),
  );
  assert.equal(outcome.decision, "rejected");
  assert.equal(outcome.verificationArtifactId, undefined);
});

test("reverted status is recorded on an accepted outcome", () => {
  const outcome = createOutcome(
    input({ revertStatus: "reverted" }),
    links,
    new Date(0),
  );
  assert.equal(outcome.revertStatus, "reverted");
});

test("usage-unavailable stores null measurements", () => {
  const outcome = createOutcome(input(), links, new Date(0));
  assert.equal(outcome.usage.status, "unavailable");
  assert.equal(outcome.usage.outputTokens, null);
  assert.equal(outcome.usage.providerCost, null);
  assert.equal(outcome.usage.reasoningEffort, null);
});

test("retryCount is derived without a linked attempt", () => {
  const outcome = createOutcome(
    input({ decision: "rejected", retryCount: 3 }),
    {},
    new Date(0),
  );
  assert.equal(outcome.retryCount, 3);
  assert.equal(outcome.attemptArtifactId, undefined);
  assert.equal(outcome.provider, undefined);
});

test("recorded usage totals and identity are preserved", () => {
  const outcome = createOutcome(
    input({
      usage: {
        status: "recorded",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        modelIdentity: "reported-model",
      },
    }),
    links,
    new Date(0),
  );
  assert.equal(outcome.usage.totalTokens, 150);
  assert.deepEqual(outcome.usage.modelIdentity, {
    value: "reported-model",
    attestation: "unverified",
  });
});

test("an accepted outcome requires a passing verification", () => {
  assert.throws(() => createOutcome(input(), { attempt: attempt() }));
  assert.throws(() =>
    createOutcome(input(), {
      attempt: attempt(),
      verification: verification({ status: "failed" }),
    }),
  );
});

test("reverted while rejected is rejected", () => {
  assert.throws(() =>
    createOutcome(input({ decision: "rejected", revertStatus: "reverted" }), {
      attempt: attempt({ status: "failed" }),
    }),
  );
});

test("inconsistent token totals are rejected", () => {
  assert.throws(() =>
    createOutcome(
      input({
        usage: {
          status: "recorded",
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 200,
        },
      }),
      links,
    ),
  );
});

test("a total below a present component is rejected", () => {
  assert.throws(() =>
    createOutcome(
      input({
        usage: { status: "recorded", inputTokens: 100, totalTokens: 50 },
      }),
      links,
    ),
  );
});

test("a total below a present output component is rejected", () => {
  assert.throws(() =>
    createOutcome(
      input({
        usage: { status: "recorded", outputTokens: 100, totalTokens: 50 },
      }),
      links,
    ),
  );
});

test("recorded usage without a measured value is rejected", () => {
  assert.throws(() =>
    createOutcome(
      input({ usage: { status: "recorded", modelIdentity: "reported" } }),
      links,
    ),
  );
});

test("retryCount conflicting with the attempt is rejected", () => {
  assert.throws(() => createOutcome(input({ retryCount: 5 }), links));
});

test("usage-unavailable carrying a token number is rejected", () => {
  assert.throws(() =>
    createOutcome(
      input({ usage: { status: "unavailable", inputTokens: 10 } }),
      links,
    ),
  );
});

test("escaped defect requires an accepted outcome", () => {
  assert.throws(() =>
    createOutcome(
      input({ decision: "rejected", escapedDefectStatus: "confirmed" }),
      { attempt: attempt({ status: "failed" }) },
    ),
  );
});

test("outcome input parser fails closed on malformed input", () => {
  assert.throws(() =>
    parseOutcomeInput({
      schemaVersion: "rigor.outcome-input.v1",
      taskId: "TASK-1",
      decision: "maybe",
      acceptedWithoutModelCodeChanges: false,
      humanCorrectionMinutes: 0,
      escalationCount: 0,
      reviewFindings: { critical: 0, high: 0, medium: 0, low: 0 },
      revertStatus: "none",
      escapedDefectStatus: "none",
      usage: { status: "unavailable" },
    }),
  );
});
