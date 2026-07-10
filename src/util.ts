import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { EXIT, RigorError } from "./errors.js";

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : stable(value))
    .digest("hex");
}

export function artifactId(kind: string): string {
  return `${kind}_${randomUUID()}`;
}

export async function readJson(file: string): Promise<unknown> {
  try {
    const text = await readFile(file, "utf8");
    if (text.length > 2_000_000)
      throw new RigorError(`Input is too large: ${file}`, EXIT.inputError);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof RigorError) throw error;
    throw new RigorError(
      `Cannot read valid JSON from ${file}`,
      EXIT.inputError,
    );
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

export function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RigorError(`${name} must be an object`, EXIT.inputError);
  }
  return value as Record<string, unknown>;
}

export function textField(value: unknown, name: string, max = 10_000): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.includes("\0")
  ) {
    throw new RigorError(
      `${name} must be a non-empty safe string`,
      EXIT.inputError,
    );
  }
  return value;
}

export function strings(
  value: unknown,
  name: string,
  maxItems = 1000,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new RigorError(`${name} must be an array`, EXIT.inputError);
  }
  return value.map((item, index) => textField(item, `${name}[${index}]`));
}

export function taskId(value: unknown): string {
  const id = textField(value, "taskId", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) {
    throw new RigorError(
      "taskId contains unsupported characters",
      EXIT.inputError,
    );
  }
  return id;
}

export async function assertContainedPath(
  root: string,
  target: string,
): Promise<void> {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RigorError("Path escapes the repository", EXIT.inputError);
  }
  let cursor = target;
  while (cursor !== root) {
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) {
        const resolved = await realpath(cursor);
        const rel = path.relative(root, resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          throw new RigorError(
            "Symlink escapes the repository",
            EXIT.inputError,
          );
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof RigorError)) throw error;
      if (error instanceof RigorError) throw error;
    }
    cursor = path.dirname(cursor);
  }
}
