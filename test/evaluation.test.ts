import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildEvaluationReport,
  buildReplayReport,
  createCalibrationProposal,
  parseCalibrationProposalInput,
  parseEvaluationManifest,
  verifyCalibrationEvidence,
} from "../src/evaluation.js";
import { parseModelProfiles } from "../src/routing.js";
import { hash } from "../src/util.js";
import type { EvaluationManifest } from "../src/types.js";

const FIX = path.join(import.meta.dirname, "fixtures", "evaluation");
const EVIDENCE = path.join(FIX, "evidence");

interface Signal {
  count: number;
  denominator: number;
  definition?: string;
}
interface Agg {
  capabilityClass?: string;
  candidate?: string;
  acceptedChanges: number;
  rejectedOutcomes: number;
  perAcceptedChange: { configuredRelativeCost: number | null };
  signals: { overRouting: Signal; underRouting: Signal };
}
interface Split {
  split: string;
  evaluationOnly: boolean;
  outcomes: {
    accepted: number;
    rejected: number;
    absent: number;
    malformed: number;
  };
  missingData: Record<string, number>;
  signals: {
    overRouting: Signal;
    underRouting: Signal;
    retryCost: {
      acceptedChanges: number;
      retriesTotal: number;
      configuredRelativeCostTotal: number;
      configuredRelativeCostPerAcceptedChange: number | null;
      relativeCostUnknownAttempts: number;
    };
    escapedDefects: {
      suspected: number;
      confirmed: number;
      acceptedChanges: number;
    };
  };
  byCapabilityClass: Agg[];
  byCandidate: Agg[];
}
interface Report {
  schemaVersion: string;
  splits: { calibration: Split; holdout: Split };
}
interface Replay {
  split: string;
  holdoutFinal: boolean;
  excludedSplitTaskCount: number;
  summary: { changed: number };
  diffs: Array<{ taskId: string }>;
}

async function loadJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(FIX, file), "utf8")) as unknown;
}

async function report(): Promise<Report> {
  return (await buildEvaluationReport(
    EVIDENCE,
    await manifest(),
    new Date(0),
  )) as unknown as Report;
}

async function manifest(): Promise<EvaluationManifest> {
  return parseEvaluationManifest(await loadJson("manifest.json"));
}

test("the evaluation manifest parses and covers both splits and >=3 categories", async () => {
  const m = await manifest();
  assert.equal(m.schemaVersion, "rigor.evaluation-manifest.v1");
  assert.ok(m.tasks.length >= 10);
  assert.ok(m.categories.length >= 3);
  assert.ok(m.tasks.some((t) => t.split === "calibration"));
  assert.ok(m.tasks.some((t) => t.split === "holdout"));
  assert.ok(m.owner.length > 0 && m.reviewInterval.length > 0);
});

test("manifest parser fails closed on unknown schema, undeclared category, and duplicates", () => {
  assert.throws(() =>
    parseEvaluationManifest({ schemaVersion: "rigor.evaluation-manifest.v2" }),
  );
  assert.throws(() =>
    parseEvaluationManifest({
      schemaVersion: "rigor.evaluation-manifest.v1",
      manifestVersion: 1,
      createdAt: "t",
      owner: "o",
      reviewInterval: "every release",
      categories: ["bugfix"],
      expansionPolicy: "x",
      tasks: [
        { taskId: "A", category: "feature", split: "calibration", source: "s" },
      ],
    }),
  );
  assert.throws(() =>
    parseEvaluationManifest({
      schemaVersion: "rigor.evaluation-manifest.v1",
      manifestVersion: 1,
      createdAt: "t",
      owner: "o",
      reviewInterval: "every release",
      categories: ["bugfix"],
      expansionPolicy: "x",
      tasks: [
        { taskId: "A", category: "bugfix", split: "calibration", source: "s" },
        { taskId: "A", category: "bugfix", split: "holdout", source: "s" },
      ],
    }),
  );
});

test("the evaluation report deterministically matches the checked-in golden fixture", async () => {
  const report = await buildEvaluationReport(
    EVIDENCE,
    await manifest(),
    new Date(0),
  );
  assert.deepEqual(report, await loadJson("expected-report.json"));
});

test("the report uses accepted changes as the denominator and shows missing-data counts", async () => {
  const cal = (await report()).splits.calibration;
  // Accepted includes EVAL-MALF-5: a fully well-formed accepted outcome whose
  // sole attempt is malformed (missing routingPlanArtifactId) and therefore
  // excluded, not the same thing as an malformed outcome.
  assert.equal(cal.outcomes.accepted, 8);
  assert.equal(cal.outcomes.rejected, 1);
  assert.equal(cal.outcomes.absent, 1);
  // Four malformed outcomes: EVAL-MALF-1 (malformed JSON body), EVAL-MALF-2
  // (well-versioned but with a wrong-typed consumed field, retryCount a
  // string), EVAL-MALF-3 (schema-required retryCount field absent entirely),
  // and EVAL-MALF-4 (well-versioned but with a wrong-typed provider field, a
  // number rather than a string).
  assert.equal(cal.outcomes.malformed, 4);
  // The wrong-typed attempt.progress and plan.selection.relativeCost under
  // EVAL-MALF-2, plus EVAL-MALF-5's attempt missing routingPlanArtifactId, are
  // counted as malformed artifacts, never silently defaulted or accepted.
  assert.equal(cal.missingData.malformedArtifacts, 3);
  // Every per-accepted-change rate is denominated by accepted changes.
  assert.equal(cal.signals.retryCost.acceptedChanges, 8);
  assert.equal(cal.signals.escapedDefects.acceptedChanges, 8);
  const premium = cal.byCapabilityClass.find(
    (c) => c.capabilityClass === "premium",
  )!;
  assert.equal(premium.acceptedChanges, 2);
  // configuredRelativeCost is an abstract configured weight aggregated over the
  // accepted changes (140 / 2), never a price or token count.
  assert.equal(premium.perAcceptedChange.configuredRelativeCost, 70);
  // Missing usage is counted, never inferred.
  assert.equal(cal.missingData.usageUnavailable, 3);
  assert.equal(cal.missingData.usageUnknown, 1);
  assert.equal(cal.missingData.modelIdentityAbsent, 8);
});

test("the report detects over-routing, under-routing, retry cost, and escaped defects with explicit denominators", async () => {
  const cal = (await report()).splits.calibration;
  // EVAL-MALF-5 is accepted on the first attempt (retryCount 0, escalationCount
  // 0) with zero review findings at "standard" (above economy), so it also
  // counts as over-routing.
  assert.equal(cal.signals.overRouting.count, 4);
  assert.equal(cal.signals.overRouting.denominator, 8);
  assert.match(String(cal.signals.overRouting.definition), /heuristic/);
  assert.equal(cal.signals.underRouting.count, 3);
  assert.equal(cal.signals.underRouting.denominator, 9);
  assert.equal(cal.signals.retryCost.retriesTotal, 2);
  assert.equal(cal.signals.retryCost.configuredRelativeCostTotal, 270);
  // EVAL-MALF-5's malformed, excluded attempt counts as one unknown relative
  // cost contribution, so the per-accepted-change rate below is null even
  // though every other accepted attempt's cost is fully known.
  assert.equal(cal.signals.retryCost.relativeCostUnknownAttempts, 1);
  assert.equal(
    cal.signals.retryCost.configuredRelativeCostPerAcceptedChange,
    null,
  );
  assert.equal(cal.signals.escapedDefects.confirmed, 1);
});

test("holdout results are hard-separated and marked evaluation-only", async () => {
  const splits = (await report()).splits;
  assert.equal(splits.calibration.evaluationOnly, false);
  assert.equal(splits.holdout.evaluationOnly, true);
  assert.equal(splits.holdout.outcomes.accepted, 1);
});

test("the report never embeds an absolute path", async () => {
  const serialized = JSON.stringify(await report());
  assert.ok(!serialized.includes(EVIDENCE));
  assert.ok(!serialized.includes("/Users/"));
});

test("replay deterministically matches the golden and reports only calibration diffs by default", async () => {
  const profiles = parseModelProfiles(
    await loadJson("proposed-model-profiles.json"),
  );
  const replay = (await buildReplayReport(
    EVIDENCE,
    await manifest(),
    profiles,
    { holdoutFinal: false },
    new Date(0),
  )) as unknown as Replay;
  assert.deepEqual(replay, await loadJson("expected-replay.json"));
  assert.equal(replay.split, "calibration");
  assert.equal(replay.holdoutFinal, false);
  assert.equal(replay.excludedSplitTaskCount, 2);
  assert.equal(replay.summary.changed, 1);
  for (const diff of replay.diffs)
    assert.ok(!String(diff.taskId).includes("HOLD"));
});

test("replay against holdout requires the explicit --holdout-final flag and records it", async () => {
  const profiles = parseModelProfiles(
    await loadJson("proposed-model-profiles.json"),
  );
  const replay = (await buildReplayReport(
    EVIDENCE,
    await manifest(),
    profiles,
    { holdoutFinal: true },
    new Date(0),
  )) as unknown as Replay;
  assert.equal(replay.split, "holdout");
  assert.equal(replay.holdoutFinal, true);
  assert.equal(replay.excludedSplitTaskCount, 14);
  for (const diff of replay.diffs)
    assert.ok(String(diff.taskId).includes("HOLD"));
});

test("replay fails closed when the selected split has no routing plans to replay", async () => {
  const holdoutOnly = parseEvaluationManifest({
    schemaVersion: "rigor.evaluation-manifest.v1",
    manifestVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    owner: "owner",
    reviewInterval: "every release",
    categories: ["feature"],
    expansionPolicy: "holdout-only manifest",
    tasks: [
      {
        taskId: "EVAL-HOLD-1",
        category: "feature",
        split: "holdout",
        source: "s",
      },
    ],
  });
  const profiles = parseModelProfiles(
    await loadJson("proposed-model-profiles.json"),
  );
  // calibration mode over a manifest with no calibration tasks refuses (exit 2).
  await assert.rejects(
    buildReplayReport(EVIDENCE, holdoutOnly, profiles, { holdoutFinal: false }),
    /No calibration tasks/,
  );
});

test("a calibration proposal is inert and records manifest-bound provenance", async () => {
  const input = parseCalibrationProposalInput(
    await loadJson("proposal-input.json"),
  );
  const proposal = createCalibrationProposal(
    input,
    await manifest(),
    new Date(0),
  );
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.approvalEffect, "none");
  assert.equal(proposal.schemaVersion, "rigor.calibration-proposal.v1");
  assert.ok(proposal.expectedTradeOffs.length > 0);
  assert.ok(proposal.rollbackCriteria.length > 0);
  assert.ok(proposal.evidence.reportHashes.length > 0);
  // Provenance cross-checks every cited evidence task against the manifest and
  // records its split, so a proposal's contamination boundary is auditable.
  assert.match(proposal.provenance.manifestHash, /^[a-f0-9]{64}$/u);
  assert.equal(proposal.provenance.holdoutFinalEvaluation, false);
  assert.deepEqual(proposal.provenance.evidenceTaskSplits, [
    { taskId: "EVAL-FEAT-2", split: "calibration" },
  ]);
});

test("a calibration proposal input carries its own schema version, distinct from the artifact", async () => {
  const input = parseCalibrationProposalInput(
    await loadJson("proposal-input.json"),
  );
  assert.equal(input.schemaVersion, "rigor.calibration-proposal-input.v1");
  const proposal = createCalibrationProposal(
    input,
    await manifest(),
    new Date(0),
  );
  assert.equal(proposal.schemaVersion, "rigor.calibration-proposal.v1");
  // The artifact fields the CLI generates are absent from the input.
  assert.ok(!("artifactId" in input));
  assert.ok(!("createdAt" in input));
  assert.ok(!("provenance" in input));
});

test("a calibration proposal claiming approval or a non-proposed status is rejected", async () => {
  const base = (await loadJson("proposal-input.json")) as Record<
    string,
    unknown
  >;
  assert.throws(() =>
    parseCalibrationProposalInput({ ...base, approvalEffect: "enforce" }),
  );
  assert.throws(() =>
    parseCalibrationProposalInput({ ...base, status: "approved" }),
  );
  // The artifact schema version is not a valid input schema version.
  assert.throws(() =>
    parseCalibrationProposalInput({
      ...base,
      schemaVersion: "rigor.calibration-proposal.v1",
    }),
  );
});

test("a calibration proposal citing an unknown or holdout task fails closed", async () => {
  const base = (await loadJson("proposal-input.json")) as Record<
    string,
    unknown
  >;
  const m = await manifest();
  // A task absent from the manifest can never be cited.
  const unknownTask = parseCalibrationProposalInput({
    ...base,
    evidence: {
      ...(base.evidence as object),
      taskIds: ["EVAL-NOT-IN-MANIFEST"],
    },
  });
  assert.throws(() => createCalibrationProposal(unknownTask, m, new Date(0)));
  // A holdout task cannot be cited unless holdoutFinalEvaluation is explicit.
  const holdoutCitation = {
    ...base,
    evidence: { ...(base.evidence as object), taskIds: ["EVAL-HOLD-1"] },
  };
  assert.throws(() =>
    createCalibrationProposal(
      parseCalibrationProposalInput(holdoutCitation),
      m,
      new Date(0),
    ),
  );
  // With the explicit flag, the holdout citation is permitted and recorded.
  const finalEval = parseCalibrationProposalInput({
    ...holdoutCitation,
    holdoutFinalEvaluation: true,
  });
  const proposal = createCalibrationProposal(finalEval, m, new Date(0));
  assert.equal(proposal.provenance.holdoutFinalEvaluation, true);
  assert.deepEqual(proposal.provenance.evidenceTaskSplits, [
    { taskId: "EVAL-HOLD-1", split: "holdout" },
  ]);
});

test("an unresolved routing plan makes the configured relative cost null, never zero", async () => {
  const unresolved = parseEvaluationManifest(
    await loadJson("manifest-unresolved.json"),
  );
  const report = (await buildEvaluationReport(
    EVIDENCE,
    unresolved,
    new Date(0),
  )) as unknown as Report;
  const cal = report.splits.calibration;
  assert.equal(cal.outcomes.accepted, 1);
  // The single accepted change has an unresolved plan, so the average configured
  // relative cost is unknown (null) rather than a misleading zero.
  assert.equal(cal.signals.retryCost.relativeCostUnknownAttempts, 1);
  assert.equal(
    cal.signals.retryCost.configuredRelativeCostPerAcceptedChange,
    null,
  );
  const standard = cal.byCapabilityClass.find(
    (c) => c.capabilityClass === "standard",
  )!;
  assert.equal(standard.perAcceptedChange.configuredRelativeCost, null);
});

test("byCandidate is keyed by provider, model, and capability class, not model alone", async () => {
  const cal = (await report()).splits.calibration;
  // The internal key is JSON.stringify([provider, model, capabilityClass]),
  // not a delimiter-joined string, so it stays collision-proof even when a
  // provider or model name contains "/".
  assert.ok(
    cal.byCandidate.every((c) =>
      /^\["synthetic","synthetic-[a-z]+","[a-z]+"\]$/u.test(
        String(c.candidate),
      ),
    ),
  );
});

test("a provider or model name containing the old delimiter never collapses two candidates into one", async () => {
  const collisionManifest = parseEvaluationManifest(
    await loadJson("manifest-candidate-collision.json"),
  );
  const collisionReport = (await buildEvaluationReport(
    EVIDENCE,
    collisionManifest,
    new Date(0),
  )) as unknown as Report;
  const cal = collisionReport.splits.calibration;
  // A naive `${provider}/${model}/${capabilityClass}` join would read
  // "a/b/c/standard" for both EVAL-COLL-A (provider "a/b", model "c") and
  // EVAL-COLL-B (provider "a", model "b/c"), collapsing them into one row.
  // JSON.stringify's quoting keeps them distinct.
  assert.equal(cal.byCandidate.length, 2);
  assert.equal(cal.outcomes.accepted, 2);
  const candidates = cal.byCandidate.map((c) => c.candidate);
  assert.ok(candidates.includes(JSON.stringify(["a/b", "c", "standard"])));
  assert.ok(candidates.includes(JSON.stringify(["a", "b/c", "standard"])));
});

test("replay marks a re-weighted same-id candidate as changed", async () => {
  const profiles = parseModelProfiles(
    await loadJson("proposed-model-profiles-cost-change.json"),
  );
  const replay = (await buildReplayReport(
    EVIDENCE,
    await manifest(),
    profiles,
    { holdoutFinal: false },
    new Date(0),
  )) as unknown as {
    diffs: Array<{
      taskId: string;
      original: { candidateId: string; relativeCost: number } | null;
      proposed: { candidateId: string; relativeCost: number } | null;
      changed: boolean;
    }>;
  };
  const bug1 = replay.diffs.find((d) => d.taskId === "EVAL-BUG-1")!;
  // The candidate id is unchanged but its configured relative cost is re-weighted
  // (20 -> 25); that is a real routing change, so changed must be true.
  assert.equal(bug1.original!.candidateId, "claude-standard");
  assert.equal(bug1.proposed!.candidateId, "claude-standard");
  assert.equal(bug1.original!.relativeCost, 20);
  assert.equal(bug1.proposed!.relativeCost, 25);
  assert.equal(bug1.changed, true);
});

test("evidence reads never follow a symlink out of the evidence root", async () => {
  const { mkdtemp, mkdir, writeFile, symlink } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const base = await mkdtemp(path.join(tmpdir(), "rigor-eval-symlink-"));
  const root = path.join(base, "evidence");
  const outside = path.join(base, "outside", "EVIL");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  // A fully valid accepted outcome sitting OUTSIDE the evidence root.
  await writeFile(
    path.join(outside, "outcome.json"),
    JSON.stringify({
      schemaVersion: "rigor.outcome.v1",
      decision: "accepted",
      capabilityClass: "standard",
      attemptArtifactId: "a",
      humanCorrectionMinutes: 1234567,
    }),
  );
  // A task directory inside the root that is a symlink to the outside directory.
  await symlink(path.join(base, "outside", "EVIL"), path.join(root, "EVIL"));
  const escaping = parseEvaluationManifest({
    schemaVersion: "rigor.evaluation-manifest.v1",
    manifestVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    owner: "owner",
    reviewInterval: "every release",
    categories: ["feature"],
    expansionPolicy: "symlink-escape manifest",
    tasks: [
      {
        taskId: "EVIL",
        category: "feature",
        split: "calibration",
        source: "s",
      },
    ],
  });
  const report = (await buildEvaluationReport(
    root,
    escaping,
    new Date(0),
  )) as unknown as Report;
  const cal = report.splits.calibration;
  // The escaping task is counted as malformed and its outside content is not read.
  assert.equal(cal.outcomes.malformed, 1);
  assert.equal(cal.outcomes.accepted, 0);
  assert.ok(!JSON.stringify(report).includes("1234567"));
});

test("an accepted change with one valid attempt and one malformed attempt has an unknown, never partial, configured relative cost", async () => {
  const mixedManifest = parseEvaluationManifest(
    await loadJson("manifest-mixed-attempts.json"),
  );
  const mixedReport = (await buildEvaluationReport(
    EVIDENCE,
    mixedManifest,
    new Date(0),
  )) as unknown as Report;
  const cal = mixedReport.splits.calibration;
  assert.equal(cal.outcomes.accepted, 1);
  // One attempt is malformed (missing routingPlanArtifactId) and excluded; the
  // other is valid with a known relativeCost of 15. Without counting the
  // malformed attempt's cost as unknown, the average would silently read as
  // if the valid attempt's cost applied to the whole task.
  assert.equal(cal.signals.retryCost.relativeCostUnknownAttempts, 1);
  assert.equal(cal.signals.retryCost.configuredRelativeCostTotal, 15);
  assert.equal(
    cal.signals.retryCost.configuredRelativeCostPerAcceptedChange,
    null,
  );
});

test("an accepted change with no recorded elapsed time has a null per-accepted-change average, never zero", async () => {
  const elapsedManifest = parseEvaluationManifest(
    await loadJson("manifest-elapsed-missing.json"),
  );
  const elapsedReport = (await buildEvaluationReport(
    EVIDENCE,
    elapsedManifest,
    new Date(0),
  )) as unknown as {
    splits: {
      calibration: {
        byCapabilityClass: Array<{
          capabilityClass: string;
          perAcceptedChange: { elapsedMs: number | null };
          totals: {
            elapsedMs: { total: number; present: number; missing: number };
          };
        }>;
      };
    };
  };
  const standard = elapsedReport.splits.calibration.byCapabilityClass.find(
    (c) => c.capabilityClass === "standard",
  )!;
  assert.equal(standard.perAcceptedChange.elapsedMs, null);
  assert.ok(standard.totals.elapsedMs.missing > 0);
});

test("a collection directory that escapes the evidence root counts as one malformed artifact, never zero", async () => {
  const { mkdtemp, mkdir, writeFile, symlink } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const base = await mkdtemp(path.join(tmpdir(), "rigor-eval-symlink-dir-"));
  const root = path.join(base, "evidence");
  const task = path.join(root, "ESCDIR");
  const outside = path.join(base, "outside-attempts");
  await mkdir(task, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(
    path.join(task, "outcome.json"),
    JSON.stringify({
      schemaVersion: "rigor.outcome.v1",
      artifactId: "outcome_ESCDIR",
      taskId: "ESCDIR",
      createdAt: "2026-01-01T00:00:00.000Z",
      decision: "accepted",
      acceptedWithoutModelCodeChanges: false,
      humanCorrectionMinutes: 0,
      escalationCount: 0,
      retryCount: 0,
      reviewFindings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      revertStatus: "none",
      escapedDefectStatus: "none",
      executionIdentityStatus: "unverified",
      usage: {
        status: "unavailable",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        reasoningEffort: null,
        providerCost: null,
        modelIdentity: null,
      },
      notes: [],
    }),
  );
  // A fully valid attempt sitting OUTSIDE the evidence root, never read.
  await writeFile(
    path.join(outside, "attempt_ESCDIR_1.json"),
    JSON.stringify({ schemaVersion: "rigor.attempt.v1", marker: "1234567" }),
  );
  // The task's attempts/ collection directory is itself a symlink escaping root.
  await symlink(outside, path.join(task, "attempts"));
  const escaping = parseEvaluationManifest({
    schemaVersion: "rigor.evaluation-manifest.v1",
    manifestVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    owner: "owner",
    reviewInterval: "every release",
    categories: ["feature"],
    expansionPolicy: "symlinked collection directory manifest",
    tasks: [
      {
        taskId: "ESCDIR",
        category: "feature",
        split: "calibration",
        source: "s",
      },
    ],
  });
  const report = (await buildEvaluationReport(
    root,
    escaping,
    new Date(0),
  )) as unknown as Report;
  const cal = report.splits.calibration;
  // The task's own outcome is well-formed and accepted; only its attempts/
  // collection is unreadable, so exactly one malformed artifact is counted,
  // never zero, and the outside content is never read.
  assert.equal(cal.outcomes.accepted, 1);
  assert.equal(cal.missingData.malformedArtifacts, 1);
  assert.ok(!JSON.stringify(report).includes("1234567"));
});

test("an individual artifact file that is a symlink escaping the evidence root is never read and counts as malformed", async () => {
  const { mkdtemp, mkdir, writeFile, symlink } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const base = await mkdtemp(path.join(tmpdir(), "rigor-eval-symlink-file-"));
  const root = path.join(base, "evidence");
  const attempts = path.join(root, "ESCFILE", "attempts");
  const outside = path.join(base, "outside-file");
  await mkdir(attempts, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(
    path.join(root, "ESCFILE", "outcome.json"),
    JSON.stringify({
      schemaVersion: "rigor.outcome.v1",
      artifactId: "outcome_ESCFILE",
      taskId: "ESCFILE",
      createdAt: "2026-01-01T00:00:00.000Z",
      decision: "accepted",
      acceptedWithoutModelCodeChanges: false,
      humanCorrectionMinutes: 0,
      escalationCount: 0,
      retryCount: 0,
      reviewFindings: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      revertStatus: "none",
      escapedDefectStatus: "none",
      executionIdentityStatus: "unverified",
      usage: {
        status: "unavailable",
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        reasoningEffort: null,
        providerCost: null,
        modelIdentity: null,
      },
      notes: [],
    }),
  );
  // A fully valid attempt sitting OUTSIDE the evidence root, never read.
  await writeFile(
    path.join(outside, "attempt_ESCFILE_1.json"),
    JSON.stringify({ schemaVersion: "rigor.attempt.v1", marker: "1234567" }),
  );
  // The attempts/ directory itself is legitimate and inside the root; only the
  // individual file within it is a symlink escaping the root.
  await symlink(
    path.join(outside, "attempt_ESCFILE_1.json"),
    path.join(attempts, "attempt_ESCFILE_1.json"),
  );
  const escaping = parseEvaluationManifest({
    schemaVersion: "rigor.evaluation-manifest.v1",
    manifestVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    owner: "owner",
    reviewInterval: "every release",
    categories: ["feature"],
    expansionPolicy: "symlinked individual artifact manifest",
    tasks: [
      {
        taskId: "ESCFILE",
        category: "feature",
        split: "calibration",
        source: "s",
      },
    ],
  });
  const report = (await buildEvaluationReport(
    root,
    escaping,
    new Date(0),
  )) as unknown as Report;
  const cal = report.splits.calibration;
  assert.equal(cal.outcomes.accepted, 1);
  assert.equal(cal.missingData.malformedArtifacts, 1);
  assert.ok(!JSON.stringify(report).includes("1234567"));
});

test("calibration evidence hashes are verified against actually-supplied report/replay files", async () => {
  const m = await manifest();
  const goldenReport = await loadJson("expected-report.json");
  const goldenReplay = await loadJson("expected-replay.json");
  const input = parseCalibrationProposalInput(
    await loadJson("proposal-input.json"),
  );
  // The checked-in expected-report.json's manifest hash matches manifest.json,
  // and its canonical hash (hash() over the parsed object, exactly like
  // proposedModelProfilesHash/manifest.hash) matches evidence.reportHashes.
  assert.doesNotThrow(() =>
    verifyCalibrationEvidence(input.evidence, m, [goldenReport]),
  );
  // replayHash is null in the fixture input, so it is not checked; supplying
  // the replay file too must not break verification.
  assert.doesNotThrow(() =>
    verifyCalibrationEvidence(input.evidence, m, [goldenReport, goldenReplay]),
  );
  // A replayHash, once set, must be backed by a supplied replay file whose
  // hash matches exactly.
  const withReplay = {
    ...input.evidence,
    replayHash: hash(goldenReplay),
  };
  assert.doesNotThrow(() =>
    verifyCalibrationEvidence(withReplay, m, [goldenReport, goldenReplay]),
  );
});

test("calibration evidence verification fails closed on every kind of mismatch", async () => {
  const m = await manifest();
  const goldenReport = await loadJson("expected-report.json");
  const goldenReplay = await loadJson("expected-replay.json");
  const input = parseCalibrationProposalInput(
    await loadJson("proposal-input.json"),
  );
  // No --report supplied at all.
  assert.throws(() => verifyCalibrationEvidence(input.evidence, m, []));
  // A reportHashes digest with no backing supplied file.
  assert.throws(() =>
    verifyCalibrationEvidence(
      { ...input.evidence, reportHashes: ["f".repeat(64)] },
      m,
      [goldenReport],
    ),
  );
  // A supplied file whose manifest.hash does not match the selected manifest.
  const unresolved = parseEvaluationManifest(
    await loadJson("manifest-unresolved.json"),
  );
  assert.throws(() =>
    verifyCalibrationEvidence(input.evidence, unresolved, [goldenReport]),
  );
  // A supplied file that is neither an evaluation report nor a replay.
  assert.throws(() =>
    verifyCalibrationEvidence(input.evidence, m, [
      { ...(goldenReport as Record<string, unknown>), schemaVersion: "future" },
    ]),
  );
  // A replayHash with no backing supplied replay file (only the report is
  // supplied, or the replay's own hash does not match).
  const withReplay = { ...input.evidence, replayHash: "a".repeat(64) };
  assert.throws(() =>
    verifyCalibrationEvidence(withReplay, m, [goldenReport, goldenReplay]),
  );
  // A reportHashes entry that matches a supplied replay file's hash rather
  // than a report file's: the schemaVersion must match the evidence kind, not
  // merely the digest.
  const replayOnlyAsReport = {
    ...input.evidence,
    reportHashes: [hash(goldenReplay)],
  };
  assert.throws(() =>
    verifyCalibrationEvidence(replayOnlyAsReport, m, [goldenReplay]),
  );
});
