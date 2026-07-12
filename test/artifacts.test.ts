import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createContract,
  parseEscalationInput,
  parseVerification,
  verify,
} from "../src/artifacts.js";
import { evaluate } from "../src/policy.js";
import { defaultPolicy } from "../src/setup.js";
import type { Contract, GitFacts, Intent, Policy } from "../src/types.js";

const exec = promisify(execFile);

const policy = defaultPolicy("repo");
const git: GitFacts = {
  root: "/repo",
  head: "abc",
  dirty: false,
  changedPaths: [],
};
const intent: Intent = {
  schemaVersion: "rigor.intent.v1",
  taskId: "T-1",
  summary: "change",
  plannedPaths: ["src/a.ts"],
};
const preflight = evaluate(policy, intent, git);

test("contract enforces planned scope", () => {
  assert.throws(() =>
    createContract(policy, preflight, {
      schemaVersion: "rigor.contract-input.v1",
      taskId: "T-1",
      acceptanceCriteria: ["works"],
      allowedPaths: ["docs/**"],
      constraints: [],
    }),
  );
  const contract = createContract(policy, preflight, {
    schemaVersion: "rigor.contract-input.v1",
    taskId: "T-1",
    acceptanceCriteria: ["works"],
    allowedPaths: ["src/**"],
    constraints: [],
  });
  assert.deepEqual(contract.requiredChecks, ["git-diff-check"]);
});

test("escalation rejects duplicate attempts", () => {
  assert.throws(() =>
    parseEscalationInput({
      schemaVersion: "rigor.escalation-input.v1",
      taskId: "T-1",
      facts: ["failed"],
      attempts: [
        { action: "retry", result: "same" },
        { action: "retry", result: "same" },
      ],
      disprovedHypotheses: [],
      speculation: [],
      requestedDecision: "help",
    }),
  );
});

async function gitRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rigor-verify-"));
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "rigor@example.invalid"], {
    cwd: root,
  });
  await exec("git", ["config", "user.name", "Rigor Test"], { cwd: root });
  await exec("git", ["commit", "-q", "--allow-empty", "-m", "initial"], {
    cwd: root,
  });
  return root;
}

const SECRET_TOKEN = "SECRET_TOKEN_do_not_persist_9f8e7d";

function checksPolicy(): Policy {
  return {
    ...defaultPolicy("repo"),
    checks: [
      {
        id: "pass-check",
        command: "node",
        args: ["-e", "process.exit(0)"],
        tiers: ["low", "medium", "high", "critical"],
        timeoutMs: 30_000,
      },
      {
        id: "fail-check",
        command: "node",
        args: [
          "-e",
          `console.error(${JSON.stringify(
            `AssertionError: expected 1 to equal 2 ${SECRET_TOKEN}`,
          )}); process.exit(1);`,
        ],
        tiers: ["low", "medium", "high", "critical"],
        timeoutMs: 30_000,
      },
    ],
  };
}

function checksContract(): Contract {
  return {
    schemaVersion: "rigor.contract.v1",
    artifactId: "contract_verify",
    taskId: "TASK-VERIFY",
    createdAt: new Date(0).toISOString(),
    preflightArtifactId: "preflight_verify",
    preflightHash: "preflight-hash",
    riskTier: "low",
    externalTransmission: "allowed",
    acceptanceCriteria: ["works"],
    allowedPaths: ["**"],
    constraints: [],
    requiredChecks: ["pass-check", "fail-check"],
    stopConditions: [],
  };
}

test("verify attaches per-check failure facts and a verification-level fingerprint", async () => {
  const root = await gitRepo();
  const result = await verify(root, checksPolicy(), checksContract(), [], null);
  assert.equal(result.status, "failed");

  const passed = result.checks.find((check) => check.id === "pass-check")!;
  assert.equal(passed.status, "passed");
  assert.equal(passed.failure, undefined);

  const failed = result.checks.find((check) => check.id === "fail-check")!;
  assert.equal(failed.status, "failed");
  assert.ok(failed.failure);
  assert.equal(failed.failure!.category, "implementation");
  assert.equal(failed.failure!.errorClass, "assertion");

  assert.equal(result.failureFacts?.length, 2);
  const passedFact = result.failureFacts!.find(
    (fact) => fact.checkId === "pass-check",
  )!;
  assert.equal(passedFact.failure, null);
  const failedFact = result.failureFacts!.find(
    (fact) => fact.checkId === "fail-check",
  )!;
  assert.notEqual(failedFact.failure, null);

  assert.equal(typeof result.failureFingerprint, "string");
  assert.match(result.failureFingerprint!, /^[a-f0-9]{64}$/);

  // Raw command output (including anything secret-shaped) must never be
  // persisted; only normalized facts and opaque digests are stored.
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(SECRET_TOKEN));
});

test("a fully passing verification has a null failureFingerprint and no per-check failures", async () => {
  const root = await gitRepo();
  const policy = checksPolicy();
  policy.checks = [policy.checks[0]!];
  const contract = { ...checksContract(), requiredChecks: ["pass-check"] };
  const result = await verify(root, policy, contract, [], null);
  assert.equal(result.status, "passed");
  assert.equal(result.failureFingerprint, null);
  assert.deepEqual(
    result.failureFacts!.map((fact) => fact.failure),
    [null],
  );
});

test("parseVerification accepts a verification artifact predating failure fingerprints", () => {
  const legacy = {
    schemaVersion: "rigor.verification.v1",
    artifactId: "verification_1",
    taskId: "TASK-1",
    contractArtifactId: "contract_1",
    createdAt: new Date(0).toISOString(),
    policyHash: "policy",
    head: null,
    treeHash: "tree",
    changedPaths: [],
    scopeViolations: [],
    checks: [],
    status: "passed",
  };
  const parsed = parseVerification(legacy);
  assert.equal(parsed.failureFingerprint, undefined);
  assert.equal(parsed.failureFacts, undefined);
});
