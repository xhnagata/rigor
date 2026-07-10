import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { URL } from "node:url";
import process from "node:process";

const files = execFileSync("git", ["ls-files", "*.md"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
const failures = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (!target || /^(https?:|#)/.test(target)) continue;
    try {
      await readFile(
        new URL(target, new URL(`file://${process.cwd()}/${file}`)),
      );
    } catch {
      failures.push(`${file}: ${target}`);
    }
  }
}
if (failures.length)
  throw new Error(`dangling local links:\n${failures.join("\n")}`);
process.stdout.write("markdown local-link check passed\n");
