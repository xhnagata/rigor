import path from "node:path";
import process from "node:process";
import {
  createContract,
  createEscalation,
  createReview,
  loadPolicy,
  parseContract,
  parseContractInput,
  parseEscalationInput,
  parsePreflight,
  parseVerification,
  retrospect,
  saveArtifact,
  saveCollectionArtifact,
  verify,
} from "./artifacts.js";
import { ciVerify } from "./ci.js";
import { EXIT, RigorError } from "./errors.js";
import { findGitRoot, gitFacts } from "./git.js";
import {
  githubReader,
  governanceVerify,
  parseBranch,
  parseRepository,
} from "./governance.js";
import { userPromptHook } from "./hook.js";
import { evaluate } from "./policy.js";
import { releaseVerify } from "./release.js";
import {
  createRoutingPlan,
  parseModelProfiles,
  parseRoutingInput,
  parseRoutingPlan,
  route,
} from "./routing.js";
import {
  buildAvailabilityReport,
  parseAvailabilityReport,
  probeEnvironment,
} from "./availability.js";
import {
  finishConsultation,
  parseConsultationRequest,
  parseConsultationResultInput,
  parseConsultationSession,
  startConsultation,
} from "./consultation.js";
import {
  finishAttempt,
  parseAttempt,
  parseAttemptResultInput,
  parseAttemptSession,
  startAttempt,
} from "./attempt.js";
import {
  createOutcome,
  parseOutcomeInput,
  parseReviewArtifact,
} from "./outcome.js";
import { parseIntent } from "./schema.js";
import {
  parseEscalationDecisionInput,
  selectEscalation,
  validateEscalationArtifacts,
} from "./escalation.js";
import { setup } from "./setup.js";
import {
  createClassification,
  hasUnfinishedAttempt,
  parseClassificationInput,
  parseTestIntegrityEvent,
  scanTestIntegrity,
} from "./test-integrity.js";
import { artifactId, readJson, record, taskId, textField } from "./util.js";
import { ESCALATION_DECISION_INPUT_SCHEMA } from "./types.js";
import {
  parseConsultationDecisionInput,
  selectConsultation,
} from "./review-selection.js";
import type { Verification } from "./types.js";

function option(
  args: string[],
  name: string,
  required = true,
): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && (!value || value.startsWith("--")))
    throw new RigorError(`Missing ${name}`, EXIT.inputError);
  return value;
}

function options(args: string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new RigorError(`Missing ${name}`, EXIT.inputError);
    result.push(value);
  }
  return result;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function stdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of process.stdin) {
    const chunk = Buffer.from(raw as Uint8Array);
    size += chunk.length;
    if (size > 1_000_000)
      throw new RigorError("Hook input is too large", EXIT.inputError);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RigorError("Hook input is not valid JSON", EXIT.inputError);
  }
}

export async function main(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(
      "Usage: rigor <setup|preflight|contract|availability|route|attempt-start|attempt-finish|consult-decide|consult-start|consult-finish|verify|escalate|review|outcome|retrospect|test-integrity-scan|test-integrity-classify|governance|release-check|ci|hook> [options]\n",
    );
    return EXIT.success;
  }
  const root = await findGitRoot(cwd);
  if (command === "setup" || command === "upgrade") {
    const bundle =
      process.env.RIGOR_BUNDLE_PATH ??
      path.resolve(process.argv[1] ?? "dist/rigor.cjs");
    output(await setup(root, bundle));
    return EXIT.success;
  }
  if (command === "hook") {
    if (args[0] !== "user-prompt")
      throw new RigorError("Unknown hook", EXIT.inputError);
    const decision = await userPromptHook(await stdinJson(), cwd);
    if (decision) output(decision);
    return EXIT.success;
  }
  const policy = await loadPolicy(root);
  if (command === "preflight") {
    const intent = parseIntent(await readJson(option(args, "--intent")!));
    const result = evaluate(policy, intent, await gitFacts(root));
    const saved = await saveArtifact(root, intent.taskId, "preflight", result);
    output({ ...result, saved });
    return EXIT.success;
  }
  if (command === "contract") {
    const preflight = parsePreflight(
      await readJson(option(args, "--preflight")!),
    );
    const input = parseContractInput(await readJson(option(args, "--input")!));
    const result = createContract(policy, preflight, input);
    const saved = await saveArtifact(root, result.taskId, "contract", result);
    output({ ...result, saved });
    return EXIT.success;
  }
  if (command === "availability") {
    const profiles = parseModelProfiles(
      await readJson(option(args, "--profiles")!),
    );
    const report = buildAvailabilityReport(profiles, probeEnvironment());
    output(report);
    return EXIT.success;
  }
  if (command === "route") {
    const dryRun = args.includes("--dry-run");
    const recordPlan = args.includes("--record");
    if (dryRun === recordPlan)
      throw new RigorError(
        "route requires exactly one of --dry-run or --record",
        EXIT.inputError,
      );
    const preflight = parsePreflight(
      await readJson(option(args, "--preflight")!),
    );
    const input = parseRoutingInput(await readJson(option(args, "--input")!));
    const profiles = parseModelProfiles(
      await readJson(option(args, "--profiles")!),
    );
    const availabilityPath = option(args, "--availability", false);
    const availability = availabilityPath
      ? parseAvailabilityReport(await readJson(availabilityPath))
      : undefined;
    const result = route(preflight, input, profiles, availability);
    if (result.status !== "selected") {
      output(result);
      return EXIT.policyViolation;
    }
    if (dryRun) {
      output(result);
      return EXIT.success;
    }
    const contract = parseContract(await readJson(option(args, "--contract")!));
    const plan = createRoutingPlan(result, preflight, contract);
    const saved = await saveCollectionArtifact(
      root,
      plan.taskId,
      "routing",
      "routing-plan",
      plan,
    );
    output({ ...plan, saved });
    return EXIT.success;
  }
  if (command === "attempt-start") {
    const plan = parseRoutingPlan(await readJson(option(args, "--plan")!));
    const contract = parseContract(await readJson(option(args, "--contract")!));
    const result = await startAttempt(root, policy, plan, contract);
    output({ ...result.session, saved: result.saved });
    return EXIT.success;
  }
  if (command === "attempt-finish") {
    const session = parseAttemptSession(
      await readJson(option(args, "--session")!),
    );
    const contract = parseContract(await readJson(option(args, "--contract")!));
    const input = parseAttemptResultInput(
      await readJson(option(args, "--input")!),
    );
    const verificationPath = option(args, "--verification", false);
    const verification = verificationPath
      ? parseVerification(await readJson(verificationPath))
      : undefined;
    const result = await finishAttempt(
      root,
      session,
      contract,
      input,
      verification,
    );
    output({ ...result.attempt, saved: result.saved });
    return result.attempt.status === "completed"
      ? EXIT.success
      : EXIT.policyViolation;
  }
  if (command === "consult-start") {
    const preflight = parsePreflight(
      await readJson(option(args, "--preflight")!),
    );
    const request = parseConsultationRequest(
      await readJson(option(args, "--input")!),
    );
    const result = await startConsultation(root, policy, preflight, request);
    output({ ...result.session, saved: result.saved });
    return EXIT.success;
  }
  if (command === "consult-decide") {
    const input = parseConsultationDecisionInput(
      await readJson(option(args, "--input")!),
    );
    const result = selectConsultation(input);
    if (args.includes("--dry-run")) {
      output(result);
    } else {
      const evidence = {
        ...result,
        artifactId: artifactId("independent-review-decision"),
        createdAt: new Date().toISOString(),
      };
      const saved = await saveCollectionArtifact(
        root,
        input.taskId,
        "review-decisions",
        "independent-review-decision",
        evidence,
      );
      output({ ...evidence, saved });
    }
    return result.decision === "stop-required-review"
      ? EXIT.policyViolation
      : EXIT.success;
  }
  if (command === "consult-finish") {
    const session = parseConsultationSession(
      await readJson(option(args, "--session")!),
    );
    const input = parseConsultationResultInput(
      await readJson(option(args, "--input")!),
    );
    const result = await finishConsultation(root, session, input);
    output({ ...result.consultation, saved: result.saved });
    return result.consultation.status === "completed"
      ? EXIT.success
      : EXIT.policyViolation;
  }
  if (command === "verify") {
    const contract = parseContract(await readJson(option(args, "--contract")!));
    const facts = await gitFacts(root);
    const result = await verify(
      root,
      policy,
      contract,
      facts.changedPaths.filter(
        (item) =>
          !item.startsWith(".rigor/evidence/") &&
          item !== ".rigor/events.jsonl",
      ),
      facts.head,
    );
    if (args.includes("--dry-run")) {
      output(result);
      return result.status === "passed" ? EXIT.success : EXIT.policyViolation;
    }
    const saved = await saveArtifact(
      root,
      result.taskId,
      "verification",
      result,
    );
    output({ ...result, saved });
    return result.status === "passed" ? EXIT.success : EXIT.policyViolation;
  }
  if (command === "escalate") {
    const rawInput = await readJson(option(args, "--input")!);
    if (
      record(rawInput, "escalation input").schemaVersion ===
      ESCALATION_DECISION_INPUT_SCHEMA
    ) {
      const input = parseEscalationDecisionInput(rawInput);
      const profiles = parseModelProfiles(
        await readJson(option(args, "--profiles")!),
      );
      const availabilityPath = option(args, "--availability", false);
      const availability = availabilityPath
        ? parseAvailabilityReport(await readJson(availabilityPath))
        : undefined;
      const contract = parseContract(
        await readJson(option(args, "--contract")!),
      );
      const planPaths = options(args, "--plan");
      if (planPaths.length === 0)
        throw new RigorError(
          "At least one --plan is required",
          EXIT.inputError,
        );
      const plans = await Promise.all(
        planPaths.map(async (file) => parseRoutingPlan(await readJson(file))),
      );
      const attemptPaths = options(args, "--attempt");
      if (attemptPaths.length === 0)
        throw new RigorError(
          "At least one --attempt is required",
          EXIT.inputError,
        );
      const attempts = await Promise.all(
        attemptPaths.map(async (file) => parseAttempt(await readJson(file))),
      );
      attempts.sort((left, right) => left.sequence - right.sequence);
      validateEscalationArtifacts(input, contract, plans, attempts);
      const decision = selectEscalation(input, profiles, availability);
      if (args.includes("--dry-run")) {
        output(decision);
      } else {
        const evidence = {
          ...decision,
          artifactId: artifactId("escalation-decision"),
          createdAt: new Date().toISOString(),
        };
        const saved = await saveCollectionArtifact(
          root,
          input.taskId,
          "escalations",
          "escalation-decision",
          evidence,
        );
        output({ ...evidence, saved });
      }
      return decision.decision.startsWith("stop-")
        ? EXIT.policyViolation
        : EXIT.success;
    }
    const result = createEscalation(parseEscalationInput(rawInput));
    const task = String(record(result, "escalation").taskId);
    const saved = await saveArtifact(root, task, "escalation", result);
    output({ ...record(result, "escalation"), saved });
    return EXIT.success;
  }
  if (command === "review") {
    const contract = parseContract(await readJson(option(args, "--contract")!));
    const preflight = parsePreflight(
      await readJson(option(args, "--preflight")!),
    );
    const verification = record(
      await readJson(option(args, "--verification")!),
      "verification",
    ) as unknown as Verification;
    const result = createReview(contract, preflight, verification);
    const saved = await saveArtifact(root, contract.taskId, "review", result);
    output({ ...record(result, "review"), saved });
    return verification.status === "passed"
      ? EXIT.success
      : EXIT.policyViolation;
  }
  if (command === "governance") {
    const repository = parseRepository(option(args, "--repo")!);
    const branch = parseBranch(option(args, "--branch", false) ?? "main");
    const requiredCheckContext =
      option(args, "--required-check", false) ?? "rigor";
    const token =
      process.env.RIGOR_GITHUB_TOKEN ??
      process.env.GITHUB_TOKEN ??
      process.env.GH_TOKEN;
    const result = await governanceVerify(
      policy,
      { ...repository, branch, requiredCheckContext },
      githubReader(token),
    );
    output(result);
    return result.status === "passed" ? EXIT.success : EXIT.policyViolation;
  }
  if (command === "release-check") {
    const version = option(args, "--version")!;
    if (!/^\d+\.\d+\.\d+$/u.test(version))
      throw new RigorError(
        "--version must be a semantic version like X.Y.Z",
        EXIT.inputError,
      );
    const expectedBranch = parseBranch(
      option(args, "--branch", false) ?? "main",
    );
    const expectedSha = option(args, "--expected-sha", false) ?? null;
    const repoArg = option(args, "--repo", false);
    const requiredChecks = (
      option(args, "--required-check", false) ?? "quality"
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const repo = repoArg ? parseRepository(repoArg) : null;
    const token =
      process.env.RIGOR_GITHUB_TOKEN ??
      process.env.GITHUB_TOKEN ??
      process.env.GH_TOKEN;
    const read = repo ? githubReader(token) : null;
    const report = await releaseVerify(
      root,
      { version, expectedBranch, expectedSha, repo, requiredChecks },
      read,
    );
    output(report);
    return report.status === "passed" ? EXIT.success : EXIT.policyViolation;
  }
  if (command === "outcome") {
    const input = parseOutcomeInput(await readJson(option(args, "--input")!));
    const attemptPath = option(args, "--attempt", false);
    const verificationPath = option(args, "--verification", false);
    const reviewPath = option(args, "--review", false);
    const attempt = attemptPath
      ? parseAttempt(await readJson(attemptPath))
      : undefined;
    const verification = verificationPath
      ? parseVerification(await readJson(verificationPath))
      : undefined;
    const review = reviewPath
      ? parseReviewArtifact(await readJson(reviewPath))
      : undefined;
    const outcome = createOutcome(input, { attempt, verification, review });
    const saved = await saveArtifact(root, outcome.taskId, "outcome", outcome);
    output({ ...outcome, saved });
    return EXIT.success;
  }
  if (command === "retrospect") {
    output(await retrospect(root));
    return EXIT.success;
  }
  if (command === "test-integrity-scan") {
    const task = taskId(option(args, "--task")!);
    const base = option(args, "--base")!;
    const head = option(args, "--head", false) ?? null;
    const attemptPath = option(args, "--attempt", false);
    const verificationPath = option(args, "--verification", false);
    const noteArg = option(args, "--note", false);
    const note =
      noteArg === undefined ? null : textField(noteArg, "--note", 200);
    let attemptArtifactId: string | null = null;
    let verificationArtifactId: string | null = null;
    if (attemptPath !== undefined) {
      const attempt = parseAttempt(await readJson(attemptPath));
      if (attempt.taskId !== task)
        throw new RigorError(
          "Linked attempt taskId does not match --task",
          EXIT.policyViolation,
        );
      attemptArtifactId = attempt.artifactId;
    }
    if (verificationPath !== undefined) {
      const verification = parseVerification(await readJson(verificationPath));
      if (verification.taskId !== task)
        throw new RigorError(
          "Linked verification taskId does not match --task",
          EXIT.policyViolation,
        );
      verificationArtifactId = verification.artifactId;
    }
    const event = await scanTestIntegrity(root, {
      task,
      base,
      head,
      attemptArtifactId,
      verificationArtifactId,
      note,
    });
    const saved = await saveCollectionArtifact(
      root,
      task,
      "test-integrity",
      "test-integrity-event",
      event,
    );
    output({ ...event, saved });
    return EXIT.success;
  }
  if (command === "test-integrity-classify") {
    const event = parseTestIntegrityEvent(
      await readJson(option(args, "--event")!),
    );
    const input = parseClassificationInput(
      await readJson(option(args, "--input")!),
    );
    if (await hasUnfinishedAttempt(root, event.taskId))
      throw new RigorError(
        "Refusing to classify while an attempt is unfinished for this task",
        EXIT.policyViolation,
      );
    const classification = createClassification(input, event);
    const saved = await saveCollectionArtifact(
      root,
      event.taskId,
      "test-integrity",
      "test-integrity-classification",
      classification,
    );
    output({ ...classification, saved });
    return EXIT.success;
  }
  if (command === "ci") {
    const result = await ciVerify(
      root,
      option(args, "--base")!,
      option(args, "--head")!,
    );
    output(result);
    return result.status === "passed" ? EXIT.success : EXIT.policyViolation;
  }
  throw new RigorError(`Unknown command: ${command}`, EXIT.inputError);
}

const entryName = process.argv[1] ? path.basename(process.argv[1]) : "";
const isEntry =
  entryName === "rigor.cjs" ||
  entryName === "rigor-ci.cjs" ||
  entryName === "cli.ts";
if (isEntry) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof RigorError) {
        process.stderr.write(`rigor: ${error.message}\n`);
        process.exitCode = error.exitCode;
      } else {
        process.stderr.write(
          "rigor: internal error; re-run with validated inputs and inspect local logs\n",
        );
        process.exitCode = EXIT.internalError;
      }
    });
}
