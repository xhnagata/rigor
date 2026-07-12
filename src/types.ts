import type {
  CheckFacts,
  CheckFailure,
  FailureCategory,
  ProgressComparison,
  ProgressStatus,
  TestStats,
} from "./fingerprint.js";

export const POLICY_SCHEMA = "rigor.policy.v1" as const;
export const INTENT_SCHEMA = "rigor.intent.v1" as const;
export const PREFLIGHT_SCHEMA = "rigor.preflight.v1" as const;
export const CONTRACT_SCHEMA = "rigor.contract.v1" as const;
export const CONTRACT_INPUT_SCHEMA = "rigor.contract-input.v1" as const;
export const VERIFY_SCHEMA = "rigor.verification.v1" as const;
export const ESCALATION_SCHEMA = "rigor.escalation.v1" as const;
export const ESCALATION_INPUT_SCHEMA = "rigor.escalation-input.v1" as const;
export const ESCALATION_DECISION_INPUT_SCHEMA =
  "rigor.escalation-decision-input.v1" as const;
export const ESCALATION_DECISION_SCHEMA =
  "rigor.escalation-decision.v1" as const;
export const REVIEW_SCHEMA = "rigor.review.v1" as const;
export const ROUTING_INPUT_SCHEMA = "rigor.routing-input.v1" as const;
export const ROUTING_INPUT_V2_SCHEMA = "rigor.routing-input.v2" as const;
export const MODEL_PROFILES_SCHEMA = "rigor.model-profiles.v1" as const;
export const ROUTING_DECISION_SCHEMA = "rigor.routing-decision.v1" as const;
export const ATTEMPT_SCHEMA = "rigor.attempt.v1" as const;
export const CONSULTATION_SCHEMA = "rigor.consultation.v1" as const;
export const CONSULTATION_REQUEST_SCHEMA =
  "rigor.consultation-request.v1" as const;
export const CONSULTATION_SESSION_SCHEMA =
  "rigor.consultation-session.v1" as const;
export const CONSULTATION_RESULT_INPUT_SCHEMA =
  "rigor.consultation-result-input.v1" as const;
export const ROUTING_PLAN_SCHEMA = "rigor.routing-plan.v1" as const;
export const ATTEMPT_SESSION_SCHEMA = "rigor.attempt-session.v1" as const;
export const ATTEMPT_RESULT_INPUT_SCHEMA =
  "rigor.attempt-result-input.v1" as const;
export const OUTCOME_INPUT_SCHEMA = "rigor.outcome-input.v1" as const;
export const OUTCOME_SCHEMA = "rigor.outcome.v1" as const;
export const AVAILABILITY_SCHEMA = "rigor.availability.v1" as const;
export const TEST_INTEGRITY_EVENT_SCHEMA =
  "rigor.test-integrity-event.v1" as const;
export const TEST_INTEGRITY_CLASSIFICATION_INPUT_SCHEMA =
  "rigor.test-integrity-classification-input.v1" as const;
export const TEST_INTEGRITY_CLASSIFICATION_SCHEMA =
  "rigor.test-integrity-classification.v1" as const;

export type {
  CheckFacts,
  CheckFailure,
  FailureCategory,
  ProgressComparison,
  ProgressStatus,
  TestStats,
} from "./fingerprint.js";

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
  testStats?: TestStats;
  failure?: CheckFailure;
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
  /**
   * Additive, optional for backward compatibility with verification.json
   * artifacts recorded before failure fingerprinting existed.
   */
  failureFingerprint?: string | null;
  failureFacts?: CheckFacts[];
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

export type EscalationFailureCategory = FailureCategory | "mixed";

export type EscalationDecisionKind =
  | "retry-current"
  | "escalate-adjacent"
  | "escalate-direct"
  | "retry-infrastructure"
  | "stop-infrastructure"
  | "stop-human-decision"
  | "stop-policy-violation"
  | "stop-budget-exhausted"
  | "stop-no-eligible-candidate";

export interface EscalationAttemptFact {
  artifactId: string;
  artifactHash: string;
  routingPlanArtifactId: string;
  routingPlanHash: string;
  sequence: number;
  capabilityClass: CapabilityClass;
  failureCategory: EscalationFailureCategory;
  progress: ProgressStatus;
  failureFingerprint: string | null;
  durationMs: number;
  relativeCost: number;
}

export interface EscalationDecisionInput {
  schemaVersion: typeof ESCALATION_DECISION_INPUT_SCHEMA;
  taskId: string;
  purpose: RoutingPurpose;
  contract: { artifactId: string; artifactHash: string };
  routingPlan: {
    artifactId: string;
    artifactHash: string;
    modelProfilesHash: string;
  };
  currentAttempt: EscalationAttemptFact;
  previousAttempts: EscalationAttemptFact[];
  riskTier: RiskTier;
  externalTransmission: Transmission;
  failureCategory: EscalationFailureCategory;
  progress: ProgressStatus;
  fingerprintRepetitions: number;
  currentCapabilityClass: CapabilityClass;
  attemptCount: number;
  elapsedMs: number;
  consumedRelativeCost: number;
  budget: RoutingInput["budget"];
  concerns: {
    requirementsChangeRequired: boolean;
    acceptanceCriteriaChangeRequired: boolean;
    humanOnlyDecision: boolean;
    scopeViolation: boolean;
    protectedTestMutation: boolean;
    configuredCheckRemoval: boolean;
    configuredCheckWeakening: boolean;
    security: boolean;
    dataIntegrity: boolean;
    architectureChange: boolean;
    contractContradiction: boolean;
  };
  thresholds: {
    unchangedAttemptsBeforeDirect: number;
    infrastructureRetries: number;
  };
  speculation: string[];
}

export type EscalationCandidateExclusionReason =
  | Exclude<RoutingExclusionReason, "INSUFFICIENT_CAPABILITY">
  | "CAPABILITY_NOT_SELECTED";

export interface EscalationDecision {
  schemaVersion: typeof ESCALATION_DECISION_SCHEMA;
  taskId: string;
  inputHash: string;
  modelProfilesHash: string;
  availabilityReportHash: string | null;
  decision: EscalationDecisionKind;
  reasonCode: string;
  targetCapabilityClass: CapabilityClass | null;
  selection: RoutingDecision["selection"];
  eligibleCandidates: string[];
  excludedCandidates: Array<{
    candidateId: string;
    reasonCode: EscalationCandidateExclusionReason;
  }>;
  budget: {
    attemptCount: number;
    maxAttempts: number;
    elapsedMs: number;
    maxDurationMs: number;
    consumedRelativeCost: number;
    remainingRelativeCost: number;
    maxRelativeCost: number;
  };
  facts: {
    failureCategory: EscalationFailureCategory;
    progress: ProgressStatus;
    fingerprintRepetitions: number;
    riskTier: RiskTier;
    currentCapabilityClass: CapabilityClass;
    concerns: EscalationDecisionInput["concerns"];
  };
  speculation: string[];
}

export type AssessmentConfidence = "low" | "medium" | "high";

export interface AssessmentEvidence {
  path: string; // repository-relative path anchoring the observation
  observation: string; // what was observed at that path
}

export interface RoutingAssessment {
  inputSchemaVersion:
    | typeof ROUTING_INPUT_SCHEMA
    | typeof ROUTING_INPUT_V2_SCHEMA;
  confidence: AssessmentConfidence;
  evidence: AssessmentEvidence[]; // [] for legacy v1
}

export interface RoutingInput {
  schemaVersion: typeof ROUTING_INPUT_SCHEMA | typeof ROUTING_INPUT_V2_SCHEMA;
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
  assessment?: RoutingAssessment; // present only for v2 inputs
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
  | "BUDGET_EXCEEDED"
  | "UNAVAILABLE"
  | "INCOMPATIBLE";

export type AvailabilityState =
  | "available"
  | "unavailable"
  | "unknown"
  | "incompatible";

export type CodexPluginPresence = "present" | "absent" | "unknown";

/**
 * Raw observation of the local execution environment gathered through
 * documented, bounded interfaces only (environment variables). It performs no
 * installation, authentication, or network transmission and never scrapes
 * undocumented UI output. `probeSupported` is false when the interface is
 * unavailable or its format changed, so every derived state fails safe to
 * `unknown` rather than fabricating availability.
 */
export interface EnvironmentObservation {
  probeSupported: boolean;
  claudeCode: { present: boolean; version: string | null };
  configuredModel: string | null;
  codexPlugin: { presence: CodexPluginPresence; version: string | null };
}

export interface CandidateAvailability {
  candidateId: string;
  provider: string;
  state: AvailabilityState;
  reason: string;
  observedAt: string;
  toolVersion: string | null;
}

/**
 * A versioned observation (not attestation) of which configured candidates the
 * current environment can invoke. Configured model identity, reasoning effort,
 * usage, and cost remain unverified; availability is never runtime attestation.
 */
export interface AvailabilityReport {
  schemaVersion: typeof AVAILABILITY_SCHEMA;
  artifactId: string;
  createdAt: string;
  modelProfilesHash: string;
  probeStatus: "supported" | "unsupported";
  environment: {
    claudeCode: { present: boolean; version: string | null };
    configuredModel: { value: string; attestation: "unverified" } | null;
    codexPlugin: { presence: CodexPluginPresence; version: string | null };
  };
  candidates: CandidateAvailability[];
}

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
  availabilityReportHash?: string;
  assessment: {
    inputSchemaVersion:
      | typeof ROUTING_INPUT_SCHEMA
      | typeof ROUTING_INPUT_V2_SCHEMA;
    confidence: AssessmentConfidence;
    evidenceCount: number;
  };
  status: "selected" | "unroutable" | "requires-review";
}

export interface Attempt {
  schemaVersion: typeof ATTEMPT_SCHEMA;
  artifactId: string;
  taskId: string;
  createdAt: string;
  sessionArtifactId: string;
  sessionHash: string;
  routingPlanArtifactId: string;
  routingPlanHash: string;
  contractArtifactId: string;
  contractHash: string;
  sequence: number;
  provider: string;
  model?: string;
  capabilityClass: CapabilityClass;
  purpose: RoutingPurpose;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  executionIdentityStatus: "unverified";
  status:
    | "completed"
    | "failed"
    | "cancelled"
    | "scope-violation"
    | "budget-exceeded";
  beforeHead: string | null;
  afterHead: string | null;
  beforeTreeHash: string;
  afterTreeHash: string;
  changedPathsBefore: string[];
  changedPaths: string[];
  scopeViolations: string[];
  verificationArtifactId?: string;
  failureClass?: string;
  externalSessionId?: string;
  externalTurnId?: string;
  /**
   * Additive, optional for backward compatibility with attempt.json artifacts
   * recorded before failure fingerprinting existed. Deterministically derived
   * from the linked verification's failureFacts, never copied from model
   * input; kept separate from the model-supplied, speculative `failureClass`
   * above.
   */
  failureFingerprint?: string | null;
  failureCategory?: FailureCategory | "mixed" | null;
  failureFacts?: CheckFacts[];
  progress?: ProgressComparison;
}

export interface RoutingPlan
  extends Omit<RoutingDecision, "schemaVersion" | "mode" | "status"> {
  schemaVersion: typeof ROUTING_PLAN_SCHEMA;
  artifactId: string;
  createdAt: string;
  contractArtifactId: string;
  contractHash: string;
  policyHash: string;
  plannedHead: string | null;
  status: "planned";
}

export interface AttemptSession {
  schemaVersion: typeof ATTEMPT_SESSION_SCHEMA;
  artifactId: string;
  taskId: string;
  createdAt: string;
  sequence: number;
  routingPlanArtifactId: string;
  routingPlanHash: string;
  contractArtifactId: string;
  contractHash: string;
  provider: string;
  model?: string;
  capabilityClass: CapabilityClass;
  purpose: RoutingPurpose;
  budget: RoutingInput["budget"];
  executionIdentityStatus: "unverified";
  beforeHead: string | null;
  beforeTreeHash: string;
  changedPathsBefore: string[];
}

export interface AttemptResultInput {
  schemaVersion: typeof ATTEMPT_RESULT_INPUT_SCHEMA;
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  failureClass?: string;
  externalSessionId?: string;
  externalTurnId?: string;
}

export interface Consultation {
  schemaVersion: typeof CONSULTATION_SCHEMA;
  artifactId: string;
  taskId: string;
  createdAt: string;
  sessionArtifactId: string;
  sessionHash: string;
  provider: string;
  mode: "review" | "adversarial-review" | "consultation" | "rescue";
  requestedDecision: string;
  transmissionDecision: Transmission;
  beforeTreeHash: string;
  afterTreeHash: string;
  beforeHead: string | null;
  afterHead: string | null;
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

export interface ConsultationRequest {
  schemaVersion: typeof CONSULTATION_REQUEST_SCHEMA;
  taskId: string;
  provider: "codex-plugin-cc";
  mode: "review" | "adversarial-review" | "consultation" | "rescue";
  requestedDecision: string;
}

export interface ConsultationSession {
  schemaVersion: typeof CONSULTATION_SESSION_SCHEMA;
  artifactId: string;
  taskId: string;
  createdAt: string;
  preflightArtifactId: string;
  preflightHash: string;
  provider: "codex-plugin-cc";
  mode: ConsultationRequest["mode"];
  requestedDecision: string;
  transmissionDecision: "allowed";
  beforeHead: string | null;
  beforeTreeHash: string;
  changedPathsBefore: string[];
}

export interface ConsultationResultInput {
  schemaVersion: typeof CONSULTATION_RESULT_INPUT_SCHEMA;
  taskId: string;
  status: "completed" | "failed";
  outcome: "accept" | "revise" | "reject" | "investigate" | "ask-human";
  findingCount: number;
  requiredActions: string[];
  externalJobId?: string;
  externalSessionId?: string;
  externalTurnId?: string;
  model?: string;
  reasoningEffort?: string;
  usageStatus: "recorded" | "unavailable";
}

export type TestIntegritySignalId =
  | "TI-05"
  | "TI-06"
  | "TI-07"
  | "TI-08"
  | "TI-09";

export type TestIntegrityVerdict =
  | "true-positive"
  | "false-positive"
  | "uncertain";

export interface TestIntegritySignal {
  signalId: TestIntegritySignalId;
  threatClass: string;
  label: "advisory-interpretation";
  computation: "deterministic";
  detector: { name: string; version: string };
  /** Bounded numbers and enumerated strings only; never matched source text. */
  value: Record<string, number>;
  /** Repository-relative, at most 25 entries; the true count is in `value`. */
  paths: string[];
  /** Opaque hash over normalized matched lines; never reversible to content. */
  matchDigest: string;
  note: string | null;
}

export interface TestIntegrityEvent {
  schemaVersion: typeof TEST_INTEGRITY_EVENT_SCHEMA;
  artifactId: string;
  taskId: string;
  createdAt: string;
  mode: "shadow";
  enforcement: "none";
  attemptArtifactId: string | null;
  verificationArtifactId: string | null;
  diff: {
    baseSha: string;
    headSha: string | null;
    worktreeDigest: string | null;
  };
  signalsEvaluated: TestIntegritySignalId[];
  signals: TestIntegritySignal[];
  signalsTruncated: boolean;
  note: string | null;
}

export interface TestIntegrityClassificationInput {
  schemaVersion: typeof TEST_INTEGRITY_CLASSIFICATION_INPUT_SCHEMA;
  taskId: string;
  eventArtifactId: string;
  verdicts: Array<{
    signalId: TestIntegritySignalId;
    verdict: TestIntegrityVerdict;
    note?: string;
  }>;
  /** A recorded declaration, not attested identity; satisfies no control. */
  classifiedBy: "human";
}

export interface TestIntegrityClassification {
  schemaVersion: typeof TEST_INTEGRITY_CLASSIFICATION_SCHEMA;
  artifactId: string;
  taskId: string;
  createdAt: string;
  eventArtifactId: string;
  classifiedBy: "human";
  verdicts: Array<{
    signalId: TestIntegritySignalId;
    verdict: TestIntegrityVerdict;
    note: string | null;
  }>;
}

export interface OutcomeInput {
  schemaVersion: typeof OUTCOME_INPUT_SCHEMA;
  taskId: string;
  decision: "accepted" | "rejected";
  acceptedWithoutModelCodeChanges: boolean;
  humanCorrectionMinutes: number;
  escalationCount: number;
  reviewFindings: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  revertStatus: "none" | "reverted";
  escapedDefectStatus: "none" | "suspected" | "confirmed";
  usage: {
    status: "recorded" | "unavailable" | "unknown";
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningEffort?: string;
    modelIdentity?: string;
    providerCost?: { currency: string; amount: number };
  };
  retryCount?: number;
  commit?: string;
  pullRequest?: string;
  notes?: string[];
}

export interface Outcome {
  schemaVersion: typeof OUTCOME_SCHEMA;
  artifactId: string;
  taskId: string;
  createdAt: string;
  decision: "accepted" | "rejected";
  acceptedWithoutModelCodeChanges: boolean;
  humanCorrectionMinutes: number;
  escalationCount: number;
  retryCount: number;
  reviewFindings: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  revertStatus: "none" | "reverted";
  escapedDefectStatus: "none" | "suspected" | "confirmed";
  executionIdentityStatus: "unverified";
  routingPlanArtifactId?: string;
  attemptArtifactId?: string;
  attemptSequence?: number;
  attemptStatus?: Attempt["status"];
  attemptDurationMs?: number;
  provider?: string;
  model?: string;
  capabilityClass?: CapabilityClass;
  verificationArtifactId?: string;
  verificationStatus?: Verification["status"];
  reviewArtifactId?: string;
  commit?: string;
  pullRequest?: string;
  usage: {
    status: "recorded" | "unavailable" | "unknown";
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    reasoningEffort: string | null;
    providerCost: { currency: string; amount: number } | null;
    modelIdentity: { value: string; attestation: "unverified" } | null;
  };
  notes: string[];
}
