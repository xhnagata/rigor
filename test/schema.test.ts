import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultPolicy } from "../src/setup.js";
import { parseIntent, parsePolicy } from "../src/schema.js";
import {
  buildTestIntegrityEvent,
  createClassification,
  parseClassificationInput,
  parseTestIntegrityEvent,
} from "../src/test-integrity.js";
import type { TestIntegrityEvent, TestIntegritySignal } from "../src/types.js";

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
// A small JSON-Schema-subset validator: enough to confirm the produced
// artifacts match the shipped schema files (additionalProperties false, const,
// enum, type, required, items, oneOf, pattern, length/count bounds). Not a
// general validator; scoped to the constructs the three schemas use.
type Schema = Record<string, unknown>;

function typeOk(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "integer")
    return typeof value === "number" && Number.isInteger(value);
  if (type === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function validate(value: unknown, schema: Schema, at = "$"): string[] {
  const errors: string[] = [];
  if ("const" in schema && value !== schema.const)
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    errors.push(`${at}: not in enum`);
  if (typeof schema.type === "string" && !typeOk(value, schema.type))
    errors.push(`${at}: expected type ${schema.type}`);
  if (Array.isArray(schema.type) && !schema.type.some((t) => typeOk(value, t)))
    errors.push(`${at}: expected one of types ${schema.type.join(",")}`);
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(
      (sub) => validate(value, sub as Schema, at).length === 0,
    );
    if (matches.length !== 1)
      errors.push(`${at}: oneOf matched ${matches.length}`);
  }
  if (typeof value === "string") {
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern).test(value)
    )
      errors.push(`${at}: pattern`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      errors.push(`${at}: minLength`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      errors.push(`${at}: maxLength`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      errors.push(`${at}: maxItems`);
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      errors.push(`${at}: minItems`);
    if (schema.items)
      value.forEach((item, i) =>
        errors.push(...validate(item, schema.items as Schema, `${at}[${i}]`)),
      );
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties as Record<string, Schema>) ?? {};
    if (
      typeof schema.maxProperties === "number" &&
      Object.keys(object).length > schema.maxProperties
    )
      errors.push(`${at}: maxProperties`);
    for (const required of (schema.required as string[]) ?? [])
      if (!(required in object)) errors.push(`${at}.${required}: required`);
    for (const [key, child] of Object.entries(object)) {
      if (key in properties)
        errors.push(...validate(child, properties[key]!, `${at}.${key}`));
      else if (schema.additionalProperties === false)
        errors.push(`${at}.${key}: additional property`);
      else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      )
        errors.push(
          ...validate(
            child,
            schema.additionalProperties as Schema,
            `${at}.${key}`,
          ),
        );
    }
  }
  return errors;
}

async function loadSchema(name: string): Promise<Schema> {
  return JSON.parse(
    await readFile(
      path.join(import.meta.dirname, "..", "schemas", name),
      "utf8",
    ),
  ) as Schema;
}

const sampleSignal: TestIntegritySignal = {
  signalId: "TI-05",
  threatClass: "skip-only-todo",
  label: "advisory-interpretation",
  computation: "deterministic",
  detector: { name: "diff-token-scan", version: "0.1.0" },
  value: { addedMarkers: 1, removedMarkers: 0, matchedPaths: 1 },
  paths: ["test/x.test.ts"],
  matchDigest: "a".repeat(64),
  note: null,
};

function sampleEvent(): TestIntegrityEvent {
  return buildTestIntegrityEvent(
    {
      taskId: "GH-22",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      worktreeDigest: null,
      attemptArtifactId: null,
      verificationArtifactId: null,
      note: null,
    },
    [sampleSignal],
    new Date(0),
  );
}

test("test-integrity event matches its schema and round-trips", async () => {
  const event = sampleEvent();
  const schema = await loadSchema("test-integrity-event.v1.schema.json");
  assert.deepEqual(validate(event, schema), []);
  assert.deepEqual(parseTestIntegrityEvent(event), event);
});

test("a tampered test-integrity event fails schema validation", async () => {
  const schema = await loadSchema("test-integrity-event.v1.schema.json");
  const extra = { ...sampleEvent(), surprise: true } as Record<string, unknown>;
  assert.notEqual(validate(extra, schema).length, 0);
  const badMode = { ...sampleEvent(), mode: "enforce" };
  assert.notEqual(validate(badMode, schema).length, 0);
});

test("test-integrity classification input matches its schema", async () => {
  const input = {
    schemaVersion: "rigor.test-integrity-classification-input.v1",
    taskId: "GH-22",
    eventArtifactId: "test-integrity-event_1",
    classifiedBy: "human",
    verdicts: [{ signalId: "TI-05", verdict: "false-positive" }],
  };
  const schema = await loadSchema(
    "test-integrity-classification-input.v1.schema.json",
  );
  assert.deepEqual(validate(input, schema), []);
  assert.deepEqual(parseClassificationInput(input).classifiedBy, "human");
});

test("test-integrity classification matches its schema", async () => {
  const event = sampleEvent();
  const classification = createClassification(
    parseClassificationInput({
      schemaVersion: "rigor.test-integrity-classification-input.v1",
      taskId: event.taskId,
      eventArtifactId: event.artifactId,
      classifiedBy: "human",
      verdicts: [
        { signalId: "TI-05", verdict: "true-positive", note: "matches AC" },
      ],
    }),
    event,
    new Date(0),
  );
  const schema = await loadSchema(
    "test-integrity-classification.v1.schema.json",
  );
  assert.deepEqual(validate(classification, schema), []);
});

test("test-integrity parsers fail closed on an unknown schema", () => {
  assert.throws(() =>
    parseTestIntegrityEvent({ schemaVersion: "rigor.test-integrity-event.v2" }),
  );
  assert.throws(() =>
    parseClassificationInput({
      schemaVersion: "future",
      classifiedBy: "human",
    }),
  );
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
