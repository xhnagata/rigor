export const POLICY_SCHEMA = "rigor.policy.v1" as const;
export const INTENT_SCHEMA = "rigor.intent.v1" as const;
export const PREFLIGHT_SCHEMA = "rigor.preflight.v1" as const;
export const CONTRACT_SCHEMA = "rigor.contract.v1" as const;
export const CONTRACT_INPUT_SCHEMA = "rigor.contract-input.v1" as const;
export const VERIFY_SCHEMA = "rigor.verification.v1" as const;
export const ESCALATION_SCHEMA = "rigor.escalation.v1" as const;
export const ESCALATION_INPUT_SCHEMA = "rigor.escalation-input.v1" as const;
export const REVIEW_SCHEMA = "rigor.review.v1" as const;

export type RiskTier = "low" | "medium" | "high" | "critical";
export type Transmission = "allowed" | "denied";

export interface Rule {
  id: string;
  paths: string[];
  tier: RiskTier;
  reason: string;
  protected?: boolean;
  denyExternalTransmission?: boolean;
  requireHumanApproval?: boolean;
}

export interface Check {
  id: string;
  command: string;
  args: string[];
  tiers: RiskTier[];
  timeoutMs: number;
}

export interface Policy {
  schemaVersion: typeof POLICY_SCHEMA;
  repositoryId: string;
  defaultTier: RiskTier;
  defaultExternalTransmission: "allow" | "deny";
  rules: Rule[];
  checks: Check[];
  stopConditions: Record<RiskTier, string[]>;
  ci: { requireEvidence: boolean; maxPolicyWeakening: "none" };
}

export interface Intent {
  schemaVersion: typeof INTENT_SCHEMA;
  taskId: string;
  summary: string;
  plannedPaths: string[];
  operations?: string[];
}

export interface GitFacts {
  root: string;
  head: string | null;
  dirty: boolean;
  changedPaths: string[];
}

export interface Preflight {
  schemaVersion: typeof PREFLIGHT_SCHEMA;
  artifactId: string;
  taskId: string;
  createdAt: string;
  policyHash: string;
  intentHash: string;
  git: GitFacts;
  plannedPaths: string[];
  riskTier: RiskTier;
  externalTransmission: Transmission;
  protectedPaths: string[];
  requireHumanApproval: boolean;
  stopConditions: string[];
  reasons: Array<{ ruleId: string; path?: string; reason: string }>;
}

export interface ContractInput {
  schemaVersion: typeof CONTRACT_INPUT_SCHEMA;
  taskId: string;
  acceptanceCriteria: string[];
  allowedPaths: string[];
  constraints: string[];
}

export interface Contract extends Omit<ContractInput, "schemaVersion"> {
  schemaVersion: typeof CONTRACT_SCHEMA;
  artifactId: string;
  createdAt: string;
  preflightArtifactId: string;
  preflightHash: string;
  riskTier: RiskTier;
  externalTransmission: Transmission;
  requiredChecks: string[];
  stopConditions: string[];
}

export interface CheckResult {
  id: string;
  status: "passed" | "failed" | "timed_out" | "error";
  exitCode: number | null;
  durationMs: number;
  outputDigest: string;
}

export interface Verification {
  schemaVersion: typeof VERIFY_SCHEMA;
  artifactId: string;
  taskId: string;
  contractArtifactId: string;
  createdAt: string;
  policyHash: string;
  head: string | null;
  treeHash: string;
  changedPaths: string[];
  scopeViolations: string[];
  checks: CheckResult[];
  status: "passed" | "failed";
}

export interface EscalationInput {
  schemaVersion: typeof ESCALATION_INPUT_SCHEMA;
  taskId: string;
  facts: string[];
  attempts: Array<{ action: string; result: string }>;
  disprovedHypotheses: string[];
  speculation: string[];
  requestedDecision: string;
}
