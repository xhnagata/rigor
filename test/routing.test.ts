import test from "node:test";
import assert from "node:assert/strict";
import {
  createRoutingPlan,
  parseModelProfiles,
  parseRoutingPlan,
  parseRoutingInput,
  requiredCapability,
  route,
} from "../src/routing.js";
import { hash } from "../src/util.js";
import type { ModelProfiles, Preflight, RoutingInput } from "../src/types.js";

const preflight: Preflight = {
  schemaVersion: "rigor.preflight.v1",
  artifactId: "preflight-1",
  taskId: "TASK-1",
  createdAt: new Date(0).toISOString(),
  policyHash: "policy",
  intentHash: "intent",
  git: {
    root: "/repo",
    head: "abc",
    dirty: false,
    changedPaths: [],
  },
  plannedPaths: ["src/a.ts"],
  riskTier: "high",
  externalTransmission: "allowed",
  protectedPaths: [],
  requireHumanApproval: true,
  stopConditions: [],
  reasons: [],
};

const input: RoutingInput = {
  schemaVersion: "rigor.routing-input.v1",
  taskId: "TASK-1",
  purpose: "implementation",
  signals: {
    complexity: "medium",
    ambiguity: "low",
    novelty: "low",
    verificationStrength: "strong",
  },
  assessmentReasons: [
    "The task follows an existing pattern and has deterministic tests.",
  ],
  budget: {
    maxAttempts: 2,
    maxDurationMs: 60_000,
    maxRelativeCost: 100,
  },
};

const profiles: ModelProfiles = {
  schemaVersion: "rigor.model-profiles.v1",
  candidates: [
    {
      id: "claude-standard",
      provider: "claude",
      capabilityClass: "standard",
      purposes: ["implementation", "review"],
      relativeCost: 20,
      requiresAdditionalExternalTransmission: false,
      enabled: true,
    },
    {
      id: "claude-premium",
      provider: "claude",
      capabilityClass: "premium",
      purposes: ["implementation", "review"],
      relativeCost: 50,
      requiresAdditionalExternalTransmission: false,
      enabled: true,
    },
    {
      id: "codex-consult",
      provider: "codex-plugin-cc",
      capabilityClass: "frontier",
      purposes: ["consultation", "adversarial-review", "rescue"],
      relativeCost: 40,
      requiresAdditionalExternalTransmission: true,
      enabled: true,
    },
  ],
};

test("selects the lowest-cost eligible candidate deterministically", () => {
  const decision = route(preflight, input, profiles);
  assert.equal(decision.status, "selected");
  assert.equal(decision.requiredCapabilityClass, "standard");
  assert.equal(decision.selection?.candidateId, "claude-standard");
  assert.match(decision.routingInputHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(decision.eligibleCandidates, [
    "claude-standard",
    "claude-premium",
  ]);
  assert.deepEqual(decision.excludedCandidates, [
    { candidateId: "codex-consult", reasonCode: "PURPOSE_UNSUPPORTED" },
  ]);
  assert.equal(decision.controls.requireIndependentReview, true);
});

test("weak verification raises required capability by one class", () => {
  const weak = {
    ...input,
    signals: { ...input.signals, verificationStrength: "weak" as const },
  };
  assert.equal(requiredCapability(weak), "premium");
  assert.equal(
    route(preflight, weak, profiles).selection?.candidateId,
    "claude-premium",
  );
});

test("external-transmission denial excludes an additional provider", () => {
  const consultation = {
    ...input,
    purpose: "consultation" as const,
    signals: {
      ...input.signals,
      complexity: "critical" as const,
    },
  };
  const denied = {
    ...preflight,
    externalTransmission: "denied" as const,
  };
  const decision = route(denied, consultation, profiles);
  assert.equal(decision.status, "unroutable");
  assert.deepEqual(decision.excludedCandidates, [
    { candidateId: "claude-standard", reasonCode: "PURPOSE_UNSUPPORTED" },
    { candidateId: "claude-premium", reasonCode: "PURPOSE_UNSUPPORTED" },
    {
      candidateId: "codex-consult",
      reasonCode: "EXTERNAL_TRANSMISSION_DENIED",
    },
  ]);
});

test("budget and capability exclusions fail closed", () => {
  const constrained = {
    ...input,
    signals: { ...input.signals, complexity: "high" as const },
    budget: { ...input.budget, maxRelativeCost: 30 },
  };
  const decision = route(preflight, constrained, profiles);
  assert.equal(decision.status, "unroutable");
  assert.deepEqual(decision.excludedCandidates, [
    {
      candidateId: "claude-standard",
      reasonCode: "INSUFFICIENT_CAPABILITY",
    },
    { candidateId: "claude-premium", reasonCode: "BUDGET_EXCEEDED" },
    { candidateId: "codex-consult", reasonCode: "PURPOSE_UNSUPPORTED" },
  ]);
});

test("routing parsers reject malformed and duplicate profiles", () => {
  assert.deepEqual(parseRoutingInput(input), input);
  assert.deepEqual(parseModelProfiles(profiles), profiles);
  assert.throws(() =>
    parseModelProfiles({
      ...profiles,
      candidates: [profiles.candidates[0], profiles.candidates[0]],
    }),
  );
  assert.throws(() =>
    parseModelProfiles({
      ...profiles,
      candidates: [{ ...profiles.candidates[0], purposes: [] }],
    }),
  );
  assert.throws(() => parseRoutingInput({ ...input, assessmentReasons: [] }));
  assert.throws(() =>
    route(preflight, { ...input, taskId: "OTHER" }, profiles),
  );
});

test("routing plan binds a selected decision to its contract", () => {
  const contract = {
    schemaVersion: "rigor.contract.v1" as const,
    artifactId: "contract-1",
    taskId: "TASK-1",
    createdAt: new Date(0).toISOString(),
    preflightArtifactId: preflight.artifactId,
    preflightHash: hash(preflight),
    riskTier: preflight.riskTier,
    externalTransmission: preflight.externalTransmission,
    acceptanceCriteria: ["works"],
    allowedPaths: ["src/**"],
    constraints: [],
    requiredChecks: [],
    stopConditions: [],
  };
  const plan = createRoutingPlan(
    route(preflight, input, profiles),
    preflight,
    contract,
    new Date(0),
  );
  assert.equal(plan.status, "planned");
  assert.equal(plan.contractArtifactId, contract.artifactId);
  assert.deepEqual(parseRoutingPlan(plan), plan);
});
