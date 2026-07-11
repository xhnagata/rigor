import { EXIT, RigorError } from "./errors.js";
import { gitFacts, treeHash } from "./git.js";
import { saveCollectionArtifact } from "./artifacts.js";
import { matches } from "./paths.js";
import {
  CONSULTATION_REQUEST_SCHEMA,
  CONSULTATION_RESULT_INPUT_SCHEMA,
  CONSULTATION_SCHEMA,
  CONSULTATION_SESSION_SCHEMA,
  type Consultation,
  type ConsultationRequest,
  type ConsultationResultInput,
  type ConsultationSession,
  type Policy,
  type Preflight,
} from "./types.js";
import {
  artifactId,
  hash,
  record,
  strings,
  taskId,
  textField,
} from "./util.js";

const ignoredEvidence = [".rigor/evidence/", ".rigor/events.jsonl"];
const modes: ConsultationRequest["mode"][] = [
  "review",
  "adversarial-review",
  "consultation",
  "rescue",
];
const outcomes: ConsultationResultInput["outcome"][] = [
  "accept",
  "revise",
  "reject",
  "investigate",
  "ask-human",
];

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value as T;
}

function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : textField(value, name, 512);
}

function filteredChangedPaths(paths: string[]): string[] {
  return paths.filter(
    (file) => !ignoredEvidence.some((prefix) => file.startsWith(prefix)),
  );
}

export function parseConsultationRequest(value: unknown): ConsultationRequest {
  const item = record(value, "consultation request");
  if (item.schemaVersion !== CONSULTATION_REQUEST_SCHEMA)
    throw new RigorError(
      "Unsupported consultation request schema",
      EXIT.inputError,
    );
  if (item.provider !== "codex-plugin-cc")
    throw new RigorError(
      "Phase 2 consultations require codex-plugin-cc",
      EXIT.inputError,
    );
  return {
    schemaVersion: CONSULTATION_REQUEST_SCHEMA,
    taskId: taskId(item.taskId),
    provider: "codex-plugin-cc",
    mode: oneOf(item.mode, modes, "mode"),
    requestedDecision: textField(
      item.requestedDecision,
      "requestedDecision",
      2_000,
    ),
  };
}

export function parseConsultationSession(value: unknown): ConsultationSession {
  const item = record(value, "consultation session");
  if (item.schemaVersion !== CONSULTATION_SESSION_SCHEMA)
    throw new RigorError(
      "Unsupported consultation session schema",
      EXIT.inputError,
    );
  if (
    item.provider !== "codex-plugin-cc" ||
    item.transmissionDecision !== "allowed"
  )
    throw new RigorError("Invalid consultation session", EXIT.inputError);
  const beforeHead = item.beforeHead;
  if (beforeHead !== null && typeof beforeHead !== "string")
    throw new RigorError("beforeHead is invalid", EXIT.inputError);
  return {
    schemaVersion: CONSULTATION_SESSION_SCHEMA,
    artifactId: textField(item.artifactId, "artifactId", 128),
    taskId: taskId(item.taskId),
    createdAt: textField(item.createdAt, "createdAt", 128),
    preflightArtifactId: textField(
      item.preflightArtifactId,
      "preflightArtifactId",
      128,
    ),
    preflightHash: textField(item.preflightHash, "preflightHash", 128),
    provider: "codex-plugin-cc",
    mode: oneOf(item.mode, modes, "mode"),
    requestedDecision: textField(
      item.requestedDecision,
      "requestedDecision",
      2_000,
    ),
    transmissionDecision: "allowed",
    beforeHead,
    beforeTreeHash: textField(item.beforeTreeHash, "beforeTreeHash", 128),
    changedPathsBefore: strings(item.changedPathsBefore, "changedPathsBefore"),
  };
}

export function parseConsultationResultInput(
  value: unknown,
): ConsultationResultInput {
  const item = record(value, "consultation result input");
  if (item.schemaVersion !== CONSULTATION_RESULT_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported consultation result input schema",
      EXIT.inputError,
    );
  if (!Number.isInteger(item.findingCount) || (item.findingCount as number) < 0)
    throw new RigorError("findingCount is invalid", EXIT.inputError);
  const result: ConsultationResultInput = {
    schemaVersion: CONSULTATION_RESULT_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    status: oneOf(item.status, ["completed", "failed"], "status"),
    outcome: oneOf(item.outcome, outcomes, "outcome"),
    findingCount: item.findingCount as number,
    requiredActions: strings(item.requiredActions, "requiredActions", 100),
    usageStatus: oneOf(
      item.usageStatus,
      ["recorded", "unavailable"],
      "usageStatus",
    ),
  };
  for (const [key, value] of Object.entries({
    externalJobId: optionalText(item.externalJobId, "externalJobId"),
    externalSessionId: optionalText(
      item.externalSessionId,
      "externalSessionId",
    ),
    externalTurnId: optionalText(item.externalTurnId, "externalTurnId"),
    model: optionalText(item.model, "model"),
    reasoningEffort: optionalText(item.reasoningEffort, "reasoningEffort"),
  }))
    if (value !== undefined) Object.assign(result, { [key]: value });
  return result;
}

export async function startConsultation(
  root: string,
  policy: Policy,
  preflight: Preflight,
  request: ConsultationRequest,
  now = new Date(),
): Promise<{ session: ConsultationSession; saved: string }> {
  if (request.taskId !== preflight.taskId)
    throw new RigorError(
      "Consultation taskId does not match preflight",
      EXIT.inputError,
    );
  if (preflight.policyHash !== hash(policy))
    throw new RigorError(
      "Consultation preflight does not match the current policy",
      EXIT.policyViolation,
    );
  if (preflight.externalTransmission !== "allowed")
    throw new RigorError(
      "Policy denies transmission to codex-plugin-cc",
      EXIT.policyViolation,
    );
  const facts = await gitFacts(root);
  if (preflight.git.head !== facts.head)
    throw new RigorError(
      "Git HEAD changed after preflight; run preflight again",
      EXIT.policyViolation,
    );
  const changedPathsBefore = filteredChangedPaths(facts.changedPaths);
  const unplanned = changedPathsBefore.filter(
    (file) => !matches(file, preflight.plannedPaths),
  );
  if (unplanned.length > 0)
    throw new RigorError(
      `Changed paths are outside preflight scope: ${unplanned.join(", ")}`,
      EXIT.policyViolation,
    );
  const session: ConsultationSession = {
    schemaVersion: CONSULTATION_SESSION_SCHEMA,
    artifactId: artifactId("consultation-session"),
    taskId: request.taskId,
    createdAt: now.toISOString(),
    preflightArtifactId: preflight.artifactId,
    preflightHash: hash(preflight),
    provider: "codex-plugin-cc",
    mode: request.mode,
    requestedDecision: request.requestedDecision,
    transmissionDecision: "allowed",
    beforeHead: facts.head,
    beforeTreeHash: await treeHash(root, ignoredEvidence),
    changedPathsBefore,
  };
  const saved = await saveCollectionArtifact(
    root,
    request.taskId,
    "consultations",
    "consultation-session",
    session,
  );
  return { session, saved };
}

export async function finishConsultation(
  root: string,
  session: ConsultationSession,
  input: ConsultationResultInput,
  now = new Date(),
): Promise<{ consultation: Consultation; saved: string }> {
  if (input.taskId !== session.taskId)
    throw new RigorError(
      "Consultation result taskId does not match session",
      EXIT.inputError,
    );
  const facts = await gitFacts(root);
  const afterTreeHash = await treeHash(root, ignoredEvidence);
  const changedPathsAfter = filteredChangedPaths(facts.changedPaths);
  const mutated =
    session.beforeHead !== facts.head ||
    session.beforeTreeHash !== afterTreeHash ||
    JSON.stringify(session.changedPathsBefore) !==
      JSON.stringify(changedPathsAfter);
  const consultation: Consultation = {
    schemaVersion: CONSULTATION_SCHEMA,
    artifactId: artifactId("consultation"),
    taskId: session.taskId,
    createdAt: now.toISOString(),
    sessionArtifactId: session.artifactId,
    sessionHash: hash(session),
    provider: session.provider,
    mode: session.mode,
    requestedDecision: session.requestedDecision,
    transmissionDecision: session.transmissionDecision,
    beforeTreeHash: session.beforeTreeHash,
    afterTreeHash,
    beforeHead: session.beforeHead,
    afterHead: facts.head,
    changedPathsBefore: session.changedPathsBefore,
    changedPathsAfter,
    usageStatus: input.usageStatus,
    status: mutated ? "mutated-worktree" : input.status,
    outcome: input.outcome,
    findingCount: input.findingCount,
    requiredActions: input.requiredActions,
  };
  for (const key of [
    "externalJobId",
    "externalSessionId",
    "externalTurnId",
    "model",
    "reasoningEffort",
  ] as const) {
    const value = input[key];
    if (value !== undefined) consultation[key] = value;
  }
  const saved = await saveCollectionArtifact(
    root,
    session.taskId,
    "consultations",
    "consultation",
    consultation,
  );
  return { consultation, saved };
}
