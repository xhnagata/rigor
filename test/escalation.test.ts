import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  parseEscalationDecisionInput,
  selectEscalation,
  validateEscalationArtifacts,
} from "../src/escalation.js";
import { hash } from "../src/util.js";
import { createContract } from "../src/artifacts.js";
import { gitFacts } from "../src/git.js";
import { evaluate } from "../src/policy.js";
import { createRoutingPlan, route } from "../src/routing.js";
import { defaultPolicy } from "../src/setup.js";
import type {
  Attempt,
  AvailabilityReport,
  Contract,
  EscalationDecisionInput,
  ModelProfiles,
  RoutingPlan,
} from "../src/types.js";

const exec = promisify(execFile);
const pluginRoot = path.resolve(import.meta.dirname, "..");

const digest = "a".repeat(64);
const fingerprint = "b".repeat(64);

function profiles(): ModelProfiles {
  return {
    schemaVersion: "rigor.model-profiles.v1",
    candidates: [
      {
        id: "standard",
        provider: "claude",
        capabilityClass: "standard",
        purposes: ["implementation"],
        relativeCost: 10,
        requiresAdditionalExternalTransmission: false,
        enabled: true,
      },
      {
        id: "premium-b",
        provider: "claude",
        capabilityClass: "premium",
        purposes: ["implementation"],
        relativeCost: 20,
        requiresAdditionalExternalTransmission: false,
        enabled: true,
      },
      {
        id: "premium-a",
        provider: "claude",
        capabilityClass: "premium",
        purposes: ["implementation"],
        relativeCost: 20,
        requiresAdditionalExternalTransmission: false,
        enabled: true,
      },
      {
        id: "frontier",
        provider: "codex-plugin-cc",
        capabilityClass: "frontier",
        purposes: ["implementation"],
        relativeCost: 40,
        requiresAdditionalExternalTransmission: true,
        enabled: true,
      },
    ],
  };
}

function rawInput(): Record<string, unknown> {
  const modelProfiles = profiles();
  return {
    schemaVersion: "rigor.escalation-decision-input.v1",
    taskId: "GH-14",
    purpose: "implementation",
    contract: { artifactId: "contract_1", artifactHash: digest },
    routingPlan: {
      artifactId: "plan_1",
      artifactHash: digest,
      modelProfilesHash: hash(modelProfiles),
    },
    currentAttempt: {
      artifactId: "attempt_1",
      artifactHash: digest,
      routingPlanArtifactId: "plan_1",
      routingPlanHash: digest,
      sequence: 1,
      capabilityClass: "standard",
      failureCategory: "implementation",
      progress: "first",
      failureFingerprint: fingerprint,
      durationMs: 100,
      relativeCost: 10,
    },
    previousAttempts: [],
    riskTier: "medium",
    externalTransmission: "allowed",
    failureCategory: "implementation",
    progress: "first",
    fingerprintRepetitions: 1,
    currentCapabilityClass: "standard",
    attemptCount: 1,
    elapsedMs: 100,
    consumedRelativeCost: 10,
    budget: {
      maxAttempts: 5,
      maxDurationMs: 10_000,
      maxRelativeCost: 100,
    },
    concerns: {
      requirementsChangeRequired: false,
      acceptanceCriteriaChangeRequired: false,
      humanOnlyDecision: false,
      scopeViolation: false,
      protectedTestMutation: false,
      configuredCheckRemoval: false,
      configuredCheckWeakening: false,
      security: false,
      dataIntegrity: false,
      architectureChange: false,
      contractContradiction: false,
    },
    speculation: ["model-authored hypothesis; not a selector fact"],
  };
}

function parsed(mutator?: (raw: Record<string, unknown>) => void) {
  const raw = rawInput();
  mutator?.(raw);
  return parseEscalationDecisionInput(raw);
}

function concerns(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.concerns as Record<string, unknown>;
}

function current(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.currentAttempt as Record<string, unknown>;
}

function repeatedUnchanged(raw: Record<string, unknown>): void {
  const first = {
    ...current(raw),
    artifactId: "attempt_1",
    sequence: 1,
    progress: "first",
  };
  raw.previousAttempts = [first];
  raw.currentAttempt = {
    ...current(raw),
    artifactId: "attempt_2",
    sequence: 2,
    progress: "unchanged",
  };
  raw.progress = "unchanged";
  raw.attemptCount = 2;
  raw.elapsedMs = 200;
  raw.consumedRelativeCost = 20;
  raw.fingerprintRepetitions = 2;
}

function availability(
  modelProfiles: ModelProfiles,
  states: Record<
    string,
    "available" | "unavailable" | "unknown" | "incompatible"
  >,
): AvailabilityReport {
  return {
    schemaVersion: "rigor.availability.v1",
    artifactId: "availability_1",
    createdAt: new Date(0).toISOString(),
    modelProfilesHash: hash(modelProfiles),
    probeStatus: "supported",
    environment: {
      claudeCode: { present: false, version: null },
      configuredModel: null,
      codexPlugin: { presence: "unknown", version: null },
    },
    candidates: modelProfiles.candidates.map((candidate) => ({
      candidateId: candidate.id,
      provider: candidate.provider,
      state: states[candidate.id] ?? "unknown",
      reason: "fixture observation",
      observedAt: new Date(0).toISOString(),
      toolVersion: null,
    })),
  };
}

test("identical validated input produces an identical decision", () => {
  const input = parsed();
  assert.deepEqual(
    selectEscalation(input, profiles()),
    selectEscalation(input, profiles()),
  );
});

test("ordinary implementation defect selects adjacent capability", () => {
  const result = selectEscalation(parsed(), profiles());
  assert.equal(result.decision, "escalate-adjacent");
  assert.equal(result.targetCapabilityClass, "premium");
  assert.equal(result.selection?.candidateId, "premium-a");
});

test("architecture and safety concerns can escalate directly to frontier", () => {
  const result = selectEscalation(
    parsed((raw) => {
      concerns(raw).architectureChange = true;
    }),
    profiles(),
  );
  assert.equal(result.decision, "escalate-direct");
  assert.equal(result.targetCapabilityClass, "frontier");
  assert.equal(result.selection?.candidateId, "frontier");
});

test("repeated unchanged fingerprint escalates directly to premium", () => {
  const result = selectEscalation(parsed(repeatedUnchanged), profiles());
  assert.equal(result.decision, "escalate-direct");
  assert.equal(result.reasonCode, "REPEATED_UNCHANGED_FAILURE");
  assert.equal(result.targetCapabilityClass, "premium");
});

for (const [progress, expected, reason] of [
  ["reduced", "retry-current", "FAILURE_SET_REDUCED"],
  ["expanded", "escalate-adjacent", "FAILURE_SET_EXPANDED"],
  ["incomparable", "escalate-adjacent", "FAILURE_SET_INCOMPARABLE"],
] as const) {
  test(`${progress} failure progress is handled explicitly`, () => {
    const result = selectEscalation(
      parsed((raw) => {
        raw.progress = progress;
        current(raw).progress = progress;
      }),
      profiles(),
    );
    assert.equal(result.decision, expected);
    assert.equal(result.reasonCode, reason);
  });
}

for (const category of ["infrastructure", "timeout"] as const) {
  test(`${category} retries infrastructure without selecting frontier`, () => {
    const result = selectEscalation(
      parsed((raw) => {
        raw.failureCategory = category;
        current(raw).failureCategory = category;
      }),
      profiles(),
    );
    assert.equal(result.decision, "retry-infrastructure");
    assert.equal(result.selection, null);
    assert.equal(result.targetCapabilityClass, null);
  });
}

test("infrastructure retries stop at the configured limit", () => {
  const result = selectEscalation(
    parsed((raw) => {
      raw.failureCategory = "infrastructure";
      current(raw).failureCategory = "infrastructure";
      raw.thresholds = {
        unchangedAttemptsBeforeDirect: 2,
        infrastructureRetries: 0,
      };
    }),
    profiles(),
  );
  assert.equal(result.decision, "stop-infrastructure");
});

for (const [flag, reason] of [
  ["scopeViolation", "SCOPE_VIOLATION"],
  ["protectedTestMutation", "PROTECTED_TEST_MUTATION"],
  ["configuredCheckWeakening", "CONFIGURED_CHECK_WEAKENING"],
  ["configuredCheckRemoval", "CONFIGURED_CHECK_REMOVAL"],
] as const) {
  test(`${flag} stops immediately`, () => {
    const result = selectEscalation(
      parsed((raw) => {
        concerns(raw)[flag] = true;
      }),
      profiles(),
    );
    assert.equal(result.decision, "stop-policy-violation");
    assert.equal(result.reasonCode, reason);
  });
}

test("policy stops take priority over exhausted budgets", () => {
  const result = selectEscalation(
    parsed((raw) => {
      concerns(raw).scopeViolation = true;
      (raw.budget as Record<string, unknown>).maxAttempts = 1;
    }),
    profiles(),
  );
  assert.equal(result.decision, "stop-policy-violation");
});

for (const flag of [
  "requirementsChangeRequired",
  "acceptanceCriteriaChangeRequired",
] as const) {
  test(`${flag} requires a human decision`, () => {
    const result = selectEscalation(
      parsed((raw) => {
        concerns(raw)[flag] = true;
      }),
      profiles(),
    );
    assert.equal(result.decision, "stop-human-decision");
  });
}

for (const [field, value, reason] of [
  ["maxAttempts", 1, "MAX_ATTEMPTS_EXHAUSTED"],
  ["maxDurationMs", 1_000, "MAX_DURATION_EXHAUSTED"],
  ["maxRelativeCost", 10, "MAX_RELATIVE_COST_EXHAUSTED"],
] as const) {
  test(`${field} budget is enforced`, () => {
    const result = selectEscalation(
      parsed((raw) => {
        (raw.budget as Record<string, unknown>)[field] = value;
        if (field === "maxDurationMs") {
          raw.elapsedMs = value;
          current(raw).durationMs = value;
        }
      }),
      profiles(),
    );
    assert.equal(result.decision, "stop-budget-exhausted");
    assert.equal(result.reasonCode, reason);
  });
}

for (const [state, reason] of [
  ["unavailable", "UNAVAILABLE"],
  ["incompatible", "INCOMPATIBLE"],
] as const) {
  test(`${state} candidates are excluded`, () => {
    const modelProfiles = profiles();
    const report = availability(modelProfiles, {
      "premium-a": state,
      "premium-b": state,
    });
    const result = selectEscalation(parsed(), modelProfiles, report);
    assert.equal(result.decision, "stop-no-eligible-candidate");
    assert.equal(
      result.excludedCandidates.find((item) => item.candidateId === "premium-a")
        ?.reasonCode,
      reason,
    );
  });
}

test("transmission-denied candidates are excluded", () => {
  const modelProfiles = profiles();
  for (const candidate of modelProfiles.candidates)
    if (candidate.capabilityClass === "premium")
      candidate.requiresAdditionalExternalTransmission = true;
  const input = parsed((raw) => {
    raw.externalTransmission = "denied";
    (raw.routingPlan as Record<string, unknown>).modelProfilesHash =
      hash(modelProfiles);
  });
  const result = selectEscalation(input, modelProfiles);
  assert.equal(result.decision, "stop-no-eligible-candidate");
  assert.equal(
    result.excludedCandidates.find((item) => item.candidateId === "premium-a")
      ?.reasonCode,
    "EXTERNAL_TRANSMISSION_DENIED",
  );
});

for (const [mutation, reason] of [
  [
    (candidate: ModelProfiles["candidates"][number]) => {
      candidate.enabled = false;
    },
    "DISABLED",
  ],
  [
    (candidate: ModelProfiles["candidates"][number]) => {
      candidate.purposes = ["review"];
    },
    "PURPOSE_UNSUPPORTED",
  ],
] as const) {
  test(`${reason} candidates are never selected`, () => {
    const modelProfiles = profiles();
    for (const candidate of modelProfiles.candidates)
      if (candidate.capabilityClass === "premium") mutation(candidate);
    const input = parsed((raw) => {
      (raw.routingPlan as Record<string, unknown>).modelProfilesHash =
        hash(modelProfiles);
    });
    const result = selectEscalation(input, modelProfiles);
    assert.equal(result.decision, "stop-no-eligible-candidate");
    assert.equal(
      result.excludedCandidates.find((item) => item.candidateId === "premium-a")
        ?.reasonCode,
      reason,
    );
  });
}

test("candidate ties use relative cost then stable candidate id", () => {
  const result = selectEscalation(parsed(), profiles());
  assert.deepEqual(result.eligibleCandidates, ["premium-a", "premium-b"]);
  assert.equal(result.selection?.candidateId, "premium-a");
});

test("candidate cost that exceeds remaining budget is a structured stop", () => {
  const result = selectEscalation(
    parsed((raw) => {
      (raw.budget as Record<string, unknown>).maxRelativeCost = 25;
    }),
    profiles(),
  );
  assert.equal(result.decision, "stop-no-eligible-candidate");
  assert.equal(result.reasonCode, "NO_ELIGIBLE_CANDIDATE");
});

test("malformed and unsupported schemas fail closed", () => {
  assert.throws(() => parseEscalationDecisionInput({}));
  assert.throws(() =>
    parseEscalationDecisionInput({
      ...rawInput(),
      schemaVersion: "rigor.escalation-decision-input.v2",
    }),
  );
});

test("stale aggregate attempt facts fail closed", () => {
  assert.throws(() =>
    parsed((raw) => {
      raw.elapsedMs = 99;
    }),
  );
});

test("stale linked artifacts fail closed", () => {
  const input = parsed();
  assert.throws(() =>
    validateEscalationArtifacts(
      input,
      {
        schemaVersion: "rigor.contract.v1",
        artifactId: "different",
        taskId: "GH-14",
        createdAt: new Date(0).toISOString(),
        preflightArtifactId: "preflight_1",
        preflightHash: digest,
        riskTier: "medium",
        externalTransmission: "allowed",
        acceptanceCriteria: ["works"],
        allowedPaths: ["src/**"],
        constraints: [],
        requiredChecks: [],
        stopConditions: [],
      },
      [],
      [],
    ),
  );
});

test("legacy escalation v1 remains a distinct accepted schema", async () => {
  const { parseEscalationInput } = await import("../src/artifacts.js");
  assert.equal(
    parseEscalationInput({
      schemaVersion: "rigor.escalation-input.v1",
      taskId: "GH-14",
      facts: ["fact"],
      attempts: [{ action: "inspect", result: "failed" }],
      disprovedHypotheses: [],
      speculation: [],
      requestedDecision: "review",
    }).schemaVersion,
    "rigor.escalation-input.v1",
  );
});

test("facts and model-authored speculation remain separate", () => {
  const input: EscalationDecisionInput = parsed();
  const result = selectEscalation(input, profiles());
  assert.deepEqual(result.speculation, input.speculation);
  assert.equal(result.facts.failureCategory, "implementation");
});

test("humanOnlyDecision requires a human decision", () => {
  const result = selectEscalation(
    parsed((raw) => {
      concerns(raw).humanOnlyDecision = true;
    }),
    profiles(),
  );
  assert.equal(result.decision, "stop-human-decision");
  assert.equal(result.reasonCode, "HUMAN_ONLY_DECISION");
});

test("contract contradiction escalates directly to premium", () => {
  const result = selectEscalation(
    parsed((raw) => {
      concerns(raw).contractContradiction = true;
    }),
    profiles(),
  );
  assert.equal(result.decision, "escalate-direct");
  assert.equal(result.reasonCode, "CONTRACT_CONTRADICTION");
  assert.equal(result.targetCapabilityClass, "premium");
});

for (const flag of ["security", "dataIntegrity"] as const) {
  test(`${flag} concern escalates directly to frontier`, () => {
    const result = selectEscalation(
      parsed((raw) => {
        concerns(raw)[flag] = true;
      }),
      profiles(),
    );
    assert.equal(result.decision, "escalate-direct");
    assert.equal(result.reasonCode, "SAFETY_CONCERN");
    assert.equal(result.targetCapabilityClass, "frontier");
  });
}

test("critical risk with repeated unchanged failure targets frontier", () => {
  const result = selectEscalation(
    parsed((raw) => {
      repeatedUnchanged(raw);
      raw.riskTier = "critical";
    }),
    profiles(),
  );
  assert.equal(result.decision, "escalate-direct");
  assert.equal(result.reasonCode, "REPEATED_UNCHANGED_FAILURE");
  assert.equal(result.targetCapabilityClass, "frontier");
});

test("direct escalation above frontier is a structured stop", () => {
  const result = selectEscalation(
    parsed((raw) => {
      concerns(raw).architectureChange = true;
      raw.currentCapabilityClass = "frontier";
      current(raw).capabilityClass = "frontier";
    }),
    profiles(),
  );
  assert.equal(result.decision, "stop-no-eligible-candidate");
  assert.equal(result.reasonCode, "NO_HIGHER_CAPABILITY_CLASS");
  assert.equal(result.selection, null);
});

test("flaky failures retry the current capability class", () => {
  const result = selectEscalation(
    parsed((raw) => {
      raw.failureCategory = "flaky";
      current(raw).failureCategory = "flaky";
    }),
    profiles(),
  );
  assert.equal(result.decision, "retry-current");
  assert.equal(result.reasonCode, "FLAKY_RETRY");
  assert.equal(result.targetCapabilityClass, "standard");
  assert.equal(result.selection?.candidateId, "standard");
});

test("mixed failures escalate to the adjacent capability class", () => {
  const result = selectEscalation(
    parsed((raw) => {
      raw.failureCategory = "mixed";
      current(raw).failureCategory = "mixed";
    }),
    profiles(),
  );
  assert.equal(result.decision, "escalate-adjacent");
  assert.equal(result.reasonCode, "ORDINARY_IMPLEMENTATION_DEFECT");
});

test("unknown availability never excludes a candidate", () => {
  const modelProfiles = profiles();
  const report = availability(modelProfiles, {
    "premium-a": "unknown",
    "premium-b": "unavailable",
  });
  const result = selectEscalation(parsed(), modelProfiles, report);
  assert.equal(result.decision, "escalate-adjacent");
  assert.equal(result.selection?.candidateId, "premium-a");
  assert.equal(
    result.excludedCandidates.find((item) => item.candidateId === "premium-b")
      ?.reasonCode,
    "UNAVAILABLE",
  );
});

test("a raised unchanged threshold keeps escalation adjacent", () => {
  const result = selectEscalation(
    parsed((raw) => {
      repeatedUnchanged(raw);
      raw.thresholds = {
        unchangedAttemptsBeforeDirect: 3,
        infrastructureRetries: 2,
      };
    }),
    profiles(),
  );
  assert.equal(result.decision, "escalate-adjacent");
  assert.equal(result.targetCapabilityClass, "premium");
});

test("human stops take priority over exhausted budgets", () => {
  const result = selectEscalation(
    parsed((raw) => {
      concerns(raw).humanOnlyDecision = true;
      (raw.budget as Record<string, unknown>).maxAttempts = 1;
    }),
    profiles(),
  );
  assert.equal(result.decision, "stop-human-decision");
});

test("budget-excluded candidates record BUDGET_EXCEEDED", () => {
  const result = selectEscalation(
    parsed((raw) => {
      (raw.budget as Record<string, unknown>).maxRelativeCost = 25;
    }),
    profiles(),
  );
  assert.equal(result.decision, "stop-no-eligible-candidate");
  assert.equal(
    result.excludedCandidates.find((item) => item.candidateId === "premium-a")
      ?.reasonCode,
    "BUDGET_EXCEEDED",
  );
});

test("reduced progress retries current even with a safety concern", () => {
  const result = selectEscalation(
    parsed((raw) => {
      raw.progress = "reduced";
      current(raw).progress = "reduced";
      concerns(raw).security = true;
    }),
    profiles(),
  );
  assert.equal(result.decision, "retry-current");
  assert.equal(result.reasonCode, "FAILURE_SET_REDUCED");
});

test("input key order does not change the decision", () => {
  const raw = rawInput();
  const reversed = Object.fromEntries(Object.entries(raw).reverse());
  assert.deepEqual(
    selectEscalation(parseEscalationDecisionInput(reversed), profiles()),
    selectEscalation(parseEscalationDecisionInput(raw), profiles()),
  );
});

test("stale fingerprint repetition counts fail closed", () => {
  assert.throws(() =>
    parsed((raw) => {
      raw.fingerprintRepetitions = 0;
    }),
  );
});

test("a current attempt linked to a different plan fails closed", () => {
  assert.throws(() =>
    parsed((raw) => {
      current(raw).routingPlanArtifactId = "plan_2";
    }),
  );
  assert.throws(() =>
    parsed((raw) => {
      current(raw).routingPlanHash = "c".repeat(64);
    }),
  );
});

test("a budget the plan did not authorize fails closed", () => {
  const contract: Contract = {
    schemaVersion: "rigor.contract.v1",
    artifactId: "contract_1",
    taskId: "GH-14",
    createdAt: new Date(0).toISOString(),
    preflightArtifactId: "preflight_1",
    preflightHash: digest,
    riskTier: "medium",
    externalTransmission: "allowed",
    acceptanceCriteria: ["works"],
    allowedPaths: ["src/**"],
    constraints: [],
    requiredChecks: [],
    stopConditions: [],
  };
  const modelProfiles = profiles();
  const plan: RoutingPlan = {
    schemaVersion: "rigor.routing-plan.v1",
    artifactId: "plan_1",
    createdAt: new Date(0).toISOString(),
    taskId: "GH-14",
    preflightArtifactId: "preflight_1",
    preflightHash: digest,
    routingInputHash: digest,
    modelProfilesHash: hash(modelProfiles),
    purpose: "implementation",
    requiredCapabilityClass: "standard",
    eligibleCandidates: ["standard"],
    excludedCandidates: [],
    selection: {
      candidateId: "standard",
      provider: "claude",
      capabilityClass: "standard",
      relativeCost: 10,
    },
    controls: {
      externalTransmission: "allowed",
      requireHumanApproval: false,
      requireIndependentReview: false,
    },
    budget: { maxAttempts: 5, maxDurationMs: 10_000, maxRelativeCost: 100 },
    assessment: {
      inputSchemaVersion: "rigor.routing-input.v1",
      confidence: "high",
      evidenceCount: 1,
    },
    contractArtifactId: "contract_1",
    contractHash: hash(contract),
    policyHash: digest,
    plannedHead: null,
    status: "planned",
  };
  const attempt: Attempt = {
    schemaVersion: "rigor.attempt.v1",
    artifactId: "attempt_1",
    taskId: "GH-14",
    createdAt: new Date(100).toISOString(),
    sessionArtifactId: "session_1",
    sessionHash: digest,
    routingPlanArtifactId: "plan_1",
    routingPlanHash: hash(plan),
    contractArtifactId: "contract_1",
    contractHash: hash(contract),
    sequence: 1,
    provider: "claude",
    capabilityClass: "standard",
    purpose: "implementation",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(100).toISOString(),
    durationMs: 100,
    executionIdentityStatus: "unverified",
    status: "failed",
    beforeHead: null,
    afterHead: null,
    beforeTreeHash: digest,
    afterTreeHash: digest,
    changedPathsBefore: [],
    changedPaths: [],
    scopeViolations: [],
    failureFingerprint: fingerprint,
    failureCategory: "implementation",
    failureFacts: [],
    progress: {
      status: "first",
      comparedToAttemptArtifactId: null,
      weakeningSignals: [],
    },
  };
  const link = (budget: Record<string, number>) =>
    parseEscalationDecisionInput({
      ...rawInput(),
      budget,
      contract: { artifactId: "contract_1", artifactHash: hash(contract) },
      routingPlan: {
        artifactId: "plan_1",
        artifactHash: hash(plan),
        modelProfilesHash: hash(modelProfiles),
      },
      currentAttempt: {
        ...current(rawInput()),
        artifactHash: hash(attempt),
        routingPlanArtifactId: "plan_1",
        routingPlanHash: hash(plan),
      },
    });
  const authorized = link({
    maxAttempts: 5,
    maxDurationMs: 10_000,
    maxRelativeCost: 100,
  });
  validateEscalationArtifacts(authorized, contract, [plan], [attempt]);
  const inflated = link({
    maxAttempts: 5,
    maxDurationMs: 10_000,
    maxRelativeCost: 200,
  });
  assert.throws(() =>
    validateEscalationArtifacts(inflated, contract, [plan], [attempt]),
  );
});

test("CLI computes and appends decision evidence without overwriting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rigor-escalation-cli-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "rigor@example.invalid"], {
    cwd: root,
  });
  await exec("git", ["config", "user.name", "Rigor Test"], { cwd: root });
  await exec("git", ["commit", "-q", "--allow-empty", "-m", "initial"], {
    cwd: root,
  });
  const policy = defaultPolicy("repo");
  await mkdir(path.join(root, ".rigor"));
  await writeFile(
    path.join(root, ".rigor", "policy.json"),
    JSON.stringify(policy),
  );
  const preflight = evaluate(
    policy,
    {
      schemaVersion: "rigor.intent.v1",
      taskId: "GH-14-CLI",
      summary: "exercise escalation CLI",
      plannedPaths: ["src/a.ts"],
    },
    await gitFacts(root),
    new Date(0),
  );
  const contract = createContract(
    policy,
    preflight,
    {
      schemaVersion: "rigor.contract-input.v1",
      taskId: "GH-14-CLI",
      acceptanceCriteria: ["decision is appended"],
      allowedPaths: ["src/**"],
      constraints: [],
    },
    new Date(0),
  );
  const modelProfiles = profiles();
  const routingInput = {
    schemaVersion: "rigor.routing-input.v1" as const,
    taskId: "GH-14-CLI",
    purpose: "implementation" as const,
    signals: {
      complexity: "medium" as const,
      ambiguity: "low" as const,
      novelty: "low" as const,
      verificationStrength: "strong" as const,
    },
    assessmentReasons: ["fixture"],
    budget: {
      maxAttempts: 5,
      maxDurationMs: 10_000,
      maxRelativeCost: 100,
    },
  };
  const plan = createRoutingPlan(
    route(preflight, routingInput, modelProfiles),
    preflight,
    contract,
    new Date(0),
  );
  const attempt: Attempt = {
    schemaVersion: "rigor.attempt.v1",
    artifactId: "attempt_cli_1",
    taskId: "GH-14-CLI",
    createdAt: new Date(100).toISOString(),
    sessionArtifactId: "session_cli_1",
    sessionHash: digest,
    routingPlanArtifactId: plan.artifactId,
    routingPlanHash: hash(plan),
    contractArtifactId: contract.artifactId,
    contractHash: hash(contract),
    sequence: 1,
    provider: "claude",
    capabilityClass: "standard",
    purpose: "implementation",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(100).toISOString(),
    durationMs: 100,
    executionIdentityStatus: "unverified",
    status: "failed",
    beforeHead: null,
    afterHead: null,
    beforeTreeHash: digest,
    afterTreeHash: digest,
    changedPathsBefore: [],
    changedPaths: [],
    scopeViolations: [],
    failureFingerprint: fingerprint,
    failureCategory: "implementation",
    failureFacts: [],
    progress: {
      status: "first",
      comparedToAttemptArtifactId: null,
      weakeningSignals: [],
    },
  };
  const input = {
    ...rawInput(),
    taskId: "GH-14-CLI",
    contract: {
      artifactId: contract.artifactId,
      artifactHash: hash(contract),
    },
    routingPlan: {
      artifactId: plan.artifactId,
      artifactHash: hash(plan),
      modelProfilesHash: hash(modelProfiles),
    },
    currentAttempt: {
      artifactId: attempt.artifactId,
      artifactHash: hash(attempt),
      routingPlanArtifactId: plan.artifactId,
      routingPlanHash: hash(plan),
      sequence: 1,
      capabilityClass: "standard",
      failureCategory: "implementation",
      progress: "first",
      failureFingerprint: fingerprint,
      durationMs: 100,
      relativeCost: 10,
    },
  };
  const files = {
    contract: path.join(root, "contract.json"),
    plan: path.join(root, "plan.json"),
    attempt: path.join(root, "attempt.json"),
    input: path.join(root, "input.json"),
    profiles: path.join(root, "profiles.json"),
  };
  await Promise.all([
    writeFile(files.contract, JSON.stringify(contract)),
    writeFile(files.plan, JSON.stringify(plan)),
    writeFile(files.attempt, JSON.stringify(attempt)),
    writeFile(files.input, JSON.stringify(input)),
    writeFile(files.profiles, JSON.stringify(modelProfiles)),
  ]);
  const args = [
    "escalate",
    "--input",
    files.input,
    "--profiles",
    files.profiles,
    "--contract",
    files.contract,
    "--plan",
    files.plan,
    "--attempt",
    files.attempt,
  ];
  for (let index = 0; index < 2; index += 1) {
    const result = await exec(path.join(pluginRoot, "bin", "rigor"), args, {
      cwd: root,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    });
    assert.equal(JSON.parse(result.stdout).decision, "escalate-adjacent");
  }
  const saved = await readdir(
    path.join(root, ".rigor", "evidence", "GH-14-CLI", "escalations"),
  );
  assert.equal(saved.length, 2);
});
