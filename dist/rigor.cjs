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
var import_node_path9 = __toESM(require("node:path"), 1);
var import_node_process = __toESM(require("node:process"), 1);

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
  const digest = (0, import_node_crypto.createHash)("sha256");
  for (const file of files) {
    digest.update(`path\0${file}\0`);
    const target = import_node_path2.default.join(root, file);
    let info;
    try {
      info = await (0, import_promises.lstat)(target);
    } catch (error) {
      if (error.code === "ENOENT") {
        digest.update("deleted\0");
        continue;
      }
      throw error;
    }
    digest.update(`mode\0${info.mode}\0`);
    if (info.isSymbolicLink()) {
      digest.update(`symlink\0${await (0, import_promises.readlink)(target)}\0`);
      continue;
    }
    if (!info.isFile())
      throw new RigorError(
        `Cannot hash non-file repository path: ${file}`,
        EXIT.inputError
      );
    for await (const chunk of (0, import_node_fs.createReadStream)(target)) digest.update(chunk);
    digest.update("\0");
  }
  return digest.digest("hex");
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
var ROUTING_INPUT_SCHEMA = "rigor.routing-input.v1";
var MODEL_PROFILES_SCHEMA = "rigor.model-profiles.v1";
var ROUTING_DECISION_SCHEMA = "rigor.routing-decision.v1";
var ATTEMPT_SCHEMA = "rigor.attempt.v1";
var CONSULTATION_SCHEMA = "rigor.consultation.v1";
var CONSULTATION_REQUEST_SCHEMA = "rigor.consultation-request.v1";
var CONSULTATION_SESSION_SCHEMA = "rigor.consultation-session.v1";
var CONSULTATION_RESULT_INPUT_SCHEMA = "rigor.consultation-result-input.v1";
var ROUTING_PLAN_SCHEMA = "rigor.routing-plan.v1";
var ATTEMPT_SESSION_SCHEMA = "rigor.attempt-session.v1";
var ATTEMPT_RESULT_INPUT_SCHEMA = "rigor.attempt-result-input.v1";

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
    treeHash: await treeHash(root, [".rigor/evidence/", ".rigor/events.jsonl"]),
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
  const findings = [];
  const rulesKnown = input.rules.status === 200;
  const classicKnown = input.protection.status === 200 || input.protection.status === 404;
  const ruleset = rulesetFacts(rulesKnown ? input.rules.body : null);
  const classic = classicFacts(
    input.protection.status === 200 ? input.protection.body : null
  );
  const branchRequirement = (id, fromRuleset, fromClassic, requirement) => {
    if (rulesKnown && fromRuleset || classicKnown && fromClassic) {
      findings.push({ id, status: "satisfied", detail: requirement });
    } else if (!rulesKnown && !classicKnown) {
      findings.push({
        id,
        status: "unverifiable",
        detail: `${requirement}: branch rules and classic protection could not be fully read with the available credentials`
      });
    } else if (!classicKnown) {
      findings.push({
        id,
        status: "unverifiable",
        detail: `${requirement}: not satisfied by rulesets, and classic protection could not be fully read with the available credentials`
      });
    } else {
      findings.push({
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
    findings.push({
      id: "codeowners-sampled-coverage",
      status: "unverifiable",
      detail: "CODEOWNERS could not be fully read with the available credentials"
    });
  } else if (input.codeowners.state === "missing") {
    findings.push({
      id: "codeowners-sampled-coverage",
      status: "failed",
      detail: "no CODEOWNERS file exists at .github/CODEOWNERS, CODEOWNERS, or docs/CODEOWNERS"
    });
  } else {
    const entries = parseCodeowners(input.codeowners.text);
    const uncovered = input.sampledPaths.filter(
      (pathname) => codeownersOwners(entries, pathname).length === 0
    );
    findings.push(
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
      findings.push({
        id: "deployment-environments",
        status: "satisfied",
        detail: "no deployment environments are configured"
      });
    } else if (unprotected.length === 0) {
      findings.push({
        id: "deployment-environments",
        status: "satisfied",
        detail: `all ${String(list.length)} deployment environments have protection rules`
      });
    } else {
      findings.push({
        id: "deployment-environments",
        status: "failed",
        detail: `deployment environments without protection rules: ${unprotected.join(", ")}`
      });
    }
  } else {
    findings.push({
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
    findings,
    status: findings.every((finding) => finding.status === "satisfied") ? "passed" : "failed"
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
async function governanceVerify(policy, options, read) {
  const base = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
  const branch = encodeURIComponent(options.branch);
  const rules = await read(`${base}/rules/branches/${branch}?per_page=100`);
  const protection = await read(`${base}/branches/${branch}/protection`);
  const codeowners = await readCodeowners(read, base);
  const environments = await read(`${base}/environments?per_page=100`);
  return evaluateGovernance({
    repository: `${options.owner}/${options.repo}`,
    branch: options.branch,
    requiredCheckContext: options.requiredCheckContext,
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
function parseRoutingInput(value) {
  const item = record(value, "routing input");
  if (item.schemaVersion !== ROUTING_INPUT_SCHEMA)
    throw new RigorError("Unsupported routing input schema", EXIT.inputError);
  const signals = record(item.signals, "signals");
  const budget = record(item.budget, "budget");
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
    signals: {
      complexity: oneOf(signals.complexity, signalLevels, "complexity"),
      ambiguity: oneOf(signals.ambiguity, signalLevels, "ambiguity"),
      novelty: oneOf(signals.novelty, signalLevels, "novelty"),
      verificationStrength: oneOf(
        signals.verificationStrength,
        verificationStrengths,
        "verificationStrength"
      )
    },
    assessmentReasons,
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
    }
  };
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
function exclusionReason(candidate, input, preflight, required) {
  if (!candidate.enabled) return "DISABLED";
  if (!candidate.purposes.includes(input.purpose)) return "PURPOSE_UNSUPPORTED";
  if (preflight.externalTransmission === "denied" && candidate.requiresAdditionalExternalTransmission)
    return "EXTERNAL_TRANSMISSION_DENIED";
  if (capabilityClasses.indexOf(candidate.capabilityClass) < capabilityClasses.indexOf(required))
    return "INSUFFICIENT_CAPABILITY";
  if (candidate.relativeCost > input.budget.maxRelativeCost)
    return "BUDGET_EXCEEDED";
  return null;
}
function route(preflight, input, profiles) {
  if (input.taskId !== preflight.taskId)
    throw new RigorError(
      "Routing taskId does not match preflight",
      EXIT.inputError
    );
  const required = requiredCapability(input);
  const eligible = [];
  const excluded = [];
  for (const candidate of profiles.candidates) {
    const reasonCode = exclusionReason(candidate, input, preflight, required);
    if (reasonCode) excluded.push({ candidateId: candidate.id, reasonCode });
    else eligible.push(candidate);
  }
  eligible.sort(
    (left, right) => left.relativeCost - right.relativeCost || capabilityClasses.indexOf(left.capabilityClass) - capabilityClasses.indexOf(right.capabilityClass) || left.id.localeCompare(right.id)
  );
  const selected = eligible[0];
  const selection = selected ? {
    candidateId: selected.id,
    provider: selected.provider,
    ...selected.model === void 0 ? {} : { model: selected.model },
    capabilityClass: selected.capabilityClass,
    relativeCost: selected.relativeCost
  } : null;
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
    status: selection ? "selected" : "unroutable"
  };
}
function createRoutingPlan(decision, preflight, contract, now = /* @__PURE__ */ new Date()) {
  if (decision.status !== "selected" || decision.selection === null || decision.taskId !== contract.taskId || preflight.taskId !== contract.taskId)
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
  } = decision;
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
          "BUDGET_EXCEEDED"
        ],
        "reasonCode"
      )
    };
  });
  return plan;
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
function oneOf2(value, values, name) {
  if (typeof value !== "string" || !values.includes(value))
    throw new RigorError(`${name} is invalid`, EXIT.inputError);
  return value;
}
function optionalText(value, name) {
  return value === void 0 ? void 0 : textField(value, name, 512);
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
    mode: oneOf2(item.mode, modes, "mode"),
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
    mode: oneOf2(item.mode, modes, "mode"),
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
  if (item.schemaVersion !== CONSULTATION_RESULT_INPUT_SCHEMA)
    throw new RigorError(
      "Unsupported consultation result input schema",
      EXIT.inputError
    );
  if (!Number.isInteger(item.findingCount) || item.findingCount < 0)
    throw new RigorError("findingCount is invalid", EXIT.inputError);
  const result = {
    schemaVersion: CONSULTATION_RESULT_INPUT_SCHEMA,
    taskId: taskId(item.taskId),
    status: oneOf2(item.status, ["completed", "failed"], "status"),
    outcome: oneOf2(item.outcome, outcomes, "outcome"),
    findingCount: item.findingCount,
    requiredActions: strings(item.requiredActions, "requiredActions", 100),
    usageStatus: oneOf2(
      item.usageStatus,
      ["recorded", "unavailable"],
      "usageStatus"
    )
  };
  for (const [key, value2] of Object.entries({
    externalJobId: optionalText(item.externalJobId, "externalJobId"),
    externalSessionId: optionalText(
      item.externalSessionId,
      "externalSessionId"
    ),
    externalTurnId: optionalText(item.externalTurnId, "externalTurnId"),
    model: optionalText(item.model, "model"),
    reasoningEffort: optionalText(item.reasoningEffort, "reasoningEffort")
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
    schemaVersion: CONSULTATION_SCHEMA,
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
var import_promises7 = require("node:fs/promises");
var import_node_path8 = __toESM(require("node:path"), 1);
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
function oneOf3(value, values, name) {
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
  const directory = import_node_path8.default.join(root, ".rigor", "evidence", task, "attempts");
  let names;
  try {
    names = await (0, import_promises7.readdir)(directory);
  } catch (error) {
    if (error.code === "ENOENT")
      return { count: 0, unfinished: [] };
    throw error;
  }
  const sessions = /* @__PURE__ */ new Set();
  const finished = /* @__PURE__ */ new Set();
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    let item;
    try {
      item = record(
        JSON.parse(
          await (0, import_promises7.readFile)(import_node_path8.default.join(directory, name), "utf8")
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
  return {
    count: sessions.size,
    unfinished: [...sessions].filter((id) => !finished.has(id))
  };
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
    capabilityClass: oneOf3(
      selection.capabilityClass,
      capabilities,
      "selection.capabilityClass"
    ),
    purpose: oneOf3(item.purpose, purposes2, "purpose"),
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
    status: oneOf3(item.status, ["completed", "failed", "cancelled"], "status")
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
    ...verification === void 0 ? {} : { verificationArtifactId: verification.artifactId }
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
      "Usage: rigor <setup|preflight|contract|route|attempt-start|attempt-finish|consult-start|consult-finish|verify|escalate|review|retrospect|governance|ci|hook> [options]\n"
    );
    return EXIT.success;
  }
  const root = await findGitRoot(cwd);
  if (command === "setup" || command === "upgrade") {
    const bundle = import_node_process.default.env.RIGOR_BUNDLE_PATH ?? import_node_path9.default.resolve(import_node_process.default.argv[1] ?? "dist/rigor.cjs");
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
    const result = route(preflight, input, profiles);
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
var entryName = import_node_process.default.argv[1] ? import_node_path9.default.basename(import_node_process.default.argv[1]) : "";
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
