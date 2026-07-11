export const POLICY_SCHEMA = "rigor.policy.v1" as const;
export const INTENT_SCHEMA = "rigor.intent.v1" as const;
export const PREFLIGHT_SCHEMA = "rigor.preflight.v1" as const;
export const CONTRACT_SCHEMA = "rigor.contract.v1" as const;
export const CONTRACT_INPUT_SCHEMA = "rigor.contract-input.v1" as const;
export const VERIFY_SCHEMA = "rigor.verification.v1" as const;
export const ESCALATION_SCHEMA = "rigor.escalation.v1" as const;
export const ESCALATION_INPUT_SCHEMA = "rigor.escalation-input.v1" as const;
export const REVIEW_SCHEMA = "rigor.review.v1" as const;
export const ROUTING_INPUT_SCHEMA = "rigor.routing-input.v1" as const;
export const MODEL_PROFILES_SCHEMA = "rigor.model-profiles.v1" as const;
export const ROUTING_DECISION_SCHEMA = "rigor.routing-decision.v1" as const;
export const ATTEMPT_SCHEMA = "rigor.attempt.v1" as const;
export const CONSULTATION_SCHEMA = "rigor.consultation.v1" as const;

export type RiskTier = "low" | "medium" | "high" | "critical";
export type Transmission = "allowed" | "denied";
export type SignalLevel = "low" | "medium" | "high" | "critical";
export type VerificationStrength = "weak" | "moderate" | "strong";
export type CapabilityClass = "economy" | "standard" | "premium" | "frontier";
export type RoutingPurpose =
  | "implementation"
  | "consultation"
  | "review"
  | "adversarial-review"
  | "rescue";

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

export interface RoutingInput {
  schemaVersion: typeof ROUTING_INPUT_SCHEMA;
  taskId: string;
  purpose: RoutingPurpose;
  signals: {
    complexity: SignalLevel;
    ambiguity: SignalLevel;
    novelty: SignalLevel;
    verificationStrength: VerificationStrength;
  };
  assessmentReasons: string[];
  budget: {
    maxAttempts: number;
    maxDurationMs: number;
    maxRelativeCost: number;
  };
}

export interface ModelCandidate {
  id: string;
  provider: string;
  model?: string;
  capabilityClass: CapabilityClass;
  purposes: RoutingPurpose[];
  relativeCost: number;
  requiresAdditionalExternalTransmission: boolean;
  enabled: boolean;
}

export interface ModelProfiles {
  schemaVersion: typeof MODEL_PROFILES_SCHEMA;
  candidates: ModelCandidate[];
}

export type RoutingExclusionReason =
  | "DISABLED"
  | "PURPOSE_UNSUPPORTED"
  | "EXTERNAL_TRANSMISSION_DENIED"
  | "INSUFFICIENT_CAPABILITY"
  | "BUDGET_EXCEEDED";

export interface RoutingDecision {
  schemaVersion: typeof ROUTING_DECISION_SCHEMA;
  mode: "dry-run";
  taskId: string;
  preflightArtifactId: string;
  preflightHash: string;
  routingInputHash: string;
  modelProfilesHash: string;
  purpose: RoutingPurpose;
  requiredCapabilityClass: CapabilityClass;
  eligibleCandidates: string[];
  excludedCandidates: Array<{
    candidateId: string;
    reasonCode: RoutingExclusionReason;
  }>;
  selection: {
    candidateId: string;
    provider: string;
    model?: string;
    capabilityClass: CapabilityClass;
    relativeCost: number;
  } | null;
  controls: {
    externalTransmission: Transmission;
    requireHumanApproval: boolean;
    requireIndependentReview: boolean;
  };
  budget: RoutingInput["budget"];
  status: "selected" | "unroutable";
}

export interface Attempt {
  schemaVersion: typeof ATTEMPT_SCHEMA;
  artifactId: string;
  taskId: string;
  routingDecisionArtifactId: string;
  createdAt: string;
  sequence: number;
  provider: string;
  model?: string;
  capabilityClass: CapabilityClass;
  purpose: RoutingPurpose;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  changedPaths: string[];
  verificationArtifactId?: string;
  failureClass?: string;
}

export interface Consultation {
  schemaVersion: typeof CONSULTATION_SCHEMA;
  artifactId: string;
  taskId: string;
  createdAt: string;
  sequence: number;
  provider: string;
  mode: "review" | "adversarial-review" | "consultation" | "rescue";
  requestedDecision: string;
  transmissionDecision: Transmission;
  beforeTreeHash: string;
  afterTreeHash: string;
  changedPathsBefore: string[];
  changedPathsAfter: string[];
  externalJobId?: string;
  externalSessionId?: string;
  externalTurnId?: string;
  model?: string;
  reasoningEffort?: string;
  usageStatus: "recorded" | "unavailable";
  status: "completed" | "failed" | "mutated-worktree";
  outcome: "accept" | "revise" | "reject" | "investigate" | "ask-human";
  findingCount: number;
  requiredActions: string[];
}
