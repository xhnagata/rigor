import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateCategory,
  compareFailures,
  deriveCheckFacts,
  normalizeSignature,
  verificationFingerprint,
  type CheckFacts,
} from "../src/fingerprint.js";

const ESC = String.fromCharCode(27);

test("normalizeSignature strips ANSI, timestamps, uuids, hex ids, durations, and paths", () => {
  const withNoise = `${ESC}[31mAssertionError${ESC}[0m: expected 1 to equal 2
    at /Users/alice/project/src/foo.ts:12:5
    at Object.<anonymous> (/Users/alice/project/test/foo.test.ts:20:3)
duration: 123ms
id: 550e8400-e29b-41d4-a716-446655440000
hex: deadbeefcafebabe
time: 2026-07-11T10:20:30.123Z
`;
  const otherNoise = `AssertionError: expected 1 to equal 2
    at /home/bob/other/src/foo.ts:99:1
    at Object.<anonymous> (/home/bob/other/test/foo.test.ts:200:9)
duration: 4.2s
id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
hex: 1234567890abcdef
time: 2020-01-01T00:00:00.000Z
`;
  assert.deepEqual(
    normalizeSignature(withNoise),
    normalizeSignature(otherNoise),
  );
  // The duration/id/hex/time-only lines carry no failure signal and are dropped.
  assert.deepEqual(normalizeSignature(withNoise), [
    "AssertionError: expected 1 to equal 2",
    "at /<path>:<n>",
    "at Object.<anonymous> (/<path>:<n>)",
  ]);
});

test("normalizeSignature: a path segment that is itself an 8+ char hex run still masks fully as <path> (path masking runs before the hex-run mask)", () => {
  const output = "Error: open /var/deadbeef01/cache.log failed\n";
  assert.deepEqual(normalizeSignature(output), ["Error: open /<path> failed"]);
});

test("deriveCheckFacts: identical failure modulo paths/timestamps/uuids/hex/durations fingerprints identically", () => {
  const withNoise = `${ESC}[31mAssertionError${ESC}[0m: expected 1 to equal 2
    at /Users/alice/project/src/foo.ts:12:5
`;
  const otherNoise = `AssertionError: expected 1 to equal 2
    at /home/bob/other/src/foo.ts:99:1
`;
  const a = deriveCheckFacts({
    checkId: "unit",
    status: "failed",
    exitCode: 1,
    output: withNoise,
  });
  const b = deriveCheckFacts({
    checkId: "unit",
    status: "failed",
    exitCode: 1,
    output: otherNoise,
  });
  assert.ok(a.failure);
  assert.ok(b.failure);
  assert.equal(a.failure!.signatureDigest, b.failure!.signatureDigest);
  assert.equal(a.failure!.fingerprint, b.failure!.fingerprint);
});

test("deriveCheckFacts: genuinely different failures fingerprint differently", () => {
  const a = deriveCheckFacts({
    checkId: "unit",
    status: "failed",
    exitCode: 1,
    output: "AssertionError: expected 1 to equal 2\n    at /a/foo.ts:1:1\n",
  });
  const b = deriveCheckFacts({
    checkId: "unit",
    status: "failed",
    exitCode: 1,
    output: "TypeError: x is not a function\n    at /a/bar.ts:1:1\n",
  });
  assert.notEqual(a.failure!.fingerprint, b.failure!.fingerprint);
  assert.notEqual(a.failure!.signatureDigest, b.failure!.signatureDigest);
});

test("failedTests extraction is normalized, sorted, deduped, and capped", () => {
  const output = `TAP version 13
not ok 1 - zeta test (12ms)
not ok 2 - alpha test
not ok 2 - alpha test
✗ beta test (1.5s)
# tests 3
# pass 0
# fail 3
`;
  const facts = deriveCheckFacts({
    checkId: "node-test",
    status: "failed",
    exitCode: 1,
    output,
  });
  assert.deepEqual(facts.failure!.failedTests, [
    "alpha test",
    "beta test",
    "zeta test",
  ]);
  assert.ok(facts.failure!.failedTests.length <= 50);
});

test("failedTests: a uuid/path embedded in a test title is noise-masked, not stored raw", () => {
  const facts = deriveCheckFacts({
    checkId: "unit",
    status: "failed",
    exitCode: 1,
    output: "not ok 1 - handles request 550e8400-e29b-41d4-a716-446655440000\n",
  });
  assert.deepEqual(facts.failure!.failedTests, ["handles request <uuid>"]);
  const serialized = JSON.stringify(facts);
  assert.ok(!serialized.includes("550e8400-e29b-41d4-a716-446655440000"));
});

test("failedTests: names differing only by an embedded uuid/path are masked identically, so the fingerprint matches across runs", () => {
  const a = deriveCheckFacts({
    checkId: "unit",
    status: "failed",
    exitCode: 1,
    output:
      "not ok 1 - handles request 550e8400-e29b-41d4-a716-446655440000 at /Users/alice/project/src/foo.ts\n",
  });
  const b = deriveCheckFacts({
    checkId: "unit",
    status: "failed",
    exitCode: 1,
    output:
      "not ok 1 - handles request aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee at /home/bob/other/src/foo.ts\n",
  });
  assert.deepEqual(a.failure!.failedTests, b.failure!.failedTests);
  assert.equal(a.failure!.fingerprint, b.failure!.fingerprint);
});

test("failedTests: normalized names are bounded to 200 characters", () => {
  const longName = "x".repeat(500);
  const facts = deriveCheckFacts({
    checkId: "unit",
    status: "failed",
    exitCode: 1,
    output: `not ok 1 - ${longName}\n`,
  });
  assert.equal(facts.failure!.failedTests.length, 1);
  assert.ok(facts.failure!.failedTests[0]!.length <= 200);
});

test("failedTests caps at 50 entries", () => {
  const lines = Array.from(
    { length: 75 },
    (_, index) => `not ok ${index} - test number ${index}`,
  ).join("\n");
  const facts = deriveCheckFacts({
    checkId: "node-test",
    status: "failed",
    exitCode: 1,
    output: lines,
  });
  assert.equal(facts.failure!.failedTests.length, 50);
});

test("testStats parses node:test TAP summaries", () => {
  const output = `TAP version 13
not ok 1 - foo
# tests 5
# pass 4
# fail 1
`;
  const facts = deriveCheckFacts({
    checkId: "node-test",
    status: "failed",
    exitCode: 1,
    output,
  });
  assert.deepEqual(facts.testStats, { total: 5, passed: 4, failed: 1 });
});

test("testStats parses jest-like summaries", () => {
  const output = "Tests:       2 failed, 3 passed, 5 total\nFAIL some/test.js";
  const facts = deriveCheckFacts({
    checkId: "jest",
    status: "failed",
    exitCode: 1,
    output,
  });
  assert.deepEqual(facts.testStats, { total: 5, passed: 3, failed: 2 });
});

test("testStats is null for unrecognized output", () => {
  const facts = deriveCheckFacts({
    checkId: "lint",
    status: "failed",
    exitCode: 1,
    output: "some random tool output with no summary line",
  });
  assert.equal(facts.testStats, null);
});

test("passing checks retain testStats but have a null failure", () => {
  const facts = deriveCheckFacts({
    checkId: "node-test",
    status: "passed",
    exitCode: 0,
    output: "# tests 5\n# pass 5\n# fail 0\n",
  });
  assert.equal(facts.failure, null);
  assert.deepEqual(facts.testStats, { total: 5, passed: 5, failed: 0 });
});

test("category: timed_out maps to timeout regardless of output", () => {
  const facts = deriveCheckFacts({
    checkId: "slow",
    status: "timed_out",
    exitCode: null,
    output: "AssertionError: expected 1 to equal 2",
  });
  assert.equal(facts.failure!.category, "timeout");
});

test("category: error status maps to infrastructure", () => {
  const facts = deriveCheckFacts({
    checkId: "spawn",
    status: "error",
    exitCode: null,
    output: "spawn-error",
  });
  assert.equal(facts.failure!.category, "infrastructure");
});

test("category: network error text maps a failed check to infrastructure", () => {
  const facts = deriveCheckFacts({
    checkId: "net",
    status: "failed",
    exitCode: 1,
    output: "Error: connect ECONNREFUSED 127.0.0.1:5432",
  });
  assert.equal(facts.failure!.category, "infrastructure");
});

test("category: assertion failure maps to implementation, never flaky", () => {
  const facts = deriveCheckFacts({
    checkId: "unit",
    status: "failed",
    exitCode: 1,
    output: "AssertionError: expected 1 to equal 2",
  });
  assert.equal(facts.failure!.category, "implementation");
  assert.notEqual(facts.failure!.category, "flaky");
});

test("category: bare 'network'/'429' substrings never misclassify an implementation assertion as infrastructure", () => {
  const networkAssertion = deriveCheckFacts({
    checkId: "unit",
    status: "failed",
    exitCode: 1,
    output: "AssertionError: expected networkStatus to equal 2",
  });
  assert.equal(networkAssertion.failure!.category, "implementation");

  const statusCodeAssertion = deriveCheckFacts({
    checkId: "unit",
    status: "failed",
    exitCode: 1,
    output: "AssertionError: expected HTTP 200 but got 429",
  });
  assert.equal(statusCodeAssertion.failure!.category, "implementation");

  // A real infrastructure signature (Node error code with word boundaries)
  // still classifies as infrastructure.
  const infra = deriveCheckFacts({
    checkId: "net",
    status: "failed",
    exitCode: 1,
    output: "Error: connect ECONNREFUSED 127.0.0.1:5432",
  });
  assert.equal(infra.failure!.category, "infrastructure");
});

function implFailure(checkId: string, output: string): CheckFacts {
  return deriveCheckFacts({ checkId, status: "failed", exitCode: 1, output });
}

function implFailureWithStats(
  checkId: string,
  errorLine: string,
  stats: { total: number; passed: number; failed: number },
): CheckFacts {
  return deriveCheckFacts({
    checkId,
    status: "failed",
    exitCode: 1,
    output: `${errorLine}\n# tests ${stats.total}\n# pass ${stats.passed}\n# fail ${stats.failed}\n`,
  });
}

function passedFact(checkId: string, total: number): CheckFacts {
  return {
    checkId,
    status: "passed",
    testStats: { total, passed: total, failed: 0 },
    failure: null,
  };
}

test("compareFailures: no prior attempt yields first", () => {
  const current = [
    implFailure("unit", "AssertionError: expected 1 to equal 2"),
  ];
  assert.deepEqual(compareFailures(null, current), {
    status: "first",
    weakeningSignals: [],
  });
  assert.deepEqual(compareFailures([], current), {
    status: "first",
    weakeningSignals: [],
  });
});

test("compareFailures: identical implementation failure is unchanged", () => {
  const previous = [
    implFailure("unit", "AssertionError: expected 1 to equal 2"),
  ];
  const current = [
    implFailure("unit", "AssertionError: expected 1 to equal 2"),
  ];
  const result = compareFailures(previous, current);
  assert.equal(result.status, "unchanged");
  assert.deepEqual(result.weakeningSignals, []);
});

test("compareFailures: all implementation failures resolved is reduced (parseable coverage confirmed)", () => {
  // Fail-closed rule: `reduced` requires parseable testStats on both sides
  // confirming the observed total did not shrink, so a genuine fix (not a
  // deleted test) is what is being reported.
  const previous = [
    implFailureWithStats("unit", "AssertionError: expected 1 to equal 2", {
      total: 5,
      passed: 4,
      failed: 1,
    }),
  ];
  const current = [passedFact("unit", 5)];
  const result = compareFailures(previous, current);
  assert.equal(result.status, "reduced");
});

test("compareFailures: a subset of prior failures remaining is reduced (parseable coverage confirmed)", () => {
  const previous = [
    implFailure("unit-a", "AssertionError: expected 1 to equal 2"),
    implFailureWithStats("unit-b", "TypeError: x is not a function", {
      total: 5,
      passed: 4,
      failed: 1,
    }),
  ];
  // unit-b now passes; it must remain present (not vanish) or its absence
  // would itself be flagged as a weakening signal.
  const current = [
    implFailure("unit-a", "AssertionError: expected 1 to equal 2"),
    passedFact("unit-b", 5),
  ];
  const result = compareFailures(previous, current);
  assert.equal(result.status, "reduced");
  assert.deepEqual(result.weakeningSignals, []);
});

test("compareFailures: reduced is withheld (incomparable) when current test coverage is unparseable", () => {
  // Same shape as the "all resolved" case above, but the current run's
  // check produces no parseable test count -- e.g. an unparseable runner --
  // so a hidden regression (tests deleted rather than fixed) cannot be
  // ruled out, and `reduced` must not be reported.
  const previous = [
    implFailureWithStats("unit", "AssertionError: expected 1 to equal 2", {
      total: 5,
      passed: 3,
      failed: 2,
    }),
  ];
  const current: CheckFacts[] = [
    { checkId: "unit", status: "passed", testStats: null, failure: null },
  ];
  const result = compareFailures(previous, current);
  assert.equal(result.status, "incomparable");
  assert.equal(result.weakeningSignals.length, 1);
  assert.match(
    result.weakeningSignals[0]!,
    /unit: cannot confirm test coverage did not shrink/,
  );
});

test("compareFailures: subset reduction is withheld when a dropped check lacks parseable counts", () => {
  const previous = [
    implFailure("unit-a", "AssertionError: expected 1 to equal 2"),
    implFailure("unit-b", "TypeError: x is not a function"),
  ];
  // unit-b resolves to passing, but neither side ever had a parseable test
  // count for it, so coverage shrinkage cannot be ruled out.
  const current = [
    implFailure("unit-a", "AssertionError: expected 1 to equal 2"),
    passedFact("unit-b", 5),
  ];
  const result = compareFailures(previous, current);
  assert.equal(result.status, "incomparable");
  assert.equal(result.weakeningSignals.length, 1);
  assert.match(
    result.weakeningSignals[0]!,
    /unit-b: cannot confirm test coverage did not shrink/,
  );
});

test("compareFailures: a new implementation failure appearing is expanded", () => {
  const previous = [
    implFailure("unit-a", "AssertionError: expected 1 to equal 2"),
  ];
  const current = [
    implFailure("unit-a", "AssertionError: expected 1 to equal 2"),
    implFailure("unit-b", "TypeError: x is not a function"),
  ];
  const result = compareFailures(previous, current);
  assert.equal(result.status, "expanded");
});

test("compareFailures: an unrelated different failure is incomparable", () => {
  const previous = [
    implFailure("unit", "AssertionError: expected 1 to equal 2"),
  ];
  const current = [implFailure("unit", "TypeError: x is not a function")];
  const result = compareFailures(previous, current);
  assert.equal(result.status, "incomparable");
});

test("compareFailures: infrastructure-only failures never confirm a loop", () => {
  const previous = [
    deriveCheckFacts({
      checkId: "net",
      status: "failed",
      exitCode: 1,
      output: "Error: connect ECONNREFUSED 127.0.0.1:5432",
    }),
  ];
  const current = [
    deriveCheckFacts({
      checkId: "net",
      status: "failed",
      exitCode: 1,
      output: "Error: connect ECONNREFUSED 127.0.0.1:5432",
    }),
  ];
  const result = compareFailures(previous, current);
  assert.equal(result.status, "incomparable");
});

test("compareFailures: a dropped test total is a weakening signal and blocks reduced", () => {
  const previous = [
    deriveCheckFacts({
      checkId: "unit",
      status: "failed",
      exitCode: 1,
      output:
        "AssertionError: expected 1 to equal 2\n# tests 3\n# pass 0\n# fail 3\n",
    }),
  ];
  const current = [passedFact("unit", 1)];
  const result = compareFailures(previous, current);
  assert.equal(result.status, "incomparable");
  assert.equal(result.weakeningSignals.length, 1);
  assert.match(result.weakeningSignals[0]!, /dropped from 3 to 1/);
});

test("compareFailures: a check disappearing from the verification is a weakening signal", () => {
  const previous = [
    implFailure("unit", "AssertionError: expected 1 to equal 2"),
  ];
  const current: CheckFacts[] = [];
  const result = compareFailures(previous, current);
  assert.equal(result.weakeningSignals.length, 1);
  assert.match(result.weakeningSignals[0]!, /no longer present/);
  // Nothing implementation-category remains to compare on either side.
  assert.equal(result.status, "incomparable");
});

test("aggregateCategory: null when nothing failed, single category, and mixed", () => {
  assert.equal(aggregateCategory([passedFact("a", 1)]), null);
  assert.equal(
    aggregateCategory([
      implFailure("a", "AssertionError: expected 1 to equal 2"),
    ]),
    "implementation",
  );
  assert.equal(
    aggregateCategory([
      implFailure("a", "AssertionError: expected 1 to equal 2"),
      deriveCheckFacts({
        checkId: "b",
        status: "timed_out",
        exitCode: null,
        output: "",
      }),
    ]),
    "mixed",
  );
});

test("verificationFingerprint: null with no failures, stable regardless of check order", () => {
  assert.equal(verificationFingerprint([passedFact("a", 1)]), null);
  const a = implFailure("a", "AssertionError: expected 1 to equal 2");
  const b = implFailure("b", "TypeError: x is not a function");
  assert.equal(
    verificationFingerprint([a, b]),
    verificationFingerprint([b, a]),
  );
});
