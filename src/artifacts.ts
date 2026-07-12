import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { EXIT, RigorError } from "./errors.js";
import { matches } from "./paths.js";
import { run, treeHash } from "./git.js";
import { deriveCheckFacts, verificationFingerprint } from "./fingerprint.js";
import { parsePolicy } from "./schema.js";
import {
  artifactId,
  hash,
  readJson,
  record,
  strings,
  taskId,
  textField,
  writeJson,
} from "./util.js";
import {
  CONTRACT_SCHEMA,
  CONTRACT_INPUT_SCHEMA,
  ESCALATION_SCHEMA,
  ESCALATION_INPUT_SCHEMA,
  OUTCOME_SCHEMA,
  PREFLIGHT_SCHEMA,
  REVIEW_SCHEMA,
  TEST_INTEGRITY_CLASSIFICATION_SCHEMA,
  TEST_INTEGRITY_EVENT_SCHEMA,
  TEST_INTEGRITY_PROMOTION_SCHEMA,
  TEST_INTEGRITY_REPLAY_SCHEMA,
  TEST_INTEGRITY_WAIVER_SCHEMA,
  VERIFY_SCHEMA,
  type CheckFacts,
  type Contract,
  type ContractInput,
  type EscalationInput,
  type Policy,
  type Preflight,
  type TestIntegritySignalId,
  type Verification,
} from "./types.js";

export function parsePreflight(value: unknown): Preflight {
  const item = record(value, "preflight");
  if (item.schemaVersion !== PREFLIGHT_SCHEMA)
    throw new RigorError("Unsupported preflight schema", EXIT.inputError);
  return item as unknown as Preflight;
}

export function parseContract(value: unknown): Contract {
  const item = record(value, "contract");
  if (item.schemaVersion !== CONTRACT_SCHEMA)
    throw new RigorError("Unsupported contract schema", EXIT.inputError);
  taskId(item.taskId);
  strings(item.acceptanceCriteria, "acceptanceCriteria");
  strings(item.allowedPaths, "allowedPaths");
  return item as unknown as Contract;
}

export function parseVerification(value: unknown): Verification {
  const item = record(value, "verification");
  if (item.schemaVersion !== VERIFY_SCHEMA)
    throw new RigorError("Unsupported verification schema", EXIT.inputError);
  taskId(item.taskId);
  textField(item.artifactId, "verification.artifactId", 128);
  textField(item.contractArtifactId, "verification.contractArtifactId", 128);
  strings(item.changedPaths, "verification.changedPaths");
  if (item.status !== "passed" && item.status !== "failed")
    throw new RigorError("Invalid verification status", EXIT.inputError);
  // failureFingerprint/failureFacts are additive; older verification.json
  // artifacts predate them and must still parse, so only validate shape when
  // the fields are present.
  if (item.failureFingerprint !== undefined && item.failureFingerprint !== null)
    textField(item.failureFingerprint, "verification.failureFingerprint", 128);
  if (item.failureFacts !== undefined && !Array.isArray(item.failureFacts))
    throw new RigorError(
      "verification.failureFacts must be an array",
      EXIT.inputError,
    );
  return item as unknown as Verification;
}

export function parseContractInput(value: unknown): ContractInput {
  const item = record(value, "contract input");
  if (item.schemaVersion !== CONTRACT_INPUT_SCHEMA)
    throw new RigorError("Unsupported contract input schema", EXIT.inputError);
  return {
    schemaVersion: CONTRACT_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    acceptanceCriteria: strings(item.acceptanceCriteria, "acceptanceCriteria"),
    allowedPaths: strings(item.allowedPaths, "allowedPaths"),
    constraints: strings(item.constraints, "constraints"),
  };
}

export function createContract(
  policy: Policy,
  preflight: Preflight,
  input: ContractInput,
  now = new Date(),
): Contract {
  if (input.taskId !== preflight.taskId)
    throw new RigorError(
      "Contract taskId does not match preflight",
      EXIT.inputError,
    );
  if (
    input.acceptanceCriteria.length === 0 ||
    input.allowedPaths.length === 0
  ) {
    throw new RigorError(
      "Contract needs acceptance criteria and allowed paths",
      EXIT.inputError,
    );
  }
  for (const planned of preflight.plannedPaths) {
    if (!matches(planned, input.allowedPaths))
      throw new RigorError(
        `Planned path is outside contract scope: ${planned}`,
        EXIT.policyViolation,
      );
  }
  return {
    schemaVersion: CONTRACT_SCHEMA,
    artifactId: artifactId("contract"),
    taskId: input.taskId,
    createdAt: now.toISOString(),
    preflightArtifactId: preflight.artifactId,
    preflightHash: hash(preflight),
    riskTier: preflight.riskTier,
    externalTransmission: preflight.externalTransmission,
    acceptanceCriteria: input.acceptanceCriteria,
    allowedPaths: input.allowedPaths,
    constraints: input.constraints,
    requiredChecks: policy.checks
      .filter((check) => check.tiers.includes(preflight.riskTier))
      .map((check) => check.id),
    stopConditions: preflight.stopConditions,
  };
}

export async function verify(
  root: string,
  policy: Policy,
  contract: Contract,
  changedPaths: string[],
  head: string | null,
  now = new Date(),
): Promise<Verification> {
  const scopeViolations = changedPaths.filter(
    (pathname) => !matches(pathname, contract.allowedPaths),
  );
  const checks = [];
  const failureFacts: CheckFacts[] = [];
  for (const check of policy.checks.filter((item) =>
    contract.requiredChecks.includes(item.id),
  )) {
    let result;
    try {
      result = await run(check.command, check.args, root, check.timeoutMs);
    } catch {
      // No process output is available; derive facts from a fixed,
      // non-secret placeholder so no raw command text is ever persisted.
      const facts = deriveCheckFacts({
        checkId: check.id,
        status: "error",
        exitCode: null,
        output: "spawn-error",
      });
      failureFacts.push(facts);
      checks.push({
        id: check.id,
        status: "error" as const,
        exitCode: null,
        durationMs: 0,
        outputDigest: hash("spawn-error"),
        ...(facts.failure === null ? {} : { failure: facts.failure }),
      });
      continue;
    }
    const combined = Buffer.concat([result.stdout, result.stderr]);
    const outputText = combined.toString("utf8");
    const status = result.timedOut
      ? ("timed_out" as const)
      : result.code === 0
        ? ("passed" as const)
        : ("failed" as const);
    const facts = deriveCheckFacts({
      checkId: check.id,
      status,
      exitCode: result.code,
      output: outputText,
    });
    failureFacts.push(facts);
    checks.push({
      id: check.id,
      status,
      exitCode: result.code,
      durationMs: result.durationMs,
      outputDigest: hash(outputText),
      ...(facts.testStats === null ? {} : { testStats: facts.testStats }),
      ...(facts.failure === null ? {} : { failure: facts.failure }),
    });
  }
  const passed =
    scopeViolations.length === 0 &&
    checks.every((check) => check.status === "passed");
  return {
    schemaVersion: VERIFY_SCHEMA,
    artifactId: artifactId("verification"),
    taskId: contract.taskId,
    contractArtifactId: contract.artifactId,
    createdAt: now.toISOString(),
    policyHash: hash(policy),
    head,
    treeHash: await treeHash(root, [".rigor/evidence/", ".rigor/events.jsonl"]),
    changedPaths,
    scopeViolations,
    checks,
    status: passed ? "passed" : "failed",
    failureFingerprint: verificationFingerprint(failureFacts),
    failureFacts,
  };
}

export function parseEscalationInput(value: unknown): EscalationInput {
  const item = record(value, "escalation input");
  if (item.schemaVersion !== ESCALATION_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported escalation input schema",
      EXIT.inputError,
    );
  if (!Array.isArray(item.attempts))
    throw new RigorError("attempts must be an array", EXIT.inputError);
  const attempts = item.attempts.map((raw, index) => {
    const attempt = record(raw, `attempts[${index}]`);
    return {
      action: textField(attempt.action, `attempts[${index}].action`),
      result: textField(attempt.result, `attempts[${index}].result`),
    };
  });
  const fingerprints = attempts.map(hash);
  if (new Set(fingerprints).size !== fingerprints.length)
    throw new RigorError(
      "Duplicate attempts must be consolidated",
      EXIT.policyViolation,
    );
  return {
    schemaVersion: ESCALATION_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    facts: strings(item.facts, "facts"),
    attempts,
    disprovedHypotheses: strings(
      item.disprovedHypotheses,
      "disprovedHypotheses",
    ),
    speculation: strings(item.speculation, "speculation"),
    requestedDecision: textField(item.requestedDecision, "requestedDecision"),
  };
}

export function createEscalation(
  input: EscalationInput,
  now = new Date(),
): unknown {
  return {
    schemaVersion: ESCALATION_SCHEMA,
    artifactId: artifactId("escalation"),
    createdAt: now.toISOString(),
    taskId: input.taskId,
    facts: input.facts,
    attempts: input.attempts,
    disprovedHypotheses: input.disprovedHypotheses,
    speculation: input.speculation,
    requestedDecision: input.requestedDecision,
  };
}

export function createReview(
  contract: Contract,
  preflight: Preflight,
  verification: Verification,
  now = new Date(),
): unknown {
  if (
    contract.taskId !== preflight.taskId ||
    verification.taskId !== contract.taskId
  )
    throw new RigorError(
      "Review artifacts have different task IDs",
      EXIT.inputError,
    );
  if (verification.contractArtifactId !== contract.artifactId)
    throw new RigorError(
      "Verification is not linked to this contract",
      EXIT.policyViolation,
    );
  return {
    schemaVersion: REVIEW_SCHEMA,
    artifactId: artifactId("review"),
    taskId: contract.taskId,
    createdAt: now.toISOString(),
    externalTransmission: preflight.externalTransmission,
    riskTier: preflight.riskTier,
    requireHumanApproval: preflight.requireHumanApproval,
    contractArtifactId: contract.artifactId,
    verificationArtifactId: verification.artifactId,
    changedPaths: verification.changedPaths,
    acceptanceCriteria: contract.acceptanceCriteria,
    verificationStatus: verification.status,
    note:
      preflight.externalTransmission === "denied"
        ? "Do not send this bundle or repository content to external services."
        : "Policy permits transmission; minimize content and re-check destination controls.",
  };
}

export async function saveArtifact(
  root: string,
  task: string,
  kind: string,
  value: unknown,
): Promise<string> {
  const directory = path.join(root, ".rigor", "evidence", task);
  const file = path.join(directory, `${kind}.json`);
  await writeJson(file, value);
  await appendEvent(root, {
    type: kind,
    taskId: task,
    artifactId: record(value, kind).artifactId,
    at: new Date().toISOString(),
  });
  return file;
}

export async function saveCollectionArtifact(
  root: string,
  task: string,
  collection: string,
  kind: string,
  value: unknown,
): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/u.test(collection))
    throw new RigorError("Invalid artifact collection", EXIT.inputError);
  const item = record(value, kind);
  const id = textField(item.artifactId, `${kind}.artifactId`, 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(id))
    throw new RigorError("Invalid artifact identifier", EXIT.inputError);
  const directory = path.join(root, ".rigor", "evidence", task, collection);
  const file = path.join(directory, `${id}.json`);
  await writeJson(file, value);
  await appendEvent(root, {
    type: kind,
    taskId: task,
    artifactId: id,
    at: new Date().toISOString(),
  });
  return file;
}

async function appendEvent(root: string, event: unknown): Promise<void> {
  const directory = path.join(root, ".rigor");
  await mkdir(directory, { recursive: true });
  await appendFile(
    path.join(directory, "events.jsonl"),
    `${JSON.stringify(event)}\n`,
    { mode: 0o600 },
  );
}

export async function retrospect(root: string): Promise<unknown> {
  let content = "";
  try {
    content = await readFile(path.join(root, ".rigor", "events.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const counts: Record<string, number> = {};
  const tasks = new Set<string>();
  for (const line of content.split("\n").filter(Boolean)) {
    try {
      const event = record(JSON.parse(line) as unknown, "event");
      const type = typeof event.type === "string" ? event.type : "invalid";
      counts[type] = (counts[type] ?? 0) + 1;
      if (typeof event.taskId === "string") tasks.add(event.taskId);
    } catch {
      counts.invalid = (counts.invalid ?? 0) + 1;
    }
  }
  const { outcomeTotals, candidates } = await aggregateOutcomes(root);
  const testIntegrity = await aggregateTestIntegrity(root);
  return {
    schemaVersion: "rigor.retrospective.v1",
    generatedAt: new Date().toISOString(),
    taskCount: tasks.size,
    eventCounts: counts,
    outcomeTotals,
    candidates,
    testIntegrity,
  };
}

const TEST_INTEGRITY_SIGNAL_IDS: readonly TestIntegritySignalId[] = [
  "TI-05",
  "TI-06",
  "TI-07",
  "TI-08",
  "TI-09",
];

interface SignalAccumulator {
  evaluated: number;
  fired: number;
  unreviewed: number;
  truePositive: number;
  falsePositive: number;
  uncertain: number;
}

interface ScannedEvent {
  firedSignals: Set<string>;
  evaluatedSignals: Set<string>;
  artifactId: string;
}

interface VerdictEntry {
  key: string;
  verdict: string;
  createdAt: string;
  artifactId: string;
}

/**
 * Aggregates append-on-create test-integrity shadow evidence into per-signal
 * denominators: how often each signal was evaluated (the scan denominator),
 * how often it fired, how many fired occurrences remain unreviewed, and the
 * human classification tally. Never throws on a malformed file; counts it,
 * exactly like malformedOutcomes. Purely advisory shadow evidence — it reflects
 * no verification, progress, review, or merge outcome.
 */
async function aggregateTestIntegrity(root: string): Promise<unknown> {
  const evidence = path.join(root, ".rigor", "evidence");
  let malformedEvents = 0;
  let malformedClassifications = 0;
  let classificationCount = 0;
  const events: ScannedEvent[] = [];
  const verdictEntries: VerdictEntry[] = [];
  let taskDirs: string[] = [];
  try {
    const entries = await readdir(evidence, { withFileTypes: true });
    taskDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const task of taskDirs) {
    const directory = path.join(evidence, task, "test-integrity");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.filter((file) => file.endsWith(".json"))) {
      const isClassification = name.startsWith("test-integrity-classification");
      let parsed: Record<string, unknown>;
      try {
        parsed = record(
          JSON.parse(
            await readFile(path.join(directory, name), "utf8"),
          ) as unknown,
          "test-integrity artifact",
        );
      } catch {
        if (isClassification) malformedClassifications += 1;
        else malformedEvents += 1;
        continue;
      }
      if (isClassification) {
        if (!collectClassification(parsed, verdictEntries))
          malformedClassifications += 1;
        else classificationCount += 1;
      } else if (
        parsed.schemaVersion === TEST_INTEGRITY_PROMOTION_SCHEMA ||
        parsed.schemaVersion === TEST_INTEGRITY_REPLAY_SCHEMA ||
        parsed.schemaVersion === TEST_INTEGRITY_WAIVER_SCHEMA
      ) {
        continue;
      } else if (!collectEvent(parsed, events)) {
        malformedEvents += 1;
      }
    }
  }
  const verdictMap = new Map<string, string>();
  for (const entry of [...verdictEntries].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.artifactId.localeCompare(b.artifactId)
      : a.createdAt.localeCompare(b.createdAt),
  ))
    verdictMap.set(entry.key, entry.verdict);

  const signals: Record<string, unknown> = {};
  for (const id of TEST_INTEGRITY_SIGNAL_IDS) {
    const acc: SignalAccumulator = {
      evaluated: 0,
      fired: 0,
      unreviewed: 0,
      truePositive: 0,
      falsePositive: 0,
      uncertain: 0,
    };
    for (const event of events) {
      if (event.evaluatedSignals.has(id)) acc.evaluated += 1;
      if (!event.firedSignals.has(id)) continue;
      acc.fired += 1;
      const verdict = verdictMap.get(`${event.artifactId}|${id}`);
      if (verdict === "true-positive") acc.truePositive += 1;
      else if (verdict === "false-positive") acc.falsePositive += 1;
      else if (verdict === "uncertain") acc.uncertain += 1;
      else acc.unreviewed += 1;
    }
    signals[id] = {
      evaluated: acc.evaluated,
      fired: acc.fired,
      unreviewed: acc.unreviewed,
      humanClassified: {
        truePositive: acc.truePositive,
        falsePositive: acc.falsePositive,
        uncertain: acc.uncertain,
      },
    };
  }
  return {
    events: events.length,
    classifications: classificationCount,
    malformedEvents,
    malformedClassifications,
    signals,
  };
}

function collectEvent(
  parsed: Record<string, unknown>,
  events: ScannedEvent[],
): boolean {
  if (parsed.schemaVersion !== TEST_INTEGRITY_EVENT_SCHEMA) return false;
  const artifactId = parsed.artifactId;
  if (typeof artifactId !== "string") return false;
  if (!Array.isArray(parsed.signals) || !Array.isArray(parsed.signalsEvaluated))
    return false;
  const firedSignals = new Set<string>();
  for (const signal of parsed.signals) {
    if (
      signal !== null &&
      typeof signal === "object" &&
      typeof (signal as Record<string, unknown>).signalId === "string"
    )
      firedSignals.add((signal as Record<string, unknown>).signalId as string);
  }
  const evaluatedSignals = new Set<string>();
  for (const id of parsed.signalsEvaluated)
    if (typeof id === "string") evaluatedSignals.add(id);
  events.push({ firedSignals, evaluatedSignals, artifactId });
  return true;
}

function collectClassification(
  parsed: Record<string, unknown>,
  verdictEntries: VerdictEntry[],
): boolean {
  if (parsed.schemaVersion !== TEST_INTEGRITY_CLASSIFICATION_SCHEMA)
    return false;
  const eventArtifactId = parsed.eventArtifactId;
  const artifactId = parsed.artifactId;
  const createdAt = parsed.createdAt;
  if (
    typeof eventArtifactId !== "string" ||
    typeof artifactId !== "string" ||
    typeof createdAt !== "string" ||
    !Array.isArray(parsed.verdicts)
  )
    return false;
  for (const verdict of parsed.verdicts) {
    if (verdict === null || typeof verdict !== "object") continue;
    const signalId = (verdict as Record<string, unknown>).signalId;
    const value = (verdict as Record<string, unknown>).verdict;
    if (typeof signalId !== "string" || typeof value !== "string") continue;
    verdictEntries.push({
      key: `${eventArtifactId}|${signalId}`,
      verdict: value,
      createdAt,
      artifactId,
    });
  }
  return true;
}

interface DataCompleteness {
  usageRecorded: number;
  usageUnavailable: number;
  usageUnknown: number;
  modelIdentityPresent: number;
  modelIdentityAbsent: number;
  providerCostPresent: number;
  elapsedPresent: number;
  elapsedMissing: number;
  attemptLinked: number;
  attemptUnlinked: number;
  verificationLinked: number;
}

interface OutcomeTotals {
  total: number;
  accepted: number;
  rejected: number;
  acceptedWithoutModelCodeChanges: number;
  reverted: number;
  escapedDefectSuspected: number;
  escapedDefectConfirmed: number;
  malformedOutcomes: number;
  dataCompleteness: DataCompleteness;
}

interface CandidateAccumulator {
  candidate: string;
  provider: string | null;
  model: string | null;
  capabilityClass: string | null;
  outcomes: number;
  accepted: number;
  retriesTotal: number;
  elapsedTotal: number;
  elapsedPresent: number;
  elapsedMissing: number;
  humanTotal: number;
  humanOutcomes: number;
  usageRecorded: number;
  usageUnavailable: number;
  usageUnknown: number;
  modelIdentityPresent: number;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

async function aggregateOutcomes(
  root: string,
): Promise<{ outcomeTotals: unknown; candidates: unknown[] }> {
  const evidence = path.join(root, ".rigor", "evidence");
  const totals: OutcomeTotals = {
    total: 0,
    accepted: 0,
    rejected: 0,
    acceptedWithoutModelCodeChanges: 0,
    reverted: 0,
    escapedDefectSuspected: 0,
    escapedDefectConfirmed: 0,
    malformedOutcomes: 0,
    dataCompleteness: {
      usageRecorded: 0,
      usageUnavailable: 0,
      usageUnknown: 0,
      modelIdentityPresent: 0,
      modelIdentityAbsent: 0,
      providerCostPresent: 0,
      elapsedPresent: 0,
      elapsedMissing: 0,
      attemptLinked: 0,
      attemptUnlinked: 0,
      verificationLinked: 0,
    },
  };
  const candidateMap = new Map<string, CandidateAccumulator>();
  let taskDirs: string[] = [];
  try {
    const entries = await readdir(evidence, { withFileTypes: true });
    taskDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const task of taskDirs) {
    let content: string;
    try {
      content = await readFile(
        path.join(evidence, task, "outcome.json"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      totals.malformedOutcomes += 1;
      continue;
    }
    try {
      const outcome = record(JSON.parse(content) as unknown, "outcome");
      if (outcome.schemaVersion !== OUTCOME_SCHEMA)
        throw new RigorError("unexpected outcome schema", EXIT.inputError);
      applyOutcome(totals, candidateMap, outcome);
    } catch {
      totals.malformedOutcomes += 1;
    }
  }
  const candidates = [...candidateMap.values()]
    .sort((a, b) => a.candidate.localeCompare(b.candidate))
    .map((entry) => ({
      candidate: entry.candidate,
      provider: entry.provider,
      model: entry.model,
      capabilityClass: entry.capabilityClass,
      outcomes: entry.outcomes,
      accepted: entry.accepted,
      successRate: { numerator: entry.accepted, denominator: entry.outcomes },
      retries: {
        total: entry.retriesTotal,
        perOutcome:
          entry.outcomes > 0 ? entry.retriesTotal / entry.outcomes : null,
      },
      elapsedMs: {
        total: entry.elapsedTotal,
        average:
          entry.elapsedPresent > 0
            ? entry.elapsedTotal / entry.elapsedPresent
            : null,
        present: entry.elapsedPresent,
        missing: entry.elapsedMissing,
      },
      humanInterventionMinutes: {
        total: entry.humanTotal,
        outcomesWithIntervention: entry.humanOutcomes,
      },
      dataCompleteness: {
        usageRecorded: entry.usageRecorded,
        usageUnavailable: entry.usageUnavailable,
        usageUnknown: entry.usageUnknown,
        modelIdentityPresent: entry.modelIdentityPresent,
      },
    }));
  return { outcomeTotals: totals, candidates };
}

function applyOutcome(
  totals: OutcomeTotals,
  candidateMap: Map<string, CandidateAccumulator>,
  outcome: Record<string, unknown>,
): void {
  const completeness = totals.dataCompleteness;
  totals.total += 1;
  const decision = outcome.decision;
  if (decision === "accepted") totals.accepted += 1;
  else if (decision === "rejected") totals.rejected += 1;
  if (outcome.acceptedWithoutModelCodeChanges === true)
    totals.acceptedWithoutModelCodeChanges += 1;
  if (outcome.revertStatus === "reverted") totals.reverted += 1;
  if (outcome.escapedDefectStatus === "suspected")
    totals.escapedDefectSuspected += 1;
  if (outcome.escapedDefectStatus === "confirmed")
    totals.escapedDefectConfirmed += 1;

  const usage =
    typeof outcome.usage === "object" && outcome.usage !== null
      ? (outcome.usage as Record<string, unknown>)
      : {};
  const usageStatus = usage.status;
  if (usageStatus === "recorded") completeness.usageRecorded += 1;
  else if (usageStatus === "unavailable") completeness.usageUnavailable += 1;
  else if (usageStatus === "unknown") completeness.usageUnknown += 1;
  const modelIdentityPresent =
    usage.modelIdentity !== null && usage.modelIdentity !== undefined;
  if (modelIdentityPresent) completeness.modelIdentityPresent += 1;
  else completeness.modelIdentityAbsent += 1;
  if (usage.providerCost !== null && usage.providerCost !== undefined)
    completeness.providerCostPresent += 1;

  const elapsed = optionalNumber(outcome.attemptDurationMs);
  if (elapsed !== undefined) completeness.elapsedPresent += 1;
  else completeness.elapsedMissing += 1;

  const attemptLinked = typeof outcome.attemptArtifactId === "string";
  if (attemptLinked) completeness.attemptLinked += 1;
  else completeness.attemptUnlinked += 1;
  if (typeof outcome.verificationArtifactId === "string")
    completeness.verificationLinked += 1;

  let candidate = "unlinked";
  let provider: string | null = null;
  let model: string | null = null;
  let capabilityClass: string | null = null;
  if (attemptLinked) {
    provider = optionalString(outcome.provider);
    model = optionalString(outcome.model);
    capabilityClass = optionalString(outcome.capabilityClass);
    candidate = model ?? `${provider}/${capabilityClass}`;
  }
  let entry = candidateMap.get(candidate);
  if (!entry) {
    entry = {
      candidate,
      provider,
      model,
      capabilityClass,
      outcomes: 0,
      accepted: 0,
      retriesTotal: 0,
      elapsedTotal: 0,
      elapsedPresent: 0,
      elapsedMissing: 0,
      humanTotal: 0,
      humanOutcomes: 0,
      usageRecorded: 0,
      usageUnavailable: 0,
      usageUnknown: 0,
      modelIdentityPresent: 0,
    };
    candidateMap.set(candidate, entry);
  }
  entry.outcomes += 1;
  if (decision === "accepted") entry.accepted += 1;
  entry.retriesTotal += optionalNumber(outcome.retryCount) ?? 0;
  if (elapsed !== undefined) {
    entry.elapsedTotal += elapsed;
    entry.elapsedPresent += 1;
  } else {
    entry.elapsedMissing += 1;
  }
  const human = optionalNumber(outcome.humanCorrectionMinutes) ?? 0;
  entry.humanTotal += human;
  if (human > 0) entry.humanOutcomes += 1;
  if (usageStatus === "recorded") entry.usageRecorded += 1;
  else if (usageStatus === "unavailable") entry.usageUnavailable += 1;
  else if (usageStatus === "unknown") entry.usageUnknown += 1;
  if (modelIdentityPresent) entry.modelIdentityPresent += 1;
}

export async function loadPolicy(root: string): Promise<Policy> {
  return parsePolicy(await readJson(path.join(root, ".rigor", "policy.json")));
}
