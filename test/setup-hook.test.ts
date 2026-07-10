import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/git.js";
import { defaultPolicy, setup } from "../src/setup.js";
import { userPromptHook } from "../src/hook.js";

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rigor-test-"));
  await run("git", ["init", "-q"], root);
  return root;
}

test("setup is idempotent and never overwrites user content", async () => {
  const root = await repo();
  const bundle = path.join(root, "bundle.cjs");
  await writeFile(bundle, "bundle");
  const first = await setup(root, bundle);
  assert.equal(first.created.length, 5);
  const second = await setup(root, bundle);
  assert.equal(second.unchanged.length, 5);
  await writeFile(path.join(root, ".rigor", "policy.json"), "{}");
  await assert.rejects(setup(root, bundle), /conflict/u);
  assert.equal(
    await readFile(path.join(root, ".rigor", "policy.json"), "utf8"),
    "{}",
  );
});

test("setup rejects a symlinked governance file", async () => {
  const root = await repo();
  const bundle = path.join(root, "bundle.cjs");
  const outside = path.join(
    await mkdtemp(path.join(tmpdir(), "rigor-out-")),
    "policy",
  );
  await writeFile(bundle, "bundle");
  await writeFile(outside, "outside");
  await mkdir(path.join(root, ".rigor"));
  await symlink(outside, path.join(root, ".rigor", "policy.json"));
  await assert.rejects(setup(root, bundle), /Symlink escapes|conflict/u);
});

test("setup detects all conflicts before creating any file", async () => {
  const root = await repo();
  const bundle = path.join(root, "bundle.cjs");
  await writeFile(bundle, "bundle");
  await mkdir(path.join(root, ".rigor"));
  await writeFile(path.join(root, ".rigor", "policy.json"), "user policy");
  await assert.rejects(setup(root, bundle), /no files were changed/u);
  await assert.rejects(
    readFile(path.join(root, ".github", "workflows", "rigor.yml")),
  );
});

test("hook no-ops when absent and blocks broken configured policy", async () => {
  const root = await repo();
  assert.equal(await userPromptHook({}, root), null);
  await mkdir(path.join(root, ".rigor"));
  const blocked = (await userPromptHook({}, root)) as { decision: string };
  assert.equal(blocked.decision, "block");
  await writeFile(
    path.join(root, ".rigor", "policy.json"),
    JSON.stringify(defaultPolicy("repo")),
  );
  const configured = (await userPromptHook({}, root)) as {
    hookSpecificOutput: { hookEventName: string };
  };
  assert.equal(configured.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const invalid = (await userPromptHook("bad", root)) as { decision: string };
  assert.equal(invalid.decision, "block");
});
