import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  finishConsultation,
  parseConsultationRequest,
  parseConsultationResultInput,
  startConsultation,
} from "../src/consultation.js";
import { evaluate } from "../src/policy.js";
import { defaultPolicy } from "../src/setup.js";
import { gitFacts, treeHash } from "../src/git.js";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<void> {
  await exec("git", args, { cwd: root });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rigor-consultation-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "rigor@example.invalid"]);
  await git(root, ["config", "user.name", "Rigor Test"]);
  await writeFile(path.join(root, "a.txt"), "initial\n");
  await git(root, ["add", "a.txt"]);
  await git(root, ["commit", "-q", "-m", "initial"]);
  return root;
}

async function preflight(root: string, taskId: string) {
  return evaluate(
    defaultPolicy("repo"),
    {
      schemaVersion: "rigor.intent.v1",
      taskId,
      summary: "consult",
      plannedPaths: ["a.txt"],
    },
    await gitFacts(root),
    new Date(0),
  );
}

const policy = defaultPolicy("repo");

function request(taskId: string) {
  return parseConsultationRequest({
    schemaVersion: "rigor.consultation-request.v1",
    taskId,
    provider: "codex-plugin-cc",
    mode: "consultation",
    requestedDecision: "Choose the safer behavior",
  });
}

function result(taskId: string) {
  return parseConsultationResultInput({
    schemaVersion: "rigor.consultation-result-input.v1",
    taskId,
    status: "completed",
    outcome: "ask-human",
    findingCount: 1,
    requiredActions: ["Clarify the contract"],
    externalSessionId: "session-1",
    usageStatus: "unavailable",
  });
}

function structuredResult(taskId: string) {
  return parseConsultationResultInput({
    schemaVersion: "rigor.consultation-result-input.v2",
    taskId,
    status: "completed",
    outcome: "revise",
    findings: [
      {
        severity: "high",
        evidenceLocation: { path: "src/consultation.ts", line: 1 },
        reproducibility: "always",
        requiredAction: "Keep the transmission gate before invocation",
        confidence: "high",
      },
    ],
    usageStatus: "unavailable",
    modelStatus: "unavailable",
    reasoningEffortStatus: "unavailable",
  });
}

test("consultation ignores its own append-only evidence", async () => {
  const root = await repository();
  const before = await preflight(root, "TASK-1");
  const started = await startConsultation(
    root,
    policy,
    before,
    request("TASK-1"),
  );
  const finished = await finishConsultation(
    root,
    started.session,
    result("TASK-1"),
  );
  assert.equal(finished.consultation.status, "completed");
  assert.equal(
    finished.consultation.beforeTreeHash,
    finished.consultation.afterTreeHash,
  );
  assert.equal(finished.consultation.externalSessionId, "session-1");
  assert.match(finished.saved, /consultations\/consultation_/u);
});

test("same-path content mutation is detected", async () => {
  const root = await repository();
  await writeFile(path.join(root, "a.txt"), "before consultation\n");
  const beforeHash = await treeHash(root);
  const started = await startConsultation(
    root,
    policy,
    await preflight(root, "TASK-2"),
    request("TASK-2"),
  );
  await writeFile(path.join(root, "a.txt"), "after consultation\n");
  assert.notEqual(await treeHash(root), beforeHash);
  const finished = await finishConsultation(
    root,
    started.session,
    result("TASK-2"),
  );
  assert.deepEqual(finished.consultation.changedPathsBefore, ["a.txt"]);
  assert.deepEqual(finished.consultation.changedPathsAfter, ["a.txt"]);
  assert.equal(finished.consultation.status, "mutated-worktree");
});

test("changed path set and HEAD mutations remain detected", async () => {
  const pathRoot = await repository();
  const pathStarted = await startConsultation(
    pathRoot,
    policy,
    await preflight(pathRoot, "TASK-PATH"),
    request("TASK-PATH"),
  );
  await writeFile(path.join(pathRoot, "new.txt"), "new path\n");
  const pathFinished = await finishConsultation(
    pathRoot,
    pathStarted.session,
    result("TASK-PATH"),
  );
  assert.equal(pathFinished.consultation.status, "mutated-worktree");
  assert.deepEqual(pathFinished.consultation.changedPathsAfter, ["new.txt"]);

  const headRoot = await repository();
  const headStarted = await startConsultation(
    headRoot,
    policy,
    await preflight(headRoot, "TASK-HEAD"),
    request("TASK-HEAD"),
  );
  await writeFile(path.join(headRoot, "a.txt"), "committed mutation\n");
  await git(headRoot, ["add", "a.txt"]);
  await git(headRoot, ["commit", "-q", "-m", "mutate during consultation"]);
  const headFinished = await finishConsultation(
    headRoot,
    headStarted.session,
    result("TASK-HEAD"),
  );
  assert.equal(headFinished.consultation.status, "mutated-worktree");
  assert.notEqual(
    headFinished.consultation.beforeHead,
    headFinished.consultation.afterHead,
  );
});

test("structured findings are normalized without inferred metadata", async () => {
  const root = await repository();
  const started = await startConsultation(
    root,
    policy,
    await preflight(root, "TASK-V2"),
    request("TASK-V2"),
  );
  const finished = await finishConsultation(
    root,
    started.session,
    structuredResult("TASK-V2"),
  );
  assert.equal(finished.consultation.schemaVersion, "rigor.consultation.v2");
  assert.equal(finished.consultation.findingCount, 1);
  assert.deepEqual(finished.consultation.findings?.[0], {
    severity: "high",
    evidenceLocation: { path: "src/consultation.ts", line: 1 },
    reproducibility: "always",
    requiredAction: "Keep the transmission gate before invocation",
    confidence: "high",
  });
  assert.equal(finished.consultation.usageStatus, "unavailable");
  assert.equal(finished.consultation.modelStatus, "unavailable");
  assert.equal(finished.consultation.model, undefined);
  assert.equal(finished.consultation.reasoningEffort, undefined);
});

test("transmission denial prevents a Codex consultation session", async () => {
  const root = await repository();
  const denied = {
    ...(await preflight(root, "TASK-3")),
    externalTransmission: "denied" as const,
  };
  await assert.rejects(() =>
    startConsultation(root, policy, denied, request("TASK-3")),
  );
});

test("stale policy and unplanned paths prevent consultation", async () => {
  const root = await repository();
  const before = await preflight(root, "TASK-4");
  const changedPolicy = defaultPolicy("repo");
  changedPolicy.defaultTier = "high";
  await assert.rejects(() =>
    startConsultation(root, changedPolicy, before, request("TASK-4")),
  );
  await writeFile(path.join(root, "outside.txt"), "unplanned\n");
  await assert.rejects(() =>
    startConsultation(root, policy, before, request("TASK-4")),
  );
});

test("consultation parsers fail closed", () => {
  assert.throws(() =>
    parseConsultationRequest({
      schemaVersion: "rigor.consultation-request.v1",
      taskId: "TASK-1",
      provider: "other",
      mode: "consultation",
      requestedDecision: "x",
    }),
  );
  assert.throws(() =>
    parseConsultationResultInput({
      schemaVersion: "rigor.consultation-result-input.v1",
      taskId: "TASK-1",
      status: "completed",
      outcome: "accept",
      findingCount: -1,
      requiredActions: [],
      usageStatus: "unavailable",
    }),
  );
  for (const pathValue of [
    "/tmp/a.ts",
    "../a.ts",
    "C:\\repo\\a.ts",
    "C:relative.ts",
  ]) {
    assert.throws(() =>
      parseConsultationResultInput({
        schemaVersion: "rigor.consultation-result-input.v2",
        taskId: "TASK-1",
        status: "completed",
        outcome: "revise",
        findings: [
          {
            severity: "high",
            evidenceLocation: { path: pathValue },
            reproducibility: "always",
            requiredAction: "fix it",
            confidence: "high",
          },
        ],
        usageStatus: "unavailable",
        modelStatus: "unavailable",
        reasoningEffortStatus: "unavailable",
      }),
    );
  }
  assert.throws(() =>
    parseConsultationResultInput({
      schemaVersion: "rigor.consultation-result-input.v2",
      taskId: "TASK-1",
      status: "completed",
      outcome: "accept",
      findings: [],
      usageStatus: "unavailable",
      modelStatus: "recorded",
      reasoningEffortStatus: "unavailable",
    }),
  );
  assert.throws(() =>
    parseConsultationResultInput({
      schemaVersion: "rigor.consultation-result-input.v2",
      taskId: "TASK-1",
      status: "completed",
      outcome: "accept",
      findings: [],
      usageStatus: "unavailable",
      modelStatus: "unavailable",
      reasoningEffortStatus: "unavailable",
      rawTranscript: "must not be accepted",
    }),
  );
  const oversizedFinding = (requiredAction: string) => ({
    severity: "high",
    evidenceLocation: { path: "src/a.ts" },
    reproducibility: "always",
    requiredAction,
    confidence: "high",
  });
  assert.throws(() =>
    parseConsultationResultInput({
      schemaVersion: "rigor.consultation-result-input.v2",
      taskId: "TASK-1",
      status: "completed",
      outcome: "revise",
      findings: Array.from({ length: 101 }, () => oversizedFinding("fix it")),
      usageStatus: "unavailable",
      modelStatus: "unavailable",
      reasoningEffortStatus: "unavailable",
    }),
  );
  assert.throws(() =>
    parseConsultationResultInput({
      schemaVersion: "rigor.consultation-result-input.v2",
      taskId: "TASK-1",
      status: "completed",
      outcome: "revise",
      findings: [oversizedFinding("x".repeat(2001))],
      usageStatus: "unavailable",
      modelStatus: "unavailable",
      reasoningEffortStatus: "unavailable",
    }),
  );
});
