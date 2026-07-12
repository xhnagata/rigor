import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildTestIntegrityEvent,
  CANDIDATE_SET_VERSION,
  DETECTOR_CONFIGURATION_DIGEST,
  DETECTOR_VERSION,
} from "../src/test-integrity.js";
import {
  CURRENT_DETECTORS,
  CURRENT_SCHEMA_BINDINGS,
  antiBypassOutcome,
  applyWaiver,
  buildPromotionReplay,
  createPromotionProposal,
  createWaiver,
  enforcePromotedSignals,
  evaluateActivation,
  parsePromotionInput,
  parseWaiverInput,
} from "../src/test-integrity-promotion.js";
import type {
  TestIntegrityClassification,
  TestIntegrityEffect,
  TestIntegrityEvent,
  TestIntegrityPromotion,
  TestIntegritySignal,
} from "../src/types.js";
import { hash } from "../src/util.js";

const policyHash = "a".repeat(64);
const sampleSignal: TestIntegritySignal = {
  signalId: "TI-05",
  threatClass: "skip-only-todo",
  label: "advisory-interpretation",
  computation: "deterministic",
  detector: { name: "diff-token-scan", version: DETECTOR_VERSION },
  value: { addedMarkers: 1 },
  paths: ["test/example.test.ts"],
  matchDigest: "b".repeat(64),
  note: null,
};

interface Fixture {
  root: string;
  input: ReturnType<typeof parsePromotionInput>;
  events: TestIntegrityEvent[];
}

async function fixture(
  effect: TestIntegrityEffect,
  counts: {
    evaluated: number;
    truePositive: number;
    falsePositive: number;
    uncertain?: number;
  },
): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rigor-promotion-"));
  const fired =
    counts.truePositive + counts.falsePositive + (counts.uncertain ?? 0);
  const events = Array.from({ length: counts.evaluated }, (_, index) => {
    const event = buildTestIntegrityEvent(
      {
        taskId: "GH-PROMOTION-FIXTURE",
        baseSha: "1".repeat(40),
        headSha: "2".repeat(40),
        worktreeDigest: null,
        attemptArtifactId: null,
        verificationArtifactId: null,
        note: null,
      },
      index < fired ? [sampleSignal] : [],
      new Date(index * 1000),
    );
    return { ...event, provenance: "synthetic-test-fixture" as const };
  });
  const classifications: TestIntegrityClassification[] = [];
  let occurrence = 0;
  for (const [verdict, count] of [
    ["true-positive", counts.truePositive],
    ["false-positive", counts.falsePositive],
    ["uncertain", counts.uncertain ?? 0],
  ] as const)
    for (let index = 0; index < count; index += 1) {
      const event = events[occurrence++]!;
      classifications.push({
        schemaVersion: "rigor.test-integrity-classification.v1",
        artifactId: `classification_${occurrence}`,
        taskId: event.taskId,
        createdAt: new Date(100_000 + occurrence).toISOString(),
        eventArtifactId: event.artifactId,
        classifiedBy: "human",
        verdicts: [{ signalId: "TI-05", verdict, note: null }],
      });
    }
  const eventRefs = [];
  for (const [index, event] of events.entries()) {
    const file = `event-${index}.json`;
    await writeFile(path.join(root, file), `${JSON.stringify(event)}\n`);
    eventRefs.push({ path: file, digest: hash(event) });
  }
  const classificationRefs = [];
  for (const [index, classification] of classifications.entries()) {
    const file = `classification-${index}.json`;
    await writeFile(
      path.join(root, file),
      `${JSON.stringify(classification)}\n`,
    );
    classificationRefs.push({ path: file, digest: hash(classification) });
  }
  const input = parsePromotionInput({
    schemaVersion: "rigor.test-integrity-promotion-input.v1",
    taskId: "GH-PROMOTION-FIXTURE",
    policyHash,
    schemaBindings: CURRENT_SCHEMA_BINDINGS,
    signals: [
      {
        signalId: "TI-05",
        detector: { name: "diff-token-scan", version: DETECTOR_VERSION },
        evaluatedCandidateSet: {
          version: CANDIDATE_SET_VERSION,
          configurationDigest: DETECTOR_CONFIGURATION_DIGEST,
        },
        requestedEffect: effect,
        evidence: {
          events: eventRefs,
          classifications: classificationRefs,
        },
        stratum: {
          evaluated: counts.evaluated,
          fired,
          humanClassified: {
            truePositive: counts.truePositive,
            falsePositive: counts.falsePositive,
            uncertain: counts.uncertain ?? 0,
          },
        },
        rollbackConditions: [
          {
            metric: "false-discovery-proportion",
            operator: "greater-than",
            threshold: 0.5,
            minimumClassifiedFired: 5,
          },
        ],
      },
    ],
    approval: {
      declaredBy: "human",
      declaration: "approved-for-proposal",
      note: "Synthetic fixture declaration; not activation authority.",
      identityAttested: false,
    },
  });
  return { root, input, events };
}

async function qualifyingProposal(): Promise<{
  fixture: Fixture;
  proposal: TestIntegrityPromotion;
}> {
  const data = await fixture("advisory", {
    evaluated: 25,
    truePositive: 5,
    falsePositive: 0,
  });
  const proposal = await createPromotionProposal(
    data.input,
    data.root,
    new Date(0),
    { allowSynthetic: true },
  );
  return { fixture: data, proposal };
}

test("a qualifying, linked promotion is activatable", async () => {
  const { fixture: data, proposal } = await qualifyingProposal();
  try {
    const replay = await buildPromotionReplay(proposal, data.root, new Date(0));
    const [result] = evaluateActivation(
      {
        schemaVersion: "rigor.test-integrity-active.v1",
        entries: [
          {
            signalId: "TI-05",
            proposalDigest: proposal.proposalDigest,
            replayDigest: replay.replayDigest,
            disposition: "active",
            rollbackTriggered: false,
          },
        ],
      },
      [proposal],
      [replay],
      CURRENT_DETECTORS,
      policyHash,
    );
    assert.equal(result?.state, "active");
    assert.deepEqual(replay.signals[0], {
      signalId: "TI-05",
      requestedEffect: "advisory",
      detector: { name: "diff-token-scan", version: DETECTOR_VERSION },
      candidateSetVersion: CANDIDATE_SET_VERSION,
      evaluated: 25,
      fired: 5,
      wouldFire: 5,
    });
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("insufficient and false-positive-dominated evidence are refused", async () => {
  const insufficient = await fixture("advisory", {
    evaluated: 24,
    truePositive: 5,
    falsePositive: 0,
  });
  const dominated = await fixture("advisory", {
    evaluated: 25,
    truePositive: 2,
    falsePositive: 3,
  });
  try {
    await assert.rejects(
      createPromotionProposal(
        insufficient.input,
        insufficient.root,
        new Date(0),
        {
          allowSynthetic: true,
        },
      ),
      /INSUFFICIENT_EVALUATED/u,
    );
    await assert.rejects(
      createPromotionProposal(dominated.input, dominated.root, new Date(0), {
        allowSynthetic: true,
      }),
      /FALSE_DISCOVERY_PROPORTION_EXCEEDED/u,
    );
  } finally {
    await rm(insufficient.root, { recursive: true, force: true });
    await rm(dominated.root, { recursive: true, force: true });
  }
});

test("production promotion rejects explicitly synthetic provenance", async () => {
  const data = await fixture("advisory", {
    evaluated: 25,
    truePositive: 5,
    falsePositive: 0,
  });
  try {
    await assert.rejects(
      createPromotionProposal(data.input, data.root),
      /synthetic-provenance/u,
    );
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("version binding mismatch refuses an otherwise qualifying promotion", async () => {
  const { fixture: data, proposal } = await qualifyingProposal();
  try {
    const replay = await buildPromotionReplay(proposal, data.root);
    const changed = {
      ...CURRENT_DETECTORS,
      "TI-05": { ...CURRENT_DETECTORS["TI-05"], version: "future" },
    };
    const [result] = evaluateActivation(
      {
        schemaVersion: "rigor.test-integrity-active.v1",
        entries: [
          {
            signalId: "TI-05",
            proposalDigest: proposal.proposalDigest,
            replayDigest: replay.replayDigest,
            disposition: "active",
            rollbackTriggered: false,
          },
        ],
      },
      [proposal],
      [replay],
      changed,
      policyHash,
    );
    assert.equal(result?.reasonCode, "DETECTOR_VERSION_MISMATCH");
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("rollback freezes a previously active promotion pending separate review", async () => {
  const { fixture: data, proposal } = await qualifyingProposal();
  try {
    const replay = await buildPromotionReplay(proposal, data.root);
    const [result] = evaluateActivation(
      {
        schemaVersion: "rigor.test-integrity-active.v1",
        entries: [
          {
            signalId: "TI-05",
            proposalDigest: proposal.proposalDigest,
            replayDigest: replay.replayDigest,
            disposition: "active",
            rollbackTriggered: true,
          },
        ],
      },
      [proposal],
      [replay],
      CURRENT_DETECTORS,
      policyHash,
    );
    assert.equal(result?.state, "frozen(requires-review)");
    assert.equal(result?.reasonCode, "ROLLBACK_CONDITION_MET");
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("a waiver downgrades one fired enforcement without hiding the original", () => {
  const event = buildTestIntegrityEvent(
    {
      taskId: "GH-WAIVER",
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      worktreeDigest: null,
      attemptArtifactId: null,
      verificationArtifactId: null,
      note: null,
    },
    [sampleSignal],
    new Date(0),
  );
  const promotionDigest = "c".repeat(64);
  const outcome = enforcePromotedSignals(event, [
    {
      signalId: "TI-05",
      state: "active",
      reasonCode: null,
      effect: "stop",
      proposalDigest: promotionDigest,
    },
  ]);
  const occurrence = outcome.original.occurrences[0]!;
  const waiver = createWaiver(
    parseWaiverInput({
      schemaVersion: "rigor.test-integrity-waiver-input.v1",
      taskId: "GH-WAIVER",
      enforcementOutcomeDigest: outcome.original.digest,
      signalOccurrenceDigest: occurrence.occurrenceDigest,
      promotionDigest,
      headSha: "d".repeat(40),
      scope: "one TI-05 occurrence",
      reason: "Reviewed exception",
      expiresAt: "2030-01-01T00:00:00.000Z",
      declaredBy: "human",
      identityAttested: false,
      externalReviewReference: "protected-review:123",
    }),
    new Date("2029-01-01T00:00:00.000Z"),
  );
  const applied = applyWaiver(outcome, waiver);
  assert.equal(applied.original.gate, "immediate-stop");
  assert.deepEqual(applied.original, outcome.original);
  assert.equal(applied.effectiveGate, "recorded-and-waived");
});

test("anti-bypass escalates protected same-diff changes", () => {
  assert.equal(
    antiBypassOutcome(["src/test-integrity-promotion.ts"]),
    "required-human-review",
  );
  assert.equal(
    antiBypassOutcome(["schemas/test-integrity-promotion.v1.schema.json"]),
    "required-human-review",
  );
  assert.equal(antiBypassOutcome(["README.md"]), null);
});

test("differential golden: no active registry preserves shadow-only behavior", () => {
  const event = buildTestIntegrityEvent(
    {
      taskId: "GH-GOLDEN",
      baseSha: "1".repeat(40),
      headSha: "2".repeat(40),
      worktreeDigest: null,
      attemptArtifactId: null,
      verificationArtifactId: null,
      note: null,
    },
    [sampleSignal],
    new Date(0),
  );
  const outcome = enforcePromotedSignals(event, []);
  assert.equal(event.mode, "shadow");
  assert.equal(event.enforcement, "none");
  assert.equal(outcome.original.gate, "none");
  assert.equal(outcome.effectiveGate, "none");
  assert.deepEqual(outcome.original.occurrences, []);
});
