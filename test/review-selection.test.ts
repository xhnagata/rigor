import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { main } from "../src/cli.js";
import { RigorError } from "../src/errors.js";
import { defaultPolicy } from "../src/setup.js";
import { writeJson } from "../src/util.js";
import {
  parseConsultationDecisionInput,
  selectConsultation,
} from "../src/review-selection.js";

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

function fixture(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof parseConsultationDecisionInput> {
  return parseConsultationDecisionInput({
    schemaVersion: "rigor.independent-review-input.v1",
    taskId: "GH-15",
    riskTier: "low",
    assessmentConfidence: "high",
    failureProgress: "none",
    fingerprintRepetitions: 0,
    concerns: { security: false, dataIntegrity: false },
    humanRequested: false,
    externalTransmission: "allowed",
    pluginAvailability: "available",
    policy: {
      unchangedFailureThreshold: 2,
      unavailableAction: "skip",
    },
    ...overrides,
  });
}

test("same validated review input produces the same decision", () => {
  const input = fixture({ riskTier: "high" });
  assert.deepEqual(selectConsultation(input), selectConsultation(input));
});

test("high and critical risk request independent review by default", () => {
  for (const [riskTier, reason] of [
    ["high", "HIGH_RISK"],
    ["critical", "CRITICAL_RISK"],
  ] as const) {
    const result = selectConsultation(fixture({ riskTier }));
    assert.equal(result.decision, "request-independent-review");
    assert.deepEqual(result.triggerReasons, [reason]);
    assert.equal(result.invocationAllowed, true);
    assert.equal(result.approvalEffect, "none");
  }
});

test("low risk does not request review without another trigger", () => {
  const result = selectConsultation(fixture());
  assert.equal(result.decision, "skip-independent-review");
  assert.equal(result.reasonCode, "NO_REVIEW_TRIGGER");
  assert.equal(result.invocationAllowed, false);
});

for (const [name, override, reason] of [
  [
    "low confidence",
    { assessmentConfidence: "low" },
    "LOW_ASSESSMENT_CONFIDENCE",
  ],
  [
    "repeated unchanged failure",
    { failureProgress: "unchanged", fingerprintRepetitions: 2 },
    "REPEATED_UNCHANGED_FAILURE",
  ],
  [
    "security concern",
    { concerns: { security: true, dataIntegrity: false } },
    "SECURITY_CONCERN",
  ],
  [
    "data integrity concern",
    { concerns: { security: false, dataIntegrity: true } },
    "DATA_INTEGRITY_CONCERN",
  ],
  ["human request", { humanRequested: true }, "HUMAN_REQUEST"],
] as const) {
  test(`${name} is an independent review trigger`, () => {
    const result = selectConsultation(fixture(override));
    assert.equal(result.decision, "request-independent-review");
    assert.deepEqual(result.triggerReasons, [reason]);
  });
}

test("trigger reasons use a fixed deterministic ordering", () => {
  const result = selectConsultation(
    fixture({
      riskTier: "critical",
      assessmentConfidence: "low",
      failureProgress: "unchanged",
      fingerprintRepetitions: 3,
      concerns: { security: true, dataIntegrity: true },
      humanRequested: true,
    }),
  );
  assert.deepEqual(result.triggerReasons, [
    "CRITICAL_RISK",
    "LOW_ASSESSMENT_CONFIDENCE",
    "REPEATED_UNCHANGED_FAILURE",
    "SECURITY_CONCERN",
    "DATA_INTEGRITY_CONCERN",
    "HUMAN_REQUEST",
  ]);
});

test("transmission denial is evaluated before a requested invocation", () => {
  const result = selectConsultation(
    fixture({
      riskTier: "critical",
      humanRequested: true,
      externalTransmission: "denied",
      pluginAvailability: "available",
      policy: { unchangedFailureThreshold: 2, unavailableAction: "stop" },
    }),
  );
  assert.equal(result.decision, "continue-claude-only");
  assert.equal(result.reasonCode, "EXTERNAL_TRANSMISSION_DENIED");
  assert.equal(result.invocationAllowed, false);
});

for (const pluginAvailability of [
  "unavailable",
  "unknown",
  "incompatible",
] as const) {
  for (const [unavailableAction, decision, reasonCode] of [
    ["skip", "skip-independent-review", "OPTIONAL_REVIEW_PLUGIN_UNAVAILABLE"],
    ["stop", "stop-required-review", "REQUIRED_REVIEW_PLUGIN_UNAVAILABLE"],
    [
      "continue-claude-only",
      "continue-claude-only",
      "CLAUDE_ONLY_PLUGIN_UNAVAILABLE",
    ],
  ] as const) {
    test(`${pluginAvailability} plugin honors ${unavailableAction} policy`, () => {
      const result = selectConsultation(
        fixture({
          riskTier: "high",
          pluginAvailability,
          policy: { unchangedFailureThreshold: 2, unavailableAction },
        }),
      );
      assert.equal(result.decision, decision);
      assert.equal(result.reasonCode, reasonCode);
      assert.equal(result.invocationAllowed, false);
    });
  }
}

test("transmission denial precedes even the no-trigger skip", () => {
  const result = selectConsultation(
    fixture({ externalTransmission: "denied" }),
  );
  assert.equal(result.decision, "continue-claude-only");
  assert.equal(result.reasonCode, "EXTERNAL_TRANSMISSION_DENIED");
  assert.deepEqual(result.triggerReasons, []);
  assert.equal(result.invocationAllowed, false);
});

test("unknown plugin availability is never treated as available", () => {
  const result = selectConsultation(
    fixture({ riskTier: "high", pluginAvailability: "unknown" }),
  );
  assert.equal(result.decision, "skip-independent-review");
  assert.equal(result.invocationAllowed, false);
});

test("consult-decide exits 2 only for a required-review stop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rigor-decide-"));
  await promisify(execFile)("git", ["init", "-q"], { cwd: root });
  await writeJson(
    path.join(root, ".rigor", "policy.json"),
    defaultPolicy("repo"),
  );
  const base = {
    schemaVersion: "rigor.independent-review-input.v1",
    taskId: "GH-15",
    riskTier: "high",
    assessmentConfidence: "high",
    failureProgress: "none",
    fingerprintRepetitions: 0,
    concerns: { security: false, dataIntegrity: false },
    humanRequested: false,
    externalTransmission: "allowed",
    pluginAvailability: "unavailable",
    policy: { unchangedFailureThreshold: 2, unavailableAction: "stop" },
  };
  const stop = path.join(root, "stop.json");
  await writeFile(stop, JSON.stringify(base));
  assert.equal(await runCli(["consult-decide", "--input", stop], root), 2);
  const request = path.join(root, "request.json");
  await writeFile(
    request,
    JSON.stringify({ ...base, pluginAvailability: "available" }),
  );
  assert.equal(await runCli(["consult-decide", "--input", request], root), 0);
});

test("review input parser fails closed", () => {
  assert.throws(() => fixture({ schemaVersion: "future" }));
  assert.throws(() => fixture({ rawTranscript: "not an input fact" }));
  assert.throws(() =>
    fixture({
      policy: { unchangedFailureThreshold: 1, unavailableAction: "skip" },
    }),
  );
});
