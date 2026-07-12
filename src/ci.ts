import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadPolicy, parseContract } from "./artifacts.js";
import { diffPaths, run, showFile } from "./git.js";
import { matches } from "./paths.js";
import { parsePolicy } from "./schema.js";
import { policyWeakening } from "./setup.js";
import { hash, readJson, record } from "./util.js";
import {
  ACTIVE_REGISTRY_PATH,
  antiBypassOutcome,
  enforcePromotedSignals,
  evaluateActivation,
  parsePromotion,
} from "./test-integrity-promotion.js";
import { CURRENT_DETECTORS } from "./test-integrity-promotion.js";
import { scanTestIntegrity } from "./test-integrity.js";
import {
  TEST_INTEGRITY_PROMOTION_SCHEMA,
  TEST_INTEGRITY_REPLAY_SCHEMA,
  type TestIntegrityPromotion,
  type TestIntegrityReplayReport,
} from "./types.js";

async function evidenceFiles(root: string): Promise<string[]> {
  const base = path.join(root, ".rigor", "evidence");
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
  await walk(base);
  return found;
}

export async function ciVerify(
  root: string,
  baseSha: string,
  headSha: string,
): Promise<{
  status: "passed" | "failed";
  failures: string[];
  changedPaths: string[];
}> {
  const failures: string[] = [];
  const baseText = await showFile(root, baseSha, ".rigor/policy.json");
  const headText = await showFile(root, headSha, ".rigor/policy.json");
  if (!headText)
    return {
      status: "failed",
      failures: ["head is missing .rigor/policy.json"],
      changedPaths: [],
    };
  let headPolicy;
  try {
    headPolicy = parsePolicy(JSON.parse(headText) as unknown);
  } catch {
    return {
      status: "failed",
      failures: ["head policy is invalid"],
      changedPaths: [],
    };
  }
  if (baseText) {
    try {
      failures.push(
        ...policyWeakening(
          parsePolicy(JSON.parse(baseText) as unknown),
          headPolicy,
        ),
      );
    } catch {
      failures.push("base policy is invalid; repair it independently");
    }
  }
  const changedPaths = await diffPaths(root, baseSha, headSha);
  // The trusted CI bundle derives this from pinned commits. It never loads the
  // head registry as authority when a protected subject changes in the same
  // range. A repository review must clear the escalation separately.
  const baseRegistry = await showFile(root, baseSha, ACTIVE_REGISTRY_PATH);
  const headRegistry = await showFile(root, headSha, ACTIVE_REGISTRY_PATH);
  const testIntegrityReviewRequired =
    antiBypassOutcome(changedPaths) === "required-human-review" ||
    baseRegistry !== headRegistry;
  const codePaths = changedPaths.filter(
    (item) => !item.startsWith(".rigor/evidence/"),
  );
  const deletion = await run(
    "git",
    ["diff", "--name-only", "--diff-filter=D", "-z", baseSha, headSha],
    root,
  );
  for (const removed of deletion.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)) {
    if (matches(removed, ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"]))
      failures.push(`existing test was deleted: ${removed}`);
  }
  const protectedChanges = codePaths.filter((item) =>
    headPolicy.rules.some(
      (rule) => rule.protected && matches(item, rule.paths),
    ),
  );
  const files = await evidenceFiles(root);
  const contracts = new Map<string, ReturnType<typeof parseContract>>();
  const verifications: Record<string, unknown>[] = [];
  const reviews: Record<string, unknown>[] = [];
  const promotions: TestIntegrityPromotion[] = [];
  const replays: TestIntegrityReplayReport[] = [];
  for (const file of files) {
    try {
      const value = await readJson(file);
      const item = record(value, "evidence");
      if (item.schemaVersion === "rigor.contract.v1") {
        const contract = parseContract(item);
        contracts.set(contract.artifactId, contract);
      } else if (item.schemaVersion === "rigor.verification.v1")
        verifications.push(item);
      else if (item.schemaVersion === "rigor.review.v1") reviews.push(item);
      else if (item.schemaVersion === TEST_INTEGRITY_PROMOTION_SCHEMA)
        promotions.push(parsePromotion(item));
      else if (item.schemaVersion === TEST_INTEGRITY_REPLAY_SCHEMA)
        replays.push(item as unknown as TestIntegrityReplayReport);
    } catch {
      failures.push(`invalid evidence file: ${path.relative(root, file)}`);
    }
  }
  let linked = false;
  for (const review of reviews) {
    const verification = verifications.find(
      (item) => item.artifactId === review.verificationArtifactId,
    );
    const contract = [...contracts.values()].find(
      (item) => item.artifactId === review.contractArtifactId,
    );
    if (
      !verification ||
      !contract ||
      verification.contractArtifactId !== contract.artifactId ||
      review.taskId !== contract.taskId
    )
      continue;
    const claimedPaths = Array.isArray(verification.changedPaths)
      ? verification.changedPaths.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    if (!codePaths.every((item) => claimedPaths.includes(item))) continue;
    if (
      verification.policyHash !== hash(headPolicy) ||
      verification.status !== "passed"
    )
      continue;
    if (protectedChanges.length > 0 && review.riskTier !== "critical") continue;
    linked = true;
  }
  if (headPolicy.ci.requireEvidence && codePaths.length > 0 && !linked)
    failures.push(
      "no linked passing evidence covers the independently derived change set and head policy",
    );
  if (testIntegrityReviewRequired && !linked)
    failures.push(
      "test-integrity anti-bypass: protected registry/configuration/verifier change requires linked human review",
    );
  if (baseRegistry !== null && baseRegistry === headRegistry) {
    let registry: unknown;
    try {
      registry = JSON.parse(baseRegistry) as unknown;
    } catch {
      registry = { malformed: true };
    }
    const activations = evaluateActivation(
      registry,
      promotions,
      replays,
      CURRENT_DETECTORS,
      hash(headPolicy),
    );
    if (activations.some((item) => item.state === "active")) {
      const event = await scanTestIntegrity(
        root,
        {
          task: "CI",
          base: baseSha,
          head: headSha,
          attemptArtifactId: null,
          verificationArtifactId: null,
          note: null,
        },
        new Date(0),
      );
      const outcome = enforcePromotedSignals(event, activations);
      if (outcome.original.gate === "immediate-stop")
        failures.push("test-integrity enforcement outcome: immediate-stop");
      else if (outcome.original.gate === "required-human-review")
        failures.push(
          "test-integrity enforcement outcome: required-human-review",
        );
      // advisory-warning intentionally has zero gating effect.
    }
    if (activations.some((item) => item.state === "frozen(requires-review)"))
      failures.push(
        "test-integrity promotion is frozen by rollback conditions and requires review",
      );
  }
  for (const check of headPolicy.checks) {
    let result;
    try {
      result = await run(check.command, check.args, root, check.timeoutMs);
    } catch {
      failures.push(`check could not start: ${check.id}`);
      continue;
    }
    if (result.timedOut || result.code !== 0)
      failures.push(`independent check failed: ${check.id}`);
  }
  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    changedPaths,
  };
}

export async function currentPolicyHash(root: string): Promise<string> {
  return hash(await loadPolicy(root));
}
