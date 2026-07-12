// Test-integrity shadow-mode signal collection (#22).
//
// This module implements the five high-confidence shadow candidates from the
// #21 catalog (docs/test-integrity.md): TI-05 skip/only/todo markers, TI-06
// test-case removal, TI-07 assertion-token decline, TI-08 snapshot churn, and
// TI-09 verification-adjacent config/script change.
//
// `detectSignals` is pure: a total, deterministic function of a parsed diff
// (git.ts DiffFileChange[]) plus the parsed package.json `scripts` maps at base
// and head. It performs no I/O and no clock/uuid access, mirroring the purity
// discipline of src/fingerprint.ts. It never returns or embeds raw matched
// source text: each fired signal carries only bounded counts, repository
// relative paths, and an opaque `matchDigest` hash over normalized matched
// lines. Shadow mode is record-only: `mode` is always "shadow" and
// `enforcement` is always "none"; a fired signal changes no verification,
// progress, review, or merge outcome, and every label is
// "advisory-interpretation" — the counts are the facts, the weakening claim is
// not.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { EXIT, RigorError } from "./errors.js";
import type { DiffFileChange } from "./git.js";
import { diffChanges, resolveCommit, showFile, treeHash } from "./git.js";
import { matches } from "./paths.js";
import {
  ATTEMPT_SCHEMA,
  ATTEMPT_SESSION_SCHEMA,
  TEST_INTEGRITY_CLASSIFICATION_INPUT_SCHEMA,
  TEST_INTEGRITY_CLASSIFICATION_SCHEMA,
  TEST_INTEGRITY_EVENT_SCHEMA,
  type TestIntegrityClassification,
  type TestIntegrityClassificationInput,
  type TestIntegrityEvent,
  type TestIntegritySignal,
  type TestIntegritySignalId,
  type TestIntegrityVerdict,
} from "./types.js";
import { artifactId, hash, record, taskId, textField } from "./util.js";

export const DETECTOR_VERSION = "0.1.0";
export const CANDIDATE_SET_VERSION = "ti-05-ti-09.v1";

/** The five signal IDs this detector evaluates on every scan. This list is the
 * denominator recorded on each event (`signalsEvaluated`) so retrospect can
 * measure firing rate against all scans, not only scans that fired. */
export const EVALUATED_SIGNALS: readonly TestIntegritySignalId[] = [
  "TI-05",
  "TI-06",
  "TI-07",
  "TI-08",
  "TI-09",
] as const;

/** Built-in test-path globs (no policy/config surface, documented defaults).
 * A file is a "test-path file" when its path matches any of these. */
export const TEST_PATH_GLOBS: readonly string[] = [
  "test/**",
  "tests/**",
  "spec/**",
  "**/__tests__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.go",
  "**/*_test.py",
  "**/test_*.py",
] as const;

/** Snapshot path conventions (TI-08). */
export const SNAPSHOT_GLOBS: readonly string[] = [
  "**/__snapshots__/**",
  "**/*.snap",
] as const;

/** Verification-adjacent runner/lint/typecheck config files (TI-09). The
 * package.json case is handled separately via a scripts diff so a version-only
 * bump does not fire. */
export const CONFIG_GLOBS: readonly string[] = [
  "**/tsconfig.json",
  "**/tsconfig.*.json",
  "**/.eslintrc",
  "**/.eslintrc.*",
  "**/eslint.config.*",
  "**/.prettierrc",
  "**/.prettierrc.*",
  "**/prettier.config.*",
  "**/vitest.config.*",
  "**/jest.config.*",
  "**/.mocharc",
  "**/.mocharc.*",
  "**/babel.config.*",
  "**/.babelrc",
  "**/.babelrc.*",
  "**/Makefile",
  ".github/workflows/**",
] as const;

/** Version-bound digest of the built-in detector configuration. */
export const DETECTOR_CONFIGURATION_DIGEST = hash({
  detectorVersion: DETECTOR_VERSION,
  candidateSetVersion: CANDIDATE_SET_VERSION,
  testPaths: TEST_PATH_GLOBS,
  snapshots: SNAPSHOT_GLOBS,
  configPaths: CONFIG_GLOBS,
});

/** TI-05 marker tokens. Each requires enough shape (a trailing `(` or a
 * bracketed/attribute form) that a plain identifier or prose containing the
 * word — `it("skips empty input")`, `options.skip = true` — does not match. */
const MARKER_TOKENS: readonly string[] = [
  ".skip(",
  ".only(",
  ".todo(",
  "it.todo",
  "describe.todo",
  "xit(",
  "xdescribe(",
  "fit(",
  "fdescribe(",
  "@pytest.mark.skip",
  "@unittest.skip",
  "#[ignore]",
  "t.Skip(",
  "t.SkipNow(",
] as const;

/** TI-07 assertion tokens. Principled, deliberately cross-framework; token
 * counting cannot distinguish a deleted assertion from one moved into a helper,
 * which is exactly why the label stays advisory. */
const ASSERTION_TOKEN_RE =
  /expect\(|\bassert|\.should\b|\bshould\(|toBe\b|toEqual\b|toStrictEqual\b|toMatch\b|toContain\b|toThrow\b|toHaveBeen|\bok\(|\bnotOk\(|\brequire\.[A-Za-z]/gu;

function isTestPath(file: string): boolean {
  return matches(file, [...TEST_PATH_GLOBS]);
}

function isSnapshotPath(file: string): boolean {
  return matches(file, [...SNAPSHOT_GLOBS]);
}

function isConfigPath(file: string): boolean {
  return matches(file, [...CONFIG_GLOBS]);
}

// ---------------------------------------------------------------------------
// matched-line normalization + digest (fingerprint.ts-style, replicated here
// because src/fingerprint.ts is a separate module we do not extend)
// ---------------------------------------------------------------------------

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g");
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP_RE =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const DURATION_RE = /\b\d+(?:\.\d+)?(?:ms|s|m)\b/g;
const HEX_RUN_RE = /\b[0-9a-fA-F]{8,}\b/g;

function normalizeMatchedLine(line: string): string {
  return line
    .replace(ANSI_RE, "")
    .replace(UUID_RE, "<uuid>")
    .replace(ISO_TIMESTAMP_RE, "<ts>")
    .replace(DURATION_RE, "<dur>")
    .replace(HEX_RUN_RE, "<hex>")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Opaque, order-independent digest over normalized matched lines so two
 * events can be compared without ever persisting raw content or secrets. */
function matchDigest(lines: string[]): string {
  const normalized = lines
    .map(normalizeMatchedLine)
    .filter((line) => line.length > 0)
    .sort();
  return hash(normalized);
}

const MAX_PATHS = 25;

function boundedPaths(paths: string[]): string[] {
  return [...new Set(paths)].sort().slice(0, MAX_PATHS);
}

function countMatches(line: string, tokens: readonly string[]): number {
  let count = 0;
  for (const token of tokens) {
    let index = line.indexOf(token);
    while (index !== -1) {
      count += 1;
      index = line.indexOf(token, index + token.length);
    }
  }
  return count;
}

function countAssertions(line: string): number {
  const matched = line.match(ASSERTION_TOKEN_RE);
  return matched === null ? 0 : matched.length;
}

// ---------------------------------------------------------------------------
// detectors
// ---------------------------------------------------------------------------

export interface ScanInputs {
  changes: DiffFileChange[];
  /** Parsed `scripts` object from package.json at the base commit, or null
   * when package.json is absent/unparseable. */
  baseScripts: Record<string, string> | null;
  /** Parsed `scripts` object from package.json at head (or worktree). */
  headScripts: Record<string, string> | null;
}

interface DetectorResult {
  signalId: TestIntegritySignalId;
  threatClass: string;
  detector: string;
  value: Record<string, number>;
  paths: string[];
  matchedLines: string[];
}

function detectTi05(changes: DiffFileChange[]): DetectorResult | null {
  let added = 0;
  let removed = 0;
  const paths: string[] = [];
  const matched: string[] = [];
  for (const change of changes) {
    if (!isTestPath(change.path)) continue;
    let fileAdded = 0;
    for (const line of change.addedLines) {
      const n = countMatches(line, MARKER_TOKENS);
      if (n > 0) matched.push(line);
      fileAdded += n;
    }
    for (const line of change.removedLines) {
      const n = countMatches(line, MARKER_TOKENS);
      if (n > 0) matched.push(line);
      removed += n;
    }
    added += fileAdded;
    if (fileAdded > 0) paths.push(change.path);
  }
  if (added === 0) return null;
  return {
    signalId: "TI-05",
    threatClass: "skip-only-todo",
    detector: "diff-token-scan",
    value: {
      addedMarkers: added,
      removedMarkers: removed,
      matchedPaths: paths.length,
    },
    paths,
    matchedLines: matched,
  };
}

function detectTi06(changes: DiffFileChange[]): DetectorResult | null {
  const paths: string[] = [];
  for (const change of changes) {
    if (change.changeType !== "deleted") continue;
    if (!isTestPath(change.path)) continue;
    paths.push(change.path);
  }
  if (paths.length === 0) return null;
  return {
    signalId: "TI-06",
    threatClass: "test-case-removal",
    detector: "diff-name-status",
    value: { deletedTestFiles: paths.length, matchedPaths: paths.length },
    paths,
    matchedLines: paths,
  };
}

function detectTi07(changes: DiffFileChange[]): DetectorResult | null {
  let added = 0;
  let removed = 0;
  const paths: string[] = [];
  const matched: string[] = [];
  for (const change of changes) {
    if (!isTestPath(change.path)) continue;
    let touched = false;
    for (const line of change.addedLines) {
      const n = countAssertions(line);
      if (n > 0) {
        added += n;
        matched.push(line);
        touched = true;
      }
    }
    for (const line of change.removedLines) {
      const n = countAssertions(line);
      if (n > 0) {
        removed += n;
        matched.push(line);
        touched = true;
      }
    }
    if (touched) paths.push(change.path);
  }
  const netRemoved = removed - added;
  if (netRemoved <= 0) return null;
  return {
    signalId: "TI-07",
    threatClass: "assertion-deletion",
    detector: "diff-token-scan",
    value: {
      addedAssertions: added,
      removedAssertions: removed,
      netRemoved,
      matchedPaths: paths.length,
    },
    paths,
    matchedLines: matched,
  };
}

function detectTi08(changes: DiffFileChange[]): DetectorResult | null {
  const snapshotPaths: string[] = [];
  let implementationFiles = 0;
  for (const change of changes) {
    if (isSnapshotPath(change.path)) {
      snapshotPaths.push(change.path);
      continue;
    }
    if (isTestPath(change.path) || isConfigPath(change.path)) continue;
    implementationFiles += 1;
  }
  if (snapshotPaths.length === 0 || implementationFiles === 0) return null;
  return {
    signalId: "TI-08",
    threatClass: "snapshot-churn",
    detector: "diff-path-scan",
    value: {
      snapshotFiles: snapshotPaths.length,
      implementationFiles,
      matchedPaths: snapshotPaths.length,
    },
    paths: snapshotPaths,
    matchedLines: snapshotPaths,
  };
}

function scriptsDiffer(
  base: Record<string, string> | null,
  head: Record<string, string> | null,
): boolean {
  if (base === null || head === null) return base !== head;
  return hash(base) !== hash(head);
}

function detectTi09(inputs: ScanInputs): DetectorResult | null {
  const configPaths: string[] = [];
  let packageChanged = false;
  for (const change of inputs.changes) {
    if (change.path === "package.json" || change.path.endsWith("/package.json"))
      packageChanged = true;
    if (isConfigPath(change.path)) configPaths.push(change.path);
  }
  const scriptsChanged =
    packageChanged && scriptsDiffer(inputs.baseScripts, inputs.headScripts);
  if (configPaths.length === 0 && !scriptsChanged) return null;
  const paths = [...configPaths];
  // The scripts comparison reads the root package.json only; nested package
  // manifests set packageChanged but their scripts are not parsed.
  if (scriptsChanged) paths.push("package.json");
  return {
    signalId: "TI-09",
    threatClass: "configured-check-weakening",
    detector: "config-diff-scan",
    value: {
      changedConfigFiles: configPaths.length,
      packageScriptsChanged: scriptsChanged ? 1 : 0,
      matchedPaths: paths.length,
    },
    paths,
    matchedLines: paths,
  };
}

/** Pure detection over a parsed diff. Returns one fired signal entry per
 * candidate that fired; a signal whose count is zero is intentionally omitted
 * (the `signalsEvaluated` denominator on the event still records that it was
 * evaluated). */
export function detectSignals(inputs: ScanInputs): TestIntegritySignal[] {
  const results = [
    detectTi05(inputs.changes),
    detectTi06(inputs.changes),
    detectTi07(inputs.changes),
    detectTi08(inputs.changes),
    detectTi09(inputs),
  ].filter((result): result is DetectorResult => result !== null);
  return results.map((result) => ({
    signalId: result.signalId,
    threatClass: result.threatClass,
    label: "advisory-interpretation" as const,
    computation: "deterministic" as const,
    detector: { name: result.detector, version: DETECTOR_VERSION },
    value: result.value,
    paths: boundedPaths(result.paths),
    matchDigest: matchDigest(result.matchedLines),
    note: null,
  }));
}

const MAX_SIGNALS = 32;

export interface EventMetadata {
  taskId: string;
  baseSha: string;
  headSha: string | null;
  worktreeDigest: string | null;
  attemptArtifactId: string | null;
  verificationArtifactId: string | null;
  note: string | null;
}

/** Assembles the append-on-create shadow event. `mode`/`enforcement` are fixed;
 * absent linkage is explicit null, never fabricated. */
export function buildTestIntegrityEvent(
  meta: EventMetadata,
  signals: TestIntegritySignal[],
  now = new Date(),
): TestIntegrityEvent {
  if (!/^[0-9a-f]{40}$/u.test(meta.baseSha))
    throw new RigorError(
      "baseSha must be a 40-hex commit sha",
      EXIT.inputError,
    );
  if (meta.headSha !== null && !/^[0-9a-f]{40}$/u.test(meta.headSha))
    throw new RigorError(
      "headSha must be a 40-hex commit sha",
      EXIT.inputError,
    );
  if (meta.headSha === null && meta.worktreeDigest === null)
    throw new RigorError(
      "worktreeDigest is required when headSha is null",
      EXIT.inputError,
    );
  const truncated = signals.length > MAX_SIGNALS;
  return {
    schemaVersion: TEST_INTEGRITY_EVENT_SCHEMA,
    artifactId: artifactId("test-integrity-event"),
    taskId: meta.taskId,
    createdAt: now.toISOString(),
    mode: "shadow",
    enforcement: "none",
    attemptArtifactId: meta.attemptArtifactId,
    verificationArtifactId: meta.verificationArtifactId,
    diff: {
      baseSha: meta.baseSha,
      headSha: meta.headSha,
      worktreeDigest: meta.headSha === null ? meta.worktreeDigest : null,
    },
    signalsEvaluated: [...EVALUATED_SIGNALS],
    evaluationManifest: EVALUATED_SIGNALS.map((signalId) => ({
      signalId,
      detector: { name: detectorName(signalId), version: DETECTOR_VERSION },
      candidateSetVersion: CANDIDATE_SET_VERSION,
      configurationDigest: DETECTOR_CONFIGURATION_DIGEST,
    })),
    provenance: "recorded",
    signals: signals.slice(0, MAX_SIGNALS),
    signalsTruncated: truncated,
    note: meta.note,
  };
}

function detectorName(signalId: TestIntegritySignalId): string {
  if (signalId === "TI-05") return "diff-token-scan";
  if (signalId === "TI-06") return "diff-name-status";
  if (signalId === "TI-07") return "diff-token-scan";
  if (signalId === "TI-08") return "diff-path-scan";
  return "config-diff-scan";
}

/** Parses package.json text into its `scripts` map, or null when absent or
 * unparseable — unknown is recorded, never guessed. */
export function parseScripts(
  text: string | null,
): Record<string, string> | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (scripts === null || typeof scripts !== "object") return null;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      scripts as Record<string, unknown>,
    ))
      if (typeof value === "string") result[key] = value;
    return result;
  } catch {
    return null;
  }
}

const IGNORED_EVIDENCE = [".rigor/evidence/", ".rigor/events.jsonl"];

export interface ScanOptions {
  task: string;
  base: string;
  /** A commit-ish to diff against, or null to diff the base against the current
   * (dirty) worktree. */
  head: string | null;
  attemptArtifactId: string | null;
  verificationArtifactId: string | null;
  note: string | null;
}

/**
 * Computes the diff (base..head, or base..worktree when `head` is null), runs
 * the five detectors, and assembles the shadow event. Reads only Git objects
 * and the worktree; it never reads or affects verification/attempt/review/CI
 * code paths.
 */
export async function scanTestIntegrity(
  root: string,
  options: ScanOptions,
  now = new Date(),
): Promise<TestIntegrityEvent> {
  const baseSha = await resolveCommit(root, options.base);
  const headSha =
    options.head === null ? null : await resolveCommit(root, options.head);
  const changes = await diffChanges(root, baseSha, headSha);
  const baseScripts = parseScripts(
    await showFile(root, baseSha, "package.json"),
  );
  let headScripts: Record<string, string> | null;
  if (headSha === null) {
    let text: string | null = null;
    try {
      text = await readFile(path.join(root, "package.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    headScripts = parseScripts(text);
  } else {
    headScripts = parseScripts(await showFile(root, headSha, "package.json"));
  }
  const signals = detectSignals({ changes, baseScripts, headScripts });
  const worktreeDigest =
    headSha === null ? await treeHash(root, IGNORED_EVIDENCE) : null;
  return buildTestIntegrityEvent(
    {
      taskId: options.task,
      baseSha,
      headSha,
      worktreeDigest,
      attemptArtifactId: options.attemptArtifactId,
      verificationArtifactId: options.verificationArtifactId,
      note: options.note,
    },
    signals,
    now,
  );
}

// ---------------------------------------------------------------------------
// event / classification parsing
// ---------------------------------------------------------------------------

const VERDICTS: readonly TestIntegrityVerdict[] = [
  "true-positive",
  "false-positive",
  "uncertain",
] as const;

const SIGNAL_IDS: readonly TestIntegritySignalId[] = EVALUATED_SIGNALS;

export function parseTestIntegrityEvent(value: unknown): TestIntegrityEvent {
  const item = record(value, "test-integrity event");
  if (item.schemaVersion !== TEST_INTEGRITY_EVENT_SCHEMA)
    throw new RigorError(
      "Unsupported test-integrity event schema",
      EXIT.inputError,
    );
  taskId(item.taskId);
  textField(item.artifactId, "event.artifactId", 128);
  if (!Array.isArray(item.signals))
    throw new RigorError("event.signals must be an array", EXIT.inputError);
  if (!Array.isArray(item.signalsEvaluated))
    throw new RigorError(
      "event.signalsEvaluated must be an array",
      EXIT.inputError,
    );
  return item as unknown as TestIntegrityEvent;
}

function parseVerdictEntry(
  value: unknown,
  index: number,
): TestIntegrityClassificationInput["verdicts"][number] {
  const item = record(value, `verdicts[${index}]`);
  const signalId = textField(item.signalId, `verdicts[${index}].signalId`, 32);
  if (!SIGNAL_IDS.includes(signalId as TestIntegritySignalId))
    throw new RigorError(
      `verdicts[${index}].signalId is not a known signal`,
      EXIT.inputError,
    );
  if (
    typeof item.verdict !== "string" ||
    !VERDICTS.includes(item.verdict as TestIntegrityVerdict)
  )
    throw new RigorError(
      `verdicts[${index}].verdict is invalid`,
      EXIT.inputError,
    );
  const entry: TestIntegrityClassificationInput["verdicts"][number] = {
    signalId: signalId as TestIntegritySignalId,
    verdict: item.verdict as TestIntegrityVerdict,
  };
  if (item.note !== undefined)
    entry.note = textField(item.note, `verdicts[${index}].note`, 200);
  return entry;
}

export function parseClassificationInput(
  value: unknown,
): TestIntegrityClassificationInput {
  const item = record(value, "classification input");
  if (item.schemaVersion !== TEST_INTEGRITY_CLASSIFICATION_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported classification input schema",
      EXIT.inputError,
    );
  if (item.classifiedBy !== "human")
    throw new RigorError("classifiedBy must be human", EXIT.inputError);
  if (!Array.isArray(item.verdicts) || item.verdicts.length === 0)
    throw new RigorError("verdicts must be a non-empty array", EXIT.inputError);
  if (item.verdicts.length > MAX_SIGNALS)
    throw new RigorError("too many verdicts", EXIT.inputError);
  return {
    schemaVersion: TEST_INTEGRITY_CLASSIFICATION_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    eventArtifactId: textField(item.eventArtifactId, "eventArtifactId", 128),
    verdicts: item.verdicts.map(parseVerdictEntry),
    classifiedBy: "human",
  };
}

/**
 * Records a human-reported classification beside an event. Event linkage
 * (taskId, eventArtifactId) is copied from the event artifact, never trusted
 * from the input; the input's copies must agree or the call fails closed. Every
 * verdict must name a signal actually present in the event. `classifiedBy` is a
 * recorded declaration, not attested identity, and satisfies no control.
 */
export function createClassification(
  input: TestIntegrityClassificationInput,
  event: TestIntegrityEvent,
  now = new Date(),
): TestIntegrityClassification {
  if (input.taskId !== event.taskId)
    throw new RigorError(
      "Classification taskId does not match the event",
      EXIT.policyViolation,
    );
  if (input.eventArtifactId !== event.artifactId)
    throw new RigorError(
      "Classification eventArtifactId does not match the event",
      EXIT.policyViolation,
    );
  const firedSignals = new Set(event.signals.map((signal) => signal.signalId));
  for (const verdict of input.verdicts)
    if (!firedSignals.has(verdict.signalId))
      throw new RigorError(
        `verdict names a signal not present in the event: ${verdict.signalId}`,
        EXIT.policyViolation,
      );
  return {
    schemaVersion: TEST_INTEGRITY_CLASSIFICATION_SCHEMA,
    artifactId: artifactId("test-integrity-classification"),
    taskId: event.taskId,
    createdAt: now.toISOString(),
    eventArtifactId: event.artifactId,
    classifiedBy: "human",
    verdicts: input.verdicts.map((verdict) => ({
      signalId: verdict.signalId,
      verdict: verdict.verdict,
      note: verdict.note ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// unfinished-attempt guard (mirrors attempt-start's attempt-session detection)
// ---------------------------------------------------------------------------

/**
 * True when the task has an attempt-session artifact with no corresponding
 * finalized attempt artifact — i.e. an attempt is in progress. Mirrors the
 * detection attempt-start uses (an attempt.v1 references its session via
 * sessionArtifactId). The classify command refuses while this holds so a
 * delegated model cannot confirm its own observation mid-attempt.
 */
export async function hasUnfinishedAttempt(
  root: string,
  task: string,
): Promise<boolean> {
  const directory = path.join(root, ".rigor", "evidence", task, "attempts");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const sessions = new Set<string>();
  const finished = new Set<string>();
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    let item: Record<string, unknown>;
    try {
      item = record(
        JSON.parse(
          await readFile(path.join(directory, name), "utf8"),
        ) as unknown,
        "attempt artifact",
      );
    } catch {
      throw new RigorError(
        `Invalid attempt artifact: ${name}`,
        EXIT.inputError,
      );
    }
    if (item.schemaVersion === ATTEMPT_SESSION_SCHEMA)
      sessions.add(textField(item.artifactId, "artifactId", 128));
    if (item.schemaVersion === ATTEMPT_SCHEMA)
      finished.add(textField(item.sessionArtifactId, "sessionArtifactId", 128));
  }
  return [...sessions].some((id) => !finished.has(id));
}
