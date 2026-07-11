import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { EXIT, RigorError } from "./errors.js";
import { matches } from "./paths.js";
import { run, treeHash } from "./git.js";
import { parsePolicy } from "./schema.js";
import {
  artifactId,
  hash,
  readJson,
  record,
  strings,
  taskId,
  textField,
  writeJson,
} from "./util.js";
import {
  CONTRACT_SCHEMA,
  CONTRACT_INPUT_SCHEMA,
  ESCALATION_SCHEMA,
  ESCALATION_INPUT_SCHEMA,
  PREFLIGHT_SCHEMA,
  REVIEW_SCHEMA,
  VERIFY_SCHEMA,
  type Contract,
  type ContractInput,
  type EscalationInput,
  type Policy,
  type Preflight,
  type Verification,
} from "./types.js";

export function parsePreflight(value: unknown): Preflight {
  const item = record(value, "preflight");
  if (item.schemaVersion !== PREFLIGHT_SCHEMA)
    throw new RigorError("Unsupported preflight schema", EXIT.inputError);
  return item as unknown as Preflight;
}

export function parseContract(value: unknown): Contract {
  const item = record(value, "contract");
  if (item.schemaVersion !== CONTRACT_SCHEMA)
    throw new RigorError("Unsupported contract schema", EXIT.inputError);
  taskId(item.taskId);
  strings(item.acceptanceCriteria, "acceptanceCriteria");
  strings(item.allowedPaths, "allowedPaths");
  return item as unknown as Contract;
}

export function parseContractInput(value: unknown): ContractInput {
  const item = record(value, "contract input");
  if (item.schemaVersion !== CONTRACT_INPUT_SCHEMA)
    throw new RigorError("Unsupported contract input schema", EXIT.inputError);
  return {
    schemaVersion: CONTRACT_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    acceptanceCriteria: strings(item.acceptanceCriteria, "acceptanceCriteria"),
    allowedPaths: strings(item.allowedPaths, "allowedPaths"),
    constraints: strings(item.constraints, "constraints"),
  };
}

export function createContract(
  policy: Policy,
  preflight: Preflight,
  input: ContractInput,
  now = new Date(),
): Contract {
  if (input.taskId !== preflight.taskId)
    throw new RigorError(
      "Contract taskId does not match preflight",
      EXIT.inputError,
    );
  if (
    input.acceptanceCriteria.length === 0 ||
    input.allowedPaths.length === 0
  ) {
    throw new RigorError(
      "Contract needs acceptance criteria and allowed paths",
      EXIT.inputError,
    );
  }
  for (const planned of preflight.plannedPaths) {
    if (!matches(planned, input.allowedPaths))
      throw new RigorError(
        `Planned path is outside contract scope: ${planned}`,
        EXIT.policyViolation,
      );
  }
  return {
    schemaVersion: CONTRACT_SCHEMA,
    artifactId: artifactId("contract"),
    taskId: input.taskId,
    createdAt: now.toISOString(),
    preflightArtifactId: preflight.artifactId,
    preflightHash: hash(preflight),
    riskTier: preflight.riskTier,
    externalTransmission: preflight.externalTransmission,
    acceptanceCriteria: input.acceptanceCriteria,
    allowedPaths: input.allowedPaths,
    constraints: input.constraints,
    requiredChecks: policy.checks
      .filter((check) => check.tiers.includes(preflight.riskTier))
      .map((check) => check.id),
    stopConditions: preflight.stopConditions,
  };
}

export async function verify(
  root: string,
  policy: Policy,
  contract: Contract,
  changedPaths: string[],
  head: string | null,
  now = new Date(),
): Promise<Verification> {
  const scopeViolations = changedPaths.filter(
    (pathname) => !matches(pathname, contract.allowedPaths),
  );
  const checks = [];
  for (const check of policy.checks.filter((item) =>
    contract.requiredChecks.includes(item.id),
  )) {
    let result;
    try {
      result = await run(check.command, check.args, root, check.timeoutMs);
    } catch {
      checks.push({
        id: check.id,
        status: "error" as const,
        exitCode: null,
        durationMs: 0,
        outputDigest: hash("spawn-error"),
      });
      continue;
    }
    const combined = Buffer.concat([result.stdout, result.stderr]);
    checks.push({
      id: check.id,
      status: result.timedOut
        ? ("timed_out" as const)
        : result.code === 0
          ? ("passed" as const)
          : ("failed" as const),
      exitCode: result.code,
      durationMs: result.durationMs,
      outputDigest: hash(combined.toString("utf8")),
    });
  }
  const passed =
    scopeViolations.length === 0 &&
    checks.every((check) => check.status === "passed");
  return {
    schemaVersion: VERIFY_SCHEMA,
    artifactId: artifactId("verification"),
    taskId: contract.taskId,
    contractArtifactId: contract.artifactId,
    createdAt: now.toISOString(),
    policyHash: hash(policy),
    head,
    treeHash: await treeHash(root, [".rigor/evidence/", ".rigor/events.jsonl"]),
    changedPaths,
    scopeViolations,
    checks,
    status: passed ? "passed" : "failed",
  };
}

export function parseEscalationInput(value: unknown): EscalationInput {
  const item = record(value, "escalation input");
  if (item.schemaVersion !== ESCALATION_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported escalation input schema",
      EXIT.inputError,
    );
  if (!Array.isArray(item.attempts))
    throw new RigorError("attempts must be an array", EXIT.inputError);
  const attempts = item.attempts.map((raw, index) => {
    const attempt = record(raw, `attempts[${index}]`);
    return {
      action: textField(attempt.action, `attempts[${index}].action`),
      result: textField(attempt.result, `attempts[${index}].result`),
    };
  });
  const fingerprints = attempts.map(hash);
  if (new Set(fingerprints).size !== fingerprints.length)
    throw new RigorError(
      "Duplicate attempts must be consolidated",
      EXIT.policyViolation,
    );
  return {
    schemaVersion: ESCALATION_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    facts: strings(item.facts, "facts"),
    attempts,
    disprovedHypotheses: strings(
      item.disprovedHypotheses,
      "disprovedHypotheses",
    ),
    speculation: strings(item.speculation, "speculation"),
    requestedDecision: textField(item.requestedDecision, "requestedDecision"),
  };
}

export function createEscalation(
  input: EscalationInput,
  now = new Date(),
): unknown {
  return {
    schemaVersion: ESCALATION_SCHEMA,
    artifactId: artifactId("escalation"),
    createdAt: now.toISOString(),
    taskId: input.taskId,
    facts: input.facts,
    attempts: input.attempts,
    disprovedHypotheses: input.disprovedHypotheses,
    speculation: input.speculation,
    requestedDecision: input.requestedDecision,
  };
}

export function createReview(
  contract: Contract,
  preflight: Preflight,
  verification: Verification,
  now = new Date(),
): unknown {
  if (
    contract.taskId !== preflight.taskId ||
    verification.taskId !== contract.taskId
  )
    throw new RigorError(
      "Review artifacts have different task IDs",
      EXIT.inputError,
    );
  if (verification.contractArtifactId !== contract.artifactId)
    throw new RigorError(
      "Verification is not linked to this contract",
      EXIT.policyViolation,
    );
  return {
    schemaVersion: REVIEW_SCHEMA,
    artifactId: artifactId("review"),
    taskId: contract.taskId,
    createdAt: now.toISOString(),
    externalTransmission: preflight.externalTransmission,
    riskTier: preflight.riskTier,
    requireHumanApproval: preflight.requireHumanApproval,
    contractArtifactId: contract.artifactId,
    verificationArtifactId: verification.artifactId,
    changedPaths: verification.changedPaths,
    acceptanceCriteria: contract.acceptanceCriteria,
    verificationStatus: verification.status,
    note:
      preflight.externalTransmission === "denied"
        ? "Do not send this bundle or repository content to external services."
        : "Policy permits transmission; minimize content and re-check destination controls.",
  };
}

export async function saveArtifact(
  root: string,
  task: string,
  kind: string,
  value: unknown,
): Promise<string> {
  const directory = path.join(root, ".rigor", "evidence", task);
  const file = path.join(directory, `${kind}.json`);
  await writeJson(file, value);
  await appendEvent(root, {
    type: kind,
    taskId: task,
    artifactId: record(value, kind).artifactId,
    at: new Date().toISOString(),
  });
  return file;
}

export async function saveCollectionArtifact(
  root: string,
  task: string,
  collection: string,
  kind: string,
  value: unknown,
): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/u.test(collection))
    throw new RigorError("Invalid artifact collection", EXIT.inputError);
  const item = record(value, kind);
  const id = textField(item.artifactId, `${kind}.artifactId`, 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(id))
    throw new RigorError("Invalid artifact identifier", EXIT.inputError);
  const directory = path.join(root, ".rigor", "evidence", task, collection);
  const file = path.join(directory, `${id}.json`);
  await writeJson(file, value);
  await appendEvent(root, {
    type: kind,
    taskId: task,
    artifactId: id,
    at: new Date().toISOString(),
  });
  return file;
}

async function appendEvent(root: string, event: unknown): Promise<void> {
  const directory = path.join(root, ".rigor");
  await mkdir(directory, { recursive: true });
  await appendFile(
    path.join(directory, "events.jsonl"),
    `${JSON.stringify(event)}\n`,
    { mode: 0o600 },
  );
}

export async function retrospect(root: string): Promise<unknown> {
  let content = "";
  try {
    content = await readFile(path.join(root, ".rigor", "events.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const counts: Record<string, number> = {};
  const tasks = new Set<string>();
  for (const line of content.split("\n").filter(Boolean)) {
    try {
      const event = record(JSON.parse(line) as unknown, "event");
      const type = typeof event.type === "string" ? event.type : "invalid";
      counts[type] = (counts[type] ?? 0) + 1;
      if (typeof event.taskId === "string") tasks.add(event.taskId);
    } catch {
      counts.invalid = (counts.invalid ?? 0) + 1;
    }
  }
  return {
    schemaVersion: "rigor.retrospective.v1",
    generatedAt: new Date().toISOString(),
    taskCount: tasks.size,
    eventCounts: counts,
  };
}

export async function loadPolicy(root: string): Promise<Policy> {
  return parsePolicy(await readJson(path.join(root, ".rigor", "policy.json")));
}
