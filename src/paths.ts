import path from "node:path";
import { EXIT, RigorError } from "./errors.js";

export function normalizeRepoPath(input: string): string {
  if (
    input.length === 0 ||
    input.includes("\0") ||
    /[\r\n]/u.test(input) ||
    path.isAbsolute(input)
  ) {
    throw new RigorError(
      "Paths must be non-empty relative paths without control characters",
      EXIT.inputError,
    );
  }
  const unix = input.replaceAll("\\", "/");
  const normalized = path.posix.normalize(unix);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new RigorError(
      `Unsafe repository path: ${JSON.stringify(input)}`,
      EXIT.inputError,
    );
  }
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

export function globToRegExp(glob: string): RegExp {
  const normalized = normalizeRepoPath(glob);
  let source = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        i += 1;
        if (normalized[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += escapeRegex(char);
  }
  return new RegExp(`${source}$`, "u");
}

export function matches(pathname: string, globs: string[]): boolean {
  const normalized = normalizeRepoPath(pathname);
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}
