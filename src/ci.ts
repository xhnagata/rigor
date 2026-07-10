import { readdir } from "node:fs/promises";
import path from "node:path";
import { loadPolicy, parseContract } from "./artifacts.js";
import { diffPaths, run, showFile } from "./git.js";
import { matches } from "./paths.js";
import { parsePolicy } from "./schema.js";
import { policyWeakening } from "./setup.js";
import { hash, readJson, record } from "./util.js";

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
