import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { EXIT, RigorError } from "./errors.js";
import {
  ATTEMPT_SCHEMA,
  CALIBRATION_PROPOSAL_INPUT_SCHEMA,
  CALIBRATION_PROPOSAL_SCHEMA,
  EVALUATION_MANIFEST_SCHEMA,
  EVALUATION_REPLAY_SCHEMA,
  EVALUATION_REPORT_SCHEMA,
  OUTCOME_SCHEMA,
  ROUTING_PLAN_SCHEMA,
  type CalibrationProposal,
  type CalibrationProposalInput,
  type CalibrationProposalProvenance,
  type CalibrationProposalTarget,
  type CapabilityClass,
  type EvaluationManifest,
  type EvaluationSplit,
  type EvaluationTask,
  type ModelProfiles,
} from "./types.js";
import {
  artifactId,
  assertContainedPath,
  hash,
  record,
  strings,
  taskId,
  textField,
} from "./util.js";

// ---------------------------------------------------------------------------
// Shared local validation helpers (dependency-free, fail-closed) following the
// hand-written style of src/routing.ts and src/outcome.ts.
// ---------------------------------------------------------------------------

const CAPABILITY_CLASSES: CapabilityClass[] = [
  "economy",
  "standard",
  "premium",
  "frontier",
];
const SPLITS: EvaluationSplit[] = ["calibration", "holdout"];
const PROPOSAL_TARGETS: CalibrationProposalTarget[] = [
  "model-profiles",
  "escalation-thresholds",
  "routing-heuristic-constant",
];

const OVER_ROUTING_DEFINITION =
  "Accepted on the first attempt (retryCount 0, escalationCount 0) with zero review findings at a capability class above economy, so a lower class may have sufficed. A reviewable heuristic count, not a verdict.";
const UNDER_ROUTING_DEFINITION =
  "An outcome at the routed capability class that was rejected, escalated (escalationCount > 0), or produced an expanded failure set. A reviewable heuristic count, not a verdict.";

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value as T;
}

function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new RigorError(`${name} is out of range`, EXIT.inputError);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// ---------------------------------------------------------------------------
// Strict field validation. An artifact whose schemaVersion matches is not
// trusted wholesale: every field the report actually consumes is validated for
// type, and a wrong-typed field makes the whole artifact malformed (counted,
// never guessed) rather than silently defaulting. Absent optional fields are
// legitimate and never malformed; only a present field of the wrong type is.
// ---------------------------------------------------------------------------

const USAGE_STATUSES = ["recorded", "unavailable", "unknown"];
const ESCAPED_STATUSES = ["none", "suspected", "confirmed"];
const PROGRESS_STATUSES = [
  "first",
  "unchanged",
  "reduced",
  "expanded",
  "incomparable",
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Optional-by-schema numeric field: absence is legitimate ("missing"); a
 * present wrong-typed value is not. */
function numericFieldOk(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

/** Schema-required numeric field (schemas/outcome.v1.schema.json `required`):
 * absence is itself a schema violation, exactly like a wrong type, so it can
 * never silently default at aggregation time. */
function requiredNumericFieldOk(value: unknown): boolean {
  return isFiniteNumber(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The outcome schema requires the `usage.modelIdentity`/`usage.providerCost`
 * keys but allows a `null` value (`oneOf [null, object]`): both an absent key
 * and an explicit `null` read as "not present" for reporting. Only a present
 * value that mismatches the schema's own object shape is malformed — a wrong
 * type must never be counted as if it were present data.
 */
function nullableRecordOk(
  value: unknown,
  shapeOk: (value: Record<string, unknown>) => boolean,
): boolean {
  return (
    value === undefined || value === null || (isRecord(value) && shapeOk(value))
  );
}

function isModelIdentityShape(value: Record<string, unknown>): boolean {
  return typeof value.value === "string" && value.attestation === "unverified";
}

function isProviderCostShape(value: Record<string, unknown>): boolean {
  return (
    typeof value.currency === "string" &&
    /^[A-Z]{3}$/u.test(value.currency) &&
    isFiniteNumber(value.amount) &&
    value.amount >= 0
  );
}

/**
 * True when every outcome field the report consumes is well-typed. Every
 * field the outcome schema (schemas/outcome.v1.schema.json) requires is
 * validated for presence, not merely type: an absent required field is
 * exactly as malformed as a wrong-typed one, so it can never silently default
 * at `deriveOutcomeData`. Fields the schema leaves optional remain
 * legitimately absent; only a present-but-wrong-typed value makes them
 * malformed.
 */
function outcomeFieldsWellFormed(o: Record<string, unknown>): boolean {
  if (o.decision !== "accepted" && o.decision !== "rejected") return false;
  // Required, non-nullable integers: absence is a schema violation, not a
  // legitimate zero.
  if (
    !requiredNumericFieldOk(o.retryCount) ||
    !requiredNumericFieldOk(o.escalationCount) ||
    !requiredNumericFieldOk(o.humanCorrectionMinutes)
  )
    return false;
  // Optional-by-schema: absence remains legitimately "missing".
  if (!numericFieldOk(o.attemptDurationMs)) return false;
  // Optional-by-schema strings: absence is legitimate; a present non-string
  // (including an explicit null, which the schema does not allow either) is
  // malformed rather than silently coerced to null.
  if (o.provider !== undefined && typeof o.provider !== "string") return false;
  if (o.model !== undefined && typeof o.model !== "string") return false;
  if (
    o.capabilityClass !== undefined &&
    o.capabilityClass !== null &&
    !(
      typeof o.capabilityClass === "string" &&
      (CAPABILITY_CLASSES as string[]).includes(o.capabilityClass)
    )
  )
    return false;
  // reviewFindings is required, and its nested `total` is required too.
  if (
    !isRecord(o.reviewFindings) ||
    !requiredNumericFieldOk(o.reviewFindings.total)
  )
    return false;
  // usage is required, and its nested `status` is required and enumerated.
  if (!isRecord(o.usage)) return false;
  if (
    typeof o.usage.status !== "string" ||
    !USAGE_STATUSES.includes(o.usage.status)
  )
    return false;
  if (!nullableRecordOk(o.usage.modelIdentity, isModelIdentityShape))
    return false;
  if (!nullableRecordOk(o.usage.providerCost, isProviderCostShape))
    return false;
  // escapedDefectStatus is required and enumerated; unlike modelIdentity or
  // providerCost, the schema gives it no null option.
  if (
    typeof o.escapedDefectStatus !== "string" ||
    !ESCAPED_STATUSES.includes(o.escapedDefectStatus)
  )
    return false;
  return true;
}

/** True when every attempt field the report consumes is well-typed. */
function attemptFieldsWellFormed(a: Record<string, unknown>): boolean {
  // routingPlanArtifactId is required by schemas/attempt.v1.schema.json: an
  // attempt that omits it can never be joined to the routing plan that priced
  // it, so it is malformed, not merely "unlinked".
  if (typeof a.routingPlanArtifactId !== "string") return false;
  if (a.progress !== undefined && a.progress !== null) {
    if (!isRecord(a.progress)) return false;
    if (
      a.progress.status !== undefined &&
      !PROGRESS_STATUSES.includes(a.progress.status as string)
    )
      return false;
  }
  return true;
}

/** True when every routing-plan field the report consumes is well-typed. */
function planFieldsWellFormed(p: Record<string, unknown>): boolean {
  // artifactId is required by schemas/routing-plan.v1.schema.json: a plan
  // that omits it can never be the target of an attempt's
  // routingPlanArtifactId link, so it is malformed.
  if (typeof p.artifactId !== "string") return false;
  if (p.selection !== undefined && p.selection !== null) {
    if (!isRecord(p.selection)) return false;
    // A present-but-non-numeric relativeCost is malformed; an absent one is a
    // legitimate "unknown" counted by relativeCostUnknownAttempts.
    if (
      p.selection.relativeCost !== undefined &&
      !(
        typeof p.selection.relativeCost === "number" &&
        Number.isFinite(p.selection.relativeCost)
      )
    )
      return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Manifest parsing.
// ---------------------------------------------------------------------------

export function parseEvaluationManifest(value: unknown): EvaluationManifest {
  const item = record(value, "evaluation manifest");
  if (item.schemaVersion !== EVALUATION_MANIFEST_SCHEMA)
    throw new RigorError(
      "Unsupported evaluation manifest schema",
      EXIT.inputError,
    );
  const categories = strings(item.categories, "categories", 32);
  if (categories.length === 0)
    throw new RigorError("categories must not be empty", EXIT.inputError);
  if (new Set(categories).size !== categories.length)
    throw new RigorError("categories must be unique", EXIT.inputError);
  if (!Array.isArray(item.tasks) || item.tasks.length === 0)
    throw new RigorError("tasks must be a non-empty array", EXIT.inputError);
  if (item.tasks.length > 100)
    throw new RigorError("tasks must not exceed 100 entries", EXIT.inputError);
  const categorySet = new Set(categories);
  const seen = new Set<string>();
  const tasks: EvaluationTask[] = item.tasks.map((raw, index) => {
    const entry = record(raw, `tasks[${index}]`);
    const id = taskId(entry.taskId);
    if (seen.has(id))
      throw new RigorError(
        `Duplicate task id in manifest: ${id}`,
        EXIT.inputError,
      );
    seen.add(id);
    const category = textField(entry.category, `tasks[${index}].category`, 128);
    if (!categorySet.has(category))
      throw new RigorError(
        `tasks[${index}].category is not declared in categories`,
        EXIT.inputError,
      );
    const task: EvaluationTask = {
      taskId: id,
      category,
      split: oneOf(entry.split, SPLITS, `tasks[${index}].split`),
      source: textField(entry.source, `tasks[${index}].source`, 2000),
    };
    if (entry.fixtureRef !== undefined) {
      const ref = textField(
        entry.fixtureRef,
        `tasks[${index}].fixtureRef`,
        1024,
      );
      if (ref.startsWith("/") || ref.split(/[\\/]/u).includes(".."))
        throw new RigorError(
          `tasks[${index}].fixtureRef must be a repository-relative path`,
          EXIT.inputError,
        );
      task.fixtureRef = ref;
    }
    if (entry.crossModelComparison !== undefined) {
      if (typeof entry.crossModelComparison !== "boolean")
        throw new RigorError(
          `tasks[${index}].crossModelComparison must be boolean`,
          EXIT.inputError,
        );
      task.crossModelComparison = entry.crossModelComparison;
    }
    return task;
  });
  return {
    schemaVersion: EVALUATION_MANIFEST_SCHEMA,
    manifestVersion: integer(
      item.manifestVersion,
      "manifestVersion",
      1,
      100_000,
    ),
    createdAt: textField(item.createdAt, "createdAt", 128),
    owner: textField(item.owner, "owner", 256),
    reviewInterval: textField(item.reviewInterval, "reviewInterval", 256),
    categories,
    expansionPolicy: textField(item.expansionPolicy, "expansionPolicy", 4000),
    tasks,
  };
}

// ---------------------------------------------------------------------------
// Calibration proposal parsing and construction. The proposal is an inert
// artifact: it can never change routing, thresholds, or profiles, and any
// consumer must treat it as advice pending human review.
// ---------------------------------------------------------------------------

export function parseCalibrationProposalInput(
  value: unknown,
): CalibrationProposalInput {
  const item = record(value, "calibration proposal");
  if (item.schemaVersion !== CALIBRATION_PROPOSAL_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported calibration proposal input schema",
      EXIT.inputError,
    );
  // Fixed inert markers: a proposal that claims any approval or non-proposed
  // status is rejected outright so no artifact can imply enforcement.
  if (item.status !== "proposed")
    throw new RigorError(
      'A calibration proposal status must be exactly "proposed"',
      EXIT.inputError,
    );
  if (item.approvalEffect !== "none")
    throw new RigorError(
      'A calibration proposal approvalEffect must be exactly "none"',
      EXIT.inputError,
    );
  const evidence = record(item.evidence, "evidence");
  const reportHashes = strings(
    evidence.reportHashes,
    "evidence.reportHashes",
    100,
  );
  if (reportHashes.length === 0)
    throw new RigorError(
      "evidence.reportHashes must not be empty",
      EXIT.inputError,
    );
  for (const [index, digest] of reportHashes.entries())
    if (!/^[a-f0-9]{64}$/u.test(digest))
      throw new RigorError(
        `evidence.reportHashes[${index}] must be a SHA-256 digest`,
        EXIT.inputError,
      );
  const taskIds = Array.isArray(evidence.taskIds)
    ? evidence.taskIds
    : undefined;
  if (taskIds === undefined || taskIds.length === 0 || taskIds.length > 100)
    throw new RigorError(
      "evidence.taskIds must be a non-empty array",
      EXIT.inputError,
    );
  const resolvedTaskIds = taskIds.map((raw) => taskId(raw));
  let replayHash: string | null = null;
  if (evidence.replayHash !== undefined && evidence.replayHash !== null) {
    replayHash = textField(evidence.replayHash, "evidence.replayHash", 128);
    if (!/^[a-f0-9]{64}$/u.test(replayHash))
      throw new RigorError(
        "evidence.replayHash must be a SHA-256 digest",
        EXIT.inputError,
      );
  }
  const expectedTradeOffs = strings(
    item.expectedTradeOffs,
    "expectedTradeOffs",
    50,
  );
  if (expectedTradeOffs.length === 0)
    throw new RigorError(
      "expectedTradeOffs must not be empty",
      EXIT.inputError,
    );
  const rollbackCriteria = strings(
    item.rollbackCriteria,
    "rollbackCriteria",
    50,
  );
  if (rollbackCriteria.length === 0)
    throw new RigorError("rollbackCriteria must not be empty", EXIT.inputError);
  let holdoutFinalEvaluation = false;
  if (item.holdoutFinalEvaluation !== undefined) {
    if (typeof item.holdoutFinalEvaluation !== "boolean")
      throw new RigorError(
        "holdoutFinalEvaluation must be a boolean",
        EXIT.inputError,
      );
    holdoutFinalEvaluation = item.holdoutFinalEvaluation;
  }
  return {
    schemaVersion: CALIBRATION_PROPOSAL_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    target: oneOf(item.target, PROPOSAL_TARGETS, "target"),
    summary: textField(item.summary, "summary", 2000),
    evidence: { reportHashes, taskIds: resolvedTaskIds, replayHash },
    proposedChange: textField(item.proposedChange, "proposedChange", 4000),
    expectedTradeOffs,
    rollbackCriteria,
    status: "proposed",
    approvalEffect: "none",
    holdoutFinalEvaluation,
  };
}

/**
 * Bind a proposal to a manifest so its evidence provenance is fail-closed: every
 * cited evidence task must exist in the manifest, and a holdout task may only be
 * cited when the input explicitly sets `holdoutFinalEvaluation`. The saved
 * artifact records the manifest hash and every cited task's split so the
 * contamination boundary is auditable. The proposal stays inert.
 */
export function createCalibrationProposal(
  input: CalibrationProposalInput,
  manifest: EvaluationManifest,
  now = new Date(),
): CalibrationProposal {
  const splitByTask = new Map<string, EvaluationSplit>();
  for (const task of manifest.tasks) splitByTask.set(task.taskId, task.split);
  const evidenceTaskSplits = input.evidence.taskIds.map((id) => {
    const split = splitByTask.get(id);
    if (split === undefined)
      throw new RigorError(
        `evidence task ${id} is not present in the cross-checked manifest`,
        EXIT.inputError,
      );
    if (split === "holdout" && !input.holdoutFinalEvaluation)
      throw new RigorError(
        `evidence task ${id} is a holdout task; set holdoutFinalEvaluation to cite it as a final evaluation`,
        EXIT.inputError,
      );
    return { taskId: id, split };
  });
  const provenance: CalibrationProposalProvenance = {
    manifestHash: hash(manifest),
    manifestVersion: manifest.manifestVersion,
    holdoutFinalEvaluation: input.holdoutFinalEvaluation,
    evidenceTaskSplits,
  };
  return {
    schemaVersion: CALIBRATION_PROPOSAL_SCHEMA,
    artifactId: artifactId("calibration-proposal"),
    taskId: input.taskId,
    createdAt: now.toISOString(),
    target: input.target,
    summary: input.summary,
    evidence: input.evidence,
    proposedChange: input.proposedChange,
    expectedTradeOffs: input.expectedTradeOffs,
    rollbackCriteria: input.rollbackCriteria,
    status: "proposed",
    approvalEffect: "none",
    provenance,
  };
}

/**
 * Verify that a calibration proposal's cited evidence hashes are backed by
 * actually-supplied report/replay files, not merely copied unverified from the
 * input. Every `--report` file must itself parse as a
 * `rigor.evaluation-report.v1` or `rigor.evaluation-replay.v1` document whose
 * `manifest.hash` equals the hash of the `--manifest` selected for this
 * command (the same manifest `createCalibrationProposal` cross-checks
 * evidence task ids against), and every digest in `evidence.reportHashes`
 * (report) or `evidence.replayHash` (replay, when present) must equal the
 * canonical hash of one of the supplied files. The canonical hash of a report
 * is computed by the same `hash()` helper the report/replay generators use
 * for their own embedded hashes (`manifest.hash`, `proposedModelProfilesHash`):
 * `hash()` re-serializes the parsed object through a stable, sorted-key
 * stringify, so it is insensitive to on-disk formatting (pretty-printing,
 * key order, trailing newline) and only reflects content. Any mismatch fails
 * closed: a proposal can never cite evidence nobody actually supplied.
 */
export function verifyCalibrationEvidence(
  evidence: CalibrationProposalInput["evidence"],
  manifest: EvaluationManifest,
  reports: unknown[],
): void {
  if (reports.length === 0)
    throw new RigorError(
      "At least one --report is required to verify cited evidence",
      EXIT.inputError,
    );
  const manifestHash = hash(manifest);
  const parsed = reports.map((raw, index) => {
    const item = record(raw, `--report[${index}]`);
    if (
      item.schemaVersion !== EVALUATION_REPORT_SCHEMA &&
      item.schemaVersion !== EVALUATION_REPLAY_SCHEMA
    )
      throw new RigorError(
        `--report[${index}] is not a rigor.evaluation-report.v1 or rigor.evaluation-replay.v1 document`,
        EXIT.inputError,
      );
    const reportManifest = record(item.manifest, `--report[${index}].manifest`);
    if (reportManifest.hash !== manifestHash)
      throw new RigorError(
        `--report[${index}].manifest.hash does not match the selected --manifest`,
        EXIT.inputError,
      );
    return { schemaVersion: item.schemaVersion, digest: hash(item) };
  });
  for (const digest of evidence.reportHashes) {
    const backed = parsed.some(
      (item) =>
        item.schemaVersion === EVALUATION_REPORT_SCHEMA &&
        item.digest === digest,
    );
    if (!backed)
      throw new RigorError(
        `evidence.reportHashes entry ${digest} is not the canonical hash of any supplied --report file`,
        EXIT.inputError,
      );
  }
  if (evidence.replayHash !== null) {
    const backed = parsed.some(
      (item) =>
        item.schemaVersion === EVALUATION_REPLAY_SCHEMA &&
        item.digest === evidence.replayHash,
    );
    if (!backed)
      throw new RigorError(
        "evidence.replayHash is not the canonical hash of any supplied --report file",
        EXIT.inputError,
      );
  }
}

// ---------------------------------------------------------------------------
// Evidence loading. The evidence root is a directory that directly contains one
// subdirectory per task id (e.g. `.rigor/evidence`). Reading is never fatal on a
// missing or malformed file: it is counted, exactly like retrospect's
// malformedOutcomes.
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

interface LoadedTask {
  outcome: Raw | null;
  outcomeAbsent: boolean;
  outcomeMalformed: boolean;
  attempts: Raw[];
  malformedAttempts: number;
  plans: Map<string, Raw>;
  planList: Raw[];
  malformedPlans: number;
}

/**
 * True when `target` resolves inside the already-realpath'd evidence `root`,
 * following symlinks along the way. A path that escapes the root (via a symlink
 * out of the tree, for example) is not read; the caller counts it as malformed.
 */
async function containedInRoot(root: string, target: string): Promise<boolean> {
  try {
    await assertContainedPath(root, target);
    return true;
  } catch (error) {
    if (error instanceof RigorError) return false;
    throw error;
  }
}

async function readRecord(
  root: string,
  file: string,
): Promise<Raw | undefined> {
  if (!(await containedInRoot(root, file)))
    throw new RigorError("Path escapes the evidence root", EXIT.inputError);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new RigorError("Not an object", EXIT.inputError);
  return parsed as Raw;
}

async function readCollection(
  root: string,
  directory: string,
  schemaVersion: string,
  wellFormed: (raw: Raw) => boolean,
): Promise<{ valid: Raw[]; malformed: number }> {
  // A collection directory (attempts/, routing/) that escapes the resolved
  // evidence root is never read; it is counted as one malformed artifact,
  // exactly like an escaping task directory or an escaping individual file,
  // rather than silently reporting zero malformed artifacts for content that
  // was never inspected.
  if (!(await containedInRoot(root, directory)))
    return { valid: [], malformed: 1 };
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { valid: [], malformed: 0 };
    throw error;
  }
  const valid: Raw[] = [];
  let malformed = 0;
  for (const name of names.filter((file) => file.endsWith(".json")).sort()) {
    try {
      const parsed = await readRecord(root, path.join(directory, name));
      if (
        parsed === undefined ||
        parsed.schemaVersion !== schemaVersion ||
        !wellFormed(parsed)
      )
        malformed += 1;
      else valid.push(parsed);
    } catch {
      malformed += 1;
    }
  }
  return { valid, malformed };
}

async function loadTask(root: string, task: string): Promise<LoadedTask> {
  const directory = path.join(root, task);
  // A task directory that escapes the resolved evidence root (for example via a
  // symlink out of the tree) is never read: it is counted as one malformed
  // outcome and its artifacts are skipped.
  if (!(await containedInRoot(root, directory)))
    return {
      outcome: null,
      outcomeAbsent: false,
      outcomeMalformed: true,
      attempts: [],
      malformedAttempts: 0,
      plans: new Map(),
      planList: [],
      malformedPlans: 0,
    };
  let outcome: Raw | null = null;
  let outcomeAbsent = false;
  let outcomeMalformed = false;
  try {
    const parsed = await readRecord(root, path.join(directory, "outcome.json"));
    if (parsed === undefined) outcomeAbsent = true;
    else if (
      parsed.schemaVersion !== OUTCOME_SCHEMA ||
      !outcomeFieldsWellFormed(parsed)
    )
      outcomeMalformed = true;
    else outcome = parsed;
  } catch {
    outcomeMalformed = true;
  }
  const attempts = await readCollection(
    root,
    path.join(directory, "attempts"),
    ATTEMPT_SCHEMA,
    attemptFieldsWellFormed,
  );
  const plans = await readCollection(
    root,
    path.join(directory, "routing"),
    ROUTING_PLAN_SCHEMA,
    planFieldsWellFormed,
  );
  const planMap = new Map<string, Raw>();
  for (const plan of plans.valid) {
    const id = optionalString(plan.artifactId);
    if (id !== null) planMap.set(id, plan);
  }
  return {
    outcome,
    outcomeAbsent,
    outcomeMalformed,
    attempts: attempts.valid,
    malformedAttempts: attempts.malformed,
    plans: planMap,
    planList: plans.valid,
    malformedPlans: plans.malformed,
  };
}

// ---------------------------------------------------------------------------
// Aggregation.
// ---------------------------------------------------------------------------

interface Agg {
  acceptedChanges: number;
  rejectedOutcomes: number;
  retriesTotal: number;
  relativeCostTotal: number;
  relativeCostUnknownAttempts: number;
  humanTotal: number;
  reviewFindingsTotal: number;
  elapsedTotal: number;
  elapsedPresent: number;
  elapsedMissing: number;
  usageRecorded: number;
  usageUnavailable: number;
  usageUnknown: number;
  modelIdentityPresent: number;
  providerCostPresent: number;
  escapedSuspected: number;
  escapedConfirmed: number;
  overRouting: number;
  underRouting: number;
}

function emptyAgg(): Agg {
  return {
    acceptedChanges: 0,
    rejectedOutcomes: 0,
    retriesTotal: 0,
    relativeCostTotal: 0,
    relativeCostUnknownAttempts: 0,
    humanTotal: 0,
    reviewFindingsTotal: 0,
    elapsedTotal: 0,
    elapsedPresent: 0,
    elapsedMissing: 0,
    usageRecorded: 0,
    usageUnavailable: 0,
    usageUnknown: 0,
    modelIdentityPresent: 0,
    providerCostPresent: 0,
    escapedSuspected: 0,
    escapedConfirmed: 0,
    overRouting: 0,
    underRouting: 0,
  };
}

interface OutcomeData {
  decision: "accepted" | "rejected";
  capabilityClass: CapabilityClass | null;
  provider: string | null;
  model: string | null;
  candidateKey: string;
  retries: number;
  relativeCost: number;
  relativeCostUnknown: number;
  human: number;
  reviewFindings: number;
  elapsed: number | undefined;
  usageStatus: "recorded" | "unavailable" | "unknown" | null;
  modelIdentityPresent: boolean;
  providerCostPresent: boolean;
  escaped: "none" | "suspected" | "confirmed";
  overRouting: boolean;
  underRouting: boolean;
}

function deriveOutcomeData(loaded: LoadedTask): OutcomeData {
  const outcome = loaded.outcome as Raw;
  const decision = outcome.decision === "accepted" ? "accepted" : "rejected";
  const rawClass = optionalString(outcome.capabilityClass);
  const capabilityClass =
    rawClass !== null && (CAPABILITY_CLASSES as string[]).includes(rawClass)
      ? (rawClass as CapabilityClass)
      : null;
  const provider = optionalString(outcome.provider);
  const model = optionalString(outcome.model);
  const attemptLinked = typeof outcome.attemptArtifactId === "string";
  // Composite key so two distinct candidates that happen to share a model name
  // (different provider or capability class) never collapse into one row.
  // JSON.stringify of the tuple (rather than a delimiter-joined string) is
  // collision-proof even when a provider or model name itself contains the
  // delimiter: quoting and comma-separation make `["a/b","c",null]` and
  // `["a","b/c",null]` distinct strings, whereas `"a/b/c"` would collide. An
  // outcome not linked to an attempt has no identified candidate and is
  // grouped under the explicit "unlinked" key, exactly as before.
  const candidateKey = attemptLinked
    ? JSON.stringify([provider, model, capabilityClass])
    : "unlinked";
  const retries = optionalNumber(outcome.retryCount) ?? 0;
  const escalationCount = optionalNumber(outcome.escalationCount) ?? 0;
  const human = optionalNumber(outcome.humanCorrectionMinutes) ?? 0;
  const findings =
    typeof outcome.reviewFindings === "object" &&
    outcome.reviewFindings !== null
      ? (outcome.reviewFindings as Raw)
      : {};
  const reviewFindings = optionalNumber(findings.total) ?? 0;
  const elapsed = optionalNumber(outcome.attemptDurationMs);
  const usage =
    typeof outcome.usage === "object" && outcome.usage !== null
      ? (outcome.usage as Raw)
      : {};
  const usageStatus =
    usage.status === "recorded" ||
    usage.status === "unavailable" ||
    usage.status === "unknown"
      ? usage.status
      : null;
  const modelIdentityPresent =
    usage.modelIdentity !== null && usage.modelIdentity !== undefined;
  const providerCostPresent =
    usage.providerCost !== null && usage.providerCost !== undefined;
  const escaped =
    outcome.escapedDefectStatus === "suspected"
      ? "suspected"
      : outcome.escapedDefectStatus === "confirmed"
        ? "confirmed"
        : "none";

  // Relative cost consumed across every recorded attempt for this task, joined
  // to the routing plan that produced each attempt. Never inferred: an attempt
  // whose plan is missing or malformed is counted as unknown, not guessed.
  let relativeCost = 0;
  let relativeCostUnknown = 0;
  let expanded = false;
  for (const attempt of loaded.attempts) {
    const planId = optionalString(attempt.routingPlanArtifactId);
    const plan = planId !== null ? loaded.plans.get(planId) : undefined;
    const selection =
      plan && typeof plan.selection === "object" && plan.selection !== null
        ? (plan.selection as Raw)
        : undefined;
    const cost = selection ? optionalNumber(selection.relativeCost) : undefined;
    if (cost !== undefined) relativeCost += cost;
    else relativeCostUnknown += 1;
    const progress =
      typeof attempt.progress === "object" && attempt.progress !== null
        ? (attempt.progress as Raw)
        : undefined;
    if (progress && progress.status === "expanded") expanded = true;
  }
  // An attempt excluded as malformed was never read, so its cost can never be
  // known either: it counts as one more unknown relative-cost contribution for
  // this task, exactly like an attempt whose routing plan could not be
  // resolved. Without this, a task with one valid and one malformed attempt
  // would report a partial cost as if it were complete.
  relativeCostUnknown += loaded.malformedAttempts;

  const overRouting =
    decision === "accepted" &&
    retries === 0 &&
    escalationCount === 0 &&
    reviewFindings === 0 &&
    capabilityClass !== null &&
    capabilityClass !== "economy";
  const underRouting =
    decision === "rejected" || escalationCount > 0 || expanded;

  return {
    decision,
    capabilityClass,
    provider,
    model,
    candidateKey,
    retries,
    relativeCost,
    relativeCostUnknown,
    human,
    reviewFindings,
    elapsed,
    usageStatus,
    modelIdentityPresent,
    providerCostPresent,
    escaped,
    overRouting,
    underRouting,
  };
}

function applyAgg(agg: Agg, data: OutcomeData): void {
  if (data.decision === "accepted") {
    agg.acceptedChanges += 1;
    agg.retriesTotal += data.retries;
    agg.relativeCostTotal += data.relativeCost;
    agg.relativeCostUnknownAttempts += data.relativeCostUnknown;
    agg.humanTotal += data.human;
    agg.reviewFindingsTotal += data.reviewFindings;
    if (data.elapsed !== undefined) {
      agg.elapsedTotal += data.elapsed;
      agg.elapsedPresent += 1;
    } else {
      agg.elapsedMissing += 1;
    }
    if (data.usageStatus === "recorded") agg.usageRecorded += 1;
    else if (data.usageStatus === "unavailable") agg.usageUnavailable += 1;
    else if (data.usageStatus === "unknown") agg.usageUnknown += 1;
    if (data.modelIdentityPresent) agg.modelIdentityPresent += 1;
    if (data.providerCostPresent) agg.providerCostPresent += 1;
    if (data.escaped === "suspected") agg.escapedSuspected += 1;
    else if (data.escaped === "confirmed") agg.escapedConfirmed += 1;
    if (data.overRouting) agg.overRouting += 1;
  } else {
    agg.rejectedOutcomes += 1;
  }
  if (data.underRouting) agg.underRouting += 1;
}

function ratio(total: number, denominator: number): number | null {
  return denominator > 0 ? total / denominator : null;
}

function renderAgg(agg: Agg): Record<string, unknown> {
  const d = agg.acceptedChanges;
  return {
    acceptedChanges: d,
    rejectedOutcomes: agg.rejectedOutcomes,
    perAcceptedChange: {
      retries: ratio(agg.retriesTotal, d),
      // Null unless the configured relative cost is known for every accepted
      // change in the aggregate: an unresolved-plan attempt must never make an
      // unknown look like a smaller average.
      configuredRelativeCost:
        agg.relativeCostUnknownAttempts > 0
          ? null
          : ratio(agg.relativeCostTotal, d),
      humanCorrectionMinutes: ratio(agg.humanTotal, d),
      reviewFindings: ratio(agg.reviewFindingsTotal, d),
      // Denominated by accepted changes, and only reported when elapsed is
      // present for every accepted change (elapsedMissing === 0); otherwise
      // null, since a partial mean would misrepresent the completeness.
      elapsedMs: agg.elapsedMissing > 0 ? null : ratio(agg.elapsedTotal, d),
    },
    totals: {
      retries: agg.retriesTotal,
      configuredRelativeCost: agg.relativeCostTotal,
      humanCorrectionMinutes: agg.humanTotal,
      reviewFindings: agg.reviewFindingsTotal,
      elapsedMs: {
        total: agg.elapsedTotal,
        present: agg.elapsedPresent,
        missing: agg.elapsedMissing,
      },
    },
    missingData: {
      usageRecorded: agg.usageRecorded,
      usageUnavailable: agg.usageUnavailable,
      usageUnknown: agg.usageUnknown,
      modelIdentityPresent: agg.modelIdentityPresent,
      providerCostPresent: agg.providerCostPresent,
      relativeCostUnknownAttempts: agg.relativeCostUnknownAttempts,
    },
    escapedDefects: {
      suspected: agg.escapedSuspected,
      confirmed: agg.escapedConfirmed,
    },
    signals: {
      overRouting: { count: agg.overRouting, denominator: d },
      underRouting: {
        count: agg.underRouting,
        denominator: agg.acceptedChanges + agg.rejectedOutcomes,
      },
    },
  };
}

interface SplitMissing {
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
  relativeCostUnknownAttempts: number;
  malformedArtifacts: number;
}

interface SplitState {
  manifestTaskCount: number;
  accepted: number;
  rejected: number;
  absent: number;
  malformed: number;
  missing: SplitMissing;
  split: Agg;
  classes: Map<CapabilityClass, Agg>;
  candidates: Map<
    string,
    {
      provider: string | null;
      model: string | null;
      capabilityClass: CapabilityClass | null;
      agg: Agg;
    }
  >;
}

function emptySplitState(): SplitState {
  const classes = new Map<CapabilityClass, Agg>();
  for (const capability of CAPABILITY_CLASSES)
    classes.set(capability, emptyAgg());
  return {
    manifestTaskCount: 0,
    accepted: 0,
    rejected: 0,
    absent: 0,
    malformed: 0,
    missing: {
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
      relativeCostUnknownAttempts: 0,
      malformedArtifacts: 0,
    },
    split: emptyAgg(),
    classes,
    candidates: new Map(),
  };
}

function renderSplit(
  split: EvaluationSplit,
  state: SplitState,
): Record<string, unknown> {
  const accepted = state.accepted;
  const s = state.split;
  const byCapabilityClass = CAPABILITY_CLASSES.map((capability) => ({
    capabilityClass: capability,
    ...renderAgg(state.classes.get(capability)!),
  }));
  const byCandidate = [...state.candidates.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([candidate, entry]) => ({
      candidate,
      provider: entry.provider,
      model: entry.model,
      capabilityClass: entry.capabilityClass,
      ...renderAgg(entry.agg),
    }));
  return {
    split,
    evaluationOnly: split === "holdout",
    manifestTaskCount: state.manifestTaskCount,
    outcomes: {
      accepted,
      rejected: state.rejected,
      absent: state.absent,
      malformed: state.malformed,
    },
    missingData: state.missing,
    signals: {
      overRouting: {
        count: s.overRouting,
        denominator: accepted,
        definition: OVER_ROUTING_DEFINITION,
      },
      underRouting: {
        count: s.underRouting,
        denominator: accepted + state.rejected,
        definition: UNDER_ROUTING_DEFINITION,
      },
      retryCost: {
        acceptedChanges: accepted,
        retriesTotal: s.retriesTotal,
        retriesPerAcceptedChange: ratio(s.retriesTotal, accepted),
        configuredRelativeCostTotal: s.relativeCostTotal,
        // Known numerator (configuredRelativeCostTotal) is reported separately;
        // the per-accepted-change value is null whenever any contributing
        // attempt's plan was unresolved, so a partial total never reads as
        // complete.
        configuredRelativeCostPerAcceptedChange:
          s.relativeCostUnknownAttempts > 0
            ? null
            : ratio(s.relativeCostTotal, accepted),
        relativeCostUnknownAttempts: s.relativeCostUnknownAttempts,
      },
      escapedDefects: {
        suspected: s.escapedSuspected,
        confirmed: s.escapedConfirmed,
        acceptedChanges: accepted,
      },
    },
    byCapabilityClass,
    byCandidate,
  };
}

/**
 * Resolve the evidence root once so every subsequent containment check is
 * relative to its real location. The root itself may live anywhere (an
 * explicitly selected external fixture root is supported); only paths escaping
 * the resolved root are rejected. A non-existent root resolves to itself so the
 * per-task reads report absent/empty as before.
 */
async function resolveEvidenceRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return root;
    throw error;
  }
}

export async function buildEvaluationReport(
  root: string,
  manifest: EvaluationManifest,
  now = new Date(),
): Promise<Record<string, unknown>> {
  const realRoot = await resolveEvidenceRoot(root);
  const states: Record<EvaluationSplit, SplitState> = {
    calibration: emptySplitState(),
    holdout: emptySplitState(),
  };
  for (const task of manifest.tasks) {
    const state = states[task.split];
    state.manifestTaskCount += 1;
    const loaded = await loadTask(realRoot, task.taskId);
    state.missing.malformedArtifacts +=
      loaded.malformedAttempts + loaded.malformedPlans;
    if (loaded.outcomeAbsent) {
      state.absent += 1;
      continue;
    }
    if (loaded.outcomeMalformed || loaded.outcome === null) {
      state.malformed += 1;
      continue;
    }
    const data = deriveOutcomeData(loaded);
    const outcome = loaded.outcome;
    // Split-level data completeness is measured over every present outcome
    // (accepted and rejected); the per-class and per-candidate aggregates below
    // are measured strictly over accepted outcomes.
    if (data.usageStatus === "recorded") state.missing.usageRecorded += 1;
    else if (data.usageStatus === "unavailable")
      state.missing.usageUnavailable += 1;
    else if (data.usageStatus === "unknown") state.missing.usageUnknown += 1;
    if (data.modelIdentityPresent) state.missing.modelIdentityPresent += 1;
    else state.missing.modelIdentityAbsent += 1;
    if (data.providerCostPresent) state.missing.providerCostPresent += 1;
    if (data.elapsed !== undefined) state.missing.elapsedPresent += 1;
    else state.missing.elapsedMissing += 1;
    if (typeof outcome.attemptArtifactId === "string")
      state.missing.attemptLinked += 1;
    else state.missing.attemptUnlinked += 1;
    if (typeof outcome.verificationArtifactId === "string")
      state.missing.verificationLinked += 1;
    if (data.decision === "accepted")
      state.missing.relativeCostUnknownAttempts += data.relativeCostUnknown;

    if (data.decision === "accepted") state.accepted += 1;
    else state.rejected += 1;

    applyAgg(state.split, data);
    if (data.capabilityClass !== null)
      applyAgg(state.classes.get(data.capabilityClass)!, data);
    let candidate = state.candidates.get(data.candidateKey);
    if (candidate === undefined) {
      candidate = {
        provider: data.provider,
        model: data.model,
        capabilityClass: data.capabilityClass,
        agg: emptyAgg(),
      };
      state.candidates.set(data.candidateKey, candidate);
    }
    applyAgg(candidate.agg, data);
  }
  return {
    schemaVersion: EVALUATION_REPORT_SCHEMA,
    generatedAt: now.toISOString(),
    manifest: {
      manifestVersion: manifest.manifestVersion,
      taskCount: manifest.tasks.length,
      hash: hash(manifest),
    },
    splits: {
      calibration: renderSplit("calibration", states.calibration),
      holdout: renderSplit("holdout", states.holdout),
    },
  };
}

// ---------------------------------------------------------------------------
// Replay / shadow evaluation. A pure selector recomputes what the routed
// capability class would select under a PROPOSED model-profiles file, sourced
// entirely from each recorded routing plan. It mirrors src/routing.ts route()
// selection: required capability class is a function of signals only and is
// unchanged by proposed profiles, so the recorded requiredCapabilityClass is
// exact. Availability is not applied to a hypothetical proposed set.
// ---------------------------------------------------------------------------

interface ReplaySelection {
  status: "selected" | "unroutable" | "requires-review";
  candidateId: string | null;
  capabilityClass: CapabilityClass | null;
  relativeCost: number | null;
}

interface LoadedPlan {
  requiredCapabilityClass: CapabilityClass;
  purpose: string;
  maxRelativeCost: number;
  externalTransmission: "allowed" | "denied";
  confidence: "low" | "medium" | "high";
  selection: {
    candidateId: string;
    capabilityClass: CapabilityClass;
    relativeCost: number;
  };
  createdAt: string;
  artifactId: string;
}

export function replaySelection(
  plan: LoadedPlan,
  profiles: ModelProfiles,
): ReplaySelection {
  const requiredIndex = CAPABILITY_CLASSES.indexOf(
    plan.requiredCapabilityClass,
  );
  const eligible = profiles.candidates
    .filter(
      (candidate) =>
        candidate.enabled &&
        candidate.purposes.includes(
          plan.purpose as ModelProfiles["candidates"][number]["purposes"][number],
        ) &&
        !(
          plan.externalTransmission === "denied" &&
          candidate.requiresAdditionalExternalTransmission
        ) &&
        CAPABILITY_CLASSES.indexOf(candidate.capabilityClass) >=
          requiredIndex &&
        candidate.relativeCost <= plan.maxRelativeCost,
    )
    .sort(
      (left, right) =>
        left.relativeCost - right.relativeCost ||
        CAPABILITY_CLASSES.indexOf(left.capabilityClass) -
          CAPABILITY_CLASSES.indexOf(right.capabilityClass) ||
        left.id.localeCompare(right.id),
    );
  const selected = plan.confidence === "low" ? undefined : eligible[0];
  if (plan.confidence === "low")
    return {
      status: "requires-review",
      candidateId: null,
      capabilityClass: null,
      relativeCost: null,
    };
  if (selected === undefined)
    return {
      status: "unroutable",
      candidateId: null,
      capabilityClass: null,
      relativeCost: null,
    };
  return {
    status: "selected",
    candidateId: selected.id,
    capabilityClass: selected.capabilityClass,
    relativeCost: selected.relativeCost,
  };
}

function toLoadedPlan(plan: Raw): LoadedPlan | null {
  const selection =
    typeof plan.selection === "object" && plan.selection !== null
      ? (plan.selection as Raw)
      : null;
  if (plan.status !== "planned" || selection === null) return null;
  const rawClass = optionalString(plan.requiredCapabilityClass);
  const selClass = optionalString(selection.capabilityClass);
  const purpose = optionalString(plan.purpose);
  const budget =
    typeof plan.budget === "object" && plan.budget !== null
      ? (plan.budget as Raw)
      : null;
  const controls =
    typeof plan.controls === "object" && plan.controls !== null
      ? (plan.controls as Raw)
      : null;
  const assessment =
    typeof plan.assessment === "object" && plan.assessment !== null
      ? (plan.assessment as Raw)
      : null;
  const candidateId = optionalString(selection.candidateId);
  const maxRelativeCost = budget
    ? optionalNumber(budget.maxRelativeCost)
    : undefined;
  const relativeCost = optionalNumber(selection.relativeCost);
  const externalTransmission = controls
    ? optionalString(controls.externalTransmission)
    : null;
  const confidence = assessment
    ? optionalString(assessment.confidence)
    : "medium";
  const createdAt = optionalString(plan.createdAt);
  const artifactIdValue = optionalString(plan.artifactId);
  if (
    rawClass === null ||
    !(CAPABILITY_CLASSES as string[]).includes(rawClass) ||
    selClass === null ||
    !(CAPABILITY_CLASSES as string[]).includes(selClass) ||
    purpose === null ||
    maxRelativeCost === undefined ||
    relativeCost === undefined ||
    candidateId === null ||
    (externalTransmission !== "allowed" && externalTransmission !== "denied") ||
    (confidence !== "low" &&
      confidence !== "medium" &&
      confidence !== "high") ||
    createdAt === null ||
    artifactIdValue === null
  )
    return null;
  return {
    requiredCapabilityClass: rawClass as CapabilityClass,
    purpose,
    maxRelativeCost,
    externalTransmission,
    confidence,
    selection: {
      candidateId,
      capabilityClass: selClass as CapabilityClass,
      relativeCost,
    },
    createdAt,
    artifactId: artifactIdValue,
  };
}

export async function buildReplayReport(
  root: string,
  manifest: EvaluationManifest,
  profiles: ModelProfiles,
  options: { holdoutFinal: boolean },
  now = new Date(),
): Promise<Record<string, unknown>> {
  const realRoot = await resolveEvidenceRoot(root);
  const selectedSplit: EvaluationSplit = options.holdoutFinal
    ? "holdout"
    : "calibration";
  const diffs: Array<Record<string, unknown>> = [];
  let excludedSplitTaskCount = 0;
  let noPlan = 0;
  let changed = 0;
  let unchanged = 0;
  let nowSelected = 0;
  let nowUnroutable = 0;
  let nowRequiresReview = 0;
  for (const task of manifest.tasks) {
    // Hard separation: calibration fitting never observes holdout tasks, and a
    // holdout-final replay never observes calibration tasks. The two sets can
    // never be mixed in a single replay output.
    if (task.split !== selectedSplit) {
      excludedSplitTaskCount += 1;
      continue;
    }
    const loaded = await loadTask(realRoot, task.taskId);
    const plans = loaded.planList
      .map(toLoadedPlan)
      .filter((plan): plan is LoadedPlan => plan !== null)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.artifactId.localeCompare(b.artifactId)
          : a.createdAt.localeCompare(b.createdAt),
      );
    const plan = plans[plans.length - 1];
    if (plan === undefined) {
      noPlan += 1;
      diffs.push({
        taskId: task.taskId,
        original: null,
        proposed: null,
        changed: false,
        note: "no recorded routing plan",
      });
      continue;
    }
    const proposed = replaySelection(plan, profiles);
    // A selection is changed when the outcome status differs, or when any
    // observable of the selection differs: the candidate id, its capability
    // class, or its configured relative cost. Keeping the same candidate id but
    // re-weighting its relativeCost is a real routing change, not a no-op.
    const isChanged =
      proposed.status !== "selected" ||
      proposed.candidateId !== plan.selection.candidateId ||
      proposed.capabilityClass !== plan.selection.capabilityClass ||
      proposed.relativeCost !== plan.selection.relativeCost;
    if (isChanged) changed += 1;
    else unchanged += 1;
    if (proposed.status === "selected") nowSelected += 1;
    else if (proposed.status === "unroutable") nowUnroutable += 1;
    else nowRequiresReview += 1;
    diffs.push({
      taskId: task.taskId,
      original: {
        status: "selected",
        candidateId: plan.selection.candidateId,
        capabilityClass: plan.selection.capabilityClass,
        relativeCost: plan.selection.relativeCost,
      },
      proposed: {
        status: proposed.status,
        candidateId: proposed.candidateId,
        capabilityClass: proposed.capabilityClass,
        relativeCost: proposed.relativeCost,
      },
      changed: isChanged,
    });
  }
  const tasksReplayed = diffs.length - noPlan;
  if (tasksReplayed === 0)
    throw new RigorError(
      `No ${selectedSplit} tasks with a recorded routing plan to replay`,
      EXIT.policyViolation,
    );
  return {
    schemaVersion: EVALUATION_REPLAY_SCHEMA,
    generatedAt: now.toISOString(),
    split: selectedSplit,
    holdoutFinal: options.holdoutFinal,
    proposedModelProfilesHash: hash(profiles),
    manifest: {
      manifestVersion: manifest.manifestVersion,
      taskCount: manifest.tasks.length,
      hash: hash(manifest),
    },
    excludedSplitTaskCount,
    summary: {
      tasksReplayed,
      changed,
      unchanged,
      nowSelected,
      nowUnroutable,
      nowRequiresReview,
      noPlan,
    },
    diffs,
  };
}
