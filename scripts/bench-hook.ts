import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/git.js";
import { defaultPolicy } from "../src/setup.js";
import { userPromptHook } from "../src/hook.js";

const root = await mkdtemp(path.join(tmpdir(), "rigor-bench-"));
await run("git", ["init", "-q"], root);
await mkdir(path.join(root, ".rigor"));
await writeFile(
  path.join(root, ".rigor", "policy.json"),
  JSON.stringify(defaultPolicy("bench")),
);
const samples: number[] = [];
for (let i = 0; i < 50; i += 1) {
  const start = performance.now();
  await userPromptHook({ hook_event_name: "UserPromptSubmit" }, root);
  samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
const p95 = samples[Math.floor(samples.length * 0.95)] ?? Infinity;
console.log(
  JSON.stringify({
    iterations: samples.length,
    p95Ms: Math.round(p95 * 100) / 100,
    regressionLimitMs: 250,
  }),
);
if (p95 > 250) process.exitCode = 1;
