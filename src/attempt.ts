import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { EXIT, RigorError } from "./errors.js";
import { gitFacts, treeHash } from "./git.js";
import { matches } from "./paths.js";
import { saveCollectionArtifact } from "./artifacts.js";
import {
  ATTEMPT_RESULT_INPUT_SCHEMA,
  ATTEMPT_SCHEMA,
  ATTEMPT_SESSION_SCHEMA,
  type Attempt,
  type AttemptResultInput,
  type AttemptSession,
  type CapabilityClass,
  type Contract,
  type Policy,
  type RoutingPlan,
  type RoutingPurpose,
  type Verification,
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
const capabilities: CapabilityClass[] = [
  "economy",
  "standard",
  "premium",
  "frontier",
];
const purposes: RoutingPurpose[] = [
  "implementation",
  "consultation",
  "review",
  "adversarial-review",
  "rescue",
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

async function attemptState(
  root: string,
  task: string,
): Promise<{ count: number; unfinished: string[] }> {
  const directory = path.join(root, ".rigor", "evidence", task, "attempts");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { count: 0, unfinished: [] };
    throw error;
  }
  const sessions = new Set<string>();
  const finished = new Set<string>();
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    let item: Record<string, unknown>;
    try {
      item = record(
        JSON.parse(
          await readFile(path.join(directory, name), "utf8"),
        ) as unknown,
        "attempt artifact",
      );
    } catch {
      throw new RigorError(
        `Invalid attempt artifact: ${name}`,
        EXIT.inputError,
      );
    }
    if (item.schemaVersion === ATTEMPT_SESSION_SCHEMA)
      sessions.add(textField(item.artifactId, "artifactId", 128));
    if (item.schemaVersion === ATTEMPT_SCHEMA)
      finished.add(textField(item.sessionArtifactId, "sessionArtifactId", 128));
  }
  return {
    count: sessions.size,
    unfinished: [...sessions].filter((id) => !finished.has(id)),
  };
}

export function parseAttemptSession(value: unknown): AttemptSession {
  const item = record(value, "attempt session");
  if (item.schemaVersion !== ATTEMPT_SESSION_SCHEMA)
    throw new RigorError("Unsupported attempt session schema", EXIT.inputError);
  const selection = record(item.selection, "selection");
  const budget = record(item.budget, "budget");
  const beforeHead = item.beforeHead;
  if (beforeHead !== null && typeof beforeHead !== "string")
    throw new RigorError("beforeHead is invalid", EXIT.inputError);
  const session: AttemptSession = {
    schemaVersion: ATTEMPT_SESSION_SCHEMA,
    artifactId: textField(item.artifactId, "artifactId", 128),
    taskId: taskId(item.taskId),
    createdAt: textField(item.createdAt, "createdAt", 128),
    sequence: Number(item.sequence),
    routingPlanArtifactId: textField(
      item.routingPlanArtifactId,
      "routingPlanArtifactId",
      128,
    ),
    routingPlanHash: textField(item.routingPlanHash, "routingPlanHash", 128),
    contractArtifactId: textField(
      item.contractArtifactId,
      "contractArtifactId",
      128,
    ),
    contractHash: textField(item.contractHash, "contractHash", 128),
    provider: textField(selection.provider, "selection.provider", 128),
    capabilityClass: oneOf(
      selection.capabilityClass,
      capabilities,
      "selection.capabilityClass",
    ),
    purpose: oneOf(item.purpose, purposes, "purpose"),
    budget: {
      maxAttempts: Number(budget.maxAttempts),
      maxDurationMs: Number(budget.maxDurationMs),
      maxRelativeCost: Number(budget.maxRelativeCost),
    },
    executionIdentityStatus: "unverified",
    beforeHead,
    beforeTreeHash: textField(item.beforeTreeHash, "beforeTreeHash", 128),
    changedPathsBefore: strings(item.changedPathsBefore, "changedPathsBefore"),
  };
  for (const [name, number, minimum, maximum] of [
    ["sequence", session.sequence, 1, 20],
    ["maxAttempts", session.budget.maxAttempts, 1, 20],
    ["maxDurationMs", session.budget.maxDurationMs, 1_000, 86_400_000],
    ["maxRelativeCost", session.budget.maxRelativeCost, 1, 1_000_000],
  ] as const)
    if (!Number.isInteger(number) || number < minimum || number > maximum)
      throw new RigorError(`${name} is out of range`, EXIT.inputError);
  if (item.executionIdentityStatus !== "unverified")
    throw new RigorError(
      "executionIdentityStatus must be unverified",
      EXIT.inputError,
    );
  if (selection.model !== undefined)
    session.model = textField(selection.model, "selection.model", 256);
  return session;
}

export function parseAttempt(value: unknown): Attempt {
  const item = record(value, "attempt");
  if (item.schemaVersion !== ATTEMPT_SCHEMA)
    throw new RigorError("Unsupported attempt schema", EXIT.inputError);
  taskId(item.taskId);
  textField(item.artifactId, "attempt.artifactId", 128);
  if (
    !Number.isInteger(item.sequence) ||
    (item.sequence as number) < 1 ||
    (item.sequence as number) > 20
  )
    throw new RigorError("attempt.sequence is invalid", EXIT.inputError);
  oneOf(
    item.status,
    ["completed", "failed", "cancelled", "scope-violation", "budget-exceeded"],
    "attempt.status",
  );
  if (!Number.isInteger(item.durationMs) || (item.durationMs as number) < 0)
    throw new RigorError("attempt.durationMs is invalid", EXIT.inputError);
  textField(item.provider, "attempt.provider", 128);
  oneOf(item.capabilityClass, capabilities, "attempt.capabilityClass");
  if (item.executionIdentityStatus !== "unverified")
    throw new RigorError(
      "executionIdentityStatus must be unverified",
      EXIT.inputError,
    );
  if (item.model !== undefined) textField(item.model, "attempt.model", 256);
  if (item.verificationArtifactId !== undefined)
    textField(
      item.verificationArtifactId,
      "attempt.verificationArtifactId",
      128,
    );
  return item as unknown as Attempt;
}

export function parseAttemptResultInput(value: unknown): AttemptResultInput {
  const item = record(value, "attempt result input");
  if (item.schemaVersion !== ATTEMPT_RESULT_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported attempt result input schema",
      EXIT.inputError,
    );
  const result: AttemptResultInput = {
    schemaVersion: ATTEMPT_RESULT_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    status: oneOf(item.status, ["completed", "failed", "cancelled"], "status"),
  };
  for (const [key, value] of Object.entries({
    failureClass: optionalText(item.failureClass, "failureClass"),
    externalSessionId: optionalText(
      item.externalSessionId,
      "externalSessionId",
    ),
    externalTurnId: optionalText(item.externalTurnId, "externalTurnId"),
  }))
    if (value !== undefined) Object.assign(result, { [key]: value });
  return result;
}

export async function startAttempt(
  root: string,
  policy: Policy,
  plan: RoutingPlan,
  contract: Contract,
  now = new Date(),
): Promise<{ session: AttemptSession; saved: string }> {
  if (
    plan.taskId !== contract.taskId ||
    plan.contractArtifactId !== contract.artifactId ||
    plan.contractHash !== hash(contract)
  )
    throw new RigorError(
      "Routing plan is not linked to the contract",
      EXIT.policyViolation,
    );
  if (plan.policyHash !== hash(policy))
    throw new RigorError(
      "Routing plan does not match the current policy",
      EXIT.policyViolation,
    );
  if (plan.selection === null)
    throw new RigorError("Routing plan has no selection", EXIT.inputError);
  if (
    plan.selection.provider !== "claude" &&
    plan.selection.provider !== "codex-plugin-cc"
  )
    throw new RigorError(
      "Phase 3 attempts support only claude or codex-plugin-cc",
      EXIT.inputError,
    );
  if (
    plan.selection.provider === "codex-plugin-cc" &&
    plan.controls.externalTransmission !== "allowed"
  )
    throw new RigorError(
      "Routing plan denies Codex transmission",
      EXIT.policyViolation,
    );
  const state = await attemptState(root, plan.taskId);
  if (state.unfinished.length > 0)
    throw new RigorError(
      "An unfinished attempt must be finalized first",
      EXIT.policyViolation,
    );
  if (state.count >= plan.budget.maxAttempts)
    throw new RigorError("Attempt budget is exhausted", EXIT.policyViolation);
  const facts = await gitFacts(root);
  if (facts.head !== plan.plannedHead)
    throw new RigorError(
      "Git HEAD changed after routing; create a new plan",
      EXIT.policyViolation,
    );
  const changedPathsBefore = filteredChangedPaths(facts.changedPaths);
  const outside = changedPathsBefore.filter(
    (file) => !matches(file, contract.allowedPaths),
  );
  if (outside.length > 0)
    throw new RigorError(
      `Changed paths are outside contract scope: ${outside.join(", ")}`,
      EXIT.policyViolation,
    );
  const session: AttemptSession = {
    schemaVersion: ATTEMPT_SESSION_SCHEMA,
    artifactId: artifactId("attempt-session"),
    taskId: plan.taskId,
    createdAt: now.toISOString(),
    sequence: state.count + 1,
    routingPlanArtifactId: plan.artifactId,
    routingPlanHash: hash(plan),
    contractArtifactId: contract.artifactId,
    contractHash: hash(contract),
    provider: plan.selection.provider,
    ...(plan.selection.model === undefined
      ? {}
      : { model: plan.selection.model }),
    capabilityClass: plan.selection.capabilityClass,
    purpose: plan.purpose,
    budget: plan.budget,
    executionIdentityStatus: "unverified",
    beforeHead: facts.head,
    beforeTreeHash: await treeHash(root, ignoredEvidence),
    changedPathsBefore,
  };
  const serialized = {
    ...session,
    selection: {
      provider: session.provider,
      ...(session.model === undefined ? {} : { model: session.model }),
      capabilityClass: session.capabilityClass,
    },
  };
  delete (serialized as Partial<AttemptSession>).provider;
  delete (serialized as Partial<AttemptSession>).model;
  delete (serialized as Partial<AttemptSession>).capabilityClass;
  const saved = await saveCollectionArtifact(
    root,
    plan.taskId,
    "attempts",
    "attempt-session",
    serialized,
  );
  return { session, saved };
}

export async function finishAttempt(
  root: string,
  session: AttemptSession,
  contract: Contract,
  input: AttemptResultInput,
  verification: Verification | undefined,
  now = new Date(),
): Promise<{ attempt: Attempt; saved: string }> {
  if (
    input.taskId !== session.taskId ||
    contract.taskId !== session.taskId ||
    session.contractArtifactId !== contract.artifactId ||
    session.contractHash !== hash(contract)
  )
    throw new RigorError(
      "Attempt result, session, and contract are not linked",
      EXIT.policyViolation,
    );
  if (verification !== undefined) {
    if (
      verification.taskId !== session.taskId ||
      verification.contractArtifactId !== contract.artifactId
    )
      throw new RigorError(
        "Verification is not linked to the attempt contract",
        EXIT.policyViolation,
      );
  }
  if (
    input.status === "completed" &&
    (verification === undefined || verification.status !== "passed")
  )
    throw new RigorError(
      "A completed attempt requires passing verification",
      EXIT.policyViolation,
    );
  const facts = await gitFacts(root);
  const changedPaths = filteredChangedPaths(facts.changedPaths);
  const scopeViolations = changedPaths.filter(
    (file) => !matches(file, contract.allowedPaths),
  );
  const afterTreeHash = await treeHash(root, ignoredEvidence);
  const started = Date.parse(session.createdAt);
  const durationMs = now.getTime() - started;
  if (!Number.isFinite(durationMs) || durationMs < 0)
    throw new RigorError("Attempt timestamps are invalid", EXIT.inputError);
  const status: Attempt["status"] =
    scopeViolations.length > 0
      ? "scope-violation"
      : durationMs > session.budget.maxDurationMs
        ? "budget-exceeded"
        : input.status;
  const attempt: Attempt = {
    schemaVersion: ATTEMPT_SCHEMA,
    artifactId: artifactId("attempt"),
    taskId: session.taskId,
    createdAt: now.toISOString(),
    sessionArtifactId: session.artifactId,
    sessionHash: hash(session),
    routingPlanArtifactId: session.routingPlanArtifactId,
    routingPlanHash: session.routingPlanHash,
    contractArtifactId: session.contractArtifactId,
    contractHash: session.contractHash,
    sequence: session.sequence,
    provider: session.provider,
    ...(session.model === undefined ? {} : { model: session.model }),
    capabilityClass: session.capabilityClass,
    purpose: session.purpose,
    startedAt: session.createdAt,
    completedAt: now.toISOString(),
    durationMs,
    executionIdentityStatus: "unverified",
    status,
    beforeHead: session.beforeHead,
    afterHead: facts.head,
    beforeTreeHash: session.beforeTreeHash,
    afterTreeHash,
    changedPathsBefore: session.changedPathsBefore,
    changedPaths,
    scopeViolations,
    ...(verification === undefined
      ? {}
      : { verificationArtifactId: verification.artifactId }),
  };
  for (const key of [
    "failureClass",
    "externalSessionId",
    "externalTurnId",
  ] as const) {
    const value = input[key];
    if (value !== undefined) attempt[key] = value;
  }
  const saved = await saveCollectionArtifact(
    root,
    session.taskId,
    "attempts",
    "attempt",
    attempt,
  );
  return { attempt, saved };
}
