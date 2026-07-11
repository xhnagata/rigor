import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { EXIT, RigorError } from "./errors.js";
import { normalizeRepoPath } from "./paths.js";
import type { GitFacts } from "./types.js";

export interface CommandResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  durationMs: number;
}

export async function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
  outputLimit = 1_000_000,
): Promise<CommandResult> {
  const start = performance.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= outputLimit) stdout.push(chunk);
      else child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= outputLimit) stderr.push(chunk);
      else child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        durationMs: Math.round(performance.now() - start),
      });
    });
  });
}

async function git(root: string, args: string[]): Promise<Buffer> {
  const result = await run("git", args, root);
  if (result.code !== 0)
    throw new RigorError("Git operation failed", EXIT.inputError);
  return result.stdout;
}

export async function findGitRoot(cwd: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0)
    throw new RigorError(
      "Rigor must run inside a Git worktree",
      EXIT.inputError,
    );
  return path.resolve(result.stdout.toString("utf8").trim());
}

function nulPaths(buffer: Buffer): string[] {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeRepoPath);
}

export async function gitFacts(root: string): Promise<GitFacts> {
  const headResult = await run("git", ["rev-parse", "--verify", "HEAD"], root);
  const head =
    headResult.code === 0 ? headResult.stdout.toString("utf8").trim() : null;
  const status = await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const changed = new Set<string>();
  const entries = status.toString("utf8").split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const pathname = entry.slice(3);
    if (pathname) changed.add(normalizeRepoPath(pathname));
    if (code.includes("R") || code.includes("C")) {
      const next = entries[index + 1];
      if (next) changed.add(normalizeRepoPath(next));
      index += 1;
    }
  }
  return {
    root,
    head,
    dirty: status.length > 0,
    changedPaths: [...changed].sort(),
  };
}

export async function diffPaths(
  root: string,
  base: string,
  head: string,
): Promise<string[]> {
  await verifyCommit(root, base);
  await verifyCommit(root, head);
  return nulPaths(
    await git(root, [
      "diff",
      "--name-only",
      "-z",
      "--find-renames",
      base,
      head,
    ]),
  );
}

export async function verifyCommit(root: string, sha: string): Promise<void> {
  if (!/^[0-9a-fA-F]{7,64}$/u.test(sha))
    throw new RigorError("Invalid commit identifier", EXIT.inputError);
  const result = await run("git", ["cat-file", "-e", `${sha}^{commit}`], root);
  if (result.code !== 0)
    throw new RigorError(
      "Commit identifier does not resolve to a commit",
      EXIT.inputError,
    );
}

export async function showFile(
  root: string,
  sha: string,
  file: string,
): Promise<string | null> {
  await verifyCommit(root, sha);
  const safe = normalizeRepoPath(file);
  const result = await run("git", ["show", `${sha}:${safe}`], root);
  if (result.code !== 0) return null;
  return result.stdout.toString("utf8");
}

export async function treeHash(
  root: string,
  excludedPrefixes: string[] = [],
): Promise<string> {
  const listed = nulPaths(
    await git(root, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]),
  );
  const files = [...new Set(listed)]
    .filter(
      (file) =>
        !excludedPrefixes.some(
          (prefix) => file === prefix || file.startsWith(prefix),
        ),
    )
    .sort();
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(`path\0${file}\0`);
    const target = path.join(root, file);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        digest.update("deleted\0");
        continue;
      }
      throw error;
    }
    digest.update(`mode\0${info.mode}\0`);
    if (info.isSymbolicLink()) {
      digest.update(`symlink\0${await readlink(target)}\0`);
      continue;
    }
    if (!info.isFile())
      throw new RigorError(
        `Cannot hash non-file repository path: ${file}`,
        EXIT.inputError,
      );
    for await (const chunk of createReadStream(target)) digest.update(chunk);
    digest.update("\0");
  }
  return digest.digest("hex");
}
