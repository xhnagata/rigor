import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const pluginRoot = path.resolve(import.meta.dirname, "..");

async function git(root: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root })).stdout.trim();
}

async function rigor(
  root: string,
  args: string[],
  expectedCode = 0,
): Promise<Record<string, unknown>> {
  try {
    const result = await exec(path.join(pluginRoot, "bin", "rigor"), args, {
      cwd: root,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    });
    assert.equal(expectedCode, 0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    assert.equal(
      failure.code,
      expectedCode,
      `${failure.stderr}\n${failure.stdout}`,
    );
    return failure.stdout
      ? (JSON.parse(failure.stdout) as Record<string, unknown>)
      : {};
  }
}

test("install-to-review smoke flow and independent CI work in an empty repository", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "rigor-e2e-"));
  const root = path.join(parent, "repo");
  await mkdir(root);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "rigor@example.invalid"]);
  await git(root, ["config", "user.name", "Rigor Test"]);
  const installed = await rigor(root, ["setup"]);
  assert.equal((installed.created as string[]).length, 5);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "configure rigor"]);
  const base = await git(root, ["rev-parse", "HEAD"]);

  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "a.ts"),
    "export const answer = 42;\n",
  );
  const intentFile = path.join(parent, "intent.json");
  await writeFile(
    intentFile,
    JSON.stringify({
      schemaVersion: "rigor.intent.v1",
      taskId: "TASK-1",
      summary: "add answer",
      plannedPaths: ["src/a.ts"],
    }),
  );
  const preflight = await rigor(root, ["preflight", "--intent", intentFile]);
  assert.equal(preflight.riskTier, "high");
  const contractInput = path.join(parent, "contract.json");
  await writeFile(
    contractInput,
    JSON.stringify({
      schemaVersion: "rigor.contract-input.v1",
      taskId: "TASK-1",
      acceptanceCriteria: ["answer module exists"],
      allowedPaths: ["src/**"],
      constraints: ["no external writes"],
    }),
  );
  const contract = await rigor(root, [
    "contract",
    "--preflight",
    String(preflight.saved),
    "--input",
    contractInput,
  ]);
  const verification = await rigor(root, [
    "verify",
    "--contract",
    String(contract.saved),
  ]);
  assert.equal(verification.status, "passed");
  const review = await rigor(root, [
    "review",
    "--contract",
    String(contract.saved),
    "--preflight",
    String(preflight.saved),
    "--verification",
    String(verification.saved),
  ]);
  assert.equal(review.verificationStatus, "passed");

  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "add answer with evidence"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const ci = await rigor(root, ["ci", "--base", base, "--head", head]);
  assert.equal(ci.status, "passed");

  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "test", "existing.test.ts"), "test();\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "add existing test"]);
  const beforeDelete = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["rm", "-q", "test/existing.test.ts"]);
  await git(root, ["commit", "-q", "-m", "weaken tests"]);
  const afterDelete = await git(root, ["rev-parse", "HEAD"]);
  const deletion = await rigor(
    root,
    ["ci", "--base", beforeDelete, "--head", afterDelete],
    2,
  );
  assert.ok(
    (deletion.failures as string[]).some((item) =>
      item.includes("existing test was deleted"),
    ),
  );

  const policyFile = path.join(root, ".rigor", "policy.json");
  const policy = JSON.parse(await readFile(policyFile, "utf8")) as {
    checks: Array<{ args: string[] }>;
  };
  policy.checks[0]!.args = ["status"];
  await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
  await git(root, ["add", policyFile]);
  await git(root, ["commit", "-q", "-m", "weaken check"]);
  const weakened = await git(root, ["rev-parse", "HEAD"]);
  const policyResult = await rigor(
    root,
    ["ci", "--base", afterDelete, "--head", weakened],
    2,
  );
  assert.ok(
    (policyResult.failures as string[]).some((item) =>
      item.includes("base check changed"),
    ),
  );
});
