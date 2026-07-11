import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  finishAttempt,
  parseAttemptResultInput,
  startAttempt,
} from "../src/attempt.js";
import { createContract } from "../src/artifacts.js";
import { gitFacts } from "../src/git.js";
import { evaluate } from "../src/policy.js";
import { createRoutingPlan, route } from "../src/routing.js";
import { defaultPolicy } from "../src/setup.js";
import type { ModelProfiles, RoutingInput } from "../src/types.js";
import type { Verification } from "../src/types.js";

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
