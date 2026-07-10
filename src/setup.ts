import { lstat, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { EXIT, RigorError } from "./errors.js";
import { assertContainedPath, stable } from "./util.js";
import { POLICY_SCHEMA, INTENT_SCHEMA, type Policy } from "./types.js";

export function defaultPolicy(repositoryId: string): Policy {
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
        requireHumanApproval: true,
      },
      {
        id: "secrets",
        paths: ["**/.env*", "**/secrets/**", "**/*.pem", "**/*.key"],
        tier: "critical",
        reason: "The path may contain credentials or confidential material.",
        protected: true,
        denyExternalTransmission: true,
        requireHumanApproval: true,
      },
      {
        id: "security-and-irreversible",
        paths: [
          "**/auth/**",
          "**/permissions/**",
          "**/migrations/**",
          "**/billing/**",
          "infra/**",
        ],
        tier: "critical",
        reason:
          "Authentication, authorization, billing, migration, or infrastructure changes can be irreversible or broadly impactful.",
        protected: true,
        requireHumanApproval: true,
      },
      {
        id: "runtime-code",
        paths: ["src/**", "lib/**", "app/**", "packages/**"],
        tier: "high",
        reason: "Runtime code affects shipped behavior.",
        requireHumanApproval: true,
      },
      {
        id: "tests-and-docs",
        paths: ["test/**", "tests/**", "docs/**", "**/*.md"],
        tier: "low",
        reason:
          "Tests and documentation normally have limited direct runtime impact.",
      },
    ],
    checks: [
      {
        id: "git-diff-check",
        command: "git",
        args: ["diff", "--check"],
        tiers: ["low", "medium", "high", "critical"],
        timeoutMs: 30_000,
      },
    ],
    stopConditions: {
      low: ["scope expands beyond the contract"],
      medium: [
        "scope expands beyond the contract",
        "a required check fails twice without a new hypothesis",
      ],
      high: [
        "scope expands beyond the contract",
        "a protected path is discovered",
        "a required check fails twice without a new hypothesis",
      ],
      critical: [
        "scope expands beyond the contract",
        "an irreversible or external write is needed",
        "credentials or personal data are encountered",
        "independent human approval is unavailable",
      ],
    },
    ci: { requireEvidence: true, maxPolicyWeakening: "none" },
  };
}

const workflow = `name: Rigor\n\non:\n  pull_request:\n    types: [opened, synchronize, reopened]\n\npermissions:\n  contents: read\n\njobs:\n  rigor:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - name: Independently verify Rigor evidence and policy\n        env:\n          RIGOR_BASE_SHA: \${{ github.event.pull_request.base.sha }}\n          RIGOR_HEAD_SHA: \${{ github.event.pull_request.head.sha }}\n        run: node .rigor/rigor-ci.cjs ci --base "$RIGOR_BASE_SHA" --head "$RIGOR_HEAD_SHA"\n`;

interface Candidate {
  relative: string;
  content?: string;
  copyFrom?: string;
  mode?: number;
}

export async function setup(
  root: string,
  bundlePath: string,
): Promise<{ created: string[]; unchanged: string[] }> {
  const candidates: Candidate[] = [
    { relative: ".rigor/.gitignore", content: "events.jsonl\n" },
    {
      relative: ".rigor/policy.json",
      content: `${JSON.stringify(defaultPolicy(path.basename(root)), null, 2)}\n`,
    },
    {
      relative: ".rigor/intent.example.json",
      content: `${JSON.stringify({ schemaVersion: INTENT_SCHEMA, taskId: "TASK-123", summary: "Describe the intended change", plannedPaths: ["src/example.ts"], operations: ["edit"] }, null, 2)}\n`,
    },
    { relative: ".github/workflows/rigor.yml", content: workflow },
    { relative: ".rigor/rigor-ci.cjs", copyFrom: bundlePath, mode: 0o755 },
  ];
  const created: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  const pending: Array<{
    candidate: Candidate;
    target: string;
    desired: Buffer;
  }> = [];
  for (const candidate of candidates) {
    const target = path.join(root, candidate.relative);
    await assertContainedPath(root, target);
    let existing: Buffer | null = null;
    try {
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        conflicts.push(candidate.relative);
        continue;
      }
      existing = await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const desired = candidate.copyFrom
      ? await readFile(candidate.copyFrom)
      : Buffer.from(candidate.content ?? "");
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
      EXIT.policyViolation,
    );
  for (const { candidate, target, desired } of pending) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, desired, { flag: "wx" });
    if (candidate.mode) await chmod(target, candidate.mode);
    created.push(candidate.relative);
  }
  return { created, unchanged };
}

export function policyWeakening(base: Policy, head: Policy): string[] {
  const failures: string[] = [];
  if (
    base.defaultExternalTransmission === "deny" &&
    head.defaultExternalTransmission === "allow"
  )
    failures.push("default external-transmission policy was weakened");
  const headRules = new Map(head.rules.map((rule) => [rule.id, stable(rule)]));
  for (const rule of base.rules)
    if (headRules.get(rule.id) !== stable(rule))
      failures.push(`base rule changed or removed: ${rule.id}`);
  const headChecks = new Map(
    head.checks.map((check) => [check.id, stable(check)]),
  );
  for (const check of base.checks)
    if (headChecks.get(check.id) !== stable(check))
      failures.push(`base check changed or removed: ${check.id}`);
  return failures;
}
