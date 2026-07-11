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

function makeContract() {
  return {
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
}

function makeV2Input(
  overrides: {
    confidence?: "low" | "medium" | "high";
    ambiguity?: "low" | "medium" | "high" | "critical";
    verificationStrength?: "weak" | "moderate" | "strong";
    evidence?: unknown;
  } = {},
): unknown {
  return {
    schemaVersion: "rigor.routing-input.v2",
    taskId: "TASK-1",
    purpose: "implementation",
    signals: {
      complexity: "medium",
      ambiguity: overrides.ambiguity ?? "low",
      novelty: "low",
      verificationStrength: overrides.verificationStrength ?? "strong",
    },
    budget: {
      maxAttempts: 2,
      maxDurationMs: 60_000,
      maxRelativeCost: 100,
    },
    assessment: {
      confidence: overrides.confidence ?? "medium",
      evidence: overrides.evidence ?? [
        {
          path: "src/a.ts",
          observation:
            "The module follows an existing pattern with deterministic tests.",
        },
      ],
    },
  };
}

test("v2 routing input with valid assessment selects a candidate", () => {
  const parsed = parseRoutingInput(makeV2Input());
  assert.equal(parsed.schemaVersion, "rigor.routing-input.v2");
  assert.equal(parsed.assessment?.confidence, "medium");
  assert.deepEqual(parsed.assessmentReasons, [
    "The module follows an existing pattern with deterministic tests.",
  ]);
  const decision = route(preflight, parsed, profiles);
  assert.equal(decision.status, "selected");
  assert.equal(decision.selection?.candidateId, "claude-standard");
  assert.deepEqual(decision.assessment, {
    inputSchemaVersion: "rigor.routing-input.v2",
    confidence: "medium",
    evidenceCount: 1,
  });
});

test("low-confidence v2 assessment requires review instead of a silent economy selection", () => {
  const parsed = parseRoutingInput(makeV2Input({ confidence: "low" }));
  const decision = route(preflight, parsed, profiles);
  assert.equal(decision.status, "requires-review");
  assert.equal(decision.selection, null);
  // Candidate filtering still runs so a reviewer sees the full picture.
  assert.deepEqual(decision.eligibleCandidates, [
    "claude-standard",
    "claude-premium",
  ]);
  assert.deepEqual(decision.assessment, {
    inputSchemaVersion: "rigor.routing-input.v2",
    confidence: "low",
    evidenceCount: 1,
  });
  assert.throws(() =>
    createRoutingPlan(decision, preflight, makeContract(), new Date(0)),
  );
});

test("evidence-free v2 assessment fails closed", () => {
  assert.throws(() => parseRoutingInput(makeV2Input({ evidence: [] })));
  assert.throws(() =>
    parseRoutingInput({
      ...(makeV2Input() as Record<string, unknown>),
      assessment: { confidence: "medium" },
    }),
  );
});

test("contradictory assessment: high confidence with critical ambiguity fails closed", () => {
  assert.throws(() =>
    parseRoutingInput(
      makeV2Input({ confidence: "high", ambiguity: "critical" }),
    ),
  );
});

test("contradictory assessment: high confidence with weak verification fails closed", () => {
  assert.throws(() =>
    parseRoutingInput(
      makeV2Input({ confidence: "high", verificationStrength: "weak" }),
    ),
  );
});

test("unsupported routing input schema version fails closed", () => {
  assert.throws(() =>
    parseRoutingInput({ ...input, schemaVersion: "rigor.routing-input.v3" }),
  );
});

test("v1 inputs and pre-v2 recorded plans remain backward compatible", () => {
  assert.deepEqual(parseRoutingInput(input), input);
  const decision = route(preflight, input, profiles);
  assert.equal(decision.status, "selected");
  assert.equal(decision.selection?.candidateId, "claude-standard");
  assert.deepEqual(decision.assessment, {
    inputSchemaVersion: "rigor.routing-input.v1",
    confidence: "medium",
    evidenceCount: 0,
  });
  const plan = createRoutingPlan(
    decision,
    preflight,
    makeContract(),
    new Date(0),
  );
  // Simulate a routing plan recorded before this change: it has no
  // `assessment` field at all. parseRoutingPlan must synthesize the legacy
  // default instead of failing closed.
  const legacyPlanJson = JSON.parse(JSON.stringify(plan)) as Record<
    string,
    unknown
  >;
  delete legacyPlanJson.assessment;
  const parsedLegacy = parseRoutingPlan(legacyPlanJson);
  assert.deepEqual(parsedLegacy.assessment, {
    inputSchemaVersion: "rigor.routing-input.v1",
    confidence: "medium",
    evidenceCount: 0,
  });
});

test("routing plan derived from a v2 assessment round-trips through parseRoutingPlan", () => {
  const parsed = parseRoutingInput(makeV2Input());
  const decision = route(preflight, parsed, profiles);
  const plan = createRoutingPlan(
    decision,
    preflight,
    makeContract(),
    new Date(0),
  );
  assert.deepEqual(plan.assessment, {
    inputSchemaVersion: "rigor.routing-input.v2",
    confidence: "medium",
    evidenceCount: 1,
  });
  assert.deepEqual(parseRoutingPlan(plan), plan);
});

test("route is deterministic for identical input", () => {
  const first = route(preflight, input, profiles);
  const second = route(preflight, input, profiles);
  assert.deepEqual(first, second);
  const parsedV2 = parseRoutingInput(makeV2Input());
  const firstV2 = route(preflight, parsedV2, profiles);
  const secondV2 = route(preflight, parsedV2, profiles);
  assert.deepEqual(firstV2, secondV2);
});

test("evidence path traversal or absolute path fails closed", () => {
  assert.throws(() =>
    parseRoutingInput(
      makeV2Input({
        evidence: [
          {
            path: "../secrets.txt",
            observation: "Attempts to escape the repository root.",
          },
        ],
      }),
    ),
  );
  assert.throws(() =>
    parseRoutingInput(
      makeV2Input({
        evidence: [
          {
            path: "/etc/passwd",
            observation: "Attempts to reference an absolute path.",
          },
        ],
      }),
    ),
  );
});

test("evidence count cap fails closed", () => {
  const tooManyItems = Array.from({ length: 21 }, (_, i) => ({
    path: `src/f${i}.ts`,
    observation: "obs",
  }));
  assert.throws(() =>
    parseRoutingInput(makeV2Input({ evidence: tooManyItems })),
  );
});

test("valid high-confidence non-contradictory v2 assessment selects successfully", () => {
  const parsed = parseRoutingInput(makeV2Input({ confidence: "high" }));
  const decision = route(preflight, parsed, profiles);
  assert.equal(decision.status, "selected");
  assert.notEqual(decision.selection, null);
  assert.equal(decision.assessment.confidence, "high");
  assert.equal(
    decision.assessment.evidenceCount,
    parsed.assessment?.evidence.length,
  );
});

// GH-11: an /rigor:assess-shaped fixture (all-low signals, path-anchored
// evidence) must deterministically select an eligible economy candidate, and
// the same shape with low confidence must stop instead of silently falling
// back to that economy candidate.

const spikePreflight: Preflight = {
  ...preflight,
  taskId: "SPIKE-ROUTE-1",
};

const economyProfiles: ModelProfiles = {
  schemaVersion: "rigor.model-profiles.v1",
  candidates: [
    {
      id: "claude-economy",
      provider: "claude",
      capabilityClass: "economy",
      purposes: ["implementation"],
      relativeCost: 5,
      requiresAdditionalExternalTransmission: false,
      enabled: true,
    },
    {
      id: "claude-standard",
      provider: "claude",
      capabilityClass: "standard",
      purposes: ["implementation"],
      relativeCost: 20,
      requiresAdditionalExternalTransmission: false,
      enabled: true,
    },
  ],
};

function makeSpikeContract() {
  return {
    schemaVersion: "rigor.contract.v1" as const,
    artifactId: "spike-contract-1",
    taskId: "SPIKE-ROUTE-1",
    createdAt: new Date(0).toISOString(),
    preflightArtifactId: spikePreflight.artifactId,
    preflightHash: hash(spikePreflight),
    riskTier: spikePreflight.riskTier,
    externalTransmission: spikePreflight.externalTransmission,
    acceptanceCriteria: ["greeting constant exists"],
    allowedPaths: ["src/**"],
    constraints: [],
    requiredChecks: [],
    stopConditions: [],
  };
}

function makeSpikeInput(confidence: "low" | "medium" | "high"): unknown {
  return {
    schemaVersion: "rigor.routing-input.v2",
    taskId: "SPIKE-ROUTE-1",
    purpose: "implementation",
    signals: {
      complexity: "low",
      ambiguity: "low",
      novelty: "low",
      verificationStrength: "strong",
    },
    budget: {
      maxAttempts: 2,
      maxDurationMs: 60_000,
      maxRelativeCost: 100,
    },
    assessment: {
      confidence,
      evidence: [
        {
          path: "src/greeting.ts",
          observation:
            "The file defines a single constant export with no branching logic and an existing deterministic test.",
        },
      ],
    },
  };
}

test("SPIKE-ROUTE-1-like all-low-signal assessment deterministically selects an eligible economy candidate", () => {
  const parsed = parseRoutingInput(makeSpikeInput("medium"));
  const decision = route(spikePreflight, parsed, economyProfiles);
  assert.equal(decision.status, "selected");
  assert.equal(decision.requiredCapabilityClass, "economy");
  assert.equal(decision.selection?.candidateId, "claude-economy");
  assert.equal(decision.selection?.capabilityClass, "economy");
  const plan = createRoutingPlan(
    decision,
    spikePreflight,
    makeSpikeContract(),
    new Date(0),
  );
  assert.equal(plan.status, "planned");
  assert.equal(plan.selection?.candidateId, "claude-economy");
});

test("SPIKE-ROUTE-1-like low-confidence assessment requires review instead of silently selecting the economy candidate", () => {
  const parsed = parseRoutingInput(makeSpikeInput("low"));
  const decision = route(spikePreflight, parsed, economyProfiles);
  assert.equal(decision.status, "requires-review");
  assert.equal(decision.selection, null);
  // The economy candidate remains eligible under deterministic filtering;
  // low confidence alone is what stops selection, not exclusion.
  assert.deepEqual(decision.eligibleCandidates, [
    "claude-economy",
    "claude-standard",
  ]);
  assert.throws(() =>
    createRoutingPlan(
      decision,
      spikePreflight,
      makeSpikeContract(),
      new Date(0),
    ),
  );
});
