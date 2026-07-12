# Rigor

[日本語](README.ja.md) | English

Rigor is a Claude Code plugin that makes AI-assisted software changes reviewable and proportionally controlled. It turns an intended change into a risk assessment, a bounded task contract, an optional policy-constrained model-routing preview, deterministic verification evidence, a structured escalation or review bundle, and an independent pull-request check.

Rigor is deliberately not an LLM judge. Lint, types, tests, build commands, Git diffs, policy comparison, and evidence linkage are evaluated by the TypeScript CLI. The plugin's skills and reviewer agent organize work; the local hook gives early feedback; GitHub CI plus an independent human approval form the authoritative merge boundary.

## Guarantees and limits

When used as documented, Rigor deterministically:

- validates versioned policy and input shapes;
- derives the highest matching risk tier, protected paths, transmission decision, approval requirement, reasons, and stop conditions;
- rejects unsafe/traversing paths and setup symlink escapes;
- refuses to overwrite unequal repository-owned setup files;
- checks changed paths against a contract and runs configured commands without a shell;
- previews a model candidate by explicit capability, purpose, additional-transmission, and relative-cost constraints without invoking a model;
- stores only command status, duration, exit code, and an output digest, not raw output;
- has CI recompute base/head changes, compare base rules/checks, detect deleted tests, link evidence, and rerun checks.

Rigor does not prove that policy or acceptance criteria are correct, detect every secret, prove test quality, attest the local executable, prevent local hook bypass, control production deployment, or prevent a GitHub administrator from bypassing controls. Its transmission result is a decision; the deterministic CLI uploads no repository content. Explicitly invoked orchestration Skills may delegate bounded context through Claude Code or `codex-plugin-cc` only after the policy gate. Secret scanning, DLP, sandboxing, identity, deployment approvals, branch protection, CODEOWNERS, and human judgment remain separate controls.

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

To preview routing before implementation, create explicit assessment and profile files and run:

```json
{
  "schemaVersion": "rigor.routing-input.v1",
  "taskId": "APP-123",
  "purpose": "implementation",
  "signals": {
    "complexity": "medium",
    "ambiguity": "low",
    "novelty": "low",
    "verificationStrength": "strong"
  },
  "assessmentReasons": [
    "The change follows an existing pattern and has deterministic tests."
  ],
  "budget": {
    "maxAttempts": 2,
    "maxDurationMs": 600000,
    "maxRelativeCost": 100
  }
}
```

```json
{
  "schemaVersion": "rigor.model-profiles.v1",
  "candidates": [
    {
      "id": "claude-standard",
      "provider": "claude",
      "capabilityClass": "standard",
      "purposes": ["implementation", "review"],
      "relativeCost": 20,
      "requiresAdditionalExternalTransmission": false,
      "enabled": true
    },
    {
      "id": "codex-consult",
      "provider": "codex-plugin-cc",
      "capabilityClass": "frontier",
      "purposes": ["consultation", "adversarial-review", "rescue"],
      "relativeCost": 50,
      "requiresAdditionalExternalTransmission": true,
      "enabled": true
    }
  ]
}
```

```sh
rigor route --dry-run --preflight .rigor/evidence/APP-123/preflight.json --input /tmp/routing-input.json --profiles /tmp/model-profiles.json
```

This command does not invoke a model or save evidence. `relativeCost` is a configured comparison weight, not an observed price. See [model routing and orchestration](docs/orchestration.md).

To observe which configured candidates the current environment can actually invoke, produce a versioned availability report and let it filter unavailable or incompatible candidates before routing:

```sh
rigor availability --profiles /tmp/model-profiles.json > /tmp/availability.json
rigor route --dry-run --preflight .rigor/evidence/APP-123/preflight.json --input /tmp/routing-input.json --profiles /tmp/model-profiles.json --availability /tmp/availability.json
```

`rigor availability` marks each candidate exactly one of `available`, `unavailable`, `unknown`, or `incompatible` by reading only documented, bounded local interfaces (a fixed set of environment variables); it performs no installation, authentication, or network transmission. The `codex-plugin-cc` presence variables are an orchestrator-declared channel, not a direct plugin observation; an unrecognized or missing declaration stays `unknown`. Availability is an observation, not attestation: unsupported or failed probing is recorded as `unknown` (never `available`), unavailable and incompatible candidates are excluded before attempt start instead of being silently substituted, and configured model identity stays `unverified`. Missing `codex-plugin-cc` excludes only candidates that require it. Runtime model identity, reasoning effort, usage, and cost remain unverified/unknown.

For autonomous implementation, record the selected plan and bracket the delegated attempt:

```sh
rigor route --record --preflight .rigor/evidence/APP-123/preflight.json --contract .rigor/evidence/APP-123/contract.json --input /tmp/routing-input.json --profiles /tmp/model-profiles.json
rigor attempt-start --plan .rigor/evidence/APP-123/routing/routing-plan_ID.json --contract .rigor/evidence/APP-123/contract.json
# delegate implementation, run verify --dry-run, then persist rigor verify on success
rigor attempt-finish --session .rigor/evidence/APP-123/attempts/attempt-session_ID.json --contract .rigor/evidence/APP-123/contract.json --input /tmp/attempt-result.json --verification .rigor/evidence/APP-123/verification.json
```

Completed attempts require linked passing verification. Failed attempts use `verify --dry-run` so retries do not consume the task's write-once verification artifact. Configured provider/model identity is recorded as unverified rather than presented as runtime attestation.

An optional Codex consultation is bracketed by append-only snapshots:

```sh
rigor consult-start --preflight .rigor/evidence/APP-123/preflight.json --input /tmp/consultation-request.json
# consult through codex-plugin-cc
rigor consult-finish --session .rigor/evidence/APP-123/consultations/consultation-session_ID.json --input /tmp/consultation-result.json
```

`consult-finish` fails if repository content, changed paths, or HEAD changed during a read-only consultation. It stores a normalized summary and available external IDs, never the raw model transcript.

After review, record the task's disposition and link it to its evidence:

```sh
rigor outcome --input /tmp/outcome-input.json --attempt .rigor/evidence/APP-123/attempts/attempt_ID.json --verification .rigor/evidence/APP-123/verification.json --review .rigor/evidence/APP-123/review.json
```

`outcome` copies provider, model, capability class, and the attempt, verification, and review identifiers from the linked artifacts rather than trusting the input. It fails closed on inconsistent claims: an `accepted` outcome requires a completed attempt and a linked passing verification; `reverted` and escaped-defect outcomes must be `accepted`; and `retryCount` must equal `attempt.sequence - 1` when an attempt is linked. Token counts, provider cost, reasoning effort, and model identity are stored as measured-or-unavailable; when `usage.status` is not `recorded` the numeric fields are persisted as `null`. Configured model identity is recorded with `attestation: "unverified"`, provider cost is a reported measurement rather than a Rigor-verified charge, and the routing `relativeCost` remains an abstract routing weight, not a provider invoice or measured money.

Commit the evidence with the change. CI ignores evidence files when deriving the code change but validates their linkage and independently reruns policy checks.

## Daily workflow

The manual skills `/rigor:preflight`, `/rigor:contract`, `/rigor:route`, `/rigor:attempt`, `/rigor:verify`, `/rigor:escalate`, `/rigor:review`, and `/rigor:retrospect` guide Claude through the same CLI flow. `/rigor:consult` and `/rigor:orchestrate` are explicitly invoked model-using workflows; they remain bounded by the same CLI policy and verification commands. `/rigor:assess` produces a validated `rigor.routing-input.v2` (task characteristics, evidence, and confidence) for `/rigor:orchestrate` to route when no human-authored routing input is supplied; it never names or selects a model itself. No Skill invocation silently establishes a control.

Run the steps in this order: preflight, contract, recorded route, and attempt start before delegated edits; then complete every change, including the rebuilt `dist/rigor.cjs`, run `rigor verify`, and finalize the attempt; then `rigor review`; then commit code and evidence together in one commit. Verification records the worktree's uncommitted changes, so verifying before the last edit (or after an intermediate commit) produces evidence that does not cover the pull request's full change set and CI will reject it. Core artifacts are write-once: a task's `preflight.json`, `contract.json`, `verification.json`, and `review.json` are never overwritten; routing, attempt, and consultation artifacts are append-only collections. When scope changes or verification must be redone after saving, start a fresh task ID such as `APP-123-R2` and keep the earlier artifacts.

Routing, attempt, and consultation records are currently local advisory evidence. CI does not yet require or attest their model/provider claims.

If verification remains unresolved, create an escalation input with schema `rigor.escalation-input.v1`. Keep `facts`, `attempts`, `disprovedHypotheses`, `speculation`, and `requestedDecision` separate; duplicate attempts are rejected. `rigor retrospect` aggregates redacted local event counts from the gitignored `.rigor/events.jsonl` and, from each task's `outcome.json`, per-candidate success rates (with explicit numerator and denominator), retries, elapsed time, human-intervention minutes, and data-completeness counts. Every rate reports its denominator and every missing-data count so the metrics never hide unavailable measurements; malformed outcome files are tolerated and counted, not fatal. Reported cost is a measurement, and the routing `relativeCost` is an abstract routing weight, never a provider invoice or measured money.

Optionally, `rigor test-integrity-scan` records advisory test-weakening signals (skip/only/todo markers, test-file deletion, assertion-token decline, snapshot churn, and verification-adjacent config/script changes) over a base/head diff as shadow-only `rigor.test-integrity-event.v1` evidence, and `rigor test-integrity-classify` records human verdicts on them. Shadow collection changes no verification, progress, review, or merge outcome; a fired signal is a prompt for review, not proof of weakening, and `rigor retrospect` aggregates per-signal fired/unreviewed/classified counts with explicit denominators. See [docs/test-integrity.md](docs/test-integrity.md).

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

`rigor governance --repo owner/name` verifies these settings read-only against the GitHub API:

```sh
rigor governance --repo owner/name --branch main --required-check rigor
```

It reads active branch rules (rulesets), classic branch protection, CODEOWNERS (from `.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS`), and deployment environments, then reports one finding per requirement: pull requests required, at least one approval, stale-approval dismissal, code-owner review, last-push approval, the required `rigor` status check, force-push and deletion blocking, sampled CODEOWNERS coverage (an early-warning check, not proof of full coverage), and protection rules on every deployment environment. The command sends only GET requests to `api.github.com`, uses an optional least-privilege read token from `RIGOR_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `GH_TOKEN`, refuses redirects, times out after ten seconds, discards oversized or undecodable responses as unverifiable, treats paginated responses with unfetched pages as unverifiable instead of deciding on partial data, and never writes configuration; changing these settings remains a separately authorized human action. It exits `0` only when every finding is satisfied and `2` when any requirement fails or cannot be read with the available credentials, so missing scopes fail closed instead of passing silently. The CODEOWNERS check tests one representative path per policy-protected glob: an uncovered sample is a proven gap, but a covered sample is an early warning only and does not prove the whole glob is covered. Matching implements the documented last-match-wins subset (anchoring, `*`, `**`, `?`, escaped spaces, ownerless entries removing coverage) with case-sensitive comparison; classic protection needs repository administration read scope, while rulesets, contents, and environments need only repository read access. The [threat model](docs/threat-model.md) documents this read-only GitHub API trust boundary.

Rigor still cannot configure these repository-host settings, and a passing local command or model statement remains insufficient; the GitHub-side configuration and an independent human approval stay authoritative.

## Development and release

```sh
npm ci
npm run test:all
npm run bench
claude plugin validate . --strict
```

`test:all` runs formatting, ESLint, strict TypeScript, unit/integration/E2E tests, a fresh bundle, plugin structure validation, and local-link checks. The E2E test creates an empty temporary Git repository and covers setup through independent CI, including policy-check mutation and test deletion. Hook p95 must remain below 250 ms on the documented local benchmark.

Releases follow the [release runbook](docs/release.md): the release commit reaches `main` only through a protected pull request with the required `rigor` and `quality` checks green (never a direct push), then the deterministic `rigor release-check` pre-tag gate must pass, and only then does a human tag and publish. The gate confirms a clean tree, synchronized `package.json` and `.claude-plugin/plugin.json` versions, a matching `CHANGELOG.md` entry, a `dist/rigor.cjs` byte-identical to a fresh build, the expected branch and commit, and a successful exact-SHA GitHub CI result; omitting `--repo` leaves CI unverified and the gate fails closed. The manifest version is the Claude Code cache version, so it must change for users to receive an update.

## Security and known limitations

Artifacts are intended for version control and therefore must never contain secrets. Rigor avoids persisting raw check output but cannot sanitize prose entered by a user. Keep intent, contract, and escalation summaries minimal. A malicious policy can execute a malicious check; protect policy changes with CODEOWNERS and review base/head diffs.

MVP limitations and planned work are tracked in [MVP limitations](docs/mvp-limitations.md). In particular, Windows launch support, cryptographic provenance/attestation, semantic test-quality analysis, and any GitHub-host configuration writes are out of scope; `rigor governance` verifies host settings read-only but cannot change them.
