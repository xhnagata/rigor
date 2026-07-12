#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/cli.ts
var cli_exports = {};
__export(cli_exports, {
  main: () => main
});
module.exports = __toCommonJS(cli_exports);
var import_node_path12 = __toESM(require("node:path"), 1);
var import_node_process = __toESM(require("node:process"), 1);
var import_promises11 = require("node:fs/promises");

// src/artifacts.ts
var import_promises3 = require("node:fs/promises");
var import_node_path4 = __toESM(require("node:path"), 1);

// src/errors.ts
var RigorError = class extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
    this.name = "RigorError";
  }
};
var EXIT = {
  success: 0,
  policyViolation: 2,
  inputError: 3,
  internalError: 4
};

// src/paths.ts
var import_node_path = __toESM(require("node:path"), 1);
function normalizeRepoPath(input) {
  if (input.length === 0 || input.includes("\0") || /[\r\n]/u.test(input) || import_node_path.default.isAbsolute(input)) {
    throw new RigorError(
      "Paths must be non-empty relative paths without control characters",
      EXIT.inputError
    );
  }
  const unix = input.replaceAll("\\", "/");
  const normalized = import_node_path.default.posix.normalize(unix);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new RigorError(
      `Unsafe repository path: ${JSON.stringify(input)}`,
      EXIT.inputError
    );
  }
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}
function escapeRegex(character) {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}
function globToRegExp(glob) {
  const normalized = normalizeRepoPath(glob);
  let source = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
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
function matches(pathname, globs) {
  const normalized = normalizeRepoPath(pathname);
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

// src/git.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path2 = __toESM(require("node:path"), 1);
async function run(command, args, cwd, timeoutMs = 3e4, outputLimit = 1e6) {
  const start = performance.now();
  return await new Promise((resolve, reject2) => {
    const child = (0, import_node_child_process.spawn)(command, args, {
      cwd,
      shell: false,
      env: { ...process.env, NO_COLOR: "1" }
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size <= outputLimit) stdout.push(chunk);
      else child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      size += chunk.length;
      if (size <= outputLimit) stderr.push(chunk);
      else child.kill("SIGTERM");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject2(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        durationMs: Math.round(performance.now() - start)
      });
    });
  });
}
async function git(root, args) {
  const result = await run("git", args, root);
  if (result.code !== 0)
    throw new RigorError("Git operation failed", EXIT.inputError);
  return result.stdout;
}
async function findGitRoot(cwd) {
  const result = await run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0)
    throw new RigorError(
      "Rigor must run inside a Git worktree",
      EXIT.inputError
    );
  return import_node_path2.default.resolve(result.stdout.toString("utf8").trim());
}
function nulPaths(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean).map(normalizeRepoPath);
}
async function gitFacts(root) {
  const headResult = await run("git", ["rev-parse", "--verify", "HEAD"], root);
  const head = headResult.code === 0 ? headResult.stdout.toString("utf8").trim() : null;
  const status = await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all"
  ]);
  const changed = /* @__PURE__ */ new Set();
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
    changedPaths: [...changed].sort()
  };
}
async function diffPaths(root, base, head) {
  await verifyCommit(root, base);
  await verifyCommit(root, head);
  return nulPaths(
    await git(root, [
      "diff",
      "--name-only",
      "-z",
      "--find-renames",
      base,
      head
    ])
  );
}
var RENAME_SIMILARITY_THRESHOLD = 50;
function stripPathPrefix(raw) {
  if (raw === "/dev/null") return null;
  const trimmed = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
  return trimmed;
}
function parseUnifiedDiff(text) {
  const files = [];
  let current = null;
  let oldPath = null;
  let newPath = null;
  const flush = () => {
    if (current === null) return;
    const path13 = newPath ?? oldPath ?? current.path;
    current.path = path13 === null ? current.path : path13;
    if (current.changeType === "renamed" || current.changeType === "copied") {
      current.path = newPath ?? current.path;
    }
    files.push(current);
  };
  for (const line of text.split(/\r\n|\r|\n/u)) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = {
        changeType: "modified",
        path: "",
        oldPath: null,
        similarity: null,
        addedLines: [],
        removedLines: []
      };
      oldPath = null;
      newPath = null;
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("new file mode")) current.changeType = "added";
    else if (line.startsWith("deleted file mode"))
      current.changeType = "deleted";
    else if (line.startsWith("copy from ")) {
      current.changeType = "copied";
      current.oldPath = line.slice("copy from ".length);
    } else if (line.startsWith("copy to "))
      newPath = line.slice("copy to ".length);
    else if (line.startsWith("rename from ")) {
      current.changeType = "renamed";
      current.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to "))
      newPath = line.slice("rename to ".length);
    else if (line.startsWith("old mode ") || line.startsWith("new mode ")) {
      if (current.changeType === "modified") current.changeType = "typechange";
    } else if (line.startsWith("similarity index ")) {
      const match = /(\d+)%/u.exec(line);
      if (match) current.similarity = Number(match[1]);
    } else if (line.startsWith("--- ")) {
      const parsed = stripPathPrefix(line.slice(4));
      if (parsed !== null && current.oldPath === null) current.oldPath = parsed;
      oldPath = parsed;
    } else if (line.startsWith("+++ ")) {
      newPath = stripPathPrefix(line.slice(4)) ?? newPath;
    } else if (line.startsWith("@@")) {
      continue;
    } else if (line.startsWith("+")) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current.removedLines.push(line.slice(1));
    }
  }
  flush();
  return files.filter((file) => file.path.length > 0);
}
async function diffChanges(root, base, head) {
  await verifyCommit(root, base);
  const args = [
    "diff",
    "--no-color",
    "--unified=0",
    `-M${RENAME_SIMILARITY_THRESHOLD}%`,
    "-C",
    base
  ];
  if (head !== null) {
    await verifyCommit(root, head);
    args.push(head);
  }
  const buffer = await git(root, args);
  return parseUnifiedDiff(buffer.toString("utf8"));
}
async function verifyCommit(root, sha) {
  if (!/^[0-9a-fA-F]{7,64}$/u.test(sha))
    throw new RigorError("Invalid commit identifier", EXIT.inputError);
  const result = await run("git", ["cat-file", "-e", `${sha}^{commit}`], root);
  if (result.code !== 0)
    throw new RigorError(
      "Commit identifier does not resolve to a commit",
      EXIT.inputError
    );
}
async function resolveCommit(root, sha) {
  await verifyCommit(root, sha);
  const result = await run(
    "git",
    ["rev-parse", "--verify", `${sha}^{commit}`],
    root
  );
  if (result.code !== 0)
    throw new RigorError(
      "Commit identifier does not resolve to a commit",
      EXIT.inputError
    );
  return result.stdout.toString("utf8").trim();
}
async function showFile(root, sha, file) {
  await verifyCommit(root, sha);
  const safe = normalizeRepoPath(file);
  const result = await run("git", ["show", `${sha}:${safe}`], root);
  if (result.code !== 0) return null;
  return result.stdout.toString("utf8");
}
async function treeHash(root, excludedPrefixes = []) {
  const listed = nulPaths(
    await git(root, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard"
    ])
  );
  const files = [...new Set(listed)].filter(
    (file) => !excludedPrefixes.some(
      (prefix) => file === prefix || file.startsWith(prefix)
    )
  ).sort();
  const digest2 = (0, import_node_crypto.createHash)("sha256");
  for (const file of files) {
    digest2.update(`path\0${file}\0`);
    const target = import_node_path2.default.join(root, file);
    let info;
    try {
      info = await (0, import_promises.lstat)(target);
    } catch (error) {
      if (error.code === "ENOENT") {
        digest2.update("deleted\0");
        continue;
      }
      throw error;
    }
    digest2.update(`mode\0${info.mode}\0`);
    if (info.isSymbolicLink()) {
      digest2.update(`symlink\0${await (0, import_promises.readlink)(target)}\0`);
      continue;
    }
    if (!info.isFile())
      throw new RigorError(
        `Cannot hash non-file repository path: ${file}`,
        EXIT.inputError
      );
    for await (const chunk of (0, import_node_fs.createReadStream)(target)) digest2.update(chunk);
    digest2.update("\0");
  }
  return digest2.digest("hex");
}

// src/util.ts
var import_node_crypto2 = require("node:crypto");
var import_promises2 = require("node:fs/promises");
var import_node_path3 = __toESM(require("node:path"), 1);
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function hash(value) {
  return (0, import_node_crypto2.createHash)("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
}
function artifactId(kind) {
  return `${kind}_${(0, import_node_crypto2.randomUUID)()}`;
}
async function readJson(file) {
  try {
    const text = await (0, import_promises2.readFile)(file, "utf8");
    if (text.length > 2e6)
      throw new RigorError(`Input is too large: ${file}`, EXIT.inputError);
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof RigorError) throw error;
    throw new RigorError(
      `Cannot read valid JSON from ${file}`,
      EXIT.inputError
    );
  }
}
async function writeJson(file, value) {
  await (0, import_promises2.mkdir)(import_node_path3.default.dirname(file), { recursive: true });
  await (0, import_promises2.writeFile)(file, `${JSON.stringify(value, null, 2)}
`, {
    flag: "wx",
    mode: 384
  });
}
function record(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RigorError(`${name} must be an object`, EXIT.inputError);
  }
  return value;
}
function textField(value, name, max = 1e4) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    throw new RigorError(
      `${name} must be a non-empty safe string`,
      EXIT.inputError
    );
  }
  return value;
}
function strings(value, name, maxItems = 1e3) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new RigorError(`${name} must be an array`, EXIT.inputError);
  }
  return value.map((item, index) => textField(item, `${name}[${index}]`));
}
function taskId(value) {
  const id = textField(value, "taskId", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) {
    throw new RigorError(
      "taskId contains unsupported characters",
      EXIT.inputError
    );
  }
  return id;
}
async function assertContainedPath(root, target) {
  const relative = import_node_path3.default.relative(root, target);
  if (relative.startsWith("..") || import_node_path3.default.isAbsolute(relative)) {
    throw new RigorError("Path escapes the repository", EXIT.inputError);
  }
  let cursor = target;
  while (cursor !== root) {
    try {
      const stat = await (0, import_promises2.lstat)(cursor);
      if (stat.isSymbolicLink()) {
        const resolved = await (0, import_promises2.realpath)(cursor);
        const rel = import_node_path3.default.relative(root, resolved);
        if (rel.startsWith("..") || import_node_path3.default.isAbsolute(rel)) {
          throw new RigorError(
            "Symlink escapes the repository",
            EXIT.inputError
          );
        }
      }
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT" && !(error instanceof RigorError)) throw error;
      if (error instanceof RigorError) throw error;
    }
    cursor = import_node_path3.default.dirname(cursor);
  }
}

// src/fingerprint.ts
var ESC = String.fromCharCode(27);
var BEL = String.fromCharCode(7);
var ANSI_RE = new RegExp(
  ESC + "\\[[0-9;]*[a-zA-Z]|" + ESC + "\\][^" + BEL + "]*" + BEL + "|" + ESC + "[@-Z\\\\\\]^_]",
  "g"
);
var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
var ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
var CLOCK_TIME_RE = /\b\d{2}:\d{2}:\d{2}\b/g;
var DURATION_RE = /\b\d+(?:\.\d+)?(?:ms|s|m)\b/g;
var HEX_PREFIXED_RE = /0x[0-9a-fA-F]+/g;
var HEX_RUN_RE = /\b[0-9a-fA-F]{8,}\b/g;
var WINDOWS_PATH_RE = /[A-Za-z]:\\(?:[\w.@+-]+\\)*[\w.@+-]+\.[A-Za-z0-9]+/g;
var POSIX_PATH_RE = /(?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]+/g;
var LINE_COL_RE = /:\d+(?::\d+)?/g;
var SIGNAL_RE = /error|fail|expect|received|assert|not ok|✖|✗|✘|\bat /iu;
function dedupePreserveOrder(lines) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      result.push(line);
    }
  }
  return result;
}
function applyNoiseMasks(text) {
  let normalized = text;
  normalized = normalized.replace(ANSI_RE, "");
  normalized = normalized.replace(UUID_RE, "<uuid>");
  normalized = normalized.replace(ISO_TIMESTAMP_RE, "<ts>");
  normalized = normalized.replace(CLOCK_TIME_RE, "<time>");
  normalized = normalized.replace(DURATION_RE, "<dur>");
  normalized = normalized.replace(HEX_PREFIXED_RE, "<hex>");
  normalized = normalized.replace(WINDOWS_PATH_RE, "<path>");
  normalized = normalized.replace(POSIX_PATH_RE, "<path>");
  normalized = normalized.replace(HEX_RUN_RE, "<hex>");
  normalized = normalized.replace(LINE_COL_RE, ":<n>");
  return normalized;
}
function normalizeSignature(text) {
  const normalized = applyNoiseMasks(text);
  const lines = normalized.split(/\r\n|\r|\n/u).map((line) => line.trim().replace(/\s+/gu, " ")).filter((line) => line.length > 0);
  const signalLines = lines.filter((line) => SIGNAL_RE.test(line));
  const capped = signalLines.slice(0, 40);
  return dedupePreserveOrder(capped);
}
var NODE_TEST_TOTAL_RE = /^# tests (\d+)/m;
var NODE_TEST_PASS_RE = /^# pass (\d+)/m;
var NODE_TEST_FAIL_RE = /^# fail (\d+)/m;
function parseNodeTestSummary(output2) {
  const total = NODE_TEST_TOTAL_RE.exec(output2)?.[1];
  const passed = NODE_TEST_PASS_RE.exec(output2)?.[1];
  const failed = NODE_TEST_FAIL_RE.exec(output2)?.[1];
  if (total === void 0 || passed === void 0 || failed === void 0)
    return null;
  return {
    total: Number(total),
    passed: Number(passed),
    failed: Number(failed)
  };
}
var JEST_SUMMARY_RE = /Tests:\s*([^\n]+)/i;
var JEST_SEGMENT_RE = /(\d+)\s*(failed|passed|total|skipped|todo)/i;
function parseJestSummary(output2) {
  const segment = JEST_SUMMARY_RE.exec(output2)?.[1];
  if (segment === void 0) return null;
  const counts = {};
  for (const part of segment.split(",")) {
    const match = JEST_SEGMENT_RE.exec(part.trim());
    const value = match?.[1];
    const label = match?.[2];
    if (value !== void 0 && label !== void 0)
      counts[label.toLowerCase()] = Number(value);
  }
  if (counts.total === void 0) return null;
  const failed = counts.failed ?? 0;
  const passed = counts.passed ?? counts.total - failed;
  return { total: counts.total, passed, failed };
}
function parseTestStats(output2) {
  return parseNodeTestSummary(output2) ?? parseJestSummary(output2);
}
var INFRA_PATTERN = /\b(?:ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|ECONNRESET|ENETDOWN)\b|getaddrinfo|socket hang up|rate limit|Too Many Requests|network is unreachable|network error/i;
function deriveCategory(status, normalizedText) {
  if (status === "timed_out") return "timeout";
  if (status === "error") return "infrastructure";
  return INFRA_PATTERN.test(normalizedText) ? "infrastructure" : "implementation";
}
var ERROR_CLASS_PATTERNS = [
  ["assertion", /AssertionError|assert|Expected|Received|toBe|to equal/i],
  ["type", /TypeError|error TS\d+|is not a function/i],
  ["syntax", /SyntaxError/i],
  ["reference", /ReferenceError/i],
  ["range", /RangeError/i],
  ["module", /Cannot find module|ERR_MODULE_NOT_FOUND/i],
  ["lint", /eslint|problems \(|✖ \d+ problems/i],
  ["timeout", /timed out|timeout/i],
  ["runtime", /Error/i]
];
function deriveErrorClass(normalizedText) {
  for (const [label, pattern] of ERROR_CLASS_PATTERNS) {
    if (pattern.test(normalizedText)) return label;
  }
  return "unknown";
}
var FAILED_TEST_PATTERNS = [
  /^not ok \d+ - (.+)$/gm,
  /^\s*✗\s+(.+)$/gm,
  /^\s*✖\s+(.+)$/gm,
  /^FAIL\s+(.+)$/gm
];
var TRAILING_DURATION_RE = /\s*\(\d+(?:\.\d+)?(?:ms|s|m)\)\s*$/u;
var MAX_TEST_NAME_LENGTH = 200;
function normalizeTestName(name) {
  const withoutDuration = name.replace(TRAILING_DURATION_RE, "");
  const masked = applyNoiseMasks(withoutDuration).replace(/\s+/gu, " ").trim();
  return masked.slice(0, MAX_TEST_NAME_LENGTH);
}
function extractFailedTests(output2) {
  const names = [];
  for (const pattern of FAILED_TEST_PATTERNS) {
    for (const match of output2.matchAll(pattern)) {
      const raw = match[1];
      if (raw !== void 0) names.push(normalizeTestName(raw));
    }
  }
  names.sort();
  return [...new Set(names)].slice(0, 50);
}
function deriveCheckFacts(input) {
  const { checkId, status, output: output2 } = input;
  const testStats = parseTestStats(output2);
  if (status === "passed") {
    return { checkId, status, testStats, failure: null };
  }
  const normalizedText = normalizeSignature(output2).join("\n");
  const category = deriveCategory(status, normalizedText);
  const errorClass = deriveErrorClass(normalizedText);
  const failedTests = extractFailedTests(output2);
  const signatureDigest = hash(normalizedText);
  const fingerprint = hash({
    checkId,
    category,
    errorClass,
    failedTests,
    signatureDigest
  });
  return {
    checkId,
    status,
    testStats,
    failure: {
      category,
      errorClass,
      failedTests,
      signatureDigest,
      fingerprint
    }
  };
}
function verificationFingerprint(facts) {
  const failing = facts.filter(
    (fact) => fact.failure !== null
  );
  if (failing.length === 0) return null;
  const sorted = [...failing].sort(
    (a, b) => a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0
  );
  return hash(sorted.map((fact) => fact.failure.fingerprint));
}
function aggregateCategory(facts) {
  const categories = facts.filter(
    (fact) => fact.failure !== null
  ).map((fact) => fact.failure.category);
  if (categories.length === 0) return null;
  const unique = new Set(categories);
  if (unique.size === 1) {
    const [only] = unique;
    if (only !== void 0) return only;
  }
  return "mixed";
}
function implFailureMap(facts) {
  const map = /* @__PURE__ */ new Map();
  for (const fact of facts) {
    if (fact.failure !== null && fact.failure.category === "implementation") {
      map.set(fact.checkId, {
        fingerprint: fact.failure.fingerprint,
        failedTests: new Set(fact.failure.failedTests)
      });
    }
  }
  return map;
}
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
function isSubset(subset, superset) {
  for (const value of subset) if (!superset.has(value)) return false;
  return true;
}
function resolvedImplCheckIds(prevImpl, curImpl) {
  return [...prevImpl.keys()].filter((checkId) => !curImpl.has(checkId));
}
function confirmCoverageForResolvedChecks(resolvedCheckIds, previousByCheck, currentByCheck) {
  const signals = [];
  for (const checkId of resolvedCheckIds) {
    const priorStats = previousByCheck.get(checkId)?.testStats ?? null;
    const curStats = currentByCheck.get(checkId)?.testStats ?? null;
    const confirmed = priorStats !== null && curStats !== null && curStats.total >= priorStats.total;
    if (!confirmed) {
      signals.push(
        `check ${checkId}: cannot confirm test coverage did not shrink (no parseable test counts)`
      );
    }
  }
  return signals;
}
function reducedOrIncomparable(prevImpl, curImpl, weakeningSignals, previousByCheck, currentByCheck) {
  if (weakeningSignals.length > 0) {
    return { status: "incomparable", weakeningSignals };
  }
  const coverageSignals = confirmCoverageForResolvedChecks(
    resolvedImplCheckIds(prevImpl, curImpl),
    previousByCheck,
    currentByCheck
  );
  if (coverageSignals.length === 0) {
    return { status: "reduced", weakeningSignals };
  }
  return {
    status: "incomparable",
    weakeningSignals: [...weakeningSignals, ...coverageSignals]
  };
}
function compareFailures(previous, current) {
  if (previous === null || previous.length === 0) {
    return { status: "first", weakeningSignals: [] };
  }
  const weakeningSignals = [];
  const currentByCheck = new Map(current.map((fact) => [fact.checkId, fact]));
  const previousByCheck = new Map(previous.map((fact) => [fact.checkId, fact]));
  for (const prevFact of previous) {
    const curFact = currentByCheck.get(prevFact.checkId);
    if (curFact === void 0) {
      weakeningSignals.push(
        `check ${prevFact.checkId}: no longer present in verification`
      );
      continue;
    }
    if (prevFact.testStats !== null && curFact.testStats !== null && curFact.testStats.total < prevFact.testStats.total) {
      weakeningSignals.push(
        `check ${prevFact.checkId}: observed test total dropped from ${prevFact.testStats.total} to ${curFact.testStats.total}`
      );
    }
  }
  const prevImpl = implFailureMap(previous);
  const curImpl = implFailureMap(current);
  const prevImplEmpty = prevImpl.size === 0;
  const curImplEmpty = curImpl.size === 0;
  if (!prevImplEmpty && curImplEmpty) {
    return reducedOrIncomparable(
      prevImpl,
      curImpl,
      weakeningSignals,
      previousByCheck,
      currentByCheck
    );
  }
  if (prevImplEmpty) {
    return { status: "incomparable", weakeningSignals };
  }
  const prevFingerprints = new Set(
    [...prevImpl.values()].map((value) => value.fingerprint)
  );
  const curFingerprints = new Set(
    [...curImpl.values()].map((value) => value.fingerprint)
  );
  const sameKeys = prevImpl.size === curImpl.size && [...prevImpl.keys()].every((key) => curImpl.has(key));
  const sameFailedTests = sameKeys && [...prevImpl.entries()].every(([key, value]) => {
    const curValue = curImpl.get(key);
    return curValue !== void 0 && setsEqual(value.failedTests, curValue.failedTests);
  });
  if (setsEqual(prevFingerprints, curFingerprints) && sameFailedTests) {
    return { status: "unchanged", weakeningSignals };
  }
  const curStrictSubsetOfPrev = curFingerprints.size < prevFingerprints.size && isSubset(curFingerprints, prevFingerprints);
  if (curStrictSubsetOfPrev) {
    return reducedOrIncomparable(
      prevImpl,
      curImpl,
      weakeningSignals,
      previousByCheck,
      currentByCheck
    );
  }
  const prevStrictSubsetOfCur = prevFingerprints.size < curFingerprints.size && isSubset(prevFingerprints, curFingerprints);
  const newFailingAppeared = [...curImpl.keys()].some((key) => !prevImpl.has(key)) || [...curImpl.entries()].some(([key, value]) => {
    const prevValue = prevImpl.get(key);
    if (prevValue === void 0) return false;
    for (const test of value.failedTests)
      if (!prevValue.failedTests.has(test)) return true;
    return false;
  });
  if (prevStrictSubsetOfCur || newFailingAppeared) {
    return { status: "expanded", weakeningSignals };
  }
  return { status: "incomparable", weakeningSignals };
}

// src/types.ts
var POLICY_SCHEMA = "rigor.policy.v1";
var INTENT_SCHEMA = "rigor.intent.v1";
var PREFLIGHT_SCHEMA = "rigor.preflight.v1";
var CONTRACT_SCHEMA = "rigor.contract.v1";
var CONTRACT_INPUT_SCHEMA = "rigor.contract-input.v1";
var VERIFY_SCHEMA = "rigor.verification.v1";
var ESCALATION_SCHEMA = "rigor.escalation.v1";
var ESCALATION_INPUT_SCHEMA = "rigor.escalation-input.v1";
var ESCALATION_DECISION_INPUT_SCHEMA = "rigor.escalation-decision-input.v1";
var ESCALATION_DECISION_SCHEMA = "rigor.escalation-decision.v1";
var REVIEW_SCHEMA = "rigor.review.v1";
var ROUTING_INPUT_SCHEMA = "rigor.routing-input.v1";
var ROUTING_INPUT_V2_SCHEMA = "rigor.routing-input.v2";
var MODEL_PROFILES_SCHEMA = "rigor.model-profiles.v1";
var ROUTING_DECISION_SCHEMA = "rigor.routing-decision.v1";
var ATTEMPT_SCHEMA = "rigor.attempt.v1";
var CONSULTATION_SCHEMA = "rigor.consultation.v1";
var CONSULTATION_V2_SCHEMA = "rigor.consultation.v2";
var CONSULTATION_REQUEST_SCHEMA = "rigor.consultation-request.v1";
var CONSULTATION_SESSION_SCHEMA = "rigor.consultation-session.v1";
var CONSULTATION_RESULT_INPUT_SCHEMA = "rigor.consultation-result-input.v1";
var CONSULTATION_RESULT_INPUT_V2_SCHEMA = "rigor.consultation-result-input.v2";
var CONSULTATION_DECISION_INPUT_SCHEMA = "rigor.independent-review-input.v1";
var CONSULTATION_DECISION_SCHEMA = "rigor.independent-review-decision.v1";
var ROUTING_PLAN_SCHEMA = "rigor.routing-plan.v1";
var ATTEMPT_SESSION_SCHEMA = "rigor.attempt-session.v1";
var ATTEMPT_RESULT_INPUT_SCHEMA = "rigor.attempt-result-input.v1";
var OUTCOME_INPUT_SCHEMA = "rigor.outcome-input.v1";
var OUTCOME_SCHEMA = "rigor.outcome.v1";
var AVAILABILITY_SCHEMA = "rigor.availability.v1";
var TEST_INTEGRITY_EVENT_SCHEMA = "rigor.test-integrity-event.v1";
var TEST_INTEGRITY_CLASSIFICATION_INPUT_SCHEMA = "rigor.test-integrity-classification-input.v1";
var TEST_INTEGRITY_CLASSIFICATION_SCHEMA = "rigor.test-integrity-classification.v1";
var EVALUATION_MANIFEST_SCHEMA = "rigor.evaluation-manifest.v1";
var EVALUATION_REPORT_SCHEMA = "rigor.evaluation-report.v1";
var EVALUATION_REPLAY_SCHEMA = "rigor.evaluation-replay.v1";
var CALIBRATION_PROPOSAL_SCHEMA = "rigor.calibration-proposal.v1";
var CALIBRATION_PROPOSAL_INPUT_SCHEMA = "rigor.calibration-proposal-input.v1";

// src/schema.ts
var tiers = ["low", "medium", "high", "critical"];
function tier(value, name) {
  if (typeof value !== "string" || !tiers.includes(value)) {
    throw new RigorError(`${name} must be a valid risk tier`, EXIT.inputError);
  }
  return value;
}
function bool(value, name) {
  if (value === void 0) return void 0;
  if (typeof value !== "boolean")
    throw new RigorError(`${name} must be boolean`, EXIT.inputError);
  return value;
}
function parseRule(value, index) {
  const item = record(value, `rules[${index}]`);
  const rule = {
    id: textField(item.id, `rules[${index}].id`, 128),
    paths: strings(item.paths, `rules[${index}].paths`).map(normalizeRepoPath),
    tier: tier(item.tier, `rules[${index}].tier`),
    reason: textField(item.reason, `rules[${index}].reason`, 1e3)
  };
  const protectedValue = bool(item.protected, `rules[${index}].protected`);
  const deny = bool(
    item.denyExternalTransmission,
    `rules[${index}].denyExternalTransmission`
  );
  const approval = bool(
    item.requireHumanApproval,
    `rules[${index}].requireHumanApproval`
  );
  if (protectedValue !== void 0) rule.protected = protectedValue;
  if (deny !== void 0) rule.denyExternalTransmission = deny;
  if (approval !== void 0) rule.requireHumanApproval = approval;
  return rule;
}
function parseCheck(value, index) {
  const item = record(value, `checks[${index}]`);
  const timeout = item.timeoutMs;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 9e5) {
    throw new RigorError(
      `checks[${index}].timeoutMs is out of range`,
      EXIT.inputError
    );
  }
  return {
    id: textField(item.id, `checks[${index}].id`, 128),
    command: textField(item.command, `checks[${index}].command`, 512),
    args: strings(item.args, `checks[${index}].args`, 100),
    tiers: strings(item.tiers, `checks[${index}].tiers`, 4).map(
      (v) => tier(v, "check tier")
    ),
    timeoutMs: timeout
  };
}
function parsePolicy(value) {
  const item = record(value, "policy");
  if (item.schemaVersion !== POLICY_SCHEMA)
    throw new RigorError(`Unsupported policy schemaVersion`, EXIT.inputError);
  if (item.defaultExternalTransmission !== "allow" && item.defaultExternalTransmission !== "deny") {
    throw new RigorError(
      "Invalid defaultExternalTransmission",
      EXIT.inputError
    );
  }
  if (!Array.isArray(item.rules) || !Array.isArray(item.checks))
    throw new RigorError("rules and checks are required", EXIT.inputError);
  const stops = record(item.stopConditions, "stopConditions");
  const ci = record(item.ci, "ci");
  if (typeof ci.requireEvidence !== "boolean" || ci.maxPolicyWeakening !== "none") {
    throw new RigorError("Invalid ci policy", EXIT.inputError);
  }
  const policy = {
    schemaVersion: POLICY_SCHEMA,
    repositoryId: textField(item.repositoryId, "repositoryId", 256),
    defaultTier: tier(item.defaultTier, "defaultTier"),
    defaultExternalTransmission: item.defaultExternalTransmission,
    rules: item.rules.map(parseRule),
    checks: item.checks.map(parseCheck),
    stopConditions: {
      low: strings(stops.low, "stopConditions.low"),
      medium: strings(stops.medium, "stopConditions.medium"),
      high: strings(stops.high, "stopConditions.high"),
      critical: strings(stops.critical, "stopConditions.critical")
    },
    ci: { requireEvidence: ci.requireEvidence, maxPolicyWeakening: "none" }
  };
  const ids = [
    ...policy.rules.map((r) => r.id),
    ...policy.checks.map((c) => c.id)
  ];
  if (new Set(ids).size !== ids.length)
    throw new RigorError("Rule and check IDs must be unique", EXIT.inputError);
  return policy;
}
function parseIntent(value) {
  const item = record(value, "intent");
  if (item.schemaVersion !== INTENT_SCHEMA)
    throw new RigorError("Unsupported intent schemaVersion", EXIT.inputError);
  const result = {
    schemaVersion: INTENT_SCHEMA,
    taskId: taskId(item.taskId),
    summary: textField(item.summary, "summary", 2e3),
    plannedPaths: strings(item.plannedPaths, "plannedPaths").map(
      normalizeRepoPath
    )
  };
  if (item.operations !== void 0)
    result.operations = strings(item.operations, "operations", 100);
  return result;
}

// src/artifacts.ts
function parsePreflight(value) {
  const item = record(value, "preflight");
  if (item.schemaVersion !== PREFLIGHT_SCHEMA)
    throw new RigorError("Unsupported preflight schema", EXIT.inputError);
  return item;
}
function parseContract(value) {
  const item = record(value, "contract");
  if (item.schemaVersion !== CONTRACT_SCHEMA)
    throw new RigorError("Unsupported contract schema", EXIT.inputError);
  taskId(item.taskId);
  strings(item.acceptanceCriteria, "acceptanceCriteria");
  strings(item.allowedPaths, "allowedPaths");
  return item;
}
function parseVerification(value) {
  const item = record(value, "verification");
  if (item.schemaVersion !== VERIFY_SCHEMA)
    throw new RigorError("Unsupported verification schema", EXIT.inputError);
  taskId(item.taskId);
  textField(item.artifactId, "verification.artifactId", 128);
  textField(item.contractArtifactId, "verification.contractArtifactId", 128);
  strings(item.changedPaths, "verification.changedPaths");
  if (item.status !== "passed" && item.status !== "failed")
    throw new RigorError("Invalid verification status", EXIT.inputError);
  if (item.failureFingerprint !== void 0 && item.failureFingerprint !== null)
    textField(item.failureFingerprint, "verification.failureFingerprint", 128);
  if (item.failureFacts !== void 0 && !Array.isArray(item.failureFacts))
    throw new RigorError(
      "verification.failureFacts must be an array",
      EXIT.inputError
    );
  return item;
}
function parseContractInput(value) {
  const item = record(value, "contract input");
  if (item.schemaVersion !== CONTRACT_INPUT_SCHEMA)
    throw new RigorError("Unsupported contract input schema", EXIT.inputError);
  return {
    schemaVersion: CONTRACT_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    acceptanceCriteria: strings(item.acceptanceCriteria, "acceptanceCriteria"),
    allowedPaths: strings(item.allowedPaths, "allowedPaths"),
    constraints: strings(item.constraints, "constraints")
  };
}
function createContract(policy, preflight, input, now = /* @__PURE__ */ new Date()) {
  if (input.taskId !== preflight.taskId)
    throw new RigorError(
      "Contract taskId does not match preflight",
      EXIT.inputError
    );
  if (input.acceptanceCriteria.length === 0 || input.allowedPaths.length === 0) {
    throw new RigorError(
      "Contract needs acceptance criteria and allowed paths",
      EXIT.inputError
    );
  }
  for (const planned of preflight.plannedPaths) {
    if (!matches(planned, input.allowedPaths))
      throw new RigorError(
        `Planned path is outside contract scope: ${planned}`,
        EXIT.policyViolation
      );
  }
  return {
    schemaVersion: CONTRACT_SCHEMA,
    artifactId: artifactId("contract"),
    taskId: input.taskId,
    createdAt: now.toISOString(),
    preflightArtifactId: preflight.artifactId,
    preflightHash: hash(preflight),
    riskTier: preflight.riskTier,
    externalTransmission: preflight.externalTransmission,
    acceptanceCriteria: input.acceptanceCriteria,
    allowedPaths: input.allowedPaths,
    constraints: input.constraints,
    requiredChecks: policy.checks.filter((check) => check.tiers.includes(preflight.riskTier)).map((check) => check.id),
    stopConditions: preflight.stopConditions
  };
}
async function verify(root, policy, contract, changedPaths, head, now = /* @__PURE__ */ new Date()) {
  const scopeViolations = changedPaths.filter(
    (pathname) => !matches(pathname, contract.allowedPaths)
  );
  const checks = [];
  const failureFacts = [];
  for (const check of policy.checks.filter(
    (item) => contract.requiredChecks.includes(item.id)
  )) {
    let result;
    try {
      result = await run(check.command, check.args, root, check.timeoutMs);
    } catch {
      const facts2 = deriveCheckFacts({
        checkId: check.id,
        status: "error",
        exitCode: null,
        output: "spawn-error"
      });
      failureFacts.push(facts2);
      checks.push({
        id: check.id,
        status: "error",
        exitCode: null,
        durationMs: 0,
        outputDigest: hash("spawn-error"),
        ...facts2.failure === null ? {} : { failure: facts2.failure }
      });
      continue;
    }
    const combined = Buffer.concat([result.stdout, result.stderr]);
    const outputText = combined.toString("utf8");
    const status = result.timedOut ? "timed_out" : result.code === 0 ? "passed" : "failed";
    const facts = deriveCheckFacts({
      checkId: check.id,
      status,
      exitCode: result.code,
      output: outputText
    });
    failureFacts.push(facts);
    checks.push({
      id: check.id,
      status,
      exitCode: result.code,
      durationMs: result.durationMs,
      outputDigest: hash(outputText),
      ...facts.testStats === null ? {} : { testStats: facts.testStats },
      ...facts.failure === null ? {} : { failure: facts.failure }
    });
  }
  const passed = scopeViolations.length === 0 && checks.every((check) => check.status === "passed");
  return {
    schemaVersion: VERIFY_SCHEMA,
    artifactId: artifactId("verification"),
    taskId: contract.taskId,
    contractArtifactId: contract.artifactId,
    createdAt: now.toISOString(),
    policyHash: hash(policy),
    head,
    treeHash: await treeHash(root, [".rigor/evidence/", ".rigor/events.jsonl"]),
    changedPaths,
    scopeViolations,
    checks,
    status: passed ? "passed" : "failed",
    failureFingerprint: verificationFingerprint(failureFacts),
    failureFacts
  };
}
function parseEscalationInput(value) {
  const item = record(value, "escalation input");
  if (item.schemaVersion !== ESCALATION_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported escalation input schema",
      EXIT.inputError
    );
  if (!Array.isArray(item.attempts))
    throw new RigorError("attempts must be an array", EXIT.inputError);
  const attempts = item.attempts.map((raw, index) => {
    const attempt = record(raw, `attempts[${index}]`);
    return {
      action: textField(attempt.action, `attempts[${index}].action`),
      result: textField(attempt.result, `attempts[${index}].result`)
    };
  });
  const fingerprints = attempts.map(hash);
  if (new Set(fingerprints).size !== fingerprints.length)
    throw new RigorError(
      "Duplicate attempts must be consolidated",
      EXIT.policyViolation
    );
  return {
    schemaVersion: ESCALATION_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    facts: strings(item.facts, "facts"),
    attempts,
    disprovedHypotheses: strings(
      item.disprovedHypotheses,
      "disprovedHypotheses"
    ),
    speculation: strings(item.speculation, "speculation"),
    requestedDecision: textField(item.requestedDecision, "requestedDecision")
  };
}
function createEscalation(input, now = /* @__PURE__ */ new Date()) {
  return {
    schemaVersion: ESCALATION_SCHEMA,
    artifactId: artifactId("escalation"),
    createdAt: now.toISOString(),
    taskId: input.taskId,
    facts: input.facts,
    attempts: input.attempts,
    disprovedHypotheses: input.disprovedHypotheses,
    speculation: input.speculation,
    requestedDecision: input.requestedDecision
  };
}
function createReview(contract, preflight, verification, now = /* @__PURE__ */ new Date()) {
  if (contract.taskId !== preflight.taskId || verification.taskId !== contract.taskId)
    throw new RigorError(
      "Review artifacts have different task IDs",
      EXIT.inputError
    );
  if (verification.contractArtifactId !== contract.artifactId)
    throw new RigorError(
      "Verification is not linked to this contract",
      EXIT.policyViolation
    );
  return {
    schemaVersion: REVIEW_SCHEMA,
    artifactId: artifactId("review"),
    taskId: contract.taskId,
    createdAt: now.toISOString(),
    externalTransmission: preflight.externalTransmission,
    riskTier: preflight.riskTier,
    requireHumanApproval: preflight.requireHumanApproval,
    contractArtifactId: contract.artifactId,
    verificationArtifactId: verification.artifactId,
    changedPaths: verification.changedPaths,
    acceptanceCriteria: contract.acceptanceCriteria,
    verificationStatus: verification.status,
    note: preflight.externalTransmission === "denied" ? "Do not send this bundle or repository content to external services." : "Policy permits transmission; minimize content and re-check destination controls."
  };
}
async function saveArtifact(root, task, kind, value) {
  const directory = import_node_path4.default.join(root, ".rigor", "evidence", task);
  const file = import_node_path4.default.join(directory, `${kind}.json`);
  await writeJson(file, value);
  await appendEvent(root, {
    type: kind,
    taskId: task,
    artifactId: record(value, kind).artifactId,
    at: (/* @__PURE__ */ new Date()).toISOString()
  });
  return file;
}
async function saveCollectionArtifact(root, task, collection, kind, value) {
  if (!/^[a-z][a-z0-9-]*$/u.test(collection))
    throw new RigorError("Invalid artifact collection", EXIT.inputError);
  const item = record(value, kind);
  const id = textField(item.artifactId, `${kind}.artifactId`, 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(id))
    throw new RigorError("Invalid artifact identifier", EXIT.inputError);
  const directory = import_node_path4.default.join(root, ".rigor", "evidence", task, collection);
  const file = import_node_path4.default.join(directory, `${id}.json`);
  await writeJson(file, value);
  await appendEvent(root, {
    type: kind,
    taskId: task,
    artifactId: id,
    at: (/* @__PURE__ */ new Date()).toISOString()
  });
  return file;
}
async function appendEvent(root, event) {
  const directory = import_node_path4.default.join(root, ".rigor");
  await (0, import_promises3.mkdir)(directory, { recursive: true });
  await (0, import_promises3.appendFile)(
    import_node_path4.default.join(directory, "events.jsonl"),
    `${JSON.stringify(event)}
`,
    { mode: 384 }
  );
}
async function retrospect(root) {
  let content = "";
  try {
    content = await (0, import_promises3.readFile)(import_node_path4.default.join(root, ".rigor", "events.jsonl"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const counts = {};
  const tasks = /* @__PURE__ */ new Set();
  for (const line of content.split("\n").filter(Boolean)) {
    try {
      const event = record(JSON.parse(line), "event");
      const type = typeof event.type === "string" ? event.type : "invalid";
      counts[type] = (counts[type] ?? 0) + 1;
      if (typeof event.taskId === "string") tasks.add(event.taskId);
    } catch {
      counts.invalid = (counts.invalid ?? 0) + 1;
    }
  }
  const { outcomeTotals, candidates } = await aggregateOutcomes(root);
  const testIntegrity = await aggregateTestIntegrity(root);
  return {
    schemaVersion: "rigor.retrospective.v1",
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    taskCount: tasks.size,
    eventCounts: counts,
    outcomeTotals,
    candidates,
    testIntegrity
  };
}
var TEST_INTEGRITY_SIGNAL_IDS = [
  "TI-05",
  "TI-06",
  "TI-07",
  "TI-08",
  "TI-09"
];
async function aggregateTestIntegrity(root) {
  const evidence = import_node_path4.default.join(root, ".rigor", "evidence");
  let malformedEvents = 0;
  let malformedClassifications = 0;
  let classificationCount = 0;
  const events = [];
  const verdictEntries = [];
  let taskDirs = [];
  try {
    const entries = await (0, import_promises3.readdir)(evidence, { withFileTypes: true });
    taskDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const task of taskDirs) {
    const directory = import_node_path4.default.join(evidence, task, "test-integrity");
    let names;
    try {
      names = await (0, import_promises3.readdir)(directory);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.filter((file) => file.endsWith(".json"))) {
      const isClassification = name.startsWith("test-integrity-classification");
      let parsed;
      try {
        parsed = record(
          JSON.parse(
            await (0, import_promises3.readFile)(import_node_path4.default.join(directory, name), "utf8")
          ),
          "test-integrity artifact"
        );
      } catch {
        if (isClassification) malformedClassifications += 1;
        else malformedEvents += 1;
        continue;
      }
      if (isClassification) {
        if (!collectClassification(parsed, verdictEntries))
          malformedClassifications += 1;
        else classificationCount += 1;
      } else if (!collectEvent(parsed, events)) {
        malformedEvents += 1;
      }
    }
  }
  const verdictMap = /* @__PURE__ */ new Map();
  for (const entry of [...verdictEntries].sort(
    (a, b) => a.createdAt === b.createdAt ? a.artifactId.localeCompare(b.artifactId) : a.createdAt.localeCompare(b.createdAt)
  ))
    verdictMap.set(entry.key, entry.verdict);
  const signals = {};
  for (const id of TEST_INTEGRITY_SIGNAL_IDS) {
    const acc = {
      evaluated: 0,
      fired: 0,
      unreviewed: 0,
      truePositive: 0,
      falsePositive: 0,
      uncertain: 0
    };
    for (const event of events) {
      if (event.evaluatedSignals.has(id)) acc.evaluated += 1;
      if (!event.firedSignals.has(id)) continue;
      acc.fired += 1;
      const verdict = verdictMap.get(`${event.artifactId}|${id}`);
      if (verdict === "true-positive") acc.truePositive += 1;
      else if (verdict === "false-positive") acc.falsePositive += 1;
      else if (verdict === "uncertain") acc.uncertain += 1;
      else acc.unreviewed += 1;
    }
    signals[id] = {
      evaluated: acc.evaluated,
      fired: acc.fired,
      unreviewed: acc.unreviewed,
      humanClassified: {
        truePositive: acc.truePositive,
        falsePositive: acc.falsePositive,
        uncertain: acc.uncertain
      }
    };
  }
  return {
    events: events.length,
    classifications: classificationCount,
    malformedEvents,
    malformedClassifications,
    signals
  };
}
function collectEvent(parsed, events) {
  if (parsed.schemaVersion !== TEST_INTEGRITY_EVENT_SCHEMA) return false;
  const artifactId2 = parsed.artifactId;
  if (typeof artifactId2 !== "string") return false;
  if (!Array.isArray(parsed.signals) || !Array.isArray(parsed.signalsEvaluated))
    return false;
  const firedSignals = /* @__PURE__ */ new Set();
  for (const signal of parsed.signals) {
    if (signal !== null && typeof signal === "object" && typeof signal.signalId === "string")
      firedSignals.add(signal.signalId);
  }
  const evaluatedSignals = /* @__PURE__ */ new Set();
  for (const id of parsed.signalsEvaluated)
    if (typeof id === "string") evaluatedSignals.add(id);
  events.push({ firedSignals, evaluatedSignals, artifactId: artifactId2 });
  return true;
}
function collectClassification(parsed, verdictEntries) {
  if (parsed.schemaVersion !== TEST_INTEGRITY_CLASSIFICATION_SCHEMA)
    return false;
  const eventArtifactId = parsed.eventArtifactId;
  const artifactId2 = parsed.artifactId;
  const createdAt = parsed.createdAt;
  if (typeof eventArtifactId !== "string" || typeof artifactId2 !== "string" || typeof createdAt !== "string" || !Array.isArray(parsed.verdicts))
    return false;
  for (const verdict of parsed.verdicts) {
    if (verdict === null || typeof verdict !== "object") continue;
    const signalId = verdict.signalId;
    const value = verdict.verdict;
    if (typeof signalId !== "string" || typeof value !== "string") continue;
    verdictEntries.push({
      key: `${eventArtifactId}|${signalId}`,
      verdict: value,
      createdAt,
      artifactId: artifactId2
    });
  }
  return true;
}
function optionalString(value) {
  return typeof value === "string" ? value : null;
}
function optionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
async function aggregateOutcomes(root) {
  const evidence = import_node_path4.default.join(root, ".rigor", "evidence");
  const totals = {
    total: 0,
    accepted: 0,
    rejected: 0,
    acceptedWithoutModelCodeChanges: 0,
    reverted: 0,
    escapedDefectSuspected: 0,
    escapedDefectConfirmed: 0,
    malformedOutcomes: 0,
    dataCompleteness: {
      usageRecorded: 0,
      usageUnavailable: 0,
      usageUnknown: 0,
      modelIdentityPresent: 0,
      modelIdentityAbsent: 0,
      providerCostPresent: 0,
      elapsedPresent: 0,
      elapsedMissing: 0,
      attemptLinked: 0,
      attemptUnlinked: 0,
      verificationLinked: 0
    }
  };
  const candidateMap = /* @__PURE__ */ new Map();
  let taskDirs = [];
  try {
    const entries = await (0, import_promises3.readdir)(evidence, { withFileTypes: true });
    taskDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const task of taskDirs) {
    let content;
    try {
      content = await (0, import_promises3.readFile)(
        import_node_path4.default.join(evidence, task, "outcome.json"),
        "utf8"
      );
    } catch (error) {
      if (error.code === "ENOENT") continue;
      totals.malformedOutcomes += 1;
      continue;
    }
    try {
      const outcome = record(JSON.parse(content), "outcome");
      if (outcome.schemaVersion !== OUTCOME_SCHEMA)
        throw new RigorError("unexpected outcome schema", EXIT.inputError);
      applyOutcome(totals, candidateMap, outcome);
    } catch {
      totals.malformedOutcomes += 1;
    }
  }
  const candidates = [...candidateMap.values()].sort((a, b) => a.candidate.localeCompare(b.candidate)).map((entry) => ({
    candidate: entry.candidate,
    provider: entry.provider,
    model: entry.model,
    capabilityClass: entry.capabilityClass,
    outcomes: entry.outcomes,
    accepted: entry.accepted,
    successRate: { numerator: entry.accepted, denominator: entry.outcomes },
    retries: {
      total: entry.retriesTotal,
      perOutcome: entry.outcomes > 0 ? entry.retriesTotal / entry.outcomes : null
    },
    elapsedMs: {
      total: entry.elapsedTotal,
      average: entry.elapsedPresent > 0 ? entry.elapsedTotal / entry.elapsedPresent : null,
      present: entry.elapsedPresent,
      missing: entry.elapsedMissing
    },
    humanInterventionMinutes: {
      total: entry.humanTotal,
      outcomesWithIntervention: entry.humanOutcomes
    },
    dataCompleteness: {
      usageRecorded: entry.usageRecorded,
      usageUnavailable: entry.usageUnavailable,
      usageUnknown: entry.usageUnknown,
      modelIdentityPresent: entry.modelIdentityPresent
    }
  }));
  return { outcomeTotals: totals, candidates };
}
function applyOutcome(totals, candidateMap, outcome) {
  const completeness = totals.dataCompleteness;
  totals.total += 1;
  const decision2 = outcome.decision;
  if (decision2 === "accepted") totals.accepted += 1;
  else if (decision2 === "rejected") totals.rejected += 1;
  if (outcome.acceptedWithoutModelCodeChanges === true)
    totals.acceptedWithoutModelCodeChanges += 1;
  if (outcome.revertStatus === "reverted") totals.reverted += 1;
  if (outcome.escapedDefectStatus === "suspected")
    totals.escapedDefectSuspected += 1;
  if (outcome.escapedDefectStatus === "confirmed")
    totals.escapedDefectConfirmed += 1;
  const usage = typeof outcome.usage === "object" && outcome.usage !== null ? outcome.usage : {};
  const usageStatus = usage.status;
  if (usageStatus === "recorded") completeness.usageRecorded += 1;
  else if (usageStatus === "unavailable") completeness.usageUnavailable += 1;
  else if (usageStatus === "unknown") completeness.usageUnknown += 1;
  const modelIdentityPresent = usage.modelIdentity !== null && usage.modelIdentity !== void 0;
  if (modelIdentityPresent) completeness.modelIdentityPresent += 1;
  else completeness.modelIdentityAbsent += 1;
  if (usage.providerCost !== null && usage.providerCost !== void 0)
    completeness.providerCostPresent += 1;
  const elapsed = optionalNumber(outcome.attemptDurationMs);
  if (elapsed !== void 0) completeness.elapsedPresent += 1;
  else completeness.elapsedMissing += 1;
  const attemptLinked = typeof outcome.attemptArtifactId === "string";
  if (attemptLinked) completeness.attemptLinked += 1;
  else completeness.attemptUnlinked += 1;
  if (typeof outcome.verificationArtifactId === "string")
    completeness.verificationLinked += 1;
  let candidate = "unlinked";
  let provider = null;
  let model = null;
  let capabilityClass = null;
  if (attemptLinked) {
    provider = optionalString(outcome.provider);
    model = optionalString(outcome.model);
    capabilityClass = optionalString(outcome.capabilityClass);
    candidate = model ?? `${provider}/${capabilityClass}`;
  }
  let entry = candidateMap.get(candidate);
  if (!entry) {
    entry = {
      candidate,
      provider,
      model,
      capabilityClass,
      outcomes: 0,
      accepted: 0,
      retriesTotal: 0,
      elapsedTotal: 0,
      elapsedPresent: 0,
      elapsedMissing: 0,
      humanTotal: 0,
      humanOutcomes: 0,
      usageRecorded: 0,
      usageUnavailable: 0,
      usageUnknown: 0,
      modelIdentityPresent: 0
    };
    candidateMap.set(candidate, entry);
  }
  entry.outcomes += 1;
  if (decision2 === "accepted") entry.accepted += 1;
  entry.retriesTotal += optionalNumber(outcome.retryCount) ?? 0;
  if (elapsed !== void 0) {
    entry.elapsedTotal += elapsed;
    entry.elapsedPresent += 1;
  } else {
    entry.elapsedMissing += 1;
  }
  const human = optionalNumber(outcome.humanCorrectionMinutes) ?? 0;
  entry.humanTotal += human;
  if (human > 0) entry.humanOutcomes += 1;
  if (usageStatus === "recorded") entry.usageRecorded += 1;
  else if (usageStatus === "unavailable") entry.usageUnavailable += 1;
  else if (usageStatus === "unknown") entry.usageUnknown += 1;
  if (modelIdentityPresent) entry.modelIdentityPresent += 1;
}
async function loadPolicy(root) {
  return parsePolicy(await readJson(import_node_path4.default.join(root, ".rigor", "policy.json")));
}

// src/ci.ts
var import_promises5 = require("node:fs/promises");
var import_node_path6 = __toESM(require("node:path"), 1);

// src/setup.ts
var import_promises4 = require("node:fs/promises");
var import_node_path5 = __toESM(require("node:path"), 1);
function defaultPolicy(repositoryId) {
  return {
    schemaVersion: POLICY_SCHEMA,
    repositoryId,
    defaultTier: "medium",
    defaultExternalTransmission: "allow",
    rules: [
      {
        id: "governance",
        paths: [".rigor/**", ".github/workflows/**", "CODEOWNERS"],
        tier: "critical",
        reason: "Governance and enforcement changes can weaken controls.",
        protected: true,
        requireHumanApproval: true
      },
      {
        id: "secrets",
        paths: ["**/.env*", "**/secrets/**", "**/*.pem", "**/*.key"],
        tier: "critical",
        reason: "The path may contain credentials or confidential material.",
        protected: true,
        denyExternalTransmission: true,
        requireHumanApproval: true
      },
      {
        id: "security-and-irreversible",
        paths: [
          "**/auth/**",
          "**/permissions/**",
          "**/migrations/**",
          "**/billing/**",
          "infra/**"
        ],
        tier: "critical",
        reason: "Authentication, authorization, billing, migration, or infrastructure changes can be irreversible or broadly impactful.",
        protected: true,
        requireHumanApproval: true
      },
      {
        id: "runtime-code",
        paths: ["src/**", "lib/**", "app/**", "packages/**"],
        tier: "high",
        reason: "Runtime code affects shipped behavior.",
        requireHumanApproval: true
      },
      {
        id: "tests-and-docs",
        paths: ["test/**", "tests/**", "docs/**", "**/*.md"],
        tier: "low",
        reason: "Tests and documentation normally have limited direct runtime impact."
      }
    ],
    checks: [
      {
        id: "git-diff-check",
        command: "git",
        args: ["diff", "--check"],
        tiers: ["low", "medium", "high", "critical"],
        timeoutMs: 3e4
      }
    ],
    stopConditions: {
      low: ["scope expands beyond the contract"],
      medium: [
        "scope expands beyond the contract",
        "a required check fails twice without a new hypothesis"
      ],
      high: [
        "scope expands beyond the contract",
        "a protected path is discovered",
        "a required check fails twice without a new hypothesis"
      ],
      critical: [
        "scope expands beyond the contract",
        "an irreversible or external write is needed",
        "credentials or personal data are encountered",
        "independent human approval is unavailable"
      ]
    },
    ci: { requireEvidence: true, maxPolicyWeakening: "none" }
  };
}
var workflow = `name: Rigor

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

jobs:
  rigor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: Independently verify Rigor evidence and policy
        env:
          RIGOR_BASE_SHA: \${{ github.event.pull_request.base.sha }}
          RIGOR_HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: node .rigor/rigor-ci.cjs ci --base "$RIGOR_BASE_SHA" --head "$RIGOR_HEAD_SHA"
`;
async function setup(root, bundlePath) {
  const candidates = [
    { relative: ".rigor/.gitignore", content: "events.jsonl\n" },
    {
      relative: ".rigor/policy.json",
      content: `${JSON.stringify(defaultPolicy(import_node_path5.default.basename(root)), null, 2)}
`
    },
    {
      relative: ".rigor/intent.example.json",
      content: `${JSON.stringify({ schemaVersion: INTENT_SCHEMA, taskId: "TASK-123", summary: "Describe the intended change", plannedPaths: ["src/example.ts"], operations: ["edit"] }, null, 2)}
`
    },
    { relative: ".github/workflows/rigor.yml", content: workflow },
    { relative: ".rigor/rigor-ci.cjs", copyFrom: bundlePath, mode: 493 }
  ];
  const created = [];
  const unchanged = [];
  const conflicts = [];
  const pending = [];
  for (const candidate of candidates) {
    const target = import_node_path5.default.join(root, candidate.relative);
    await assertContainedPath(root, target);
    let existing = null;
    try {
      const stat = await (0, import_promises4.lstat)(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        conflicts.push(candidate.relative);
        continue;
      }
      existing = await (0, import_promises4.readFile)(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const desired = candidate.copyFrom ? await (0, import_promises4.readFile)(candidate.copyFrom) : Buffer.from(candidate.content ?? "");
    if (existing !== null) {
      if (existing.equals(desired)) unchanged.push(candidate.relative);
      else conflicts.push(candidate.relative);
      continue;
    }
    pending.push({ candidate, target, desired });
  }
  if (conflicts.length > 0)
    throw new RigorError(
      `Setup conflict; no files were changed and no existing file was overwritten: ${conflicts.join(", ")}`,
      EXIT.policyViolation
    );
  for (const { candidate, target, desired } of pending) {
    await (0, import_promises4.mkdir)(import_node_path5.default.dirname(target), { recursive: true });
    await (0, import_promises4.writeFile)(target, desired, { flag: "wx" });
    if (candidate.mode) await (0, import_promises4.chmod)(target, candidate.mode);
    created.push(candidate.relative);
  }
  return { created, unchanged };
}
function policyWeakening(base, head) {
  const failures2 = [];
  if (base.defaultExternalTransmission === "deny" && head.defaultExternalTransmission === "allow")
    failures2.push("default external-transmission policy was weakened");
  const headRules = new Map(head.rules.map((rule) => [rule.id, stable(rule)]));
  for (const rule of base.rules)
    if (headRules.get(rule.id) !== stable(rule))
      failures2.push(`base rule changed or removed: ${rule.id}`);
  const headChecks = new Map(
    head.checks.map((check) => [check.id, stable(check)])
  );
  for (const check of base.checks)
    if (headChecks.get(check.id) !== stable(check))
      failures2.push(`base check changed or removed: ${check.id}`);
  return failures2;
}

// src/ci.ts
async function evidenceFiles(root) {
  const base = import_node_path6.default.join(root, ".rigor", "evidence");
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await (0, import_promises5.readdir)(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = import_node_path6.default.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) found.push(full);
    }
  }
  await walk(base);
  return found;
}
async function ciVerify(root, baseSha, headSha) {
  const failures2 = [];
  const baseText = await showFile(root, baseSha, ".rigor/policy.json");
  const headText = await showFile(root, headSha, ".rigor/policy.json");
  if (!headText)
    return {
      status: "failed",
      failures: ["head is missing .rigor/policy.json"],
      changedPaths: []
    };
  let headPolicy;
  try {
    headPolicy = parsePolicy(JSON.parse(headText));
  } catch {
    return {
      status: "failed",
      failures: ["head policy is invalid"],
      changedPaths: []
    };
  }
  if (baseText) {
    try {
      failures2.push(
        ...policyWeakening(
          parsePolicy(JSON.parse(baseText)),
          headPolicy
        )
      );
    } catch {
      failures2.push("base policy is invalid; repair it independently");
    }
  }
  const changedPaths = await diffPaths(root, baseSha, headSha);
  const codePaths = changedPaths.filter(
    (item) => !item.startsWith(".rigor/evidence/")
  );
  const deletion = await run(
    "git",
    ["diff", "--name-only", "--diff-filter=D", "-z", baseSha, headSha],
    root
  );
  for (const removed of deletion.stdout.toString("utf8").split("\0").filter(Boolean)) {
    if (matches(removed, ["test/**", "tests/**", "**/*.test.*", "**/*.spec.*"]))
      failures2.push(`existing test was deleted: ${removed}`);
  }
  const protectedChanges = codePaths.filter(
    (item) => headPolicy.rules.some(
      (rule) => rule.protected && matches(item, rule.paths)
    )
  );
  const files = await evidenceFiles(root);
  const contracts = /* @__PURE__ */ new Map();
  const verifications = [];
  const reviews = [];
  for (const file of files) {
    try {
      const value = await readJson(file);
      const item = record(value, "evidence");
      if (item.schemaVersion === "rigor.contract.v1") {
        const contract = parseContract(item);
        contracts.set(contract.artifactId, contract);
      } else if (item.schemaVersion === "rigor.verification.v1")
        verifications.push(item);
      else if (item.schemaVersion === "rigor.review.v1") reviews.push(item);
    } catch {
      failures2.push(`invalid evidence file: ${import_node_path6.default.relative(root, file)}`);
    }
  }
  let linked = false;
  for (const review of reviews) {
    const verification = verifications.find(
      (item) => item.artifactId === review.verificationArtifactId
    );
    const contract = [...contracts.values()].find(
      (item) => item.artifactId === review.contractArtifactId
    );
    if (!verification || !contract || verification.contractArtifactId !== contract.artifactId || review.taskId !== contract.taskId)
      continue;
    const claimedPaths = Array.isArray(verification.changedPaths) ? verification.changedPaths.filter(
      (item) => typeof item === "string"
    ) : [];
    if (!codePaths.every((item) => claimedPaths.includes(item))) continue;
    if (verification.policyHash !== hash(headPolicy) || verification.status !== "passed")
      continue;
    if (protectedChanges.length > 0 && review.riskTier !== "critical") continue;
    linked = true;
  }
  if (headPolicy.ci.requireEvidence && codePaths.length > 0 && !linked)
    failures2.push(
      "no linked passing evidence covers the independently derived change set and head policy"
    );
  for (const check of headPolicy.checks) {
    let result;
    try {
      result = await run(check.command, check.args, root, check.timeoutMs);
    } catch {
      failures2.push(`check could not start: ${check.id}`);
      continue;
    }
    if (result.timedOut || result.code !== 0)
      failures2.push(`independent check failed: ${check.id}`);
  }
  return {
    status: failures2.length === 0 ? "passed" : "failed",
    failures: failures2,
    changedPaths
  };
}

// src/governance.ts
var GOVERNANCE_SCHEMA = "rigor.governance.v1";
function parseRepository(value) {
  const text = textField(value, "--repo", 200);
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})$/u.exec(
    text
  );
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo || repo === "." || repo === "..") {
    throw new RigorError(
      "--repo must be an owner/name repository reference",
      EXIT.inputError
    );
  }
  return { owner, repo };
}
function parseBranch(value) {
  const text = textField(value, "--branch", 255);
  if (/[\u0000-\u001f\u007f ~^:?*[\\]/u.test(text) || text.includes("..")) {
    throw new RigorError(
      "--branch contains unsupported characters",
      EXIT.inputError
    );
  }
  return text;
}
function githubReader(token, fetchImpl = fetch) {
  if (token !== void 0 && !/^[!-~]{1,512}$/u.test(token)) {
    throw new RigorError(
      "GitHub token contains unsupported characters",
      EXIT.inputError
    );
  }
  return async (requestPath) => {
    const headers = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "rigor-governance"
    };
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const response = await fetchImpl(`https://api.github.com${requestPath}`, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      const link = response.headers.get("link");
      if (link && /rel="next"/u.test(link)) return { status: 0, body: null };
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) return { status: 0, body: null };
      if (text.length === 0) {
        if (response.status !== 200)
          return { status: response.status, body: null };
        return { status: 0, body: null };
      }
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: 0, body: null };
    }
  };
}
var TIMEOUT_MS = 1e4;
var MAX_RESPONSE_BYTES = 1e6;
function splitCodeownersLine(line) {
  const tokens = [];
  let current = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\\" && i + 1 < line.length) {
      current += line[i + 1];
      i += 1;
    } else if (char === "#") {
      break;
    } else if (char === " " || char === "	") {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}
function parseCodeowners(text) {
  const entries = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const tokens = splitCodeownersLine(rawLine);
    const pattern = tokens[0];
    if (!pattern) continue;
    if (pattern.startsWith("!")) continue;
    entries.push({ pattern, owners: tokens.slice(1) });
  }
  return entries;
}
function escapeRegex2(character) {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}
function codeownersPatternToRegExp(pattern) {
  let body = pattern;
  let directoryOnly = false;
  if (body.endsWith("/")) {
    directoryOnly = true;
    body = body.slice(0, -1);
  }
  let anchored = false;
  if (body.startsWith("/")) {
    anchored = true;
    body = body.slice(1);
  } else if (body.includes("/")) {
    anchored = true;
  }
  let source = anchored ? "^" : "^(?:.*/)?";
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "*") {
      if (body[i + 1] === "*") {
        i += 1;
        if (body[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += escapeRegex2(char);
  }
  const last = body[body.length - 1];
  if (directoryOnly) source += "/.*";
  else if (last !== "*" && last !== "?") source += "(?:/.*)?";
  return new RegExp(`${source}$`, "u");
}
function codeownersOwners(entries, pathname) {
  let owners = [];
  for (const entry of entries) {
    if (codeownersPatternToRegExp(entry.pattern).test(pathname)) {
      owners = entry.owners;
    }
  }
  return owners;
}
function representativePaths(policy) {
  const paths = /* @__PURE__ */ new Set();
  for (const rule of policy.rules) {
    if (!rule.protected) continue;
    for (const glob of rule.paths) {
      paths.add(
        glob.split("/").map(
          (segment) => segment === "**" ? "governed" : segment.replaceAll("**", "governed").replaceAll("*", "governed").replaceAll("?", "x")
        ).join("/")
      );
    }
  }
  return [...paths].sort();
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function rulesetFacts(body) {
  const facts = {
    pullRequestRule: false,
    approvals: 0,
    dismissStale: false,
    codeOwnerReview: false,
    lastPushApproval: false,
    contexts: [],
    forcePushBlocked: false,
    deletionBlocked: false
  };
  if (!Array.isArray(body)) return facts;
  for (const item of body) {
    if (!isRecord(item)) continue;
    const parameters = isRecord(item.parameters) ? item.parameters : {};
    if (item.type === "pull_request") {
      facts.pullRequestRule = true;
      const count = parameters.required_approving_review_count;
      if (typeof count === "number" && count > facts.approvals)
        facts.approvals = count;
      if (parameters.dismiss_stale_reviews_on_push === true)
        facts.dismissStale = true;
      if (parameters.require_code_owner_review === true)
        facts.codeOwnerReview = true;
      if (parameters.require_last_push_approval === true)
        facts.lastPushApproval = true;
    } else if (item.type === "required_status_checks") {
      const checks = parameters.required_status_checks;
      if (Array.isArray(checks)) {
        for (const check of checks) {
          if (isRecord(check) && typeof check.context === "string")
            facts.contexts.push(check.context);
        }
      }
    } else if (item.type === "non_fast_forward") facts.forcePushBlocked = true;
    else if (item.type === "deletion") facts.deletionBlocked = true;
  }
  return facts;
}
function classicFacts(body) {
  const facts = {
    pullRequestRule: false,
    approvals: 0,
    dismissStale: false,
    codeOwnerReview: false,
    lastPushApproval: false,
    contexts: [],
    forcePushBlocked: false,
    deletionBlocked: false
  };
  if (!isRecord(body)) return facts;
  const reviews = body.required_pull_request_reviews;
  if (isRecord(reviews)) {
    facts.pullRequestRule = true;
    const count = reviews.required_approving_review_count;
    if (typeof count === "number") facts.approvals = count;
    if (reviews.dismiss_stale_reviews === true) facts.dismissStale = true;
    if (reviews.require_code_owner_reviews === true)
      facts.codeOwnerReview = true;
    if (reviews.require_last_push_approval === true)
      facts.lastPushApproval = true;
  }
  const checks = body.required_status_checks;
  if (isRecord(checks)) {
    if (Array.isArray(checks.contexts)) {
      for (const context of checks.contexts) {
        if (typeof context === "string") facts.contexts.push(context);
      }
    }
    if (Array.isArray(checks.checks)) {
      for (const check of checks.checks) {
        if (isRecord(check) && typeof check.context === "string")
          facts.contexts.push(check.context);
      }
    }
  }
  const forcePushes = body.allow_force_pushes;
  if (isRecord(forcePushes) && forcePushes.enabled === false)
    facts.forcePushBlocked = true;
  const deletions = body.allow_deletions;
  if (isRecord(deletions) && deletions.enabled === false)
    facts.deletionBlocked = true;
  return facts;
}
function evaluateGovernance(input) {
  const findings2 = [];
  const rulesKnown = input.rules.status === 200;
  const classicKnown = input.protection.status === 200 || input.protection.status === 404;
  const ruleset = rulesetFacts(rulesKnown ? input.rules.body : null);
  const classic = classicFacts(
    input.protection.status === 200 ? input.protection.body : null
  );
  const branchRequirement = (id, fromRuleset, fromClassic, requirement) => {
    if (rulesKnown && fromRuleset || classicKnown && fromClassic) {
      findings2.push({ id, status: "satisfied", detail: requirement });
    } else if (!rulesKnown && !classicKnown) {
      findings2.push({
        id,
        status: "unverifiable",
        detail: `${requirement}: branch rules and classic protection could not be fully read with the available credentials`
      });
    } else if (!classicKnown) {
      findings2.push({
        id,
        status: "unverifiable",
        detail: `${requirement}: not satisfied by rulesets, and classic protection could not be fully read with the available credentials`
      });
    } else {
      findings2.push({
        id,
        status: "failed",
        detail: `${requirement}: not required by any active ruleset or classic protection on ${input.branch}`
      });
    }
  };
  branchRequirement(
    "pull-request-required",
    ruleset.pullRequestRule,
    classic.pullRequestRule,
    "pull requests are required before merging"
  );
  branchRequirement(
    "approval-count",
    ruleset.approvals >= 1,
    classic.approvals >= 1,
    "at least one approving review is required"
  );
  branchRequirement(
    "stale-review-dismissal",
    ruleset.dismissStale,
    classic.dismissStale,
    "stale approvals are dismissed on new commits"
  );
  branchRequirement(
    "code-owner-review",
    ruleset.codeOwnerReview,
    classic.codeOwnerReview,
    "review from code owners is required"
  );
  branchRequirement(
    "last-push-approval",
    ruleset.lastPushApproval,
    classic.lastPushApproval,
    "approval from someone other than the last pusher is required"
  );
  branchRequirement(
    "required-check",
    ruleset.contexts.includes(input.requiredCheckContext),
    classic.contexts.includes(input.requiredCheckContext),
    `the status check "${input.requiredCheckContext}" is required`
  );
  branchRequirement(
    "force-push-blocked",
    ruleset.forcePushBlocked,
    classic.forcePushBlocked,
    "force pushes are blocked"
  );
  branchRequirement(
    "deletion-blocked",
    ruleset.deletionBlocked,
    classic.deletionBlocked,
    "branch deletion is blocked"
  );
  if (input.codeowners.state === "unverifiable") {
    findings2.push({
      id: "codeowners-sampled-coverage",
      status: "unverifiable",
      detail: "CODEOWNERS could not be fully read with the available credentials"
    });
  } else if (input.codeowners.state === "missing") {
    findings2.push({
      id: "codeowners-sampled-coverage",
      status: "failed",
      detail: "no CODEOWNERS file exists at .github/CODEOWNERS, CODEOWNERS, or docs/CODEOWNERS"
    });
  } else {
    const entries = parseCodeowners(input.codeowners.text);
    const uncovered = input.sampledPaths.filter(
      (pathname) => codeownersOwners(entries, pathname).length === 0
    );
    findings2.push(
      uncovered.length === 0 ? {
        id: "codeowners-sampled-coverage",
        status: "satisfied",
        detail: `${input.codeowners.source} assigns owners to every sampled representative of the policy-protected globs; this sampled check is an early warning and does not prove full coverage of each glob`
      } : {
        id: "codeowners-sampled-coverage",
        status: "failed",
        detail: `${input.codeowners.source} leaves sampled policy-protected paths without owners: ${uncovered.join(", ")}`
      }
    );
  }
  if (input.environments.status === 200 && isRecord(input.environments.body)) {
    const list = Array.isArray(input.environments.body.environments) ? input.environments.body.environments : [];
    const unprotected = [];
    for (const environment of list) {
      if (!isRecord(environment)) continue;
      const name = typeof environment.name === "string" ? environment.name : "unnamed";
      const rules = environment.protection_rules;
      if (!Array.isArray(rules) || rules.length === 0) unprotected.push(name);
    }
    if (list.length === 0) {
      findings2.push({
        id: "deployment-environments",
        status: "satisfied",
        detail: "no deployment environments are configured"
      });
    } else if (unprotected.length === 0) {
      findings2.push({
        id: "deployment-environments",
        status: "satisfied",
        detail: `all ${String(list.length)} deployment environments have protection rules`
      });
    } else {
      findings2.push({
        id: "deployment-environments",
        status: "failed",
        detail: `deployment environments without protection rules: ${unprotected.join(", ")}`
      });
    }
  } else {
    findings2.push({
      id: "deployment-environments",
      status: "unverifiable",
      detail: "deployment environments could not be fully read with the available credentials"
    });
  }
  return {
    schemaVersion: GOVERNANCE_SCHEMA,
    repository: input.repository,
    branch: input.branch,
    requiredCheckContext: input.requiredCheckContext,
    sampledPaths: input.sampledPaths,
    findings: findings2,
    status: findings2.every((finding) => finding.status === "satisfied") ? "passed" : "failed"
  };
}
var CODEOWNERS_LOCATIONS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS"
];
async function readCodeowners(read, base) {
  let unverifiable = false;
  for (const location of CODEOWNERS_LOCATIONS) {
    const response = await read(
      `${base}/contents/${location.split("/").map(encodeURIComponent).join("/")}`
    );
    if (response.status === 200 && isRecord(response.body)) {
      const content = response.body.content;
      if (typeof content === "string") {
        try {
          return {
            state: "found",
            source: location,
            text: Buffer.from(content, "base64").toString("utf8")
          };
        } catch {
          unverifiable = true;
        }
      }
    } else if (response.status !== 404) unverifiable = true;
  }
  return {
    state: unverifiable ? "unverifiable" : "missing",
    source: "",
    text: ""
  };
}
async function governanceVerify(policy, options2, read) {
  const base = `/repos/${encodeURIComponent(options2.owner)}/${encodeURIComponent(options2.repo)}`;
  const branch = encodeURIComponent(options2.branch);
  const rules = await read(`${base}/rules/branches/${branch}?per_page=100`);
  const protection = await read(`${base}/branches/${branch}/protection`);
  const codeowners = await readCodeowners(read, base);
  const environments = await read(`${base}/environments?per_page=100`);
  return evaluateGovernance({
    repository: `${options2.owner}/${options2.repo}`,
    branch: options2.branch,
    requiredCheckContext: options2.requiredCheckContext,
    sampledPaths: representativePaths(policy),
    rules,
    protection,
    codeowners,
    environments
  });
}

// src/hook.ts
var import_node_path7 = __toESM(require("node:path"), 1);
var import_promises6 = require("node:fs/promises");
async function userPromptHook(input, cwd = process.cwd()) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return {
      decision: "block",
      reason: "Rigor received invalid hook input. Inspect the plugin configuration."
    };
  let root;
  try {
    root = await findGitRoot(cwd);
  } catch {
    return null;
  }
  try {
    await (0, import_promises6.access)(import_node_path7.default.join(root, ".rigor"));
  } catch {
    return null;
  }
  try {
    await loadPolicy(root);
  } catch {
    return {
      decision: "block",
      reason: "Rigor is configured but .rigor/policy.json is missing or invalid. Repair policy or run rigor preflight manually."
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "Rigor is configured. Before editing, use /rigor:preflight and keep the task contract and stop conditions current."
    }
  };
}

// src/policy.ts
var rank = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
};
function evaluate(policy, intent, git2, now = /* @__PURE__ */ new Date()) {
  const plannedPaths = [
    ...new Set(intent.plannedPaths.map(normalizeRepoPath))
  ].sort();
  let riskTier = "low";
  let matchedRule = false;
  let denied = policy.defaultExternalTransmission === "deny";
  let requireHumanApproval = false;
  const protectedPaths = /* @__PURE__ */ new Set();
  const reasons = [];
  for (const pathname of plannedPaths) {
    for (const rule of policy.rules) {
      if (!matches(pathname, rule.paths)) continue;
      matchedRule = true;
      if (rank[rule.tier] > rank[riskTier]) riskTier = rule.tier;
      if (rule.denyExternalTransmission) denied = true;
      if (rule.requireHumanApproval) requireHumanApproval = true;
      if (rule.protected) protectedPaths.add(pathname);
      reasons.push({ ruleId: rule.id, path: pathname, reason: rule.reason });
    }
  }
  if (!matchedRule) riskTier = policy.defaultTier;
  if (plannedPaths.length === 0)
    reasons.push({
      ruleId: "no-paths",
      reason: "No planned path was supplied; review scope before editing."
    });
  if (git2.dirty)
    reasons.push({
      ruleId: "dirty-worktree",
      reason: "The worktree already contains changes that can affect evidence."
    });
  if (rank[riskTier] >= rank.high) requireHumanApproval = true;
  return {
    schemaVersion: PREFLIGHT_SCHEMA,
    artifactId: artifactId("preflight"),
    taskId: intent.taskId,
    createdAt: now.toISOString(),
    policyHash: hash(policy),
    intentHash: hash(intent),
    git: git2,
    plannedPaths,
    riskTier,
    externalTransmission: denied ? "denied" : "allowed",
    protectedPaths: [...protectedPaths].sort(),
    requireHumanApproval,
    stopConditions: policy.stopConditions[riskTier],
    reasons
  };
}

// src/release.ts
var import_promises7 = require("node:fs/promises");
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path8 = __toESM(require("node:path"), 1);
var RELEASE_SCHEMA = "rigor.release.v1";
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function evaluateRelease(facts) {
  const findings2 = [];
  findings2.push(
    facts.dirty ? {
      id: "clean-tree",
      status: "failed",
      detail: "the worktree has uncommitted changes; a release must be cut from a clean tree"
    } : {
      id: "clean-tree",
      status: "satisfied",
      detail: "the worktree is clean"
    }
  );
  if (facts.packageVersion === facts.version && facts.manifestVersion === facts.version) {
    findings2.push({
      id: "version-sync",
      status: "satisfied",
      detail: `package.json and .claude-plugin/plugin.json both declare ${facts.version}`
    });
  } else {
    findings2.push({
      id: "version-sync",
      status: "failed",
      detail: `version mismatch: package.json=${facts.packageVersion || "(unreadable)"}, .claude-plugin/plugin.json=${facts.manifestVersion || "(unreadable)"}, requested=${facts.version}`
    });
  }
  findings2.push(
    facts.changelogVersions.includes(facts.version) ? {
      id: "changelog-entry",
      status: "satisfied",
      detail: `CHANGELOG.md has a section for ${facts.version}`
    } : {
      id: "changelog-entry",
      status: "failed",
      detail: `CHANGELOG.md has no section for ${facts.version}`
    }
  );
  findings2.push(
    facts.bundleMatches ? {
      id: "bundle-built",
      status: "satisfied",
      detail: "dist/rigor.cjs matches a fresh build"
    } : {
      id: "bundle-built",
      status: "failed",
      detail: "committed dist/rigor.cjs differs from a fresh build; rebuild and commit it"
    }
  );
  if (facts.ciBundleMatches === null) {
    findings2.push({
      id: "ci-bundle-sync",
      status: "satisfied",
      detail: "no committed dist/rigor.cjs and .rigor/rigor-ci.cjs pair in this repository; the dogfooding CI-verifier sync invariant does not apply"
    });
  } else if (facts.ciBundleMatches) {
    findings2.push({
      id: "ci-bundle-sync",
      status: "satisfied",
      detail: ".rigor/rigor-ci.cjs is byte-identical to the committed dist/rigor.cjs"
    });
  } else {
    findings2.push({
      id: "ci-bundle-sync",
      status: "failed",
      detail: "committed .rigor/rigor-ci.cjs differs from dist/rigor.cjs; regenerate it with /bin/cp -f dist/rigor.cjs .rigor/rigor-ci.cjs"
    });
  }
  findings2.push(
    facts.branch === facts.expectedBranch ? {
      id: "expected-branch",
      status: "satisfied",
      detail: `HEAD is on the expected branch ${facts.expectedBranch}`
    } : {
      id: "expected-branch",
      status: "failed",
      detail: `HEAD is on ${facts.branch || "(unknown)"}, not the expected branch ${facts.expectedBranch}`
    }
  );
  if (facts.expectedSha === null) {
    findings2.push({
      id: "expected-commit",
      status: "satisfied",
      detail: `HEAD is ${facts.head ?? "(none)"}; no expected SHA was pinned`
    });
  } else if (facts.head === facts.expectedSha) {
    findings2.push({
      id: "expected-commit",
      status: "satisfied",
      detail: `HEAD is the expected commit ${facts.expectedSha}`
    });
  } else {
    findings2.push({
      id: "expected-commit",
      status: "failed",
      detail: `HEAD is ${facts.head ?? "(none)"}, not the expected commit ${facts.expectedSha}`
    });
  }
  if (facts.ci.state === "success") {
    findings2.push({
      id: "ci-success",
      status: "satisfied",
      detail: facts.ci.detail
    });
  } else if (facts.ci.state === "failed") {
    findings2.push({
      id: "ci-success",
      status: "failed",
      detail: facts.ci.detail
    });
  } else if (facts.ci.state === "unverifiable") {
    findings2.push({
      id: "ci-success",
      status: "unverifiable",
      detail: facts.ci.detail
    });
  } else {
    findings2.push({
      id: "ci-success",
      status: "unverifiable",
      detail: "GitHub CI was not checked; pass --repo to verify the required check(s) for the exact SHA"
    });
  }
  return {
    schemaVersion: RELEASE_SCHEMA,
    version: facts.version,
    branch: facts.branch,
    head: facts.head,
    requiredChecks: facts.requiredChecks,
    findings: findings2,
    status: findings2.every((finding) => finding.status === "satisfied") ? "passed" : "failed"
  };
}
async function releaseCiFact(read, ref, sha, requiredChecks) {
  if (!/^[0-9a-fA-F]{7,64}$/u.test(sha))
    return { state: "unverifiable", detail: "invalid commit identifier" };
  if (requiredChecks.length === 0)
    return {
      state: "unverifiable",
      detail: "no required checks were specified to verify"
    };
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const response = await read(
    `${base}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`
  );
  if (response.status !== 200 || !isRecord2(response.body) || !Array.isArray(response.body.check_runs))
    return {
      state: "unverifiable",
      detail: `check runs for ${sha} could not be read with the available credentials`
    };
  const runs = response.body.check_runs;
  const satisfied = [];
  const missing = [];
  for (const check of requiredChecks) {
    const ok = runs.some(
      (item) => isRecord2(item) && item.name === check && item.status === "completed" && item.conclusion === "success"
    );
    if (ok) satisfied.push(check);
    else missing.push(check);
  }
  if (missing.length === 0)
    return {
      state: "success",
      detail: `all required checks succeeded for ${sha}: ${satisfied.join(", ")}`
    };
  return {
    state: "failed",
    detail: `required checks not successful for ${sha}: ${missing.join(", ")}`
  };
}
async function readJsonVersion(file) {
  try {
    const parsed = JSON.parse(await (0, import_promises7.readFile)(file, "utf8"));
    if (isRecord2(parsed) && typeof parsed.version === "string")
      return parsed.version;
  } catch {
  }
  return "";
}
async function readChangelogVersions(root) {
  try {
    const text = await (0, import_promises7.readFile)(import_node_path8.default.join(root, "CHANGELOG.md"), "utf8");
    const versions = [];
    for (const match of text.matchAll(/^##\s+(\d+\.\d+\.\d+)\b/gmu))
      if (match[1]) versions.push(match[1]);
    return versions;
  } catch {
    return [];
  }
}
async function bundleMatchesFreshBuild(root) {
  const temp = import_node_path8.default.join(
    import_node_os.default.tmpdir(),
    `rigor-release-bundle-${String(process.pid)}.cjs`
  );
  try {
    const result = await run(
      "npm",
      ["run", "build", "--", `--outfile=${temp}`],
      root,
      12e4
    );
    if (result.code !== 0) return false;
    const [fresh, committed] = await Promise.all([
      (0, import_promises7.readFile)(temp),
      (0, import_promises7.readFile)(import_node_path8.default.join(root, "dist", "rigor.cjs"))
    ]);
    return fresh.equals(committed);
  } catch {
    return false;
  } finally {
    await (0, import_promises7.rm)(temp, { force: true }).catch(() => void 0);
  }
}
async function ciBundleFact(root) {
  try {
    const [dist, ci] = await Promise.all([
      (0, import_promises7.readFile)(import_node_path8.default.join(root, "dist", "rigor.cjs")),
      (0, import_promises7.readFile)(import_node_path8.default.join(root, ".rigor", "rigor-ci.cjs"))
    ]);
    return dist.equals(ci);
  } catch {
    return null;
  }
}
async function releaseVerify(root, options2, read) {
  const packageVersion = await readJsonVersion(import_node_path8.default.join(root, "package.json"));
  const manifestVersion = await readJsonVersion(
    import_node_path8.default.join(root, ".claude-plugin", "plugin.json")
  );
  const facts = await gitFacts(root);
  const branchResult = await run(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    root
  );
  const branch = branchResult.stdout.toString("utf8").trim();
  const changelogVersions = await readChangelogVersions(root);
  const bundleMatches = await bundleMatchesFreshBuild(root);
  const ciBundleMatches = await ciBundleFact(root);
  let ci;
  if (options2.repo && read) {
    ci = facts.head === null ? {
      state: "unverifiable",
      detail: "there is no HEAD commit to check remote CI for"
    } : await releaseCiFact(
      read,
      options2.repo,
      facts.head,
      options2.requiredChecks
    );
  } else {
    ci = {
      state: "not-requested",
      detail: "the remote GitHub CI check was not requested (no --repo)"
    };
  }
  return evaluateRelease({
    version: options2.version,
    packageVersion,
    manifestVersion,
    branch,
    expectedBranch: options2.expectedBranch,
    head: facts.head,
    expectedSha: options2.expectedSha,
    dirty: facts.dirty,
    changelogVersions,
    bundleMatches,
    ciBundleMatches,
    requiredChecks: options2.requiredChecks,
    ci
  });
}

// src/routing.ts
var signalLevels = ["low", "medium", "high", "critical"];
var verificationStrengths = [
  "weak",
  "moderate",
  "strong"
];
var capabilityClasses = [
  "economy",
  "standard",
  "premium",
  "frontier"
];
var purposes = [
  "implementation",
  "consultation",
  "review",
  "adversarial-review",
  "rescue"
];
var confidenceLevels = ["low", "medium", "high"];
var routingInputSchemaVersions = [
  ROUTING_INPUT_SCHEMA,
  ROUTING_INPUT_V2_SCHEMA
];
function oneOf(value, values, name) {
  if (typeof value !== "string" || !values.includes(value))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value;
}
function integer(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new RigorError(`${name} is out of range`, EXIT.inputError);
  return value;
}
function bool2(value, name) {
  if (typeof value !== "boolean")
    throw new RigorError(`${name} must be boolean`, EXIT.inputError);
  return value;
}
function assessmentPath(value, name) {
  const p = textField(value, name, 1024);
  if (p.startsWith("/") || p.split(/[\\/]/u).includes(".."))
    throw new RigorError(
      `${name} must be a repository-relative path`,
      EXIT.inputError
    );
  return p;
}
function parseSignals(value) {
  const signals = record(value, "signals");
  return {
    complexity: oneOf(signals.complexity, signalLevels, "complexity"),
    ambiguity: oneOf(signals.ambiguity, signalLevels, "ambiguity"),
    novelty: oneOf(signals.novelty, signalLevels, "novelty"),
    verificationStrength: oneOf(
      signals.verificationStrength,
      verificationStrengths,
      "verificationStrength"
    )
  };
}
function parseBudget(value) {
  const budget = record(value, "budget");
  return {
    maxAttempts: integer(budget.maxAttempts, "maxAttempts", 1, 20),
    maxDurationMs: integer(
      budget.maxDurationMs,
      "maxDurationMs",
      1e3,
      864e5
    ),
    maxRelativeCost: integer(
      budget.maxRelativeCost,
      "maxRelativeCost",
      1,
      1e6
    )
  };
}
function parseEvidence(value) {
  if (!Array.isArray(value) || value.length === 0)
    throw new RigorError(
      "assessment.evidence must not be empty",
      EXIT.inputError
    );
  if (value.length > 20)
    throw new RigorError(
      "assessment.evidence must not exceed 20 items",
      EXIT.inputError
    );
  return value.map((raw, index) => {
    const item = record(raw, `assessment.evidence[${index}]`);
    return {
      path: assessmentPath(item.path, `assessment.evidence[${index}].path`),
      observation: textField(
        item.observation,
        `assessment.evidence[${index}].observation`,
        1e4
      )
    };
  });
}
function parseRoutingInput(value) {
  const item = record(value, "routing input");
  if (item.schemaVersion === ROUTING_INPUT_SCHEMA) {
    const assessmentReasons = strings(
      item.assessmentReasons,
      "assessmentReasons",
      20
    );
    if (assessmentReasons.length === 0)
      throw new RigorError(
        "assessmentReasons must not be empty",
        EXIT.inputError
      );
    return {
      schemaVersion: ROUTING_INPUT_SCHEMA,
      taskId: taskId(item.taskId),
      purpose: oneOf(item.purpose, purposes, "purpose"),
      signals: parseSignals(item.signals),
      assessmentReasons,
      budget: parseBudget(item.budget)
    };
  }
  if (item.schemaVersion === ROUTING_INPUT_V2_SCHEMA) {
    const assessmentRecord = record(item.assessment, "assessment");
    const confidence2 = oneOf(
      assessmentRecord.confidence,
      confidenceLevels,
      "assessment.confidence"
    );
    const evidence = parseEvidence(assessmentRecord.evidence);
    const signals = parseSignals(item.signals);
    if (confidence2 === "high" && (signals.ambiguity === "critical" || signals.verificationStrength === "weak"))
      throw new RigorError(
        "Contradictory assessment: high confidence with critical ambiguity or weak verification",
        EXIT.inputError
      );
    return {
      schemaVersion: ROUTING_INPUT_V2_SCHEMA,
      taskId: taskId(item.taskId),
      purpose: oneOf(item.purpose, purposes, "purpose"),
      signals,
      // v2 does not carry a separate top-level assessmentReasons field; the
      // internal invariant that every routing input has non-empty reasons is
      // preserved by deriving reasons from the evidence observations.
      assessmentReasons: evidence.map((entry) => entry.observation),
      budget: parseBudget(item.budget),
      assessment: {
        inputSchemaVersion: ROUTING_INPUT_V2_SCHEMA,
        confidence: confidence2,
        evidence
      }
    };
  }
  throw new RigorError("Unsupported routing input schema", EXIT.inputError);
}
function parseCandidate(value, index) {
  const item = record(value, `candidates[${index}]`);
  const candidate = {
    id: textField(item.id, `candidates[${index}].id`, 128),
    provider: textField(item.provider, `candidates[${index}].provider`, 128),
    capabilityClass: oneOf(
      item.capabilityClass,
      capabilityClasses,
      `candidates[${index}].capabilityClass`
    ),
    purposes: strings(
      item.purposes,
      `candidates[${index}].purposes`,
      purposes.length
    ).map(
      (purpose) => oneOf(purpose, purposes, `candidates[${index}].purpose`)
    ),
    relativeCost: integer(
      item.relativeCost,
      `candidates[${index}].relativeCost`,
      1,
      1e6
    ),
    requiresAdditionalExternalTransmission: bool2(
      item.requiresAdditionalExternalTransmission,
      `candidates[${index}].requiresAdditionalExternalTransmission`
    ),
    enabled: bool2(item.enabled, `candidates[${index}].enabled`)
  };
  if (item.model !== void 0)
    candidate.model = textField(item.model, `candidates[${index}].model`, 256);
  if (candidate.purposes.length === 0)
    throw new RigorError(
      `candidates[${index}].purposes must not be empty`,
      EXIT.inputError
    );
  if (new Set(candidate.purposes).size !== candidate.purposes.length)
    throw new RigorError(
      `candidates[${index}].purposes contains duplicates`,
      EXIT.inputError
    );
  return candidate;
}
function parseModelProfiles(value) {
  const item = record(value, "model profiles");
  if (item.schemaVersion !== MODEL_PROFILES_SCHEMA)
    throw new RigorError("Unsupported model profiles schema", EXIT.inputError);
  if (!Array.isArray(item.candidates) || item.candidates.length === 0)
    throw new RigorError("candidates must not be empty", EXIT.inputError);
  const candidates = item.candidates.map(parseCandidate);
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length)
    throw new RigorError("Candidate IDs must be unique", EXIT.inputError);
  return { schemaVersion: MODEL_PROFILES_SCHEMA, candidates };
}
function requiredCapability(input) {
  const signalRank = Math.max(
    signalLevels.indexOf(input.signals.complexity),
    signalLevels.indexOf(input.signals.ambiguity),
    signalLevels.indexOf(input.signals.novelty)
  );
  const weaknessBump = input.signals.verificationStrength === "weak" ? 1 : 0;
  return capabilityClasses[Math.min(signalRank + weaknessBump, 3)];
}
function exclusionReason(candidate, input, preflight, required, availability2) {
  if (!candidate.enabled) return "DISABLED";
  const state = availability2.get(candidate.id);
  if (state === "incompatible") return "INCOMPATIBLE";
  if (state === "unavailable") return "UNAVAILABLE";
  if (!candidate.purposes.includes(input.purpose)) return "PURPOSE_UNSUPPORTED";
  if (preflight.externalTransmission === "denied" && candidate.requiresAdditionalExternalTransmission)
    return "EXTERNAL_TRANSMISSION_DENIED";
  if (capabilityClasses.indexOf(candidate.capabilityClass) < capabilityClasses.indexOf(required))
    return "INSUFFICIENT_CAPABILITY";
  if (candidate.relativeCost > input.budget.maxRelativeCost)
    return "BUDGET_EXCEEDED";
  return null;
}
function route(preflight, input, profiles, availability2) {
  if (input.taskId !== preflight.taskId)
    throw new RigorError(
      "Routing taskId does not match preflight",
      EXIT.inputError
    );
  const availabilityStates2 = /* @__PURE__ */ new Map();
  if (availability2 !== void 0) {
    if (availability2.modelProfilesHash !== hash(profiles))
      throw new RigorError(
        "Availability report does not match the model profiles",
        EXIT.inputError
      );
    for (const entry of availability2.candidates)
      availabilityStates2.set(entry.candidateId, entry.state);
  }
  const required = requiredCapability(input);
  const confidence2 = input.assessment?.confidence ?? "medium";
  const eligible = [];
  const excluded = [];
  for (const candidate of profiles.candidates) {
    const reasonCode = exclusionReason(
      candidate,
      input,
      preflight,
      required,
      availabilityStates2
    );
    if (reasonCode) excluded.push({ candidateId: candidate.id, reasonCode });
    else eligible.push(candidate);
  }
  eligible.sort(
    (left, right) => left.relativeCost - right.relativeCost || capabilityClasses.indexOf(left.capabilityClass) - capabilityClasses.indexOf(right.capabilityClass) || left.id.localeCompare(right.id)
  );
  const selected = confidence2 === "low" ? void 0 : eligible[0];
  const selection = selected ? {
    candidateId: selected.id,
    provider: selected.provider,
    ...selected.model === void 0 ? {} : { model: selected.model },
    capabilityClass: selected.capabilityClass,
    relativeCost: selected.relativeCost
  } : null;
  const status = confidence2 === "low" ? "requires-review" : selection ? "selected" : "unroutable";
  return {
    schemaVersion: ROUTING_DECISION_SCHEMA,
    mode: "dry-run",
    taskId: input.taskId,
    preflightArtifactId: preflight.artifactId,
    preflightHash: hash(preflight),
    routingInputHash: hash(input),
    modelProfilesHash: hash(profiles),
    purpose: input.purpose,
    requiredCapabilityClass: required,
    eligibleCandidates: eligible.map((candidate) => candidate.id),
    excludedCandidates: excluded,
    selection,
    controls: {
      externalTransmission: preflight.externalTransmission,
      requireHumanApproval: preflight.requireHumanApproval,
      requireIndependentReview: preflight.riskTier === "high" || preflight.riskTier === "critical" || preflight.protectedPaths.length > 0
    },
    budget: input.budget,
    ...availability2 === void 0 ? {} : { availabilityReportHash: hash(availability2) },
    assessment: {
      inputSchemaVersion: input.schemaVersion,
      confidence: confidence2,
      evidenceCount: input.assessment?.evidence.length ?? 0
    },
    status
  };
}
function createRoutingPlan(decision2, preflight, contract, now = /* @__PURE__ */ new Date()) {
  if (decision2.status !== "selected" || decision2.selection === null || decision2.taskId !== contract.taskId || preflight.taskId !== contract.taskId)
    throw new RigorError(
      "A selected, task-matched routing decision is required",
      EXIT.policyViolation
    );
  if (contract.preflightArtifactId !== preflight.artifactId || contract.preflightHash !== hash(preflight))
    throw new RigorError(
      "Contract is not linked to the routing preflight",
      EXIT.policyViolation
    );
  const {
    schemaVersion: _schemaVersion,
    mode: _mode,
    status: _status,
    ...rest
  } = decision2;
  void _schemaVersion;
  void _mode;
  void _status;
  return {
    ...rest,
    schemaVersion: ROUTING_PLAN_SCHEMA,
    artifactId: artifactId("routing-plan"),
    createdAt: now.toISOString(),
    contractArtifactId: contract.artifactId,
    contractHash: hash(contract),
    policyHash: preflight.policyHash,
    plannedHead: preflight.git.head,
    status: "planned"
  };
}
function parseRoutingPlan(value) {
  const item = record(value, "routing plan");
  if (item.schemaVersion !== ROUTING_PLAN_SCHEMA)
    throw new RigorError("Unsupported routing plan schema", EXIT.inputError);
  const selection = record(item.selection, "selection");
  const controls = record(item.controls, "controls");
  const budget = record(item.budget, "budget");
  const plannedHead = item.plannedHead;
  if (plannedHead !== null && typeof plannedHead !== "string")
    throw new RigorError("plannedHead is invalid", EXIT.inputError);
  const assessment = item.assessment === void 0 ? {
    inputSchemaVersion: ROUTING_INPUT_SCHEMA,
    confidence: "medium",
    evidenceCount: 0
  } : (() => {
    const raw = record(item.assessment, "assessment");
    return {
      inputSchemaVersion: oneOf(
        raw.inputSchemaVersion,
        routingInputSchemaVersions,
        "assessment.inputSchemaVersion"
      ),
      confidence: oneOf(
        raw.confidence,
        confidenceLevels,
        "assessment.confidence"
      ),
      evidenceCount: integer(
        raw.evidenceCount,
        "assessment.evidenceCount",
        0,
        20
      )
    };
  })();
  const plan = {
    schemaVersion: ROUTING_PLAN_SCHEMA,
    artifactId: textField(item.artifactId, "artifactId", 128),
    createdAt: textField(item.createdAt, "createdAt", 128),
    taskId: taskId(item.taskId),
    preflightArtifactId: textField(
      item.preflightArtifactId,
      "preflightArtifactId",
      128
    ),
    preflightHash: textField(item.preflightHash, "preflightHash", 128),
    routingInputHash: textField(item.routingInputHash, "routingInputHash", 128),
    modelProfilesHash: textField(
      item.modelProfilesHash,
      "modelProfilesHash",
      128
    ),
    contractArtifactId: textField(
      item.contractArtifactId,
      "contractArtifactId",
      128
    ),
    contractHash: textField(item.contractHash, "contractHash", 128),
    policyHash: textField(item.policyHash, "policyHash", 128),
    plannedHead,
    purpose: oneOf(item.purpose, purposes, "purpose"),
    requiredCapabilityClass: oneOf(
      item.requiredCapabilityClass,
      capabilityClasses,
      "requiredCapabilityClass"
    ),
    eligibleCandidates: strings(item.eligibleCandidates, "eligibleCandidates"),
    excludedCandidates: [],
    selection: {
      candidateId: textField(selection.candidateId, "candidateId", 128),
      provider: textField(selection.provider, "provider", 128),
      capabilityClass: oneOf(
        selection.capabilityClass,
        capabilityClasses,
        "selection.capabilityClass"
      ),
      relativeCost: integer(
        selection.relativeCost,
        "selection.relativeCost",
        1,
        1e6
      )
    },
    controls: {
      externalTransmission: oneOf(
        controls.externalTransmission,
        ["allowed", "denied"],
        "externalTransmission"
      ),
      requireHumanApproval: bool2(
        controls.requireHumanApproval,
        "requireHumanApproval"
      ),
      requireIndependentReview: bool2(
        controls.requireIndependentReview,
        "requireIndependentReview"
      )
    },
    budget: {
      maxAttempts: integer(budget.maxAttempts, "maxAttempts", 1, 20),
      maxDurationMs: integer(
        budget.maxDurationMs,
        "maxDurationMs",
        1e3,
        864e5
      ),
      maxRelativeCost: integer(
        budget.maxRelativeCost,
        "maxRelativeCost",
        1,
        1e6
      )
    },
    assessment,
    status: "planned"
  };
  if (selection.model !== void 0)
    plan.selection.model = textField(selection.model, "selection.model", 256);
  if (!Array.isArray(item.excludedCandidates))
    throw new RigorError(
      "excludedCandidates must be an array",
      EXIT.inputError
    );
  plan.excludedCandidates = item.excludedCandidates.map((raw, index) => {
    const excluded = record(raw, `excludedCandidates[${index}]`);
    return {
      candidateId: textField(excluded.candidateId, "candidateId", 128),
      reasonCode: oneOf(
        excluded.reasonCode,
        [
          "DISABLED",
          "PURPOSE_UNSUPPORTED",
          "EXTERNAL_TRANSMISSION_DENIED",
          "INSUFFICIENT_CAPABILITY",
          "BUDGET_EXCEEDED",
          "UNAVAILABLE",
          "INCOMPATIBLE"
        ],
        "reasonCode"
      )
    };
  });
  if (item.availabilityReportHash !== void 0)
    plan.availabilityReportHash = textField(
      item.availabilityReportHash,
      "availabilityReportHash",
      128
    );
  return plan;
}

// src/availability.ts
var CLAUDE_PRESENCE_VARS = ["CLAUDE_PLUGIN_ROOT", "CLAUDE_CODE_ENTRYPOINT"];
var TRUTHY = /* @__PURE__ */ new Set(["1", "true", "yes", "present"]);
var FALSEY = /* @__PURE__ */ new Set(["0", "false", "no", "absent"]);
function boundedVersion(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || trimmed.includes("\0"))
    return null;
  return trimmed;
}
function codexPresence(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (TRUTHY.has(normalized)) return "present";
  if (FALSEY.has(normalized)) return "absent";
  return "unknown";
}
function probeEnvironment(env = process.env) {
  try {
    const claudeVersion = boundedVersion(env.CLAUDE_CODE_VERSION);
    const configuredRaw = typeof env.ANTHROPIC_MODEL === "string" ? env.ANTHROPIC_MODEL.trim() : null;
    const configuredModel = configuredRaw !== null && configuredRaw.length > 0 && configuredRaw.length <= 256 && !configuredRaw.includes("\0") ? configuredRaw : null;
    return {
      probeSupported: true,
      claudeCode: {
        present: CLAUDE_PRESENCE_VARS.some(
          (name) => typeof env[name] === "string" && env[name].length > 0
        ),
        version: claudeVersion
      },
      configuredModel,
      codexPlugin: {
        presence: codexPresence(env.RIGOR_CODEX_PLUGIN_PRESENT),
        version: boundedVersion(env.RIGOR_CODEX_PLUGIN_VERSION)
      }
    };
  } catch {
    return {
      probeSupported: false,
      claudeCode: { present: false, version: null },
      configuredModel: null,
      codexPlugin: { presence: "unknown", version: null }
    };
  }
}
function deriveState(candidate, observation) {
  if (candidate.provider !== "claude" && candidate.provider !== "codex-plugin-cc")
    return {
      state: "incompatible",
      reason: "Provider cannot be invoked by the Claude Code execution layer (only claude and codex-plugin-cc are supported).",
      toolVersion: null
    };
  if (!observation.probeSupported)
    return {
      state: "unknown",
      reason: "Environment probing is unsupported; availability is unknown.",
      toolVersion: null
    };
  if (candidate.provider === "claude") {
    if (observation.claudeCode.present)
      return {
        state: "available",
        reason: "Claude Code execution environment observed; runtime model identity remains unverified.",
        toolVersion: observation.claudeCode.version
      };
    return {
      state: "unknown",
      reason: "Claude Code environment not observable through documented variables; availability is unknown.",
      toolVersion: observation.claudeCode.version
    };
  }
  if (observation.codexPlugin.presence === "present")
    return {
      state: "available",
      reason: "codex-plugin-cc declared present by the orchestrator.",
      toolVersion: observation.codexPlugin.version
    };
  if (observation.codexPlugin.presence === "absent")
    return {
      state: "unavailable",
      reason: "codex-plugin-cc declared absent by the orchestrator.",
      toolVersion: observation.codexPlugin.version
    };
  return {
    state: "unknown",
    reason: "codex-plugin-cc presence not declared through documented variables; availability is unknown.",
    toolVersion: observation.codexPlugin.version
  };
}
function buildAvailabilityReport(profiles, observation, now = /* @__PURE__ */ new Date()) {
  const observedAt = now.toISOString();
  const candidates = profiles.candidates.map(
    (candidate) => {
      const derived = deriveState(candidate, observation);
      return {
        candidateId: candidate.id,
        provider: candidate.provider,
        state: derived.state,
        reason: derived.reason,
        observedAt,
        toolVersion: derived.toolVersion
      };
    }
  );
  return {
    schemaVersion: AVAILABILITY_SCHEMA,
    artifactId: artifactId("availability"),
    createdAt: observedAt,
    modelProfilesHash: hash(profiles),
    probeStatus: observation.probeSupported ? "supported" : "unsupported",
    environment: {
      claudeCode: {
        present: observation.claudeCode.present,
        version: observation.claudeCode.version
      },
      configuredModel: observation.configuredModel === null ? null : { value: observation.configuredModel, attestation: "unverified" },
      codexPlugin: {
        presence: observation.codexPlugin.presence,
        version: observation.codexPlugin.version
      }
    },
    candidates
  };
}
var availabilityStates = [
  "available",
  "unavailable",
  "unknown",
  "incompatible"
];
var codexPresences = ["present", "absent", "unknown"];
function oneOf2(value, values, name) {
  if (typeof value !== "string" || !values.includes(value))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value;
}
function optionalVersion(value, name) {
  if (value === null) return null;
  return textField(value, name, 128);
}
function parseAvailabilityReport(value) {
  const item = record(value, "availability report");
  if (item.schemaVersion !== AVAILABILITY_SCHEMA)
    throw new RigorError(
      "Unsupported availability report schema",
      EXIT.inputError
    );
  const environment = record(item.environment, "environment");
  const claudeCode = record(environment.claudeCode, "environment.claudeCode");
  const codexPlugin = record(
    environment.codexPlugin,
    "environment.codexPlugin"
  );
  if (typeof claudeCode.present !== "boolean")
    throw new RigorError(
      "environment.claudeCode.present must be boolean",
      EXIT.inputError
    );
  let configuredModel = null;
  if (environment.configuredModel !== null) {
    const configured = record(
      environment.configuredModel,
      "environment.configuredModel"
    );
    if (configured.attestation !== "unverified")
      throw new RigorError(
        "configuredModel.attestation must be unverified",
        EXIT.inputError
      );
    configuredModel = {
      value: textField(configured.value, "configuredModel.value", 256),
      attestation: "unverified"
    };
  }
  if (!Array.isArray(item.candidates))
    throw new RigorError("candidates must be an array", EXIT.inputError);
  const candidates = item.candidates.map((raw, index) => {
    const candidate = record(raw, `candidates[${index}]`);
    return {
      candidateId: textField(
        candidate.candidateId,
        `candidates[${index}].candidateId`,
        128
      ),
      provider: textField(
        candidate.provider,
        `candidates[${index}].provider`,
        128
      ),
      state: oneOf2(
        candidate.state,
        availabilityStates,
        `candidates[${index}].state`
      ),
      reason: textField(candidate.reason, `candidates[${index}].reason`, 1e3),
      observedAt: textField(
        candidate.observedAt,
        `candidates[${index}].observedAt`,
        128
      ),
      toolVersion: optionalVersion(
        candidate.toolVersion,
        `candidates[${index}].toolVersion`
      )
    };
  });
  return {
    schemaVersion: AVAILABILITY_SCHEMA,
    artifactId: textField(item.artifactId, "artifactId", 128),
    createdAt: textField(item.createdAt, "createdAt", 128),
    modelProfilesHash: textField(
      item.modelProfilesHash,
      "modelProfilesHash",
      128
    ),
    probeStatus: oneOf2(
      item.probeStatus,
      ["supported", "unsupported"],
      "probeStatus"
    ),
    environment: {
      claudeCode: {
        present: claudeCode.present,
        version: optionalVersion(
          claudeCode.version,
          "environment.claudeCode.version"
        )
      },
      configuredModel,
      codexPlugin: {
        presence: oneOf2(
          codexPlugin.presence,
          codexPresences,
          "environment.codexPlugin.presence"
        ),
        version: optionalVersion(
          codexPlugin.version,
          "environment.codexPlugin.version"
        )
      }
    },
    candidates
  };
}

// src/consultation.ts
var ignoredEvidence = [".rigor/evidence/", ".rigor/events.jsonl"];
var modes = [
  "review",
  "adversarial-review",
  "consultation",
  "rescue"
];
var outcomes = [
  "accept",
  "revise",
  "reject",
  "investigate",
  "ask-human"
];
var severities = [
  "critical",
  "high",
  "medium",
  "low",
  "informational"
];
var reproducibility = [
  "always",
  "intermittent",
  "not-reproduced"
];
var confidence = [
  "low",
  "medium",
  "high"
];
function oneOf3(value, values, name) {
  if (typeof value !== "string" || !values.includes(value))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value;
}
function optionalText(value, name) {
  return value === void 0 ? void 0 : textField(value, name, 512);
}
function evidencePath(value, name) {
  const result = textField(value, name, 1024);
  if (result.startsWith("/") || result.startsWith("\\") || /^[A-Za-z]:/u.test(result) || result.split(/[\\/]/u).includes(".."))
    throw new RigorError(
      `${name} must be a repository-relative path`,
      EXIT.inputError
    );
  return result;
}
function exactKeys(item, allowed, name) {
  const unexpected = Object.keys(item).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    throw new RigorError(
      `${name} contains unsupported fields: ${unexpected.join(", ")}`,
      EXIT.inputError
    );
}
function findings(value) {
  if (!Array.isArray(value) || value.length > 100)
    throw new RigorError(
      "findings must contain at most 100 items",
      EXIT.inputError
    );
  return value.map((raw, index) => {
    const item = record(raw, `findings[${index}]`);
    exactKeys(
      item,
      [
        "severity",
        "evidenceLocation",
        "reproducibility",
        "requiredAction",
        "confidence"
      ],
      `findings[${index}]`
    );
    const location = record(
      item.evidenceLocation,
      `findings[${index}].evidenceLocation`
    );
    exactKeys(
      location,
      ["path", "line"],
      `findings[${index}].evidenceLocation`
    );
    const finding = {
      severity: oneOf3(item.severity, severities, `findings[${index}].severity`),
      evidenceLocation: {
        path: evidencePath(
          location.path,
          `findings[${index}].evidenceLocation.path`
        )
      },
      reproducibility: oneOf3(
        item.reproducibility,
        reproducibility,
        `findings[${index}].reproducibility`
      ),
      requiredAction: textField(
        item.requiredAction,
        `findings[${index}].requiredAction`,
        2e3
      ),
      confidence: oneOf3(
        item.confidence,
        confidence,
        `findings[${index}].confidence`
      )
    };
    if (location.line !== void 0) {
      if (!Number.isInteger(location.line) || location.line < 1 || location.line > 1e7)
        throw new RigorError(
          `findings[${index}].evidenceLocation.line is invalid`,
          EXIT.inputError
        );
      finding.evidenceLocation.line = location.line;
    }
    return finding;
  });
}
function filteredChangedPaths(paths) {
  return paths.filter(
    (file) => !ignoredEvidence.some((prefix) => file.startsWith(prefix))
  );
}
function parseConsultationRequest(value) {
  const item = record(value, "consultation request");
  if (item.schemaVersion !== CONSULTATION_REQUEST_SCHEMA)
    throw new RigorError(
      "Unsupported consultation request schema",
      EXIT.inputError
    );
  if (item.provider !== "codex-plugin-cc")
    throw new RigorError(
      "Phase 2 consultations require codex-plugin-cc",
      EXIT.inputError
    );
  return {
    schemaVersion: CONSULTATION_REQUEST_SCHEMA,
    taskId: taskId(item.taskId),
    provider: "codex-plugin-cc",
    mode: oneOf3(item.mode, modes, "mode"),
    requestedDecision: textField(
      item.requestedDecision,
      "requestedDecision",
      2e3
    )
  };
}
function parseConsultationSession(value) {
  const item = record(value, "consultation session");
  if (item.schemaVersion !== CONSULTATION_SESSION_SCHEMA)
    throw new RigorError(
      "Unsupported consultation session schema",
      EXIT.inputError
    );
  if (item.provider !== "codex-plugin-cc" || item.transmissionDecision !== "allowed")
    throw new RigorError("Invalid consultation session", EXIT.inputError);
  const beforeHead = item.beforeHead;
  if (beforeHead !== null && typeof beforeHead !== "string")
    throw new RigorError("beforeHead is invalid", EXIT.inputError);
  return {
    schemaVersion: CONSULTATION_SESSION_SCHEMA,
    artifactId: textField(item.artifactId, "artifactId", 128),
    taskId: taskId(item.taskId),
    createdAt: textField(item.createdAt, "createdAt", 128),
    preflightArtifactId: textField(
      item.preflightArtifactId,
      "preflightArtifactId",
      128
    ),
    preflightHash: textField(item.preflightHash, "preflightHash", 128),
    provider: "codex-plugin-cc",
    mode: oneOf3(item.mode, modes, "mode"),
    requestedDecision: textField(
      item.requestedDecision,
      "requestedDecision",
      2e3
    ),
    transmissionDecision: "allowed",
    beforeHead,
    beforeTreeHash: textField(item.beforeTreeHash, "beforeTreeHash", 128),
    changedPathsBefore: strings(item.changedPathsBefore, "changedPathsBefore")
  };
}
function parseConsultationResultInput(value) {
  const item = record(value, "consultation result input");
  if (item.schemaVersion !== CONSULTATION_RESULT_INPUT_SCHEMA && item.schemaVersion !== CONSULTATION_RESULT_INPUT_V2_SCHEMA)
    throw new RigorError(
      "Unsupported consultation result input schema",
      EXIT.inputError
    );
  const structuredFindings = item.schemaVersion === CONSULTATION_RESULT_INPUT_V2_SCHEMA ? findings(item.findings) : void 0;
  if (item.schemaVersion === CONSULTATION_RESULT_INPUT_V2_SCHEMA)
    exactKeys(
      item,
      [
        "schemaVersion",
        "taskId",
        "status",
        "outcome",
        "findings",
        "externalJobId",
        "externalSessionId",
        "externalTurnId",
        "model",
        "reasoningEffort",
        "usageStatus",
        "modelStatus",
        "reasoningEffortStatus"
      ],
      "consultation result input"
    );
  if (item.schemaVersion === CONSULTATION_RESULT_INPUT_SCHEMA && (!Number.isInteger(item.findingCount) || item.findingCount < 0))
    throw new RigorError("findingCount is invalid", EXIT.inputError);
  const modelStatus = item.schemaVersion === CONSULTATION_RESULT_INPUT_V2_SCHEMA ? oneOf3(item.modelStatus, ["recorded", "unavailable"], "modelStatus") : void 0;
  const reasoningEffortStatus = item.schemaVersion === CONSULTATION_RESULT_INPUT_V2_SCHEMA ? oneOf3(
    item.reasoningEffortStatus,
    ["recorded", "unavailable"],
    "reasoningEffortStatus"
  ) : void 0;
  const model = optionalText(item.model, "model");
  const reasoningEffort = optionalText(item.reasoningEffort, "reasoningEffort");
  if (item.schemaVersion === CONSULTATION_RESULT_INPUT_V2_SCHEMA && (modelStatus === "recorded" !== (model !== void 0) || reasoningEffortStatus === "recorded" !== (reasoningEffort !== void 0)))
    throw new RigorError(
      "Recorded/unavailable metadata status is inconsistent",
      EXIT.inputError
    );
  const result = {
    schemaVersion: item.schemaVersion,
    taskId: taskId(item.taskId),
    status: oneOf3(item.status, ["completed", "failed"], "status"),
    outcome: oneOf3(item.outcome, outcomes, "outcome"),
    findingCount: structuredFindings === void 0 ? item.findingCount : structuredFindings.length,
    requiredActions: structuredFindings === void 0 ? strings(item.requiredActions, "requiredActions", 100) : structuredFindings.map((finding) => finding.requiredAction),
    usageStatus: oneOf3(
      item.usageStatus,
      ["recorded", "unavailable"],
      "usageStatus"
    )
  };
  if (structuredFindings !== void 0) {
    result.findings = structuredFindings;
    result.modelStatus = modelStatus;
    result.reasoningEffortStatus = reasoningEffortStatus;
  }
  for (const [key, value2] of Object.entries({
    externalJobId: optionalText(item.externalJobId, "externalJobId"),
    externalSessionId: optionalText(
      item.externalSessionId,
      "externalSessionId"
    ),
    externalTurnId: optionalText(item.externalTurnId, "externalTurnId"),
    model,
    reasoningEffort
  }))
    if (value2 !== void 0) Object.assign(result, { [key]: value2 });
  return result;
}
async function startConsultation(root, policy, preflight, request, now = /* @__PURE__ */ new Date()) {
  if (request.taskId !== preflight.taskId)
    throw new RigorError(
      "Consultation taskId does not match preflight",
      EXIT.inputError
    );
  if (preflight.policyHash !== hash(policy))
    throw new RigorError(
      "Consultation preflight does not match the current policy",
      EXIT.policyViolation
    );
  if (preflight.externalTransmission !== "allowed")
    throw new RigorError(
      "Policy denies transmission to codex-plugin-cc",
      EXIT.policyViolation
    );
  const facts = await gitFacts(root);
  if (preflight.git.head !== facts.head)
    throw new RigorError(
      "Git HEAD changed after preflight; run preflight again",
      EXIT.policyViolation
    );
  const changedPathsBefore = filteredChangedPaths(facts.changedPaths);
  const unplanned = changedPathsBefore.filter(
    (file) => !matches(file, preflight.plannedPaths)
  );
  if (unplanned.length > 0)
    throw new RigorError(
      `Changed paths are outside preflight scope: ${unplanned.join(", ")}`,
      EXIT.policyViolation
    );
  const session = {
    schemaVersion: CONSULTATION_SESSION_SCHEMA,
    artifactId: artifactId("consultation-session"),
    taskId: request.taskId,
    createdAt: now.toISOString(),
    preflightArtifactId: preflight.artifactId,
    preflightHash: hash(preflight),
    provider: "codex-plugin-cc",
    mode: request.mode,
    requestedDecision: request.requestedDecision,
    transmissionDecision: "allowed",
    beforeHead: facts.head,
    beforeTreeHash: await treeHash(root, ignoredEvidence),
    changedPathsBefore
  };
  const saved = await saveCollectionArtifact(
    root,
    request.taskId,
    "consultations",
    "consultation-session",
    session
  );
  return { session, saved };
}
async function finishConsultation(root, session, input, now = /* @__PURE__ */ new Date()) {
  if (input.taskId !== session.taskId)
    throw new RigorError(
      "Consultation result taskId does not match session",
      EXIT.inputError
    );
  const facts = await gitFacts(root);
  const afterTreeHash = await treeHash(root, ignoredEvidence);
  const changedPathsAfter = filteredChangedPaths(facts.changedPaths);
  const mutated = session.beforeHead !== facts.head || session.beforeTreeHash !== afterTreeHash || JSON.stringify(session.changedPathsBefore) !== JSON.stringify(changedPathsAfter);
  const consultation = {
    schemaVersion: input.schemaVersion === CONSULTATION_RESULT_INPUT_V2_SCHEMA ? CONSULTATION_V2_SCHEMA : CONSULTATION_SCHEMA,
    artifactId: artifactId("consultation"),
    taskId: session.taskId,
    createdAt: now.toISOString(),
    sessionArtifactId: session.artifactId,
    sessionHash: hash(session),
    provider: session.provider,
    mode: session.mode,
    requestedDecision: session.requestedDecision,
    transmissionDecision: session.transmissionDecision,
    beforeTreeHash: session.beforeTreeHash,
    afterTreeHash,
    beforeHead: session.beforeHead,
    afterHead: facts.head,
    changedPathsBefore: session.changedPathsBefore,
    changedPathsAfter,
    usageStatus: input.usageStatus,
    status: mutated ? "mutated-worktree" : input.status,
    outcome: input.outcome,
    findingCount: input.findingCount,
    requiredActions: input.requiredActions
  };
  if (input.schemaVersion === CONSULTATION_RESULT_INPUT_V2_SCHEMA) {
    consultation.findings = input.findings;
    consultation.modelStatus = input.modelStatus;
    consultation.reasoningEffortStatus = input.reasoningEffortStatus;
  }
  for (const key of [
    "externalJobId",
    "externalSessionId",
    "externalTurnId",
    "model",
    "reasoningEffort"
  ]) {
    const value = input[key];
    if (value !== void 0) consultation[key] = value;
  }
  const saved = await saveCollectionArtifact(
    root,
    session.taskId,
    "consultations",
    "consultation",
    consultation
  );
  return { consultation, saved };
}

// src/attempt.ts
var import_promises8 = require("node:fs/promises");
var import_node_path9 = __toESM(require("node:path"), 1);
var ignoredEvidence2 = [".rigor/evidence/", ".rigor/events.jsonl"];
var capabilities = [
  "economy",
  "standard",
  "premium",
  "frontier"
];
var purposes2 = [
  "implementation",
  "consultation",
  "review",
  "adversarial-review",
  "rescue"
];
function oneOf4(value, values, name) {
  if (typeof value !== "string" || !values.includes(value))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value;
}
function optionalText2(value, name) {
  return value === void 0 ? void 0 : textField(value, name, 512);
}
function filteredChangedPaths2(paths) {
  return paths.filter(
    (file) => !ignoredEvidence2.some((prefix) => file.startsWith(prefix))
  );
}
async function attemptState(root, task) {
  const directory = import_node_path9.default.join(root, ".rigor", "evidence", task, "attempts");
  let names;
  try {
    names = await (0, import_promises8.readdir)(directory);
  } catch (error) {
    if (error.code === "ENOENT")
      return { count: 0, unfinished: [], finishedAttempts: [] };
    throw error;
  }
  const sessions = /* @__PURE__ */ new Set();
  const finished = /* @__PURE__ */ new Set();
  const finishedAttempts = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    let item;
    try {
      item = record(
        JSON.parse(
          await (0, import_promises8.readFile)(import_node_path9.default.join(directory, name), "utf8")
        ),
        "attempt artifact"
      );
    } catch {
      throw new RigorError(
        `Invalid attempt artifact: ${name}`,
        EXIT.inputError
      );
    }
    if (item.schemaVersion === ATTEMPT_SESSION_SCHEMA)
      sessions.add(textField(item.artifactId, "artifactId", 128));
    if (item.schemaVersion === ATTEMPT_SCHEMA) {
      finished.add(textField(item.sessionArtifactId, "sessionArtifactId", 128));
      finishedAttempts.push(item);
    }
  }
  return {
    count: sessions.size,
    unfinished: [...sessions].filter((id) => !finished.has(id)),
    finishedAttempts
  };
}
function mostRecentPriorAttempt(finishedAttempts, beforeSequence) {
  let best = null;
  let bestSequence = -1;
  for (const item of finishedAttempts) {
    const sequence = item.sequence;
    if (typeof sequence !== "number" || !(sequence < beforeSequence)) continue;
    if (sequence > bestSequence) {
      bestSequence = sequence;
      best = item;
    }
  }
  return best;
}
function parseAttemptSession(value) {
  const item = record(value, "attempt session");
  if (item.schemaVersion !== ATTEMPT_SESSION_SCHEMA)
    throw new RigorError("Unsupported attempt session schema", EXIT.inputError);
  const selection = record(item.selection, "selection");
  const budget = record(item.budget, "budget");
  const beforeHead = item.beforeHead;
  if (beforeHead !== null && typeof beforeHead !== "string")
    throw new RigorError("beforeHead is invalid", EXIT.inputError);
  const session = {
    schemaVersion: ATTEMPT_SESSION_SCHEMA,
    artifactId: textField(item.artifactId, "artifactId", 128),
    taskId: taskId(item.taskId),
    createdAt: textField(item.createdAt, "createdAt", 128),
    sequence: Number(item.sequence),
    routingPlanArtifactId: textField(
      item.routingPlanArtifactId,
      "routingPlanArtifactId",
      128
    ),
    routingPlanHash: textField(item.routingPlanHash, "routingPlanHash", 128),
    contractArtifactId: textField(
      item.contractArtifactId,
      "contractArtifactId",
      128
    ),
    contractHash: textField(item.contractHash, "contractHash", 128),
    provider: textField(selection.provider, "selection.provider", 128),
    capabilityClass: oneOf4(
      selection.capabilityClass,
      capabilities,
      "selection.capabilityClass"
    ),
    purpose: oneOf4(item.purpose, purposes2, "purpose"),
    budget: {
      maxAttempts: Number(budget.maxAttempts),
      maxDurationMs: Number(budget.maxDurationMs),
      maxRelativeCost: Number(budget.maxRelativeCost)
    },
    executionIdentityStatus: "unverified",
    beforeHead,
    beforeTreeHash: textField(item.beforeTreeHash, "beforeTreeHash", 128),
    changedPathsBefore: strings(item.changedPathsBefore, "changedPathsBefore")
  };
  for (const [name, number, minimum, maximum] of [
    ["sequence", session.sequence, 1, 20],
    ["maxAttempts", session.budget.maxAttempts, 1, 20],
    ["maxDurationMs", session.budget.maxDurationMs, 1e3, 864e5],
    ["maxRelativeCost", session.budget.maxRelativeCost, 1, 1e6]
  ])
    if (!Number.isInteger(number) || number < minimum || number > maximum)
      throw new RigorError(`${name} is out of range`, EXIT.inputError);
  if (item.executionIdentityStatus !== "unverified")
    throw new RigorError(
      "executionIdentityStatus must be unverified",
      EXIT.inputError
    );
  if (selection.model !== void 0)
    session.model = textField(selection.model, "selection.model", 256);
  return session;
}
function parseAttempt(value) {
  const item = record(value, "attempt");
  if (item.schemaVersion !== ATTEMPT_SCHEMA)
    throw new RigorError("Unsupported attempt schema", EXIT.inputError);
  taskId(item.taskId);
  textField(item.artifactId, "attempt.artifactId", 128);
  if (!Number.isInteger(item.sequence) || item.sequence < 1 || item.sequence > 20)
    throw new RigorError("attempt.sequence is invalid", EXIT.inputError);
  oneOf4(
    item.status,
    ["completed", "failed", "cancelled", "scope-violation", "budget-exceeded"],
    "attempt.status"
  );
  if (!Number.isInteger(item.durationMs) || item.durationMs < 0)
    throw new RigorError("attempt.durationMs is invalid", EXIT.inputError);
  textField(item.provider, "attempt.provider", 128);
  oneOf4(item.capabilityClass, capabilities, "attempt.capabilityClass");
  if (item.executionIdentityStatus !== "unverified")
    throw new RigorError(
      "executionIdentityStatus must be unverified",
      EXIT.inputError
    );
  if (item.model !== void 0) textField(item.model, "attempt.model", 256);
  if (item.verificationArtifactId !== void 0)
    textField(
      item.verificationArtifactId,
      "attempt.verificationArtifactId",
      128
    );
  if (item.failureFingerprint !== void 0 && item.failureFingerprint !== null)
    textField(item.failureFingerprint, "attempt.failureFingerprint", 128);
  if (item.failureCategory !== void 0 && item.failureCategory !== null)
    oneOf4(
      item.failureCategory,
      ["implementation", "infrastructure", "timeout", "flaky", "mixed"],
      "attempt.failureCategory"
    );
  if (item.failureFacts !== void 0 && !Array.isArray(item.failureFacts))
    throw new RigorError(
      "attempt.failureFacts must be an array",
      EXIT.inputError
    );
  if (item.progress !== void 0) {
    const progress2 = record(item.progress, "attempt.progress");
    oneOf4(
      progress2.status,
      ["first", "unchanged", "reduced", "expanded", "incomparable"],
      "attempt.progress.status"
    );
    strings(progress2.weakeningSignals, "attempt.progress.weakeningSignals");
    if (progress2.comparedToAttemptArtifactId !== null && progress2.comparedToAttemptArtifactId !== void 0)
      textField(
        progress2.comparedToAttemptArtifactId,
        "attempt.progress.comparedToAttemptArtifactId",
        128
      );
  }
  return item;
}
function parseAttemptResultInput(value) {
  const item = record(value, "attempt result input");
  if (item.schemaVersion !== ATTEMPT_RESULT_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported attempt result input schema",
      EXIT.inputError
    );
  const result = {
    schemaVersion: ATTEMPT_RESULT_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    status: oneOf4(item.status, ["completed", "failed", "cancelled"], "status")
  };
  for (const [key, value2] of Object.entries({
    failureClass: optionalText2(item.failureClass, "failureClass"),
    externalSessionId: optionalText2(
      item.externalSessionId,
      "externalSessionId"
    ),
    externalTurnId: optionalText2(item.externalTurnId, "externalTurnId")
  }))
    if (value2 !== void 0) Object.assign(result, { [key]: value2 });
  return result;
}
async function startAttempt(root, policy, plan, contract, now = /* @__PURE__ */ new Date()) {
  if (plan.taskId !== contract.taskId || plan.contractArtifactId !== contract.artifactId || plan.contractHash !== hash(contract))
    throw new RigorError(
      "Routing plan is not linked to the contract",
      EXIT.policyViolation
    );
  if (plan.policyHash !== hash(policy))
    throw new RigorError(
      "Routing plan does not match the current policy",
      EXIT.policyViolation
    );
  if (plan.selection === null)
    throw new RigorError("Routing plan has no selection", EXIT.inputError);
  if (plan.selection.provider !== "claude" && plan.selection.provider !== "codex-plugin-cc")
    throw new RigorError(
      "Phase 3 attempts support only claude or codex-plugin-cc",
      EXIT.inputError
    );
  if (plan.selection.provider === "codex-plugin-cc" && plan.controls.externalTransmission !== "allowed")
    throw new RigorError(
      "Routing plan denies Codex transmission",
      EXIT.policyViolation
    );
  const state = await attemptState(root, plan.taskId);
  if (state.unfinished.length > 0)
    throw new RigorError(
      "An unfinished attempt must be finalized first",
      EXIT.policyViolation
    );
  if (state.count >= plan.budget.maxAttempts)
    throw new RigorError("Attempt budget is exhausted", EXIT.policyViolation);
  const facts = await gitFacts(root);
  if (facts.head !== plan.plannedHead)
    throw new RigorError(
      "Git HEAD changed after routing; create a new plan",
      EXIT.policyViolation
    );
  const changedPathsBefore = filteredChangedPaths2(facts.changedPaths);
  const outside = changedPathsBefore.filter(
    (file) => !matches(file, contract.allowedPaths)
  );
  if (outside.length > 0)
    throw new RigorError(
      `Changed paths are outside contract scope: ${outside.join(", ")}`,
      EXIT.policyViolation
    );
  const session = {
    schemaVersion: ATTEMPT_SESSION_SCHEMA,
    artifactId: artifactId("attempt-session"),
    taskId: plan.taskId,
    createdAt: now.toISOString(),
    sequence: state.count + 1,
    routingPlanArtifactId: plan.artifactId,
    routingPlanHash: hash(plan),
    contractArtifactId: contract.artifactId,
    contractHash: hash(contract),
    provider: plan.selection.provider,
    ...plan.selection.model === void 0 ? {} : { model: plan.selection.model },
    capabilityClass: plan.selection.capabilityClass,
    purpose: plan.purpose,
    budget: plan.budget,
    executionIdentityStatus: "unverified",
    beforeHead: facts.head,
    beforeTreeHash: await treeHash(root, ignoredEvidence2),
    changedPathsBefore
  };
  const serialized = {
    ...session,
    selection: {
      provider: session.provider,
      ...session.model === void 0 ? {} : { model: session.model },
      capabilityClass: session.capabilityClass
    }
  };
  delete serialized.provider;
  delete serialized.model;
  delete serialized.capabilityClass;
  const saved = await saveCollectionArtifact(
    root,
    plan.taskId,
    "attempts",
    "attempt-session",
    serialized
  );
  return { session, saved };
}
async function finishAttempt(root, session, contract, input, verification, now = /* @__PURE__ */ new Date()) {
  if (input.taskId !== session.taskId || contract.taskId !== session.taskId || session.contractArtifactId !== contract.artifactId || session.contractHash !== hash(contract))
    throw new RigorError(
      "Attempt result, session, and contract are not linked",
      EXIT.policyViolation
    );
  if (verification !== void 0) {
    if (verification.taskId !== session.taskId || verification.contractArtifactId !== contract.artifactId)
      throw new RigorError(
        "Verification is not linked to the attempt contract",
        EXIT.policyViolation
      );
  }
  if (input.status === "completed" && (verification === void 0 || verification.status !== "passed"))
    throw new RigorError(
      "A completed attempt requires passing verification",
      EXIT.policyViolation
    );
  const facts = await gitFacts(root);
  const changedPaths = filteredChangedPaths2(facts.changedPaths);
  const scopeViolations = changedPaths.filter(
    (file) => !matches(file, contract.allowedPaths)
  );
  const afterTreeHash = await treeHash(root, ignoredEvidence2);
  const started = Date.parse(session.createdAt);
  const durationMs = now.getTime() - started;
  if (!Number.isFinite(durationMs) || durationMs < 0)
    throw new RigorError("Attempt timestamps are invalid", EXIT.inputError);
  const status = scopeViolations.length > 0 ? "scope-violation" : durationMs > session.budget.maxDurationMs ? "budget-exceeded" : input.status;
  const failureFacts = verification?.failureFacts ?? [];
  const failureFingerprint = verification?.failureFingerprint ?? null;
  const failureCategory = aggregateCategory(failureFacts);
  const { finishedAttempts } = await attemptState(root, session.taskId);
  const prior = mostRecentPriorAttempt(finishedAttempts, session.sequence);
  let progress2;
  if (prior === null) {
    progress2 = {
      status: "first",
      comparedToAttemptArtifactId: null,
      weakeningSignals: []
    };
  } else {
    const comparedToAttemptArtifactId = textField(
      prior.artifactId,
      "prior attempt artifactId",
      128
    );
    const priorFailureFacts = Array.isArray(prior.failureFacts) ? prior.failureFacts : null;
    if (priorFailureFacts === null) {
      progress2 = {
        status: "incomparable",
        comparedToAttemptArtifactId,
        weakeningSignals: []
      };
    } else {
      const comparison = compareFailures(priorFailureFacts, failureFacts);
      progress2 = {
        status: comparison.status,
        comparedToAttemptArtifactId,
        weakeningSignals: comparison.weakeningSignals
      };
    }
  }
  const attempt = {
    schemaVersion: ATTEMPT_SCHEMA,
    artifactId: artifactId("attempt"),
    taskId: session.taskId,
    createdAt: now.toISOString(),
    sessionArtifactId: session.artifactId,
    sessionHash: hash(session),
    routingPlanArtifactId: session.routingPlanArtifactId,
    routingPlanHash: session.routingPlanHash,
    contractArtifactId: session.contractArtifactId,
    contractHash: session.contractHash,
    sequence: session.sequence,
    provider: session.provider,
    ...session.model === void 0 ? {} : { model: session.model },
    capabilityClass: session.capabilityClass,
    purpose: session.purpose,
    startedAt: session.createdAt,
    completedAt: now.toISOString(),
    durationMs,
    executionIdentityStatus: "unverified",
    status,
    beforeHead: session.beforeHead,
    afterHead: facts.head,
    beforeTreeHash: session.beforeTreeHash,
    afterTreeHash,
    changedPathsBefore: session.changedPathsBefore,
    changedPaths,
    scopeViolations,
    ...verification === void 0 ? {} : { verificationArtifactId: verification.artifactId },
    failureFingerprint,
    failureCategory,
    failureFacts,
    progress: progress2
  };
  for (const key of [
    "failureClass",
    "externalSessionId",
    "externalTurnId"
  ]) {
    const value = input[key];
    if (value !== void 0) attempt[key] = value;
  }
  const saved = await saveCollectionArtifact(
    root,
    session.taskId,
    "attempts",
    "attempt",
    attempt
  );
  return { attempt, saved };
}

// src/outcome.ts
function oneOf5(value, values, name) {
  if (typeof value !== "string" || !values.includes(value))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value;
}
function boolean(value, name) {
  if (typeof value !== "boolean")
    throw new RigorError(`${name} must be a boolean`, EXIT.inputError);
  return value;
}
function integer2(value, name, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new RigorError(`${name} is out of range`, EXIT.inputError);
  return value;
}
function finite(value, name, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new RigorError(`${name} is out of range`, EXIT.inputError);
  return value;
}
function reject(message) {
  throw new RigorError(message, EXIT.policyViolation);
}
function parseUsageInput(value) {
  const item = record(value, "usage");
  const usage = {
    status: oneOf5(
      item.status,
      ["recorded", "unavailable", "unknown"],
      "usage.status"
    )
  };
  if (item.inputTokens !== void 0)
    usage.inputTokens = integer2(item.inputTokens, "usage.inputTokens", 0, 1e12);
  if (item.outputTokens !== void 0)
    usage.outputTokens = integer2(
      item.outputTokens,
      "usage.outputTokens",
      0,
      1e12
    );
  if (item.totalTokens !== void 0)
    usage.totalTokens = integer2(item.totalTokens, "usage.totalTokens", 0, 1e12);
  if (item.reasoningEffort !== void 0)
    usage.reasoningEffort = textField(
      item.reasoningEffort,
      "usage.reasoningEffort",
      128
    );
  if (item.modelIdentity !== void 0)
    usage.modelIdentity = textField(
      item.modelIdentity,
      "usage.modelIdentity",
      256
    );
  if (item.providerCost !== void 0) {
    const cost = record(item.providerCost, "usage.providerCost");
    const currency = textField(cost.currency, "usage.providerCost.currency", 3);
    if (!/^[A-Z]{3}$/u.test(currency))
      throw new RigorError(
        "usage.providerCost.currency is invalid",
        EXIT.inputError
      );
    usage.providerCost = {
      currency,
      amount: finite(cost.amount, "usage.providerCost.amount", 0, 1e12)
    };
  }
  return usage;
}
function parseOutcomeInput(value) {
  const item = record(value, "outcome input");
  if (item.schemaVersion !== OUTCOME_INPUT_SCHEMA)
    throw new RigorError("Unsupported outcome input schema", EXIT.inputError);
  const findings2 = record(item.reviewFindings, "reviewFindings");
  const input = {
    schemaVersion: OUTCOME_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    decision: oneOf5(item.decision, ["accepted", "rejected"], "decision"),
    acceptedWithoutModelCodeChanges: boolean(
      item.acceptedWithoutModelCodeChanges,
      "acceptedWithoutModelCodeChanges"
    ),
    humanCorrectionMinutes: integer2(
      item.humanCorrectionMinutes,
      "humanCorrectionMinutes",
      0,
      1e5
    ),
    escalationCount: integer2(item.escalationCount, "escalationCount", 0, 100),
    reviewFindings: {
      critical: integer2(
        findings2.critical,
        "reviewFindings.critical",
        0,
        1e4
      ),
      high: integer2(findings2.high, "reviewFindings.high", 0, 1e4),
      medium: integer2(findings2.medium, "reviewFindings.medium", 0, 1e4),
      low: integer2(findings2.low, "reviewFindings.low", 0, 1e4)
    },
    revertStatus: oneOf5(
      item.revertStatus,
      ["none", "reverted"],
      "revertStatus"
    ),
    escapedDefectStatus: oneOf5(
      item.escapedDefectStatus,
      ["none", "suspected", "confirmed"],
      "escapedDefectStatus"
    ),
    usage: parseUsageInput(item.usage)
  };
  if (item.retryCount !== void 0)
    input.retryCount = integer2(item.retryCount, "retryCount", 0, 100);
  if (item.commit !== void 0) {
    const commit = textField(item.commit, "commit", 64);
    if (!/^[0-9a-f]{7,64}$/u.test(commit))
      throw new RigorError("commit is invalid", EXIT.inputError);
    input.commit = commit;
  }
  if (item.pullRequest !== void 0)
    input.pullRequest = textField(item.pullRequest, "pullRequest", 256);
  if (item.notes !== void 0) {
    if (!Array.isArray(item.notes) || item.notes.length > 100)
      throw new RigorError("notes must be an array", EXIT.inputError);
    input.notes = item.notes.map(
      (note, index) => textField(note, `notes[${index}]`, 2e3)
    );
  }
  return input;
}
function parseReviewArtifact(value) {
  const item = record(value, "review");
  if (item.schemaVersion !== REVIEW_SCHEMA)
    throw new RigorError("Unsupported review schema", EXIT.inputError);
  const review = {
    taskId: taskId(item.taskId),
    artifactId: textField(item.artifactId, "review.artifactId", 128)
  };
  if (item.verificationArtifactId !== void 0)
    review.verificationArtifactId = textField(
      item.verificationArtifactId,
      "review.verificationArtifactId",
      128
    );
  return review;
}
function createOutcome(input, links, now = /* @__PURE__ */ new Date()) {
  const { attempt, verification, review } = links;
  const task = input.taskId;
  if (attempt && attempt.taskId !== task)
    reject("Attempt taskId does not match the outcome");
  if (verification && verification.taskId !== task)
    reject("Verification taskId does not match the outcome");
  if (review && review.taskId !== task)
    reject("Review taskId does not match the outcome");
  if (input.decision === "rejected" && input.acceptedWithoutModelCodeChanges)
    reject("A rejected outcome cannot be accepted without model code changes");
  if (input.revertStatus === "reverted" && input.decision !== "accepted")
    reject("A reverted outcome must be accepted");
  if (input.escapedDefectStatus !== "none" && input.decision !== "accepted")
    reject("An escaped defect requires an accepted outcome");
  const linkage = {};
  let retryCount;
  if (attempt) {
    const derived = attempt.sequence - 1;
    if (input.retryCount !== void 0 && input.retryCount !== derived)
      reject("retryCount conflicts with the linked attempt");
    retryCount = derived;
    linkage.routingPlanArtifactId = attempt.routingPlanArtifactId;
    linkage.attemptArtifactId = attempt.artifactId;
    linkage.attemptSequence = attempt.sequence;
    linkage.attemptStatus = attempt.status;
    linkage.attemptDurationMs = attempt.durationMs;
    linkage.provider = attempt.provider;
    if (attempt.model !== void 0) linkage.model = attempt.model;
    linkage.capabilityClass = attempt.capabilityClass;
    if (input.decision === "accepted" && attempt.status !== "completed")
      reject("An accepted outcome requires a completed attempt");
  } else {
    if (input.retryCount === void 0)
      reject("retryCount is required without a linked attempt");
    retryCount = input.retryCount;
  }
  if (verification) {
    if (attempt && attempt.verificationArtifactId !== void 0 && verification.artifactId !== attempt.verificationArtifactId)
      reject("Verification does not match the attempt's linked verification");
    if (input.decision === "accepted" && verification.status !== "passed")
      reject("An accepted outcome requires a linked passing verification");
    linkage.verificationArtifactId = verification.artifactId;
    linkage.verificationStatus = verification.status;
  } else if (input.decision === "accepted") {
    reject("an accepted outcome requires a linked passing verification");
  }
  if (review) {
    linkage.reviewArtifactId = review.artifactId;
    if (review.verificationArtifactId !== void 0 && verification && review.verificationArtifactId !== verification.artifactId)
      reject("Review verification does not match the linked verification");
  }
  const u = input.usage;
  const measured = u.inputTokens !== void 0 || u.outputTokens !== void 0 || u.totalTokens !== void 0 || u.providerCost !== void 0 || u.reasoningEffort !== void 0;
  if (u.status !== "recorded") {
    if (measured) reject("Usage measurements are not available");
  } else if (u.inputTokens === void 0 && u.outputTokens === void 0 && u.providerCost === void 0) {
    reject("recorded usage requires at least one measured value");
  }
  if (u.totalTokens !== void 0) {
    if (u.inputTokens !== void 0 && u.totalTokens < u.inputTokens)
      reject("token totals are inconsistent");
    if (u.outputTokens !== void 0 && u.totalTokens < u.outputTokens)
      reject("token totals are inconsistent");
    if (u.inputTokens !== void 0 && u.outputTokens !== void 0 && u.totalTokens !== u.inputTokens + u.outputTokens)
      reject("token totals are inconsistent");
  }
  if (input.commit !== void 0) linkage.commit = input.commit;
  if (input.pullRequest !== void 0) linkage.pullRequest = input.pullRequest;
  const findings2 = input.reviewFindings;
  const outcome = {
    schemaVersion: OUTCOME_SCHEMA,
    artifactId: artifactId("outcome"),
    taskId: task,
    createdAt: now.toISOString(),
    decision: input.decision,
    acceptedWithoutModelCodeChanges: input.acceptedWithoutModelCodeChanges,
    humanCorrectionMinutes: input.humanCorrectionMinutes,
    escalationCount: input.escalationCount,
    retryCount,
    reviewFindings: {
      ...findings2,
      total: findings2.critical + findings2.high + findings2.medium + findings2.low
    },
    revertStatus: input.revertStatus,
    escapedDefectStatus: input.escapedDefectStatus,
    executionIdentityStatus: "unverified",
    ...linkage,
    usage: {
      status: u.status,
      inputTokens: u.inputTokens ?? null,
      outputTokens: u.outputTokens ?? null,
      totalTokens: u.totalTokens ?? null,
      reasoningEffort: u.reasoningEffort ?? null,
      providerCost: u.providerCost ?? null,
      modelIdentity: u.modelIdentity === void 0 ? null : { value: u.modelIdentity, attestation: "unverified" }
    },
    notes: input.notes ?? []
  };
  return outcome;
}

// src/escalation.ts
var INITIAL_ESCALATION_THRESHOLDS = {
  unchangedAttemptsBeforeDirect: 2,
  infrastructureRetries: 2
};
var capabilities2 = [
  "economy",
  "standard",
  "premium",
  "frontier"
];
var failures = [
  "implementation",
  "infrastructure",
  "timeout",
  "flaky",
  "mixed"
];
var progressStatuses = [
  "first",
  "unchanged",
  "reduced",
  "expanded",
  "incomparable"
];
var risks = ["low", "medium", "high", "critical"];
var purposes3 = [
  "implementation",
  "consultation",
  "review",
  "adversarial-review",
  "rescue"
];
function oneOf6(value, allowed, name) {
  if (typeof value !== "string" || !allowed.includes(value))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value;
}
function integer3(value, name, minimum = 0, maximum = 1e9) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new RigorError(`${name} is out of range`, EXIT.inputError);
  return value;
}
function bool3(value, name) {
  if (typeof value !== "boolean")
    throw new RigorError(`${name} must be boolean`, EXIT.inputError);
  return value;
}
function digest(value, name) {
  const result = textField(value, name, 128);
  if (!/^[a-f0-9]{64}$/u.test(result))
    throw new RigorError(`${name} must be a SHA-256 digest`, EXIT.inputError);
  return result;
}
function attemptFact(value, name) {
  const item = record(value, name);
  const failureFingerprint = item.failureFingerprint;
  if (failureFingerprint !== null)
    digest(failureFingerprint, `${name}.failureFingerprint`);
  return {
    artifactId: textField(item.artifactId, `${name}.artifactId`, 128),
    artifactHash: digest(item.artifactHash, `${name}.artifactHash`),
    routingPlanArtifactId: textField(
      item.routingPlanArtifactId,
      `${name}.routingPlanArtifactId`,
      128
    ),
    routingPlanHash: digest(item.routingPlanHash, `${name}.routingPlanHash`),
    sequence: integer3(item.sequence, `${name}.sequence`, 1, 20),
    capabilityClass: oneOf6(
      item.capabilityClass,
      capabilities2,
      `${name}.capabilityClass`
    ),
    failureCategory: oneOf6(
      item.failureCategory,
      failures,
      `${name}.failureCategory`
    ),
    progress: oneOf6(item.progress, progressStatuses, `${name}.progress`),
    failureFingerprint,
    durationMs: integer3(item.durationMs, `${name}.durationMs`),
    relativeCost: integer3(item.relativeCost, `${name}.relativeCost`, 0)
  };
}
function parseEscalationDecisionInput(value) {
  const item = record(value, "escalation decision input");
  if (item.schemaVersion !== ESCALATION_DECISION_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported escalation decision input schema",
      EXIT.inputError
    );
  const contract = record(item.contract, "contract");
  const plan = record(item.routingPlan, "routingPlan");
  const budget = record(item.budget, "budget");
  const concerns = record(item.concerns, "concerns");
  const rawThresholds = item.thresholds === void 0 ? INITIAL_ESCALATION_THRESHOLDS : record(item.thresholds, "thresholds");
  if (!Array.isArray(item.previousAttempts))
    throw new RigorError("previousAttempts must be an array", EXIT.inputError);
  const previousAttempts = item.previousAttempts.map(
    (attempt, index) => attemptFact(attempt, `previousAttempts[${index}]`)
  );
  const currentAttempt = attemptFact(item.currentAttempt, "currentAttempt");
  const result = {
    schemaVersion: ESCALATION_DECISION_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    purpose: oneOf6(item.purpose, purposes3, "purpose"),
    contract: {
      artifactId: textField(contract.artifactId, "contract.artifactId", 128),
      artifactHash: digest(contract.artifactHash, "contract.artifactHash")
    },
    routingPlan: {
      artifactId: textField(plan.artifactId, "routingPlan.artifactId", 128),
      artifactHash: digest(plan.artifactHash, "routingPlan.artifactHash"),
      modelProfilesHash: digest(
        plan.modelProfilesHash,
        "routingPlan.modelProfilesHash"
      )
    },
    currentAttempt,
    previousAttempts,
    riskTier: oneOf6(item.riskTier, risks, "riskTier"),
    externalTransmission: oneOf6(
      item.externalTransmission,
      ["allowed", "denied"],
      "externalTransmission"
    ),
    failureCategory: oneOf6(item.failureCategory, failures, "failureCategory"),
    progress: oneOf6(item.progress, progressStatuses, "progress"),
    fingerprintRepetitions: integer3(
      item.fingerprintRepetitions,
      "fingerprintRepetitions",
      0,
      20
    ),
    currentCapabilityClass: oneOf6(
      item.currentCapabilityClass,
      capabilities2,
      "currentCapabilityClass"
    ),
    attemptCount: integer3(item.attemptCount, "attemptCount", 1, 20),
    elapsedMs: integer3(item.elapsedMs, "elapsedMs"),
    consumedRelativeCost: integer3(
      item.consumedRelativeCost,
      "consumedRelativeCost"
    ),
    budget: {
      maxAttempts: integer3(budget.maxAttempts, "budget.maxAttempts", 1, 20),
      maxDurationMs: integer3(
        budget.maxDurationMs,
        "budget.maxDurationMs",
        1e3
      ),
      maxRelativeCost: integer3(
        budget.maxRelativeCost,
        "budget.maxRelativeCost",
        1
      )
    },
    concerns: {
      requirementsChangeRequired: bool3(
        concerns.requirementsChangeRequired,
        "concerns.requirementsChangeRequired"
      ),
      acceptanceCriteriaChangeRequired: bool3(
        concerns.acceptanceCriteriaChangeRequired,
        "concerns.acceptanceCriteriaChangeRequired"
      ),
      humanOnlyDecision: bool3(
        concerns.humanOnlyDecision,
        "concerns.humanOnlyDecision"
      ),
      scopeViolation: bool3(concerns.scopeViolation, "concerns.scopeViolation"),
      protectedTestMutation: bool3(
        concerns.protectedTestMutation,
        "concerns.protectedTestMutation"
      ),
      configuredCheckRemoval: bool3(
        concerns.configuredCheckRemoval,
        "concerns.configuredCheckRemoval"
      ),
      configuredCheckWeakening: bool3(
        concerns.configuredCheckWeakening,
        "concerns.configuredCheckWeakening"
      ),
      security: bool3(concerns.security, "concerns.security"),
      dataIntegrity: bool3(concerns.dataIntegrity, "concerns.dataIntegrity"),
      architectureChange: bool3(
        concerns.architectureChange,
        "concerns.architectureChange"
      ),
      contractContradiction: bool3(
        concerns.contractContradiction,
        "concerns.contractContradiction"
      )
    },
    thresholds: {
      unchangedAttemptsBeforeDirect: integer3(
        rawThresholds.unchangedAttemptsBeforeDirect,
        "thresholds.unchangedAttemptsBeforeDirect",
        2,
        20
      ),
      infrastructureRetries: integer3(
        rawThresholds.infrastructureRetries,
        "thresholds.infrastructureRetries",
        0,
        20
      )
    },
    speculation: strings(item.speculation, "speculation", 100)
  };
  validateConsistency(result);
  return result;
}
function validateConsistency(input) {
  if (input.currentAttempt.routingPlanArtifactId !== input.routingPlan.artifactId || input.currentAttempt.routingPlanHash !== input.routingPlan.artifactHash)
    throw new RigorError(
      "currentAttempt is not linked to routingPlan",
      EXIT.inputError
    );
  const attempts = [...input.previousAttempts, input.currentAttempt];
  for (let index = 0; index < attempts.length; index += 1) {
    if (attempts[index]?.sequence !== index + 1)
      throw new RigorError(
        "Attempt sequence is stale or inconsistent",
        EXIT.inputError
      );
  }
  const elapsedMs = attempts.reduce(
    (sum, attempt) => sum + attempt.durationMs,
    0
  );
  const relativeCost = attempts.reduce(
    (sum, attempt) => sum + attempt.relativeCost,
    0
  );
  if (input.attemptCount !== attempts.length || input.elapsedMs !== elapsedMs || input.consumedRelativeCost !== relativeCost || input.currentCapabilityClass !== input.currentAttempt.capabilityClass || input.failureCategory !== input.currentAttempt.failureCategory || input.progress !== input.currentAttempt.progress)
    throw new RigorError(
      "Escalation facts are stale or inconsistent",
      EXIT.inputError
    );
  const matching = attempts.filter(
    (attempt) => input.currentAttempt.failureFingerprint !== null && attempt.failureFingerprint === input.currentAttempt.failureFingerprint
  ).length;
  if (input.fingerprintRepetitions !== matching)
    throw new RigorError(
      "fingerprintRepetitions is stale or inconsistent",
      EXIT.inputError
    );
}
function validateEscalationArtifacts(input, contract, plans, attempts) {
  const plansById = new Map(plans.map((plan) => [plan.artifactId, plan]));
  const currentPlan = plansById.get(input.routingPlan.artifactId);
  if (contract.taskId !== input.taskId || currentPlan === void 0 || currentPlan.taskId !== input.taskId || input.contract.artifactId !== contract.artifactId || input.contract.artifactHash !== hash(contract) || input.routingPlan.artifactHash !== hash(currentPlan) || input.routingPlan.modelProfilesHash !== currentPlan.modelProfilesHash || currentPlan.contractArtifactId !== contract.artifactId || currentPlan.contractHash !== hash(contract) || input.budget.maxAttempts !== currentPlan.budget.maxAttempts || input.budget.maxDurationMs !== currentPlan.budget.maxDurationMs || input.budget.maxRelativeCost !== currentPlan.budget.maxRelativeCost)
    throw new RigorError(
      "Linked escalation artifacts are stale or inconsistent",
      EXIT.inputError
    );
  const expected = [...input.previousAttempts, input.currentAttempt];
  if (attempts.length !== expected.length)
    throw new RigorError("Attempt artifact set is incomplete", EXIT.inputError);
  for (let index = 0; index < expected.length; index += 1) {
    const actual = attempts[index];
    const fact = expected[index];
    const linkedPlan = fact === void 0 ? void 0 : plansById.get(fact.routingPlanArtifactId);
    if (actual === void 0 || fact === void 0 || linkedPlan === void 0 || linkedPlan.selection === null || linkedPlan.taskId !== input.taskId || linkedPlan.contractArtifactId !== contract.artifactId || linkedPlan.contractHash !== hash(contract) || fact.routingPlanHash !== hash(linkedPlan) || fact.relativeCost !== linkedPlan.selection.relativeCost || actual.taskId !== input.taskId || actual.artifactId !== fact.artifactId || hash(actual) !== fact.artifactHash || actual.routingPlanArtifactId !== fact.routingPlanArtifactId || actual.routingPlanHash !== fact.routingPlanHash || actual.sequence !== fact.sequence || actual.capabilityClass !== fact.capabilityClass || actual.failureCategory !== fact.failureCategory || (actual.progress?.status ?? "first") !== fact.progress || (actual.failureFingerprint ?? null) !== fact.failureFingerprint || actual.durationMs !== fact.durationMs)
      throw new RigorError(
        "Attempt artifact is stale or inconsistent",
        EXIT.inputError
      );
  }
}
function stop(input, profiles, availability2, decision2, reasonCode) {
  return baseDecision(input, profiles, availability2, {
    decision: decision2,
    reasonCode,
    target: null,
    selection: null,
    eligible: [],
    excluded: []
  });
}
function baseDecision(input, profiles, availability2, result) {
  return {
    schemaVersion: ESCALATION_DECISION_SCHEMA,
    taskId: input.taskId,
    inputHash: hash(input),
    modelProfilesHash: hash(profiles),
    availabilityReportHash: availability2 === void 0 ? null : hash(availability2),
    decision: result.decision,
    reasonCode: result.reasonCode,
    targetCapabilityClass: result.target,
    selection: result.selection,
    eligibleCandidates: result.eligible,
    excludedCandidates: result.excluded,
    budget: {
      attemptCount: input.attemptCount,
      maxAttempts: input.budget.maxAttempts,
      elapsedMs: input.elapsedMs,
      maxDurationMs: input.budget.maxDurationMs,
      consumedRelativeCost: input.consumedRelativeCost,
      remainingRelativeCost: input.budget.maxRelativeCost - input.consumedRelativeCost,
      maxRelativeCost: input.budget.maxRelativeCost
    },
    facts: {
      failureCategory: input.failureCategory,
      progress: input.progress,
      fingerprintRepetitions: input.fingerprintRepetitions,
      riskTier: input.riskTier,
      currentCapabilityClass: input.currentCapabilityClass,
      concerns: input.concerns
    },
    speculation: input.speculation
  };
}
function desiredClass(input) {
  const currentIndex = capabilities2.indexOf(input.currentCapabilityClass);
  if (input.progress === "reduced" || input.failureCategory === "flaky")
    return {
      decision: "retry-current",
      reasonCode: input.progress === "reduced" ? "FAILURE_SET_REDUCED" : "FLAKY_RETRY",
      target: input.currentCapabilityClass
    };
  const direct = input.concerns.contractContradiction || input.concerns.security || input.concerns.dataIntegrity || input.concerns.architectureChange || input.progress === "unchanged" && input.fingerprintRepetitions >= input.thresholds.unchangedAttemptsBeforeDirect;
  if (direct) {
    const frontier = input.riskTier === "critical" || input.concerns.security || input.concerns.dataIntegrity || input.concerns.architectureChange;
    const targetIndex = Math.max(frontier ? 3 : 2, currentIndex + 1);
    return {
      decision: "escalate-direct",
      reasonCode: input.concerns.contractContradiction ? "CONTRACT_CONTRADICTION" : input.concerns.architectureChange ? "ARCHITECTURE_CHANGE" : input.concerns.security || input.concerns.dataIntegrity ? "SAFETY_CONCERN" : "REPEATED_UNCHANGED_FAILURE",
      target: capabilities2[targetIndex] ?? null
    };
  }
  return {
    decision: "escalate-adjacent",
    reasonCode: input.progress === "expanded" ? "FAILURE_SET_EXPANDED" : input.progress === "incomparable" ? "FAILURE_SET_INCOMPARABLE" : "ORDINARY_IMPLEMENTATION_DEFECT",
    target: capabilities2[currentIndex + 1] ?? null
  };
}
function exclusionReason2(candidate, input, target, availability2) {
  if (!candidate.enabled) return "DISABLED";
  if (!candidate.purposes.includes(input.purpose)) return "PURPOSE_UNSUPPORTED";
  if (candidate.requiresAdditionalExternalTransmission && input.externalTransmission === "denied")
    return "EXTERNAL_TRANSMISSION_DENIED";
  if (availability2.get(candidate.id) === "unavailable") return "UNAVAILABLE";
  if (availability2.get(candidate.id) === "incompatible") return "INCOMPATIBLE";
  if (candidate.capabilityClass !== target) return "CAPABILITY_NOT_SELECTED";
  if (input.consumedRelativeCost + candidate.relativeCost > input.budget.maxRelativeCost)
    return "BUDGET_EXCEEDED";
  return null;
}
function selectEscalation(input, profiles, availability2) {
  if (input.routingPlan.modelProfilesHash !== hash(profiles) || availability2 !== void 0 && availability2.modelProfilesHash !== hash(profiles))
    throw new RigorError(
      "Profiles or availability are stale or inconsistent",
      EXIT.inputError
    );
  if (input.concerns.scopeViolation || input.concerns.protectedTestMutation || input.concerns.configuredCheckRemoval || input.concerns.configuredCheckWeakening)
    return stop(
      input,
      profiles,
      availability2,
      "stop-policy-violation",
      input.concerns.scopeViolation ? "SCOPE_VIOLATION" : input.concerns.protectedTestMutation ? "PROTECTED_TEST_MUTATION" : input.concerns.configuredCheckRemoval ? "CONFIGURED_CHECK_REMOVAL" : "CONFIGURED_CHECK_WEAKENING"
    );
  if (input.concerns.requirementsChangeRequired || input.concerns.acceptanceCriteriaChangeRequired || input.concerns.humanOnlyDecision)
    return stop(
      input,
      profiles,
      availability2,
      "stop-human-decision",
      input.concerns.requirementsChangeRequired ? "REQUIREMENTS_CHANGE_REQUIRED" : input.concerns.acceptanceCriteriaChangeRequired ? "ACCEPTANCE_CRITERIA_CHANGE_REQUIRED" : "HUMAN_ONLY_DECISION"
    );
  if (input.attemptCount >= input.budget.maxAttempts || input.elapsedMs >= input.budget.maxDurationMs || input.consumedRelativeCost >= input.budget.maxRelativeCost)
    return stop(
      input,
      profiles,
      availability2,
      "stop-budget-exhausted",
      input.attemptCount >= input.budget.maxAttempts ? "MAX_ATTEMPTS_EXHAUSTED" : input.elapsedMs >= input.budget.maxDurationMs ? "MAX_DURATION_EXHAUSTED" : "MAX_RELATIVE_COST_EXHAUSTED"
    );
  if (input.failureCategory === "infrastructure" || input.failureCategory === "timeout") {
    const stopInfrastructure = input.fingerprintRepetitions > input.thresholds.infrastructureRetries;
    return stop(
      input,
      profiles,
      availability2,
      stopInfrastructure ? "stop-infrastructure" : "retry-infrastructure",
      input.failureCategory === "timeout" ? stopInfrastructure ? "TIMEOUT_RETRY_LIMIT" : "TIMEOUT_RETRY" : stopInfrastructure ? "INFRASTRUCTURE_RETRY_LIMIT" : "INFRASTRUCTURE_RETRY"
    );
  }
  const desired = desiredClass(input);
  if (desired.target === null)
    return stop(
      input,
      profiles,
      availability2,
      "stop-no-eligible-candidate",
      "NO_HIGHER_CAPABILITY_CLASS"
    );
  const availabilityStates2 = new Map(
    availability2?.candidates.map((candidate) => [
      candidate.candidateId,
      candidate.state
    ]) ?? []
  );
  const eligible = [];
  const excluded = [];
  for (const candidate of profiles.candidates) {
    const reasonCode = exclusionReason2(
      candidate,
      input,
      desired.target,
      availabilityStates2
    );
    if (reasonCode === null) eligible.push(candidate);
    else excluded.push({ candidateId: candidate.id, reasonCode });
  }
  eligible.sort(
    (left, right) => capabilities2.indexOf(left.capabilityClass) - capabilities2.indexOf(right.capabilityClass) || left.relativeCost - right.relativeCost || left.id.localeCompare(right.id)
  );
  const selected = eligible[0];
  if (selected === void 0)
    return baseDecision(input, profiles, availability2, {
      decision: "stop-no-eligible-candidate",
      reasonCode: "NO_ELIGIBLE_CANDIDATE",
      target: desired.target,
      selection: null,
      eligible: [],
      excluded
    });
  return baseDecision(input, profiles, availability2, {
    decision: desired.decision,
    reasonCode: desired.reasonCode,
    target: desired.target,
    selection: {
      candidateId: selected.id,
      provider: selected.provider,
      ...selected.model === void 0 ? {} : { model: selected.model },
      capabilityClass: selected.capabilityClass,
      relativeCost: selected.relativeCost
    },
    eligible: eligible.map((candidate) => candidate.id),
    excluded
  });
}

// src/evaluation.ts
var import_promises9 = require("node:fs/promises");
var import_node_path10 = __toESM(require("node:path"), 1);
var CAPABILITY_CLASSES = [
  "economy",
  "standard",
  "premium",
  "frontier"
];
var SPLITS = ["calibration", "holdout"];
var PROPOSAL_TARGETS = [
  "model-profiles",
  "escalation-thresholds",
  "routing-heuristic-constant"
];
var OVER_ROUTING_DEFINITION = "Accepted on the first attempt (retryCount 0, escalationCount 0) with zero review findings at a capability class above economy, so a lower class may have sufficed. A reviewable heuristic count, not a verdict.";
var UNDER_ROUTING_DEFINITION = "An outcome at the routed capability class that was rejected, escalated (escalationCount > 0), or produced an expanded failure set. A reviewable heuristic count, not a verdict.";
function oneOf7(value, values, name) {
  if (typeof value !== "string" || !values.includes(value))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value;
}
function integer4(value, name, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new RigorError(`${name} is out of range`, EXIT.inputError);
  return value;
}
function optionalString2(value) {
  return typeof value === "string" ? value : null;
}
function optionalNumber2(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
var USAGE_STATUSES = ["recorded", "unavailable", "unknown"];
var ESCAPED_STATUSES = ["none", "suspected", "confirmed"];
var PROGRESS_STATUSES = [
  "first",
  "unchanged",
  "reduced",
  "expanded",
  "incomparable"
];
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function numericFieldOk(value) {
  return value === void 0 || isFiniteNumber(value);
}
function requiredNumericFieldOk(value) {
  return isFiniteNumber(value);
}
function isRecord3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nullableRecordOk(value, shapeOk) {
  return value === void 0 || value === null || isRecord3(value) && shapeOk(value);
}
function isModelIdentityShape(value) {
  return typeof value.value === "string" && value.attestation === "unverified";
}
function isProviderCostShape(value) {
  return typeof value.currency === "string" && /^[A-Z]{3}$/u.test(value.currency) && isFiniteNumber(value.amount) && value.amount >= 0;
}
function outcomeFieldsWellFormed(o) {
  if (o.decision !== "accepted" && o.decision !== "rejected") return false;
  if (!requiredNumericFieldOk(o.retryCount) || !requiredNumericFieldOk(o.escalationCount) || !requiredNumericFieldOk(o.humanCorrectionMinutes))
    return false;
  if (!numericFieldOk(o.attemptDurationMs)) return false;
  if (o.provider !== void 0 && typeof o.provider !== "string") return false;
  if (o.model !== void 0 && typeof o.model !== "string") return false;
  if (o.capabilityClass !== void 0 && o.capabilityClass !== null && !(typeof o.capabilityClass === "string" && CAPABILITY_CLASSES.includes(o.capabilityClass)))
    return false;
  if (!isRecord3(o.reviewFindings) || !requiredNumericFieldOk(o.reviewFindings.total))
    return false;
  if (!isRecord3(o.usage)) return false;
  if (typeof o.usage.status !== "string" || !USAGE_STATUSES.includes(o.usage.status))
    return false;
  if (!nullableRecordOk(o.usage.modelIdentity, isModelIdentityShape))
    return false;
  if (!nullableRecordOk(o.usage.providerCost, isProviderCostShape))
    return false;
  if (typeof o.escapedDefectStatus !== "string" || !ESCAPED_STATUSES.includes(o.escapedDefectStatus))
    return false;
  return true;
}
function attemptFieldsWellFormed(a) {
  if (typeof a.routingPlanArtifactId !== "string") return false;
  if (a.progress !== void 0 && a.progress !== null) {
    if (!isRecord3(a.progress)) return false;
    if (a.progress.status !== void 0 && !PROGRESS_STATUSES.includes(a.progress.status))
      return false;
  }
  return true;
}
function planFieldsWellFormed(p) {
  if (typeof p.artifactId !== "string") return false;
  if (p.selection !== void 0 && p.selection !== null) {
    if (!isRecord3(p.selection)) return false;
    if (p.selection.relativeCost !== void 0 && !(typeof p.selection.relativeCost === "number" && Number.isFinite(p.selection.relativeCost)))
      return false;
  }
  return true;
}
function parseEvaluationManifest(value) {
  const item = record(value, "evaluation manifest");
  if (item.schemaVersion !== EVALUATION_MANIFEST_SCHEMA)
    throw new RigorError(
      "Unsupported evaluation manifest schema",
      EXIT.inputError
    );
  const categories = strings(item.categories, "categories", 32);
  if (categories.length === 0)
    throw new RigorError("categories must not be empty", EXIT.inputError);
  if (new Set(categories).size !== categories.length)
    throw new RigorError("categories must be unique", EXIT.inputError);
  if (!Array.isArray(item.tasks) || item.tasks.length === 0)
    throw new RigorError("tasks must be a non-empty array", EXIT.inputError);
  if (item.tasks.length > 100)
    throw new RigorError("tasks must not exceed 100 entries", EXIT.inputError);
  const categorySet = new Set(categories);
  const seen = /* @__PURE__ */ new Set();
  const tasks = item.tasks.map((raw, index) => {
    const entry = record(raw, `tasks[${index}]`);
    const id = taskId(entry.taskId);
    if (seen.has(id))
      throw new RigorError(
        `Duplicate task id in manifest: ${id}`,
        EXIT.inputError
      );
    seen.add(id);
    const category = textField(entry.category, `tasks[${index}].category`, 128);
    if (!categorySet.has(category))
      throw new RigorError(
        `tasks[${index}].category is not declared in categories`,
        EXIT.inputError
      );
    const task = {
      taskId: id,
      category,
      split: oneOf7(entry.split, SPLITS, `tasks[${index}].split`),
      source: textField(entry.source, `tasks[${index}].source`, 2e3)
    };
    if (entry.fixtureRef !== void 0) {
      const ref = textField(
        entry.fixtureRef,
        `tasks[${index}].fixtureRef`,
        1024
      );
      if (ref.startsWith("/") || ref.split(/[\\/]/u).includes(".."))
        throw new RigorError(
          `tasks[${index}].fixtureRef must be a repository-relative path`,
          EXIT.inputError
        );
      task.fixtureRef = ref;
    }
    if (entry.crossModelComparison !== void 0) {
      if (typeof entry.crossModelComparison !== "boolean")
        throw new RigorError(
          `tasks[${index}].crossModelComparison must be boolean`,
          EXIT.inputError
        );
      task.crossModelComparison = entry.crossModelComparison;
    }
    return task;
  });
  return {
    schemaVersion: EVALUATION_MANIFEST_SCHEMA,
    manifestVersion: integer4(
      item.manifestVersion,
      "manifestVersion",
      1,
      1e5
    ),
    createdAt: textField(item.createdAt, "createdAt", 128),
    owner: textField(item.owner, "owner", 256),
    reviewInterval: textField(item.reviewInterval, "reviewInterval", 256),
    categories,
    expansionPolicy: textField(item.expansionPolicy, "expansionPolicy", 4e3),
    tasks
  };
}
function parseCalibrationProposalInput(value) {
  const item = record(value, "calibration proposal");
  if (item.schemaVersion !== CALIBRATION_PROPOSAL_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported calibration proposal input schema",
      EXIT.inputError
    );
  if (item.status !== "proposed")
    throw new RigorError(
      'A calibration proposal status must be exactly "proposed"',
      EXIT.inputError
    );
  if (item.approvalEffect !== "none")
    throw new RigorError(
      'A calibration proposal approvalEffect must be exactly "none"',
      EXIT.inputError
    );
  const evidence = record(item.evidence, "evidence");
  const reportHashes = strings(
    evidence.reportHashes,
    "evidence.reportHashes",
    100
  );
  if (reportHashes.length === 0)
    throw new RigorError(
      "evidence.reportHashes must not be empty",
      EXIT.inputError
    );
  for (const [index, digest2] of reportHashes.entries())
    if (!/^[a-f0-9]{64}$/u.test(digest2))
      throw new RigorError(
        `evidence.reportHashes[${index}] must be a SHA-256 digest`,
        EXIT.inputError
      );
  const taskIds = Array.isArray(evidence.taskIds) ? evidence.taskIds : void 0;
  if (taskIds === void 0 || taskIds.length === 0 || taskIds.length > 100)
    throw new RigorError(
      "evidence.taskIds must be a non-empty array",
      EXIT.inputError
    );
  const resolvedTaskIds = taskIds.map((raw) => taskId(raw));
  let replayHash = null;
  if (evidence.replayHash !== void 0 && evidence.replayHash !== null) {
    replayHash = textField(evidence.replayHash, "evidence.replayHash", 128);
    if (!/^[a-f0-9]{64}$/u.test(replayHash))
      throw new RigorError(
        "evidence.replayHash must be a SHA-256 digest",
        EXIT.inputError
      );
  }
  const expectedTradeOffs = strings(
    item.expectedTradeOffs,
    "expectedTradeOffs",
    50
  );
  if (expectedTradeOffs.length === 0)
    throw new RigorError(
      "expectedTradeOffs must not be empty",
      EXIT.inputError
    );
  const rollbackCriteria = strings(
    item.rollbackCriteria,
    "rollbackCriteria",
    50
  );
  if (rollbackCriteria.length === 0)
    throw new RigorError("rollbackCriteria must not be empty", EXIT.inputError);
  let holdoutFinalEvaluation = false;
  if (item.holdoutFinalEvaluation !== void 0) {
    if (typeof item.holdoutFinalEvaluation !== "boolean")
      throw new RigorError(
        "holdoutFinalEvaluation must be a boolean",
        EXIT.inputError
      );
    holdoutFinalEvaluation = item.holdoutFinalEvaluation;
  }
  return {
    schemaVersion: CALIBRATION_PROPOSAL_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    target: oneOf7(item.target, PROPOSAL_TARGETS, "target"),
    summary: textField(item.summary, "summary", 2e3),
    evidence: { reportHashes, taskIds: resolvedTaskIds, replayHash },
    proposedChange: textField(item.proposedChange, "proposedChange", 4e3),
    expectedTradeOffs,
    rollbackCriteria,
    status: "proposed",
    approvalEffect: "none",
    holdoutFinalEvaluation
  };
}
function createCalibrationProposal(input, manifest, now = /* @__PURE__ */ new Date()) {
  const splitByTask = /* @__PURE__ */ new Map();
  for (const task of manifest.tasks) splitByTask.set(task.taskId, task.split);
  const evidenceTaskSplits = input.evidence.taskIds.map((id) => {
    const split = splitByTask.get(id);
    if (split === void 0)
      throw new RigorError(
        `evidence task ${id} is not present in the cross-checked manifest`,
        EXIT.inputError
      );
    if (split === "holdout" && !input.holdoutFinalEvaluation)
      throw new RigorError(
        `evidence task ${id} is a holdout task; set holdoutFinalEvaluation to cite it as a final evaluation`,
        EXIT.inputError
      );
    return { taskId: id, split };
  });
  const provenance = {
    manifestHash: hash(manifest),
    manifestVersion: manifest.manifestVersion,
    holdoutFinalEvaluation: input.holdoutFinalEvaluation,
    evidenceTaskSplits
  };
  return {
    schemaVersion: CALIBRATION_PROPOSAL_SCHEMA,
    artifactId: artifactId("calibration-proposal"),
    taskId: input.taskId,
    createdAt: now.toISOString(),
    target: input.target,
    summary: input.summary,
    evidence: input.evidence,
    proposedChange: input.proposedChange,
    expectedTradeOffs: input.expectedTradeOffs,
    rollbackCriteria: input.rollbackCriteria,
    status: "proposed",
    approvalEffect: "none",
    provenance
  };
}
function verifyCalibrationEvidence(evidence, manifest, reports) {
  if (reports.length === 0)
    throw new RigorError(
      "At least one --report is required to verify cited evidence",
      EXIT.inputError
    );
  const manifestHash = hash(manifest);
  const parsed = reports.map((raw, index) => {
    const item = record(raw, `--report[${index}]`);
    if (item.schemaVersion !== EVALUATION_REPORT_SCHEMA && item.schemaVersion !== EVALUATION_REPLAY_SCHEMA)
      throw new RigorError(
        `--report[${index}] is not a rigor.evaluation-report.v1 or rigor.evaluation-replay.v1 document`,
        EXIT.inputError
      );
    const reportManifest = record(item.manifest, `--report[${index}].manifest`);
    if (reportManifest.hash !== manifestHash)
      throw new RigorError(
        `--report[${index}].manifest.hash does not match the selected --manifest`,
        EXIT.inputError
      );
    return { schemaVersion: item.schemaVersion, digest: hash(item) };
  });
  for (const digest2 of evidence.reportHashes) {
    const backed = parsed.some(
      (item) => item.schemaVersion === EVALUATION_REPORT_SCHEMA && item.digest === digest2
    );
    if (!backed)
      throw new RigorError(
        `evidence.reportHashes entry ${digest2} is not the canonical hash of any supplied --report file`,
        EXIT.inputError
      );
  }
  if (evidence.replayHash !== null) {
    const backed = parsed.some(
      (item) => item.schemaVersion === EVALUATION_REPLAY_SCHEMA && item.digest === evidence.replayHash
    );
    if (!backed)
      throw new RigorError(
        "evidence.replayHash is not the canonical hash of any supplied --report file",
        EXIT.inputError
      );
  }
}
async function containedInRoot(root, target) {
  try {
    await assertContainedPath(root, target);
    return true;
  } catch (error) {
    if (error instanceof RigorError) return false;
    throw error;
  }
}
async function readRecord(root, file) {
  if (!await containedInRoot(root, file))
    throw new RigorError("Path escapes the evidence root", EXIT.inputError);
  let text;
  try {
    text = await (0, import_promises9.readFile)(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new RigorError("Not an object", EXIT.inputError);
  return parsed;
}
async function readCollection(root, directory, schemaVersion, wellFormed) {
  if (!await containedInRoot(root, directory))
    return { valid: [], malformed: 1 };
  let names;
  try {
    names = await (0, import_promises9.readdir)(directory);
  } catch (error) {
    if (error.code === "ENOENT")
      return { valid: [], malformed: 0 };
    throw error;
  }
  const valid = [];
  let malformed = 0;
  for (const name of names.filter((file) => file.endsWith(".json")).sort()) {
    try {
      const parsed = await readRecord(root, import_node_path10.default.join(directory, name));
      if (parsed === void 0 || parsed.schemaVersion !== schemaVersion || !wellFormed(parsed))
        malformed += 1;
      else valid.push(parsed);
    } catch {
      malformed += 1;
    }
  }
  return { valid, malformed };
}
async function loadTask(root, task) {
  const directory = import_node_path10.default.join(root, task);
  if (!await containedInRoot(root, directory))
    return {
      outcome: null,
      outcomeAbsent: false,
      outcomeMalformed: true,
      attempts: [],
      malformedAttempts: 0,
      plans: /* @__PURE__ */ new Map(),
      planList: [],
      malformedPlans: 0
    };
  let outcome = null;
  let outcomeAbsent = false;
  let outcomeMalformed = false;
  try {
    const parsed = await readRecord(root, import_node_path10.default.join(directory, "outcome.json"));
    if (parsed === void 0) outcomeAbsent = true;
    else if (parsed.schemaVersion !== OUTCOME_SCHEMA || !outcomeFieldsWellFormed(parsed))
      outcomeMalformed = true;
    else outcome = parsed;
  } catch {
    outcomeMalformed = true;
  }
  const attempts = await readCollection(
    root,
    import_node_path10.default.join(directory, "attempts"),
    ATTEMPT_SCHEMA,
    attemptFieldsWellFormed
  );
  const plans = await readCollection(
    root,
    import_node_path10.default.join(directory, "routing"),
    ROUTING_PLAN_SCHEMA,
    planFieldsWellFormed
  );
  const planMap = /* @__PURE__ */ new Map();
  for (const plan of plans.valid) {
    const id = optionalString2(plan.artifactId);
    if (id !== null) planMap.set(id, plan);
  }
  return {
    outcome,
    outcomeAbsent,
    outcomeMalformed,
    attempts: attempts.valid,
    malformedAttempts: attempts.malformed,
    plans: planMap,
    planList: plans.valid,
    malformedPlans: plans.malformed
  };
}
function emptyAgg() {
  return {
    acceptedChanges: 0,
    rejectedOutcomes: 0,
    retriesTotal: 0,
    relativeCostTotal: 0,
    relativeCostUnknownAttempts: 0,
    humanTotal: 0,
    reviewFindingsTotal: 0,
    elapsedTotal: 0,
    elapsedPresent: 0,
    elapsedMissing: 0,
    usageRecorded: 0,
    usageUnavailable: 0,
    usageUnknown: 0,
    modelIdentityPresent: 0,
    providerCostPresent: 0,
    escapedSuspected: 0,
    escapedConfirmed: 0,
    overRouting: 0,
    underRouting: 0
  };
}
function deriveOutcomeData(loaded) {
  const outcome = loaded.outcome;
  const decision2 = outcome.decision === "accepted" ? "accepted" : "rejected";
  const rawClass = optionalString2(outcome.capabilityClass);
  const capabilityClass = rawClass !== null && CAPABILITY_CLASSES.includes(rawClass) ? rawClass : null;
  const provider = optionalString2(outcome.provider);
  const model = optionalString2(outcome.model);
  const attemptLinked = typeof outcome.attemptArtifactId === "string";
  const candidateKey = attemptLinked ? JSON.stringify([provider, model, capabilityClass]) : "unlinked";
  const retries = optionalNumber2(outcome.retryCount) ?? 0;
  const escalationCount = optionalNumber2(outcome.escalationCount) ?? 0;
  const human = optionalNumber2(outcome.humanCorrectionMinutes) ?? 0;
  const findings2 = typeof outcome.reviewFindings === "object" && outcome.reviewFindings !== null ? outcome.reviewFindings : {};
  const reviewFindings = optionalNumber2(findings2.total) ?? 0;
  const elapsed = optionalNumber2(outcome.attemptDurationMs);
  const usage = typeof outcome.usage === "object" && outcome.usage !== null ? outcome.usage : {};
  const usageStatus = usage.status === "recorded" || usage.status === "unavailable" || usage.status === "unknown" ? usage.status : null;
  const modelIdentityPresent = usage.modelIdentity !== null && usage.modelIdentity !== void 0;
  const providerCostPresent = usage.providerCost !== null && usage.providerCost !== void 0;
  const escaped = outcome.escapedDefectStatus === "suspected" ? "suspected" : outcome.escapedDefectStatus === "confirmed" ? "confirmed" : "none";
  let relativeCost = 0;
  let relativeCostUnknown = 0;
  let expanded = false;
  for (const attempt of loaded.attempts) {
    const planId = optionalString2(attempt.routingPlanArtifactId);
    const plan = planId !== null ? loaded.plans.get(planId) : void 0;
    const selection = plan && typeof plan.selection === "object" && plan.selection !== null ? plan.selection : void 0;
    const cost = selection ? optionalNumber2(selection.relativeCost) : void 0;
    if (cost !== void 0) relativeCost += cost;
    else relativeCostUnknown += 1;
    const progress2 = typeof attempt.progress === "object" && attempt.progress !== null ? attempt.progress : void 0;
    if (progress2 && progress2.status === "expanded") expanded = true;
  }
  relativeCostUnknown += loaded.malformedAttempts;
  const overRouting = decision2 === "accepted" && retries === 0 && escalationCount === 0 && reviewFindings === 0 && capabilityClass !== null && capabilityClass !== "economy";
  const underRouting = decision2 === "rejected" || escalationCount > 0 || expanded;
  return {
    decision: decision2,
    capabilityClass,
    provider,
    model,
    candidateKey,
    retries,
    relativeCost,
    relativeCostUnknown,
    human,
    reviewFindings,
    elapsed,
    usageStatus,
    modelIdentityPresent,
    providerCostPresent,
    escaped,
    overRouting,
    underRouting
  };
}
function applyAgg(agg, data) {
  if (data.decision === "accepted") {
    agg.acceptedChanges += 1;
    agg.retriesTotal += data.retries;
    agg.relativeCostTotal += data.relativeCost;
    agg.relativeCostUnknownAttempts += data.relativeCostUnknown;
    agg.humanTotal += data.human;
    agg.reviewFindingsTotal += data.reviewFindings;
    if (data.elapsed !== void 0) {
      agg.elapsedTotal += data.elapsed;
      agg.elapsedPresent += 1;
    } else {
      agg.elapsedMissing += 1;
    }
    if (data.usageStatus === "recorded") agg.usageRecorded += 1;
    else if (data.usageStatus === "unavailable") agg.usageUnavailable += 1;
    else if (data.usageStatus === "unknown") agg.usageUnknown += 1;
    if (data.modelIdentityPresent) agg.modelIdentityPresent += 1;
    if (data.providerCostPresent) agg.providerCostPresent += 1;
    if (data.escaped === "suspected") agg.escapedSuspected += 1;
    else if (data.escaped === "confirmed") agg.escapedConfirmed += 1;
    if (data.overRouting) agg.overRouting += 1;
  } else {
    agg.rejectedOutcomes += 1;
  }
  if (data.underRouting) agg.underRouting += 1;
}
function ratio(total, denominator) {
  return denominator > 0 ? total / denominator : null;
}
function renderAgg(agg) {
  const d = agg.acceptedChanges;
  return {
    acceptedChanges: d,
    rejectedOutcomes: agg.rejectedOutcomes,
    perAcceptedChange: {
      retries: ratio(agg.retriesTotal, d),
      // Null unless the configured relative cost is known for every accepted
      // change in the aggregate: an unresolved-plan attempt must never make an
      // unknown look like a smaller average.
      configuredRelativeCost: agg.relativeCostUnknownAttempts > 0 ? null : ratio(agg.relativeCostTotal, d),
      humanCorrectionMinutes: ratio(agg.humanTotal, d),
      reviewFindings: ratio(agg.reviewFindingsTotal, d),
      // Denominated by accepted changes, and only reported when elapsed is
      // present for every accepted change (elapsedMissing === 0); otherwise
      // null, since a partial mean would misrepresent the completeness.
      elapsedMs: agg.elapsedMissing > 0 ? null : ratio(agg.elapsedTotal, d)
    },
    totals: {
      retries: agg.retriesTotal,
      configuredRelativeCost: agg.relativeCostTotal,
      humanCorrectionMinutes: agg.humanTotal,
      reviewFindings: agg.reviewFindingsTotal,
      elapsedMs: {
        total: agg.elapsedTotal,
        present: agg.elapsedPresent,
        missing: agg.elapsedMissing
      }
    },
    missingData: {
      usageRecorded: agg.usageRecorded,
      usageUnavailable: agg.usageUnavailable,
      usageUnknown: agg.usageUnknown,
      modelIdentityPresent: agg.modelIdentityPresent,
      providerCostPresent: agg.providerCostPresent,
      relativeCostUnknownAttempts: agg.relativeCostUnknownAttempts
    },
    escapedDefects: {
      suspected: agg.escapedSuspected,
      confirmed: agg.escapedConfirmed
    },
    signals: {
      overRouting: { count: agg.overRouting, denominator: d },
      underRouting: {
        count: agg.underRouting,
        denominator: agg.acceptedChanges + agg.rejectedOutcomes
      }
    }
  };
}
function emptySplitState() {
  const classes = /* @__PURE__ */ new Map();
  for (const capability of CAPABILITY_CLASSES)
    classes.set(capability, emptyAgg());
  return {
    manifestTaskCount: 0,
    accepted: 0,
    rejected: 0,
    absent: 0,
    malformed: 0,
    missing: {
      usageRecorded: 0,
      usageUnavailable: 0,
      usageUnknown: 0,
      modelIdentityPresent: 0,
      modelIdentityAbsent: 0,
      providerCostPresent: 0,
      elapsedPresent: 0,
      elapsedMissing: 0,
      attemptLinked: 0,
      attemptUnlinked: 0,
      verificationLinked: 0,
      relativeCostUnknownAttempts: 0,
      malformedArtifacts: 0
    },
    split: emptyAgg(),
    classes,
    candidates: /* @__PURE__ */ new Map()
  };
}
function renderSplit(split, state) {
  const accepted = state.accepted;
  const s = state.split;
  const byCapabilityClass = CAPABILITY_CLASSES.map((capability) => ({
    capabilityClass: capability,
    ...renderAgg(state.classes.get(capability))
  }));
  const byCandidate = [...state.candidates.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([candidate, entry]) => ({
    candidate,
    provider: entry.provider,
    model: entry.model,
    capabilityClass: entry.capabilityClass,
    ...renderAgg(entry.agg)
  }));
  return {
    split,
    evaluationOnly: split === "holdout",
    manifestTaskCount: state.manifestTaskCount,
    outcomes: {
      accepted,
      rejected: state.rejected,
      absent: state.absent,
      malformed: state.malformed
    },
    missingData: state.missing,
    signals: {
      overRouting: {
        count: s.overRouting,
        denominator: accepted,
        definition: OVER_ROUTING_DEFINITION
      },
      underRouting: {
        count: s.underRouting,
        denominator: accepted + state.rejected,
        definition: UNDER_ROUTING_DEFINITION
      },
      retryCost: {
        acceptedChanges: accepted,
        retriesTotal: s.retriesTotal,
        retriesPerAcceptedChange: ratio(s.retriesTotal, accepted),
        configuredRelativeCostTotal: s.relativeCostTotal,
        // Known numerator (configuredRelativeCostTotal) is reported separately;
        // the per-accepted-change value is null whenever any contributing
        // attempt's plan was unresolved, so a partial total never reads as
        // complete.
        configuredRelativeCostPerAcceptedChange: s.relativeCostUnknownAttempts > 0 ? null : ratio(s.relativeCostTotal, accepted),
        relativeCostUnknownAttempts: s.relativeCostUnknownAttempts
      },
      escapedDefects: {
        suspected: s.escapedSuspected,
        confirmed: s.escapedConfirmed,
        acceptedChanges: accepted
      }
    },
    byCapabilityClass,
    byCandidate
  };
}
async function resolveEvidenceRoot(root) {
  try {
    return await (0, import_promises9.realpath)(root);
  } catch (error) {
    if (error.code === "ENOENT") return root;
    throw error;
  }
}
async function buildEvaluationReport(root, manifest, now = /* @__PURE__ */ new Date()) {
  const realRoot = await resolveEvidenceRoot(root);
  const states = {
    calibration: emptySplitState(),
    holdout: emptySplitState()
  };
  for (const task of manifest.tasks) {
    const state = states[task.split];
    state.manifestTaskCount += 1;
    const loaded = await loadTask(realRoot, task.taskId);
    state.missing.malformedArtifacts += loaded.malformedAttempts + loaded.malformedPlans;
    if (loaded.outcomeAbsent) {
      state.absent += 1;
      continue;
    }
    if (loaded.outcomeMalformed || loaded.outcome === null) {
      state.malformed += 1;
      continue;
    }
    const data = deriveOutcomeData(loaded);
    const outcome = loaded.outcome;
    if (data.usageStatus === "recorded") state.missing.usageRecorded += 1;
    else if (data.usageStatus === "unavailable")
      state.missing.usageUnavailable += 1;
    else if (data.usageStatus === "unknown") state.missing.usageUnknown += 1;
    if (data.modelIdentityPresent) state.missing.modelIdentityPresent += 1;
    else state.missing.modelIdentityAbsent += 1;
    if (data.providerCostPresent) state.missing.providerCostPresent += 1;
    if (data.elapsed !== void 0) state.missing.elapsedPresent += 1;
    else state.missing.elapsedMissing += 1;
    if (typeof outcome.attemptArtifactId === "string")
      state.missing.attemptLinked += 1;
    else state.missing.attemptUnlinked += 1;
    if (typeof outcome.verificationArtifactId === "string")
      state.missing.verificationLinked += 1;
    if (data.decision === "accepted")
      state.missing.relativeCostUnknownAttempts += data.relativeCostUnknown;
    if (data.decision === "accepted") state.accepted += 1;
    else state.rejected += 1;
    applyAgg(state.split, data);
    if (data.capabilityClass !== null)
      applyAgg(state.classes.get(data.capabilityClass), data);
    let candidate = state.candidates.get(data.candidateKey);
    if (candidate === void 0) {
      candidate = {
        provider: data.provider,
        model: data.model,
        capabilityClass: data.capabilityClass,
        agg: emptyAgg()
      };
      state.candidates.set(data.candidateKey, candidate);
    }
    applyAgg(candidate.agg, data);
  }
  return {
    schemaVersion: EVALUATION_REPORT_SCHEMA,
    generatedAt: now.toISOString(),
    manifest: {
      manifestVersion: manifest.manifestVersion,
      taskCount: manifest.tasks.length,
      hash: hash(manifest)
    },
    splits: {
      calibration: renderSplit("calibration", states.calibration),
      holdout: renderSplit("holdout", states.holdout)
    }
  };
}
function replaySelection(plan, profiles) {
  const requiredIndex = CAPABILITY_CLASSES.indexOf(
    plan.requiredCapabilityClass
  );
  const eligible = profiles.candidates.filter(
    (candidate) => candidate.enabled && candidate.purposes.includes(
      plan.purpose
    ) && !(plan.externalTransmission === "denied" && candidate.requiresAdditionalExternalTransmission) && CAPABILITY_CLASSES.indexOf(candidate.capabilityClass) >= requiredIndex && candidate.relativeCost <= plan.maxRelativeCost
  ).sort(
    (left, right) => left.relativeCost - right.relativeCost || CAPABILITY_CLASSES.indexOf(left.capabilityClass) - CAPABILITY_CLASSES.indexOf(right.capabilityClass) || left.id.localeCompare(right.id)
  );
  const selected = plan.confidence === "low" ? void 0 : eligible[0];
  if (plan.confidence === "low")
    return {
      status: "requires-review",
      candidateId: null,
      capabilityClass: null,
      relativeCost: null
    };
  if (selected === void 0)
    return {
      status: "unroutable",
      candidateId: null,
      capabilityClass: null,
      relativeCost: null
    };
  return {
    status: "selected",
    candidateId: selected.id,
    capabilityClass: selected.capabilityClass,
    relativeCost: selected.relativeCost
  };
}
function toLoadedPlan(plan) {
  const selection = typeof plan.selection === "object" && plan.selection !== null ? plan.selection : null;
  if (plan.status !== "planned" || selection === null) return null;
  const rawClass = optionalString2(plan.requiredCapabilityClass);
  const selClass = optionalString2(selection.capabilityClass);
  const purpose = optionalString2(plan.purpose);
  const budget = typeof plan.budget === "object" && plan.budget !== null ? plan.budget : null;
  const controls = typeof plan.controls === "object" && plan.controls !== null ? plan.controls : null;
  const assessment = typeof plan.assessment === "object" && plan.assessment !== null ? plan.assessment : null;
  const candidateId = optionalString2(selection.candidateId);
  const maxRelativeCost = budget ? optionalNumber2(budget.maxRelativeCost) : void 0;
  const relativeCost = optionalNumber2(selection.relativeCost);
  const externalTransmission = controls ? optionalString2(controls.externalTransmission) : null;
  const confidence2 = assessment ? optionalString2(assessment.confidence) : "medium";
  const createdAt = optionalString2(plan.createdAt);
  const artifactIdValue = optionalString2(plan.artifactId);
  if (rawClass === null || !CAPABILITY_CLASSES.includes(rawClass) || selClass === null || !CAPABILITY_CLASSES.includes(selClass) || purpose === null || maxRelativeCost === void 0 || relativeCost === void 0 || candidateId === null || externalTransmission !== "allowed" && externalTransmission !== "denied" || confidence2 !== "low" && confidence2 !== "medium" && confidence2 !== "high" || createdAt === null || artifactIdValue === null)
    return null;
  return {
    requiredCapabilityClass: rawClass,
    purpose,
    maxRelativeCost,
    externalTransmission,
    confidence: confidence2,
    selection: {
      candidateId,
      capabilityClass: selClass,
      relativeCost
    },
    createdAt,
    artifactId: artifactIdValue
  };
}
async function buildReplayReport(root, manifest, profiles, options2, now = /* @__PURE__ */ new Date()) {
  const realRoot = await resolveEvidenceRoot(root);
  const selectedSplit = options2.holdoutFinal ? "holdout" : "calibration";
  const diffs = [];
  let excludedSplitTaskCount = 0;
  let noPlan = 0;
  let changed = 0;
  let unchanged = 0;
  let nowSelected = 0;
  let nowUnroutable = 0;
  let nowRequiresReview = 0;
  for (const task of manifest.tasks) {
    if (task.split !== selectedSplit) {
      excludedSplitTaskCount += 1;
      continue;
    }
    const loaded = await loadTask(realRoot, task.taskId);
    const plans = loaded.planList.map(toLoadedPlan).filter((plan2) => plan2 !== null).sort(
      (a, b) => a.createdAt === b.createdAt ? a.artifactId.localeCompare(b.artifactId) : a.createdAt.localeCompare(b.createdAt)
    );
    const plan = plans[plans.length - 1];
    if (plan === void 0) {
      noPlan += 1;
      diffs.push({
        taskId: task.taskId,
        original: null,
        proposed: null,
        changed: false,
        note: "no recorded routing plan"
      });
      continue;
    }
    const proposed = replaySelection(plan, profiles);
    const isChanged = proposed.status !== "selected" || proposed.candidateId !== plan.selection.candidateId || proposed.capabilityClass !== plan.selection.capabilityClass || proposed.relativeCost !== plan.selection.relativeCost;
    if (isChanged) changed += 1;
    else unchanged += 1;
    if (proposed.status === "selected") nowSelected += 1;
    else if (proposed.status === "unroutable") nowUnroutable += 1;
    else nowRequiresReview += 1;
    diffs.push({
      taskId: task.taskId,
      original: {
        status: "selected",
        candidateId: plan.selection.candidateId,
        capabilityClass: plan.selection.capabilityClass,
        relativeCost: plan.selection.relativeCost
      },
      proposed: {
        status: proposed.status,
        candidateId: proposed.candidateId,
        capabilityClass: proposed.capabilityClass,
        relativeCost: proposed.relativeCost
      },
      changed: isChanged
    });
  }
  const tasksReplayed = diffs.length - noPlan;
  if (tasksReplayed === 0)
    throw new RigorError(
      `No ${selectedSplit} tasks with a recorded routing plan to replay`,
      EXIT.policyViolation
    );
  return {
    schemaVersion: EVALUATION_REPLAY_SCHEMA,
    generatedAt: now.toISOString(),
    split: selectedSplit,
    holdoutFinal: options2.holdoutFinal,
    proposedModelProfilesHash: hash(profiles),
    manifest: {
      manifestVersion: manifest.manifestVersion,
      taskCount: manifest.tasks.length,
      hash: hash(manifest)
    },
    excludedSplitTaskCount,
    summary: {
      tasksReplayed,
      changed,
      unchanged,
      nowSelected,
      nowUnroutable,
      nowRequiresReview,
      noPlan
    },
    diffs
  };
}

// src/test-integrity.ts
var import_promises10 = require("node:fs/promises");
var import_node_path11 = __toESM(require("node:path"), 1);
var DETECTOR_VERSION = "0.1.0";
var EVALUATED_SIGNALS = [
  "TI-05",
  "TI-06",
  "TI-07",
  "TI-08",
  "TI-09"
];
var TEST_PATH_GLOBS = [
  "test/**",
  "tests/**",
  "spec/**",
  "**/__tests__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.go",
  "**/*_test.py",
  "**/test_*.py"
];
var SNAPSHOT_GLOBS = [
  "**/__snapshots__/**",
  "**/*.snap"
];
var CONFIG_GLOBS = [
  "**/tsconfig.json",
  "**/tsconfig.*.json",
  "**/.eslintrc",
  "**/.eslintrc.*",
  "**/eslint.config.*",
  "**/.prettierrc",
  "**/.prettierrc.*",
  "**/prettier.config.*",
  "**/vitest.config.*",
  "**/jest.config.*",
  "**/.mocharc",
  "**/.mocharc.*",
  "**/babel.config.*",
  "**/.babelrc",
  "**/.babelrc.*",
  "**/Makefile",
  ".github/workflows/**"
];
var MARKER_TOKENS = [
  ".skip(",
  ".only(",
  ".todo(",
  "it.todo",
  "describe.todo",
  "xit(",
  "xdescribe(",
  "fit(",
  "fdescribe(",
  "@pytest.mark.skip",
  "@unittest.skip",
  "#[ignore]",
  "t.Skip(",
  "t.SkipNow("
];
var ASSERTION_TOKEN_RE = /expect\(|\bassert|\.should\b|\bshould\(|toBe\b|toEqual\b|toStrictEqual\b|toMatch\b|toContain\b|toThrow\b|toHaveBeen|\bok\(|\bnotOk\(|\brequire\.[A-Za-z]/gu;
function isTestPath(file) {
  return matches(file, [...TEST_PATH_GLOBS]);
}
function isSnapshotPath(file) {
  return matches(file, [...SNAPSHOT_GLOBS]);
}
function isConfigPath(file) {
  return matches(file, [...CONFIG_GLOBS]);
}
var ESC2 = String.fromCharCode(27);
var ANSI_RE2 = new RegExp(`${ESC2}\\[[0-9;]*[a-zA-Z]`, "g");
var UUID_RE2 = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
var ISO_TIMESTAMP_RE2 = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
var DURATION_RE2 = /\b\d+(?:\.\d+)?(?:ms|s|m)\b/g;
var HEX_RUN_RE2 = /\b[0-9a-fA-F]{8,}\b/g;
function normalizeMatchedLine(line) {
  return line.replace(ANSI_RE2, "").replace(UUID_RE2, "<uuid>").replace(ISO_TIMESTAMP_RE2, "<ts>").replace(DURATION_RE2, "<dur>").replace(HEX_RUN_RE2, "<hex>").replace(/\s+/gu, " ").trim();
}
function matchDigest(lines) {
  const normalized = lines.map(normalizeMatchedLine).filter((line) => line.length > 0).sort();
  return hash(normalized);
}
var MAX_PATHS = 25;
function boundedPaths(paths) {
  return [...new Set(paths)].sort().slice(0, MAX_PATHS);
}
function countMatches(line, tokens) {
  let count = 0;
  for (const token of tokens) {
    let index = line.indexOf(token);
    while (index !== -1) {
      count += 1;
      index = line.indexOf(token, index + token.length);
    }
  }
  return count;
}
function countAssertions(line) {
  const matched = line.match(ASSERTION_TOKEN_RE);
  return matched === null ? 0 : matched.length;
}
function detectTi05(changes) {
  let added = 0;
  let removed = 0;
  const paths = [];
  const matched = [];
  for (const change of changes) {
    if (!isTestPath(change.path)) continue;
    let fileAdded = 0;
    for (const line of change.addedLines) {
      const n = countMatches(line, MARKER_TOKENS);
      if (n > 0) matched.push(line);
      fileAdded += n;
    }
    for (const line of change.removedLines) {
      const n = countMatches(line, MARKER_TOKENS);
      if (n > 0) matched.push(line);
      removed += n;
    }
    added += fileAdded;
    if (fileAdded > 0) paths.push(change.path);
  }
  if (added === 0) return null;
  return {
    signalId: "TI-05",
    threatClass: "skip-only-todo",
    detector: "diff-token-scan",
    value: {
      addedMarkers: added,
      removedMarkers: removed,
      matchedPaths: paths.length
    },
    paths,
    matchedLines: matched
  };
}
function detectTi06(changes) {
  const paths = [];
  for (const change of changes) {
    if (change.changeType !== "deleted") continue;
    if (!isTestPath(change.path)) continue;
    paths.push(change.path);
  }
  if (paths.length === 0) return null;
  return {
    signalId: "TI-06",
    threatClass: "test-case-removal",
    detector: "diff-name-status",
    value: { deletedTestFiles: paths.length, matchedPaths: paths.length },
    paths,
    matchedLines: paths
  };
}
function detectTi07(changes) {
  let added = 0;
  let removed = 0;
  const paths = [];
  const matched = [];
  for (const change of changes) {
    if (!isTestPath(change.path)) continue;
    let touched = false;
    for (const line of change.addedLines) {
      const n = countAssertions(line);
      if (n > 0) {
        added += n;
        matched.push(line);
        touched = true;
      }
    }
    for (const line of change.removedLines) {
      const n = countAssertions(line);
      if (n > 0) {
        removed += n;
        matched.push(line);
        touched = true;
      }
    }
    if (touched) paths.push(change.path);
  }
  const netRemoved = removed - added;
  if (netRemoved <= 0) return null;
  return {
    signalId: "TI-07",
    threatClass: "assertion-deletion",
    detector: "diff-token-scan",
    value: {
      addedAssertions: added,
      removedAssertions: removed,
      netRemoved,
      matchedPaths: paths.length
    },
    paths,
    matchedLines: matched
  };
}
function detectTi08(changes) {
  const snapshotPaths = [];
  let implementationFiles = 0;
  for (const change of changes) {
    if (isSnapshotPath(change.path)) {
      snapshotPaths.push(change.path);
      continue;
    }
    if (isTestPath(change.path) || isConfigPath(change.path)) continue;
    implementationFiles += 1;
  }
  if (snapshotPaths.length === 0 || implementationFiles === 0) return null;
  return {
    signalId: "TI-08",
    threatClass: "snapshot-churn",
    detector: "diff-path-scan",
    value: {
      snapshotFiles: snapshotPaths.length,
      implementationFiles,
      matchedPaths: snapshotPaths.length
    },
    paths: snapshotPaths,
    matchedLines: snapshotPaths
  };
}
function scriptsDiffer(base, head) {
  if (base === null || head === null) return base !== head;
  return hash(base) !== hash(head);
}
function detectTi09(inputs) {
  const configPaths = [];
  let packageChanged = false;
  for (const change of inputs.changes) {
    if (change.path === "package.json" || change.path.endsWith("/package.json"))
      packageChanged = true;
    if (isConfigPath(change.path)) configPaths.push(change.path);
  }
  const scriptsChanged = packageChanged && scriptsDiffer(inputs.baseScripts, inputs.headScripts);
  if (configPaths.length === 0 && !scriptsChanged) return null;
  const paths = [...configPaths];
  if (scriptsChanged) paths.push("package.json");
  return {
    signalId: "TI-09",
    threatClass: "configured-check-weakening",
    detector: "config-diff-scan",
    value: {
      changedConfigFiles: configPaths.length,
      packageScriptsChanged: scriptsChanged ? 1 : 0,
      matchedPaths: paths.length
    },
    paths,
    matchedLines: paths
  };
}
function detectSignals(inputs) {
  const results = [
    detectTi05(inputs.changes),
    detectTi06(inputs.changes),
    detectTi07(inputs.changes),
    detectTi08(inputs.changes),
    detectTi09(inputs)
  ].filter((result) => result !== null);
  return results.map((result) => ({
    signalId: result.signalId,
    threatClass: result.threatClass,
    label: "advisory-interpretation",
    computation: "deterministic",
    detector: { name: result.detector, version: DETECTOR_VERSION },
    value: result.value,
    paths: boundedPaths(result.paths),
    matchDigest: matchDigest(result.matchedLines),
    note: null
  }));
}
var MAX_SIGNALS = 32;
function buildTestIntegrityEvent(meta, signals, now = /* @__PURE__ */ new Date()) {
  if (!/^[0-9a-f]{40}$/u.test(meta.baseSha))
    throw new RigorError(
      "baseSha must be a 40-hex commit sha",
      EXIT.inputError
    );
  if (meta.headSha !== null && !/^[0-9a-f]{40}$/u.test(meta.headSha))
    throw new RigorError(
      "headSha must be a 40-hex commit sha",
      EXIT.inputError
    );
  if (meta.headSha === null && meta.worktreeDigest === null)
    throw new RigorError(
      "worktreeDigest is required when headSha is null",
      EXIT.inputError
    );
  const truncated = signals.length > MAX_SIGNALS;
  return {
    schemaVersion: TEST_INTEGRITY_EVENT_SCHEMA,
    artifactId: artifactId("test-integrity-event"),
    taskId: meta.taskId,
    createdAt: now.toISOString(),
    mode: "shadow",
    enforcement: "none",
    attemptArtifactId: meta.attemptArtifactId,
    verificationArtifactId: meta.verificationArtifactId,
    diff: {
      baseSha: meta.baseSha,
      headSha: meta.headSha,
      worktreeDigest: meta.headSha === null ? meta.worktreeDigest : null
    },
    signalsEvaluated: [...EVALUATED_SIGNALS],
    signals: signals.slice(0, MAX_SIGNALS),
    signalsTruncated: truncated,
    note: meta.note
  };
}
function parseScripts(text) {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return null;
    const scripts = parsed.scripts;
    if (scripts === null || typeof scripts !== "object") return null;
    const result = {};
    for (const [key, value] of Object.entries(
      scripts
    ))
      if (typeof value === "string") result[key] = value;
    return result;
  } catch {
    return null;
  }
}
var IGNORED_EVIDENCE = [".rigor/evidence/", ".rigor/events.jsonl"];
async function scanTestIntegrity(root, options2, now = /* @__PURE__ */ new Date()) {
  const baseSha = await resolveCommit(root, options2.base);
  const headSha = options2.head === null ? null : await resolveCommit(root, options2.head);
  const changes = await diffChanges(root, baseSha, headSha);
  const baseScripts = parseScripts(
    await showFile(root, baseSha, "package.json")
  );
  let headScripts;
  if (headSha === null) {
    let text = null;
    try {
      text = await (0, import_promises10.readFile)(import_node_path11.default.join(root, "package.json"), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    headScripts = parseScripts(text);
  } else {
    headScripts = parseScripts(await showFile(root, headSha, "package.json"));
  }
  const signals = detectSignals({ changes, baseScripts, headScripts });
  const worktreeDigest = headSha === null ? await treeHash(root, IGNORED_EVIDENCE) : null;
  return buildTestIntegrityEvent(
    {
      taskId: options2.task,
      baseSha,
      headSha,
      worktreeDigest,
      attemptArtifactId: options2.attemptArtifactId,
      verificationArtifactId: options2.verificationArtifactId,
      note: options2.note
    },
    signals,
    now
  );
}
var VERDICTS = [
  "true-positive",
  "false-positive",
  "uncertain"
];
var SIGNAL_IDS = EVALUATED_SIGNALS;
function parseTestIntegrityEvent(value) {
  const item = record(value, "test-integrity event");
  if (item.schemaVersion !== TEST_INTEGRITY_EVENT_SCHEMA)
    throw new RigorError(
      "Unsupported test-integrity event schema",
      EXIT.inputError
    );
  taskId(item.taskId);
  textField(item.artifactId, "event.artifactId", 128);
  if (!Array.isArray(item.signals))
    throw new RigorError("event.signals must be an array", EXIT.inputError);
  if (!Array.isArray(item.signalsEvaluated))
    throw new RigorError(
      "event.signalsEvaluated must be an array",
      EXIT.inputError
    );
  return item;
}
function parseVerdictEntry(value, index) {
  const item = record(value, `verdicts[${index}]`);
  const signalId = textField(item.signalId, `verdicts[${index}].signalId`, 32);
  if (!SIGNAL_IDS.includes(signalId))
    throw new RigorError(
      `verdicts[${index}].signalId is not a known signal`,
      EXIT.inputError
    );
  if (typeof item.verdict !== "string" || !VERDICTS.includes(item.verdict))
    throw new RigorError(
      `verdicts[${index}].verdict is invalid`,
      EXIT.inputError
    );
  const entry = {
    signalId,
    verdict: item.verdict
  };
  if (item.note !== void 0)
    entry.note = textField(item.note, `verdicts[${index}].note`, 200);
  return entry;
}
function parseClassificationInput(value) {
  const item = record(value, "classification input");
  if (item.schemaVersion !== TEST_INTEGRITY_CLASSIFICATION_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported classification input schema",
      EXIT.inputError
    );
  if (item.classifiedBy !== "human")
    throw new RigorError("classifiedBy must be human", EXIT.inputError);
  if (!Array.isArray(item.verdicts) || item.verdicts.length === 0)
    throw new RigorError("verdicts must be a non-empty array", EXIT.inputError);
  if (item.verdicts.length > MAX_SIGNALS)
    throw new RigorError("too many verdicts", EXIT.inputError);
  return {
    schemaVersion: TEST_INTEGRITY_CLASSIFICATION_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    eventArtifactId: textField(item.eventArtifactId, "eventArtifactId", 128),
    verdicts: item.verdicts.map(parseVerdictEntry),
    classifiedBy: "human"
  };
}
function createClassification(input, event, now = /* @__PURE__ */ new Date()) {
  if (input.taskId !== event.taskId)
    throw new RigorError(
      "Classification taskId does not match the event",
      EXIT.policyViolation
    );
  if (input.eventArtifactId !== event.artifactId)
    throw new RigorError(
      "Classification eventArtifactId does not match the event",
      EXIT.policyViolation
    );
  const firedSignals = new Set(event.signals.map((signal) => signal.signalId));
  for (const verdict of input.verdicts)
    if (!firedSignals.has(verdict.signalId))
      throw new RigorError(
        `verdict names a signal not present in the event: ${verdict.signalId}`,
        EXIT.policyViolation
      );
  return {
    schemaVersion: TEST_INTEGRITY_CLASSIFICATION_SCHEMA,
    artifactId: artifactId("test-integrity-classification"),
    taskId: event.taskId,
    createdAt: now.toISOString(),
    eventArtifactId: event.artifactId,
    classifiedBy: "human",
    verdicts: input.verdicts.map((verdict) => ({
      signalId: verdict.signalId,
      verdict: verdict.verdict,
      note: verdict.note ?? null
    }))
  };
}
async function hasUnfinishedAttempt(root, task) {
  const directory = import_node_path11.default.join(root, ".rigor", "evidence", task, "attempts");
  let names;
  try {
    names = await (0, import_promises10.readdir)(directory);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  const sessions = /* @__PURE__ */ new Set();
  const finished = /* @__PURE__ */ new Set();
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    let item;
    try {
      item = record(
        JSON.parse(
          await (0, import_promises10.readFile)(import_node_path11.default.join(directory, name), "utf8")
        ),
        "attempt artifact"
      );
    } catch {
      throw new RigorError(
        `Invalid attempt artifact: ${name}`,
        EXIT.inputError
      );
    }
    if (item.schemaVersion === ATTEMPT_SESSION_SCHEMA)
      sessions.add(textField(item.artifactId, "artifactId", 128));
    if (item.schemaVersion === ATTEMPT_SCHEMA)
      finished.add(textField(item.sessionArtifactId, "sessionArtifactId", 128));
  }
  return [...sessions].some((id) => !finished.has(id));
}

// src/review-selection.ts
var risks2 = ["low", "medium", "high", "critical"];
var confidences = ["low", "medium", "high"];
var progress = ["none", "changed", "unchanged"];
var availability = [
  "available",
  "unavailable",
  "unknown",
  "incompatible"
];
var unavailableActions = ["skip", "stop", "continue-claude-only"];
function oneOf8(value, allowed, name) {
  if (typeof value !== "string" || !allowed.includes(value))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value;
}
function bool4(value, name) {
  if (typeof value !== "boolean")
    throw new RigorError(`${name} must be boolean`, EXIT.inputError);
  return value;
}
function integer5(value, name, minimum) {
  if (!Number.isInteger(value) || value < minimum || value > 20)
    throw new RigorError(`${name} is out of range`, EXIT.inputError);
  return value;
}
function exactKeys2(item, allowed, name) {
  const unexpected = Object.keys(item).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    throw new RigorError(
      `${name} contains unsupported fields: ${unexpected.join(", ")}`,
      EXIT.inputError
    );
}
function parseConsultationDecisionInput(value) {
  const item = record(value, "consultation decision input");
  if (item.schemaVersion !== CONSULTATION_DECISION_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported consultation decision input schema",
      EXIT.inputError
    );
  exactKeys2(
    item,
    [
      "schemaVersion",
      "taskId",
      "riskTier",
      "assessmentConfidence",
      "failureProgress",
      "fingerprintRepetitions",
      "concerns",
      "humanRequested",
      "externalTransmission",
      "pluginAvailability",
      "policy"
    ],
    "consultation decision input"
  );
  const concerns = record(item.concerns, "concerns");
  const policy = record(item.policy, "policy");
  exactKeys2(concerns, ["security", "dataIntegrity"], "concerns");
  exactKeys2(
    policy,
    ["unchangedFailureThreshold", "unavailableAction"],
    "policy"
  );
  return {
    schemaVersion: CONSULTATION_DECISION_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    riskTier: oneOf8(item.riskTier, risks2, "riskTier"),
    assessmentConfidence: oneOf8(
      item.assessmentConfidence,
      confidences,
      "assessmentConfidence"
    ),
    failureProgress: oneOf8(item.failureProgress, progress, "failureProgress"),
    fingerprintRepetitions: integer5(
      item.fingerprintRepetitions,
      "fingerprintRepetitions",
      0
    ),
    concerns: {
      security: bool4(concerns.security, "concerns.security"),
      dataIntegrity: bool4(concerns.dataIntegrity, "concerns.dataIntegrity")
    },
    humanRequested: bool4(item.humanRequested, "humanRequested"),
    externalTransmission: oneOf8(
      item.externalTransmission,
      ["allowed", "denied"],
      "externalTransmission"
    ),
    pluginAvailability: oneOf8(
      item.pluginAvailability,
      availability,
      "pluginAvailability"
    ),
    policy: {
      unchangedFailureThreshold: integer5(
        policy.unchangedFailureThreshold,
        "policy.unchangedFailureThreshold",
        2
      ),
      unavailableAction: oneOf8(
        policy.unavailableAction,
        unavailableActions,
        "policy.unavailableAction"
      )
    }
  };
}
function triggers(input) {
  const result = [];
  if (input.riskTier === "high") result.push("HIGH_RISK");
  if (input.riskTier === "critical") result.push("CRITICAL_RISK");
  if (input.assessmentConfidence === "low")
    result.push("LOW_ASSESSMENT_CONFIDENCE");
  if (input.failureProgress === "unchanged" && input.fingerprintRepetitions >= input.policy.unchangedFailureThreshold)
    result.push("REPEATED_UNCHANGED_FAILURE");
  if (input.concerns.security) result.push("SECURITY_CONCERN");
  if (input.concerns.dataIntegrity) result.push("DATA_INTEGRITY_CONCERN");
  if (input.humanRequested) result.push("HUMAN_REQUEST");
  return result;
}
function decision(input, result) {
  return {
    schemaVersion: CONSULTATION_DECISION_SCHEMA,
    taskId: input.taskId,
    inputHash: hash(input),
    pluginAvailability: input.pluginAvailability,
    externalTransmission: input.externalTransmission,
    ...result,
    // Last so no spread value can ever widen the decision into an approval.
    approvalEffect: "none"
  };
}
function selectConsultation(input) {
  if (input.externalTransmission === "denied")
    return decision(input, {
      decision: "continue-claude-only",
      reasonCode: "EXTERNAL_TRANSMISSION_DENIED",
      triggerReasons: triggers(input),
      invocationAllowed: false
    });
  const triggerReasons = triggers(input);
  if (triggerReasons.length === 0)
    return decision(input, {
      decision: "skip-independent-review",
      reasonCode: "NO_REVIEW_TRIGGER",
      triggerReasons,
      invocationAllowed: false
    });
  if (input.pluginAvailability === "available")
    return decision(input, {
      decision: "request-independent-review",
      reasonCode: "REVIEW_TRIGGERED",
      triggerReasons,
      invocationAllowed: true
    });
  if (input.policy.unavailableAction === "stop")
    return decision(input, {
      decision: "stop-required-review",
      reasonCode: "REQUIRED_REVIEW_PLUGIN_UNAVAILABLE",
      triggerReasons,
      invocationAllowed: false
    });
  if (input.policy.unavailableAction === "continue-claude-only")
    return decision(input, {
      decision: "continue-claude-only",
      reasonCode: "CLAUDE_ONLY_PLUGIN_UNAVAILABLE",
      triggerReasons,
      invocationAllowed: false
    });
  return decision(input, {
    decision: "skip-independent-review",
    reasonCode: "OPTIONAL_REVIEW_PLUGIN_UNAVAILABLE",
    triggerReasons,
    invocationAllowed: false
  });
}

// src/cli.ts
function option(args, name, required = true) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : void 0;
  if (required && (!value || value.startsWith("--")))
    throw new RigorError(`Missing ${name}`, EXIT.inputError);
  return value;
}
function options(args, name) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new RigorError(`Missing ${name}`, EXIT.inputError);
    result.push(value);
  }
  return result;
}
function output(value) {
  import_node_process.default.stdout.write(`${JSON.stringify(value, null, 2)}
`);
}
async function stdinJson() {
  const chunks = [];
  let size = 0;
  for await (const raw of import_node_process.default.stdin) {
    const chunk = Buffer.from(raw);
    size += chunk.length;
    if (size > 1e6)
      throw new RigorError("Hook input is too large", EXIT.inputError);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RigorError("Hook input is not valid JSON", EXIT.inputError);
  }
}
async function main(argv = import_node_process.default.argv.slice(2), cwd = import_node_process.default.cwd()) {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") {
    import_node_process.default.stdout.write(
      "Usage: rigor <setup|preflight|contract|availability|route|attempt-start|attempt-finish|consult-decide|consult-start|consult-finish|verify|escalate|review|outcome|retrospect|eval-report|eval-replay|calibration-proposal|test-integrity-scan|test-integrity-classify|governance|release-check|ci|hook> [options]\n"
    );
    return EXIT.success;
  }
  const root = await findGitRoot(cwd);
  if (command === "setup" || command === "upgrade") {
    const bundle = import_node_process.default.env.RIGOR_BUNDLE_PATH ?? import_node_path12.default.resolve(import_node_process.default.argv[1] ?? "dist/rigor.cjs");
    output(await setup(root, bundle));
    return EXIT.success;
  }
  if (command === "hook") {
    if (args[0] !== "user-prompt")
      throw new RigorError("Unknown hook", EXIT.inputError);
    const decision2 = await userPromptHook(await stdinJson(), cwd);
    if (decision2) output(decision2);
    return EXIT.success;
  }
  const policy = await loadPolicy(root);
  if (command === "preflight") {
    const intent = parseIntent(await readJson(option(args, "--intent")));
    const result = evaluate(policy, intent, await gitFacts(root));
    const saved = await saveArtifact(root, intent.taskId, "preflight", result);
    output({ ...result, saved });
    return EXIT.success;
  }
  if (command === "contract") {
    const preflight = parsePreflight(
      await readJson(option(args, "--preflight"))
    );
    const input = parseContractInput(await readJson(option(args, "--input")));
    const result = createContract(policy, preflight, input);
    const saved = await saveArtifact(root, result.taskId, "contract", result);
    output({ ...result, saved });
    return EXIT.success;
  }
  if (command === "availability") {
    const profiles = parseModelProfiles(
      await readJson(option(args, "--profiles"))
    );
    const report = buildAvailabilityReport(profiles, probeEnvironment());
    output(report);
    return EXIT.success;
  }
  if (command === "route") {
    const dryRun = args.includes("--dry-run");
    const recordPlan = args.includes("--record");
    if (dryRun === recordPlan)
      throw new RigorError(
        "route requires exactly one of --dry-run or --record",
        EXIT.inputError
      );
    const preflight = parsePreflight(
      await readJson(option(args, "--preflight"))
    );
    const input = parseRoutingInput(await readJson(option(args, "--input")));
    const profiles = parseModelProfiles(
      await readJson(option(args, "--profiles"))
    );
    const availabilityPath = option(args, "--availability", false);
    const availability2 = availabilityPath ? parseAvailabilityReport(await readJson(availabilityPath)) : void 0;
    const result = route(preflight, input, profiles, availability2);
    if (result.status !== "selected") {
      output(result);
      return EXIT.policyViolation;
    }
    if (dryRun) {
      output(result);
      return EXIT.success;
    }
    const contract = parseContract(await readJson(option(args, "--contract")));
    const plan = createRoutingPlan(result, preflight, contract);
    const saved = await saveCollectionArtifact(
      root,
      plan.taskId,
      "routing",
      "routing-plan",
      plan
    );
    output({ ...plan, saved });
    return EXIT.success;
  }
  if (command === "attempt-start") {
    const plan = parseRoutingPlan(await readJson(option(args, "--plan")));
    const contract = parseContract(await readJson(option(args, "--contract")));
    const result = await startAttempt(root, policy, plan, contract);
    output({ ...result.session, saved: result.saved });
    return EXIT.success;
  }
  if (command === "attempt-finish") {
    const session = parseAttemptSession(
      await readJson(option(args, "--session"))
    );
    const contract = parseContract(await readJson(option(args, "--contract")));
    const input = parseAttemptResultInput(
      await readJson(option(args, "--input"))
    );
    const verificationPath = option(args, "--verification", false);
    const verification = verificationPath ? parseVerification(await readJson(verificationPath)) : void 0;
    const result = await finishAttempt(
      root,
      session,
      contract,
      input,
      verification
    );
    output({ ...result.attempt, saved: result.saved });
    return result.attempt.status === "completed" ? EXIT.success : EXIT.policyViolation;
  }
  if (command === "consult-start") {
    const preflight = parsePreflight(
      await readJson(option(args, "--preflight"))
    );
    const request = parseConsultationRequest(
      await readJson(option(args, "--input"))
    );
    const result = await startConsultation(root, policy, preflight, request);
    output({ ...result.session, saved: result.saved });
    return EXIT.success;
  }
  if (command === "consult-decide") {
    const input = parseConsultationDecisionInput(
      await readJson(option(args, "--input"))
    );
    const result = selectConsultation(input);
    if (args.includes("--dry-run")) {
      output(result);
    } else {
      const evidence = {
        ...result,
        artifactId: artifactId("independent-review-decision"),
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const saved = await saveCollectionArtifact(
        root,
        input.taskId,
        "review-decisions",
        "independent-review-decision",
        evidence
      );
      output({ ...evidence, saved });
    }
    return result.decision === "stop-required-review" ? EXIT.policyViolation : EXIT.success;
  }
  if (command === "consult-finish") {
    const session = parseConsultationSession(
      await readJson(option(args, "--session"))
    );
    const input = parseConsultationResultInput(
      await readJson(option(args, "--input"))
    );
    const result = await finishConsultation(root, session, input);
    output({ ...result.consultation, saved: result.saved });
    return result.consultation.status === "completed" ? EXIT.success : EXIT.policyViolation;
  }
  if (command === "verify") {
    const contract = parseContract(await readJson(option(args, "--contract")));
    const facts = await gitFacts(root);
    const result = await verify(
      root,
      policy,
      contract,
      facts.changedPaths.filter(
        (item) => !item.startsWith(".rigor/evidence/") && item !== ".rigor/events.jsonl"
      ),
      facts.head
    );
    if (args.includes("--dry-run")) {
      output(result);
      return result.status === "passed" ? EXIT.success : EXIT.policyViolation;
    }
    const saved = await saveArtifact(
      root,
      result.taskId,
      "verification",
      result
    );
    output({ ...result, saved });
    return result.status === "passed" ? EXIT.success : EXIT.policyViolation;
  }
  if (command === "escalate") {
    const rawInput = await readJson(option(args, "--input"));
    if (record(rawInput, "escalation input").schemaVersion === ESCALATION_DECISION_INPUT_SCHEMA) {
      const input = parseEscalationDecisionInput(rawInput);
      const profiles = parseModelProfiles(
        await readJson(option(args, "--profiles"))
      );
      const availabilityPath = option(args, "--availability", false);
      const availability2 = availabilityPath ? parseAvailabilityReport(await readJson(availabilityPath)) : void 0;
      const contract = parseContract(
        await readJson(option(args, "--contract"))
      );
      const planPaths = options(args, "--plan");
      if (planPaths.length === 0)
        throw new RigorError(
          "At least one --plan is required",
          EXIT.inputError
        );
      const plans = await Promise.all(
        planPaths.map(async (file) => parseRoutingPlan(await readJson(file)))
      );
      const attemptPaths = options(args, "--attempt");
      if (attemptPaths.length === 0)
        throw new RigorError(
          "At least one --attempt is required",
          EXIT.inputError
        );
      const attempts = await Promise.all(
        attemptPaths.map(async (file) => parseAttempt(await readJson(file)))
      );
      attempts.sort((left, right) => left.sequence - right.sequence);
      validateEscalationArtifacts(input, contract, plans, attempts);
      const decision2 = selectEscalation(input, profiles, availability2);
      if (args.includes("--dry-run")) {
        output(decision2);
      } else {
        const evidence = {
          ...decision2,
          artifactId: artifactId("escalation-decision"),
          createdAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        const saved2 = await saveCollectionArtifact(
          root,
          input.taskId,
          "escalations",
          "escalation-decision",
          evidence
        );
        output({ ...evidence, saved: saved2 });
      }
      return decision2.decision.startsWith("stop-") ? EXIT.policyViolation : EXIT.success;
    }
    const result = createEscalation(parseEscalationInput(rawInput));
    const task = String(record(result, "escalation").taskId);
    const saved = await saveArtifact(root, task, "escalation", result);
    output({ ...record(result, "escalation"), saved });
    return EXIT.success;
  }
  if (command === "review") {
    const contract = parseContract(await readJson(option(args, "--contract")));
    const preflight = parsePreflight(
      await readJson(option(args, "--preflight"))
    );
    const verification = record(
      await readJson(option(args, "--verification")),
      "verification"
    );
    const result = createReview(contract, preflight, verification);
    const saved = await saveArtifact(root, contract.taskId, "review", result);
    output({ ...record(result, "review"), saved });
    return verification.status === "passed" ? EXIT.success : EXIT.policyViolation;
  }
  if (command === "governance") {
    const repository = parseRepository(option(args, "--repo"));
    const branch = parseBranch(option(args, "--branch", false) ?? "main");
    const requiredCheckContext = option(args, "--required-check", false) ?? "rigor";
    const token = import_node_process.default.env.RIGOR_GITHUB_TOKEN ?? import_node_process.default.env.GITHUB_TOKEN ?? import_node_process.default.env.GH_TOKEN;
    const result = await governanceVerify(
      policy,
      { ...repository, branch, requiredCheckContext },
      githubReader(token)
    );
    output(result);
    return result.status === "passed" ? EXIT.success : EXIT.policyViolation;
  }
  if (command === "release-check") {
    const version = option(args, "--version");
    if (!/^\d+\.\d+\.\d+$/u.test(version))
      throw new RigorError(
        "--version must be a semantic version like X.Y.Z",
        EXIT.inputError
      );
    const expectedBranch = parseBranch(
      option(args, "--branch", false) ?? "main"
    );
    const expectedSha = option(args, "--expected-sha", false) ?? null;
    const repoArg = option(args, "--repo", false);
    const requiredChecks = (option(args, "--required-check", false) ?? "quality").split(",").map((value) => value.trim()).filter(Boolean);
    const repo = repoArg ? parseRepository(repoArg) : null;
    const token = import_node_process.default.env.RIGOR_GITHUB_TOKEN ?? import_node_process.default.env.GITHUB_TOKEN ?? import_node_process.default.env.GH_TOKEN;
    const read = repo ? githubReader(token) : null;
    const report = await releaseVerify(
      root,
      { version, expectedBranch, expectedSha, repo, requiredChecks },
      read
    );
    output(report);
    return report.status === "passed" ? EXIT.success : EXIT.policyViolation;
  }
  if (command === "outcome") {
    const input = parseOutcomeInput(await readJson(option(args, "--input")));
    const attemptPath = option(args, "--attempt", false);
    const verificationPath = option(args, "--verification", false);
    const reviewPath = option(args, "--review", false);
    const attempt = attemptPath ? parseAttempt(await readJson(attemptPath)) : void 0;
    const verification = verificationPath ? parseVerification(await readJson(verificationPath)) : void 0;
    const review = reviewPath ? parseReviewArtifact(await readJson(reviewPath)) : void 0;
    const outcome = createOutcome(input, { attempt, verification, review });
    const saved = await saveArtifact(root, outcome.taskId, "outcome", outcome);
    output({ ...outcome, saved });
    return EXIT.success;
  }
  if (command === "retrospect") {
    output(await retrospect(root));
    return EXIT.success;
  }
  if (command === "eval-report") {
    const manifest = parseEvaluationManifest(
      await readJson(option(args, "--manifest"))
    );
    const evidenceRoot = import_node_path12.default.resolve(cwd, option(args, "--evidence-root"));
    const report = await buildEvaluationReport(evidenceRoot, manifest);
    const outPath = option(args, "--out", false);
    if (outPath !== void 0)
      await (0, import_promises11.writeFile)(
        import_node_path12.default.resolve(cwd, outPath),
        `${JSON.stringify(report, null, 2)}
`
      );
    output(report);
    return EXIT.success;
  }
  if (command === "eval-replay") {
    const manifest = parseEvaluationManifest(
      await readJson(option(args, "--manifest"))
    );
    const evidenceRoot = import_node_path12.default.resolve(cwd, option(args, "--evidence-root"));
    const profiles = parseModelProfiles(
      await readJson(option(args, "--profiles"))
    );
    const holdoutFinal = args.includes("--holdout-final");
    const replay = await buildReplayReport(evidenceRoot, manifest, profiles, {
      holdoutFinal
    });
    output(replay);
    return EXIT.success;
  }
  if (command === "calibration-proposal") {
    const manifest = parseEvaluationManifest(
      await readJson(option(args, "--manifest"))
    );
    const input = parseCalibrationProposalInput(
      await readJson(option(args, "--input"))
    );
    const reportPaths = options(args, "--report");
    if (reportPaths.length === 0)
      throw new RigorError(
        "At least one --report is required",
        EXIT.inputError
      );
    const reports = await Promise.all(
      reportPaths.map(async (file) => readJson(file))
    );
    verifyCalibrationEvidence(input.evidence, manifest, reports);
    const proposal = createCalibrationProposal(input, manifest);
    const saved = await saveCollectionArtifact(
      root,
      proposal.taskId,
      "calibration",
      "calibration-proposal",
      proposal
    );
    output({ ...proposal, saved });
    return EXIT.success;
  }
  if (command === "test-integrity-scan") {
    const task = taskId(option(args, "--task"));
    const base = option(args, "--base");
    const head = option(args, "--head", false) ?? null;
    const attemptPath = option(args, "--attempt", false);
    const verificationPath = option(args, "--verification", false);
    const noteArg = option(args, "--note", false);
    const note = noteArg === void 0 ? null : textField(noteArg, "--note", 200);
    let attemptArtifactId = null;
    let verificationArtifactId = null;
    if (attemptPath !== void 0) {
      const attempt = parseAttempt(await readJson(attemptPath));
      if (attempt.taskId !== task)
        throw new RigorError(
          "Linked attempt taskId does not match --task",
          EXIT.policyViolation
        );
      attemptArtifactId = attempt.artifactId;
    }
    if (verificationPath !== void 0) {
      const verification = parseVerification(await readJson(verificationPath));
      if (verification.taskId !== task)
        throw new RigorError(
          "Linked verification taskId does not match --task",
          EXIT.policyViolation
        );
      verificationArtifactId = verification.artifactId;
    }
    const event = await scanTestIntegrity(root, {
      task,
      base,
      head,
      attemptArtifactId,
      verificationArtifactId,
      note
    });
    const saved = await saveCollectionArtifact(
      root,
      task,
      "test-integrity",
      "test-integrity-event",
      event
    );
    output({ ...event, saved });
    return EXIT.success;
  }
  if (command === "test-integrity-classify") {
    const event = parseTestIntegrityEvent(
      await readJson(option(args, "--event"))
    );
    const input = parseClassificationInput(
      await readJson(option(args, "--input"))
    );
    if (await hasUnfinishedAttempt(root, event.taskId))
      throw new RigorError(
        "Refusing to classify while an attempt is unfinished for this task",
        EXIT.policyViolation
      );
    const classification = createClassification(input, event);
    const saved = await saveCollectionArtifact(
      root,
      event.taskId,
      "test-integrity",
      "test-integrity-classification",
      classification
    );
    output({ ...classification, saved });
    return EXIT.success;
  }
  if (command === "ci") {
    const result = await ciVerify(
      root,
      option(args, "--base"),
      option(args, "--head")
    );
    output(result);
    return result.status === "passed" ? EXIT.success : EXIT.policyViolation;
  }
  throw new RigorError(`Unknown command: ${command}`, EXIT.inputError);
}
var entryName = import_node_process.default.argv[1] ? import_node_path12.default.basename(import_node_process.default.argv[1]) : "";
var isEntry = entryName === "rigor.cjs" || entryName === "rigor-ci.cjs" || entryName === "cli.ts";
if (isEntry) {
  main().then((code) => {
    import_node_process.default.exitCode = code;
  }).catch((error) => {
    if (error instanceof RigorError) {
      import_node_process.default.stderr.write(`rigor: ${error.message}
`);
      import_node_process.default.exitCode = error.exitCode;
    } else {
      import_node_process.default.stderr.write(
        "rigor: internal error; re-run with validated inputs and inspect local logs\n"
      );
      import_node_process.default.exitCode = EXIT.internalError;
    }
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  main
});
