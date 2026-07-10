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
  retrospect,
  saveArtifact,
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
import { parseIntent } from "./schema.js";
import { setup } from "./setup.js";
import { readJson, record } from "./util.js";
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
      "Usage: rigor <setup|preflight|contract|verify|escalate|review|retrospect|governance|ci|hook> [options]\n",
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
    const result = createEscalation(
      parseEscalationInput(await readJson(option(args, "--input")!)),
    );
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
  if (command === "retrospect") {
    output(await retrospect(root));
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
const isEntry = entryName === "rigor.cjs" || entryName === "cli.ts";
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
