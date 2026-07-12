// Deterministic failure fingerprinting and cross-attempt progress comparison.
//
// This module is pure: no I/O, no Date.now(), no randomness. Every function is a
// total function of its arguments. It never persists or returns raw command
// output; callers must discard the raw text after deriving CheckFacts from it.
//
// normalizeSignature() bounds and normalizes free-form check output into a small
// set of "signal" lines so that cosmetically different but substantively
// identical failures hash to the same digest. normalizeTestName() applies the
// same noise masks (via the shared applyNoiseMasks() helper) to individual
// failed-test names before they are sorted, deduped, and persisted in
// failedTests, so a test title embedding a per-run uuid/timestamp/path never
// survives verbatim and two runs that differ only in that noise still
// fingerprint identically.
//
// applyNoiseMasks() is applied, in order, as:
//   1. Strip ANSI escape sequences.
//   2. Replace UUIDs (8-4-4-4-12 hex) with `<uuid>`.
//   3. Replace ISO-8601 timestamps with `<ts>`, then bare `HH:MM:SS` clock
//      times with `<time>`.
//   4. Replace durations such as `12ms`, `1.5s`, `2m` with `<dur>`.
//   5. Replace `0x`-prefixed hex literals with `<hex>`.
//   6. Replace Windows drive-letter paths, then POSIX absolute/relative file
//      paths, with `<path>` -- BEFORE the standalone hex-run mask below, so a
//      path segment that happens to be an 8+ character hex run still masks
//      fully as `<path>` rather than partially as `/var/<hex>/...`.
//   7. Replace standalone hex runs of 8+ characters with `<hex>`.
//   8. Replace trailing `:line` / `:line:col` numeric suffixes with `:<n>`.
//
// normalizeSignature() additionally, after applyNoiseMasks():
//   9. Splits into lines; trims and collapses internal whitespace runs to a
//      single space; drops lines that become empty.
//   10. Keeps only "signal" lines that look like they carry failure
//       information (error/fail/expect/received/assert/"not ok"/cross
//       marks/"at ").
//   11. Caps to the first 40 signal lines, then dedupes exact repeats
//       (preserving the order of first occurrence).
//
// normalizeTestName() instead, after applyNoiseMasks(), strips a trailing
// `(duration)` suffix, collapses whitespace, and bounds the result to 200
// characters.
//
// The model-supplied `failureClass` on `AttemptResultInput`/`Attempt` is kept
// entirely separate from the fields derived here: it is speculation recorded
// for human review, never an input to deterministic derivation.

import { hash } from "./util.js";

export type FailureCategory =
  | "implementation"
  | "infrastructure"
  | "timeout"
  | "flaky";

export interface TestStats {
  total: number;
  passed: number;
  failed: number;
}

export interface CheckFailure {
  category: FailureCategory;
  errorClass: string;
  /** Normalized, sorted, deduped test names; at most 50 entries. */
  failedTests: string[];
  /** hash(normalizeSignature(output).join("\n")); no raw text is stored. */
  signatureDigest: string;
  /** hash({ checkId, category, errorClass, failedTests, signatureDigest }) */
  fingerprint: string;
}

/**
 * One entry per check observed in a verification (passing or not). The next
 * attempt's finalization compares its CheckFacts[] against this attempt's.
 */
export interface CheckFacts {
  checkId: string;
  status: "passed" | "failed" | "timed_out" | "error";
  testStats: TestStats | null;
  /** null when status === "passed" */
  failure: CheckFailure | null;
}

export type ProgressStatus =
  | "first"
  | "unchanged"
  | "reduced"
  | "expanded"
  | "incomparable";

export interface ProgressComparison {
  status: ProgressStatus;
  /** Filled in by the caller (attempt.ts); null when status is "first". */
  comparedToAttemptArtifactId: string | null;
  weakeningSignals: string[];
}

// ---------------------------------------------------------------------------
// normalizeSignature
// ---------------------------------------------------------------------------

// Built from character codes (rather than literal control characters or
// backslash-u escapes) so the source file never embeds a raw control byte.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(
  ESC +
    "\\[[0-9;]*[a-zA-Z]|" +
    ESC +
    "\\][^" +
    BEL +
    "]*" +
    BEL +
    "|" +
    ESC +
    "[@-Z\\\\\\]^_]",
  "g",
);
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP_RE =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const CLOCK_TIME_RE = /\b\d{2}:\d{2}:\d{2}\b/g;
const DURATION_RE = /\b\d+(?:\.\d+)?(?:ms|s|m)\b/g;
const HEX_PREFIXED_RE = /0x[0-9a-fA-F]+/g;
const HEX_RUN_RE = /\b[0-9a-fA-F]{8,}\b/g;
const WINDOWS_PATH_RE = /[A-Za-z]:\\(?:[\w.@+-]+\\)*[\w.@+-]+\.[A-Za-z0-9]+/g;
const POSIX_PATH_RE = /(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]+/g;
const LINE_COL_RE = /:\d+(?::\d+)?/g;
const SIGNAL_RE = /error|fail|expect|received|assert|not ok|✖|✗|✘|\bat /iu;

function dedupePreserveOrder(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      result.push(line);
    }
  }
  return result;
}

/**
 * Shared noise-normalization pass used by both normalizeSignature() (over
 * whole check output) and normalizeTestName() (over individual failed-test
 * names extracted from that output). See the order documented at the top of
 * this file. Path masking runs before the standalone hex-run mask so a path
 * segment made of 8+ hex characters is captured whole as `<path>` rather
 * than partially replaced, leaving a mixed `/var/<hex>/...` result.
 */
function applyNoiseMasks(text: string): string {
  let normalized = text;
  normalized = normalized.replace(ANSI_RE, "");
  normalized = normalized.replace(UUID_RE, "<uuid>");
  normalized = normalized.replace(ISO_TIMESTAMP_RE, "<ts>");
  normalized = normalized.replace(CLOCK_TIME_RE, "<time>");
  normalized = normalized.replace(DURATION_RE, "<dur>");
  normalized = normalized.replace(HEX_PREFIXED_RE, "<hex>");
  normalized = normalized.replace(WINDOWS_PATH_RE, "<path>");
  normalized = normalized.replace(POSIX_PATH_RE, "<path>");
  normalized = normalized.replace(HEX_RUN_RE, "<hex>");
  normalized = normalized.replace(LINE_COL_RE, ":<n>");
  return normalized;
}

export function normalizeSignature(text: string): string[] {
  const normalized = applyNoiseMasks(text);
  const lines = normalized
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .filter((line) => line.length > 0);
  const signalLines = lines.filter((line) => SIGNAL_RE.test(line));
  const capped = signalLines.slice(0, 40);
  return dedupePreserveOrder(capped);
}

// ---------------------------------------------------------------------------
// testStats parsing
// ---------------------------------------------------------------------------

const NODE_TEST_TOTAL_RE = /^# tests (\d+)/m;
const NODE_TEST_PASS_RE = /^# pass (\d+)/m;
const NODE_TEST_FAIL_RE = /^# fail (\d+)/m;

function parseNodeTestSummary(output: string): TestStats | null {
  const total = NODE_TEST_TOTAL_RE.exec(output)?.[1];
  const passed = NODE_TEST_PASS_RE.exec(output)?.[1];
  const failed = NODE_TEST_FAIL_RE.exec(output)?.[1];
  if (total === undefined || passed === undefined || failed === undefined)
    return null;
  return {
    total: Number(total),
    passed: Number(passed),
    failed: Number(failed),
  };
}

const JEST_SUMMARY_RE = /Tests:\s*([^\n]+)/i;
const JEST_SEGMENT_RE = /(\d+)\s*(failed|passed|total|skipped|todo)/i;
type JestLabel = "failed" | "passed" | "total" | "skipped" | "todo";

function parseJestSummary(output: string): TestStats | null {
  const segment = JEST_SUMMARY_RE.exec(output)?.[1];
  if (segment === undefined) return null;
  const counts: Partial<Record<JestLabel, number>> = {};
  for (const part of segment.split(",")) {
    const match = JEST_SEGMENT_RE.exec(part.trim());
    const value = match?.[1];
    const label = match?.[2];
    if (value !== undefined && label !== undefined)
      counts[label.toLowerCase() as JestLabel] = Number(value);
  }
  if (counts.total === undefined) return null;
  const failed = counts.failed ?? 0;
  const passed = counts.passed ?? counts.total - failed;
  return { total: counts.total, passed, failed };
}

function parseTestStats(output: string): TestStats | null {
  return parseNodeTestSummary(output) ?? parseJestSummary(output);
}

// ---------------------------------------------------------------------------
// failure category / error class / failed-test extraction
// ---------------------------------------------------------------------------

// Matches only clear infrastructure signatures -- Node.js network error codes
// (with word boundaries so they cannot match inside a longer identifier) and
// specific phrases. Deliberately does NOT match bare words like "network" or
// bare numbers like "429": an implementation assertion such as "expected
// networkStatus to equal 2" or "expected HTTP 200 but got 429" must classify
// as `implementation`, not `infrastructure`.
const INFRA_PATTERN =
  /\b(?:ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|ECONNRESET|ENETDOWN)\b|getaddrinfo|socket hang up|rate limit|Too Many Requests|network is unreachable|network error/i;

function deriveCategory(
  status: CheckFacts["status"],
  normalizedText: string,
): FailureCategory {
  if (status === "timed_out") return "timeout";
  if (status === "error") return "infrastructure";
  return INFRA_PATTERN.test(normalizedText)
    ? "infrastructure"
    : "implementation";
}

const ERROR_CLASS_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["assertion", /AssertionError|assert|Expected|Received|toBe|to equal/i],
  ["type", /TypeError|error TS\d+|is not a function/i],
  ["syntax", /SyntaxError/i],
  ["reference", /ReferenceError/i],
  ["range", /RangeError/i],
  ["module", /Cannot find module|ERR_MODULE_NOT_FOUND/i],
  ["lint", /eslint|problems \(|✖ \d+ problems/i],
  ["timeout", /timed out|timeout/i],
  ["runtime", /Error/i],
];

function deriveErrorClass(normalizedText: string): string {
  for (const [label, pattern] of ERROR_CLASS_PATTERNS) {
    if (pattern.test(normalizedText)) return label;
  }
  return "unknown";
}

const FAILED_TEST_PATTERNS: readonly RegExp[] = [
  /^not ok \d+ - (.+)$/gm,
  /^\s*✗\s+(.+)$/gm,
  /^\s*✖\s+(.+)$/gm,
  /^FAIL\s+(.+)$/gm,
];

const TRAILING_DURATION_RE = /\s*\(\d+(?:\.\d+)?(?:ms|s|m)\)\s*$/u;
const MAX_TEST_NAME_LENGTH = 200;

function normalizeTestName(name: string): string {
  // Strip the trailing `(duration)` suffix first, then apply the same noise
  // masks used on whole check output so a uuid/timestamp/path/hex id
  // embedded in a test title never survives into failedTests verbatim and
  // two runs differing only in that noise still fingerprint identically.
  const withoutDuration = name.replace(TRAILING_DURATION_RE, "");
  const masked = applyNoiseMasks(withoutDuration).replace(/\s+/gu, " ").trim();
  return masked.slice(0, MAX_TEST_NAME_LENGTH);
}

function extractFailedTests(output: string): string[] {
  const names: string[] = [];
  for (const pattern of FAILED_TEST_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      const raw = match[1];
      if (raw !== undefined) names.push(normalizeTestName(raw));
    }
  }
  names.sort();
  return [...new Set(names)].slice(0, 50);
}

// ---------------------------------------------------------------------------
// deriveCheckFacts
// ---------------------------------------------------------------------------

export function deriveCheckFacts(input: {
  checkId: string;
  status: CheckFacts["status"];
  exitCode: number | null;
  output: string;
}): CheckFacts {
  const { checkId, status, output } = input;
  const testStats = parseTestStats(output);
  if (status === "passed") {
    return { checkId, status, testStats, failure: null };
  }
  const normalizedText = normalizeSignature(output).join("\n");
  const category = deriveCategory(status, normalizedText);
  const errorClass = deriveErrorClass(normalizedText);
  const failedTests = extractFailedTests(output);
  const signatureDigest = hash(normalizedText);
  const fingerprint = hash({
    checkId,
    category,
    errorClass,
    failedTests,
    signatureDigest,
  });
  return {
    checkId,
    status,
    testStats,
    failure: {
      category,
      errorClass,
      failedTests,
      signatureDigest,
      fingerprint,
    },
  };
}

// ---------------------------------------------------------------------------
// verification-level aggregation
// ---------------------------------------------------------------------------

export function verificationFingerprint(facts: CheckFacts[]): string | null {
  const failing = facts.filter(
    (fact): fact is CheckFacts & { failure: CheckFailure } =>
      fact.failure !== null,
  );
  if (failing.length === 0) return null;
  // A plain code-unit comparator (not localeCompare) keeps the aggregate
  // fingerprint identical across locales and CI machines.
  const sorted = [...failing].sort((a, b) =>
    a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0,
  );
  return hash(sorted.map((fact) => fact.failure.fingerprint));
}

export function aggregateCategory(
  facts: CheckFacts[],
): FailureCategory | "mixed" | null {
  const categories = facts
    .filter(
      (fact): fact is CheckFacts & { failure: CheckFailure } =>
        fact.failure !== null,
    )
    .map((fact) => fact.failure.category);
  if (categories.length === 0) return null;
  const unique = new Set(categories);
  if (unique.size === 1) {
    const [only] = unique;
    if (only !== undefined) return only;
  }
  return "mixed";
}

// ---------------------------------------------------------------------------
// cross-attempt progress comparison
// ---------------------------------------------------------------------------

interface ImplFailure {
  fingerprint: string;
  failedTests: Set<string>;
}

function implFailureMap(facts: CheckFacts[]): Map<string, ImplFailure> {
  const map = new Map<string, ImplFailure>();
  for (const fact of facts) {
    if (fact.failure !== null && fact.failure.category === "implementation") {
      map.set(fact.checkId, {
        fingerprint: fact.failure.fingerprint,
        failedTests: new Set(fact.failure.failedTests),
      });
    }
  }
  return map;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function isSubset<T>(subset: Set<T>, superset: Set<T>): boolean {
  for (const value of subset) if (!superset.has(value)) return false;
  return true;
}

/** checkIds that were implementation-failing in `prevImpl` and are not
 * implementation-failing in `curImpl` -- i.e. resolved, whether because the
 * check now passes or because it is entirely absent from `current`. */
function resolvedImplCheckIds(
  prevImpl: Map<string, ImplFailure>,
  curImpl: Map<string, ImplFailure>,
): string[] {
  return [...prevImpl.keys()].filter((checkId) => !curImpl.has(checkId));
}

/**
 * For every resolved implementation-category check, require positive
 * confirmation that test coverage did not shrink: both the prior and current
 * CheckFacts for that checkId must carry parseable `testStats`, and the
 * current total must be >= the prior total. Without this, an unparseable
 * runner (testStats null) could make a hidden regression -- failing tests
 * deleted or weakened rather than fixed -- look identical to genuine
 * progress, which would violate the constraint that regressions cannot be
 * hidden by deleting or weakening tests.
 */
function confirmCoverageForResolvedChecks(
  resolvedCheckIds: readonly string[],
  previousByCheck: Map<string, CheckFacts>,
  currentByCheck: Map<string, CheckFacts>,
): string[] {
  const signals: string[] = [];
  for (const checkId of resolvedCheckIds) {
    const priorStats = previousByCheck.get(checkId)?.testStats ?? null;
    const curStats = currentByCheck.get(checkId)?.testStats ?? null;
    const confirmed =
      priorStats !== null &&
      curStats !== null &&
      curStats.total >= priorStats.total;
    if (!confirmed) {
      signals.push(
        `check ${checkId}: cannot confirm test coverage did not shrink (no parseable test counts)`,
      );
    }
  }
  return signals;
}

/**
 * A candidate `reduced` result is fail-closed: it is only reported once
 * every resolved implementation check has positive test-coverage
 * confirmation (see confirmCoverageForResolvedChecks). Otherwise -- or when
 * an existing weakening signal already fired -- the result is
 * `incomparable`, never `reduced`.
 */
function reducedOrIncomparable(
  prevImpl: Map<string, ImplFailure>,
  curImpl: Map<string, ImplFailure>,
  weakeningSignals: string[],
  previousByCheck: Map<string, CheckFacts>,
  currentByCheck: Map<string, CheckFacts>,
): { status: ProgressStatus; weakeningSignals: string[] } {
  if (weakeningSignals.length > 0) {
    return { status: "incomparable", weakeningSignals };
  }
  const coverageSignals = confirmCoverageForResolvedChecks(
    resolvedImplCheckIds(prevImpl, curImpl),
    previousByCheck,
    currentByCheck,
  );
  if (coverageSignals.length === 0) {
    return { status: "reduced", weakeningSignals };
  }
  return {
    status: "incomparable",
    weakeningSignals: [...weakeningSignals, ...coverageSignals],
  };
}

export function compareFailures(
  previous: CheckFacts[] | null,
  current: CheckFacts[],
): { status: ProgressStatus; weakeningSignals: string[] } {
  if (previous === null || previous.length === 0) {
    return { status: "first", weakeningSignals: [] };
  }

  const weakeningSignals: string[] = [];
  const currentByCheck = new Map(current.map((fact) => [fact.checkId, fact]));
  const previousByCheck = new Map(previous.map((fact) => [fact.checkId, fact]));
  for (const prevFact of previous) {
    const curFact = currentByCheck.get(prevFact.checkId);
    if (curFact === undefined) {
      weakeningSignals.push(
        `check ${prevFact.checkId}: no longer present in verification`,
      );
      continue;
    }
    if (
      prevFact.testStats !== null &&
      curFact.testStats !== null &&
      curFact.testStats.total < prevFact.testStats.total
    ) {
      weakeningSignals.push(
        `check ${prevFact.checkId}: observed test total dropped from ${prevFact.testStats.total} to ${curFact.testStats.total}`,
      );
    }
  }

  const prevImpl = implFailureMap(previous);
  const curImpl = implFailureMap(current);
  const prevImplEmpty = prevImpl.size === 0;
  const curImplEmpty = curImpl.size === 0;

  if (!prevImplEmpty && curImplEmpty) {
    return reducedOrIncomparable(
      prevImpl,
      curImpl,
      weakeningSignals,
      previousByCheck,
      currentByCheck,
    );
  }
  if (prevImplEmpty) {
    // Either both sides have no implementation-category failure (nothing to
    // compare), or only the current side does (no impl baseline on prev
    // side) -- either way there is no impl-failure loop to confirm.
    return { status: "incomparable", weakeningSignals };
  }

  const prevFingerprints = new Set(
    [...prevImpl.values()].map((value) => value.fingerprint),
  );
  const curFingerprints = new Set(
    [...curImpl.values()].map((value) => value.fingerprint),
  );
  const sameKeys =
    prevImpl.size === curImpl.size &&
    [...prevImpl.keys()].every((key) => curImpl.has(key));
  const sameFailedTests =
    sameKeys &&
    [...prevImpl.entries()].every(([key, value]) => {
      const curValue = curImpl.get(key);
      return (
        curValue !== undefined &&
        setsEqual(value.failedTests, curValue.failedTests)
      );
    });

  if (setsEqual(prevFingerprints, curFingerprints) && sameFailedTests) {
    return { status: "unchanged", weakeningSignals };
  }

  const curStrictSubsetOfPrev =
    curFingerprints.size < prevFingerprints.size &&
    isSubset(curFingerprints, prevFingerprints);
  if (curStrictSubsetOfPrev) {
    return reducedOrIncomparable(
      prevImpl,
      curImpl,
      weakeningSignals,
      previousByCheck,
      currentByCheck,
    );
  }

  const prevStrictSubsetOfCur =
    prevFingerprints.size < curFingerprints.size &&
    isSubset(prevFingerprints, curFingerprints);
  const newFailingAppeared =
    [...curImpl.keys()].some((key) => !prevImpl.has(key)) ||
    [...curImpl.entries()].some(([key, value]) => {
      const prevValue = prevImpl.get(key);
      if (prevValue === undefined) return false;
      for (const test of value.failedTests)
        if (!prevValue.failedTests.has(test)) return true;
      return false;
    });
  if (prevStrictSubsetOfCur || newFailingAppeared) {
    return { status: "expanded", weakeningSignals };
  }

  return { status: "incomparable", weakeningSignals };
}
