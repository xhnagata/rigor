import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ciBundleFact } from "../src/release.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

test("the committed .rigor/rigor-ci.cjs is byte-identical to dist/rigor.cjs in this repository", async () => {
  // Dogfooding invariant: both files exist here and must match. This is the
  // deterministic check that fails loudly on drift as part of npm run test:all.
  const result = await ciBundleFact(repoRoot);
  assert.equal(
    result,
    true,
    "dist/rigor.cjs and .rigor/rigor-ci.cjs drifted; regenerate with /bin/cp -f dist/rigor.cjs .rigor/rigor-ci.cjs",
  );
});

test("ciBundleFact catches drift when only dist/rigor.cjs is mutated (negative fixture)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rigor-ci-bundle-"));
  try {
    await mkdir(path.join(dir, "dist"));
    await mkdir(path.join(dir, ".rigor"));
    const bytes = Buffer.from("console.log('bundle');\n");
    await writeFile(path.join(dir, "dist", "rigor.cjs"), bytes);
    await writeFile(path.join(dir, ".rigor", "rigor-ci.cjs"), bytes);
    assert.equal(await ciBundleFact(dir), true);

    // Mutate ONLY dist/rigor.cjs, exactly the recurrence mechanism from #29/#44.
    await writeFile(
      path.join(dir, "dist", "rigor.cjs"),
      Buffer.from("console.log('bundle');\n// rebuilt\n"),
    );
    assert.equal(await ciBundleFact(dir), false);

    // Not applicable when the pair is incomplete (consumer-repo shape).
    await rm(path.join(dir, "dist", "rigor.cjs"));
    assert.equal(await ciBundleFact(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("node .rigor/rigor-ci.cjs ci runs under the rigor-ci.cjs filename and emits non-empty JSON (#29 entry-guard)", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  // base === head is an empty range: deterministic, no dependency on working-tree
  // contents. The point is that the entry guard fires under this filename and
  // produces non-empty JSON instead of the silent empty-stdout exit-0 of #29.
  const result = spawnSync(
    process.execPath,
    [".rigor/rigor-ci.cjs", "ci", "--base", head, "--head", head],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const out = (result.stdout ?? "").trim();
  assert.ok(out.length > 0, "the CI verifier produced empty stdout");
  const parsed = JSON.parse(out);
  assert.equal(typeof parsed.status, "string");
});
