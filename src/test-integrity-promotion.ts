import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { EXIT, RigorError } from "./errors.js";
import {
  CANDIDATE_SET_VERSION,
  DETECTOR_CONFIGURATION_DIGEST,
  DETECTOR_VERSION,
  EVALUATED_SIGNALS,
  parseTestIntegrityEvent,
} from "./test-integrity.js";
import type {
  PromotionCriterion,
  TestIntegrityClassification,
  TestIntegrityEffect,
  TestIntegrityEvent,
  TestIntegrityPromotion,
  TestIntegrityPromotionInput,
  TestIntegrityPromotionSignal,
  TestIntegrityReplayReport,
  TestIntegritySignalId,
  TestIntegrityWaiver,
  TestIntegrityWaiverInput,
} from "./types.js";
import {
  TEST_INTEGRITY_CLASSIFICATION_SCHEMA,
  TEST_INTEGRITY_EVENT_SCHEMA,
  TEST_INTEGRITY_PROMOTION_INPUT_SCHEMA,
  TEST_INTEGRITY_PROMOTION_SCHEMA,
  TEST_INTEGRITY_REPLAY_SCHEMA,
  TEST_INTEGRITY_WAIVER_INPUT_SCHEMA,
  TEST_INTEGRITY_WAIVER_SCHEMA,
} from "./types.js";
import {
  artifactId,
  assertContainedPath,
  hash,
  readJson,
  record,
  taskId,
  textField,
} from "./util.js";

/** Human-approved conservative governance risk floors. These values are not
 * empirically calibrated and changing them is an anti-bypass protected change. */
export const PROMOTION_CRITERIA: Readonly<
  Record<TestIntegrityEffect, PromotionCriterion>
> = Object.freeze({
  advisory: Object.freeze({
    minimumEvaluated: 25,
    minimumHumanClassifiedFired: 5,
    maximumFalseDiscoveryProportion: 0.5,
  }),
  review: Object.freeze({
    minimumEvaluated: 50,
    minimumHumanClassifiedFired: 10,
    maximumFalseDiscoveryProportion: 0.2,
  }),
  stop: Object.freeze({
    minimumEvaluated: 100,
    minimumHumanClassifiedFired: 20,
    maximumFalseDiscoveryProportion: 0.05,
  }),
});

export const ACTIVE_REGISTRY_PATH = ".rigor/test-integrity-active.json";

export const CURRENT_SCHEMA_BINDINGS = Object.freeze({
  event: TEST_INTEGRITY_EVENT_SCHEMA,
  classification: TEST_INTEGRITY_CLASSIFICATION_SCHEMA,
  promotion: TEST_INTEGRITY_PROMOTION_SCHEMA,
  replay: TEST_INTEGRITY_REPLAY_SCHEMA,
});

const EFFECTS: readonly TestIntegrityEffect[] = ["stop", "review", "advisory"];
const HEX64 = /^[0-9a-f]{64}$/u;
const HEX40 = /^[0-9a-f]{40}$/u;

function fail(message: string, policy = false): never {
  throw new RigorError(
    message,
    policy ? EXIT.policyViolation : EXIT.inputError,
  );
}

function exact(
  item: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const extra = Object.keys(item).filter((key) => !allowed.includes(key));
  if (extra.length > 0) fail(`${name} has unknown field: ${extra[0]}`);
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(`${name} must be a non-negative safe integer`);
  return value as number;
}

function digest(value: unknown, name: string): string {
  const result = textField(value, name, 64);
  if (!HEX64.test(result)) fail(`${name} must be a sha256 digest`);
  return result;
}

function parseSignalId(value: unknown, name: string): TestIntegritySignalId {
  const id = textField(value, name, 16) as TestIntegritySignalId;
  if (!EVALUATED_SIGNALS.includes(id)) fail(`${name} is not supported`);
  return id;
}

function parseEvidenceRefs(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000)
    fail(`${name} must be a bounded non-empty array`);
  return value.map((raw, index) => {
    const item = record(raw, `${name}[${index}]`);
    exact(item, ["path", "digest"], `${name}[${index}]`);
    const relative = textField(item.path, `${name}[${index}].path`, 300);
    if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes(".."))
      fail(`${name}[${index}].path must be relative and contained`);
    return {
      path: relative,
      digest: digest(item.digest, `${name}[${index}].digest`),
    };
  });
}

function parsePromotionSignal(
  raw: unknown,
  index: number,
): TestIntegrityPromotionSignal {
  const name = `signals[${index}]`;
  const item = record(raw, name);
  exact(
    item,
    [
      "signalId",
      "detector",
      "evaluatedCandidateSet",
      "requestedEffect",
      "evidence",
      "stratum",
      "rollbackConditions",
    ],
    name,
  );
  const detector = record(item.detector, `${name}.detector`);
  exact(detector, ["name", "version"], `${name}.detector`);
  const candidate = record(
    item.evaluatedCandidateSet,
    `${name}.evaluatedCandidateSet`,
  );
  exact(
    candidate,
    ["version", "configurationDigest"],
    `${name}.evaluatedCandidateSet`,
  );
  const evidence = record(item.evidence, `${name}.evidence`);
  exact(evidence, ["events", "classifications"], `${name}.evidence`);
  const stratum = record(item.stratum, `${name}.stratum`);
  exact(stratum, ["evaluated", "fired", "humanClassified"], `${name}.stratum`);
  const classified = record(
    stratum.humanClassified,
    `${name}.stratum.humanClassified`,
  );
  exact(
    classified,
    ["truePositive", "falsePositive", "uncertain"],
    `${name}.stratum.humanClassified`,
  );
  if (
    !Array.isArray(item.rollbackConditions) ||
    item.rollbackConditions.length === 0 ||
    item.rollbackConditions.length > 8
  )
    fail(`${name}.rollbackConditions must be a bounded non-empty array`);
  const rollbackConditions = item.rollbackConditions.map(
    (rawCondition, conditionIndex) => {
      const conditionName = `${name}.rollbackConditions[${conditionIndex}]`;
      const condition = record(rawCondition, conditionName);
      exact(
        condition,
        ["metric", "operator", "threshold", "minimumClassifiedFired"],
        conditionName,
      );
      if (
        condition.metric !== "false-discovery-proportion" &&
        condition.metric !== "review-coverage"
      )
        fail(`${conditionName}.metric is invalid`);
      if (
        condition.operator !== "greater-than" &&
        condition.operator !== "less-than"
      )
        fail(`${conditionName}.operator is invalid`);
      if (
        typeof condition.threshold !== "number" ||
        !Number.isFinite(condition.threshold) ||
        condition.threshold < 0 ||
        condition.threshold > 1
      )
        fail(`${conditionName}.threshold must be between zero and one`);
      return {
        metric: condition.metric as
          | "false-discovery-proportion"
          | "review-coverage",
        operator: condition.operator as "greater-than" | "less-than",
        threshold: condition.threshold,
        minimumClassifiedFired: integer(
          condition.minimumClassifiedFired,
          `${conditionName}.minimumClassifiedFired`,
        ),
      };
    },
  );
  if (
    typeof item.requestedEffect !== "string" ||
    !EFFECTS.includes(item.requestedEffect as TestIntegrityEffect)
  )
    fail(`${name}.requestedEffect is invalid`);
  return {
    signalId: parseSignalId(item.signalId, `${name}.signalId`),
    detector: {
      name: textField(detector.name, `${name}.detector.name`, 64),
      version: textField(detector.version, `${name}.detector.version`, 32),
    },
    evaluatedCandidateSet: {
      version: textField(
        candidate.version,
        `${name}.evaluatedCandidateSet.version`,
        64,
      ),
      configurationDigest: digest(
        candidate.configurationDigest,
        `${name}.evaluatedCandidateSet.configurationDigest`,
      ),
    },
    requestedEffect: item.requestedEffect as TestIntegrityEffect,
    evidence: {
      events: parseEvidenceRefs(evidence.events, `${name}.evidence.events`),
      classifications:
        Array.isArray(evidence.classifications) &&
        evidence.classifications.length === 0
          ? []
          : parseEvidenceRefs(
              evidence.classifications,
              `${name}.evidence.classifications`,
            ),
    },
    stratum: {
      evaluated: integer(stratum.evaluated, `${name}.stratum.evaluated`),
      fired: integer(stratum.fired, `${name}.stratum.fired`),
      humanClassified: {
        truePositive: integer(
          classified.truePositive,
          `${name}.stratum.humanClassified.truePositive`,
        ),
        falsePositive: integer(
          classified.falsePositive,
          `${name}.stratum.humanClassified.falsePositive`,
        ),
        uncertain: integer(
          classified.uncertain,
          `${name}.stratum.humanClassified.uncertain`,
        ),
      },
    },
    rollbackConditions,
  };
}

export function parsePromotionInput(
  value: unknown,
): TestIntegrityPromotionInput {
  const item = record(value, "promotion input");
  exact(
    item,
    [
      "schemaVersion",
      "taskId",
      "policyHash",
      "schemaBindings",
      "signals",
      "approval",
    ],
    "promotion input",
  );
  if (item.schemaVersion !== TEST_INTEGRITY_PROMOTION_INPUT_SCHEMA)
    fail("Unsupported promotion input schema");
  const bindings = record(item.schemaBindings, "schemaBindings");
  exact(
    bindings,
    ["event", "classification", "promotion", "replay"],
    "schemaBindings",
  );
  for (const [key, expected] of Object.entries(CURRENT_SCHEMA_BINDINGS))
    if (bindings[key] !== expected)
      fail(`schemaBindings.${key} is unsupported`);
  if (
    !Array.isArray(item.signals) ||
    item.signals.length === 0 ||
    item.signals.length > EVALUATED_SIGNALS.length
  )
    fail("signals must be a bounded non-empty array");
  const signals = item.signals.map(parsePromotionSignal);
  if (new Set(signals.map((signal) => signal.signalId)).size !== signals.length)
    fail("signals contains a duplicate logical signal id");
  const approval = record(item.approval, "approval");
  exact(
    approval,
    ["declaredBy", "declaration", "note", "identityAttested"],
    "approval",
  );
  if (
    approval.declaredBy !== "human" ||
    approval.declaration !== "approved-for-proposal" ||
    approval.identityAttested !== false
  )
    fail("approval must be an unattested human proposal declaration");
  return {
    schemaVersion: TEST_INTEGRITY_PROMOTION_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    policyHash: digest(item.policyHash, "policyHash"),
    schemaBindings: { ...CURRENT_SCHEMA_BINDINGS },
    signals,
    approval: {
      declaredBy: "human",
      declaration: "approved-for-proposal",
      note: textField(approval.note, "approval.note", 500),
      identityAttested: false,
    },
  };
}

function classifiedCount(signal: TestIntegrityPromotionSignal): number {
  const count = signal.stratum.humanClassified;
  return count.truePositive + count.falsePositive + count.uncertain;
}

export function promotionCriterionFailures(
  signal: TestIntegrityPromotionSignal,
): string[] {
  const criterion = PROMOTION_CRITERIA[signal.requestedEffect];
  const classified = classifiedCount(signal);
  const decisive =
    signal.stratum.humanClassified.truePositive +
    signal.stratum.humanClassified.falsePositive;
  const fdp =
    decisive === 0
      ? 1
      : signal.stratum.humanClassified.falsePositive / decisive;
  const failures: string[] = [];
  if (signal.stratum.evaluated < criterion.minimumEvaluated)
    failures.push("INSUFFICIENT_EVALUATED");
  if (classified < criterion.minimumHumanClassifiedFired)
    failures.push("INSUFFICIENT_CLASSIFIED_FIRED");
  if (fdp > criterion.maximumFalseDiscoveryProportion)
    failures.push("FALSE_DISCOVERY_PROPORTION_EXCEEDED");
  if (signal.stratum.fired < classified)
    failures.push("CLASSIFIED_EXCEEDS_FIRED");
  return failures;
}

async function loadBoundReference(
  root: string,
  ref: { path: string; digest: string },
): Promise<unknown> {
  const file = path.resolve(root, ref.path);
  await assertContainedPath(root, file);
  const raw = await readFile(file, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    fail(`malformed evidence: ${ref.path}`, true);
  }
  if (hash(value) !== ref.digest)
    fail(`evidence digest mismatch: ${ref.path}`, true);
  return value!;
}

function evaluationFor(
  event: TestIntegrityEvent,
  signalId: TestIntegritySignalId,
) {
  return event.evaluationManifest?.find((entry) => entry.signalId === signalId);
}

export async function validatePromotionEvidence(
  input: TestIntegrityPromotionInput,
  evidenceRoot: string,
  options: { allowSynthetic?: boolean; requireCriteria?: boolean } = {},
): Promise<void> {
  const logicalEventIds = new Map<string, string>();
  const logicalClassificationIds = new Map<string, string>();
  for (const signal of input.signals) {
    let evaluated = 0;
    let fired = 0;
    const eventIds = new Set<string>();
    const classificationIds = new Set<string>();
    const verdicts = { truePositive: 0, falsePositive: 0, uncertain: 0 };
    const verdictByOccurrence = new Map<string, string>();
    for (const ref of signal.evidence.events) {
      const raw = await loadBoundReference(evidenceRoot, ref);
      const event = parseTestIntegrityEvent(raw);
      const previousDigest = logicalEventIds.get(event.artifactId);
      if (
        eventIds.has(event.artifactId) ||
        (previousDigest !== undefined && previousDigest !== ref.digest)
      )
        fail(`duplicate event logical id: ${event.artifactId}`, true);
      logicalEventIds.set(event.artifactId, ref.digest);
      if (
        event.provenance === "synthetic-test-fixture" &&
        !options.allowSynthetic
      )
        fail("synthetic-provenance evidence is promotion-ineligible", true);
      if (
        event.provenance !== "recorded" &&
        event.provenance !== "synthetic-test-fixture"
      )
        fail("unversioned legacy evidence is promotion-ineligible", true);
      const manifest = evaluationFor(event, signal.signalId);
      if (!manifest) fail("event lacks a per-signal evaluation manifest", true);
      if (
        event.evaluationManifest!.filter(
          (entry) => entry.signalId === signal.signalId,
        ).length !== 1
      )
        fail("duplicate per-signal evaluation manifest identity", true);
      if (
        event.signals.some(
          (entry) =>
            entry === null ||
            typeof entry !== "object" ||
            !EVALUATED_SIGNALS.includes(entry.signalId),
        )
      )
        fail("malformed signal occurrence", true);
      if (
        event.signals.filter((entry) => entry.signalId === signal.signalId)
          .length > 1
      )
        fail("duplicate signal occurrence identity", true);
      if (
        manifest.detector.name !== signal.detector.name ||
        manifest.detector.version !== signal.detector.version ||
        manifest.candidateSetVersion !== signal.evaluatedCandidateSet.version ||
        manifest.configurationDigest !==
          signal.evaluatedCandidateSet.configurationDigest
      )
        fail("detector-version or candidate-set stratum mismatch", true);
      evaluated += 1;
      eventIds.add(event.artifactId);
      if (event.signals.some((entry) => entry.signalId === signal.signalId))
        fired += 1;
    }
    for (const ref of signal.evidence.classifications) {
      const raw = record(
        await loadBoundReference(evidenceRoot, ref),
        "classification evidence",
      );
      if (raw.schemaVersion !== TEST_INTEGRITY_CLASSIFICATION_SCHEMA)
        fail("classification schema mismatch", true);
      const classification = raw as unknown as TestIntegrityClassification;
      if (
        typeof classification.artifactId !== "string" ||
        !Array.isArray(classification.verdicts) ||
        classification.classifiedBy !== "human"
      )
        fail("malformed classification evidence", true);
      const previousDigest = logicalClassificationIds.get(
        classification.artifactId,
      );
      if (
        classificationIds.has(classification.artifactId) ||
        (previousDigest !== undefined && previousDigest !== ref.digest)
      )
        fail(
          `duplicate classification logical id: ${classification.artifactId}`,
          true,
        );
      classificationIds.add(classification.artifactId);
      logicalClassificationIds.set(classification.artifactId, ref.digest);
      if (!eventIds.has(classification.eventArtifactId))
        fail("classification is not linked to a cited event", true);
      for (const verdict of classification.verdicts.filter(
        (entry) => entry.signalId === signal.signalId,
      )) {
        const key = `${classification.eventArtifactId}|${signal.signalId}`;
        const previous = verdictByOccurrence.get(key);
        if (previous !== undefined)
          fail(
            previous === verdict.verdict
              ? "duplicate classification logical occurrence"
              : "contradictory classifications",
            true,
          );
        verdictByOccurrence.set(key, verdict.verdict);
        if (verdict.verdict === "true-positive") verdicts.truePositive += 1;
        else if (verdict.verdict === "false-positive")
          verdicts.falsePositive += 1;
        else verdicts.uncertain += 1;
      }
    }
    const actual = { evaluated, fired, humanClassified: verdicts };
    if (hash(actual) !== hash(signal.stratum))
      fail(
        `declared stratum counts do not match cited evidence for ${signal.signalId}`,
        true,
      );
    const failures = promotionCriterionFailures(signal);
    if (options.requireCriteria !== false && failures.length > 0)
      fail(
        `promotion criteria not met for ${signal.signalId}: ${failures.join(",")}`,
        true,
      );
  }
}

function proposalCore(input: TestIntegrityPromotionInput): unknown {
  return {
    taskId: input.taskId,
    policyHash: input.policyHash,
    schemaBindings: input.schemaBindings,
    signals: input.signals,
    approval: input.approval,
    criteria: PROMOTION_CRITERIA,
    status: "proposed",
    approvalEffect: "none",
  };
}

export function parsePromotion(value: unknown): TestIntegrityPromotion {
  const item = record(value, "promotion proposal");
  exact(
    item,
    [
      "schemaVersion",
      "artifactId",
      "createdAt",
      "taskId",
      "policyHash",
      "schemaBindings",
      "signals",
      "approval",
      "proposalDigest",
      "criteria",
      "status",
      "approvalEffect",
    ],
    "promotion proposal",
  );
  if (
    item.schemaVersion !== TEST_INTEGRITY_PROMOTION_SCHEMA ||
    item.status !== "proposed" ||
    item.approvalEffect !== "none"
  )
    fail("Unsupported or non-inert promotion proposal");
  const parsedInput = parsePromotionInput({
    schemaVersion: TEST_INTEGRITY_PROMOTION_INPUT_SCHEMA,
    taskId: item.taskId,
    policyHash: item.policyHash,
    schemaBindings: item.schemaBindings,
    signals: item.signals,
    approval: item.approval,
  });
  const proposalDigest = digest(item.proposalDigest, "proposalDigest");
  if (proposalDigest !== hash(proposalCore(parsedInput)))
    fail("proposalDigest does not match canonical proposal content", true);
  if (hash(item.criteria) !== hash(PROMOTION_CRITERIA))
    fail("proposal criteria do not match the built-in governance floors", true);
  return {
    ...parsedInput,
    schemaVersion: TEST_INTEGRITY_PROMOTION_SCHEMA,
    artifactId: textField(item.artifactId, "artifactId", 128),
    createdAt: textField(item.createdAt, "createdAt", 40),
    proposalDigest,
    criteria: PROMOTION_CRITERIA,
    status: "proposed",
    approvalEffect: "none",
  };
}

export async function createPromotionProposal(
  input: TestIntegrityPromotionInput,
  evidenceRoot: string,
  now = new Date(),
  options: { allowSynthetic?: boolean } = {},
): Promise<TestIntegrityPromotion> {
  await validatePromotionEvidence(input, evidenceRoot, {
    ...options,
    requireCriteria: true,
  });
  return {
    artifactId: artifactId("test-integrity-promotion"),
    createdAt: now.toISOString(),
    ...input,
    schemaVersion: TEST_INTEGRITY_PROMOTION_SCHEMA,
    proposalDigest: hash(proposalCore(input)),
    criteria: PROMOTION_CRITERIA,
    status: "proposed",
    approvalEffect: "none",
  };
}

async function jsonFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) found.push(full);
    }
  }
  await walk(root);
  return found.sort();
}

export async function buildPromotionReplay(
  proposal: TestIntegrityPromotion,
  evidenceRoot: string,
  now = new Date(),
): Promise<TestIntegrityReplayReport> {
  const events: TestIntegrityEvent[] = [];
  const sourceDigests: Array<{ path: string; digest: string }> = [];
  for (const file of await jsonFiles(evidenceRoot)) {
    let raw: unknown;
    try {
      raw = await readJson(file);
    } catch {
      continue;
    }
    const item = record(raw, "evidence");
    if (item.schemaVersion !== TEST_INTEGRITY_EVENT_SCHEMA) continue;
    const event = parseTestIntegrityEvent(item);
    if (!event.evaluationManifest) continue;
    events.push(event);
    sourceDigests.push({
      path: path.relative(evidenceRoot, file),
      digest: hash(raw),
    });
  }
  const signals = proposal.signals.map((signal) => {
    const matching = events.filter((event) => {
      const manifest = evaluationFor(event, signal.signalId);
      return (
        manifest?.detector.name === signal.detector.name &&
        manifest.detector.version === signal.detector.version &&
        manifest.candidateSetVersion === signal.evaluatedCandidateSet.version &&
        manifest.configurationDigest ===
          signal.evaluatedCandidateSet.configurationDigest
      );
    });
    const fired = matching.filter((event) =>
      event.signals.some((entry) => entry.signalId === signal.signalId),
    ).length;
    return {
      signalId: signal.signalId,
      requestedEffect: signal.requestedEffect,
      detector: signal.detector,
      candidateSetVersion: signal.evaluatedCandidateSet.version,
      evaluated: matching.length,
      fired,
      wouldFire: fired,
    };
  });
  const core = {
    taskId: proposal.taskId,
    proposalArtifactId: proposal.artifactId,
    proposalDigest: proposal.proposalDigest,
    evidenceRootDigest: hash(sourceDigests),
    signals,
  };
  return {
    schemaVersion: TEST_INTEGRITY_REPLAY_SCHEMA,
    artifactId: artifactId("test-integrity-replay"),
    createdAt: now.toISOString(),
    ...core,
    replayDigest: hash(core),
  };
}

export interface ActiveRegistry {
  schemaVersion: "rigor.test-integrity-active.v1";
  entries: Array<{
    signalId: TestIntegritySignalId;
    proposalDigest: string;
    replayDigest: string;
    disposition: "active" | "tombstone";
    rollbackTriggered: boolean;
  }>;
}

export type ActivationReasonCode =
  | "MALFORMED_REGISTRY"
  | "DUPLICATE_LOGICAL_ID"
  | "MISSING_PROPOSAL"
  | "EVIDENCE_BELOW_CRITERIA"
  | "DETECTOR_VERSION_MISMATCH"
  | "CANDIDATE_SET_MISMATCH"
  | "POLICY_BINDING_MISMATCH"
  | "SCHEMA_BINDING_MISMATCH"
  | "MISSING_OR_UNLINKED_REPLAY"
  | "TOMBSTONED";

export interface ActivationResult {
  signalId: TestIntegritySignalId | null;
  state: "active" | "refused" | "frozen(requires-review)";
  reasonCode: ActivationReasonCode | "ROLLBACK_CONDITION_MET" | null;
  effect: TestIntegrityEffect | null;
  proposalDigest: string | null;
}

export interface CurrentDetector {
  name: string;
  version: string;
  candidateSetVersion: string;
  configurationDigest: string;
}

export const CURRENT_DETECTORS: Readonly<
  Record<TestIntegritySignalId, CurrentDetector>
> = Object.freeze(
  Object.fromEntries(
    EVALUATED_SIGNALS.map((signalId) => [
      signalId,
      {
        name:
          signalId === "TI-05"
            ? "diff-token-scan"
            : signalId === "TI-06"
              ? "diff-name-status"
              : signalId === "TI-07"
                ? "diff-token-scan"
                : signalId === "TI-08"
                  ? "diff-path-scan"
                  : "config-diff-scan",
        version: DETECTOR_VERSION,
        candidateSetVersion: CANDIDATE_SET_VERSION,
        configurationDigest: DETECTOR_CONFIGURATION_DIGEST,
      },
    ]),
  ) as Record<TestIntegritySignalId, CurrentDetector>,
);

export function evaluateActivation(
  registryValue: unknown,
  proposals: readonly TestIntegrityPromotion[],
  replays: readonly TestIntegrityReplayReport[],
  current: Readonly<Record<TestIntegritySignalId, CurrentDetector>>,
  policyHash: string,
  schemaBindings: typeof CURRENT_SCHEMA_BINDINGS = CURRENT_SCHEMA_BINDINGS,
): ActivationResult[] {
  if (registryValue === null || registryValue === undefined) return [];
  let registry: ActiveRegistry;
  try {
    const item = record(registryValue, "active registry");
    if (
      item.schemaVersion !== "rigor.test-integrity-active.v1" ||
      !Array.isArray(item.entries)
    )
      throw new Error();
    registry = item as unknown as ActiveRegistry;
  } catch {
    return [
      {
        signalId: null,
        state: "refused",
        reasonCode: "MALFORMED_REGISTRY",
        effect: null,
        proposalDigest: null,
      },
    ];
  }
  const seen = new Set<string>();
  return registry.entries.map((entry): ActivationResult => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !EVALUATED_SIGNALS.includes(entry.signalId) ||
      !HEX64.test(entry.proposalDigest ?? "") ||
      !HEX64.test(entry.replayDigest ?? "") ||
      (entry.disposition !== "active" && entry.disposition !== "tombstone") ||
      typeof entry.rollbackTriggered !== "boolean"
    )
      return {
        signalId: null,
        state: "refused",
        reasonCode: "MALFORMED_REGISTRY",
        effect: null,
        proposalDigest: null,
      };
    if (seen.has(entry.signalId))
      return {
        signalId: entry.signalId,
        state: "refused",
        reasonCode: "DUPLICATE_LOGICAL_ID",
        effect: null,
        proposalDigest: entry.proposalDigest,
      };
    seen.add(entry.signalId);
    if (entry.disposition === "tombstone")
      return {
        signalId: entry.signalId,
        state: "refused",
        reasonCode: "TOMBSTONED",
        effect: null,
        proposalDigest: entry.proposalDigest,
      };
    let proposal: TestIntegrityPromotion | undefined;
    try {
      const rawProposal = proposals.find(
        (candidate) => candidate?.proposalDigest === entry.proposalDigest,
      );
      proposal =
        rawProposal === undefined ? undefined : parsePromotion(rawProposal);
    } catch {
      return {
        signalId: entry.signalId,
        state: "refused",
        reasonCode: "MISSING_PROPOSAL",
        effect: null,
        proposalDigest: entry.proposalDigest,
      };
    }
    if (!proposal)
      return {
        signalId: entry.signalId,
        state: "refused",
        reasonCode: "MISSING_PROPOSAL",
        effect: null,
        proposalDigest: entry.proposalDigest,
      };
    const signal = proposal.signals.find(
      (candidate) => candidate.signalId === entry.signalId,
    );
    if (!signal || promotionCriterionFailures(signal).length > 0)
      return {
        signalId: entry.signalId,
        state: "refused",
        reasonCode: "EVIDENCE_BELOW_CRITERIA",
        effect: signal?.requestedEffect ?? null,
        proposalDigest: entry.proposalDigest,
      };
    if (proposal.policyHash !== policyHash)
      return {
        signalId: entry.signalId,
        state: "refused",
        reasonCode: "POLICY_BINDING_MISMATCH",
        effect: signal.requestedEffect,
        proposalDigest: entry.proposalDigest,
      };
    if (hash(proposal.schemaBindings) !== hash(schemaBindings))
      return {
        signalId: entry.signalId,
        state: "refused",
        reasonCode: "SCHEMA_BINDING_MISMATCH",
        effect: signal.requestedEffect,
        proposalDigest: entry.proposalDigest,
      };
    const detector = current[entry.signalId];
    if (
      !detector ||
      detector.name !== signal.detector.name ||
      detector.version !== signal.detector.version
    )
      return {
        signalId: entry.signalId,
        state: "refused",
        reasonCode: "DETECTOR_VERSION_MISMATCH",
        effect: signal.requestedEffect,
        proposalDigest: entry.proposalDigest,
      };
    if (
      detector.candidateSetVersion !== signal.evaluatedCandidateSet.version ||
      detector.configurationDigest !==
        signal.evaluatedCandidateSet.configurationDigest
    )
      return {
        signalId: entry.signalId,
        state: "refused",
        reasonCode: "CANDIDATE_SET_MISMATCH",
        effect: signal.requestedEffect,
        proposalDigest: entry.proposalDigest,
      };
    const replay = replays.find(
      (candidate) =>
        candidate?.replayDigest === entry.replayDigest &&
        candidate.proposalDigest === proposal.proposalDigest &&
        candidate.proposalArtifactId === proposal.artifactId,
    );
    const replayCore = replay && {
      taskId: replay.taskId,
      proposalArtifactId: replay.proposalArtifactId,
      proposalDigest: replay.proposalDigest,
      evidenceRootDigest: replay.evidenceRootDigest,
      signals: replay.signals,
    };
    if (
      !replay ||
      replay.schemaVersion !== TEST_INTEGRITY_REPLAY_SCHEMA ||
      replay.replayDigest !== hash(replayCore)
    )
      return {
        signalId: entry.signalId,
        state: "refused",
        reasonCode: "MISSING_OR_UNLINKED_REPLAY",
        effect: signal.requestedEffect,
        proposalDigest: entry.proposalDigest,
      };
    if (entry.rollbackTriggered)
      return {
        signalId: entry.signalId,
        state: "frozen(requires-review)",
        reasonCode: "ROLLBACK_CONDITION_MET",
        effect: signal.requestedEffect,
        proposalDigest: entry.proposalDigest,
      };
    return {
      signalId: entry.signalId,
      state: "active",
      reasonCode: null,
      effect: signal.requestedEffect,
      proposalDigest: entry.proposalDigest,
    };
  });
}

export interface RecordedEnforcementOutcome {
  original: {
    digest: string;
    gate:
      | "immediate-stop"
      | "required-human-review"
      | "advisory-warning"
      | "none";
    occurrences: Array<{
      signalId: TestIntegritySignalId;
      occurrenceDigest: string;
      effect: TestIntegrityEffect;
      promotionDigest: string;
    }>;
  };
  effectiveGate:
    | "immediate-stop"
    | "required-human-review"
    | "advisory-warning"
    | "none"
    | "recorded-and-waived";
  waiver: TestIntegrityWaiver | null;
}

export function enforcePromotedSignals(
  event: TestIntegrityEvent,
  activations: readonly ActivationResult[],
): RecordedEnforcementOutcome {
  const occurrences = event.signals.flatMap((signal) =>
    activations
      .filter(
        (activation) =>
          activation.state === "active" &&
          activation.signalId === signal.signalId &&
          activation.effect !== null &&
          activation.proposalDigest !== null,
      )
      .map((activation) => ({
        signalId: signal.signalId,
        occurrenceDigest: hash({
          eventArtifactId: event.artifactId,
          signalId: signal.signalId,
          matchDigest: signal.matchDigest,
        }),
        effect: activation.effect!,
        promotionDigest: activation.proposalDigest!,
      })),
  );
  const gate: RecordedEnforcementOutcome["original"]["gate"] = occurrences.some(
    (item) => item.effect === "stop",
  )
    ? "immediate-stop"
    : occurrences.some((item) => item.effect === "review")
      ? "required-human-review"
      : occurrences.some((item) => item.effect === "advisory")
        ? "advisory-warning"
        : "none";
  const core = { gate, occurrences };
  return {
    original: { ...core, digest: hash(core) },
    effectiveGate: gate,
    waiver: null,
  };
}

export function parseWaiverInput(value: unknown): TestIntegrityWaiverInput {
  const item = record(value, "waiver input");
  exact(
    item,
    [
      "schemaVersion",
      "taskId",
      "enforcementOutcomeDigest",
      "signalOccurrenceDigest",
      "promotionDigest",
      "headSha",
      "scope",
      "reason",
      "expiresAt",
      "declaredBy",
      "identityAttested",
      "externalReviewReference",
    ],
    "waiver input",
  );
  if (item.schemaVersion !== TEST_INTEGRITY_WAIVER_INPUT_SCHEMA)
    fail("Unsupported waiver input schema");
  if (item.declaredBy !== "human" || item.identityAttested !== false)
    fail("waiver must be an unattested human declaration");
  const headSha = textField(item.headSha, "headSha", 40);
  if (!HEX40.test(headSha)) fail("headSha must be a full commit sha");
  const expiresAt = textField(item.expiresAt, "expiresAt", 40);
  if (!Number.isFinite(Date.parse(expiresAt)))
    fail("expiresAt must be an ISO date-time");
  return {
    schemaVersion: TEST_INTEGRITY_WAIVER_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    enforcementOutcomeDigest: digest(
      item.enforcementOutcomeDigest,
      "enforcementOutcomeDigest",
    ),
    signalOccurrenceDigest: digest(
      item.signalOccurrenceDigest,
      "signalOccurrenceDigest",
    ),
    promotionDigest: digest(item.promotionDigest, "promotionDigest"),
    headSha,
    scope: textField(item.scope, "scope", 300),
    reason: textField(item.reason, "reason", 500),
    expiresAt,
    declaredBy: "human",
    identityAttested: false,
    externalReviewReference: textField(
      item.externalReviewReference,
      "externalReviewReference",
      300,
    ),
  };
}

export function createWaiver(
  input: TestIntegrityWaiverInput,
  now = new Date(),
): TestIntegrityWaiver {
  if (Date.parse(input.expiresAt) <= now.getTime())
    fail("waiver is already expired", true);
  return {
    ...input,
    schemaVersion: TEST_INTEGRITY_WAIVER_SCHEMA,
    artifactId: artifactId("test-integrity-waiver"),
    createdAt: now.toISOString(),
    status: "recorded-and-waived",
    approvalEffect: "single-outcome-downgrade",
  };
}

export function applyWaiver(
  outcome: RecordedEnforcementOutcome,
  waiver: TestIntegrityWaiver,
): RecordedEnforcementOutcome {
  const occurrence = outcome.original.occurrences.find(
    (item) =>
      item.occurrenceDigest === waiver.signalOccurrenceDigest &&
      item.promotionDigest === waiver.promotionDigest,
  );
  if (
    outcome.original.digest !== waiver.enforcementOutcomeDigest ||
    !occurrence
  )
    fail("waiver is not bound to this enforcement outcome", true);
  return {
    original: outcome.original,
    effectiveGate: "recorded-and-waived",
    waiver,
  };
}

export const ANTI_BYPASS_PATHS = [
  ACTIVE_REGISTRY_PATH,
  "src/ci.ts",
  "src/cli.ts",
  "src/test-integrity.ts",
  "src/test-integrity-promotion.ts",
  "src/types.ts",
  "schemas/test-integrity-",
  "dist/rigor.cjs",
  ".rigor/rigor-ci.cjs",
] as const;

export function antiBypassOutcome(
  changedPaths: readonly string[],
): "required-human-review" | null {
  return changedPaths.some((changed) =>
    ANTI_BYPASS_PATHS.some((subject) =>
      subject.endsWith("-") ? changed.startsWith(subject) : changed === subject,
    ),
  )
    ? "required-human-review"
    : null;
}
