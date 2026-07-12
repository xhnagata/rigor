import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  finishAttempt,
  parseAttempt,
  parseAttemptResultInput,
  startAttempt,
} from "../src/attempt.js";
import { createContract } from "../src/artifacts.js";
import {
  deriveCheckFacts,
  verificationFingerprint,
} from "../src/fingerprint.js";
import { gitFacts } from "../src/git.js";
import { evaluate } from "../src/policy.js";
import { createRoutingPlan, route } from "../src/routing.js";
import { defaultPolicy } from "../src/setup.js";
import type { ModelProfiles, RoutingInput } from "../src/types.js";
import type { CheckFacts, Verification } from "../src/types.js";

const exec = promisify(execFile);
const policy = defaultPolicy("repo");

async function git(root: string, args: string[]): Promise<void> {
  await exec("git", args, { cwd: root });
}

async function fixture(
  taskId: string,
  maxDurationMs = 60_000,
  maxAttempts = 2,
) {
  const root = await mkdtemp(path.join(tmpdir(), "rigor-attempt-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "rigor@example.invalid"]);
  await git(root, ["config", "user.name", "Rigor Test"]);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "initial"]);
  const preflight = evaluate(
    policy,
    {
      schemaVersion: "rigor.intent.v1",
      taskId,
      summary: "change a",
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
      taskId,
      acceptanceCriteria: ["a changes safely"],
      allowedPaths: ["src/**"],
      constraints: [],
    },
    new Date(0),
  );
  const input: RoutingInput = {
    schemaVersion: "rigor.routing-input.v1",
    taskId,
    purpose: "implementation",
    signals: {
      complexity: "medium",
      ambiguity: "low",
      novelty: "low",
      verificationStrength: "strong",
    },
    assessmentReasons: ["bounded fixture"],
    budget: { maxAttempts, maxDurationMs, maxRelativeCost: 100 },
  };
  const profiles: ModelProfiles = {
    schemaVersion: "rigor.model-profiles.v1",
    candidates: [
      {
        id: "claude-standard",
        provider: "claude",
        model: "configured-standard",
        capabilityClass: "standard",
        purposes: ["implementation"],
        relativeCost: 20,
        requiresAdditionalExternalTransmission: false,
        enabled: true,
      },
    ],
  };
  const plan = createRoutingPlan(
    route(preflight, input, profiles),
    preflight,
    contract,
    new Date(0),
  );
  return { root, contract, plan };
}

function result(taskId: string, status: "completed" | "failed" = "completed") {
  return parseAttemptResultInput({
    schemaVersion: "rigor.attempt-result-input.v1",
    taskId,
    status,
  });
}

function verification(
  taskId: string,
  contractArtifactId: string,
): Verification {
  return {
    schemaVersion: "rigor.verification.v1",
    artifactId: `verification-${taskId}`,
    taskId,
    contractArtifactId,
    createdAt: new Date(0).toISOString(),
    policyHash: "policy",
    head: null,
    treeHash: "tree",
    changedPaths: ["src/a.ts"],
    scopeViolations: [],
    checks: [],
    status: "passed",
  };
}

let failingVerificationSequence = 0;

function failingVerification(
  taskId: string,
  contractArtifactId: string,
  failureFacts: CheckFacts[],
): Verification {
  failingVerificationSequence += 1;
  return {
    schemaVersion: "rigor.verification.v1",
    artifactId: `verification-${taskId}-${failingVerificationSequence}`,
    taskId,
    contractArtifactId,
    createdAt: new Date(0).toISOString(),
    policyHash: "policy",
    head: null,
    treeHash: "tree",
    changedPaths: [],
    scopeViolations: [],
    checks: [],
    status: "failed",
    failureFingerprint: verificationFingerprint(failureFacts),
    failureFacts,
  };
}

test("records a bounded implementation attempt", async () => {
  const { root, contract, plan } = await fixture("TASK-1");
  const started = await startAttempt(root, policy, plan, contract, new Date(0));
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 2;\n");
  const finished = await finishAttempt(
    root,
    started.session,
    contract,
    result("TASK-1"),
    verification("TASK-1", contract.artifactId),
    new Date(500),
  );
  assert.equal(finished.attempt.status, "completed");
  assert.equal(finished.attempt.durationMs, 500);
  assert.equal(finished.attempt.executionIdentityStatus, "unverified");
  assert.deepEqual(finished.attempt.changedPaths, ["src/a.ts"]);
  assert.deepEqual(finished.attempt.scopeViolations, []);
});

test("scope and duration budgets fail closed", async () => {
  const scope = await fixture("TASK-2");
  const scopeStart = await startAttempt(
    scope.root,
    policy,
    scope.plan,
    scope.contract,
    new Date(0),
  );
  await writeFile(path.join(scope.root, "outside.txt"), "outside\n");
  const scopeFinish = await finishAttempt(
    scope.root,
    scopeStart.session,
    scope.contract,
    result("TASK-2", "failed"),
    undefined,
    new Date(100),
  );
  assert.equal(scopeFinish.attempt.status, "scope-violation");
  assert.deepEqual(scopeFinish.attempt.scopeViolations, ["outside.txt"]);

  const duration = await fixture("TASK-3", 1_000);
  const durationStart = await startAttempt(
    duration.root,
    policy,
    duration.plan,
    duration.contract,
    new Date(0),
  );
  const durationFinish = await finishAttempt(
    duration.root,
    durationStart.session,
    duration.contract,
    result("TASK-3", "failed"),
    undefined,
    new Date(1_001),
  );
  assert.equal(durationFinish.attempt.status, "budget-exceeded");
});

test("an unfinished attempt blocks another attempt", async () => {
  const { root, contract, plan } = await fixture("TASK-4");
  await startAttempt(root, policy, plan, contract, new Date(0));
  await assert.rejects(() =>
    startAttempt(root, policy, plan, contract, new Date(1)),
  );
});

test("completed status requires linked passing verification", async () => {
  const { root, contract, plan } = await fixture("TASK-5");
  const started = await startAttempt(root, policy, plan, contract, new Date(0));
  await assert.rejects(() =>
    finishAttempt(
      root,
      started.session,
      contract,
      result("TASK-5"),
      undefined,
      new Date(100),
    ),
  );
});

test("finalized attempts consume the attempt-count budget", async () => {
  const { root, contract, plan } = await fixture("TASK-6", 60_000, 1);
  const started = await startAttempt(root, policy, plan, contract, new Date(0));
  await finishAttempt(
    root,
    started.session,
    contract,
    result("TASK-6", "failed"),
    undefined,
    new Date(100),
  );
  await assert.rejects(() =>
    startAttempt(root, policy, plan, contract, new Date(200)),
  );
});

test("finishAttempt sets failureFingerprint and progress from the linked verification", async () => {
  const { root, contract, plan } = await fixture("TASK-7", 60_000, 2);
  const started = await startAttempt(root, policy, plan, contract, new Date(0));
  const facts = [
    deriveCheckFacts({
      checkId: "unit",
      status: "failed",
      exitCode: 1,
      output: "AssertionError: expected 1 to equal 2\n    at /a/foo.ts:1:1\n",
    }),
  ];
  const finished = await finishAttempt(
    root,
    started.session,
    contract,
    result("TASK-7", "failed"),
    failingVerification("TASK-7", contract.artifactId, facts),
    new Date(100),
  );
  assert.equal(
    finished.attempt.failureFingerprint,
    verificationFingerprint(facts),
  );
  assert.notEqual(finished.attempt.failureFingerprint, null);
  assert.equal(finished.attempt.failureCategory, "implementation");
  assert.deepEqual(finished.attempt.failureFacts, facts);
  assert.deepEqual(finished.attempt.progress, {
    status: "first",
    comparedToAttemptArtifactId: null,
    weakeningSignals: [],
  });
});

test("progress is unchanged across two consecutive attempts with the same implementation failure", async () => {
  const { root, contract, plan } = await fixture("TASK-8", 60_000, 3);
  const output =
    "AssertionError: expected 1 to equal 2\n    at /a/foo.ts:1:1\n";
  const factsFor = () => [
    deriveCheckFacts({
      checkId: "unit",
      status: "failed",
      exitCode: 1,
      output,
    }),
  ];

  const first = await startAttempt(root, policy, plan, contract, new Date(0));
  const firstFinished = await finishAttempt(
    root,
    first.session,
    contract,
    result("TASK-8", "failed"),
    failingVerification("TASK-8", contract.artifactId, factsFor()),
    new Date(100),
  );
  assert.equal(firstFinished.attempt.progress?.status, "first");

  const second = await startAttempt(
    root,
    policy,
    plan,
    contract,
    new Date(200),
  );
  const secondFinished = await finishAttempt(
    root,
    second.session,
    contract,
    result("TASK-8", "failed"),
    failingVerification("TASK-8", contract.artifactId, factsFor()),
    new Date(300),
  );
  assert.equal(secondFinished.attempt.progress?.status, "unchanged");
  assert.equal(
    secondFinished.attempt.progress?.comparedToAttemptArtifactId,
    firstFinished.attempt.artifactId,
  );
});

test("progress does not confirm a loop when only infrastructure failures repeat", async () => {
  const { root, contract, plan } = await fixture("TASK-9", 60_000, 3);
  const factsFor = () => [
    deriveCheckFacts({
      checkId: "net",
      status: "failed",
      exitCode: 1,
      output: "Error: connect ECONNREFUSED 127.0.0.1:5432",
    }),
  ];

  const first = await startAttempt(root, policy, plan, contract, new Date(0));
  await finishAttempt(
    root,
    first.session,
    contract,
    result("TASK-9", "failed"),
    failingVerification("TASK-9", contract.artifactId, factsFor()),
    new Date(100),
  );

  const second = await startAttempt(
    root,
    policy,
    plan,
    contract,
    new Date(200),
  );
  const secondFinished = await finishAttempt(
    root,
    second.session,
    contract,
    result("TASK-9", "failed"),
    failingVerification("TASK-9", contract.artifactId, factsFor()),
    new Date(300),
  );
  assert.equal(secondFinished.attempt.progress?.status, "incomparable");
  assert.equal(secondFinished.attempt.failureCategory, "infrastructure");
});

test("progress is incomparable when the prior attempt predates failure fingerprinting", async () => {
  const { root, contract, plan } = await fixture("TASK-10", 60_000, 3);
  const output =
    "AssertionError: expected 1 to equal 2\n    at /a/foo.ts:1:1\n";
  const factsFor = () => [
    deriveCheckFacts({
      checkId: "unit",
      status: "failed",
      exitCode: 1,
      output,
    }),
  ];

  const first = await startAttempt(root, policy, plan, contract, new Date(0));
  const firstFinished = await finishAttempt(
    root,
    first.session,
    contract,
    result("TASK-10", "failed"),
    failingVerification("TASK-10", contract.artifactId, factsFor()),
    new Date(100),
  );

  // Simulate an attempt.json recorded before failure fingerprinting existed.
  const legacy = JSON.parse(
    await readFile(firstFinished.saved, "utf8"),
  ) as Record<string, unknown>;
  delete legacy.failureFingerprint;
  delete legacy.failureCategory;
  delete legacy.failureFacts;
  delete legacy.progress;
  await writeFile(firstFinished.saved, JSON.stringify(legacy, null, 2));

  const second = await startAttempt(
    root,
    policy,
    plan,
    contract,
    new Date(200),
  );
  const secondFinished = await finishAttempt(
    root,
    second.session,
    contract,
    result("TASK-10", "failed"),
    failingVerification("TASK-10", contract.artifactId, factsFor()),
    new Date(300),
  );
  assert.equal(secondFinished.attempt.progress?.status, "incomparable");
  assert.equal(
    secondFinished.attempt.progress?.comparedToAttemptArtifactId,
    firstFinished.attempt.artifactId,
  );
});

test("parseAttempt accepts an attempt artifact predating failure fingerprinting", () => {
  const legacy = {
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
    changedPaths: [],
    scopeViolations: [],
  };
  const parsed = parseAttempt(legacy);
  assert.equal(parsed.failureFingerprint, undefined);
  assert.equal(parsed.failureCategory, undefined);
  assert.equal(parsed.failureFacts, undefined);
  assert.equal(parsed.progress, undefined);
});
