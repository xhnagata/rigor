import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const pluginRoot = path.resolve(import.meta.dirname, "..");

async function git(root: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root })).stdout.trim();
}

async function rigor(
  root: string,
  args: string[],
  expectedCode = 0,
): Promise<Record<string, unknown>> {
  try {
    const result = await exec(path.join(pluginRoot, "bin", "rigor"), args, {
      cwd: root,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    });
    assert.equal(expectedCode, 0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    assert.equal(
      failure.code,
      expectedCode,
      `${failure.stderr}\n${failure.stdout}`,
    );
    return failure.stdout
      ? (JSON.parse(failure.stdout) as Record<string, unknown>)
      : {};
  }
}

async function generatedCi(
  root: string,
  base: string,
  head: string,
): Promise<Record<string, unknown>> {
  const result = await exec(
    "node",
    [
      path.join(root, ".rigor", "rigor-ci.cjs"),
      "ci",
      "--base",
      base,
      "--head",
      head,
    ],
    { cwd: root },
  );
  assert.notEqual(
    result.stdout.trim(),
    "",
    "generated rigor-ci.cjs must execute the CLI entrypoint",
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("install-to-review smoke flow and independent CI work in an empty repository", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "rigor-e2e-"));
  const root = path.join(parent, "repo");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "rigor@example.invalid"]);
  await git(root, ["config", "user.name", "Rigor Test"]);
  const installed = await rigor(root, ["setup"]);
  assert.equal((installed.created as string[]).length, 5);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "configure rigor"]);
  const base = await git(root, ["rev-parse", "HEAD"]);

  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "a.ts"),
    "export const answer = 42;\n",
  );
  const intentFile = path.join(parent, "intent.json");
  await writeFile(
    intentFile,
    JSON.stringify({
      schemaVersion: "rigor.intent.v1",
      taskId: "TASK-1",
      summary: "add answer",
      plannedPaths: ["src/a.ts"],
    }),
  );
  const preflight = await rigor(root, ["preflight", "--intent", intentFile]);
  assert.equal(preflight.riskTier, "high");
  const contractInput = path.join(parent, "contract.json");
  await writeFile(
    contractInput,
    JSON.stringify({
      schemaVersion: "rigor.contract-input.v1",
      taskId: "TASK-1",
      acceptanceCriteria: ["answer module exists"],
      allowedPaths: ["src/**"],
      constraints: ["no external writes"],
    }),
  );
  const contract = await rigor(root, [
    "contract",
    "--preflight",
    String(preflight.saved),
    "--input",
    contractInput,
  ]);
  const routingInput = path.join(parent, "routing.json");
  await writeFile(
    routingInput,
    JSON.stringify({
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
        "The change is bounded and follows an existing module pattern.",
      ],
      budget: {
        maxAttempts: 2,
        maxDurationMs: 300000,
        maxRelativeCost: 100,
      },
    }),
  );
  const modelProfiles = path.join(parent, "model-profiles.json");
  await writeFile(
    modelProfiles,
    JSON.stringify({
      schemaVersion: "rigor.model-profiles.v1",
      candidates: [
        {
          id: "claude-standard",
          provider: "claude",
          capabilityClass: "standard",
          purposes: ["implementation"],
          relativeCost: 20,
          requiresAdditionalExternalTransmission: false,
          enabled: true,
        },
        {
          id: "codex-consult",
          provider: "codex-plugin-cc",
          capabilityClass: "frontier",
          purposes: ["consultation", "adversarial-review", "rescue"],
          relativeCost: 50,
          requiresAdditionalExternalTransmission: true,
          enabled: true,
        },
      ],
    }),
  );
  const routing = await rigor(root, [
    "route",
    "--dry-run",
    "--preflight",
    String(preflight.saved),
    "--input",
    routingInput,
    "--profiles",
    modelProfiles,
  ]);
  assert.equal(routing.status, "selected");
  assert.equal(
    (routing.selection as { candidateId: string }).candidateId,
    "claude-standard",
  );
  const routingPlan = await rigor(root, [
    "route",
    "--record",
    "--preflight",
    String(preflight.saved),
    "--contract",
    String(contract.saved),
    "--input",
    routingInput,
    "--profiles",
    modelProfiles,
  ]);
  assert.equal(routingPlan.status, "planned");
  const availabilityReport = await rigor(root, [
    "availability",
    "--profiles",
    modelProfiles,
  ]);
  assert.equal(availabilityReport.schemaVersion, "rigor.availability.v1");
  const availabilityCandidates = availabilityReport.candidates as Array<{
    candidateId: string;
    state: string;
  }>;
  for (const candidate of availabilityCandidates)
    assert.ok(
      ["available", "unavailable", "unknown", "incompatible"].includes(
        candidate.state,
      ),
    );
  const availabilityFile = path.join(parent, "availability.json");
  await writeFile(availabilityFile, JSON.stringify(availabilityReport));
  const routedWithAvailability = await rigor(root, [
    "route",
    "--dry-run",
    "--preflight",
    String(preflight.saved),
    "--input",
    routingInput,
    "--profiles",
    modelProfiles,
    "--availability",
    availabilityFile,
  ]);
  assert.equal(routedWithAvailability.status, "selected");
  assert.equal(
    (routedWithAvailability.selection as { candidateId: string }).candidateId,
    "claude-standard",
  );
  assert.match(
    routedWithAvailability.availabilityReportHash as string,
    /^[a-f0-9]{64}$/u,
  );
  const consultationRequest = path.join(parent, "consultation-request.json");
  await writeFile(
    consultationRequest,
    JSON.stringify({
      schemaVersion: "rigor.consultation-request.v1",
      taskId: "TASK-1",
      provider: "codex-plugin-cc",
      mode: "consultation",
      requestedDecision: "Check the proposed API boundary",
    }),
  );
  const consultationSession = await rigor(root, [
    "consult-start",
    "--preflight",
    String(preflight.saved),
    "--input",
    consultationRequest,
  ]);
  const consultationResult = path.join(parent, "consultation-result.json");
  await writeFile(
    consultationResult,
    JSON.stringify({
      schemaVersion: "rigor.consultation-result-input.v1",
      taskId: "TASK-1",
      status: "completed",
      outcome: "accept",
      findingCount: 0,
      requiredActions: [],
      externalSessionId: "session-1",
      usageStatus: "unavailable",
    }),
  );
  const consultation = await rigor(root, [
    "consult-finish",
    "--session",
    String(consultationSession.saved),
    "--input",
    consultationResult,
  ]);
  assert.equal(consultation.status, "completed");
  const attemptSession = await rigor(root, [
    "attempt-start",
    "--plan",
    String(routingPlan.saved),
    "--contract",
    String(contract.saved),
  ]);
  const verificationPreview = await rigor(root, [
    "verify",
    "--dry-run",
    "--contract",
    String(contract.saved),
  ]);
  assert.equal(verificationPreview.status, "passed");
  assert.equal(verificationPreview.saved, undefined);
  const verification = await rigor(root, [
    "verify",
    "--contract",
    String(contract.saved),
  ]);
  assert.equal(verification.status, "passed");
  const attemptResult = path.join(parent, "attempt-result.json");
  await writeFile(
    attemptResult,
    JSON.stringify({
      schemaVersion: "rigor.attempt-result-input.v1",
      taskId: "TASK-1",
      status: "completed",
    }),
  );
  const attempt = await rigor(root, [
    "attempt-finish",
    "--session",
    String(attemptSession.saved),
    "--contract",
    String(contract.saved),
    "--input",
    attemptResult,
    "--verification",
    String(verification.saved),
  ]);
  assert.equal(attempt.status, "completed");
  const review = await rigor(root, [
    "review",
    "--contract",
    String(contract.saved),
    "--preflight",
    String(preflight.saved),
    "--verification",
    String(verification.saved),
  ]);
  assert.equal(review.verificationStatus, "passed");

  const outcomeInput = path.join(parent, "outcome-input.json");
  await writeFile(
    outcomeInput,
    JSON.stringify({
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
      pullRequest: "#1",
    }),
  );
  const outcome = await rigor(root, [
    "outcome",
    "--input",
    outcomeInput,
    "--attempt",
    String(attempt.saved),
    "--verification",
    String(verification.saved),
    "--review",
    String(review.saved),
  ]);
  assert.equal(outcome.decision, "accepted");
  assert.equal(outcome.retryCount, 0);
  const retrospective = await rigor(root, ["retrospect"]);
  const outcomeTotals = retrospective.outcomeTotals as {
    total: number;
    accepted: number;
  };
  assert.ok(outcomeTotals.total >= 1);
  assert.ok(outcomeTotals.accepted >= 1);
  const candidates = retrospective.candidates as Array<{
    successRate: { denominator: number };
  }>;
  assert.ok(
    candidates.some((candidate) => candidate.successRate.denominator >= 1),
  );

  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "add answer with evidence"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const ci = await generatedCi(root, base, head);
  assert.equal(ci.status, "passed");

  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "test", "existing.test.ts"), "test();\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "add existing test"]);
  const beforeDelete = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["rm", "-q", "test/existing.test.ts"]);
  await git(root, ["commit", "-q", "-m", "weaken tests"]);
  const afterDelete = await git(root, ["rev-parse", "HEAD"]);
  const deletion = await rigor(
    root,
    ["ci", "--base", beforeDelete, "--head", afterDelete],
    2,
  );
  assert.ok(
    (deletion.failures as string[]).some((item) =>
      item.includes("existing test was deleted"),
    ),
  );

  const policyFile = path.join(root, ".rigor", "policy.json");
  const policy = JSON.parse(await readFile(policyFile, "utf8")) as {
    checks: Array<{ args: string[] }>;
  };
  policy.checks[0]!.args = ["status"];
  await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
  await git(root, ["add", policyFile]);
  await git(root, ["commit", "-q", "-m", "weaken check"]);
  const weakened = await git(root, ["rev-parse", "HEAD"]);
  const policyResult = await rigor(
    root,
    ["ci", "--base", afterDelete, "--head", weakened],
    2,
  );
  assert.ok(
    (policyResult.failures as string[]).some((item) =>
      item.includes("base check changed"),
    ),
  );
});

// GH-11: /rigor:assess produces a rigor.routing-input.v2 whose validation is
// `rigor route --dry-run`. These fixtures exercise the CLI directly for both
// the allowed (economy-selected) and stopped (requires-review) flows.

async function setupSpikeRepo(): Promise<{
  parent: string;
  root: string;
  preflight: Record<string, unknown>;
  contract: Record<string, unknown>;
  modelProfiles: string;
}> {
  const parent = await mkdtemp(path.join(tmpdir(), "rigor-e2e-assess-"));
  const root = path.join(parent, "repo");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "rigor@example.invalid"]);
  await git(root, ["config", "user.name", "Rigor Test"]);
  await rigor(root, ["setup"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "configure rigor"]);

  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "greeting.ts"),
    'export const greeting = "hi";\n',
  );
  const intentFile = path.join(parent, "intent.json");
  await writeFile(
    intentFile,
    JSON.stringify({
      schemaVersion: "rigor.intent.v1",
      taskId: "SPIKE-ROUTE-1",
      summary: "add a trivial constant export",
      plannedPaths: ["src/greeting.ts"],
    }),
  );
  const preflight = await rigor(root, ["preflight", "--intent", intentFile]);
  const contractInput = path.join(parent, "contract.json");
  await writeFile(
    contractInput,
    JSON.stringify({
      schemaVersion: "rigor.contract-input.v1",
      taskId: "SPIKE-ROUTE-1",
      acceptanceCriteria: ["greeting constant exists"],
      allowedPaths: ["src/**"],
      constraints: ["no external writes"],
    }),
  );
  const contract = await rigor(root, [
    "contract",
    "--preflight",
    String(preflight.saved),
    "--input",
    contractInput,
  ]);

  const modelProfiles = path.join(parent, "model-profiles.json");
  await writeFile(
    modelProfiles,
    JSON.stringify({
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
    }),
  );
  return { parent, root, preflight, contract, modelProfiles };
}

function spikeRoutingInput(
  confidence: "low" | "medium",
): Record<string, unknown> {
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
      maxDurationMs: 60000,
      maxRelativeCost: 100,
    },
    assessment: {
      confidence,
      evidence: [
        {
          path: "src/greeting.ts",
          observation:
            "The file defines a single constant export with no branching logic.",
        },
      ],
    },
  };
}

test("SPIKE-ROUTE-1-like low-complexity assessment deterministically selects an eligible economy candidate through rigor route", async () => {
  const { parent, root, preflight, contract, modelProfiles } =
    await setupSpikeRepo();
  const routingInput = path.join(parent, "routing-input.json");
  await writeFile(routingInput, JSON.stringify(spikeRoutingInput("medium")));

  const routing = await rigor(root, [
    "route",
    "--dry-run",
    "--preflight",
    String(preflight.saved),
    "--input",
    routingInput,
    "--profiles",
    modelProfiles,
  ]);
  assert.equal(routing.status, "selected");
  assert.equal(routing.requiredCapabilityClass, "economy");
  assert.equal(
    (routing.selection as { candidateId: string }).candidateId,
    "claude-economy",
  );

  const routingPlan = await rigor(root, [
    "route",
    "--record",
    "--preflight",
    String(preflight.saved),
    "--contract",
    String(contract.saved),
    "--input",
    routingInput,
    "--profiles",
    modelProfiles,
  ]);
  assert.equal(routingPlan.status, "planned");
  assert.equal(
    (routingPlan.selection as { candidateId: string }).candidateId,
    "claude-economy",
  );
});

test("SPIKE-ROUTE-1-like low-confidence assessment stops with requires-review instead of silently selecting an economy candidate", async () => {
  const { parent, root, preflight, contract, modelProfiles } =
    await setupSpikeRepo();
  const routingInput = path.join(parent, "routing-input.json");
  await writeFile(routingInput, JSON.stringify(spikeRoutingInput("low")));

  const routing = await rigor(
    root,
    [
      "route",
      "--dry-run",
      "--preflight",
      String(preflight.saved),
      "--input",
      routingInput,
      "--profiles",
      modelProfiles,
    ],
    2,
  );
  assert.equal(routing.status, "requires-review");
  assert.equal(routing.selection, null);
  assert.deepEqual(routing.eligibleCandidates, [
    "claude-economy",
    "claude-standard",
  ]);

  const routingPlan = await rigor(
    root,
    [
      "route",
      "--record",
      "--preflight",
      String(preflight.saved),
      "--contract",
      String(contract.saved),
      "--input",
      routingInput,
      "--profiles",
      modelProfiles,
    ],
    2,
  );
  assert.equal(routingPlan.status, "requires-review");
  assert.equal(routingPlan.selection, null);

  const routingDir = path.join(
    root,
    ".rigor",
    "evidence",
    "SPIKE-ROUTE-1",
    "routing",
  );
  const persisted = await readdir(routingDir).catch(
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "ENOENT");
      return [];
    },
  );
  assert.deepEqual(persisted, []);
});
