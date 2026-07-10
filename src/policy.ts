import { matches, normalizeRepoPath } from "./paths.js";
import { artifactId, hash } from "./util.js";
import {
  PREFLIGHT_SCHEMA,
  type GitFacts,
  type Intent,
  type Policy,
  type Preflight,
  type RiskTier,
} from "./types.js";

const rank: Record<RiskTier, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function evaluate(
  policy: Policy,
  intent: Intent,
  git: GitFacts,
  now = new Date(),
): Preflight {
  const plannedPaths = [
    ...new Set(intent.plannedPaths.map(normalizeRepoPath)),
  ].sort();
  let riskTier: RiskTier = "low";
  let matchedRule = false;
  let denied = policy.defaultExternalTransmission === "deny";
  let requireHumanApproval = false;
  const protectedPaths = new Set<string>();
  const reasons: Preflight["reasons"] = [];
  for (const pathname of plannedPaths) {
    for (const rule of policy.rules) {
      if (!matches(pathname, rule.paths)) continue;
      matchedRule = true;
      if (rank[rule.tier] > rank[riskTier]) riskTier = rule.tier;
      if (rule.denyExternalTransmission) denied = true;
      if (rule.requireHumanApproval) requireHumanApproval = true;
      if (rule.protected) protectedPaths.add(pathname);
      reasons.push({ ruleId: rule.id, path: pathname, reason: rule.reason });
    }
  }
  if (!matchedRule) riskTier = policy.defaultTier;
  if (plannedPaths.length === 0)
    reasons.push({
      ruleId: "no-paths",
      reason: "No planned path was supplied; review scope before editing.",
    });
  if (git.dirty)
    reasons.push({
      ruleId: "dirty-worktree",
      reason: "The worktree already contains changes that can affect evidence.",
    });
  if (rank[riskTier] >= rank.high) requireHumanApproval = true;
  return {
    schemaVersion: PREFLIGHT_SCHEMA,
    artifactId: artifactId("preflight"),
    taskId: intent.taskId,
    createdAt: now.toISOString(),
    policyHash: hash(policy),
    intentHash: hash(intent),
    git,
    plannedPaths,
    riskTier,
    externalTransmission: denied ? "denied" : "allowed",
    protectedPaths: [...protectedPaths].sort(),
    requireHumanApproval,
    stopConditions: policy.stopConditions[riskTier],
    reasons,
  };
}
