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
var import_node_path8 = __toESM(require("node:path"), 1);
var import_node_process = __toESM(require("node:process"), 1);

// src/artifacts.ts
var import_promises2 = require("node:fs/promises");
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
var import_node_path2 = __toESM(require("node:path"), 1);
async function run(command, args, cwd, timeoutMs = 3e4, outputLimit = 1e6) {
  const start = performance.now();
  return await new Promise((resolve, reject) => {
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
      reject(error);
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
async function showFile(root, sha, file) {
  await verifyCommit(root, sha);
  const safe = normalizeRepoPath(file);
  const result = await run("git", ["show", `${sha}:${safe}`], root);
  if (result.code !== 0) return null;
  return result.stdout.toString("utf8");
}
async function treeHash(root) {
  const tracked = await git(root, ["ls-files", "-z"]);
  const status = await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all"
  ]);
  const { createHash: createHash2 } = await import("node:crypto");
  return createHash2("sha256").update(tracked).update(status).digest("hex");
}

// src/util.ts
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path3 = __toESM(require("node:path"), 1);
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function hash(value) {
  return (0, import_node_crypto.createHash)("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
}
function artifactId(kind) {
  return `${kind}_${(0, import_node_crypto.randomUUID)()}`;
}
async function readJson(file) {
  try {
    const text = await (0, import_promises.readFile)(file, "utf8");
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
  await (0, import_promises.mkdir)(import_node_path3.default.dirname(file), { recursive: true });
  await (0, import_promises.writeFile)(file, `${JSON.stringify(value, null, 2)}
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
      const stat = await (0, import_promises.lstat)(cursor);
      if (stat.isSymbolicLink()) {
        const resolved = await (0, import_promises.realpath)(cursor);
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

// src/types.ts
var POLICY_SCHEMA = "rigor.policy.v1";
var INTENT_SCHEMA = "rigor.intent.v1";
var PREFLIGHT_SCHEMA = "rigor.preflight.v1";
var CONTRACT_SCHEMA = "rigor.contract.v1";
var CONTRACT_INPUT_SCHEMA = "rigor.contract-input.v1";
var VERIFY_SCHEMA = "rigor.verification.v1";
var ESCALATION_SCHEMA = "rigor.escalation.v1";
var ESCALATION_INPUT_SCHEMA = "rigor.escalation-input.v1";
var REVIEW_SCHEMA = "rigor.review.v1";

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
  for (const check of policy.checks.filter(
    (item) => contract.requiredChecks.includes(item.id)
  )) {
    let result;
    try {
      result = await run(check.command, check.args, root, check.timeoutMs);
    } catch {
      checks.push({
        id: check.id,
        status: "error",
        exitCode: null,
        durationMs: 0,
        outputDigest: hash("spawn-error")
      });
      continue;
    }
    const combined = Buffer.concat([result.stdout, result.stderr]);
    checks.push({
      id: check.id,
      status: result.timedOut ? "timed_out" : result.code === 0 ? "passed" : "failed",
      exitCode: result.code,
      durationMs: result.durationMs,
      outputDigest: hash(combined.toString("utf8"))
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
    treeHash: await treeHash(root),
    changedPaths,
    scopeViolations,
    checks,
    status: passed ? "passed" : "failed"
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
async function appendEvent(root, event) {
  const directory = import_node_path4.default.join(root, ".rigor");
  await (0, import_promises2.mkdir)(directory, { recursive: true });
  await (0, import_promises2.appendFile)(
    import_node_path4.default.join(directory, "events.jsonl"),
    `${JSON.stringify(event)}
`,
    { mode: 384 }
  );
}
async function retrospect(root) {
  let content = "";
  try {
    content = await (0, import_promises2.readFile)(import_node_path4.default.join(root, ".rigor", "events.jsonl"), "utf8");
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
  return {
    schemaVersion: "rigor.retrospective.v1",
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    taskCount: tasks.size,
    eventCounts: counts
  };
}
async function loadPolicy(root) {
  return parsePolicy(await readJson(import_node_path4.default.join(root, ".rigor", "policy.json")));
}

// src/ci.ts
var import_promises4 = require("node:fs/promises");
var import_node_path6 = __toESM(require("node:path"), 1);

// src/setup.ts
var import_promises3 = require("node:fs/promises");
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
      const stat = await (0, import_promises3.lstat)(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        conflicts.push(candidate.relative);
        continue;
      }
      existing = await (0, import_promises3.readFile)(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const desired = candidate.copyFrom ? await (0, import_promises3.readFile)(candidate.copyFrom) : Buffer.from(candidate.content ?? "");
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
    await (0, import_promises3.mkdir)(import_node_path5.default.dirname(target), { recursive: true });
    await (0, import_promises3.writeFile)(target, desired, { flag: "wx" });
    if (candidate.mode) await (0, import_promises3.chmod)(target, candidate.mode);
    created.push(candidate.relative);
  }
  return { created, unchanged };
}
function policyWeakening(base, head) {
  const failures = [];
  if (base.defaultExternalTransmission === "deny" && head.defaultExternalTransmission === "allow")
    failures.push("default external-transmission policy was weakened");
  const headRules = new Map(head.rules.map((rule) => [rule.id, stable(rule)]));
  for (const rule of base.rules)
    if (headRules.get(rule.id) !== stable(rule))
      failures.push(`base rule changed or removed: ${rule.id}`);
  const headChecks = new Map(
    head.checks.map((check) => [check.id, stable(check)])
  );
  for (const check of base.checks)
    if (headChecks.get(check.id) !== stable(check))
      failures.push(`base check changed or removed: ${check.id}`);
  return failures;
}

// src/ci.ts
async function evidenceFiles(root) {
  const base = import_node_path6.default.join(root, ".rigor", "evidence");
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await (0, import_promises4.readdir)(dir, { withFileTypes: true });
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
  const failures = [];
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
      failures.push(
        ...policyWeakening(
          parsePolicy(JSON.parse(baseText)),
          headPolicy
        )
      );
    } catch {
      failures.push("base policy is invalid; repair it independently");
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
      failures.push(`existing test was deleted: ${removed}`);
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
      failures.push(`invalid evidence file: ${import_node_path6.default.relative(root, file)}`);
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
    failures.push(
      "no linked passing evidence covers the independently derived change set and head policy"
    );
  for (const check of headPolicy.checks) {
    let result;
    try {
      result = await run(check.command, check.args, root, check.timeoutMs);
    } catch {
      failures.push(`check could not start: ${check.id}`);
      continue;
    }
    if (result.timedOut || result.code !== 0)
      failures.push(`independent check failed: ${check.id}`);
  }
  return {
    status: failures.length === 0 ? "passed" : "failed",
    failures,
    changedPaths
  };
}

// src/hook.ts
var import_node_path7 = __toESM(require("node:path"), 1);
var import_promises5 = require("node:fs/promises");
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
    await (0, import_promises5.access)(import_node_path7.default.join(root, ".rigor"));
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

// src/cli.ts
function option(args, name, required = true) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : void 0;
  if (required && (!value || value.startsWith("--")))
    throw new RigorError(`Missing ${name}`, EXIT.inputError);
  return value;
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
      "Usage: rigor <setup|preflight|contract|verify|escalate|review|retrospect|ci|hook> [options]\n"
    );
    return EXIT.success;
  }
  const root = await findGitRoot(cwd);
  if (command === "setup" || command === "upgrade") {
    const bundle = import_node_process.default.env.RIGOR_BUNDLE_PATH ?? import_node_path8.default.resolve(import_node_process.default.argv[1] ?? "dist/rigor.cjs");
    output(await setup(root, bundle));
    return EXIT.success;
  }
  if (command === "hook") {
    if (args[0] !== "user-prompt")
      throw new RigorError("Unknown hook", EXIT.inputError);
    const decision = await userPromptHook(await stdinJson(), cwd);
    if (decision) output(decision);
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
    const result = createEscalation(
      parseEscalationInput(await readJson(option(args, "--input")))
    );
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
  if (command === "retrospect") {
    output(await retrospect(root));
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
var entryName = import_node_process.default.argv[1] ? import_node_path8.default.basename(import_node_process.default.argv[1]) : "";
var isEntry = entryName === "rigor.cjs" || entryName === "cli.ts";
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
