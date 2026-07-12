import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRelease,
  releaseCiFact,
  type ReleaseCiFact,
  type ReleaseFacts,
} from "../src/release.js";
import type { GitHubReader } from "../src/governance.js";

function facts(overrides: Partial<ReleaseFacts> = {}): ReleaseFacts {
  return {
    version: "1.2.3",
    packageVersion: "1.2.3",
    manifestVersion: "1.2.3",
    branch: "main",
    expectedBranch: "main",
    head: "a".repeat(40),
    expectedSha: null,
    dirty: false,
    changelogVersions: ["1.2.3", "1.2.2"],
    bundleMatches: true,
    ciBundleMatches: true,
    requiredChecks: ["quality"],
    ci: { state: "success", detail: "all required checks succeeded" },
    ...overrides,
  };
}

function finding(report: ReturnType<typeof evaluateRelease>, id: string) {
  return report.findings.find((item) => item.id === id);
}

test("release passes when every finding is satisfied and CI succeeded", () => {
  const report = evaluateRelease(facts());
  assert.equal(report.status, "passed");
  assert.ok(report.findings.every((item) => item.status === "satisfied"));
  assert.deepEqual(report.requiredChecks, ["quality"]);
});

test("a dirty worktree fails clean-tree and the overall status", () => {
  const report = evaluateRelease(facts({ dirty: true }));
  assert.equal(finding(report, "clean-tree")?.status, "failed");
  assert.equal(report.status, "failed");
});

test("version mismatch across package, manifest, or request fails", () => {
  const pkg = evaluateRelease(facts({ packageVersion: "1.2.2" }));
  assert.equal(finding(pkg, "version-sync")?.status, "failed");
  assert.equal(pkg.status, "failed");
  assert.ok(
    finding(pkg, "version-sync")?.detail.includes("package.json=1.2.2"),
  );

  const manifest = evaluateRelease(facts({ manifestVersion: "9.9.9" }));
  assert.equal(finding(manifest, "version-sync")?.status, "failed");
  assert.ok(finding(manifest, "version-sync")?.detail.includes("9.9.9"));

  const requested = evaluateRelease(
    facts({
      version: "2.0.0",
      changelogVersions: ["2.0.0"],
    }),
  );
  assert.equal(finding(requested, "version-sync")?.status, "failed");
});

test("a missing changelog entry fails", () => {
  const report = evaluateRelease(facts({ changelogVersions: ["1.2.2"] }));
  assert.equal(finding(report, "changelog-entry")?.status, "failed");
  assert.equal(report.status, "failed");
});

test("a stale bundle fails bundle-built", () => {
  const report = evaluateRelease(facts({ bundleMatches: false }));
  assert.equal(finding(report, "bundle-built")?.status, "failed");
  assert.equal(report.status, "failed");
});

test("a drifted CI bundle fails ci-bundle-sync", () => {
  const report = evaluateRelease(facts({ ciBundleMatches: false }));
  assert.equal(finding(report, "ci-bundle-sync")?.status, "failed");
  assert.equal(report.status, "failed");
});

test("a synced CI bundle satisfies ci-bundle-sync", () => {
  const report = evaluateRelease(facts({ ciBundleMatches: true }));
  assert.equal(finding(report, "ci-bundle-sync")?.status, "satisfied");
});

test("ci-bundle-sync is satisfied (not applicable) when the pair is absent", () => {
  const report = evaluateRelease(facts({ ciBundleMatches: null }));
  const item = finding(report, "ci-bundle-sync");
  assert.equal(item?.status, "satisfied");
  assert.ok(item?.detail.includes("does not apply"));
});

test("the wrong branch fails expected-branch", () => {
  const report = evaluateRelease(facts({ branch: "feature/x" }));
  const item = finding(report, "expected-branch");
  assert.equal(item?.status, "failed");
  assert.ok(item?.detail.includes("feature/x"));
  assert.ok(item?.detail.includes("main"));
  assert.equal(report.status, "failed");
});

test("expected-commit is satisfied when no SHA is pinned", () => {
  const report = evaluateRelease(facts({ expectedSha: null }));
  assert.equal(finding(report, "expected-commit")?.status, "satisfied");
});

test("expected-commit fails when the pinned SHA differs from HEAD", () => {
  const report = evaluateRelease(
    facts({ head: "a".repeat(40), expectedSha: "b".repeat(40) }),
  );
  const item = finding(report, "expected-commit");
  assert.equal(item?.status, "failed");
  assert.ok(item?.detail.includes("b".repeat(40)));
  assert.equal(report.status, "failed");
});

test("expected-commit is satisfied when the pinned SHA matches HEAD", () => {
  const sha = "c".repeat(40);
  const report = evaluateRelease(facts({ head: sha, expectedSha: sha }));
  assert.equal(finding(report, "expected-commit")?.status, "satisfied");
  assert.equal(report.status, "passed");
});

test("CI not-requested is unverifiable and fails closed even when local checks pass", () => {
  const report = evaluateRelease(
    facts({
      ci: {
        state: "not-requested",
        detail: "the remote check was not requested",
      },
    }),
  );
  const item = finding(report, "ci-success");
  assert.equal(item?.status, "unverifiable");
  assert.ok(item?.detail.includes("pass --repo"));
  assert.equal(report.status, "failed");
});

test("CI unverifiable fails closed", () => {
  const report = evaluateRelease(
    facts({
      ci: { state: "unverifiable", detail: "could not read check runs" },
    }),
  );
  assert.equal(finding(report, "ci-success")?.status, "unverifiable");
  assert.equal(report.status, "failed");
});

test("CI failure fails the overall status", () => {
  const report = evaluateRelease(
    facts({ ci: { state: "failed", detail: "quality did not succeed" } }),
  );
  assert.equal(finding(report, "ci-success")?.status, "failed");
  assert.equal(report.status, "failed");
});

test("CI success contributes to a passing report", () => {
  const report = evaluateRelease(
    facts({ ci: { state: "success", detail: "quality succeeded" } }),
  );
  assert.equal(finding(report, "ci-success")?.status, "satisfied");
  assert.equal(report.status, "passed");
});

const ref = { owner: "o", repo: "r" };
const sha = "d".repeat(40);

function reader(response: { status: number; body: unknown }): {
  read: GitHubReader;
  requested: string[];
} {
  const requested: string[] = [];
  const read: GitHubReader = (requestPath) => {
    requested.push(requestPath);
    return Promise.resolve(response);
  };
  return { read, requested };
}

test("releaseCiFact reports success when the required check completed successfully", async () => {
  const { read, requested } = reader({
    status: 200,
    body: {
      check_runs: [
        { name: "quality", status: "completed", conclusion: "success" },
        { name: "other", status: "completed", conclusion: "failure" },
      ],
    },
  });
  const result = await releaseCiFact(read, ref, sha, ["quality"]);
  assert.equal(result.state, "success");
  assert.deepEqual(requested, [
    `/repos/o/r/commits/${sha}/check-runs?per_page=100`,
  ]);
});

test("releaseCiFact reports failed when the required check concluded unsuccessfully", async () => {
  const { read } = reader({
    status: 200,
    body: {
      check_runs: [
        { name: "quality", status: "completed", conclusion: "failure" },
      ],
    },
  });
  const result = await releaseCiFact(read, ref, sha, ["quality"]);
  assert.equal(result.state, "failed");
  assert.ok(result.detail.includes("quality"));
});

test("releaseCiFact reports failed when the required check is absent", async () => {
  const { read } = reader({
    status: 200,
    body: {
      check_runs: [
        { name: "lint", status: "completed", conclusion: "success" },
      ],
    },
  });
  const result = await releaseCiFact(read, ref, sha, ["quality"]);
  assert.equal(result.state, "failed");
});

test("releaseCiFact fails when one of several required checks is missing", async () => {
  const { read } = reader({
    status: 200,
    body: {
      check_runs: [
        { name: "quality", status: "completed", conclusion: "success" },
      ],
    },
  });
  const result = await releaseCiFact(read, ref, sha, ["quality", "rigor"]);
  assert.equal(result.state, "failed");
  assert.ok(result.detail.includes("rigor"));
});

test("releaseCiFact fails closed on an empty required-check set without contacting GitHub", async () => {
  let called = false;
  const read: GitHubReader = () => {
    called = true;
    return Promise.resolve({ status: 200, body: { check_runs: [] } });
  };
  const result = await releaseCiFact(read, ref, sha, []);
  assert.equal(result.state, "unverifiable");
  assert.equal(called, false);
});

test("releaseCiFact treats an unreadable response as unverifiable", async () => {
  const { read } = reader({ status: 0, body: null });
  const result = await releaseCiFact(read, ref, sha, ["quality"]);
  assert.equal(result.state, "unverifiable");
});

test("releaseCiFact rejects malformed commit identifiers without contacting GitHub", async () => {
  let called = false;
  const read: GitHubReader = () => {
    called = true;
    return Promise.resolve({ status: 200, body: {} });
  };
  const result: ReleaseCiFact = await releaseCiFact(read, ref, "not-a-sha", [
    "quality",
  ]);
  assert.equal(result.state, "unverifiable");
  assert.equal(result.detail, "invalid commit identifier");
  assert.equal(called, false);
});
