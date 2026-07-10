import path from "node:path";
import { access } from "node:fs/promises";
import { loadPolicy } from "./artifacts.js";
import { findGitRoot } from "./git.js";

export async function userPromptHook(
  input: unknown,
  cwd = process.cwd(),
): Promise<unknown | null> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return {
      decision: "block",
      reason:
        "Rigor received invalid hook input. Inspect the plugin configuration.",
    };
  let root: string;
  try {
    root = await findGitRoot(cwd);
  } catch {
    return null;
  }
  try {
    await access(path.join(root, ".rigor"));
  } catch {
    return null;
  }
  try {
    await loadPolicy(root);
  } catch {
    return {
      decision: "block",
      reason:
        "Rigor is configured but .rigor/policy.json is missing or invalid. Repair policy or run rigor preflight manually.",
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        "Rigor is configured. Before editing, use /rigor:preflight and keep the task contract and stop conditions current.",
    },
  };
}
