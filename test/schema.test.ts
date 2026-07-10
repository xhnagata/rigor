import test from "node:test";
import assert from "node:assert/strict";
import { defaultPolicy } from "../src/setup.js";
import { parseIntent, parsePolicy } from "../src/schema.js";

test("policy round trips", () =>
  assert.deepEqual(parsePolicy(defaultPolicy("repo")), defaultPolicy("repo")));
test("unknown schema fails closed", () =>
  assert.throws(() =>
    parsePolicy({ ...defaultPolicy("repo"), schemaVersion: "future" }),
  ));
test("duplicate rule/check IDs fail", () => {
  const policy = defaultPolicy("repo");
  policy.checks[0]!.id = policy.rules[0]!.id;
  assert.throws(() => parsePolicy(policy));
});
test("intent rejects traversal and malformed IDs", () => {
  assert.throws(() =>
    parseIntent({
      schemaVersion: "rigor.intent.v1",
      taskId: "../x",
      summary: "x",
      plannedPaths: ["src/a"],
    }),
  );
  assert.throws(() =>
    parseIntent({
      schemaVersion: "rigor.intent.v1",
      taskId: "T",
      summary: "x",
      plannedPaths: ["../a"],
    }),
  );
});
