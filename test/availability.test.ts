import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAvailabilityReport,
  parseAvailabilityReport,
  probeEnvironment,
} from "../src/availability.js";
import { route } from "../src/routing.js";
import { hash } from "../src/util.js";
import type {
  EnvironmentObservation,
  ModelProfiles,
  Preflight,
  RoutingInput,
} from "../src/types.js";

const profiles: ModelProfiles = {
  schemaVersion: "rigor.model-profiles.v1",
  candidates: [
    {
      id: "claude-standard",
      provider: "claude",
      capabilityClass: "standard",
      purposes: ["implementation", "review"],
      relativeCost: 20,
      requiresAdditionalExternalTransmission: false,
      enabled: true,
    },
    {
      id: "codex-consult",
      provider: "codex-plugin-cc",
      capabilityClass: "frontier",
      purposes: ["implementation", "consultation", "rescue"],
      relativeCost: 40,
      requiresAdditionalExternalTransmission: true,
      enabled: true,
    },
    {
      id: "other-provider",
      provider: "some-other-runtime",
      capabilityClass: "standard",
      purposes: ["implementation"],
      relativeCost: 10,
      requiresAdditionalExternalTransmission: false,
      enabled: true,
    },
  ],
};

const preflight: Preflight = {
  schemaVersion: "rigor.preflight.v1",
  artifactId: "preflight-1",
  taskId: "TASK-1",
  createdAt: new Date(0).toISOString(),
  policyHash: "policy",
  intentHash: "intent",
  git: { root: "/repo", head: "abc", dirty: false, changedPaths: [] },
  plannedPaths: ["src/a.ts"],
  riskTier: "high",
  externalTransmission: "allowed",
  protectedPaths: [],
  requireHumanApproval: true,
  stopConditions: [],
  reasons: [],
};

const input: RoutingInput = {
  schemaVersion: "rigor.routing-input.v1",
  taskId: "TASK-1",
  purpose: "implementation",
  signals: {
    complexity: "medium",
    ambiguity: "low",
    novelty: "low",
    verificationStrength: "strong",
  },
  assessmentReasons: ["Bounded change with deterministic tests."],
  budget: { maxAttempts: 2, maxDurationMs: 60_000, maxRelativeCost: 100 },
};

const supported = (
  overrides: Partial<EnvironmentObservation> = {},
): EnvironmentObservation => ({
  probeSupported: true,
  claudeCode: { present: true, version: "1.2.3" },
  configuredModel: "claude-opus-4",
  codexPlugin: { presence: "absent", version: null },
  ...overrides,
});

test("report assigns exactly one state per configured candidate", () => {
  const report = buildAvailabilityReport(
    profiles,
    supported({ codexPlugin: { presence: "present", version: "0.9.0" } }),
    new Date(0),
  );
  assert.equal(report.schemaVersion, "rigor.availability.v1");
  assert.equal(report.candidates.length, profiles.candidates.length);
  const byId = new Map(report.candidates.map((c) => [c.candidateId, c]));
  assert.equal(byId.get("claude-standard")!.state, "available");
  assert.equal(byId.get("codex-consult")!.state, "available");
  assert.equal(byId.get("other-provider")!.state, "incompatible");
  for (const candidate of report.candidates)
    assert.ok(
      ["available", "unavailable", "unknown", "incompatible"].includes(
        candidate.state,
      ),
    );
});

test("missing codex-plugin-cc marks only the codex candidate unavailable", () => {
  const report = buildAvailabilityReport(profiles, supported(), new Date(0));
  const byId = new Map(report.candidates.map((c) => [c.candidateId, c]));
  assert.equal(byId.get("codex-consult")!.state, "unavailable");
  assert.equal(byId.get("claude-standard")!.state, "available");
});

test("unsupported probing derives unknown, never available", () => {
  const report = buildAvailabilityReport(
    profiles,
    supported({ probeSupported: false }),
    new Date(0),
  );
  assert.equal(report.probeStatus, "unsupported");
  const byId = new Map(report.candidates.map((c) => [c.candidateId, c]));
  assert.equal(byId.get("claude-standard")!.state, "unknown");
  assert.equal(byId.get("codex-consult")!.state, "unknown");
  assert.equal(byId.get("other-provider")!.state, "incompatible");
  for (const candidate of report.candidates)
    assert.notEqual(candidate.state, "available");
});

test("configured model is recorded as unverified and versions/time observed", () => {
  const report = buildAvailabilityReport(profiles, supported(), new Date(0));
  assert.deepEqual(report.environment.configuredModel, {
    value: "claude-opus-4",
    attestation: "unverified",
  });
  const claude = report.candidates.find(
    (c) => c.candidateId === "claude-standard",
  )!;
  assert.equal(claude.toolVersion, "1.2.3");
  assert.equal(claude.observedAt, new Date(0).toISOString());
});

test("absent tool/plugin version and configured model are explicitly null", () => {
  const report = buildAvailabilityReport(
    profiles,
    supported({
      claudeCode: { present: true, version: null },
      configuredModel: null,
    }),
    new Date(0),
  );
  assert.equal(report.environment.configuredModel, null);
  const claude = report.candidates.find(
    (c) => c.candidateId === "claude-standard",
  )!;
  assert.equal(claude.toolVersion, null);
});

test("availability report round-trips through the fail-closed parser", () => {
  const report = buildAvailabilityReport(profiles, supported(), new Date(0));
  assert.deepEqual(parseAvailabilityReport(report), report);
  assert.throws(() =>
    parseAvailabilityReport({ ...report, schemaVersion: "future" }),
  );
  assert.throws(() =>
    parseAvailabilityReport({
      ...report,
      candidates: [{ ...report.candidates[0], state: "maybe" }],
    }),
  );
});

test("route filters unavailable and incompatible candidates with reason codes", () => {
  const report = buildAvailabilityReport(profiles, supported(), new Date(0));
  const decision = route(preflight, input, profiles, report);
  assert.equal(decision.selection?.candidateId, "claude-standard");
  assert.equal(decision.availabilityReportHash, hash(report));
  assert.deepEqual(decision.excludedCandidates, [
    { candidateId: "codex-consult", reasonCode: "UNAVAILABLE" },
    { candidateId: "other-provider", reasonCode: "INCOMPATIBLE" },
  ]);
});

test("unknown never excludes; static incompatibility survives an unsupported probe", () => {
  const report = buildAvailabilityReport(
    profiles,
    supported({ probeSupported: false }),
    new Date(0),
  );
  const decision = route(preflight, input, profiles, report);
  assert.equal(decision.status, "selected");
  assert.equal(decision.selection?.candidateId, "claude-standard");
  assert.deepEqual(decision.excludedCandidates, [
    { candidateId: "other-provider", reasonCode: "INCOMPATIBLE" },
  ]);
});

test("route without availability is unchanged and omits the hash", () => {
  const decision = route(preflight, input, profiles);
  assert.equal(decision.availabilityReportHash, undefined);
  assert.equal(decision.selection?.candidateId, "other-provider");
});

test("all-unavailable selections stop with an explicit unroutable result", () => {
  const claudeOnly: ModelProfiles = {
    schemaVersion: "rigor.model-profiles.v1",
    candidates: [profiles.candidates[1]!],
  };
  const report = buildAvailabilityReport(claudeOnly, supported(), new Date(0));
  const decision = route(preflight, input, claudeOnly, report);
  assert.equal(decision.status, "unroutable");
  assert.equal(decision.selection, null);
  assert.deepEqual(decision.excludedCandidates, [
    { candidateId: "codex-consult", reasonCode: "UNAVAILABLE" },
  ]);
});

test("route rejects an availability report bound to different profiles", () => {
  const report = buildAvailabilityReport(profiles, supported(), new Date(0));
  const otherProfiles: ModelProfiles = {
    schemaVersion: "rigor.model-profiles.v1",
    candidates: [profiles.candidates[0]!],
  };
  assert.throws(() => route(preflight, input, otherProfiles, report));
});

test("default probe reads bounded env vars and never fabricates", () => {
  const present = probeEnvironment({
    CLAUDE_PLUGIN_ROOT: "/plugins/rigor",
    ANTHROPIC_MODEL: "claude-opus-4",
    RIGOR_CODEX_PLUGIN_PRESENT: "true",
    RIGOR_CODEX_PLUGIN_VERSION: "0.9.0",
  } as NodeJS.ProcessEnv);
  assert.equal(present.probeSupported, true);
  assert.equal(present.claudeCode.present, true);
  assert.equal(present.configuredModel, "claude-opus-4");
  assert.equal(present.codexPlugin.presence, "present");
  assert.equal(present.codexPlugin.version, "0.9.0");

  const empty = probeEnvironment({} as NodeJS.ProcessEnv);
  assert.equal(empty.claudeCode.present, false);
  assert.equal(empty.claudeCode.version, null);
  assert.equal(empty.configuredModel, null);
  assert.equal(empty.codexPlugin.presence, "unknown");
  assert.equal(empty.codexPlugin.version, null);
});
