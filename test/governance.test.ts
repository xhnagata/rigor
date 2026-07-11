import test from "node:test";
import assert from "node:assert/strict";
import {
  codeownersOwners,
  githubReader,
  evaluateGovernance,
  governanceVerify,
  parseBranch,
  parseCodeowners,
  parseRepository,
  representativePaths,
  type GitHubResponse,
} from "../src/governance.js";
import { defaultPolicy } from "../src/setup.js";

const rulesetBody = [
  {
    type: "pull_request",
    parameters: {
      required_approving_review_count: 1,
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: true,
      require_last_push_approval: true,
    },
  },
  {
    type: "required_status_checks",
    parameters: { required_status_checks: [{ context: "rigor" }] },
  },
  { type: "non_fast_forward" },
  { type: "deletion" },
];

const codeownersText = [
  "# governed paths",
  "* @org/maintainers",
  "/.rigor/ @org/governance",
  "/.github/workflows/ @org/governance",
].join("\n");

function evaluation(overrides: {
  rules?: GitHubResponse;
  protection?: GitHubResponse;
  codeowners?: { state: "found" | "missing" | "unverifiable"; text: string };
  environments?: GitHubResponse;
  sampledPaths?: string[];
  requiredCheckContext?: string;
}) {
  const codeowners = overrides.codeowners ?? {
    state: "found" as const,
    text: codeownersText,
  };
  return evaluateGovernance({
    repository: "o/r",
    branch: "main",
    requiredCheckContext: overrides.requiredCheckContext ?? "rigor",
    sampledPaths: overrides.sampledPaths ?? [
      ".rigor/governed",
      ".github/workflows/governed",
    ],
    rules: overrides.rules ?? { status: 200, body: rulesetBody },
    protection: overrides.protection ?? { status: 404, body: null },
    codeowners: { ...codeowners, source: "CODEOWNERS" },
    environments: overrides.environments ?? {
      status: 200,
      body: { total_count: 0, environments: [] },
    },
  });
}

test("governance passes when rulesets satisfy every requirement", () => {
  const report = evaluation({});
  assert.equal(report.status, "passed");
  assert.ok(report.findings.every((item) => item.status === "satisfied"));
});

test("governance fails closed when no rules protect the branch", () => {
  const report = evaluation({ rules: { status: 200, body: [] } });
  assert.equal(report.status, "failed");
  const finding = report.findings.find(
    (item) => item.id === "pull-request-required",
  );
  assert.equal(finding?.status, "failed");
});

test("unreadable configuration is unverifiable, not passing", () => {
  const report = evaluation({
    rules: { status: 0, body: null },
    protection: { status: 403, body: null },
    environments: { status: 403, body: null },
  });
  assert.equal(report.status, "failed");
  assert.ok(
    report.findings
      .filter((item) => item.id !== "codeowners-sampled-coverage")
      .every((item) => item.status === "unverifiable"),
  );
});

test("classic branch protection alone can satisfy requirements", () => {
  const report = evaluation({
    rules: { status: 200, body: [] },
    protection: {
      status: 200,
      body: {
        required_pull_request_reviews: {
          required_approving_review_count: 2,
          dismiss_stale_reviews: true,
          require_code_owner_reviews: true,
          require_last_push_approval: true,
        },
        required_status_checks: { contexts: ["rigor"], checks: [] },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
      },
    },
  });
  assert.equal(report.status, "passed");
});

test("a missing required check context fails", () => {
  const report = evaluation({ requiredCheckContext: "other-check" });
  const finding = report.findings.find((item) => item.id === "required-check");
  assert.equal(finding?.status, "failed");
});

test("unprotected deployment environments fail", () => {
  const report = evaluation({
    environments: {
      status: 200,
      body: {
        total_count: 2,
        environments: [
          {
            name: "production",
            protection_rules: [{ type: "required_reviewers" }],
          },
          { name: "staging", protection_rules: [] },
        ],
      },
    },
  });
  const finding = report.findings.find(
    (item) => item.id === "deployment-environments",
  );
  assert.equal(finding?.status, "failed");
  assert.ok(finding?.detail.includes("staging"));
});

test("codeowners coverage flags governed paths without owners", () => {
  const report = evaluation({
    codeowners: { state: "found", text: "/docs/ @org/docs" },
  });
  const finding = report.findings.find(
    (item) => item.id === "codeowners-sampled-coverage",
  );
  assert.equal(finding?.status, "failed");
  assert.ok(finding?.detail.includes(".rigor/governed"));
});

test("missing codeowners fails and unreadable codeowners is unverifiable", () => {
  const missing = evaluation({ codeowners: { state: "missing", text: "" } });
  assert.equal(
    missing.findings.find((item) => item.id === "codeowners-sampled-coverage")
      ?.status,
    "failed",
  );
  const unreadable = evaluation({
    codeowners: { state: "unverifiable", text: "" },
  });
  assert.equal(
    unreadable.findings.find(
      (item) => item.id === "codeowners-sampled-coverage",
    )?.status,
    "unverifiable",
  );
});

test("codeowners uses last-match-wins and empty owners remove coverage", () => {
  const entries = parseCodeowners(
    ["* @org/all", "/.rigor/ @org/governance", "/.rigor/"].join("\n"),
  );
  assert.deepEqual(codeownersOwners(entries, ".rigor/policy.json"), []);
  const restored = parseCodeowners(
    ["/.rigor/", "/.rigor/ @org/governance"].join("\n"),
  );
  assert.deepEqual(codeownersOwners(restored, ".rigor/policy.json"), [
    "@org/governance",
  ]);
});

test("codeowners matching honors anchoring and star depth", () => {
  const entries = parseCodeowners("docs/* @org/docs");
  assert.deepEqual(codeownersOwners(entries, "docs/a.md"), ["@org/docs"]);
  assert.deepEqual(codeownersOwners(entries, "docs/sub/a.md"), []);
  const anyDepth = parseCodeowners("*.md @org/docs");
  assert.deepEqual(codeownersOwners(anyDepth, "docs/sub/a.md"), ["@org/docs"]);
  const recursive = parseCodeowners("/docs/** @org/docs");
  assert.deepEqual(codeownersOwners(recursive, "docs/sub/a.md"), ["@org/docs"]);
});

test("codeowners matching is case sensitive", () => {
  const entries = parseCodeowners("/Docs/ @org/docs");
  assert.deepEqual(codeownersOwners(entries, "docs/a.md"), []);
});

test("codeowners handles escaped spaces, non-ASCII paths, and comments", () => {
  const entries = parseCodeowners(
    [
      "/docs/release\\ notes.md @org/docs # inline comment",
      "/資料/ @org/docs",
      "# comment line",
      "!negation-is-not-supported @nobody",
    ].join("\r\n"),
  );
  assert.deepEqual(codeownersOwners(entries, "docs/release notes.md"), [
    "@org/docs",
  ]);
  assert.deepEqual(codeownersOwners(entries, "資料/報告書.md"), ["@org/docs"]);
  assert.deepEqual(codeownersOwners(entries, "negation-is-not-supported"), []);
});

test("representative paths cover protected policy globs", () => {
  const paths = representativePaths(defaultPolicy("repo"));
  assert.ok(paths.includes(".rigor/governed"));
  assert.ok(paths.includes(".github/workflows/governed"));
  assert.ok(paths.includes("CODEOWNERS"));
  assert.ok(paths.every((item) => !item.includes("*")));
});

test("repository and branch inputs are validated", () => {
  assert.deepEqual(parseRepository("owner/repo.name"), {
    owner: "owner",
    repo: "repo.name",
  });
  assert.throws(() => parseRepository("owner"));
  assert.throws(() => parseRepository("owner/re po"));
  assert.throws(() => parseRepository("owner/.."));
  assert.throws(() => parseRepository("owner/repo/extra"));
  assert.equal(parseBranch("release/1.x"), "release/1.x");
  assert.throws(() => parseBranch("bad..range"));
  assert.throws(() => parseBranch("has space"));
  assert.throws(() => parseBranch("wild*card"));
  assert.throws(() => parseBranch("ctrl\u0007char"));
});

test("governanceVerify issues only repository-scoped GET reads", async () => {
  const requested: string[] = [];
  const report = await governanceVerify(
    defaultPolicy("repo"),
    { owner: "o", repo: "r", branch: "feat/x", requiredCheckContext: "rigor" },
    (requestPath) => {
      requested.push(requestPath);
      if (requestPath === "/repos/o/r/rules/branches/feat%2Fx?per_page=100")
        return Promise.resolve({ status: 200, body: rulesetBody });
      if (requestPath === "/repos/o/r/contents/CODEOWNERS")
        return Promise.resolve({
          status: 200,
          body: {
            content: Buffer.from("* @org/maintainers\n").toString("base64"),
          },
        });
      if (requestPath === "/repos/o/r/environments?per_page=100")
        return Promise.resolve({
          status: 200,
          body: { total_count: 0, environments: [] },
        });
      return Promise.resolve({ status: 404, body: null });
    },
  );
  assert.ok(requested.every((item) => item.startsWith("/repos/o/r/")));
  assert.equal(report.status, "passed");
  assert.equal(report.branch, "feat/x");
});

test("githubReader sends GET-only requests to the fixed GitHub API host", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fakeFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  }) as typeof fetch;
  const read = githubReader("token-abc", fakeFetch);
  const result = await read("/repos/o/r/environments");
  assert.deepEqual(result, { status: 200, body: { ok: true } });
  const call = calls[0];
  assert.equal(call?.url, "https://api.github.com/repos/o/r/environments");
  assert.equal(call?.init?.method, "GET");
  assert.equal(call?.init?.redirect, "error");
  assert.ok(call?.init?.signal instanceof AbortSignal);
  const headers = call?.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer token-abc");
});

test("githubReader treats undecodable bodies as unverifiable", async () => {
  const reader = (response: Response | Error) =>
    githubReader(undefined, (() =>
      response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response)) as typeof fetch);
  assert.deepEqual(
    await reader(new Response("not json", { status: 200 }))("/repos/o/r"),
    { status: 0, body: null },
  );
  assert.deepEqual(
    await reader(new Response("x".repeat(1_000_001), { status: 200 }))(
      "/repos/o/r",
    ),
    { status: 0, body: null },
  );
  assert.deepEqual(
    await reader(new Response(null, { status: 200 }))("/repos/o/r"),
    { status: 0, body: null },
  );
  assert.deepEqual(
    await reader(new Response(null, { status: 404 }))("/repos/o/r"),
    { status: 404, body: null },
  );
  assert.deepEqual(await reader(new Error("offline"))("/repos/o/r"), {
    status: 0,
    body: null,
  });
});

test("githubReader treats paginated responses with a next page as unverifiable", async () => {
  const paged = new Response("[]", {
    status: 200,
    headers: {
      link: '<https://api.github.com/repos/o/r/environments?page=2>; rel="next", <https://api.github.com/repos/o/r/environments?page=3>; rel="last"',
    },
  });
  const read = githubReader(undefined, (() =>
    Promise.resolve(paged)) as typeof fetch);
  assert.deepEqual(await read("/repos/o/r/environments"), {
    status: 0,
    body: null,
  });
  const lastOnly = new Response("[]", {
    status: 200,
    headers: {
      link: '<https://api.github.com/repos/o/r/environments?page=1>; rel="prev"',
    },
  });
  const readLast = githubReader(undefined, (() =>
    Promise.resolve(lastOnly)) as typeof fetch);
  assert.deepEqual(await readLast("/repos/o/r/environments"), {
    status: 200,
    body: [],
  });
});

test("githubReader rejects malformed tokens", () => {
  assert.throws(() => githubReader("bad token"));
  assert.throws(() => githubReader("bad\ntoken"));
});
