# Rigor

[日本語](README.ja.md) | English

Rigor is a Claude Code plugin that makes AI-assisted software changes reviewable and proportionally controlled. It turns an intended change into a risk assessment, a bounded task contract, deterministic verification evidence, a structured escalation or review bundle, and an independent pull-request check.

Rigor is deliberately not an LLM judge. Lint, types, tests, build commands, Git diffs, policy comparison, and evidence linkage are evaluated by the TypeScript CLI. The plugin's skills and reviewer agent organize work; the local hook gives early feedback; GitHub CI plus an independent human approval form the authoritative merge boundary.

## Guarantees and limits

When used as documented, Rigor deterministically:

- validates versioned policy and input shapes;
- derives the highest matching risk tier, protected paths, transmission decision, approval requirement, reasons, and stop conditions;
- rejects unsafe/traversing paths and setup symlink escapes;
- refuses to overwrite unequal repository-owned setup files;
- checks changed paths against a contract and runs configured commands without a shell;
- stores only command status, duration, exit code, and an output digest, not raw output;
- has CI recompute base/head changes, compare base rules/checks, detect deleted tests, link evidence, and rerun checks.

Rigor does not prove that policy or acceptance criteria are correct, detect every secret, prove test quality, attest the local executable, prevent local hook bypass, control production deployment, or prevent a GitHub administrator from bypassing controls. Its transmission result is a decision; Rigor itself uploads nothing. Secret scanning, DLP, sandboxing, identity, deployment approvals, branch protection, CODEOWNERS, and human judgment remain separate controls.

See [the product definition](docs/product.md), [threat model](docs/threat-model.md), and [architecture](docs/architecture.md) for the concise design basis.

## Requirements and installation

- Claude Code 2.1.206 or newer (the implementation was validated with 2.1.206)
- Node.js 20 or newer
- Git
- macOS or Linux; the launcher is POSIX shell in this MVP

Install from the GitHub-hosted marketplace in Claude Code:

```text
/plugin marketplace add xhnagata/rigor
/plugin install rigor@rigor-tools
```

For development, clone this repository, run `npm ci && npm run build`, then start Claude Code with `claude --plugin-dir .`. Only trust plugins from repositories you have reviewed: an enabled plugin can execute hooks.

## Five-minute quick start

From the target Git repository:

```sh
rigor setup
```

Review and commit the generated `.rigor/policy.json`, `.rigor/rigor-ci.cjs`, `.rigor/.gitignore`, `.rigor/intent.example.json`, and `.github/workflows/rigor.yml`. Create an intent file outside the repository or in a path covered by your task:

```json
{
  "schemaVersion": "rigor.intent.v1",
  "taskId": "APP-123",
  "summary": "Add a bounded parser",
  "plannedPaths": ["src/parser.ts", "test/parser.test.ts"],
  "operations": ["create", "test"]
}
```

Run preflight, then create `contract-input.json`:

```sh
rigor preflight --intent /tmp/intent.json
```

```json
{
  "schemaVersion": "rigor.contract-input.v1",
  "taskId": "APP-123",
  "acceptanceCriteria": [
    "valid input parses",
    "invalid input returns a typed error"
  ],
  "allowedPaths": ["src/parser.ts", "test/parser.test.ts"],
  "constraints": ["no network access", "no new runtime dependency"]
}
```

Use the saved path printed by each command:

```sh
rigor contract --preflight .rigor/evidence/APP-123/preflight.json --input /tmp/contract-input.json
# implement the bounded change
rigor verify --contract .rigor/evidence/APP-123/contract.json
rigor review --contract .rigor/evidence/APP-123/contract.json --preflight .rigor/evidence/APP-123/preflight.json --verification .rigor/evidence/APP-123/verification.json
```

Commit the evidence with the change. CI ignores evidence files when deriving the code change but validates their linkage and independently reruns policy checks.

## Daily workflow

The manual skills `/rigor:preflight`, `/rigor:contract`, `/rigor:verify`, `/rigor:escalate`, `/rigor:review`, and `/rigor:retrospect` guide Claude through the same CLI flow. They are intentionally manual so an inferred skill invocation cannot silently establish a control.

If verification remains unresolved, create an escalation input with schema `rigor.escalation-input.v1`. Keep `facts`, `attempts`, `disprovedHypotheses`, `speculation`, and `requestedDecision` separate; duplicate attempts are rejected. `rigor retrospect` aggregates redacted local event counts from the gitignored `.rigor/events.jsonl`.

Stable CLI exit codes are `0` success, `2` policy/verification failure, `3` invalid input or repository state, and `4` unexpected internal failure. Error messages omit raw subprocess output.

## What is installed where

The plugin contains:

- `.claude-plugin/plugin.json` and `marketplace.json` for packaging;
- `skills/` for agent workflow guidance;
- `agents/rigor-reviewer.md`, a read-only advisory reviewer;
- `hooks/hooks.json`, a five-second `UserPromptSubmit` early-feedback hook;
- `bin/rigor` and bundled `dist/rigor.cjs` deterministic runtime.

`rigor setup` adds only the five files listed in quick start. Re-running it is idempotent. Any unequal existing file or symlink is a conflict and is never overwritten. `rigor upgrade` currently performs the same safe reconciliation; it reports conflicts for manual review.

An unconfigured repository is ignored by the hook. A repository with `.rigor/` but missing or invalid policy is blocked early. This hook remains bypassable; CI is the enforcement point.

## Policy

The generated policy is a conservative starting point, not universal truth. It protects Rigor/workflow files, credentials, authentication, authorization, billing, migrations, and infrastructure; classifies runtime code high; and makes the highest matching rule win. It uses segment-aware `*`, `?`, and `**` globs with case-sensitive matching on every platform.

Checks are executable plus argument arrays, never shell strings:

```json
{
  "id": "project-test",
  "command": "npm",
  "args": ["test"],
  "tiers": ["medium", "high", "critical"],
  "timeoutMs": 300000
}
```

Add project-specific format, lint, typecheck, test, and build checks. Policy/check changes are protected and CI rejects removal or mutation of a base rule/check; introduce reviewed additions first, then retire old controls in a separately governed change. Schemas live in [`schemas/`](schemas/).

## GitHub enforcement

For `main`, configure a ruleset or branch protection that:

1. requires pull requests and the generated `rigor` check plus the project's normal test checks;
2. requires at least one approval and dismisses stale approvals on new commits;
3. requires review from CODEOWNERS for `.rigor/**`, `.github/workflows/**`, authentication, permissions, billing, migrations, infrastructure, and deployment files;
4. prevents the implementing author from being the only approver;
5. restricts force-pushes, deletion, and bypass; and
6. applies the rules to administrators where organizational policy permits.

Rigor cannot configure or verify these repository-host settings from the plugin. Treat a passing local command or model statement as insufficient.

## Development and release

```sh
npm ci
npm run test:all
npm run bench
claude plugin validate . --strict
```

`test:all` runs formatting, ESLint, strict TypeScript, unit/integration/E2E tests, a fresh bundle, plugin structure validation, and local-link checks. The E2E test creates an empty temporary Git repository and covers setup through independent CI, including policy-check mutation and test deletion. Hook p95 must remain below 250 ms on the documented local benchmark.

For release, update `CHANGELOG.md`, bump both `package.json` and `.claude-plugin/plugin.json`, rebuild and commit `dist/rigor.cjs`, run all gates and official validation, tag `vX.Y.Z`, and publish the Git tag. The manifest version is the Claude Code cache version, so it must change for users to receive an update.

## Security and known limitations

Artifacts are intended for version control and therefore must never contain secrets. Rigor avoids persisting raw check output but cannot sanitize prose entered by a user. Keep intent, contract, and escalation summaries minimal. A malicious policy can execute a malicious check; protect policy changes with CODEOWNERS and review base/head diffs.

MVP limitations and planned work are tracked in [MVP limitations](docs/mvp-limitations.md). In particular, Windows launch support, cryptographic provenance/attestation, semantic test-quality analysis, and GitHub-host configuration verification are out of scope for 0.1.0.
