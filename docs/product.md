# Rigor product definition

## Users and problem

Rigor is for teams that use Claude Code in Git repositories and need evidence that an AI-assisted change followed controls proportional to its risk. It replaces informal, self-reported process with a small, inspectable workflow: assess, contract, implement, verify, review, approve, and learn.

## User journey

1. A maintainer runs `rigor setup` and reviews the generated `.rigor/policy.json` and GitHub workflow.
2. A contributor runs `rigor preflight --intent <file>` before implementation. Rigor derives confidentiality, risk, protected paths, stop conditions, and reasons from policy, intent, paths, and Git state.
3. `rigor contract` records acceptance criteria, allowed paths, constraints, and required checks under one task ID.
4. The contributor changes only contracted paths and runs `rigor verify`. Deterministic commands produce machine-readable evidence tied to the current commit or working tree.
5. Repeated unresolved failure is captured with `rigor escalate`; facts, attempts, disproved hypotheses, and speculation stay distinct.
6. `rigor review` re-runs preflight, checks scope, and creates a minimal local review bundle. Content is not marked exportable when policy forbids external transmission.
7. On a pull request, the generated CI invokes the repository-contained verifier against base and head. It re-derives policy and Git facts rather than trusting evidence claims.
8. Branch protection, CODEOWNERS, and an independent human approver remain the authoritative merge controls.
9. `rigor retrospect` aggregates local redacted events for calibration.

## MVP

The MVP provides a versioned JSON policy and artifacts; setup/upgrade; preflight; contract; deterministic verification; escalation; review preparation; retrospective aggregation; a lightweight hook; a read-only reviewer agent; skills for the workflow; and independent pull-request verification. It supports Git and Node.js on macOS/Linux.

## Non-goals

- Replacing GitHub branch protection, secret scanners, sandboxing, identity systems, or human approval.
- Proving that acceptance criteria are semantically correct or that tests are sufficient.
- Uploading code, evidence, or telemetry.
- Selecting a model by price or asserting that a model name is a trust boundary.
- Preventing a user who controls the local repository from bypassing local hooks.
