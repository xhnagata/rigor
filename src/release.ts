import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitFacts, run } from "./git.js";
import type { GitHubReader, RepositoryRef } from "./governance.js";

export const RELEASE_SCHEMA = "rigor.release.v1" as const;

export interface ReleaseFinding {
  id: string;
  status: "satisfied" | "failed" | "unverifiable";
  detail: string;
}

export interface ReleaseCiFact {
  state: "success" | "failed" | "unverifiable" | "not-requested";
  detail: string;
}

export interface ReleaseFacts {
  version: string;
  packageVersion: string;
  manifestVersion: string;
  branch: string;
  expectedBranch: string;
  head: string | null;
  expectedSha: string | null;
  dirty: boolean;
  changelogVersions: string[];
  bundleMatches: boolean;
  requiredChecks: string[];
  ci: ReleaseCiFact;
}

export interface ReleaseReport {
  schemaVersion: typeof RELEASE_SCHEMA;
  version: string;
  branch: string;
  head: string | null;
  requiredChecks: string[];
  findings: ReleaseFinding[];
  status: "passed" | "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function evaluateRelease(facts: ReleaseFacts): ReleaseReport {
  const findings: ReleaseFinding[] = [];

  findings.push(
    facts.dirty
      ? {
          id: "clean-tree",
          status: "failed",
          detail:
            "the worktree has uncommitted changes; a release must be cut from a clean tree",
        }
      : {
          id: "clean-tree",
          status: "satisfied",
          detail: "the worktree is clean",
        },
  );

  if (
    facts.packageVersion === facts.version &&
    facts.manifestVersion === facts.version
  ) {
    findings.push({
      id: "version-sync",
      status: "satisfied",
      detail: `package.json and .claude-plugin/plugin.json both declare ${facts.version}`,
    });
  } else {
    findings.push({
      id: "version-sync",
      status: "failed",
      detail: `version mismatch: package.json=${facts.packageVersion || "(unreadable)"}, .claude-plugin/plugin.json=${facts.manifestVersion || "(unreadable)"}, requested=${facts.version}`,
    });
  }

  findings.push(
    facts.changelogVersions.includes(facts.version)
      ? {
          id: "changelog-entry",
          status: "satisfied",
          detail: `CHANGELOG.md has a section for ${facts.version}`,
        }
      : {
          id: "changelog-entry",
          status: "failed",
          detail: `CHANGELOG.md has no section for ${facts.version}`,
        },
  );

  findings.push(
    facts.bundleMatches
      ? {
          id: "bundle-built",
          status: "satisfied",
          detail: "dist/rigor.cjs matches a fresh build",
        }
      : {
          id: "bundle-built",
          status: "failed",
          detail:
            "committed dist/rigor.cjs differs from a fresh build; rebuild and commit it",
        },
  );

  findings.push(
    facts.branch === facts.expectedBranch
      ? {
          id: "expected-branch",
          status: "satisfied",
          detail: `HEAD is on the expected branch ${facts.expectedBranch}`,
        }
      : {
          id: "expected-branch",
          status: "failed",
          detail: `HEAD is on ${facts.branch || "(unknown)"}, not the expected branch ${facts.expectedBranch}`,
        },
  );

  if (facts.expectedSha === null) {
    findings.push({
      id: "expected-commit",
      status: "satisfied",
      detail: `HEAD is ${facts.head ?? "(none)"}; no expected SHA was pinned`,
    });
  } else if (facts.head === facts.expectedSha) {
    findings.push({
      id: "expected-commit",
      status: "satisfied",
      detail: `HEAD is the expected commit ${facts.expectedSha}`,
    });
  } else {
    findings.push({
      id: "expected-commit",
      status: "failed",
      detail: `HEAD is ${facts.head ?? "(none)"}, not the expected commit ${facts.expectedSha}`,
    });
  }

  if (facts.ci.state === "success") {
    findings.push({
      id: "ci-success",
      status: "satisfied",
      detail: facts.ci.detail,
    });
  } else if (facts.ci.state === "failed") {
    findings.push({
      id: "ci-success",
      status: "failed",
      detail: facts.ci.detail,
    });
  } else if (facts.ci.state === "unverifiable") {
    findings.push({
      id: "ci-success",
      status: "unverifiable",
      detail: facts.ci.detail,
    });
  } else {
    findings.push({
      id: "ci-success",
      status: "unverifiable",
      detail:
        "GitHub CI was not checked; pass --repo to verify the required check(s) for the exact SHA",
    });
  }

  return {
    schemaVersion: RELEASE_SCHEMA,
    version: facts.version,
    branch: facts.branch,
    head: facts.head,
    requiredChecks: facts.requiredChecks,
    findings,
    status: findings.every((finding) => finding.status === "satisfied")
      ? "passed"
      : "failed",
  };
}

export async function releaseCiFact(
  read: GitHubReader,
  ref: RepositoryRef,
  sha: string,
  requiredChecks: string[],
): Promise<ReleaseCiFact> {
  if (!/^[0-9a-fA-F]{7,64}$/u.test(sha))
    return { state: "unverifiable", detail: "invalid commit identifier" };
  // An empty required-check set would otherwise pass vacuously; a gate whose
  // purpose is to fail closed must not report success without verifying a check.
  if (requiredChecks.length === 0)
    return {
      state: "unverifiable",
      detail: "no required checks were specified to verify",
    };
  const base = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const response = await read(
    `${base}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
  );
  if (
    response.status !== 200 ||
    !isRecord(response.body) ||
    !Array.isArray(response.body.check_runs)
  )
    return {
      state: "unverifiable",
      detail: `check runs for ${sha} could not be read with the available credentials`,
    };
  const runs = response.body.check_runs;
  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const check of requiredChecks) {
    const ok = runs.some(
      (item) =>
        isRecord(item) &&
        item.name === check &&
        item.status === "completed" &&
        item.conclusion === "success",
    );
    if (ok) satisfied.push(check);
    else missing.push(check);
  }
  if (missing.length === 0)
    return {
      state: "success",
      detail: `all required checks succeeded for ${sha}: ${satisfied.join(", ")}`,
    };
  return {
    state: "failed",
    detail: `required checks not successful for ${sha}: ${missing.join(", ")}`,
  };
}

export interface ReleaseOptions {
  version: string;
  expectedBranch: string;
  expectedSha: string | null;
  repo: RepositoryRef | null;
  requiredChecks: string[];
}

async function readJsonVersion(file: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.version === "string")
      return parsed.version;
  } catch {
    // Unreadable or malformed manifests leave the version empty so that the
    // version-sync finding fails rather than throwing.
  }
  return "";
}

async function readChangelogVersions(root: string): Promise<string[]> {
  try {
    const text = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
    const versions: string[] = [];
    // "Unreleased" headings are intentionally ignored.
    for (const match of text.matchAll(/^##\s+(\d+\.\d+\.\d+)\b/gmu))
      if (match[1]) versions.push(match[1]);
    return versions;
  } catch {
    return [];
  }
}

async function bundleMatchesFreshBuild(root: string): Promise<boolean> {
  // The committed bundle is compared against a fresh build written to a
  // throwaway file. esbuild honors the last --outfile, so appending it to the
  // repo's own `npm run build` keeps the flags authoritative and never mutates
  // dist/rigor.cjs.
  const temp = path.join(
    os.tmpdir(),
    `rigor-release-bundle-${String(process.pid)}.cjs`,
  );
  try {
    const result = await run(
      "npm",
      ["run", "build", "--", `--outfile=${temp}`],
      root,
      120_000,
    );
    if (result.code !== 0) return false;
    const [fresh, committed] = await Promise.all([
      readFile(temp),
      readFile(path.join(root, "dist", "rigor.cjs")),
    ]);
    return fresh.equals(committed);
  } catch {
    return false;
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function releaseVerify(
  root: string,
  options: ReleaseOptions,
  read: GitHubReader | null,
): Promise<ReleaseReport> {
  const packageVersion = await readJsonVersion(path.join(root, "package.json"));
  const manifestVersion = await readJsonVersion(
    path.join(root, ".claude-plugin", "plugin.json"),
  );
  const facts = await gitFacts(root);
  const branchResult = await run(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    root,
  );
  const branch = branchResult.stdout.toString("utf8").trim();
  const changelogVersions = await readChangelogVersions(root);
  const bundleMatches = await bundleMatchesFreshBuild(root);

  let ci: ReleaseCiFact;
  if (options.repo && read) {
    ci =
      facts.head === null
        ? {
            state: "unverifiable",
            detail: "there is no HEAD commit to check remote CI for",
          }
        : await releaseCiFact(
            read,
            options.repo,
            facts.head,
            options.requiredChecks,
          );
  } else {
    ci = {
      state: "not-requested",
      detail: "the remote GitHub CI check was not requested (no --repo)",
    };
  }

  return evaluateRelease({
    version: options.version,
    packageVersion,
    manifestVersion,
    branch,
    expectedBranch: options.expectedBranch,
    head: facts.head,
    expectedSha: options.expectedSha,
    dirty: facts.dirty,
    changelogVersions,
    bundleMatches,
    requiredChecks: options.requiredChecks,
    ci,
  });
}
