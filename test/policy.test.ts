import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/policy.js";
import { defaultPolicy } from "../src/setup.js";
import { globToRegExp, normalizeRepoPath } from "../src/paths.js";
import type { GitFacts, Intent } from "../src/types.js";

const git: GitFacts = {
  root: "/repo",
  head: "abc",
  dirty: false,
  changedPaths: [],
};
const cases = [
  { path: "docs/read me.md", tier: "low", transmission: "allowed" },
  { path: "src/index.ts", tier: "high", transmission: "allowed" },
  { path: "src/auth/login.ts", tier: "critical", transmission: "allowed" },
  { path: "service/.env.production", tier: "critical", transmission: "denied" },
  { path: ".rigor/policy.json", tier: "critical", transmission: "allowed" },
] as const;

for (const item of cases) {
  test(`evaluates ${item.path}`, () => {
    const intent: Intent = {
      schemaVersion: "rigor.intent.v1",
      taskId: "T-1",
      summary: "test",
      plannedPaths: [item.path],
    };
    const result = evaluate(defaultPolicy("repo"), intent, git, new Date(0));
    assert.equal(result.riskTier, item.tier);
    assert.equal(result.externalTransmission, item.transmission);
  });
}

test("highest risk wins regardless of rule order", () => {
  const policy = defaultPolicy("repo");
  policy.rules.reverse();
  const intent: Intent = {
    schemaVersion: "rigor.intent.v1",
    taskId: "T-1",
    summary: "test",
    plannedPaths: ["src/auth/a.ts", "docs/a.md"],
  };
  assert.equal(evaluate(policy, intent, git).riskTier, "critical");
});

test("normalizes unicode and spaces and rejects unsafe paths", () => {
  assert.equal(normalizeRepoPath("資料/a b.ts"), "資料/a b.ts");
  assert.throws(() => normalizeRepoPath("../secret"));
  assert.throws(() => normalizeRepoPath("/absolute"));
  assert.throws(() => normalizeRepoPath("line\nbreak"));
  assert.throws(() => normalizeRepoPath("a/../../b"));
});

test("glob matching is segment aware", () => {
  assert.match("src/a/b.ts", globToRegExp("src/**"));
  assert.match(".env", globToRegExp("**/.env*"));
  assert.doesNotMatch("source/a.ts", globToRegExp("src/*"));
  assert.doesNotMatch("SRC/a.ts", globToRegExp("src/*"));
});
