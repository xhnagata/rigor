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
});
