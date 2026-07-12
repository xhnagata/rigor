import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { main } from "../src/cli.js";
import { RigorError } from "../src/errors.js";
import {
  retrospect,
  saveCollectionArtifact,
  verify,
} from "../src/artifacts.js";
import { parseUnifiedDiff } from "../src/git.js";
import {
  createClassification,
  buildTestIntegrityEvent,
  detectSignals,
  parseClassificationInput,
  scanTestIntegrity,
} from "../src/test-integrity.js";
import { defaultPolicy } from "../src/setup.js";
import { writeJson } from "../src/util.js";
import type { Contract, Policy, TestIntegrityEvent } from "../src/types.js";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root })).stdout.trim();
}

async function initRepo(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "rigor-ti-"));
  const root = path.join(parent, "repo");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "ti@example.invalid"]);
  await git(root, ["config", "user.name", "TI Test"]);
  return root;
}

async function write(
  root: string,
  rel: string,
  content: string,
): Promise<void> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

async function scan(
  root: string,
  base: string,
  head: string | null,
): Promise<TestIntegrityEvent> {
  return scanTestIntegrity(root, {
    task: "GH-22",
    base,
    head,
    attemptArtifactId: null,
    verificationArtifactId: null,
    note: null,
  });
}

function firedIds(event: TestIntegrityEvent): string[] {
  return event.signals.map((signal) => signal.signalId);
}

// ---------------------------------------------------------------------------
// TI-05 skip/only/todo markers
// ---------------------------------------------------------------------------

test("TI-05 fires when a skip marker is added to a test-path file", async () => {
  const root = await initRepo();
  await write(root, "test/payment.test.ts", `it("charges", () => {});\n`);
  const base = await commitAll(root, "base");
  await write(
    root,
    "test/payment.test.ts",
    `it("charges", () => {});\nit.skip("charges the card SECRETTOKEN", () => {});\n`,
  );
  const head = await commitAll(root, "add skip");
  const event = await scan(root, base, head);
  assert.ok(firedIds(event).includes("TI-05"));
  const ti05 = event.signals.find((s) => s.signalId === "TI-05")!;
  assert.equal(ti05.value.addedMarkers, 1);
  assert.equal(ti05.label, "advisory-interpretation");
  assert.equal(ti05.computation, "deterministic");
  // No raw matched text or secrets persist in the event.
  assert.ok(!JSON.stringify(event).includes("SECRETTOKEN"));
  assert.ok(!JSON.stringify(event).includes("charges the card"));
});

test("TI-05 does not fire for a non-marker test or a non-test-path skip", async () => {
  const root = await initRepo();
  await write(root, "test/payment.test.ts", `it("charges", () => {});\n`);
  await write(root, "src/options.ts", `export const options = {};\n`);
  const base = await commitAll(root, "base");
  await write(
    root,
    "test/payment.test.ts",
    `it("charges", () => {});\nit("skips empty input", () => {});\n`,
  );
  await write(
    root,
    "src/options.ts",
    `export const options = { skip: true };\n`,
  );
  const head = await commitAll(root, "benign");
  const event = await scan(root, base, head);
  assert.ok(!firedIds(event).includes("TI-05"));
});

// ---------------------------------------------------------------------------
// TI-06 test-case removal
// ---------------------------------------------------------------------------

test("TI-06 fires when a test file is deleted without a rename pair", async () => {
  const root = await initRepo();
  await write(root, "test/payment.test.ts", `it("charges", () => {});\n`);
  await write(root, "src/keep.ts", `export const keep = 1;\n`);
  const base = await commitAll(root, "base");
  await git(root, ["rm", "-q", "test/payment.test.ts"]);
  const head = await commitAll(root, "delete test");
  const event = await scan(root, base, head);
  assert.ok(firedIds(event).includes("TI-06"));
  const ti06 = event.signals.find((s) => s.signalId === "TI-06")!;
  assert.equal(ti06.value.deletedTestFiles, 1);
  assert.deepEqual(ti06.paths, ["test/payment.test.ts"]);
});

test("TI-06 does not fire for a high-similarity rename", async () => {
  const root = await initRepo();
  const body = Array.from(
    { length: 20 },
    (_, i) => `it("case ${i}", () => { expect(${i}).toBe(${i}); });`,
  ).join("\n");
  await write(root, "test/payment.test.ts", `${body}\n`);
  const base = await commitAll(root, "base");
  await git(root, ["mv", "test/payment.test.ts", "test/billing.test.ts"]);
  const head = await commitAll(root, "rename test");
  const event = await scan(root, base, head);
  assert.ok(!firedIds(event).includes("TI-06"));
});

// ---------------------------------------------------------------------------
// TI-07 assertion-token decline
// ---------------------------------------------------------------------------

test("TI-07 fires on a net decline of assertion tokens", async () => {
  const root = await initRepo();
  await write(
    root,
    "test/a.test.ts",
    `expect(1).toBe(1);\nexpect(2).toBe(2);\nexpect(3).toBe(3);\nexpect(4).toBe(4);\n`,
  );
  const base = await commitAll(root, "base");
  await write(root, "test/a.test.ts", `expect(1).toBe(1);\n`);
  const head = await commitAll(root, "remove asserts");
  const event = await scan(root, base, head);
  assert.ok(firedIds(event).includes("TI-07"));
  const ti07 = event.signals.find((s) => s.signalId === "TI-07")!;
  assert.ok((ti07.value.netRemoved ?? 0) > 0);
});

test("TI-07 does not fire when assertions move between test files (net 0)", async () => {
  const root = await initRepo();
  await write(
    root,
    "test/a.test.ts",
    `expect(1).toBe(1);\nexpect(2).toBe(2);\nexpect(3).toBe(3);\nexpect(4).toBe(4);\n`,
  );
  await write(root, "test/b.test.ts", `// empty\n`);
  const base = await commitAll(root, "base");
  await write(root, "test/a.test.ts", `// empty\n`);
  await write(
    root,
    "test/b.test.ts",
    `expect(1).toBe(1);\nexpect(2).toBe(2);\nexpect(3).toBe(3);\nexpect(4).toBe(4);\n`,
  );
  const head = await commitAll(root, "move asserts");
  const event = await scan(root, base, head);
  assert.ok(!firedIds(event).includes("TI-07"));
});

// ---------------------------------------------------------------------------
// TI-08 snapshot churn
// ---------------------------------------------------------------------------

test("TI-08 fires when snapshots change alongside implementation", async () => {
  const root = await initRepo();
  await write(root, "src/render.ts", `export const v = 1;\n`);
  await write(root, "test/__snapshots__/render.snap", `exports[1] = "a";\n`);
  const base = await commitAll(root, "base");
  await write(root, "src/render.ts", `export const v = 2;\n`);
  await write(root, "test/__snapshots__/render.snap", `exports[1] = "b";\n`);
  const head = await commitAll(root, "regenerate snapshot");
  const event = await scan(root, base, head);
  assert.ok(firedIds(event).includes("TI-08"));
  const ti08 = event.signals.find((s) => s.signalId === "TI-08")!;
  assert.ok((ti08.value.snapshotFiles ?? 0) >= 1);
  assert.ok((ti08.value.implementationFiles ?? 0) >= 1);
});

test("TI-08 does not fire without a snapshot path change", async () => {
  const root = await initRepo();
  await write(root, "src/render.ts", `export const v = 1;\n`);
  const base = await commitAll(root, "base");
  await write(root, "src/render.ts", `export const v = 2;\n`);
  const head = await commitAll(root, "impl only");
  const event = await scan(root, base, head);
  assert.ok(!firedIds(event).includes("TI-08"));
});

// ---------------------------------------------------------------------------
// TI-09 verification-adjacent config/script change
// ---------------------------------------------------------------------------

test("TI-09 fires when the package.json test script changes", async () => {
  const root = await initRepo();
  await write(
    root,
    "package.json",
    `${JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "node --test test/" } }, null, 2)}\n`,
  );
  const base = await commitAll(root, "base");
  await write(
    root,
    "package.json",
    `${JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "node --test test/unit/" } }, null, 2)}\n`,
  );
  const head = await commitAll(root, "weaken test script");
  const event = await scan(root, base, head);
  assert.ok(firedIds(event).includes("TI-09"));
  const ti09 = event.signals.find((s) => s.signalId === "TI-09")!;
  assert.equal(ti09.value.packageScriptsChanged, 1);
  assert.deepEqual(ti09.paths, ["package.json"]);
  for (const signal of event.signals)
    for (const p of signal.paths) assert.ok(!p.includes("#"));
});

test("TI-09 does not fire for a version-only package.json bump", async () => {
  const root = await initRepo();
  await write(
    root,
    "package.json",
    `${JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "node --test test/" } }, null, 2)}\n`,
  );
  const base = await commitAll(root, "base");
  await write(
    root,
    "package.json",
    `${JSON.stringify({ name: "x", version: "1.0.1", scripts: { test: "node --test test/" } }, null, 2)}\n`,
  );
  const head = await commitAll(root, "version bump");
  const event = await scan(root, base, head);
  assert.ok(!firedIds(event).includes("TI-09"));
});

test("TI-09 fires when a tsconfig file changes", async () => {
  const root = await initRepo();
  await write(root, "tsconfig.json", `{ "strict": true }\n`);
  const base = await commitAll(root, "base");
  await write(root, "tsconfig.json", `{ "strict": false }\n`);
  const head = await commitAll(root, "loosen tsconfig");
  const event = await scan(root, base, head);
  assert.ok(firedIds(event).includes("TI-09"));
});

// ---------------------------------------------------------------------------
// dirty worktree + zero-signal event
// ---------------------------------------------------------------------------

test("dirty-worktree scan yields headSha null and a worktreeDigest", async () => {
  const root = await initRepo();
  await write(root, "test/payment.test.ts", `it("charges", () => {});\n`);
  const base = await commitAll(root, "base");
  await write(
    root,
    "test/payment.test.ts",
    `it("charges", () => {});\nit.only("focus", () => {});\n`,
  );
  const event = await scan(root, base, null);
  assert.equal(event.diff.headSha, null);
  assert.match(event.diff.worktreeDigest ?? "", /^[0-9a-f]{64}$/u);
  assert.ok(firedIds(event).includes("TI-05"));
});

test("a scan with no weakening writes an event with empty signals but full denominator", async () => {
  const root = await initRepo();
  await write(root, "src/a.ts", `export const a = 1;\n`);
  const base = await commitAll(root, "base");
  await write(root, "src/a.ts", `export const a = 2;\n`);
  const head = await commitAll(root, "benign impl");
  const event = await scan(root, base, head);
  assert.deepEqual(event.signals, []);
  assert.deepEqual(event.signalsEvaluated, [
    "TI-05",
    "TI-06",
    "TI-07",
    "TI-08",
    "TI-09",
  ]);
  assert.equal(event.mode, "shadow");
  assert.equal(event.enforcement, "none");
});

// ---------------------------------------------------------------------------
// pure detectors
// ---------------------------------------------------------------------------

test("detectSignals is a pure function of a parsed diff", () => {
  const diff = parseUnifiedDiff(
    [
      "diff --git a/test/x.test.ts b/test/x.test.ts",
      "--- a/test/x.test.ts",
      "+++ b/test/x.test.ts",
      "@@ -1,0 +1 @@",
      `+it.skip("x", () => {});`,
    ].join("\n"),
  );
  const signals = detectSignals({
    changes: diff,
    baseScripts: null,
    headScripts: null,
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.signalId, "TI-05");
});

// ---------------------------------------------------------------------------
// buildTestIntegrityEvent validation
// ---------------------------------------------------------------------------

test("buildTestIntegrityEvent rejects a non-40-hex baseSha", () => {
  assert.throws(() =>
    buildTestIntegrityEvent(
      {
        taskId: "GH-22",
        baseSha: "abc",
        headSha: null,
        worktreeDigest: "f".repeat(64),
        attemptArtifactId: null,
        verificationArtifactId: null,
        note: null,
      },
      [],
    ),
  );
});

test("buildTestIntegrityEvent requires a worktreeDigest when headSha is null", () => {
  assert.throws(() =>
    buildTestIntegrityEvent(
      {
        taskId: "GH-22",
        baseSha: "a".repeat(40),
        headSha: null,
        worktreeDigest: null,
        attemptArtifactId: null,
        verificationArtifactId: null,
        note: null,
      },
      [],
    ),
  );
});

// ---------------------------------------------------------------------------
// CLI linkage validation
// ---------------------------------------------------------------------------

async function seedPolicy(root: string): Promise<void> {
  await writeJson(
    path.join(root, ".rigor", "policy.json"),
    defaultPolicy("repo"),
  );
}

async function runCli(argv: string[], cwd: string): Promise<number> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await main(argv, cwd);
  } catch (error) {
    if (error instanceof RigorError) return error.exitCode;
    throw error;
  } finally {
    process.stdout.write = original;
  }
}

test("test-integrity-scan exits 2 when a linked verification taskId mismatches", async () => {
  const root = await initRepo();
  await seedPolicy(root);
  await write(root, "src/a.ts", `export const a = 1;\n`);
  const base = await commitAll(root, "base");
  const badVerification = path.join(root, "bad-verification.json");
  await writeFile(
    badVerification,
    JSON.stringify({
      schemaVersion: "rigor.verification.v1",
      artifactId: "verification_bad",
      taskId: "OTHER-1",
      contractArtifactId: "contract_bad",
      createdAt: new Date(0).toISOString(),
      changedPaths: [],
      status: "passed",
    }),
  );
  const code = await runCli(
    [
      "test-integrity-scan",
      "--task",
      "GH-22",
      "--base",
      base,
      "--head",
      base,
      "--verification",
      badVerification,
    ],
    root,
  );
  assert.equal(code, 2);
});

// ---------------------------------------------------------------------------
// classify guard + retrospect aggregation
// ---------------------------------------------------------------------------

async function seedEvent(root: string): Promise<TestIntegrityEvent> {
  await write(root, "test/payment.test.ts", `it("charges", () => {});\n`);
  const base = await commitAll(root, "base");
  await write(
    root,
    "test/payment.test.ts",
    `it("charges", () => {});\nit.skip("later", () => {});\n`,
  );
  const head = await commitAll(root, "add skip");
  const event = await scan(root, base, head);
  await saveCollectionArtifact(
    root,
    event.taskId,
    "test-integrity",
    "test-integrity-event",
    event,
  );
  return event;
}

test("classify refuses mid-attempt and accepts after finalization", async () => {
  const root = await initRepo();
  await seedPolicy(root);
  const event = await seedEvent(root);
  const attempts = path.join(
    root,
    ".rigor",
    "evidence",
    event.taskId,
    "attempts",
  );
  await mkdir(attempts, { recursive: true });
  await writeFile(
    path.join(attempts, "attempt-session_S.json"),
    JSON.stringify({
      schemaVersion: "rigor.attempt-session.v1",
      artifactId: "attempt-session_S",
    }),
  );
  const inputPath = path.join(root, "classify-input.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      schemaVersion: "rigor.test-integrity-classification-input.v1",
      taskId: event.taskId,
      eventArtifactId: event.artifactId,
      classifiedBy: "human",
      verdicts: [{ signalId: "TI-05", verdict: "false-positive" }],
    }),
  );
  const eventPath = path.join(
    root,
    ".rigor",
    "evidence",
    event.taskId,
    "test-integrity",
    `${event.artifactId}.json`,
  );
  const refused = await runCli(
    ["test-integrity-classify", "--event", eventPath, "--input", inputPath],
    root,
  );
  assert.equal(refused, 2);

  // Finalize the attempt session, then classification is accepted.
  await writeFile(
    path.join(attempts, "attempt_A.json"),
    JSON.stringify({
      schemaVersion: "rigor.attempt.v1",
      artifactId: "attempt_A",
      sessionArtifactId: "attempt-session_S",
    }),
  );
  const accepted = await runCli(
    ["test-integrity-classify", "--event", eventPath, "--input", inputPath],
    root,
  );
  assert.equal(accepted, 0);

  // Retrospect reflects the fired signal and its human classification.
  const report = (await retrospect(root)) as Record<string, unknown>;
  const ti = report.testIntegrity as Record<string, unknown>;
  assert.equal(ti.events, 1);
  assert.equal(ti.classifications, 1);
  const signals = ti.signals as Record<string, Record<string, unknown>>;
  assert.equal(signals["TI-05"]!.evaluated, 1);
  assert.equal(signals["TI-05"]!.fired, 1);
  assert.equal(signals["TI-05"]!.unreviewed, 0);
  assert.deepEqual(signals["TI-05"]!.humanClassified, {
    truePositive: 0,
    falsePositive: 1,
    uncertain: 0,
  });
  assert.equal(signals["TI-06"]!.evaluated, 1);
  assert.equal(signals["TI-06"]!.fired, 0);
});

test("classify rejects a verdict naming a signal the event did not fire", async () => {
  const root = await initRepo();
  const event = await seedEvent(root);
  const input = parseClassificationInput({
    schemaVersion: "rigor.test-integrity-classification-input.v1",
    taskId: event.taskId,
    eventArtifactId: event.artifactId,
    classifiedBy: "human",
    verdicts: [{ signalId: "TI-09", verdict: "true-positive" }],
  });
  assert.throws(() => createClassification(input, event));
});

test("retrospect counts a fired-but-unclassified signal as unreviewed", async () => {
  const root = await initRepo();
  await seedEvent(root);
  const report = (await retrospect(root)) as Record<string, unknown>;
  const ti = report.testIntegrity as Record<string, unknown>;
  const signals = ti.signals as Record<string, Record<string, unknown>>;
  assert.equal(signals["TI-05"]!.fired, 1);
  assert.equal(signals["TI-05"]!.unreviewed, 1);
});

test("retrospect tolerates a malformed test-integrity file", async () => {
  const root = await initRepo();
  const dir = path.join(root, ".rigor", "evidence", "GH-22", "test-integrity");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "test-integrity-event_bad.json"),
    "{ not json",
  );
  await writeFile(
    path.join(dir, "test-integrity-classification_bad.json"),
    "{ not json",
  );
  const report = (await retrospect(root)) as Record<string, unknown>;
  const ti = report.testIntegrity as Record<string, unknown>;
  assert.equal(ti.malformedEvents, 1);
  assert.equal(ti.malformedClassifications, 1);
});

// ---------------------------------------------------------------------------
// no coupling with verification
// ---------------------------------------------------------------------------

test("verify is unaffected by the presence of test-integrity events", async () => {
  const root = await initRepo();
  await write(root, "src/a.ts", `export const a = 1;\n`);
  await commitAll(root, "base");
  const policy: Policy = {
    ...defaultPolicy("repo"),
    checks: [
      {
        id: "noop",
        command: "true",
        args: [],
        tiers: ["low"],
        timeoutMs: 1000,
      },
    ],
  };
  const contract: Contract = {
    schemaVersion: "rigor.contract.v1",
    artifactId: "contract_1",
    taskId: "GH-22",
    createdAt: new Date(0).toISOString(),
    preflightArtifactId: "preflight_1",
    preflightHash: "h",
    riskTier: "low",
    externalTransmission: "denied",
    acceptanceCriteria: ["works"],
    allowedPaths: ["**"],
    constraints: [],
    requiredChecks: ["noop"],
    stopConditions: [],
  };
  const head = await git(root, ["rev-parse", "HEAD"]);
  const before = await verify(root, policy, contract, [], head);
  // Introduce a test-integrity event under evidence and re-verify.
  await saveCollectionArtifact(
    root,
    "GH-22",
    "test-integrity",
    "test-integrity-event",
    buildTestIntegrityEvent(
      {
        taskId: "GH-22",
        baseSha: head,
        headSha: head,
        worktreeDigest: null,
        attemptArtifactId: null,
        verificationArtifactId: null,
        note: null,
      },
      [],
    ),
  );
  const after = await verify(root, policy, contract, [], head);
  assert.equal(after.status, "passed");
  assert.equal(before.status, after.status);
  assert.equal(before.treeHash, after.treeHash);
  const stripDuration = (verification: typeof before): unknown =>
    verification.checks.map((check) => ({
      id: check.id,
      status: check.status,
      exitCode: check.exitCode,
      outputDigest: check.outputDigest,
    }));
  assert.deepEqual(stripDuration(before), stripDuration(after));
  assert.deepEqual(before.changedPaths, after.changedPaths);
  assert.deepEqual(before.scopeViolations, after.scopeViolations);
  assert.equal(before.failureFingerprint, after.failureFingerprint);
});
