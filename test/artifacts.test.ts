import test from "node:test";
import assert from "node:assert/strict";
import { createContract, parseEscalationInput } from "../src/artifacts.js";
import { evaluate } from "../src/policy.js";
import { defaultPolicy } from "../src/setup.js";
import type { GitFacts, Intent } from "../src/types.js";

const policy = defaultPolicy("repo");
const git: GitFacts = {
  root: "/repo",
  head: "abc",
  dirty: false,
  changedPaths: [],
};
const intent: Intent = {
  schemaVersion: "rigor.intent.v1",
  taskId: "T-1",
  summary: "change",
  plannedPaths: ["src/a.ts"],
};
const preflight = evaluate(policy, intent, git);

test("contract enforces planned scope", () => {
  assert.throws(() =>
    createContract(policy, preflight, {
      schemaVersion: "rigor.contract-input.v1",
      taskId: "T-1",
      acceptanceCriteria: ["works"],
      allowedPaths: ["docs/**"],
      constraints: [],
    }),
  );
  const contract = createContract(policy, preflight, {
    schemaVersion: "rigor.contract-input.v1",
    taskId: "T-1",
    acceptanceCriteria: ["works"],
    allowedPaths: ["src/**"],
    constraints: [],
  });
  assert.deepEqual(contract.requiredChecks, ["git-diff-check"]);
});

test("escalation rejects duplicate attempts", () => {
  assert.throws(() =>
    parseEscalationInput({
      schemaVersion: "rigor.escalation-input.v1",
      taskId: "T-1",
      facts: ["failed"],
      attempts: [
        { action: "retry", result: "same" },
        { action: "retry", result: "same" },
      ],
      disprovedHypotheses: [],
      speculation: [],
      requestedDecision: "help",
    }),
  );
});
