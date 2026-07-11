import { access, readFile, stat } from "node:fs/promises";
import process from "node:process";

const manifest = JSON.parse(
  await readFile(".claude-plugin/plugin.json", "utf8"),
);
if (manifest.name !== "rigor" || !/^\d+\.\d+\.\d+$/.test(manifest.version))
  throw new Error("invalid plugin manifest identity/version");
const hooks = JSON.parse(await readFile("hooks/hooks.json", "utf8"));
if (!hooks.hooks?.UserPromptSubmit?.length)
  throw new Error("missing UserPromptSubmit hook");
for (const file of [
  "skills/setup/SKILL.md",
  "skills/preflight/SKILL.md",
  "skills/contract/SKILL.md",
  "skills/attempt/SKILL.md",
  "skills/consult/SKILL.md",
  "skills/orchestrate/SKILL.md",
  "skills/assess/SKILL.md",
  "skills/route/SKILL.md",
  "skills/verify/SKILL.md",
  "skills/escalate/SKILL.md",
  "skills/review/SKILL.md",
  "skills/retrospect/SKILL.md",
  "agents/rigor-reviewer.md",
  "dist/rigor.cjs",
])
  await access(file);
if (((await stat("bin/rigor")).mode & 0o111) === 0)
  throw new Error("bin/rigor is not executable");
process.stdout.write("local plugin structure validation passed\n");
